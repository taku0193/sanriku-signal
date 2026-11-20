"""Gemmaが行動を選び、検索結果を観察して次の行動を決める。"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from urllib.request import ProxyHandler, build_opener
from zoneinfo import ZoneInfo

from yamada_calendars import (
    COLLECTION_PERIODS, COLLECTION_TYPES, AmbiguousDistrict, collection_bounds, find_collection_days,
)
from yamada_rag import ANSWER_INSTRUCTIONS, NO_EVIDENCE, chat_json, cited_records, normalize, search


MAX_SEARCHES = 2
MAX_DECISIONS = 3
TARGETS = ("official_documents", "collection_calendars")
TYPE_GUIDE = "\n".join(f"  {key} は {label}" for key, label in COLLECTION_TYPES.items())
NO_COLLECTION_DATES = "登録済みの日程表から、該当する収集日を確認できませんでした。"
HISTORY_INSTRUCTIONS = (
    "history は、直前までの質問と回答です。指示語や省略された対象を解釈するためだけに使い、"
    "回答の根拠は今回の observations に限定します。"
)
STREAM_INSTRUCTIONS = "回答を返す場合は、JSONを action、sources、answer の順で書いてください。"
ANSWER_PREFIX = re.compile(r'\A\s*\{\s*"action"\s*:\s*"answer"\s*,\s*"sources"\s*:\s*')
ANSWER_FIELD = re.compile(r'\s*,\s*"answer"\s*:\s*"')
JSON_STRING_PREFIX = re.compile(r'(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*')
INSTRUCTIONS = f"""{ANSWER_INSTRUCTIONS}
あなたは質問、聞き返しへの返答、検索の観察を読み、次の行動を一つ選びます。
入力の question は最初に尋ねられたことです。follow_up があれば、聞き返しに対する利用者の返答です。
observations は、あなたが指定した検索の結果です。利用者が次に何をしたいかを把握し、同行者、移動手段、使える時間など、
利用者が挙げた条件のうち案内を左右するものも確認してください。

- 検索する場合は action=search。施設・制度・観光などは target=official_documents を選び、
  query に施設名や品目と知りたい項目を入れます。複数の項目がある質問では、まず必要な施設名や品目を一緒に入れます。
  例えば「AとBはどちらが遅く閉まる？」の検索語は「A B 通常の閉館時間」です。
  missing_fact は画面に表示する短い項目名です。個人情報は入れず、「駅から行ける屋内施設」のように書きます。
  最初の結果で重要な条件や質問の一部が確認できず、探せる情報なら remaining_searches の範囲で検索します。
  検索語を不足項目に絞ります。例えば受付方法が利用者の都合に合わない場合は、別の方法や使える時間を探します。
  必要な事実がそろった時点で回答します。
- 個別地区のごみ収集日や日程表の質問では地区名が必要です。元の質問と返答から地区が分からなければ
  action=clarify、field=district とし、町内の地区名を尋ねる短い質問を answer に入れます。
  ごみの申し込み方法や締切を確認する場合は official_documents を検索します。
  地区が分かれば target=collection_calendars、district に地区名を指定します。年度の指定があるときだけ
  fiscal_year に西暦の年度を入れます（令和8年度は2026）。元の質問で指定されたごみの種類を、返答が地区名だけでも引き継ぎます。
  waste_types は質問された区分のキーの配列です。種類の指定がなければ空配列で全区分を照合します。
{TYPE_GUIDE}
  period は通常 next、今日なら today、明日なら tomorrow、日や月などの指定には period、年度全体の一覧なら fiscal_year です。
  period を指定する場合は、start_date と end_date に西暦の開始日・終了日を YYYY-MM-DD で入れます。
  一日だけなら end_date は省けます。today と current_fiscal_year を基準に、4月から翌年3月の年度を解釈します。
  地区に複数の候補があるという観察では、地区名と区番号を合わせて聞くか、目印を尋ねてください。
  日付の観察があれば action=answer とし、収集日を示す資料IDを sources に入れます。アプリが照合済みの日付を表示します。
  収集日と別の質問が同時にある場合は、そちらの根拠も探し、other_answer に収集日以外への回答を書きます。
  日付を確認できる資料がなければ、確認できないと答えます。日程表のURLへの案内は回答に含めません。
