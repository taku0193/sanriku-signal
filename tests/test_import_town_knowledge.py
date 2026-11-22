import contextlib
import io
import json
import tempfile
import unittest
from datetime import datetime
from email.message import Message
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.robotparser import RobotFileParser

from import_town_knowledge import ArticleBody, main, ORIGIN, passages, sitemap_urls, TOURISM_ARTICLE_SECTIONS, TOURISM_ORIGIN


def import_fixture(output, body_a, body_b, *, index_error=None):
    def open_article(request, *, timeout):
        url = request.full_url
        if url.endswith("/robots.txt"):
            html = "User-agent: *\nAllow: /"
        elif url.endswith("/docs/"):
            if index_error:
                raise HTTPError(url, index_error, "fixture", {}, None)
            html = """<main>
              <a href="/docs/fixture-a.html?first=1">A</a>
              <a href="/docs/fixture-a.html#duplicate">A</a>
              <a href="/docs/fixture-b.html">B</a>
            </main>"""
        else:
            content = {
                ORIGIN + "/docs/fixture-a.html": body_a,
                ORIGIN + "/docs/fixture-b.html": body_b,
            }[url]
            if isinstance(content, int):
                raise HTTPError(url, content, "fixture", {}, None)
            html = f'<h1 class="pagetitle">試験用のお知らせ</h1><article class="body"><p>{content}</p></article>'
        response = io.BytesIO(html.encode())
        response.headers = Message()
        response.headers["Content-Type"] = "text/html; charset=utf-8"
        return response

    with (patch("sys.argv", ["import_town_knowledge.py", "--output", str(output)]),
          patch("import_town_knowledge.build_opener") as opener,
          patch("import_town_knowledge.time.sleep"),
          patch("import_town_knowledge.datetime") as clock,
          contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO())):
        clock.now.return_value = datetime(2026, 11, 21)
        opener.return_value.open.side_effect = open_article
        main()
    return json.loads(output.read_text(encoding="utf-8"))


class TownImportTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.output = Path(directory.name) / "town_articles.json"

    def test_partial_failure_and_recovery_keep_unique_urls_and_ids(self):
        first = import_fixture(self.output, "海岸観察 初回", "公園案内 初回")
        self.assertEqual(len(first["documents"]), 2)
        self.assertEqual(import_fixture(self.output, "海岸観察 初回", "公園案内 初回"), first)
        legacy = json.loads(self.output.read_text(encoding="utf-8"))
        cached = legacy["documents"][0]
        cached["url"] += "?from=previous#details"
        legacy["documents"].append(cached.copy())
        self.output.write_text(json.dumps(legacy), encoding="utf-8")
        partial = import_fixture(self.output, 503, "公園案内 更新")
        self.assertEqual(partial["documents"][0], first["documents"][0])
        self.assertEqual(partial["documents"][1]["records"][0]["text"], "公園案内 更新")
        self.assertEqual(len(partial["documents"]), 2)
        [skipped] = partial["skipped"]
        self.assertEqual(skipped["url"], ORIGIN + "/docs/fixture-a.html")
        self.assertIn("503", skipped["reason"])
        self.assertTrue(skipped["reused_previous"])
        recovered = import_fixture(self.output, "海岸観察 復旧", "公園案内 更新")
        self.assertEqual(recovered["documents"][0]["records"][0]["text"], "海岸観察 復旧")
        self.assertEqual(recovered["documents"][1], partial["documents"][1])
        self.assertEqual(recovered["skipped"], [])
        ids = [r["id"] for doc in recovered["documents"] for r in doc["records"]]
        self.assertEqual(ids, ["town-fixture-a-1", "town-fixture-b-1"])

    def test_total_failure_leaves_output_byte_for_byte(self):
        import_fixture(self.output, "海岸観察 初回", "公園案内 初回")
        before = self.output.read_bytes()
        for index_error in (None, 503):
            with self.assertRaises(SystemExit) as error:
                import_fixture(self.output, 503, 503, index_error=index_error)
            self.assertEqual(error.exception.code, 1)
            self.assertEqual(self.output.read_bytes(), before)

    def test_permanent_and_uncached_failures_are_recorded(self):
        without_previous = import_fixture(self.output, 503, "公園案内 初回")
        self.assertFalse(without_previous["skipped"][0]["reused_previous"])
        import_fixture(self.output, "海岸観察 初回", "公園案内 初回")
        removed = import_fixture(self.output, 404, "公園案内 更新")
        self.assertEqual(len(removed["documents"]), 1)
        self.assertFalse(removed["skipped"][0]["reused_previous"])

    def test_cached_id_collision_keeps_both_articles(self):
        previous = import_fixture(self.output, "海岸観察 初回", "公園案内 初回")
        previous["documents"][0]["records"][0]["id"] = "town-fixture-b-1"
        self.output.write_text(json.dumps(previous), encoding="utf-8")
        partial = import_fixture(self.output, 503, "公園案内 更新")
        cached, fresh = [doc["records"][0] for doc in partial["documents"]]
        self.assertEqual(cached["text"], "海岸観察 初回")
        self.assertNotEqual(cached["id"], fresh["id"])
        self.assertEqual(fresh["id"], "town-fixture-b-1")

    def test_alternate_town_template_uses_page_title_and_own_date(self):
        body = ArticleBody()
        body.feed("""<title>国保の手続き - 岩手県山田町ホームページ</title>
            <a itemprop="item" href="/kurashi/">くらし</a>
            <aside><time datetime="2026-11-19">お知らせの日付</time></aside>
            <header class="released"><time datetime="2026-10-27">記事の日付</time></header>
            <article class="body"><h2>資格確認書</h2><p>町民課で受付</p>
                <a href="/fs/1/form.PDF">申請書</a>
            </article>""")
        self.assertTrue(body.page_title.startswith("国保の手続き"))
        self.assertEqual(body.date, "2026-10-27")
        self.assertEqual(body.category, "くらし・手続き")
        self.assertEqual(list(passages(body.sections)), [("資格確認書", "町民課で受付\n申請書")])
        self.assertEqual(body.attachment_links, ["/fs/1/form.PDF"])


