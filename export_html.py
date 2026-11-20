"""ブラウザーで直接開ける、サーバー不要の検索画面を書き出す。"""

import base64
import json
from pathlib import Path

from yamada_rag import ANSWER_INSTRUCTIONS, NO_EVIDENCE, SEARCH_LIMIT, load_records


FOLDER = Path(__file__).parent
WEB = FOLDER / "web"


def embedded_data():
    return json.dumps({
        "records": load_records(include_town=False),
        "limit": SEARCH_LIMIT,
        "instructions": ANSWER_INSTRUCTIONS,
        "noEvidence": NO_EVIDENCE,
    }, ensure_ascii=False).replace("<", "\\u003c")


def main():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "style.css").read_text(encoding="utf-8")
    search_script = (WEB / "standalone.js").read_text(encoding="utf-8")
    app_script = (WEB / "app.js").read_text(encoding="utf-8")
    photo = base64.b64encode((WEB / "yamada-bay.webp").read_bytes()).decode("ascii")

    html = html.replace('<link rel="stylesheet" href="/style.css">', f"<style>\n{css}</style>")
    html = html.replace('src="/yamada-bay.webp"', f'src="data:image/webp;base64,{photo}"')
    html = html.replace('    <script src="/app.js" defer></script>\n', "")
    html = html.replace("</body>", (
        f'<script type="application/json" id="standalone-data">{embedded_data()}</script>\n'
        f"<script>\n{search_script}\n{app_script}</script>\n</body>"
    ))
    output = FOLDER / "yamada-guide.html"
    output.write_text(html, encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
