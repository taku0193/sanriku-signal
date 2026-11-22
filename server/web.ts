import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AskInput, GuideResult, Pending, Photo, ProgressEvent, QuestionAndAnswer, Source, StreamEvent } from "../frontend/types.js";
import { formatEvidencePrompt } from "../shared/knowledge.js";
import type { SourceRecord } from "../shared/knowledge.js";
import { makeRetriever } from "./embeddings.js";
import type { SearchMode } from "./embeddings.js";
import { isObject, projectRoot, readJsonFile } from "./files.js";
import { OllamaError } from "./ollama.js";
import { KnowledgeSearchError, makeDecider, runTurn } from "./react.js";
import type { Decider } from "./react.js";
import { ANSWER_INSTRUCTIONS, loadRecords, makeSourceReader, NO_EVIDENCE } from "./records.js";

const QUESTION_LIMIT = 400;
const REQUEST_LIMIT = 16_384;
const HISTORY_LIMIT = 2;
const HISTORY_ANSWER_LIMIT = 700;
const MAX_CHECKPOINTS = 128;
const CHECKPOINT_TTL_MS = 15 * 60_000;
const EVENT_TYPE = "application/x-ndjson";
const VIDEO_TYPE = "video/mp4";
const COMMON_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const photos = readJsonFile<(Omit<Photo, "src"> & { file: string })[]>("photo_catalog.json").map(({ file, ...photo }) => ({
  file, photo: { src: "/" + file, ...photo },
}));

const assets = new Map<string, [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/chat", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/yamada-bay.webp", ["yamada-bay.webp", "image/webp"]],
  ["/sanriku-coast.webp", ["sanriku-coast.webp", "image/webp"]],
  ["/sanriku-coast.mp4", ["sanriku-coast.mp4", VIDEO_TYPE]],
]);
for (const { file, photo } of photos) assets.set(photo.src, [file, "image/webp"]);

class InvalidRequest extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function readText(value: unknown, limit = QUESTION_LIMIT): string {
  if (typeof value !== "string") throw new TypeError();
  const text = value.trim();
  if (!text || [...text].length > limit || /[\uD800-\uDFFF]/u.test(text)) throw new TypeError();
  return text;
}

export function readPending(value: unknown): Pending | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || (value.field !== "district" && value.field !== "condition") ||
      (value.field === "condition" && Object.hasOwn(value, "district_hint")) ||
      Object.keys(value).some((key) => !["question", "field", "prompt", "district_hint", "resume_token"].includes(key))) {
    throw new TypeError();
  }
  const resumeToken = value.resume_token;
  if (Object.hasOwn(value, "resume_token") &&
      (typeof resumeToken !== "string" || !/^[a-f0-9-]{36}$/.test(resumeToken))) throw new TypeError();
  return {
    question: readText(value.question),
    field: value.field,
    ...(typeof resumeToken === "string" ? { resume_token: resumeToken } : {}),
    prompt: readText(value.prompt),
    ...(Object.hasOwn(value, "district_hint") ? { district_hint: readText(value.district_hint) } : {}),
  };
}

export function readHistory(value: unknown): QuestionAndAnswer[] {
  if (!Array.isArray(value) || value.length > HISTORY_LIMIT) throw new TypeError();
  return value.map((turn) => {
    if (!isObject(turn) || Object.keys(turn).length !== 2) throw new TypeError();
    return { question: readText(turn.question), answer: readText(turn.answer, HISTORY_ANSWER_LIMIT) };
  });
}