- 回答する場合は action=answer、answer に日本語の回答、sources に根拠に使った資料IDを入れます。
  「です・ます」で、利用者がまず知りたい結論から答えます。おすすめは条件に合う候補を選び、理由と利用方法を短く伝えます。
  おすすめを尋ねられたときは、条件に最も合う一案に絞ります。複数案や比較を求められた場合は、施設ごとに情報を整理します。
  雨の日の親子のお出かけなら、駅との位置関係や子どもができることを伝えます。用件に関係のない窓口時間や設備は省きます。
  手続きで制約があるなら、通常の手順と、確認できた代わりの方法を条件付きで案内します。単純な料金などは短く答えます。
  一部に根拠があれば action=answer とし、確認できた事実と確認できない点を伝えます。
  訪問前に未確認の点があれば、連絡先とそこで尋ねる内容を案内します。距離、隣接、設備は、資料がその施設について述べた範囲で伝えます。
  利用日が示されていなければ今日行くと仮定しません。通常の開館時間を伝える場合は曜日ごとの案内にします。
  駅名から施設を特定して閉館時刻を比べるなら、駅と施設の関係を示す資料IDと、比較する双方の時刻を示す資料IDを入れます。
  同じ発信元のページでも、根拠に使った箇所が別々の資料IDならそれぞれ入れます。
  URLはアプリが表示するため answer には入れません。
- 答えられる部分がなく、有効な検索手段もなければ action=insufficient。何を確認できなかったか短く書きます。
  日付指定の混雑状況などの例は「明日の混雑状況は、手元の資料では確認できません。」です。無関係な出典は挙げません。

