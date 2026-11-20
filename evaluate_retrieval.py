"""現行検索と意味検索の候補を、回答生成の前に比較する。"""

import argparse
import json
from pathlib import Path
from statistics import median
from time import perf_counter

from yamada_rag import SEARCH_LIMIT, load_records, search


QUESTION_FILE = Path(__file__).with_name("evaluation") / "retrieval_cases.json"
MODES = ("keyword", "semantic", "hybrid")
KINDS = ("exact", "paraphrase", "multi_source")


def evaluate_search(cases, retrieve, mode):
    rows = []
    for case in cases:
        start = perf_counter()
        records, actual_mode = retrieve(case["question"])
        elapsed = (perf_counter() - start) * 1000
        ids = [record["id"] for record in records[:SEARCH_LIMIT]]
        missing = [group for group in case["expected_sources"] if not set(group).intersection(ids)]
        rows.append({
            **case, "mode": actual_mode, "retrieved_ids": ids, "missing_sources": missing,
            "passed": actual_mode == mode and not missing, "elapsed_ms": round(elapsed, 2),
        })
    return rows


def summarize(rows):
    summary = {}
    for kind in ("all", *KINDS):
        selected = [row for row in rows if kind == "all" or row["kind"] == kind]
        if not selected:
            continue
        summary[kind] = {
            "passed": sum(row["passed"] for row in selected),
            "total": len(selected),
            "median_ms": round(median(row["elapsed_ms"] for row in selected), 2),
        }
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", action="append", choices=MODES, help="検索方式です。省略時は現在のキーワード検索を測ります。")
    parser.add_argument("--questions", type=Path, default=QUESTION_FILE, help="検索を評価する質問ファイルです。")
    parser.add_argument("--output", type=Path, help="各質問の検索結果を保存します。")
    args = parser.parse_args()
    try:
        cases = json.loads(args.questions.read_text(encoding="utf-8"))
        records = load_records()
        if not cases or len({case["id"] for case in cases}) != len(cases):
            raise ValueError("評価質問が空か、IDが重複しています。")
        known = {record["id"] for record in records}
        for case in cases:
            if case["kind"] not in KINDS or not case["question"].strip() or not case["expected_sources"]:
                raise ValueError(f"評価質問の形式を確認してください。 {case['id']}")
            if any(not known.intersection(group) for group in case["expected_sources"]):
                raise ValueError(f"評価に必要な資料がありません。取得手順を確認してください。 {case['id']}")

        report = {"record_count": len(records), "limit": SEARCH_LIMIT, "modes": {}}
        unavailable = False
        for mode in dict.fromkeys(args.mode or ("keyword",)):
            if mode == "keyword":
                def retrieve(query):
                    return search(records, query), "keyword"
            else:
                from yamada_embeddings import make_retriever

                search_for_query = make_retriever(records, mode=mode)

                def retrieve(query):
                    result = search_for_query(query)
                    return result.records, result.mode

            start = perf_counter()
            _, first_mode = retrieve("山田町")
            first_call_ms = round((perf_counter() - start) * 1000, 2)
            rows = evaluate_search(cases, retrieve, mode)
            summary = summarize(rows)
            fallback = sum(row["mode"] != mode for row in rows)
            unavailable |= fallback > 0
            report["modes"][mode] = {
                "first_call": {"mode": first_mode, "elapsed_ms": first_call_ms},
                "summary": summary, "fallbacks": fallback, "results": rows,
            }
            print(f"{mode}　準備用の初回検索 {first_call_ms:.2f}ms（評価時間とは別集計）")
            for kind, score in summary.items():
                print(f"{mode} / {kind}　{score['passed']}/{score['total']}件　中央値 {score['median_ms']:.2f}ms")
            if fallback:
                print(f"{mode}　{fallback}件は別方式に切り替わりました。索引と埋め込みサーバーを確認してください。")
        if args.output:
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 2 if unavailable else 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
        parser.exit(2, f"検索評価を実行できませんでした。 {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
