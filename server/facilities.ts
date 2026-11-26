import { mentionsSubject, normalize, SEARCH_LIMIT } from "../shared/knowledge.js";
import type { SourceRecord } from "../shared/knowledge.js";
import type { SourceReader } from "./records.js";

export const EXCERPT_LIMIT = 600;
export const LIVE_STATUS = /混雑|行列|並ん|待ち時間|空席|空き|予約が取れ|運休|臨時|遅れ|開設/;
const sentences = new Intl.Segmenter("ja", { granularity: "sentence" });

export function comparisonStation(wording: string) {
  const references = new Set([...wording.matchAll(/([\p{Script=Han}\p{Script=Katakana}]+駅)\s*(?:(?:が|の)?\s*最寄り|から\s*(?:徒歩|歩いて))/gu)]
    .map(([, station]) => station));
  if (references.size === 1) return [...references][0];
}

export function stationAccessSentence(record: SourceRecord, station: string) {
  const name = normalize(station);
  return [...sentences.segment(record.text.slice(0, EXCERPT_LIMIT))].map(({ segment }) => segment.trim()).find((line) => {
    const text = normalize(line).replace(/\s+/g, "");
    return text.includes(name + "から徒歩") || text.includes(name + "から歩いて") ||
      text.includes(name + "に隣接") || text.includes(name + "が最寄り") || text.includes("最寄り駅は" + name);
  });
}

export function regularClosingQuestion(wording: string) {
  const text = normalize(wording);
  if (!/通常|普段/.test(text) || !/どちら|どっち|比較|比べ/.test(text) || LIVE_STATUS.test(text) ||
      /今日|明日|当日|特定|祝日|平日|[月火水木金土日]曜|曜日|連休|元日|休館日|最終入館|れすとらん|道路休憩施設|料金|いくら|駐車|行き方|予約|締切|分別|出し方|収集日|以外|を除|ではなく|[0-9]+月/.test(text)) return;
  if (/遅く閉|遅くまで開/.test(text)) return "later";
  if (/早く閉|先に閉/.test(text)) return "earlier";
}

function closingHours(record: SourceRecord) {
  const label = /^(.+)の(?:開館時間|営業時間)(?:・休館日)?$/.exec(record.title)?.[1];
  const range = /通常の(?:開館時間|営業時間)は\s*(\d{1,2}):(\d{2})\s*[〜～~-]\s*(\d{1,2}):(\d{2})/.exec(
    record.text.slice(0, EXCERPT_LIMIT).normalize("NFKC"));
  if (!label || !range) return;
  const [openHour, openMinute, hour, minute] = range.slice(1).map(Number);
  const closing = hour * 60 + minute;
  if (openHour > 23 || openMinute > 59 || hour > 23 || minute > 59 || closing <= openHour * 60 + openMinute) return;
  return { label, time: range[3].padStart(2, "0") + ":" + range[4], closing };
}

export function closingComparison(wording: string, evidence: readonly SourceRecord[], readSource?: SourceReader) {
  const station = comparisonStation(wording);
  const accessByUrl = station ? evidence.filter((record) => stationAccessSentence(record, station)) : [];
  const byFacility = new Map<string, {
    record: SourceRecord; hours: NonNullable<ReturnType<typeof closingHours>>; anchor: SourceRecord; access?: SourceRecord; named: boolean;
  }>();
  for (const anchor of evidence) {
    for (const record of [anchor, ...(readSource?.(anchor) ?? [])]) {
      const hours = closingHours(record);
      if (!hours || byFacility.has(hours.label)) continue;
      const named = [hours.label, ...(record.keywords ?? [])].some((name) => name.length >= 3 && mentionsSubject(wording, name));
      const access = accessByUrl.find((item) => item.url === record.url && mentionsSubject(item.title, hours.label));
      if (named || access) byFacility.set(hours.label, { record, hours, anchor, access, named });
    }
  }
  const facilities = [...byFacility.values()];
  if (facilities.length !== 2 || (station && facilities.filter(({ access, named }) => access && !named).length !== 1)) return;
  return facilities;
}

export function includeClosingEvidence(wording: string, hits: SourceRecord[], readSource: SourceReader) {
  if (!comparisonStation(wording) || !regularClosingQuestion(wording)) return hits;
  const compared = closingComparison(wording, hits, readSource);
  if (!compared) return hits;
  const related = new Map<string, SourceRecord>();
  for (const { record, access } of compared) {
    if (access) related.set(access.id, access);
    related.set(record.id, record);
  }
  const present = new Set(hits.map(({ id }) => id));
  const missing = [...related.values()].filter(({ id }) => !present.has(id));
  if (!missing.length || related.size > SEARCH_LIMIT) return hits;
  return [...hits.filter(({ id }) => related.has(id)), ...missing, ...hits.filter(({ id }) => !related.has(id))].slice(0, SEARCH_LIMIT);
}
