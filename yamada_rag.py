"""岩手県山田町の公式資料を検索する、小規模なRAGの試作。"""

import argparse
import json
import math
import os
import re
import sys
import unicodedata
from collections import Counter
from datetime import date
from functools import lru_cache
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener


SEARCH_LIMIT = 3
OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
DEFAULT_OLLAMA_MODEL = "gemma4:12b"
NO_EVIDENCE = "登録した資料からは、質問に答えるための根拠を確認できませんでした。"
ANSWER_INSTRUCTIONS = Path(__file__).with_name("prompts").joinpath("answer.md").read_text(encoding="utf-8").rstrip()


def load_markdown(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    try:
        end = lines.index("---", 1)
        if lines[0] != "---":
            raise ValueError
        metadata = {}
        for line in lines[1:end]:
            key, separator, value = line.partition(":")
            if not separator or key in metadata or not value.strip():
                raise ValueError
            metadata[key] = value.strip()
        fields = {"title", "category", "source", "url", "checked", "keywords", "topics"}
        text = "\n".join(lines[end + 1:]).strip()
        if metadata.keys() - {"names"} != fields or not text:
            raise ValueError
        url = urlsplit(metadata["url"])
        if url.scheme != "https" or not url.hostname:
            raise ValueError
        date.fromisoformat(metadata["checked"])
        for key in ("keywords", "topics", "names"):
            if key not in metadata:
                continue
            values = [word.strip() for word in metadata[key].split(",")]
            if not all(values):
                raise ValueError
            metadata[key] = values
    except ValueError as error:
        raise ValueError(f"{path.name} の資料情報または本文の形式を確認してください。") from error
    return {**metadata, "id": f"md-{path.stem}", "text": text}


def load_records(*, include_imported=True):
    path = Path(__file__).with_name("sources.json")
    documents = json.loads(path.read_text(encoding="utf-8"))
    records = []
    for document in documents:
        metadata = {key: document[key] for key in ("category", "source", "url", "checked")}
        records.extend({**metadata, **record} for record in document["records"])
    records.extend(load_markdown(file) for file in sorted(path.with_name("knowledge").glob("*.md")))
    for document in json.loads(path.with_name("regional_resources.json").read_text(encoding="utf-8")):
        metadata = {key: document[key] for key in ("category", "source", "url", "checked")}
        records.extend({**metadata, **record} for record in document["records"])
    for filename in ("town_articles.json", "tourism_articles.json") if include_imported else ():
        imported_path = path.with_name(filename)
        if not imported_path.is_file():
            continue
        for document in json.loads(imported_path.read_text(encoding="utf-8"))["documents"]:
            metadata = {key: document[key] for key in ("category", "source", "url", "checked", "published")}
            for record in document["records"]:
                title = f"{record['title']} / {record['heading']}" if record["heading"] else record["title"]
                records.append({**metadata, **record, "title": title})
    if len({record["id"] for record in records}) != len(records):
        raise ValueError("資料IDが重複しています。")
    return records


def normalize(text):
    # 幅を揃え、カタカナをひらがなにして「ゴミ」「ごみ」などを同じ扱いにする。
    text = unicodedata.normalize("NFKC", text).casefold()
    return "".join(chr(ord(char) - 0x60) if "ァ" <= char <= "ヶ" else char for char in text)


@lru_cache(maxsize=16384)
def lexical_text(text):
    return " ".join(re.findall(r"[^\W_]+", normalize(text)))


def name_text(text):
    return "".join(char for char in normalize(text) if not char.isspace() and unicodedata.category(char)[0] != "P")


def name_queries(text):
    compact = name_text(text)
    subject = re.sub(r"(?:(?:って|とは|について)(?:何|なに|教えて|おしえて)?(?:ですか|ください)?|は(?:何|なに)(?:ですか)?)$", "", compact)
    return [compact, subject, *(name_text(name) for name in re.findall(r"[「『]([^」』]+)[」』]", text))]


def matched_name_length(record, queries):
    names = (name_text(alias) for alias in record.get("names", []))
    return max((len(name) for name in names if name and any(
        query == name or (len(name) >= 4 and name in query) for query in queries
    )), default=0)


def search_imported(records, query):
    # 日本語の語境界がなくても照合できるよう、質問を二文字・三文字ずつ取り出す。
    terms = {
        token[start:start + size]
        for token in lexical_text(query).split()
        for size in (2, 3)
        for start in range(len(token) - size + 1)
    }
    if not terms:
        return []
    matches = []
    frequencies = Counter()
    for record in records:
        title = lexical_text(record["title"])
        body = lexical_text(record["text"])
        section = lexical_text(record.get("heading", ""))
        title_hits = {term for term in terms if term in title}
        body_hits = {term for term in terms if term in body}
        section_hits = {term for term in title_hits if term in section}
        hits = title_hits | body_hits
        frequencies.update(hits)
        if any(len(term) == 3 for term in hits) or (title_hits and len(hits) >= 2) or (len(terms) == 1 and title_hits):
            matches.append((record, title_hits, body_hits, section_hits))

    # 資料によく出る文字列は相対的に軽くし、見出しに現れる語を重くする。
    weights = {term: len(term) * math.log1p(len(records) / count) for term, count in frequencies.items()}
    article_scores, selected = {}, {}
    for record, title_hits, body_hits, section_hits in matches:
        score = 3 * sum(weights[term] for term in title_hits) + sum(weights[term] for term in body_hits)
        section_score = score + 6 * sum(weights[term] for term in section_hits)
        url = record["url"]
        article_scores[url] = max(article_scores.get(url, 0), score)
        if url not in selected or section_score > selected[url][0]:
            selected[url] = (section_score, record)
    ranked = sorted(selected, key=lambda url: (article_scores[url], selected[url][1]["published"]), reverse=True)
    return [selected[url][1] for url in ranked[:SEARCH_LIMIT]]


def search(records, query):
    query = normalize(query)
    names = name_queries(query)
    matches = []
    for record in records:
        keywords = [term for term in record.get("keywords", []) if normalize(term) in query]
        name_length = matched_name_length(record, names)
        if not keywords and not name_length:
            continue
        # 施設名や品目で絞り込み、質問された項目が合う候補を上位にする。
        topic_score = sum(len(topic) for topic in record.get("topics", []) if normalize(topic) in query)
        matches.append((topic_score, name_length, max(map(len, keywords), default=0), record))
    matches.sort(key=lambda match: match[:3], reverse=True)

    # 質問された項目に合う節を保ち、項目が合わない同じURLの候補は後ろに回す。
    urls = set()
    prioritized = []
    remaining = []
    for topic_score, _, _, record in matches:
        if not topic_score and record["url"] in urls:
            remaining.append(record)
        else:
            prioritized.append(record)
        urls.add(record["url"])
    curated = prioritized + remaining
    if not matches or not matches[0][0]:
        named = [record for record in curated if matched_name_length(record, names)]
        urls = {record["url"] for record in named}
        imported = [record for record in search_imported([r for r in records if "published" in r], query)
                    if record["url"] not in urls]
        urls.update(record["url"] for record in imported)
        return (named + imported + [record for record in curated if record["url"] not in urls])[:SEARCH_LIMIT]
    return curated[:SEARCH_LIMIT]


def format_record(record):
    published = f"掲載日 {record['published']} / " if record.get("published") else ""
    return (
        f"[{record['id']}] {record['category']} / {record['title']}\n"
        f"{record['text']}\n"
        f"出典　{record['source']}（{published}確認日 {record['checked']}）\n{record['url']}"
    )


def format_prompt(question, records):
    evidence = "\n\n".join(map(format_record, records))
    return (
        f"{ANSWER_INSTRUCTIONS}\n回答の根拠にした出典のURLを記載してください。\n\n"
        f"質問\n{question}\n\n検索で見つかった資料\n{evidence or '該当なし'}"
    )


def chat_json(opener, model, messages, schema, *, context=4096, response_tokens=512, on_content=None):
    payload = {
        "model": model, "messages": messages, "stream": on_content is not None, "format": schema,
        "options": {"temperature": 0},
    }
    if model == DEFAULT_OLLAMA_MODEL:
        payload["think"] = False
        payload["options"].update(num_ctx=context, num_predict=response_tokens)
    request = Request(
        os.environ.get("YAMADA_CHAT_URL") or OLLAMA_URL,
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    )
    try:
        with opener.open(request, timeout=120) as response:
            if on_content is None:
                content = json.load(response)["message"]["content"]
            else:
                content = ""
                for line in response:
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    if not isinstance(event, dict):
                        raise ValueError("Expected an Ollama event")
                    if event.get("error"):
                        raise RuntimeError("Ollamaでの生成が中断されました。")
                    message = event.get("message", {})
                    if not isinstance(message, dict):
                        raise ValueError("Expected an Ollama message")
                    fragment = message.get("content", "")
                    if fragment:
                        content += fragment
                        on_content(content)
                    if event.get("done") is True:
                        break
                else:
                    raise ValueError("Incomplete Ollama stream")
            decision = json.loads(content)
        if not isinstance(decision, dict):
            raise ValueError("Expected a JSON object")
        for field in ("answer", "other_answer"):
            if isinstance(decision.get(field), str):
                decision[field].encode("utf-8")
        return decision
    except HTTPError as error:
        raise RuntimeError(f"OllamaがHTTP {error.code}を返しました。ollama list でモデル名を確認してください。") from error
    except (URLError, TimeoutError) as error:
        raise RuntimeError("Ollamaへの接続が完了しませんでした。起動状況を確認してください。") from error
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError("Ollamaの応答を読み取れませんでした。") from error


def make_ollama_decider(model, *, catalog=()):
    opener = build_opener(ProxyHandler({}))
    searchable_titles = []
    has_imported_articles = False
    for record in catalog:
        if "published" in record:
            has_imported_articles = True
        else:
            searchable_titles.append(record["title"])

    def decide(question, records, can_search):
        actions = ["answer", "insufficient", "search"] if can_search else ["answer", "insufficient"]
        schema = {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": actions},
                "query": {"type": "string"},
                "answer": {"type": "string"},
                "sources": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["action", "query", "answer", "sources"],
        }
        instructions = f"{ANSWER_INSTRUCTIONS}\npassages は検索で取得した資料です。"
        if can_search:
            if searchable_titles:
                instructions += "searchable_titles は資料集の目次です。検索先の判断だけに使い、回答の根拠にしないでください。"
            if has_imported_articles:
                instructions += "資料集には、この目次の項目のほかに、町や観光協会の公開記事もあります。"
            instructions += (
                "必要な事実が不足し、同じ資料集から補える場合は、回答の前に必ず action=search を選びます。"
                "query には、資料から特定できた施設名または品目名と、不足している項目を入れてください。"
                "例えば、最寄り駅の案内から施設名は分かったが閉館時刻がない場合、施設の正式名に「開館時間」を足して検索します。"
                "query が空でない場合、action は必ず search です。追加検索は1回だけ可能です。"
            )
        else:
            instructions += "追加検索はできません。手元の資料で回答可否を判断してください。"
        instructions += (
            "passages に基づいて答える場合は action=answer、answer に回答、sources に根拠の資料IDを入れてください。"
            "URLはプログラムが表示するので、answer には書かないでください。"
            "答えられる根拠がなく、追加検索でも補えない場合は action=insufficient です。"
            "使わない文字列は空文字、配列は空配列にしてください。"
        )

        model_input = {
            "question": question,
            "passages": [
                {key: record[key] for key in ("id", "title", "text", "source", "checked", "published") if key in record}
                for record in records
            ],
        }
        if can_search and searchable_titles:
            model_input["searchable_titles"] = searchable_titles
        return chat_json(opener, model, [
            {"role": "system", "content": instructions},
            {"role": "user", "content": json.dumps(model_input, ensure_ascii=False)},
        ], schema)

    return decide


def answer_question(question, records, decide, *, baseline=False, trace=False, on_search=None, retriever=None):
    def retrieve(query):
        mode = "keyword"
        if retriever is None:
            hits = search(records, query)
        else:
            result = retriever(query)
            hits, mode = result.records, result.mode
        ids = tuple(record["id"] for record in hits)
        if trace:
            print(f"検索 {query!r} ({mode}) → {', '.join(ids) or '該当なし'}", file=sys.stderr)
        if on_search is not None:
            on_search(query, ids, mode)
        return hits

    evidence = {record["id"]: record for record in retrieve(question)}
    decision = decide(question, list(evidence.values()), can_search=not baseline)
    if decision.get("action") == "search" and not baseline:
        raw_query = decision.get("query")
        query = raw_query.strip() if isinstance(raw_query, str) else ""
        if query and normalize(query) != normalize(question):
            evidence.update((record["id"], record) for record in retrieve(query))
        decision = decide(question, list(evidence.values()), can_search=False)

    if decision.get("action") != "answer":
        return NO_EVIDENCE, []

    answer = decision.get("answer")
    citations = cited_records(decision, evidence)
    if not isinstance(answer, str) or not answer.strip() or not citations:
        return NO_EVIDENCE, []
    return answer.strip(), citations


def cited_records(decision, evidence):
    # 表示するURLはモデルの出力から作らず、検索で取得した資料から引く。
    ids = decision.get("sources")
    if not isinstance(ids, list) or any(not isinstance(id_, str) or id_ not in evidence for id_ in ids):
        return []
    return [evidence[id_] for id_ in dict.fromkeys(ids)]


def main():
    parser = argparse.ArgumentParser(description="岩手県山田町の観光・くらし資料を検索します。")
    parser.add_argument("question", help="質問文を引用符で囲んで指定します。")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prompt", action="store_true", help="チャットに貼れる指示と検索結果を表示します。")
    mode.add_argument(
        "--model", nargs="?", const=DEFAULT_OLLAMA_MODEL,
        help=f"ローカルOllamaで回答します。モデル名を省略すると {DEFAULT_OLLAMA_MODEL} を使います。",
    )
    parser.add_argument("--baseline", action="store_true", help="初回検索だけで回答します（--model 用）。")
    parser.add_argument("--trace", action="store_true", help="AIモードで行動と検索結果を表示します。")
    parser.add_argument("--retrieval", choices=("keyword", "hybrid"), default="keyword", help="一般資料の検索方式です。")
    args = parser.parse_args()
    question = args.question.strip()
    if not question:
        parser.error("質問を入力してください。")
    if (args.baseline or args.trace) and not args.model:
        parser.error("--baseline と --trace は --model と一緒に使います。")

    try:
        records = load_records()
        retriever = None
        if args.retrieval == "hybrid":
            from yamada_embeddings import make_retriever

            retriever = make_retriever(records, mode=args.retrieval)
        if args.model and args.baseline:
            answer, citations = answer_question(
                question, records, make_ollama_decider(args.model, catalog=records),
                baseline=True, trace=args.trace, retriever=retriever,
            )
        elif args.model:
            from yamada_react import make_react_decider, run_turn

            def trace_action(event):
                print(json.dumps(event, ensure_ascii=False), file=sys.stderr)

            result = run_turn(
                question, records, make_react_decider(args.model), on_action=trace_action if args.trace else None,
                retriever=retriever,
            )
            answer, citations = result.answer, result.sources
        if args.model:
            print(answer)
            for record in citations:
                print(f"\n出典　{record['title']}（確認日 {record['checked']}）")
                if "calendar_answer" not in record:
                    print(record["url"])
        else:
            hits = search(records, question) if retriever is None else retriever(question).records
            if args.prompt:
                print(format_prompt(question, hits))
            elif hits:
                print("検索結果（回答に使えるか、資料の内容を確認してください）\n")
                print("\n\n".join(map(format_record, hits)))
            else:
                print(NO_EVIDENCE)
    except (OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"エラー　{error}\n")


if __name__ == "__main__":
    main()
