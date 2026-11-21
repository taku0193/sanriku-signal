import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { endianness } from "node:os";
import { hasTopic, normalize, SEARCH_LIMIT } from "../shared/knowledge.js";
import type { SourceRecord } from "../shared/knowledge.js";
import { isObject, projectRoot } from "./files.js";
import { ollamaRequest, ollamaSignal } from "./ollama.js";
import { lexicalText, makeKeywordSearch } from "./records.js";

const DEFAULT_MODEL = "embeddinggemma-2:270m";
const DOCUMENT_FORMAT = "title: {title} | text: {text}";
const QUERY_FORMAT = "task: search result | query: {query}";
const LITTLE_ENDIAN = endianness() === "LE";

export type SearchMode = "keyword" | "hybrid";
export type SearchStrategy = SearchMode | "semantic";
export interface RetrievalResult {
  records: SourceRecord[];
  mode: SearchStrategy | "keyword_fallback";
}
export type Retriever = (query: string, signal?: AbortSignal, strategy?: SearchStrategy) => Promise<RetrievalResult>;

type VectorIndex = { dimensions: number; digest: string; entries: [SourceRecord, Float32Array][] };

function modelTag(model: string): string {
  return model.split("/").at(-1)!.includes(":") ? model : model + ":latest";
}

function norm(vector: Float32Array) {
  let squared = 0;
  for (const value of vector) squared += value * value;
  return Math.sqrt(squared);
}

function decode(encoded: unknown, dimensions: number): Float32Array | undefined {
  if (typeof encoded !== "string" || encoded.length !== 4 * Math.ceil(dimensions * 4 / 3)) return undefined;
  const raw = Buffer.from(encoded, "base64");
  if (raw.length !== dimensions * 4 || raw.toString("base64") !== encoded) return undefined;
  const vector = LITTLE_ENDIAN && raw.byteOffset % 4 === 0
    ? new Float32Array(raw.buffer, raw.byteOffset, dimensions)
    : Float32Array.from({ length: dimensions }, (_, index) => raw.readFloatLE(index * 4));
  return Math.abs(norm(vector) - 1) <= 1e-5 ? vector : undefined;
}

function documentHashes(records: SourceRecord[]) {
  return records.map((record) => {
    const input = `title: ${record.title || "none"} | text: ${record.text}`;
    return { record, hash: createHash("sha256").update(input).digest("hex") };
  });
}

async function loadIndex(path: URL, documents: ReturnType<typeof documentHashes>, model: string): Promise<VectorIndex | undefined> {
  const cache: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isObject(cache) || cache.version !== 1 || cache.model !== model ||
      typeof cache.model_digest !== "string" || !cache.model_digest ||
      typeof cache.dimensions !== "number" || !Number.isInteger(cache.dimensions) || cache.dimensions < 1 ||
      (model === DEFAULT_MODEL && cache.dimensions !== 768) || cache.vector_format !== "float32-le-base64" ||
      !isObject(cache.input_format) || cache.input_format.document !== DOCUMENT_FORMAT ||
      cache.input_format.query !== QUERY_FORMAT || !isObject(cache.records)) return undefined;
  const entries: VectorIndex["entries"] = [];
  for (const { record, hash } of documents) {
    const entry = cache.records[record.id];
    if (!isObject(entry) || entry.input_sha256 !== hash) return undefined;
    const vector = decode(entry.vector, cache.dimensions);
    if (!vector) return undefined;
    entries.push([record, vector]);
  }
  return { dimensions: cache.dimensions, digest: cache.model_digest, entries };
}

async function currentDigest(url: string, model: string, signal?: AbortSignal) {
  const data: unknown = await (await ollamaRequest(new URL("tags", url).href, ollamaSignal(60_000, signal))).json();
  if (!isObject(data) || !Array.isArray(data.models)) throw new Error("モデル一覧を読めません。");
  for (const modelInfo of data.models) {
    if (!isObject(modelInfo)) continue;
    const name = modelInfo.name || modelInfo.model;
    if (typeof name === "string" && modelTag(name) === model && typeof modelInfo.digest === "string" && modelInfo.digest) {
      return modelInfo.digest;
    }
  }
  throw new Error("埋め込みモデルの識別情報がありません。");
}

