import { readdirSync } from "node:fs";
import { normalize, rankCurated, SEARCH_LIMIT } from "../shared/knowledge.js";
import type { SourceRecord } from "../shared/knowledge.js";
import { projectRoot, readJsonFile, readTextFile } from "./files.js";

export const NO_EVIDENCE = "登録した資料からは、質問に答えるための根拠を確認できませんでした。";
export const ANSWER_INSTRUCTIONS = readTextFile("prompts/answer.md").trimEnd();

type SourceMetadata = Pick<SourceRecord, "category" | "source" | "url" | "checked" | "published">;
type Document = SourceMetadata & { records: Omit<SourceRecord, keyof SourceMetadata>[] };
type Import = { documents: Document[] };

function loadMarkdown(file: string): SourceRecord {
  try {
    const lines = readTextFile("knowledge/" + file).split(/\r?\n/);
    const end = lines.indexOf("---", 1);
    if (lines[0] !== "---" || end < 0) throw new Error();
    const metadata = new Map<string, string>();
    for (const line of lines.slice(1, end)) {
      const colon = line.indexOf(":");
      const key = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (colon <= 0 || !value || metadata.has(key)) throw new Error();
      metadata.set(key, value);
    }
    const fields = ["title", "category", "source", "url", "checked", "keywords", "topics"] as const;
    if (metadata.size !== fields.length || fields.some((field) => !metadata.has(field))) throw new Error();
    const [title, category, source, url, checked, keywordList, topicList] = fields.map((field) => metadata.get(field)!);
    const text = lines.slice(end + 1).join("\n").trim();
    const keywords = keywordList.split(",").map((term) => term.trim());
    const topics = topicList.split(",").map((term) => term.trim());
    const location = new URL(url);
    const date = new Date(checked + "T00:00:00Z");
    if (location.protocol !== "https:" || !location.hostname || date.toISOString().slice(0, 10) !== checked ||
        !text || !keywords.every(Boolean) || !topics.every(Boolean)) throw new Error();
    return { id: "md-" + file.slice(0, -3), title, category, source, url, checked, text, keywords, topics };
  } catch (error) {
    throw new Error(file + " の資料情報または本文の形式を確認してください。", { cause: error });
  }
}

function unpack({ records, ...metadata }: Document, imported = false): SourceRecord[] {
  return records.map((record) => ({
    ...metadata,
    ...record,
    title: imported && record.heading ? record.title + " / " + record.heading : record.title,
  }));
}

export function loadRecords(): SourceRecord[] {
  const records = readJsonFile<Document[]>("sources.json").flatMap((document) => unpack(document));
  const markdown = readdirSync(new URL("knowledge/", projectRoot)).filter((file) => file.endsWith(".md")).sort();
  records.push(...markdown.map(loadMarkdown));
  for (const file of ["town_articles.json", "tourism_articles.json"]) {
    try {
      const data = readJsonFile<Import>(file);
      for (const document of data.documents) records.push(...unpack(document, true));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error("資料IDが重複しています。");
  return records;
}

export function lexicalText(text: string): string {
  return (normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}

function termsFor(query: string) {
  const terms = new Set<string>();
  for (const word of lexicalText(query).split(" ")) {
    const symbols = [...word];
    for (const size of [2, 3]) {
      for (let i = 0; i + size <= symbols.length; i++) terms.add(symbols.slice(i, i + size).join(""));
    }
  }
  return [...terms];
}

export function makeKeywordSearch(records: SourceRecord[]) {
  const curated = records.filter((record) => record.keywords?.length);
  const imported = records.filter((record) => record.published !== undefined).map((record) => ({
    record,
    title: lexicalText(record.title),
    body: lexicalText(record.text),
    section: lexicalText(record.heading ?? ""),
  }));

  function searchImported(query: string) {
    const terms = termsFor(query);
    if (!terms.length) return [];
    const length = new Map(terms.map((term) => [term, [...term].length]));
    const frequencies = new Map<string, number>();
    const matches = imported.flatMap(({ record, title, body, section }) => {
      const titleHits = terms.filter((term) => title.includes(term));
      const bodyHits = terms.filter((term) => body.includes(term));
      const hits = new Set([...titleHits, ...bodyHits]);
      for (const term of hits) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      if (![...hits].some((term) => length.get(term) === 3) && !(titleHits.length && (hits.size >= 2 || terms.length === 1))) {
        return [];
      }
      return [{ record, titleHits, bodyHits, sectionHits: titleHits.filter((term) => section.includes(term)) }];
    });
    const weights = new Map([...frequencies].map(([term, count]) =>
      [term, length.get(term)! * Math.log1p(imported.length / count)]));
    const weight = (terms: string[]) => terms.reduce((sum, term) => sum + weights.get(term)!, 0);
    const pages = new Map<string, { score: number; sectionScore: number; record: SourceRecord }>();
    for (const { record, titleHits, bodyHits, sectionHits } of matches) {
      const score = 3 * weight(titleHits) + weight(bodyHits);
      const sectionScore = score + 6 * weight(sectionHits);
      const page = pages.get(record.url);
      if (!page) pages.set(record.url, { score, sectionScore, record });
      else {
        page.score = Math.max(page.score, score);
        if (sectionScore > page.sectionScore) Object.assign(page, { sectionScore, record });
      }
    }
    return [...pages.values()].sort((a, b) => b.score - a.score ||
      (b.record.published ?? "").localeCompare(a.record.published ?? ""))
      .slice(0, SEARCH_LIMIT).map(({ record }) => record);
  }

  return (rawQuery: string): SourceRecord[] => {
    const query = normalize(rawQuery);
    const { records: direct, strongMatch } = rankCurated(curated, query);
    if (strongMatch) return direct.slice(0, SEARCH_LIMIT);
    const fromArticles = searchImported(query);
    const urls = new Set(fromArticles.map((record) => record.url));
    return [...fromArticles, ...direct.filter((record) => !urls.has(record.url))].slice(0, SEARCH_LIMIT);
  };
}
