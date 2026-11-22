import type { Source } from "../frontend/types.js";

export interface SourceRecord extends Source {
  id: string;
  category: string;
  url: string;
  text: string;
  checked: string;
  keywords?: string[];
  topics?: string[];
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

export function rankCurated(records: readonly SourceRecord[], query: string) {
  const matches = [];
  for (const record of records) {
    const keywords = record.keywords?.filter((term) => query.includes(normalize(term))) ?? [];
    if (!keywords.length) continue;
    const topicScore = (record.topics ?? []).reduce((score, topic) =>
      score + (query.includes(normalize(topic)) ? topic.length : 0), 0);
    matches.push({ record, topicScore, keywordLength: Math.max(...keywords.map((term) => term.length)) });
  }
  matches.sort((a, b) => b.topicScore - a.topicScore || b.keywordLength - a.keywordLength);

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
