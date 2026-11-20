import { parseArgs } from "node:util";
import { DEFAULT_MODEL } from "./ollama.js";
import { createGuideServer } from "./web.js";

const usage = "npm start -- [--model [モデル名]] [--retrieval keyword|hybrid] [--port ポート番号]";

try {
  const input = process.argv.slice(2);
  const args = input.map((arg, index) =>
    arg === "--model" && (!input[index + 1] || input[index + 1].startsWith("-")) ? "--model=" + DEFAULT_MODEL : arg
  );
  const { values } = parseArgs({
    args, options: {
      model: { type: "string" }, retrieval: { type: "string", default: "keyword" },
      port: { type: "string", default: "8765" }, help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) console.log(usage);
  else {
    const port = Number(values.port);
    const retrieval = values.retrieval;
    if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("ポート番号を確認してください。");
    }
    if (retrieval !== "keyword" && retrieval !== "hybrid") throw new Error("検索方式を確認してください。");
    const server = createGuideServer({ model: values.model, retrieval });
    server.on("error", (error) => {
      console.error("ローカルサーバーを起動できませんでした。", error.message);
      process.exitCode = 1;
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address !== "string") {
        console.log(`山田町の観光・くらし案内　http://127.0.0.1:${address.port}`);
      }
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error, "\n" + usage);
  process.exitCode = 1;
}
