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

from import_town_knowledge import main, ORIGIN


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
