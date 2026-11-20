"""山田町RAGのブラウザー画面をローカルで起動する。"""

import argparse
import json
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from yamada_rag import DEFAULT_OLLAMA_MODEL, NO_EVIDENCE, format_prompt, load_records, search
from yamada_react import make_react_decider, run_turn


ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/yamada-bay.webp": ("yamada-bay.webp", "image/webp"),
}
WEB_DIR = Path(__file__).with_name("web")
QUESTION_LIMIT = 400
REQUEST_LIMIT = 16_384


def read_text(value):
    if not isinstance(value, str):
        raise ValueError
    value = value.strip()
    if not 0 < len(value) <= QUESTION_LIMIT:
        raise ValueError
    value.encode("utf-8")
    return value


def read_pending(value):
    if value is None:
        return None
    required = {"question", "field", "prompt"}
    if not isinstance(value, dict) or not required <= value.keys() <= required | {"district_hint"}:
        raise ValueError
    if value["field"] != "district":
        raise ValueError
    pending = {
        "question": read_text(value["question"]),
        "field": "district",
        "prompt": read_text(value["prompt"]),
    }
    if "district_hint" in value:
        pending["district_hint"] = read_text(value["district_hint"])
    return pending


def public_source(record):
    fields = ("category", "title", "text", "source", "checked", "published")
    source = {key: record[key] for key in fields if key in record}
    if "calendar_answer" in record:
        source["text"] = ""
    elif "url" in record:
        source["url"] = record["url"]
    return source


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
            if not 0 < length <= REQUEST_LIMIT:
                raise ValueError
            payload = json.loads(self.rfile.read(length))
        except (RecursionError, ValueError):
            return self.send_json(400, {"error": "質問を読み取れませんでした。"})

        if not isinstance(payload, dict):
            return self.send_json(400, {"error": "質問を読み取れませんでした。"})
        try:
            question = read_text(payload.get("question"))
        except ValueError:
            return self.send_json(400, {"error": f"質問は1〜{QUESTION_LIMIT}文字で入力してください。"})
        try:
            pending = read_pending(payload.get("pending"))
        except ValueError:
            return self.send_json(400, {"error": "聞き返しの情報を読み取れませんでした。"})

        mode, action, prompt, notice = "search", "search", "", ""
        next_pending = None
        if self.decide is not None:
            try:
                result = run_turn(question, self.records, self.decide, pending=pending)
                mode = "ai"
                action, answer, hits, next_pending = result.action, result.answer, result.sources, result.pending
            except RuntimeError:
                notice = "AIに接続できませんでした。公式資料の検索結果を表示しています。"
                if pending is not None:
                    next_pending = pending
                    notice += "返答をもう一度送信すると、続きから再試行できます。"

        if mode == "search":
            search_query = f"{pending['question']}\n{question}" if pending else question
            hits = search(self.records, search_query)
            answer = "" if hits else NO_EVIDENCE
            prompt = format_prompt(search_query, hits) if hits else ""

        self.send_json(200, {
            "mode": mode,
            "action": action,
            "pending": next_pending,
            "answer": answer,
            "notice": notice,
            "sources": [public_source(record) for record in hits],
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
    decide = make_react_decider(args.model) if args.model else None
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
