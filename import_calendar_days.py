#!/usr/bin/env python3
"""Build calendar date records from the manually transcribed FY2026 PDF tables.

The recurring weekday/month patterns and the listed exceptions below were
checked against each district PDF with both pdftotext -layout and
pdftotext -bbox-layout, and visually against the rendered tables. The bbox
check keeps the transcription tied to the source PDFs when this file is rerun.
"""

from __future__ import annotations

import argparse
import calendar
import collections
import json
import re
import subprocess
from datetime import date
from pathlib import Path
from tempfile import NamedTemporaryFile


HERE = Path(__file__).resolve().parent
REGISTRY_PATH = HERE / "collection_calendars.json"
OUTPUT_PATH = HERE / "collection_calendar_days.json"

WEEKDAYS = {"月": 0, "火": 1, "水": 2, "木": 3, "金": 4, "土": 5, "日": 6}
MONTHS = tuple(range(4, 13)) + tuple(range(1, 4))

# weekday is Monday=0; nth is 1-based. extra is a date explicitly printed in
# the PDF in addition to the recurring day. January 1–3 are suppressed below.
SCHEDULES = {
    "calendar-2026-arakawa": {
        "burnable": ("火", "金"), "non_burnable": (5, 2, []),
        "pet": (2, 2, []), "plastic": ((2, 2), (2, 4), []),
        "paper": (2, 4), "oversized": [(7, 29), (1, 29)],
    },
    "calendar-2026-funakoshi-1": {
        "burnable": ("水", "土"), "non_burnable": (3, 2, []),
        "pet": (3, 1, []), "plastic": ((3, 1), (3, 3), []),
        "paper": (3, 3), "oversized": [(5, 29), (10, 29)],
    },
    "calendar-2026-funakoshi-2": {
        "burnable": ("水", "土"), "non_burnable": (1, 3, []),
        "pet": (4, 2, []), "plastic": ((4, 2), (1, 4), []),
        "paper": (1, 4), "oversized": [(6, 29), (11, 30)],
    },
    "calendar-2026-funakoshi-3": {
        "burnable": ("月", "木"), "non_burnable": (4, 1, [(12, 30)]),
        "pet": (4, 2, []), "plastic": ((4, 2), (1, 4), []),
        "paper": (1, 4), "oversized": [(6, 29), (11, 30)],
    },
    "calendar-2026-orikasa-1": {
        "burnable": ("火", "金"), "non_burnable": (0, 4, []),
        "pet": (0, 2, []), "plastic": ((0, 2), (3, 4), []),
        "paper": (3, 4), "oversized": [(5, 29), (10, 29)],
    },
    "calendar-2026-orikasa-2": {
        "burnable": ("月", "木"), "non_burnable": (4, 3, []),
        "pet": (1, 2, []), "plastic": ((1, 2), (4, 4), []),
        "paper": (4, 4), "oversized": [(5, 29), (10, 29)],
    },
    "calendar-2026-orikasa-3": {
        "burnable": ("水", "土"), "non_burnable": (4, 3, []),
        "pet": (1, 2, []), "plastic": ((1, 2), (4, 4), []),
        "paper": (4, 4), "oversized": [(5, 29), (10, 29)],
    },
    "calendar-2026-osawa": {
        "burnable": ("水", "土"), "non_burnable": (4, 3, []),
        "pet": (1, 2, []), "plastic": ((1, 2), (4, 4), []),
        "paper": (4, 4), "oversized": [(8, 29), (3, 29)],
    },
    "calendar-2026-toyomane-1": {
        "burnable": ("月", "木"), "non_burnable": (5, 1, [(12, 30)]),
        "pet": (2, 2, []), "plastic": ((2, 2), (2, 4), []),
        "paper": (2, 4), "oversized": [(7, 29), (1, 29)],
    },
    "calendar-2026-toyomane-2": {
        "burnable": ("火", "金"), "non_burnable": (5, 1, [(12, 30)]),
        "pet": (2, 2, []), "plastic": ((2, 2), (2, 4), []),
        "paper": (2, 4), "oversized": [(7, 29), (1, 29)],
    },
    "calendar-2026-toyomane-3": {
        "burnable": ("月", "木"), "non_burnable": (5, 2, []),
        "pet": (2, 2, []), "plastic": ((2, 2), (2, 4), []),
        "paper": (2, 4), "oversized": [(7, 29), (1, 29)],
    },
    "calendar-2026-yamada-1": {
        "burnable": ("月", "木"), "non_burnable": (5, 4, []),
        "pet": (4, 1, [(12, 29)]),
        "plastic": ((4, 1), (2, 3), [(12, 29)]),
        "paper": (2, 3), "oversized": [(4, 29), (9, 29)],
    },
    "calendar-2026-yamada-2": {
        "burnable": ("火", "金"), "non_burnable": (5, 3, []),
        "pet": (0, 1, []), "plastic": ((0, 1), (0, 3), []),
        "paper": (0, 3), "oversized": [(4, 29), (9, 29)],
    },
    "calendar-2026-yamada-3": {
        "burnable": ("月", "木"), "non_burnable": (5, 3, []),
        "pet": (2, 1, []), "plastic": ((2, 1), (2, 3), []),
        "paper": (2, 3), "oversized": [(4, 29), (9, 29)],
    },
    "calendar-2026-yamada-4-1": {
        "burnable": ("月", "木"), "non_burnable": (5, 4, []),
        "pet": (2, 1, []), "plastic": ((2, 1), (2, 3), []),
        "paper": (2, 3), "oversized": [(4, 29), (9, 29)],
    },
    "calendar-2026-yamada-4-2": {
        "burnable": ("火", "金"), "non_burnable": (5, 4, []),
        "pet": (2, 1, []), "plastic": ((2, 1), (2, 3), []),
        "paper": (2, 3), "oversized": [(4, 29), (9, 29)],
    },
    "calendar-2026-yamada-5-1": {
        "burnable": ("水", "土"), "non_burnable": (3, 2, []),
        "pet": (0, 1, []), "plastic": ((0, 1), (0, 3), []),
        "paper": (0, 3), "oversized": [(4, 29), (9, 29)],
    },
    "calendar-2026-yamada-5-2": {
        "burnable": ("火", "金"), "non_burnable": (3, 2, []),
        "pet": (0, 1, []), "plastic": ((0, 1), (0, 3), []),
        "paper": (0, 3), "oversized": [(4, 29), (9, 29)],
    },
    "calendar-2026-yamada-6": {
        "burnable": ("月", "木"), "non_burnable": (5, 4, []),
        "pet": (1, 1, []), "plastic": ((1, 1), (1, 3), []),
        "paper": (1, 3), "oversized": [(4, 29), (9, 29)],
    },
    "calendar-2026-yamada-7": {
        "burnable": ("月", "木"), "non_burnable": (5, 3, []),
        "pet": (1, 1, []), "plastic": ((1, 1), (1, 3), []),
        "paper": (1, 3), "oversized": [(4, 29), (9, 29)],
    },
}

