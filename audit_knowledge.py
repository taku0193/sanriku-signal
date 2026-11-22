"""ローカルの資料、添付一覧、地区別日程表、意味検索の索引を照合する。"""

import argparse
import json
from collections import Counter
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from import_town_knowledge import ORIGIN, TOURISM_ORIGIN, source_url
from yamada_calendars import COLLECTION_TYPES
from yamada_rag import load_records


ROOT = Path(__file__).resolve().parent


def read_json(filename):
    return json.loads((ROOT / filename).read_text(encoding="utf-8"))


def summarize_import(filename, origin, issues):
    snapshot = read_json(filename)
    documents = snapshot["documents"]
    by_url = {doc["url"] for doc in documents}
    skipped = {item["url"] for item in snapshot["skipped"]}
    retained = {item["url"] for item in snapshot["skipped"] if item["reused_previous"]}
    if len(by_url) != len(documents) or len(skipped) != len(snapshot["skipped"]) or (skipped & by_url) != retained:
        issues.append(f"{filename} の記事URLと取得ログが一致しません。")
    for doc in documents:
        if not doc["records"] or source_url(doc["url"], origin) != doc["url"]:
            issues.append(f"{doc['url']} の記事URLまたは本文が無効です。")
    all_attachments = {url for doc in documents for url in doc.get("attachments", [])}
    if any(source_url(url, origin) != url for url in all_attachments):
        issues.append(f"{filename} の添付URLの形式を確認してください。")
    return {
        "candidates": len(by_url | skipped),
        "articles": len(documents),
        "passages": sum(len(doc["records"]) for doc in documents),
        "categories": dict(Counter(doc["category"] for doc in documents)),
        "articles_without_published_date": sum(not doc["published"] for doc in documents),
        "attachments": dict(Counter(Path(urlsplit(url).path).suffix.lower() for url in sorted(all_attachments))),
        "skipped": snapshot["skipped"],
    }


def audit_calendars(issues):
    calendars = read_json("collection_calendars.json")
    days = read_json("collection_calendar_days.json")
    ids = {row["id"] for row in calendars}
    if len(ids) != len(calendars) or ids != days.keys():
        issues.append("地区別日程表の日付データと資料IDが一致しません。")
    for calendar in calendars:
        year, key = calendar["fiscal_year"], calendar["id"]
        start, end = date(year, 4, 1), date(year + 1, 3, 31)
        rows = days.get(key, {}).get("rows", [])
        if len(rows) != len(COLLECTION_TYPES) or {row["key"] for row in rows} != COLLECTION_TYPES.keys():
            issues.append(f"{key} のごみ区分を確認してください。")
        for row in rows:
            dates = [date.fromisoformat(value) for value in row["dates"]]
            if not dates or sorted(set(dates)) != dates or dates[0] < start or dates[-1] > end:
                issues.append(f"{key} の {row['key']} の収集日を確認してください。")
    return {"tables": len(calendars), "rows": sum(len(calendar["rows"]) for calendar in days.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--embeddings", action="store_true", help="各資料の本文と埋め込み索引を照合します。")
    args = parser.parse_args()
    issues = []
    try:
        records = load_records()
        curated = [record for record in records if "published" not in record]
        today = datetime.now(ZoneInfo("Asia/Tokyo")).date()
        invalid_dates = []
        for record in records:
            url = urlsplit(record["url"])
            if url.scheme != "https" or not url.hostname or not all(record[key].strip() for key in ("source", "title", "text")):
                issues.append(f"{record['id']} の出典または本文が無効です。")
            for key in ("checked", "published"):
                value = record.get(key)
                if not value and key == "published":
                    continue
                try:
                    if date.fromisoformat(value) <= today:
                        continue
                except (ValueError, TypeError):
                    pass
                invalid_dates.append({"id": record["id"], "field": key, "value": value})
        if invalid_dates:
            issues.append("無効な日付または将来の掲載日・確認日があります。")
        texts = Counter(" ".join(record["text"].split()) for record in records)
        imports = {
            "town": summarize_import("town_articles.json", ORIGIN, issues),
            "tourism": summarize_import("tourism_articles.json", TOURISM_ORIGIN, issues),
        }
        calendars = audit_calendars(issues)
        photos = read_json("photo_catalog.json")
        ids = {record["id"] for record in records}
        for photo in photos:
            if not ids.issuperset(photo["record_ids"]) or not (ROOT / "web" / photo["file"]).is_file():
                issues.append(f"{photo['file']} の写真または参照先が見つかりません。")
        report = {
            "passages": len(records),
            "curated_passages": len(curated),
            "curated_source_urls": len({record["url"] for record in curated}),
            "identical_passages_after_first": sum(count - 1 for count in texts.values()),
            "passages_with_replacement_character": [record["id"] for record in records if "\ufffd" in record["text"]],
            "invalid_dates": invalid_dates,
            "imports": imports,
            "calendars": calendars,
            "photo_references": len(photos),
        }
        if args.embeddings:
            from yamada_embeddings import DEFAULT_CACHE, _default_embedder, _documents, _load_index, _read_cache

            index = _load_index(DEFAULT_CACHE, _documents(records), _default_embedder())
            cache = _read_cache(DEFAULT_CACHE)
            if index is None or cache["records"].keys() != ids or not index[0]:
                issues.append("資料の本文・IDと埋め込み索引が一致しません。")
            report["embedding_records"] = len(index[2]) if index else 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(2, f"資料を照合できませんでした。 {error}\n")
    print(json.dumps({**report, "issues": issues}, ensure_ascii=False, indent=2))
    return 1 if issues else 0


if __name__ == "__main__":
    raise SystemExit(main())