class TourismImportTests(unittest.TestCase):
    def test_sitemap_discovers_posts_and_dining_areas(self):
        origin = TOURISM_ORIGIN
        pages = {
            origin + "/wp-sitemap.xml": f"""<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
                <sitemap><loc>{origin}/wp-sitemap-posts-plan-1.xml</loc></sitemap>
                <sitemap><loc>{origin}/wp-sitemap-taxonomies-area-1.xml</loc></sitemap>
                <sitemap><loc>{origin}/wp-sitemap-users-1.xml</loc></sitemap>
            </sitemapindex>""",
            origin + "/wp-sitemap-posts-plan-1.xml": f"""<urlset>
                <url><loc>{origin}/plan/plan-123/</loc></url>
                <url><loc>https://example.com/plan/plan-456/</loc></url>
            </urlset>""",
            origin + "/wp-sitemap-taxonomies-area-1.xml": f"""<urlset>
                <url><loc>{origin}/area/toyomane/</loc></url>
                <url><loc>{origin}/contact/</loc></url>
            </urlset>""",
        }
        robots = RobotFileParser()
        robots.parse(["User-agent: *", "Allow: /"])
        self.assertEqual(list(sitemap_urls(pages.__getitem__, robots)), [
            origin + "/plan/plan-123/", origin + "/area/toyomane/",
        ])

    def test_dining_keeps_shop_headings_and_plan_excludes_form_text(self):
        area = ArticleBody(TOURISM_ARTICLE_SECTIONS["area"])
        area.feed("""<div id="gourmet-list">
            <div><h2>食堂A</h2><dl><dt>営業</dt><dd>11:00〜14:00</dd></dl></div>
            <div><h2>食堂B</h2><dl><dt>休</dt><dd>火曜日</dd></dl></div>
            </div><p>フッター</p>""")
        self.assertEqual(list(passages(area.sections)), [
            ("食堂A", "営業\n11:00〜14:00"), ("食堂B", "休\n火曜日"),
        ])
        plan = ArticleBody(TOURISM_ARTICLE_SECTIONS["plan"])
        plan.feed("""<div id="plan-detail-block">
            <h2>申込み</h2><p>希望日の7日前まで</p>
            <form><div>入力欄</div></form><p>電話で相談</p>
            </div><p>ほかの企画</p>""")
        self.assertEqual(list(passages(plan.sections)), [("申込み", "希望日の7日前まで\n電話で相談")])

    def test_photo_uses_the_site_caption_when_alt_text_is_empty(self):
        body = ArticleBody(TOURISM_ARTICLE_SECTIONS["photorepo"])
        body.feed("""<section id="photorepo_box"><h2>2018年6月18日公開</h2>
            <h5>織笠</h5><img alt="">
            </section><h5>関連資料</h5><img alt="別の写真">""")
        self.assertEqual(list(passages(body.sections)), [("織笠", "写真の説明 織笠")])
