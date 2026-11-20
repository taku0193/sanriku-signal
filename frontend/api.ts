import type { AskInput, GuideResult, ProgressEvent, StreamEvent } from "./types";

const eventType = "application/x-ndjson";
const interrupted = "応答が途中で途切れました。もう一度お試しください。";

async function readEvents(response: Response, onEvent: (event: ProgressEvent) => void): Promise<GuideResult> {
  if (!response.body) throw new Error(interrupted);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === "result") return event.data;
        if (event.type === "progress" || (event.type === "delta" && typeof event.text === "string")) onEvent(event);
      }
      if (done) throw new Error(interrupted);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function requestAnswer(
  input: AskInput,
  signal: AbortSignal,
  onEvent: (event: ProgressEvent) => void,
): Promise<GuideResult> {
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: eventType },
    body: JSON.stringify(input),
    signal,
  });
  if (response.ok && response.headers.get("Content-Type")?.includes(eventType)) {
    return readEvents(response, onEvent);
  }
  if (!response.ok) {
    const data = await response.json() as { error?: string };
    throw new Error(data.error || "質問を送信できませんでした。");
  }
  return response.json() as Promise<GuideResult>;
}

export async function loadMode(): Promise<string> {
  try {
    const response = await fetch("/api/settings");
    if (!response.ok) return "";
    const { ai } = await response.json() as { ai: boolean };
    return ai ? "AI回答モード" : "資料検索モード";
  } catch {
    // 質問を送れない場合は会話欄に表示する。
    return "";
  }
}
