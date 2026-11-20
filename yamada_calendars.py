"""山田町の地区別ごみ収集日程表を地区と西暦年度で照合する。"""

import json
import re
import unicodedata
from datetime import date, timedelta
from itertools import groupby
from pathlib import Path


_CALENDARS_PATH = Path(__file__).with_name("collection_calendars.json")
_DAYS_PATH = Path(__file__).with_name("collection_calendar_days.json")
COLLECTION_TYPES = {
    "burnable": "燃やせるごみ、可燃ごみ",
    "non_burnable_glass_batteries": "燃やせないごみ、空びん、乾電池",
    "pet_bottles_cans": "ペットボトル、缶",
    "plastic": "プラスチック、プラ",
    "paper_and_hazardous_items": "紙、新聞、紙パック、ダンボール、蛍光管、水銀体温計、水銀血圧計",
    "oversized": "粗大ごみ",
}
COLLECTION_PERIODS = ("next", "today", "tomorrow", "period", "fiscal_year")
WEEKDAYS = "月火水木金土日"


class AmbiguousDistrict(ValueError):
    def __init__(self, name, choices):
        super().__init__(name)
        self.name = name
        self.choices = choices


def normalize_district(text):
    digits = "〇一二三四五六七八九"
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"([一二三四五六七八九])丁目", lambda match: f"{digits.index(match[1])}丁目", text)


def calendars_for_year(year):
    return [
        row for row in json.loads(_CALENDARS_PATH.read_text(encoding="utf-8"))
        if row["fiscal_year"] == year
    ]


def district_names(row):
    return (row["district"], *row.get("aliases", []))


def find_collection_calendar(district: str, fiscal_year: int) -> list[dict]:
    """表記を揃えた地区名と西暦年度が一致する日程表を返す。"""
    if type(district) is not str or type(fiscal_year) is not int:
        return []

    district = normalize_district(district).strip().removesuffix("地区")
    matches = [row for row in calendars_for_year(fiscal_year) if district in district_names(row)]
    return matches if len(matches) == 1 else []


def resolve_district(district, year, wording):
    by_name = {}
    for row in calendars_for_year(year):
        for name in district_names(row):
            by_name.setdefault(normalize_district(name), []).append(row)
    district = normalize_district(district).strip().removesuffix("地区")
    proposed = by_name.get(district, [])
    matches = proposed
    label = district
    if wording:
        names = []
        for phrase in wording:
            phrase = normalize_district(phrase)
            for name in sorted(by_name, key=len, reverse=True):
                if re.search(re.escape(name) + r"(?![0-9区])", phrase) and not any(name in longer for longer in names):
                    names.append(name)
            if names:
                break
        candidates = [(name, by_name[name]) for name in names if any(row in proposed for row in by_name[name])]
        if not candidates:
            return None
        # 呼び名が複数の表を指すときは、モデルが選んだ表名で候補を狭めない。
        label, matches = next((item for item in candidates if item[0] == district), candidates[0])
    if len(matches) > 1:
        raise AmbiguousDistrict(label, [row["district"] for row in matches])
    return matches[0] if matches else None


def collection_bounds(decision, today):
    """モデルが指定した期間を日本時間の日付と西暦年度に揃える。"""
    has_dates = "start_date" in decision or "end_date" in decision
    period = decision.get("period", "period" if has_dates else "next")
    if period not in COLLECTION_PERIODS:
        raise ValueError("収集日の期間が無効です。")
    if has_dates and period != "period":
        raise ValueError("収集日の指定が競合しています。")
    start, end = today, None
    if period == "next":
        start += timedelta(days=1)
    elif period in ("today", "tomorrow"):
        if period == "tomorrow":
            start += timedelta(days=1)
        end = start
    elif period == "period":
        start = date.fromisoformat(decision["start_date"])
        end = date.fromisoformat(decision.get("end_date", decision["start_date"]))
        if start > end:
            raise ValueError("収集日の期間が逆です。")

    default_year = start.year if start.month >= 4 else start.year - 1
    year = decision.get("fiscal_year", default_year)
    if type(year) is not int or not 1 <= year < 9999:
        raise ValueError("収集日程表の年度が無効です。")
    if period == "fiscal_year":
        start, end = date(year, 4, 1), date(year + 1, 3, 31)
    return year, start, end


def format_day(day):
    return f"{day.year}年{day.month}月{day.day}日（{WEEKDAYS[day.weekday()]}）"


def find_collection_days(district, year, start, end, waste_types, *, wording=()):
    calendar = resolve_district(district, year, wording)
    if not calendar:
        return []
    schedule = json.loads(_DAYS_PATH.read_text(encoding="utf-8")).get(calendar["id"])
    first, last = date(year, 4, 1), date(year + 1, 3, 31)
    if not schedule or start > last or (end is not None and (start < first or end > last)):
        return []

    rows = schedule["rows"]
    if not set(waste_types or COLLECTION_TYPES) <= {row["key"] for row in rows}:
        return []
    selections = []
    for row in rows:
        if waste_types and row["key"] not in waste_types:
            continue
        dates = sorted(date.fromisoformat(value) for value in row["dates"])
        dates = [day for day in dates if start <= day <= (end or last)]
        selections.append((row, dates if end is not None else dates[:1]))

    district_name = calendar["district"]
    if end is None:
        heading = f"{district_name}の次回のごみ収集予定（{year}年度）です。"
    elif start == end:
        heading = f"{district_name}の{format_day(start)}のごみ収集予定です。"
    else:
        heading = f"{district_name}の{format_day(start)}から{format_day(end)}までのごみ収集予定です。"

    lines = []
    for row, dates in selections:
        if not dates:
            value = "この期間の収集予定はありません。" if end else f"{year}年度内で次回の予定はありません。"
        elif len(dates) <= 8:
            value = "、".join(map(format_day, dates))
        else:
            months = groupby(dates, key=lambda day: (day.year, day.month))
            value = "、".join(f"{yr}年{mo}月" + "・".join(f"{day.day}日" for day in group) for (yr, mo), group in months)
        lines.append(f"・{row['label']}　{value}")

    def includes(low, high):
        if end:
            return start <= high and low <= end
        return any(low <= day <= high for _, dates in selections for day in dates)

    if includes(date(year, 12, 29), date(year, 12, 31)):
        lines.append("12月29日〜31日は、通常の収集時間や内容が変わる場合があります。")
    if includes(date(year + 1, 1, 1), date(year + 1, 1, 3)):
        lines.append("1月1日〜3日は収集休止です。")
    if any(row["key"] == "oversized" and dates for row, dates in selections):
        lines.append("粗大ごみは収集月の20日までに芳賀清掃社への予約が必要です。")
    answer = heading + "\n\n" + "\n".join(lines)
    return [{
        **calendar, "text": answer, "calendar_answer": answer,
        "source": "山田町の地区別ごみ収集日程表（1ページ）",
    }]