LABELS = (
    ("burnable", "燃やせるごみ"),
    ("non_burnable_glass_batteries", "燃やせないごみ・空びん・乾電池"),
    ("pet_bottles_cans", "ペットボトル・缶"),
    ("plastic", "プラスチック"),
    (
        "paper_and_hazardous_items",
        "紙製容器包装・新聞・紙パック・雑誌・ダンボール・蛍光管・水銀体温計・水銀血圧計",
    ),
    ("oversized", "粗大ごみ（予約制）"),
)

SPECIAL_NOTES = {
    "calendar-2026-funakoshi-3": [
        "燃やせないごみ・空びん・乾電池は12月30日にも収集します（通常の第1金曜12月4日とは別日）。"
    ],
    "calendar-2026-toyomane-1": [
        "燃やせないごみ・空びん・乾電池は12月30日にも収集します（通常の第1土曜12月5日とは別日）。"
    ],
    "calendar-2026-toyomane-2": [
        "燃やせないごみ・空びん・乾電池は12月30日にも収集します（通常の第1土曜12月5日とは別日）。"
    ],
    "calendar-2026-yamada-1": [
        "ペットボトル・缶とプラスチックは12月29日にも収集します（通常の第1金曜12月4日とは別日）。"
    ],
}


def fiscal_year(month: int) -> int:
    return 2026 if month >= 4 else 2027


