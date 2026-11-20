"""山田町と山田町観光協会の公開記事を取り込み、ローカル資料を更新する。"""

import argparse
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from html.parser import HTMLParser
from http.client import HTTPException
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.robotparser import RobotFileParser
from zoneinfo import ZoneInfo


ORIGIN = "https://www.town.yamada.iwate.jp"
TOURISM_ORIGIN = "https://www.yamada-kankou.jp"
OUTPUT = Path(__file__).with_name("town_articles.json")
TOURISM_OUTPUT = OUTPUT.with_name("tourism_articles.json")
USER_AGENT = "YamadaGuide/1.0 (public-document indexing)"
ARTICLE = re.compile(r"/docs/([A-Za-z0-9_-]+)\.html")
INDEX = re.compile(r"/docs/(?:index\.p[0-9]+\.html)?")
TOURISM_INDEXES = ("/spots/", "/facilities/", "/accommodations/")
TOURISM_ARTICLE = re.compile(r"/(?:spots|facilities|accommodations)/[a-zA-Z0-9_-]+/")
TOURISM_SECTIONS = {
    "/specialty/": ("section", {"specialty1", "specialty2", "specialty3"}),
    "/shiokaze-trail/": ("section", {"item_block"}),
    "/wonderful-taiken/": ("div", {"chatch-block"}),
}
CATEGORIES = {
    "kurashi": "くらし・手続き", "kanko": "観光", "jigyosha": "事業者向け", "chousei": "町政情報",
}
HEADINGS = {"h2", "h3", "h4", "h5", "h6"}
BREAKS = {"br", "p", "li", "dt", "dd", "div", "tr", "caption"}


def source_url(url, origin):
    parts = urlsplit(urljoin(origin, url))
    if parts.scheme != "https" or parts.netloc != urlsplit(origin).netloc:
        return None
    return origin + parts.path


class LocalRedirect(HTTPRedirectHandler):
    def __init__(self, origin):
        self.origin = origin

    def redirect_request(self, request, fp, code, msg, headers, new_url):
        if source_url(new_url, self.origin) is None:
            raise HTTPError(request.full_url, code, "取得対象サイト外への転送", headers, fp)
        return super().redirect_request(request, fp, code, msg, headers, new_url)


class ArticleIndex(HTMLParser):
    def __init__(self, origin=ORIGIN):
        super().__init__()
        self.origin = origin
        self.inside_main = False
        self.articles = []
        self.next_page = None

    def handle_starttag(self, tag, pairs):
        if tag == "main":
            self.inside_main = True
        if not self.inside_main or tag != "a":
            return
        attrs = dict(pairs)
        url = source_url(attrs.get("href") or "", self.origin)
        if url is None:
            return
        path = urlsplit(url).path
        if self.origin == TOURISM_ORIGIN:
            if TOURISM_ARTICLE.fullmatch(path):
                self.articles.append(url)
            return
        match = ARTICLE.fullmatch(path)
        if match and match[1] != "index":
            self.articles.append(url)
        if "next" in (attrs.get("rel") or "").split() and INDEX.fullmatch(path):
            self.next_page = url

    def handle_endtag(self, tag):
        if tag == "main":
            self.inside_main = False


class ArticleBody(HTMLParser):
    def __init__(self, tourism_section=None):
        super().__init__()
        self.tourism_section = tourism_section
        self.body_tag = tourism_section[0] if tourism_section else "article"
        self.category = "観光" if tourism_section else "町公式サイト"
        self.title = ""
        self.read_title = False
        self.date = ""
        self.body_depth = 0
        self.ignore = None
        self.read_heading = None
        self.buffer = []
        self.heading = ""
        self.sections = []

    def flush(self):
        content = " ".join("".join(self.buffer).split())
        if content:
            if not self.sections or self.sections[-1][0] != self.heading:
                self.sections.append((self.heading, []))
            self.sections[-1][1].append(content)
        self.buffer.clear()

    def handle_starttag(self, tag, pairs):
        attrs = dict(pairs)
        classes = (attrs.get("class") or "").split()
        if tag == "meta" and self.tourism_section and attrs.get("property") == "og:title":
            self.title = (attrs.get("content") or "").partition("|")[0].strip()
        if tag == "body" and not self.tourism_section:
            for key, category in CATEGORIES.items():
                if f"body--{key}" in classes:
                    self.category = category
        if tag == "h1" and "pagetitle" in classes and not self.tourism_section:
            self.read_title = True
        if tag == "time" and not self.date:
            self.date = attrs.get("datetime") or ""
        if tag == self.body_tag:
            is_body = attrs.get("id") in self.tourism_section[1] if self.tourism_section else "body" in classes
            if is_body or self.body_depth:
                self.body_depth += 1
        if not self.body_depth or self.ignore:
            return
        if tag in {"script", "style", "iframe"}:
            self.ignore = tag
        elif tag in HEADINGS:
            self.flush()
            self.read_heading = tag
        elif tag in BREAKS and not self.read_heading:
            self.flush()

    def handle_endtag(self, tag):
        if tag == "h1":
            self.read_title = False
        if self.ignore:
            if tag == self.ignore:
                self.ignore = None
            return
        if not self.body_depth:
            return
        if tag == self.read_heading:
            self.heading = " ".join("".join(self.buffer).split())
            self.buffer.clear()
            self.read_heading = None
        elif tag == self.body_tag:
            self.flush()
            self.body_depth -= 1
        elif tag in BREAKS and not self.read_heading:
            self.flush()
        elif tag in {"td", "th"}:
            self.buffer.append(" | ")

    def handle_data(self, data):
        if self.read_title:
            self.title += data
        if self.body_depth and not self.ignore:
            self.buffer.append(data)


