import { normalize } from "../shared/knowledge.js";
import type { SourcePeriod, SourceRecord } from "../shared/knowledge.js";
import { readJsonFile } from "./files.js";

interface PeriodRegistry {
  records: Record<string, SourcePeriod>;
  snapshots: { url: string; published: string; record_id: string }[];
}

export function withSourcePeriods(records: SourceRecord[]) {
  const registry = readJsonFile<PeriodRegistry>("source-periods.json");
  return records.map((record) => {
    const snapshot = record.published && registry.snapshots.find(({ url, published }) =>
      record.url === url && record.published === published);
    const period = registry.records[record.id] ?? (snapshot ? registry.records[snapshot.record_id] : undefined);
    return period ? { ...record, period } : record;
  });
}

function eventTimingQuery(wording: string) {
  const text = normalize(wording);
  return /祭|まつり|催し|花火|いべんと|海水浴|花見/u.test(text) &&
    /何日|何月|何時|いつ|日程|宵宮|前夜祭|開場|開催|開設|出店|遊泳/u.test(text) ? text : undefined;
}

export function requestedEventYear(wording: string, today: string) {
  const text = eventTimingQuery(wording);
  if (!text) return undefined;
  const years = new Set([...text.matchAll(/(?<![0-9])((?:19|20)[0-9]{2})年|令和(元|[0-9]{1,2})年/g)]
    .map(([, year, era]) => year ? Number(year) : 2018 + (era === "元" ? 1 : Number(era))));
  if (years.size) return years.size === 1 ? [...years][0] : undefined;
  const now = Number(today.slice(0, 4));
  if (text.includes("再来年")) return now + 2;
  if (text.includes("来年")) return now + 1;
  if (text.includes("今年")) return now;
}

export function asksForUpcomingEvent(wording: string) {
  const text = eventTimingQuery(wording);
  return Boolean(text && /次の|次に開|次回|今度の|今後の|これから/.test(text) && !/前回|当時|昨年|去年/.test(text));
}

export function documentsEventYear(record: SourceRecord, year: number, exposedLength: number) {
  if (record.period?.through) {
    return record.period.from <= `${year}-12-31` && record.period.through >= `${year}-01-01`;
  }
  const evidence = normalize(record.title + "\n" + record.text.slice(0, exposedLength));
  return evidence.includes(year + "年") ||
    year >= 2019 && (evidence.includes(`令和${year - 2018}年`) || (year === 2019 && evidence.includes("令和元年")));
}

export function documentsUpcomingEvent(record: SourceRecord, today: string, exposedLength: number) {
  if (record.period?.through) return record.period.from >= today;
  const evidence = normalize(record.title + "\n" + record.text.slice(0, exposedLength));
  return Array.from(evidence.matchAll(/(?<![0-9])((?:19|20)[0-9]{2})年\s*([0-9]{1,2})月\s*([0-9]{1,2})日/g))
    .some(([, year, month, day]) => `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` >= today);
}
