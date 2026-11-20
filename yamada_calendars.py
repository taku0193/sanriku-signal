"""山田町の地区別ごみ収集日程表を地区と西暦年度で照合する。"""

import json
import unicodedata
from pathlib import Path


_CALENDARS_PATH = Path(__file__).with_name("collection_calendars.json")


def find_collection_calendar(district: str, fiscal_year: int) -> list[dict]:
    """表記を揃えた地区名と西暦年度が一致する日程表を返す。"""
    if type(district) is not str or type(fiscal_year) is not int:
        return []

    district = unicodedata.normalize("NFKC", district).strip().removesuffix("地区")
    records = json.loads(_CALENDARS_PATH.read_text(encoding="utf-8"))
    return [
        record
        for record in records
        if record.get("district") == district
        and type(record.get("fiscal_year")) is int
        and record["fiscal_year"] == fiscal_year
    ]
