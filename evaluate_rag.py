"""同じ質問で、初回検索のみ・旧追加検索・ReActの回答を評価する。"""

import argparse
import json
import re
import statistics
import unicodedata
from pathlib import Path
from time import perf_counter

from yamada_rag import DEFAULT_OLLAMA_MODEL, answer_question, load_records, make_ollama_decider
from yamada_react import make_react_decider, run_turn


QUESTION_FILE = Path(__file__).with_name("evaluation") / "questions.json"
MODES = {"baseline": "初回検索のみ", "agentic": "旧・追加検索あり", "react": "ReAct"}


def check_answer(case, answer, citations):
    normalized = " ".join(unicodedata.normalize("NFKC", answer).split())
    missing_patterns = [pattern for pattern in case["required_patterns"] if not re.search(pattern, normalized)]
    forbidden_matches = [pattern for pattern in case.get("forbidden_patterns", []) if re.search(pattern, normalized)]

    expected_sources = case["required_sources"]
    actual_sources = {record["id"]: record["url"] for record in citations}
    missing_sources = {key: url for key, url in expected_sources.items() if actual_sources.get(key) != url}
    unexpected_sources = actual_sources if not expected_sources else {}
    answer_passed = not (missing_patterns or forbidden_matches)
    sources_passed = not (missing_sources or unexpected_sources)
    return {
        "passed": answer_passed and sources_passed,
        "answer_passed": answer_passed,
        "sources_passed": sources_passed,
        "missing_patterns": missing_patterns,
        "forbidden_matches": forbidden_matches,
        "missing_sources": missing_sources,
        "unexpected_sources": unexpected_sources,
    }


def evaluate_case(case, mode, records, decide):
    searches = []
    turns = []

    def record_search(query, source_ids):
        searches.append({"query": query, "source_ids": list(source_ids)})

    start = perf_counter()
    if mode == "react":
        expectations = {**case, **case.get("react", {})}

        def evaluate_turn(question, expected, pending=None):
            actions = []
            result = run_turn(question, records, decide, pending=pending, on_action=actions.append)
            for event in actions:
                if event["action"] == "search" and event["status"] in {"found", "not_found", "error"}:
                    searches.append(event)
            checks = check_answer(expected, result.answer, result.sources)
            expected_action = expected.get("action", "answer" if expected["required_sources"] else "insufficient")
            action_passed = result.action == expected_action
            if "first_action" in expected:
                action_passed = action_passed and bool(actions) and actions[0]["action"] == expected["first_action"]
            turns.append({
                "question": question, "action": result.action, "expected_action": expected_action,
                "answer": result.answer, "actions": actions,
                "citations": [{key: row[key] for key in ("id", "url")} for row in result.sources],
                **checks, "action_passed": action_passed, "passed": checks["passed"] and action_passed,
            })
            return result

        result = evaluate_turn(case["question"], expectations)
        followup = expectations.get("follow_up")
        continued = not followup or result.pending is not None
        if followup and result.pending:
            result = evaluate_turn(followup["question"], followup, result.pending)
            expectations = followup
        answer, citations = result.answer, result.sources
        checks = check_answer(expectations, answer, citations)
        checks["passed"] = continued and all(turn["passed"] for turn in turns)
    else:
        expectations = case
        answer, citations = answer_question(
            case["question"], records, decide, baseline=mode == "baseline", on_search=record_search,
        )
        checks = check_answer(case, answer, citations)
    elapsed = round(perf_counter() - start, 3)
    return {
        "case_id": case["id"],
        "mode": mode,
        "category": case["category"],
        "question": case["question"],
        "expected_answer": expectations["expected_answer"],
        "expected_sources": expectations["required_sources"],
        "answer": answer,
        "citations": [{"id": record["id"], "url": record["url"]} for record in citations],
        "searches": searches,
        **({"turns": turns} if turns else {}),
        "elapsed_seconds": elapsed,
        **checks,
    }


def summarize(results):
    summary = {}
    for mode, label in MODES.items():
        rows = [row for row in results if row["mode"] == mode]
        if not rows:
            continue
        passed = sum(row["passed"] for row in rows)
        median = statistics.median(row["elapsed_seconds"] for row in rows)
        summary[mode] = {"passed": passed, "total": len(rows), "median_seconds": round(median, 3)}
        print(f"{label}　{passed}/{len(rows)}件合格　応答時間の中央値 {median:.2f}秒")
    return summary


def main():
    parser = argparse.ArgumentParser(description="山田町RAGの回答・出典・応答時間を比較します。")
    parser.add_argument("--model", default=DEFAULT_OLLAMA_MODEL, help=f"Ollamaのモデル名（既定は {DEFAULT_OLLAMA_MODEL}）")
    parser.add_argument("--case", action="append", metavar="ID", help="指定した質問だけを評価します。複数指定できます。")
    parser.add_argument("--mode", action="append", choices=MODES, help="評価方式です。省略時は初回検索のみと旧追加検索を比較します。")
    parser.add_argument("--output", type=Path, metavar="FILE", help="回答・出典・検索履歴を含む結果JSONを保存します。")
    args = parser.parse_args()

    try:
        cases = json.loads(QUESTION_FILE.read_text(encoding="utf-8"))
        by_id = {case["id"]: case for case in cases}
        if not cases or len(by_id) != len(cases):
            parser.error("評価の質問が空か、IDが重複しています。")
        if args.case:
            unknown = [case_id for case_id in args.case if case_id not in by_id]
            if unknown:
                parser.error(f"評価対象にないIDです。 {', '.join(unknown)}")
            cases = [by_id[case_id] for case_id in dict.fromkeys(args.case)]

        records = load_records()
        modes = tuple(dict.fromkeys(args.mode or ("baseline", "agentic")))
        react = make_react_decider(args.model) if "react" in modes else None
        legacy = make_ollama_decider(args.model, catalog=records)
        print(f"{args.model} を準備中（初回の読み込みは計測外）", flush=True)
        legacy("評価前の準備です。", [], can_search=False)

        results = []
        for case in cases:
            for mode in modes:
                label = MODES[mode]
                row = evaluate_case(case, mode, records, react if mode == "react" else legacy)
                results.append(row)
                status = "合格" if row["passed"] else "要確認"
                answer_status = "○" if row["answer_passed"] else "×"
                sources_status = "○" if row["sources_passed"] else "×"
                print(
                    f"{case['id']}　{label}　{status}（回答{answer_status} 出典{sources_status}）"
                    f"　{row['elapsed_seconds']:.2f}秒　検索{len(row['searches'])}回",
                    flush=True,
                )

        summary = summarize(results)
        if args.output:
            report = {"model": args.model, "summary": summary, "results": results}
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, re.error) as error:
        parser.exit(2, f"評価を実行できませんでした。 {error}\n")

    return int(any(not row["passed"] for row in results))


if __name__ == "__main__":
    raise SystemExit(main())
