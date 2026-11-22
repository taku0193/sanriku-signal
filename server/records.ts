import { readdirSync } from "node:fs";
import { hasNamedMatch, hasTopic, mentionsSubject, normalize, quotedSubject, rankCurated, SEARCH_LIMIT } from "../shared/knowledge.js";
import type { SourceRecord } from "../shared/knowledge.js";
import { normalizeQuery } from "../shared/query.js";
import { projectRoot, readJsonFile, readTextFile } from "./files.js";
import { withSourcePeriods } from "./periods.js";

export const NO_EVIDENCE = "登録した資料からは、質問に答えるための根拠を確認できませんでした。";
export const ANSWER_INSTRUCTIONS = readTextFile("prompts/answer.md").trimEnd();

export function summarizeSearchFallback(question: string, records: SourceRecord[]): string {
  if (!records.length) return NO_EVIDENCE;
  const unconfirmed = "見つかった資料から、質問への答えを確認できませんでした。";
  const wording = normalize(normalizeQuery(question));
  if (/今日|きょう|明日|あした|今朝|今夜|今の|現在|ただいま|直近|次の|次回|今年|来年|来月|今週|当日|遅れ|混雑|運休中|以外|ではなく|じゃなく|比較|どちら|\d+年|\d+月\d+日/.test(wording)) {
    return unconfirmed;
  }

  const subject = quotedSubject(question);
  const matches = records.filter((record) => !record.published && !record.period?.through &&
    record.text.length <= 500 && hasTopic(record, wording) &&
    (!subject || [record.title, ...(record.names ?? [])].some((name) => mentionsSubject(name, subject))));
  if (matches.length !== 1) return unconfirmed;

  const [record] = matches;
  return `「${record.title}」の記載\n\n${record.text}`;
}

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
    if (metadata.size !== fields.length + Number(metadata.has("names")) || fields.some((field) => !metadata.has(field))) {
      throw new Error();
    }
    const [title, category, source, url, checked, keywordList, topicList] = fields.map((field) => metadata.get(field)!);
    const text = lines.slice(end + 1).join("\n").trim();
    const keywords = keywordList.split(",").map((term) => term.trim());
    const topics = topicList.split(",").map((term) => term.trim());
    const names = metadata.get("names")?.split(",").map((term) => term.trim());
    const location = new URL(url);
    const date = new Date(checked + "T00:00:00Z");
    if (location.protocol !== "https:" || !location.hostname || date.toISOString().slice(0, 10) !== checked ||
        !text || !keywords.every(Boolean) || !topics.every(Boolean) || names?.some((term) => !term)) throw new Error();
    return { id: "md-" + file.slice(0, -3), title, category, source, url, checked, text, keywords, topics,
      ...(names ? { names } : {}) };
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
  records.push(...readJsonFile<Document[]>("regional_resources.json").flatMap((document) => unpack(document)));
  for (const file of ["town_articles.json", "tourism_articles.json"]) {
    try {
      const data = readJsonFile<Import>(file);
      for (const document of data.documents) records.push(...unpack(document, true));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error("資料IDが重複しています。");
  return withSourcePeriods(records);
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

export function makeSourceReader(records: SourceRecord[]) {
  const sections = new Map<string, SourceRecord[]>();
  for (const record of records) {
    const entries = sections.get(record.url);
    if (entries) entries.push(record);
    else sections.set(record.url, [record]);
  }

  return (record: SourceRecord) => sections.get(record.url) ?? [];
}

export type SourceReader = ReturnType<typeof makeSourceReader>;

export function rankSections(sections: readonly SourceRecord[], query: string, limit: number) {
  const terms = termsFor(normalizeQuery(query));
  return sections.map((section) => {
    const heading = lexicalText(section.heading ?? section.title);
    const body = lexicalText(section.text);
    const score = terms.reduce((sum, term) =>
      sum + 3 * Number(heading.includes(term)) + Number(body.includes(term)), 0);
    return { section, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score).slice(0, limit).map(({ section }) => section);
}

export function makeKeywordSearch(records: SourceRecord[]) {
  const curated = records.filter((record) => record.keywords?.length || record.names?.length);
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

  return (rawQuery: string, original = rawQuery): SourceRecord[] => {
    const query = normalize(rawQuery);
    const { records: direct, strongMatch } = rankCurated(curated, query, original);
    if (strongMatch) return direct.slice(0, SEARCH_LIMIT);
    const named = direct.filter((record) => hasNamedMatch(record, query, original));
    const namedUrls = new Set(named.map((record) => record.url));
    const fromArticles = searchImported(query).filter(({ url }) => !namedUrls.has(url));
    const urls = new Set([...named, ...fromArticles].map((record) => record.url));
    return [...named, ...fromArticles, ...direct.filter((record) => !urls.has(record.url))].slice(0, SEARCH_LIMIT);
  };
}
