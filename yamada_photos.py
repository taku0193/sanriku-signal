"""回答の根拠に対応する現地写真を、リポジトリの目録から選ぶ。"""

import json
from pathlib import Path


PHOTO_CATALOG = json.loads(Path(__file__).with_name("photo_catalog.json").read_text(encoding="utf-8"))
PHOTO_LIMIT = 2


def photo_details(photo, src):
    return {"src": src, **{key: value for key, value in photo.items() if key != "file"}}


def photos_for(records):
    source_ids = {record["id"] for record in records}
    matches = [photo for photo in PHOTO_CATALOG if not source_ids.isdisjoint(photo["record_ids"])]
    return [photo_details(photo, "/" + photo["file"]) for photo in matches[:PHOTO_LIMIT]]
