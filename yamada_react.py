"""Gemmaが行動を選び、検索結果を観察して次の行動を決める。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from urllib.request import ProxyHandler, build_opener
from zoneinfo import ZoneInfo

from yamada_calendars import find_collection_calendar
from yamada_rag import ANSWER_INSTRUCTIONS, NO_EVIDENCE, chat_json, cited_records, normalize, search


MAX_SEARCHES = 2
MAX_DECISIONS = 3
TARGETS = ("official_documents", "collection_calendars")
INSTRUCTIONS = f"""{ANSWER_INSTRUCTIONS}
あなたは質問、聞き返しへの返答、検索の観察を読み、次の行動を一つ選びます。
入力の question は最初に尋ねられたことです。follow_up があれば、聞き返しに対する利用者の返答です。
observations は、あなたが指定した検索の結果です。回答に必要な事実がそろったら、追加検索せず回答してください。

- 検索する場合は action=search。施設・制度・観光などは target=official_documents を選び、
  query に施設名や品目と知りたい項目を入れます。複数の項目がある質問では、まず必要な施設名や品目を一緒に入れます。
  例えば「AとBはどちらが遅く閉まる？」の検索語は「A B 通常の閉館時間」です。
  missing_fact にその検索で確認したい項目を短く記録します。
- 個別地区のごみ収集日や日程表の質問では地区名が必要です。元の質問と返答から地区が分からなければ
  action=clarify、field=district とし、町内の地区名を尋ねる短い質問を answer に入れます。
  地区が分かれば target=collection_calendars、district に地区名、fiscal_year に西暦の年度を指定します。
  年度指定がなければ current_fiscal_year を使います。日程表の案内だけが見つかった場合は、
  PDFで確認するよう案内し、収集日や曜日は推測しません。
- 回答する場合は action=answer、answer に日本語の回答、sources に根拠に使った資料IDを入れます。
  駅名から施設を特定して閉館時刻を比べるなら、駅と施設の関係を示す資料IDと、比較する双方の時刻を示す資料IDを入れます。
  同じ発信元のページでも、根拠に使った箇所が別々の資料IDならそれぞれ入れます。
  URLはアプリが表示するため answer には入れません。
- 根拠を確認できず、有効な検索手段もなければ action=insufficient。分からないことを answer に短く書きます。
  日付指定の混雑状況のような、収録資料から確認できない情報は推測しません。

答えられる可能性があり observations が空なら、検索するか、地区が足りなければ聞き返してください。
既に観察した検索条件をそのまま再指定せず、不足項目に合う条件に変更します。
action に必要な項目だけ出力してください。"""


@dataclass
class TurnResult:
    action: str
    answer: str
    sources: list
    pending: dict | None = None


def make_react_decider(model):
    opener = build_opener(ProxyHandler({}))

    def decide(state, *, actions):
        schema = {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": actions},
                "target": {"type": "string", "enum": TARGETS},
                "query": {"type": "string"},
                "missing_fact": {"type": "string"},
                "district": {"type": "string"},
                "fiscal_year": {"type": "integer"},
                "field": {"type": "string", "enum": ["district"]},
                "answer": {"type": "string"},
                "sources": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["action"],
            "additionalProperties": False,
        }
        messages = [
            {"role": "system", "content": INSTRUCTIONS},
            {"role": "user", "content": json.dumps(state, ensure_ascii=False)},
        ]
        return chat_json(opener, model, messages, schema, context=6144, response_tokens=448)

    return decide


def run_turn(question, records, decide, *, pending=None, on_action=None):
    today = datetime.now(ZoneInfo("Asia/Tokyo")).date()
    fiscal_year = today.year if today.month >= 4 else today.year - 1
    state = {
        "question": pending["question"] if pending else question,
        "today": today.isoformat(),
        "current_fiscal_year": fiscal_year,
        "observations": [],
    }
    if pending:
        state["follow_up"] = {"asked": pending["prompt"], "reply": question}

    evidence = {}
    previous = {}
    searches = 0
    for step in range(MAX_DECISIONS):
        actions = ["clarify", "insufficient"]
        if evidence:
            actions.append("answer")
        remaining = min(MAX_SEARCHES - searches, MAX_DECISIONS - step - 1)
        if remaining:
            actions.append("search")
        state["remaining_searches"] = remaining
        decision = decide(state, actions=actions)
        action = decision.get("action")
        if action not in actions:
            break
        if action == "search":
            target = decision.get("target")
            event = {"action": action, "target": target, "status": "invalid", "source_ids": []}
            missing_fact = decision.get("missing_fact")
            if isinstance(missing_fact, str) and missing_fact.strip():
                event["missing_fact"] = missing_fact.strip()
            lookup = None
            if target == "official_documents":
                query = decision.get("query")
                if isinstance(query, str) and 0 < len(query.strip()) <= 400:
                    query = query.strip()
                    event["query"] = query
                    key = (target, " ".join(normalize(query).split()))
                    lookup = lambda: search(records, query)
            elif target == "collection_calendars":
                district = decision.get("district")
                year = decision.get("fiscal_year", fiscal_year)
                if isinstance(district, str) and 0 < len(district.strip()) <= 80 and type(year) is int:
                    district = district.strip()
                    event.update(district=district, fiscal_year=year)
                    key = (target, " ".join(normalize(district).split()), year)
                    lookup = lambda: find_collection_calendar(district, year)

            passages = []
            if lookup is not None:
                if key in previous:
                    passages = previous[key]
                    event["status"] = "reused"
                else:
                    searches += 1
                    try:
                        passages = lookup()
                    except (OSError, ValueError):
                        event["status"] = "error"
                    else:
                        previous[key] = passages
                        event["status"] = "found" if passages else "not_found"
                evidence.update((record["id"], record) for record in passages)
                event["source_ids"] = [record["id"] for record in passages]
            if on_action:
                on_action(event)
            fields = ("id", "title", "text", "source", "checked", "published")
            state["observations"].append({
                **event,
                "passages": [
                    {field: record[field] for field in fields if field in record} for record in passages
                ] if event["status"] != "reused" else [],
            })
            continue

        if on_action:
            on_action({"action": action})
        raw_answer = decision.get("answer")
        answer = raw_answer.strip() if isinstance(raw_answer, str) else ""
        sources = cited_records(decision, evidence)
        if action == "clarify" and decision.get("field") == "district":
            prompt = answer if 0 < len(answer) <= 400 else "山田町内のどの地区か教えてください。"
            return TurnResult(action, prompt, [], {
                "question": state["question"], "field": "district", "prompt": prompt,
            })
        if action == "answer" and answer and sources:
            return TurnResult(action, answer, sources)
        if action == "insufficient":
            return TurnResult(action, answer or NO_EVIDENCE, sources)
        break
    return TurnResult("insufficient", NO_EVIDENCE, [])