答えられる可能性があり observations が空なら、検索するか、地区が足りなければ聞き返してください。
既に観察した検索条件をそのまま再指定せず、不足項目に合う条件に変更します。
「行けるところはありますか」のように行き先を尋ねられたら、最も条件に合う場所、そこへ行きやすい理由、そこでできることの3点を案内します。
営業時間、休館日、今日の営業状況は、利用する日時や営業時間について尋ねられたときだけ答えます。
action に必要な項目だけ出力してください。"""


@dataclass
class TurnResult:
    action: str
    answer: str
    sources: list
    pending: dict | None = None


def read_grounded_answer_prefix(content, evidence):
    """出典が照合できた時点から、JSONの回答文のうち復号できる部分を返す。"""
    prefix = ANSWER_PREFIX.match(content)
    if prefix is None:
        return ""
    try:
        sources, end = json.JSONDecoder().raw_decode(content, prefix.end())
    except json.JSONDecodeError:
        return ""
    if not isinstance(sources, list) or not sources or not all(
        isinstance(source, str) and source in evidence for source in sources
    ):
        return ""
    field = ANSWER_FIELD.match(content, end)
    if field is None:
        return ""
    escaped = JSON_STRING_PREFIX.match(content, field.end()).group()
    answer = json.loads(f'"{escaped}"')
    if answer and "\ud800" <= answer[-1] <= "\udbff":
        answer = answer[:-1]
    try:
        answer.encode("utf-8")
    except UnicodeEncodeError:
        return ""
    return answer.lstrip()


def stream_grounded_answer(evidence, on_delta):
    emitted = ""

    def receive(content):
        nonlocal emitted
        answer = read_grounded_answer_prefix(content, evidence)
        if len(answer) > len(emitted) and answer.startswith(emitted):
            on_delta(answer[len(emitted):])
            emitted = answer

    return receive


def make_react_decider(model):
    opener = build_opener(ProxyHandler({}))

    def decide(state, *, actions, on_content=None):
        schema = {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": actions},
                "target": {"type": "string", "enum": TARGETS},
                "query": {"type": "string"},
                "missing_fact": {"type": "string"},
                "district": {"type": "string"},
                "fiscal_year": {"type": "integer"},
                "period": {"type": "string", "enum": COLLECTION_PERIODS},
                "start_date": {"type": "string"},
                "end_date": {"type": "string"},
                "waste_types": {"type": "array", "items": {"type": "string", "enum": list(COLLECTION_TYPES)}},
                "field": {"type": "string", "enum": ["district"]},
                "answer": {"type": "string"},
                "other_answer": {"type": "string"},
                "sources": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["action"],
            "additionalProperties": False,
        }
        instructions = f"{INSTRUCTIONS}\n\n{HISTORY_INSTRUCTIONS}" if state.get("history") else INSTRUCTIONS
        if on_content is not None:
            properties = schema["properties"]
            source_ids = dict.fromkeys(
                source_id for observation in state["observations"] for source_id in observation["source_ids"]
            )
            properties["sources"]["items"]["enum"] = list(source_ids)
            ordered = {key: properties[key] for key in ("action", "sources", "answer")}
            ordered.update(properties)
            schema["properties"] = ordered
            instructions += f"\n\n{STREAM_INSTRUCTIONS}"
        messages = [
            {"role": "system", "content": instructions},
            {"role": "user", "content": json.dumps(state, ensure_ascii=False)},
        ]
        return chat_json(opener, model, messages, schema, context=6144, response_tokens=448, on_content=on_content)

    return decide


def asks_reservation_deadline(text):
    return bool(re.search(r"申[し込]|予約|受付", text) and re.search(r"(?:何日|いつ|何時)まで", text))


def asks_collection_date(text):
    text = normalize(text)
    if re.search(r"収集日|収集予定|回収日|収集.*日程|ごみ.*日程|ごみの日", text):
        return True
    if asks_reservation_deadline(text):
        return False
    waste = re.search(r"ごみ|ぺっとぼとる|空き?びん|乾電池|ぷら|[段だん]ぼーる|缶|新聞|紙ぱっく|蛍光[管灯]|水銀", text)
    timing = re.search(r"今日|明日|次回|次の|何日|何曜日|[0-9]+月|いつ(?!までに)", text)
    return bool(waste and timing)


def run_turn(question, records, decide, *, pending=None, history=(), on_action=None, on_progress=None,
             on_delta=None, today=None, retriever=None):
    today = today or datetime.now(ZoneInfo("Asia/Tokyo")).date()
    fiscal_year = today.year if today.month >= 4 else today.year - 1
    state = {
        "question": pending["question"] if pending else question,
        "today": today.isoformat(),
        "current_fiscal_year": fiscal_year,
        "observations": [],
    }
    if history:
        state["history"] = history
    hint = pending.get("district_hint") if pending else None
    reply = f"{hint}{question}" if hint and re.match(r"^[0-9]+区", normalize(question)) else question
    if pending:
        state["follow_up"] = {"asked": pending["prompt"], "reply": reply}
    wording = (reply, pending["question"]) if pending else (question,)
    calendar_question = asks_collection_date("\n".join(wording))
    reservation_only = not calendar_question and asks_reservation_deadline(normalize(state["question"]))

    def clarify_district(prompt, district_hint=None):
        next_pending = {
            "question": state["question"], "field": "district", "prompt": prompt,
        }
        if district_hint:
            next_pending["district_hint"] = district_hint
        return TurnResult("clarify", prompt, [], next_pending)

    def find_documents(query):
        if retriever is None:
            return search(records, query), "keyword"
        result = retriever(query)
        return result.records, result.mode

    evidence = {}
    previous = {}
    ambiguity = None
    searches = 0
    search_detail = None
    for step in range(MAX_DECISIONS):
        actions = ["insufficient"] if reservation_only else ["clarify", "insufficient"]
        if evidence:
            actions.append("answer")
        remaining = min(MAX_SEARCHES - searches, MAX_DECISIONS - step - 1)
        if remaining:
            actions.append("search")
        state["remaining_searches"] = remaining
        if on_progress:
            on_progress("reviewing" if state["observations"] else "planning", detail=search_detail)
        if on_delta is not None and evidence and not calendar_question:
            decision = decide(state, actions=actions, on_content=stream_grounded_answer(evidence, on_delta))
        else:
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
                    lookup = lambda: find_documents(query)
            elif target == "collection_calendars":
                calendar_question = True
                district = decision.get("district")
                types = decision.get("waste_types", [])
                valid_types = isinstance(types, list) and all(
                    isinstance(key, str) and key in COLLECTION_TYPES for key in types
                )
                if isinstance(district, str) and 0 < len(district.strip()) <= 80 and valid_types:
                    district = district.strip()
                    try:
                        year, start, end = collection_bounds(decision, today, wording=wording)
                    except (KeyError, TypeError, ValueError, OverflowError):
                        pass
                    else:
                        types = tuple(sorted(set(types)))
                        event.update(district=district, fiscal_year=year, start_date=start.isoformat(), waste_types=list(types))
                        if end:
                            event["end_date"] = end.isoformat()
                        key = (target, " ".join(normalize(district).split()), year, start, end, types)
                        lookup = lambda: (find_collection_days(district, year, start, end, types, wording=wording), None)

            passages = []
            retrieval = None
            if lookup is not None:
                if key in previous:
                    passages, retrieval = previous[key]
                    event["status"] = "reused"
                else:
                    search_detail = " ".join(event.get("missing_fact", "").split())[:60] or None
                    if on_progress:
                        on_progress("searching", detail=search_detail)
                    searches += 1
                    try:
                        passages, retrieval = lookup()
                    except AmbiguousDistrict as error:
                        ambiguity = error
                        event.update(status="ambiguous", district_candidates=error.choices)
                    except (OSError, KeyError, TypeError, ValueError):
                        event["status"] = "error"
                    else:
                        passages = [
                            {**record, "id": f"{record['id']}-lookup-{searches}"}
                            if "calendar_answer" in record and record["id"] in evidence
                            and record["text"] != evidence[record["id"]]["text"] else record
                            for record in passages
                        ]
                        previous[key] = (passages, retrieval)
                        event["status"] = "found" if passages else "not_found"
                        if target == "collection_calendars" and passages:
                            ambiguity = None
                evidence.update((record["id"], record) for record in passages)
                event["source_ids"] = [record["id"] for record in passages]
                if retrieval:
                    event["retrieval"] = retrieval
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
        if ambiguity:
            return clarify_district(f"「{ambiguity.name}」には複数の収集区分があります。"
                                    "区番号や、ごみステーションの目印を教えてください。", ambiguity.name)
        if action == "clarify" and decision.get("field") == "district":
            prompt = answer if 0 < len(answer) <= 400 else "山田町内のどの地区か教えてください。"
            return clarify_district(prompt, hint)
        if action == "answer" and sources:
            dates = [record["calendar_answer"] for record in sources if "calendar_answer" in record]
            if dates:
                other_answer = decision.get("other_answer")
                if isinstance(other_answer, str) and other_answer.strip() and len(dates) < len(sources):
                    dates.append(other_answer.strip())
                return TurnResult(action, "\n\n".join(dates), sources)
            if answer and not calendar_question:
                return TurnResult(action, answer, sources)
        if action == "insufficient" and not calendar_question:
            return TurnResult(action, answer or NO_EVIDENCE, sources)
        break
    return TurnResult("insufficient", NO_COLLECTION_DATES if calendar_question else NO_EVIDENCE, [])
