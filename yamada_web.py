"""山田町RAGのブラウザー画面をローカルで起動する。"""

import argparse
import json
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from yamada_photos import PHOTO_CATALOG, photos_for
from yamada_rag import DEFAULT_OLLAMA_MODEL, NO_EVIDENCE, format_prompt, load_records, search
from yamada_react import make_react_decider, run_turn


ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/chat": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/yamada-bay.webp": ("yamada-bay.webp", "image/webp"),
}
ASSETS.update({"/" + photo["file"]: (photo["file"], "image/webp") for photo in PHOTO_CATALOG})
WEB_DIR = Path(__file__).with_name("web")
QUESTION_LIMIT = 400
REQUEST_LIMIT = 16_384
HISTORY_LIMIT = 2
HISTORY_ANSWER_LIMIT = 700
EVENT_TYPE = "application/x-ndjson"


def read_text(value, limit=QUESTION_LIMIT):
    if not isinstance(value, str):
        raise ValueError
    value = value.strip()
    if not 0 < len(value) <= limit:
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


def read_history(value):
    if not isinstance(value, list) or len(value) > HISTORY_LIMIT:
        raise ValueError
    history = []
    for turn in value:
        if not isinstance(turn, dict) or turn.keys() != {"question", "answer"}:
            raise ValueError
        history.append({
            "question": read_text(turn["question"]),
            "answer": read_text(turn["answer"], HISTORY_ANSWER_LIMIT),
        })
    return history


def public_source(record):
    fields = ("category", "title", "text", "source", "checked", "published")
    source = {key: record[key] for key in fields if key in record}
    if "calendar_answer" in record:
        source["text"] = ""
    elif "url" in record:
        source["url"] = record["url"]
    return source


class GuideHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, records, decide, retriever=None, retrieval_mode="keyword", **kwargs):
        self.records = records
        self.decide = decide
        self.retriever = retriever
        self.retrieval_mode = retrieval_mode
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
            return self.send_json(200, {"ai": self.decide is not None, "retrieval": self.retrieval_mode})

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
            history = read_history(payload.get("history", []))
        except ValueError:
            return self.send_json(400, {"error": "会話の続きに必要な情報を読み取れませんでした。"})

        accepted_types = self.headers.get("Accept", "").split(",")
        if any(kind.split(";", 1)[0].strip() == EVENT_TYPE for kind in accepted_types):
            return self.stream_answer(question, pending, history)
        self.send_json(200, self.answer_question(question, pending, history))

    def stream_answer(self, question, pending, history):
        def send_event(event):
            line = json.dumps(event, ensure_ascii=False) + "\n"
            self.wfile.write(line.encode("utf-8"))
            self.wfile.flush()

        def progress(stage, *, detail=None):
            event = {"type": "progress", "stage": stage}
            if detail:
                event["detail"] = detail
            send_event(event)

        def delta(text):
            send_event({"type": "delta", "text": text})

        self.send_response(200)
        self.send_header("Content-Type", f"{EVENT_TYPE}; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.close_connection = True
        try:
            self.end_headers()
            result = self.answer_question(question, pending, history, on_progress=progress, on_delta=delta)
            send_event({"type": "result", "data": result})
        except (BrokenPipeError, ConnectionResetError):
            return

    def answer_question(self, question, pending, history, *, on_progress=None, on_delta=None):
        mode, action, prompt, notice = "search", "search", "", ""
        next_pending = None
        if self.decide is not None:
            try:
                result = run_turn(
                    question, self.records, self.decide, pending=pending, history=history,
                    retriever=self.retriever, on_progress=on_progress, on_delta=on_delta,
                )
                mode = "ai"
                action, answer, hits, next_pending = result.action, result.answer, result.sources, result.pending
            except RuntimeError:
                notice = "AIに接続できませんでした。公式資料の検索結果を表示しています。"
                if pending is not None:
                    next_pending = pending
                    notice += "返答をもう一度送信すると、続きから再試行できます。"

        if mode == "search":
            if on_progress:
                on_progress("searching")
            search_query = f"{pending['question']}\n{question}" if pending else question
            hits = search(self.records, search_query) if self.retriever is None else self.retriever(search_query).records
            answer = "" if hits else NO_EVIDENCE
            prompt = format_prompt(search_query, hits) if hits else ""

        return {
            "mode": mode,
            "action": action,
            "pending": next_pending,
            "answer": answer,
            "notice": notice,
            "sources": [public_source(record) for record in hits],
            "photos": photos_for(hits) if action in ("answer", "search") else [],
            "prompt": prompt,
        }


def main():
    parser = argparse.ArgumentParser(description="山田町の観光・くらし案内をローカルで表示します。")
    parser.add_argument("--port", type=int, default=8765, help="ポート番号（既定は8765）")
    parser.add_argument("--retrieval", choices=("keyword", "hybrid"), default="keyword", help="一般資料の検索方式です。")
    parser.add_argument(
        "--model", nargs="?", const=DEFAULT_OLLAMA_MODEL,
        help=f"Ollamaで回答します。モデル名を省略すると {DEFAULT_OLLAMA_MODEL} を使います。",
    )
    args = parser.parse_args()
    records = load_records()
    retriever = None
    if args.retrieval == "hybrid":
        from yamada_embeddings import make_retriever

        retriever = make_retriever(records, mode=args.retrieval)
    decide = make_react_decider(args.model) if args.model else None
    handler = partial(GuideHandler, records=records, decide=decide, retriever=retriever, retrieval_mode=args.retrieval)

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