async function readAsk(request: IncomingMessage): Promise<AskInput> {
  if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new InvalidRequest(415, "質問をJSONで送信してください。");
  }
  let payload: unknown;
  try {
    const declared = Number(request.headers["content-length"]);
    if (!Number.isInteger(declared) || declared < 1 || declared > REQUEST_LIMIT) throw new TypeError();
    const body: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      body.push(chunk);
      size += chunk.length;
      if (size > REQUEST_LIMIT) throw new TypeError();
    }
    if (size !== declared) throw new TypeError();
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(body, size)));
    if (!isObject(payload)) throw new TypeError();
  } catch {
    throw new InvalidRequest(400, "質問を読み取れませんでした。");
  }
  let question: string;
  try {
    question = readText(payload.question);
  } catch {
    throw new InvalidRequest(400, `質問は1〜${QUESTION_LIMIT}文字で入力してください。`);
  }
  try {
    return {
      question, pending: readPending(payload.pending),
      history: readHistory(Object.hasOwn(payload, "history") ? payload.history : []),
    };
  } catch {
    throw new InvalidRequest(400, "会話の続きに必要な情報を読み取れませんでした。");
  }
}

function sendContent(response: ServerResponse, status: number, type: string, data: Buffer, headers = {}) {
  response.writeHead(status, { ...COMMON_HEADERS, ...headers, "Content-Type": type, "Content-Length": data.length });
  response.end(response.req.method === "HEAD" ? undefined : data);
}

function sendJson(response: ServerResponse, status: number, data: object) {
  sendContent(response, status, "application/json; charset=utf-8", Buffer.from(JSON.stringify(data)));
}

function sendVideo(request: IncomingMessage, response: ServerResponse, data: Buffer) {
  const headers = { "Accept-Ranges": "bytes" };
  const value = request.method === "GET" && !request.headers["if-range"] ? request.headers.range : undefined;
  const match = /^bytes=([0-9]{0,18})-([0-9]{0,18})$/i.exec(value ?? "");
  if (!match || (!match[1] && !match[2])) {
    sendContent(response, 200, VIDEO_TYPE, data, headers);
    return;
  }
  const size = BigInt(data.length);
  const first = match[1] ? BigInt(match[1]) : size - BigInt(match[2]);
  const last = match[1] && match[2] ? BigInt(match[2]) : size - 1n;
  const start = first < 0n ? 0n : first;
  const end = last >= size ? size - 1n : last;
  if (start > end) {
    sendContent(response, 416, VIDEO_TYPE, Buffer.alloc(0), {
      ...headers, "Content-Range": `bytes */${size}`,
    });
    return;
  }
  sendContent(response, 206, VIDEO_TYPE, data.subarray(Number(start), Number(end) + 1), {
    ...headers, "Content-Range": `bytes ${start}-${end}/${size}`,
  });
}

function publicSource({ category, title, text, source, url, checked, published, calendar_answer }: SourceRecord): Source & { category: string } {
  return {
    category, title, source, checked,
    ...(published !== undefined ? { published } : {}),
    ...(calendar_answer ? { text: "" } : { text, url }),
  };
}

function photosFor(records: SourceRecord[]) {
  const ids = new Set(records.map((record) => record.id));
  return photos.filter(({ photo }) => photo.record_ids.some((id) => ids.has(id))).slice(0, 2).map(({ photo }) => photo);
}

interface ServerOptions {
  model?: string;
  retrieval: SearchMode;
  records?: SourceRecord[];
  decide?: Decider;
}

