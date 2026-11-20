"""ブラウザーで直接開ける、サーバー不要の検索画面を書き出す。"""

import base64
import json
import re
from pathlib import Path

from yamada_photos import PHOTO_CATALOG, PHOTO_LIMIT, photo_details
from yamada_rag import ANSWER_INSTRUCTIONS, NO_EVIDENCE, SEARCH_LIMIT, load_records


FOLDER = Path(__file__).parent
WEB = FOLDER / "web"


def embedded_photo(relative_path):
    encoded = base64.b64encode((WEB / relative_path).read_bytes()).decode("ascii")
    return f"data:image/webp;base64,{encoded}"


def embedded_data():
    return json.dumps({
        "records": load_records(include_imported=False),
        "limit": SEARCH_LIMIT,
        "instructions": ANSWER_INSTRUCTIONS,
        "noEvidence": NO_EVIDENCE,
        "photos": [photo_details(photo, embedded_photo(photo["file"])) for photo in PHOTO_CATALOG],
        "photoLimit": PHOTO_LIMIT,
        "heroImage": embedded_photo("yamada-bay.webp"),
    }, ensure_ascii=False).replace("<", "\\u003c")


def main():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "style.css").read_text(encoding="utf-8")
    app_script = (WEB / "app.js").read_text(encoding="utf-8")
    app_script = re.sub(r"</script", r"<\\/script", app_script, flags=re.IGNORECASE)
    html = html.replace('<link rel="stylesheet" href="/style.css">', f"<style>\n{css}</style>")
    html = html.replace('    <script src="/app.js" defer></script>\n', "")
    html = html.replace("</body>", (
        f'<script type="application/json" id="standalone-data">{embedded_data()}</script>\n'
        f"<script>\n{app_script}\n</script>\n</body>"
    ))
    output = FOLDER / "yamada-guide.html"
    output.write_text(html, encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