def passages(sections):
    for heading, paragraphs in sections:
        chunk = ""
        for paragraph in paragraphs:
            for start in range(0, len(paragraph), 650):
                part = paragraph[start:start + 650]
                if chunk and len(chunk) + len(part) + 1 > 720:
                    yield heading, chunk
                    chunk = ""
                chunk = f"{chunk}\n{part}" if chunk else part
        if chunk:
            yield heading, chunk


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, help="確認用に取得する記事数を指定します。")
    parser.add_argument("--source", choices=("town", "tourism"), default="town", help="取り込み元です。")
    parser.add_argument("--output", type=Path, help="取り込みデータの保存先です。")
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit は1以上を指定してください。")

    tourism = args.source == "tourism"
    origin = TOURISM_ORIGIN if tourism else ORIGIN
    output = args.output or (TOURISM_OUTPUT if tourism else OUTPUT)
    opener = build_opener(LocalRedirect(origin))
    lock = Lock()
    next_request = 0.0

    def fetch(url):
        nonlocal next_request
        with lock:
            time.sleep(max(0, next_request - time.monotonic()))
            next_request = time.monotonic() + 0.25
        request = Request(url, headers={"User-Agent": USER_AGENT})
        with opener.open(request, timeout=12) as response:
            data = response.read(2_000_001)
            if len(data) > 2_000_000:
                raise ValueError("HTMLが2 MBを超えています。")
            return data.decode(response.headers.get_content_charset() or "utf-8", errors="replace")

    robots = RobotFileParser()
    try:
        robots.parse(fetch(origin + "/robots.txt").splitlines())
        paths = TOURISM_INDEXES if tourism else ("/docs/",)
        pages = [origin + path for path in paths]
        visited = set()
        urls = dict.fromkeys(origin + path for path in TOURISM_SECTIONS) if tourism else {}
        for page in pages:
            if page in visited or not robots.can_fetch(USER_AGENT, page):
                continue
            visited.add(page)
            index = ArticleIndex(origin)
            index.feed(fetch(page))
            urls.update(dict.fromkeys(index.articles))
            if index.next_page:
                pages.append(index.next_page)
    except (OSError, HTTPException, ValueError) as error:
        parser.exit(1, f"記事一覧を取得できませんでした。 {error}\n")
    candidates = [url for url in urls if robots.can_fetch(USER_AGENT, url)][:args.limit]
    if not candidates:
        parser.exit(1, "記事一覧から記事が見つかりませんでした。\n")
    print(f"記事一覧 {len(visited)}ページ・{len(candidates)}記事を確認", flush=True)
    checked = datetime.now(ZoneInfo("Asia/Tokyo")).date().isoformat()

    def read_article(url):
        try:
            path = urlsplit(url).path
            section = TOURISM_SECTIONS.get(path, ("section", {"list-detail-block"})) if tourism else None
            body = ArticleBody(section)
            body.feed(fetch(url))
            title = " ".join(body.title.split())
            slug = path.strip("/").replace("/", "-") if tourism else ARTICLE.fullmatch(path)[1]
            records = [
                {"id": f"{args.source}-{slug}-{index}", "title": title, "heading": heading, "text": text}
                for index, (heading, text) in enumerate(passages(body.sections), 1)
            ]
            if title and records:
                return {
                    "category": body.category, "source": f"山田町観光協会「{title}」" if tourism else title,
                    "url": url, "checked": checked,
                    "published": body.date, "records": records,
                }, None
            return None, "見出しまたは本文を検出できませんでした。"
        except (OSError, HTTPException, ValueError) as error:
            return None, str(error)

    documents, skipped = [], []
    with ThreadPoolExecutor(max_workers=4) as workers:
        for number, (url, (document, error)) in enumerate(zip(candidates, workers.map(read_article, candidates)), 1):
            if document is not None:
                documents.append(document)
            else:
                skipped.append({"url": url, "reason": error})
            if number % 100 == 0:
                print(f"{number}/{len(candidates)}記事を確認", flush=True)
    if not documents:
        parser.exit(1, "本文を取得できる記事がありませんでした。\n")
    with NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=output.parent, prefix=output.stem + ".", suffix=".tmp", delete=False,
    ) as handle:
        temporary = Path(handle.name)
        try:
            json.dump({"documents": documents, "skipped": skipped}, handle, ensure_ascii=False)
            handle.close()
            temporary.replace(output)
        finally:
            temporary.unlink(missing_ok=True)
    print(f"{len(documents)}記事・{sum(len(doc['records']) for doc in documents)}件の本文を保存。取得対象外・取得失敗 {len(skipped)}記事。")


if __name__ == "__main__":
    main()