export function createGuideServer({ model, retrieval, records = loadRecords(), decide = model ? makeDecider(model) : undefined }: ServerOptions) {
  const retrieve = makeRetriever(records, retrieval);
  const readSource = makeSourceReader(records);
  const checkpoints = new Map<string, { pending: Pending; records: SourceRecord[]; expiresAt: number }>();

  async function answer({ question, pending, history }: AskInput, signal: AbortSignal,
                        progress?: (event: ProgressEvent) => void): Promise<GuideResult> {
    let notice = "";
    if (decide) {
      try {
        const token = pending?.resume_token;
        const saved = token ? checkpoints.get(token) : undefined;
        const resume = saved && saved.expiresAt > Date.now() &&
          saved.pending.question === pending?.question && saved.pending.prompt === pending.prompt &&
          saved.pending.field === pending.field &&
          saved.pending.district_hint === pending.district_hint ? saved : undefined;
        const { checkpoint, ...result } = await runTurn(question, decide, retrieve, {
          pending, history, signal, searchMode: retrieval, readSource, checkpoint: resume?.records,
          onProgress: progress && ((stage, detail) => progress({ type: "progress", stage, ...(detail ? { detail } : {}) })),
          onDelta: progress && ((text) => progress({ type: "delta", text })),
        });
        signal.throwIfAborted();
        if (resume && token) checkpoints.delete(token);
        if (result.pending && checkpoint?.length) {
          const now = Date.now();
          for (const [id, entry] of checkpoints) {
            if (entry.expiresAt <= now) checkpoints.delete(id);
          }
          if (checkpoints.size >= MAX_CHECKPOINTS) checkpoints.delete(checkpoints.keys().next().value!);
          result.pending.resume_token = randomUUID();
          checkpoints.set(result.pending.resume_token, { pending: result.pending, records: checkpoint, expiresAt: now + CHECKPOINT_TTL_MS });
        }
        return {
          ...result, mode: "ai", sources: result.sources.map(publicSource), notice,
          photos: result.action === "answer" ? photosFor(result.sources) : [], prompt: "",
        };
      } catch (error) {
        if (!(error instanceof OllamaError || error instanceof KnowledgeSearchError)) throw error;
        notice = error.message + "公式資料の検索結果を表示しています。";
        if (pending) notice += "返答をもう一度送信すると、続きから再試行できます。";
      }
    }
    progress?.({ type: "progress", stage: "searching" });
    const query = pending ? pending.question + "\n" + question : question;
    const { records: hits } = await retrieve(query, signal);
    return {
      mode: "search", action: "search", answer: hits.length ? "" : NO_EVIDENCE, pending, notice,
      sources: hits.map(publicSource), photos: photosFor(hits),
      prompt: hits.length ? formatEvidencePrompt(query, hits, ANSWER_INSTRUCTIONS) : "",
    };
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const path = request.url?.split("?", 1)[0] ?? "";
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/api/settings") {
        sendJson(response, 200, { ai: Boolean(decide), retrieval });
        return;
      }
      const asset = assets.get(path);
      if (asset) {
        const [file, type] = asset;
        try {
          const data = await readFile(new URL("web/" + file, projectRoot));
          if (type === VIDEO_TYPE) sendVideo(request, response, data);
          else sendContent(response, 200, type, data);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } else if (request.method === "POST" && path === "/api/ask") {
      const controller = new AbortController();
      response.once("close", () => { if (!response.writableEnded) controller.abort(); });
      const input = await readAsk(request);
      const accepts = request.headers.accept?.split(",").some((type) => type.split(";", 1)[0].trim() === EVENT_TYPE);
      if (accepts) {
        response.writeHead(200, { ...COMMON_HEADERS, "Content-Type": EVENT_TYPE + "; charset=utf-8", Connection: "close" });
        response.flushHeaders();
        const emit = (event: StreamEvent) => {
          if (!controller.signal.aborted) response.write(JSON.stringify(event) + "\n");
        };
        const result = await answer(input, controller.signal, emit);
        emit({ type: "result", data: result });
        if (!controller.signal.aborted) response.end();
      } else {
        const result = await answer(input, controller.signal);
        if (!controller.signal.aborted) sendJson(response, 200, result);
      }
      return;
    }
    sendJson(response, 404, { error: "ページが見つかりません。" });
  }

  return createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (response.destroyed) return;
      if (error instanceof InvalidRequest) sendJson(response, error.status, { error: error.message });
      else {
        console.error(error);
        if (response.headersSent) response.destroy();
        else sendJson(response, 500, { error: "案内を取得できませんでした。" });
      }
    });
  });
}