async function embed(url: string, model: string, query: string, dimensions: number, signal?: AbortSignal) {
  const input = ["task: search result | query: " + query];
  const data: unknown = await (await ollamaRequest(url, ollamaSignal(60_000, signal), { model, input, truncate: true })).json();
  if (!isObject(data) || typeof data.model !== "string" || modelTag(data.model) !== modelTag(model) ||
      !Array.isArray(data.embeddings) || data.embeddings.length !== 1) throw new Error("埋め込みの応答が無効です。");
  const values: unknown = data.embeddings[0];
  if (!Array.isArray(values) || values.length !== dimensions || !values.every(Number.isFinite)) {
    throw new Error("埋め込みベクトルの次元または値が無効です。");
  }
  const length = Math.hypot(...values);
  if (!Number.isFinite(length) || length === 0) throw new Error("埋め込みベクトルの長さが無効です。");
  return Float32Array.from(values, (value: number) => value / length);
}

function semanticSearch(index: VectorIndex, query: Float32Array) {
  const pages = new Map<string, { score: number; record: SourceRecord }>();
  for (const [record, vector] of index.entries) {
    let score = 0;
    for (let i = 0; i < vector.length; i++) score += vector[i] * query[i];
    const existing = pages.get(record.url);
    if (!existing || score > existing.score) pages.set(record.url, { score, record });
  }
  return [...pages.values()].sort((a, b) => b.score - a.score).slice(0, 12).map(({ record }) => record);
}

function hybrid(keyword: SourceRecord[], semantic: SourceRecord[], rawQuery: string) {
  const ranks = new Map<string, { score: number; record: SourceRecord }>();
  for (const list of [keyword, semantic]) {
    list.forEach((record, i) => {
      const score = (ranks.get(record.id)?.score ?? 0) + 1 / (60 + i + 1);
      ranks.set(record.id, { score, record });
    });
  }
  const query = normalize(rawQuery);
  const lexicalQuery = lexicalText(query);
  const result = keyword.filter((record) => {
    if (record.keywords?.some((word) => query.includes(normalize(word)))) return hasTopic(record, query);
    return [record.title.split(" / ", 1)[0], record.heading ?? ""].map(lexicalText)
      .some((term) => term.length >= 4 && lexicalQuery.includes(term));
  });
  if (!result.length) result.push(...semantic.slice(0, SEARCH_LIMIT - 1));
  const selected = new Set(result.map((record) => record.id));
  const urls = new Set(result.map((record) => record.url));
  const shared = new Set(keyword.filter((record) => semantic.some((other) => other.id === record.id)).map((record) => record.id));
  const remaining: SourceRecord[] = [];
  for (const { record } of [...ranks.values()].sort((a, b) => b.score - a.score)) {
    if (selected.has(record.id)) continue;
    if (urls.has(record.url) && !shared.has(record.id)) remaining.push(record);
    else {
      result.push(record);
      urls.add(record.url);
    }
  }
  return [...result, ...remaining].slice(0, SEARCH_LIMIT);
}

export function makeRetriever(records: SourceRecord[], mode: SearchMode, path = new URL("embeddings-cache.json", projectRoot)): Retriever {
  const keyword = makeKeywordSearch(records);
  if (mode === "keyword") return async (query) => ({ records: keyword(query), mode });

  const documents = documentHashes(records);
  const model = process.env.YAMADA_EMBED_MODEL || DEFAULT_MODEL;
  const tag = modelTag(model);
  const url = process.env.YAMADA_EMBED_URL || "http://127.0.0.1:11434/api/embed";
  let current: { fingerprint: string; index: Promise<VectorIndex | undefined> } | undefined;

  async function getIndex() {
    const info = await stat(path, { bigint: true });
    const fingerprint = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
    if (current?.fingerprint !== fingerprint) {
      current = { fingerprint, index: loadIndex(path, documents, tag).catch(() => undefined) };
    }
    return current.index;
  }

  return async (query, signal, strategy = mode) => {
    if (strategy === "keyword") return { records: keyword(query), mode: "keyword" };
    try {
      const index = await getIndex();
      if (!index || await currentDigest(url, tag, signal) !== index.digest) throw new Error("埋め込み索引が一致しません。");
      const vector = await embed(url, model, query, index.dimensions, signal);
      if (await currentDigest(url, tag, signal) !== index.digest) throw new Error("検索中に埋め込みモデルが変わりました。");
      const semantic = semanticSearch(index, vector);
      const hits = strategy === "semantic" ? semantic.slice(0, SEARCH_LIMIT) : hybrid(keyword(query), semantic, query);
      return { records: hits, mode: strategy };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return { records: keyword(query), mode: "keyword_fallback" };
    }
  };
}
