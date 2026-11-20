"""旧コマンドからTypeScriptのサーバーを起動する。"""

import os
import sys
from pathlib import Path


def main():
    server = Path(__file__).resolve().parent / ".runtime" / "typescript" / "server" / "main.js"
    if not server.is_file():
        sys.exit("サーバーを起動する前に npm ci と npm run build を実行してください。")
    try:
        os.execvp("node", ["node", str(server), *sys.argv[1:]])
    except OSError as error:
        sys.exit(f"Node.jsを起動できませんでした。{error}")


if __name__ == "__main__":
    main()
