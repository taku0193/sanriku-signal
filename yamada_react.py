"""Gemmaが行動を選び、検索結果を観察して次の行動を決める。"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.request import ProxyHandler, build_opener
from zoneinfo import ZoneInfo

from yamada_calendars import (
    COLLECTION_PERIODS, COLLECTION_TYPES, AmbiguousDistrict, collection_bounds, find_collection_days,
)
from yamada_rag import ANSWER_INSTRUCTIONS, NO_EVIDENCE, chat_json, cited_records, normalize, search


MAX_SEARCHES = 3
MAX_DECISIONS = MAX_SEARCHES + 1
TARGETS = ("official_documents", "collection_calendars")
TYPE_GUIDE = "\n".join(f"  {key} は {label}" for key, label in COLLECTION_TYPES.items())
NO_COLLECTION_DATES = "登録済みの日程表から、該当する収集日を確認できませんでした。"
INSUFFICIENT_MESSAGES = {
    "live_information": "手元の資料では、現在の状況や当日の変更を確認できませんでした。施設や運営元、町の最新のお知らせをご確認ください。",
    "outside_scope": "岩手県山田町の観光や暮らしを案内しています。山田町に関係する内容をお尋ねください。",
}
HISTORY_INSTRUCTIONS = (
    "history は、直前までの質問と回答です。指示語や省略された対象を解釈するためだけに使い、"
    "回答の根拠は今回の observations に限定します。"
)
STREAM_INSTRUCTIONS = "回答を返す場合は、JSONを action、sources、answer の順で書いてください。"
ANSWER_PREFIX = re.compile(r'\A\s*\{\s*"action"\s*:\s*"answer"\s*,\s*"sources"\s*:\s*')
ANSWER_FIELD = re.compile(r'\s*,\s*"answer"\s*:\s*"')
JSON_STRING_PREFIX = re.compile(r'(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*')
INSTRUCTIONS = Path(__file__).with_name("prompts").joinpath("react.md").read_text(encoding="utf-8").rstrip().replace("{ANSWER_INSTRUCTIONS}", ANSWER_INSTRUCTIONS).replace("{TYPE_GUIDE}", TYPE_GUIDE)


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
                "field": {"type": "string", "enum": ["district", "condition"]},
                "reason": {"type": "string", "enum": ["missing_evidence", *INSUFFICIENT_MESSAGES]},
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
    if re.search(r"創刊|発行|刊行|出版", text) and not re.search(r"ごみ|収集|回収|出[すせ]|捨て|処分", text):
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

    def clarify(prompt, field, district_hint=None):
        next_pending = {
            "question": state["question"], "field": field, "prompt": prompt,
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
        actions = ["clarify", "insufficient"] if not reservation_only and (calendar_question or not pending) else ["insufficient"]
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
            return clarify(f"「{ambiguity.name}」には複数の収集区分があります。"
                           "区番号や、ごみステーションの目印を教えてください。", "district", ambiguity.name)
        if action == "clarify" and decision.get("field") == "district" and calendar_question:
            prompt = answer if 0 < len(answer) <= 400 else "山田町内のどの地区か教えてください。"
            return clarify(prompt, "district", hint)
        if (action == "clarify" and decision.get("field") == "condition" and not calendar_question
                and not pending and 0 < len(answer) <= 120 and not re.search(r"https?://", answer, re.I)):
            return clarify(" ".join(answer.split()), "condition")
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
            reason = decision.get("reason")
            message = INSUFFICIENT_MESSAGES.get(reason, NO_EVIDENCE) if isinstance(reason, str) else NO_EVIDENCE
            return TurnResult(action, message, [])
        break
    return TurnResult("insufficient", NO_COLLECTION_DATES if calendar_question else NO_EVIDENCE, [])
