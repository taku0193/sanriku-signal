import type { Source } from "../frontend/types.js";

export interface SourceRecord extends Source {
  id: string;
  category: string;
  url: string;
  text: string;
  checked: string;
  keywords?: string[];
  topics?: string[];
  names?: string[];
  heading?: string;
  calendar_answer?: string;
}

export const SEARCH_LIMIT = 3;

export function foldKana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60)
  );
}

export function normalize(text: string): string {
  return foldKana(text.normalize("NFKC").toLowerCase());
}

export function hasTopic(record: SourceRecord, query: string): boolean {
  return (record.keywords ?? []).some((word) => query.includes(normalize(word))) &&
    (record.topics ?? []).some((word) => query.includes(normalize(word)));
}

function nameText(text: string): string {
  return normalize(text).replace(/[\s\p{P}]/gu, "");
}

export function quotedSubject(question: string) {
  const mentions = [...question.matchAll(/[「『]([^「『」』]+)[」』](?!\s*(?:以外|を除|ではなく|じゃなく))/gu)];
  return mentions.length === 1 && nameText(mentions[0][1]).length >= 3 ? mentions[0][1] : undefined;
}

export function mentionsSubject(text: string, subject: string) {
  return nameText(text).includes(nameText(subject));
}

function nameSubject(compact: string): string {
  return compact.replace(/(?:(?:って|とは|について)(?:何|なに|教えて|おしえて)?(?:ですか|ください)?|は(?:何|なに)(?:ですか)?)$/u, "");
}

function nameQueries(text: string): string[] {
  const compact = nameText(text);
  return [compact, nameSubject(compact), ...Array.from(text.matchAll(/[「『]([^」』]+)[」』]/gu), ([, name]) => nameText(name))];
}

export function makeNameResolver(records: readonly SourceRecord[]) {
  const titles = new Map<string, string | undefined>();
  for (const { names } of records) {
    if (!names?.length) continue;
    const [title] = names;
    for (const alias of names) {
      const key = nameText(alias);
      if (!key) continue;
      if (!titles.has(key)) titles.set(key, title);
      else if (titles.get(key) !== title) titles.set(key, undefined);
    }
  }
  return (question: string) => {
    const compact = nameText(question);
    return titles.get(titles.has(compact) ? compact : nameSubject(compact));
  };
}

function matchedNameLength(record: SourceRecord, queries: string[]): number {
  let length = 0;
  for (const alias of record.names ?? []) {
    const name = nameText(alias);
    if (name && queries.some((query) => query === name || (name.length >= 4 && query.includes(name)))) {
      length = Math.max(length, name.length);
    }
  }
  return length;
}

export function hasNamedMatch(record: SourceRecord, ...wording: string[]): boolean {
  return matchedNameLength(record, wording.flatMap(nameQueries)) > 0;
}

export function rankCurated(records: readonly SourceRecord[], query: string, original = query) {
  const queries = [query, original].flatMap(nameQueries);
  const matches = [];
  for (const record of records) {
    const keywords = record.keywords?.filter((term) => query.includes(normalize(term))) ?? [];
    const nameLength = matchedNameLength(record, queries);
    if (!keywords.length && !nameLength) continue;
    const topicScore = (record.topics ?? []).reduce((score, topic) =>
      score + (query.includes(normalize(topic)) ? topic.length : 0), 0);
    matches.push({ record, topicScore, nameLength, keywordLength: Math.max(0, ...keywords.map((term) => term.length)) });
  }
  matches.sort((a, b) => b.topicScore - a.topicScore || b.nameLength - a.nameLength || b.keywordLength - a.keywordLength);

  const urls = new Set<string>();
  const prioritized: SourceRecord[] = [];
  const remaining: SourceRecord[] = [];
  for (const { record, topicScore } of matches) {
    if (!topicScore && urls.has(record.url)) remaining.push(record);
    else prioritized.push(record);
    urls.add(record.url);
  }
  return { records: [...prioritized, ...remaining], strongMatch: Boolean(matches[0]?.topicScore) };
}

export function formatEvidencePrompt(question: string, records: SourceRecord[], instructions: string): string {
  const evidence = records.map((record) => {
    const published = record.published ? "掲載日 " + record.published + " / " : "";
    return `[${record.id}] ${record.category} / ${record.title}\n${record.text}\n出典　${record.source}（${published}確認日 ${record.checked}）\n${record.url}`;
  }).join("\n\n");
  return `${instructions}\n回答の根拠にした出典のURLを記載してください。\n\n質問\n${question}\n\n検索で見つかった資料\n${evidence || "該当なし"}`;
}
