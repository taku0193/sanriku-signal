import { isObject } from "./files.js";

export const DEFAULT_MODEL = "gemma4:12b";

export class OllamaError extends Error {}

export async function ollamaRequest(url: string, timeout: number, signal?: AbortSignal, payload?: object) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new OllamaError("Ollamaの接続先が無効です。");
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetch(endpoint, {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    ...(payload ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new OllamaError(`OllamaがHTTP ${response.status}を返しました。`);
  }
  return response;
}

async function* readLines(response: Response) {
  if (!response.body) throw new Error("期待したOllamaのストリームがありません。");
  const reader = response.body.pipeThrough(new TextDecoderStream("utf-8", { fatal: true })).getReader();
  let pending = "";
  try {
    for (;;) {
      const fragment = await reader.read();
      if (fragment.done) break;
      pending += fragment.value;
      let end = pending.indexOf("\n");
      while (end >= 0) {
        yield pending.slice(0, end);
        pending = pending.slice(end + 1);
        end = pending.indexOf("\n");
      }
    }
    if (pending) yield pending;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readStream(response: Response, onContent: (text: string) => void) {
  let content = "";
  for await (const line of readLines(response)) {
    if (!line.trim()) continue;
    const event: unknown = JSON.parse(line);
    if (!isObject(event) || event.error) throw new Error("生成が中断されました。");
    if (event.message !== undefined && !isObject(event.message)) throw new Error("Ollamaのメッセージが無効です。");
    if (isObject(event.message) && typeof event.message.content === "string" && event.message.content) {
      content += event.message.content;
      onContent(content);
    }
    if (event.done === true) return content;
  }
  throw new Error("Ollamaのストリームが途中で終了しました。");
}

interface ChatOptions {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  format: object;
  signal?: AbortSignal;
  onContent?: (text: string) => void;
}

export async function chatJson({ model, messages, format, signal, onContent }: ChatOptions) {
  const payload = {
    model, messages, format, stream: Boolean(onContent),
    ...(model === DEFAULT_MODEL ? { think: false } : {}),
    options: { temperature: 0, ...(model === DEFAULT_MODEL ? { num_ctx: 6144, num_predict: 448 } : {}) },
  };
  try {
    const url = process.env.YAMADA_CHAT_URL || "http://127.0.0.1:11434/api/chat";
    const response = await ollamaRequest(url, 120_000, signal, payload);
    const content = onContent ? await readStream(response, onContent) : (await response.json()).message?.content;
    if (typeof content !== "string") throw new Error("Ollamaの応答に本文がありません。");
    const decision: unknown = JSON.parse(content);
    if (!isObject(decision) || [decision.answer, decision.other_answer].some((value) =>
      typeof value === "string" && /[\uD800-\uDFFF]/u.test(value))) throw new Error("Ollamaの行動が無効です。");
    return decision;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof OllamaError) throw error;
    throw new OllamaError("Ollamaの応答を取得できませんでした。", { cause: error });
  }
}