def nth_weekday(year: int, month: int, weekday: int, nth: int) -> date:
    days = [week[weekday] for week in calendar.monthcalendar(year, month) if week[weekday]]
    if len(days) < nth:
        raise ValueError(f"No {nth}th weekday in {year}-{month:02}")
    return date(year, month, days[nth - 1])


def recurring_dates(rule: tuple[int, int, list[tuple[int, int]]]) -> list[date]:
    weekday, nth, extras = rule
    dates = []
    for month in MONTHS:
        day = nth_weekday(fiscal_year(month), month, weekday, nth)
        if not (month == 1 and day.day <= 3):
            dates.append(day)
    dates.extend(date(fiscal_year(month), month, day) for month, day in extras)
    return sorted(set(dates))


def weekly_dates(weekdays: tuple[str, str]) -> list[date]:
    wanted = {WEEKDAYS[day] for day in weekdays}
    dates = []
    for month in MONTHS:
        year = fiscal_year(month)
        for day in range(1, calendar.monthrange(year, month)[1] + 1):
            current = date(year, month, day)
            if current.weekday() in wanted and not (month == 1 and day <= 3):
                dates.append(current)
    return dates


def oversized_dates(month_days: list[tuple[int, int]]) -> list[date]:
    return sorted(date(fiscal_year(month), month, day) for month, day in month_days)


def monthly_table_dates(rule: tuple[int, int] | tuple[int, int, list[tuple[int, int]]]) -> collections.Counter:
    weekday, nth = rule[:2]
    found = []
    for month in MONTHS:
        day = nth_weekday(fiscal_year(month), month, weekday, nth).day
        if not (month == 1 and day <= 3):
            found.append((month, day))
    if len(rule) == 3:
        found.extend(rule[2])
    return collections.Counter(found)


def oversized_table_dates(month_days: list[tuple[int, int]]) -> collections.Counter:
    return collections.Counter(month_days)


def read_bbox_groups(pdf: Path) -> list[collections.Counter]:
    result = subprocess.run(
        ["pdftotext", "-bbox-layout", str(pdf), "-"],
        check=True,
        capture_output=True,
        text=True,
    )
    month_headers: list[tuple[int, float]] = []
    date_words: list[tuple[float, float, str]] = []
    for match in re.finditer(r'<word\s+([^>]*)>([^<]+)</word>', result.stdout):
        word = match.group(2).strip()
        attrs = dict(re.findall(r'(\w+)="([^"]+)"', match.group(1)))
        x_min, x_max, y_min = (
            float(attrs["xMin"]), float(attrs["xMax"]), float(attrs["yMin"])
        )
        if word in {f"{month}月" for month in range(1, 13)}:
            month_headers.append((int(word[:-1]), (x_min + x_max) / 2))
        elif word.isdecimal() and 100 < y_min < 710 and int(word) <= 31:
            date_words.append((y_min, x_min, word))

    if len(month_headers) != 12:
        raise ValueError(f"Could not identify all month columns in {pdf.name}")

    groups: list[list] = []
    for y_min, x_min, word in sorted(date_words):
        if not groups or abs(y_min - groups[-1][0]) > 2:
            groups.append([y_min, []])
        adjusted_x = x_min + (4 if len(word) == 1 else 0)
        month = min(month_headers, key=lambda header: abs(adjusted_x - header[1]))[0]
        groups[-1][1].append((month, int(word)))
    return [collections.Counter(values) for _, values in groups]


