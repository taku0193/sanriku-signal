"""山田町の公開文化財・地域資源一覧から、名称・読み・分類を収録する。"""

import json
import re
import time
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from import_town_knowledge import USER_AGENT


INDEX = "https://cuckoo.si.soft.iwate-pu.ac.jp/~yamada_prj/index.php"
OUTPUT = Path(__file__).with_name("regional_resources.json")
PAGE_SIZE = 24
CATEGORIES = {"designated": "指定文化財", "local_resource": "地域資源"}


def page_url(**parameters):
    return INDEX + "?" + urlencode(parameters)


class ResourceCards(HTMLParser):
    def __init__(self):
        super().__init__()
        self.items = []
        self.card = None
        self.field = None
        self.read_title = False
        self.buffer = []

    def handle_starttag(self, tag, pairs):
        attrs = dict(pairs)
        classes = (attrs.get("class") or "").split()
        if tag == "div" and "resource-card-wrap" in classes:
            self.card = {"id": attrs["data-rid"], "reading": attrs.get("data-name-kana", ""),
                         "category": CATEGORIES[attrs["data-cat"]]}
            self.read_title = False
        if self.card is None:
            return
        if tag == "a" and "bunkazai-card" in classes:
            target = urlsplit(urljoin(INDEX, attrs["href"]))
            query = parse_qs(target.query)
            if target._replace(query="", fragment="").geturl() != INDEX or query != {
                "page": ["bunkazai_detail"], "id": [self.card["id"]],
            }:
                raise ValueError("一覧のIDと詳細ページが一致しません。")
            self.card["url"] = page_url(page="bunkazai_detail", id=self.card["id"])
        elif tag == "div" and self.read_title:
            self.field = ("title", "div")
            self.read_title = False
        elif tag == "span" and "badge-warm" in classes and "font-size:.62rem" in attrs.get("style", ""):
            self.field = ("kind", "span")

    def handle_comment(self, data):
        if self.card is not None and data.strip() == "名称":
            self.read_title = True

    def handle_data(self, data):
        if self.field:
            self.buffer.append(data)

    def handle_endtag(self, tag):
        if self.field and tag == self.field[1]:
            self.card[self.field[0]] = " ".join("".join(self.buffer).split())
            self.buffer.clear()
            self.field = None
        if tag == "a" and self.card and "url" in self.card:
            if not self.card.get("title") or not self.card["id"].isdecimal():
                raise ValueError("文化財の公開名称またはIDを確認できません。")
            self.items.append(self.card)
            self.card = None


def make_documents(items, checked):
    documents = []
    for item in sorted(items, key=lambda row: int(row["id"])):
        title, reading, category = (item[field] for field in ("title", "reading", "category"))
        name = f"{title}（{reading}）" if reading and reading != title else title
        kind = f"種別は「{item['kind']}」です。" if item.get("kind") else ""
        documents.append({
            "category": "文化・地域史", "source": "山田町 文化財・地域資源 管理システム",
            "url": item["url"], "checked": checked,
            "records": [{"id": f"regional-{item['id']}", "title": title,
                         "names": list(dict.fromkeys(filter(None, (title, reading)))),
                         "text": f"{name}は、山田町の公開一覧に掲載されている{category}です。{kind}"}],
        })
    return documents


def main():
    items = []
    ids = set()
    page = 1
    expected = None
    while True:
        parser = ResourceCards()
        url = page_url(page="bunkazai_list", per=PAGE_SIZE, p=page)
        with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=15) as response:
            html = response.read(2_000_001).decode("utf-8")
        count = re.search(r"<strong>(\d+)</strong>\s*件中", html)
        if not count or (expected is not None and int(count[1]) != expected):
            raise ValueError("公開一覧の件数を確認できません。")
        expected = int(count[1])
        parser.feed(html)
        if len(parser.items) != min(PAGE_SIZE, expected - len(items)):
            raise ValueError(f"一覧の{page}ページ目の件数が一致しません。")
        page_ids = {item["id"] for item in parser.items}
        if ids & page_ids or len(page_ids) != len(parser.items):
            raise ValueError(f"一覧の{page}ページ目で資料IDが重複しています。")
        if not items and not parser.items:
            raise ValueError("公開一覧に文化財・地域資源が見つかりません。")
        ids.update(page_ids)
        items.extend(parser.items)
        if len(items) == expected:
            break
        page += 1
        time.sleep(0.25)

    checked = datetime.now(ZoneInfo("Asia/Tokyo")).date().isoformat()
    documents = make_documents(items, checked)
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=OUTPUT.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            json.dump(documents, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.close()
            temporary.replace(OUTPUT)
        finally:
            temporary.unlink(missing_ok=True)
    print(f"公開一覧{page}ページから{len(documents)}件を収録しました。")


if __name__ == "__main__":
    main()
