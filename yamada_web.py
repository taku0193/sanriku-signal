"""山田町RAGのブラウザー画面をローカルで起動する。"""

import argparse
import json
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from yamada_rag import (
    DEFAULT_OLLAMA_MODEL, NO_EVIDENCE, answer_question, format_prompt, load_records, make_ollama_decider, search,
)


ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/yamada-bay.webp": ("yamada-bay.webp", "image/webp"),
}
WEB_DIR = Path(__file__).with_name("web")
QUESTION_LIMIT = 400


class GuideHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, records, decide, **kwargs):
        self.records = records
        self.decide = decide
        super().__init__(*args, **kwargs)

    def send_content(self, status, content_type, data):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_content(status, "application/json; charset=utf-8", data)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/settings":
            return self.send_json(200, {"ai": self.decide is not None})

        asset = ASSETS.get(path)
        if asset is None:
            return self.send_error(404)

        filename, content_type = asset
        try:
            data = (WEB_DIR / filename).read_bytes()
        except FileNotFoundError:
            return self.send_error(404)
        self.send_content(200, content_type, data)

    def do_POST(self):
        if urlsplit(self.path).path != "/api/ask":
            return self.send_error(404)
        if self.headers.get_content_type() != "application/json":
            return self.send_json(415, {"error": "質問をJSONで送信してください。"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8192:
                raise ValueError
            payload = json.loads(self.rfile.read(length))
        except ValueError:
            return self.send_json(400, {"error": "質問を読み取れませんでした。"})

        question = payload.get("question") if isinstance(payload, dict) else None
        if not isinstance(question, str) or not 0 < len(question.strip()) <= QUESTION_LIMIT:
            return self.send_json(400, {"error": f"質問は1〜{QUESTION_LIMIT}文字で入力してください。"})
        question = question.strip()

        mode, prompt, notice = "search", "", ""
        if self.decide is not None:
            try:
                answer, hits = answer_question(question, self.records, self.decide)
                mode = "ai"
            except RuntimeError:
                notice = "AIに接続できませんでした。公式資料の検索結果を表示しています。"

        if mode == "search":
            hits = search(self.records, question)
            answer = "" if hits else NO_EVIDENCE
            prompt = format_prompt(question, hits) if hits else ""

        self.send_json(200, {
            "mode": mode,
            "answer": answer,
            "notice": notice,
            "sources": [
                {key: record[key] for key in ("category", "title", "text", "source", "url", "checked")}
                for record in hits
            ],
            "prompt": prompt,
        })


def main():
    parser = argparse.ArgumentParser(description="山田町の観光・くらし案内をローカルで表示します。")
    parser.add_argument("--port", type=int, default=8765, help="ポート番号（既定は8765）")
    parser.add_argument(
        "--model", nargs="?", const=DEFAULT_OLLAMA_MODEL,
        help=f"Ollamaで回答します。モデル名を省略すると {DEFAULT_OLLAMA_MODEL} を使います。",
    )
    args = parser.parse_args()
    records = load_records()
    decide = make_ollama_decider(args.model, catalog=records) if args.model else None
    handler = partial(GuideHandler, records=records, decide=decide)

    try:
        with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
            print(f"山田町の観光・くらし案内　http://127.0.0.1:{server.server_port}", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    except OSError as error:
        parser.exit(1, f"ローカルサーバーを起動できませんでした（{error}）。\n")


if __name__ == "__main__":
    main()