def validate_source_table(pdf: Path, config: dict) -> None:
    calendar_id = pdf.stem
    if not pdf.is_file():
        raise FileNotFoundError(pdf)

    groups = read_bbox_groups(pdf)
    if calendar_id in {
        "calendar-2026-funakoshi-3",
        "calendar-2026-toyomane-1",
        "calendar-2026-toyomane-2",
    }:
        source_rows = [
            groups[0] + groups[1] + groups[2],
            groups[3], groups[4], groups[5], groups[6], groups[7],
        ]
    elif calendar_id == "calendar-2026-yamada-1":
        source_rows = [
            groups[0], groups[1] + groups[2], groups[3] + groups[4] + groups[5],
            groups[6], groups[7], groups[8],
        ]
    else:
        source_rows = groups

    expected_rows = [
        monthly_table_dates(config["non_burnable"]),
        monthly_table_dates(config["pet"]),
        monthly_table_dates(config["plastic"][0])
        + collections.Counter(config["plastic"][2]),
        monthly_table_dates(config["plastic"][1]),
        monthly_table_dates(config["paper"]),
        oversized_table_dates(config["oversized"]),
    ]
    if len(source_rows) != len(expected_rows):
        raise ValueError(
            f"{calendar_id}: expected 6 date rows, found {len(source_rows)}"
        )
    for row_number, (actual, expected) in enumerate(zip(source_rows, expected_rows), 1):
        if actual != expected:
            raise ValueError(
                f"{calendar_id}: source table row {row_number} differs; "
                f"actual={sorted(actual.items())}, expected={sorted(expected.items())}"
            )

    layout = subprocess.run(
        ["pdftotext", "-layout", str(pdf), "-"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    match = re.search(r"毎週\s*([月火水木金土日])・([月火水木金土日])曜日", layout)
    if not match or tuple(match.groups()) != config["burnable"]:
        raise ValueError(f"{calendar_id}: burnable weekday banner differs")


def build_notes(calendar_id: str, config: dict) -> list[str]:
    first, second = config["burnable"]
    return [
        f"燃やせるごみは毎週{first}・{second}曜日。1回につき1世帯2袋まで、ごみステーションには午前8時までに出してください。",
        "1月1日～3日は清掃センター休業のため収集しません（お盆期間は通常どおり）。",
        "12月29日～31日は収集時間・内容等が通常と異なる場合があります。",
        "収集されなかったごみは中身を確認して出し直してください。",
        "粗大ごみは予約制です。収集月の20日までに（有）芳賀清掃社へ連絡してください（1世帯1つまで）。",
        *SPECIAL_NOTES.get(calendar_id, []),
    ]


def build_rows(config: dict) -> list[dict]:
    plastic_dates = sorted(
        set(
            recurring_dates((*config["plastic"][0], []))
            + recurring_dates((*config["plastic"][1], []))
            + [date(fiscal_year(month), month, day) for month, day in config["plastic"][2]]
        )
    )
    dates_by_key = {
        "burnable": weekly_dates(config["burnable"]),
        "non_burnable_glass_batteries": recurring_dates(config["non_burnable"]),
        "pet_bottles_cans": recurring_dates(config["pet"]),
        "plastic": plastic_dates,
        "paper_and_hazardous_items": recurring_dates((*config["paper"], [])),
        "oversized": oversized_dates(config["oversized"]),
    }
    return [
        {"key": key, "label": label, "dates": [day.isoformat() for day in dates_by_key[key]]}
        for key, label in LABELS
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description="令和8年度の地区別PDFと収集日データを照合します。")
    parser.add_argument("--pdf-dir", type=Path, required=True, help="資料IDをファイル名としたPDFのフォルダです。")
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH, help="照合済みの日付JSONの保存先です。")
    args = parser.parse_args()
    records = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    record_ids = [record["id"] for record in records]
    if set(record_ids) != set(SCHEDULES):
        raise ValueError("Schedule definitions do not match collection_calendars.json")

    output = {}
    for calendar_id in record_ids:
        config = SCHEDULES[calendar_id]
        validate_source_table(args.pdf_dir / f"{calendar_id}.pdf", config)
        output[calendar_id] = {
            "rows": build_rows(config),
            "notes": build_notes(calendar_id, config),
        }

    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=args.output.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(output, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.close()
            temporary.replace(args.output)
        finally:
            temporary.unlink(missing_ok=True)
    print(f"令和8年度の{len(output)}区分を公式PDFと照合しました。")


if __name__ == "__main__":
    main()
