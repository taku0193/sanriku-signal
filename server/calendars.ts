import type { SourceRecord } from "../shared/knowledge.js";
import { readJsonFile } from "./files.js";

export const COLLECTION_TYPES = {
  burnable: "燃やせるごみ、可燃ごみ",
  non_burnable_glass_batteries: "燃やせないごみ、空びん、乾電池",
  pet_bottles_cans: "ペットボトル、缶",
  plastic: "プラスチック、プラ",
  paper_and_hazardous_items: "紙、新聞、紙パック、ダンボール、蛍光管、水銀体温計、水銀血圧計",
  oversized: "粗大ごみ",
} as const;

export const COLLECTION_PERIODS = ["next", "today", "tomorrow", "period", "fiscal_year"] as const;
export type WasteType = keyof typeof COLLECTION_TYPES;

interface Calendar extends SourceRecord {
  district: string;
  fiscal_year: number;
  aliases?: string[];
}

interface CollectionRow {
  key: WasteType;
  label: string;
  dates: string[];
}

export class AmbiguousDistrict extends Error {
  constructor(readonly district: string, readonly choices: string[]) {
    super(district);
  }
}

const tokyoDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
});

export function todayInTokyo(date = new Date()): string {
  return tokyoDate.format(date);
}

export function fiscalYear(date: string): number {
  return Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) < 4 ? 1 : 0);
}

function shiftDay(date: string, days: number) {
  const value = new Date(date + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function checkedDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000") ||
      shiftDay(value, 0) !== value) throw new RangeError("日付の指定が無効です。");
  return value;
}

function monthStart(year: number, month: number) {
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-01";
}

function formatDay(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = "日月火水木金土"[new Date(date + "T00:00:00Z").getUTCDay()];
  return `${year}年${month}月${day}日（${weekday}）`;
}

function normalizeDistrict(text: string): string {
  return text.normalize("NFKC").replace(/([一二三四五六七八九])丁目/g, (_, digit: string) =>
    "〇一二三四五六七八九".indexOf(digit) + "丁目"
  );
}

function resolveDistrict(district: string, year: number, wording: string[]) {
  const byName = new Map<string, Calendar[]>();
  for (const row of readJsonFile<Calendar[]>("collection_calendars.json")) {
    if (row.fiscal_year !== year) continue;
    for (const name of [row.district, ...(row.aliases ?? [])]) {
      const key = normalizeDistrict(name);
      const matches = byName.get(key) ?? [];
      matches.push(row);
      byName.set(key, matches);
    }
  }
  let label = normalizeDistrict(district).trim().replace(/地区$/, "");
  let matches = byName.get(label) ?? [];
  if (wording.length) {
    const keys = [...byName.keys()].sort((a, b) => b.length - a.length);
    const mentioned: string[] = [];
    for (const phrase of wording) {
      for (const key of keys) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(escaped + "(?![0-9区])").test(normalizeDistrict(phrase)) &&
            !mentioned.some((longer) => longer.includes(key))) mentioned.push(key);
      }
      if (mentioned.length) break;
    }
    const candidates = mentioned.filter((key) => byName.get(key)!.some((row) => matches.includes(row)));
    if (!candidates.length) return undefined;
    // 共通の呼び名から地区を一つに絞るには、利用者の返答が必要。
    label = candidates.includes(label) ? label : candidates[0];
    matches = byName.get(label)!;
  }
  if (matches.length > 1) throw new AmbiguousDistrict(label, matches.map((row) => row.district));
  return matches[0];
}

function explicitBounds(wording: string[]): [string, string] | undefined {
  for (const phrase of wording) {
    const text = phrase.normalize("NFKC");
    const dates = [...text.matchAll(/(?<![0-9])([0-9]{4})年\s*([0-9]{1,2})月(?:\s*の?\s*([0-9]{1,2})日)?/g)];
    const first = dates[0];
    if (!first) continue;
    if (dates.length > 1 || /^\s*(?:から|まで|以降|以後|より|[〜~～])/.test(text.slice(first.index! + first[0].length))) {
      throw new RangeError("指定期間の開始日と終了日が必要です。");
    }
    const [year, month] = [Number(first[1]), Number(first[2])];
    const start = checkedDate(monthStart(year, month));
    if (first[3]) {
      const date = checkedDate(start.slice(0, 8) + first[3].padStart(2, "0"));
      return [date, date];
    }
    const following = month === 12 ? monthStart(year + 1, 1) : monthStart(year, month + 1);
    return [start, shiftDay(following, -1)];
  }
}

export function collectionBounds(decision: Record<string, unknown>, today: string, wording: string[]) {
  const hasDates = Object.hasOwn(decision, "start_date") || Object.hasOwn(decision, "end_date");
  const period = Object.hasOwn(decision, "period") ? decision.period : hasDates ? "period" : "next";
  if (!COLLECTION_PERIODS.some((allowed) => allowed === period) || (hasDates && period !== "period")) {
    throw new RangeError("収集日の期間が無効です。");
  }
  const stated = !hasDates && !Object.hasOwn(decision, "period") ? explicitBounds(wording) : undefined;
  let start = today;
  let end: string | undefined;
  if (stated) [start, end] = stated;
  else if (period === "next") start = shiftDay(today, 1);
  else if (period === "today" || period === "tomorrow") {
    start = period === "today" ? today : shiftDay(today, 1);
    end = start;
  } else if (period === "period") {
    start = checkedDate(decision.start_date);
    end = Object.hasOwn(decision, "end_date") ? checkedDate(decision.end_date) : start;
    if (start > end) throw new RangeError("収集日の期間が逆です。");
  }
  const year = Object.hasOwn(decision, "fiscal_year") ? decision.fiscal_year : fiscalYear(start);
  if (typeof year !== "number" || !Number.isInteger(year) || year < 1 || year >= 9999) {
    throw new RangeError("収集日程表の年度が無効です。");
  }
  if (period === "fiscal_year") {
    start = monthStart(year, 4);
    end = monthStart(year + 1, 3).slice(0, 8) + "31";
  }
  return { year, start, end };
}

function formatDates(dates: string[]) {
  if (dates.length <= 8) return dates.map(formatDay).join("、");
  const months = new Map<string, string[]>();
  for (const date of dates) {
    const [year, month, day] = date.split("-").map(Number);
    const key = `${year}年${month}月`;
    const days = months.get(key) ?? [];
    days.push(`${day}日`);
    months.set(key, days);
  }
  return [...months].map(([month, days]) => month + days.join("・")).join("、");
}

export function findCollectionDays(district: string, bounds: ReturnType<typeof collectionBounds>, types: WasteType[],
                                   wording: string[]): SourceRecord[] {
  const { year, start, end } = bounds;
  const calendar = resolveDistrict(district, year, wording);
  if (!calendar) return [];
  const schedule = readJsonFile<Record<string, { rows: CollectionRow[] }>>("collection_calendar_days.json")[calendar.id];
  const first = monthStart(year, 4);
  const last = monthStart(year + 1, 3).slice(0, 8) + "31";
  if (!schedule || start > last || (end && (start < first || end > last))) return [];
  const requiredTypes = types.length ? types : Object.keys(COLLECTION_TYPES);
  if (!requiredTypes.every((key) => schedule.rows.some((row) => row.key === key))) return [];

  const selections = schedule.rows.filter((row) => !types.length || types.includes(row.key)).map((row) => {
    const dates = row.dates.filter((date) => start <= date && date <= (end ?? last)).sort();
    return { row, dates: end ? dates : dates.slice(0, 1) };
  });
  let heading = `${calendar.district}の次回のごみ収集予定（${year}年度）です。`;
  if (end && start === end) heading = `${calendar.district}の${formatDay(start)}のごみ収集予定です。`;
  else if (end) heading = `${calendar.district}の${formatDay(start)}から${formatDay(end)}までのごみ収集予定です。`;

  const lines = selections.map(({ row, dates }) => {
    const noDates = end ? "この期間の収集予定はありません。" : `${year}年度内で次回の予定はありません。`;
    return "・" + row.label + "　" + (dates.length ? formatDates(dates) : noDates);
  });
  function includes(low: string, high: string) {
    return end ? start <= high && low <= end : selections.some(({ dates }) => dates.some((date) => low <= date && date <= high));
  }
  if (includes(`${year}-12-29`, `${year}-12-31`)) lines.push("12月29日〜31日は、通常の収集時間や内容が変わる場合があります。");
  if (includes(`${year + 1}-01-01`, `${year + 1}-01-03`)) lines.push("1月1日〜3日は収集休止です。");
  if (selections.some(({ row, dates }) => row.key === "oversized" && dates.length)) {
    lines.push("粗大ごみは収集月の20日までに芳賀清掃社への予約が必要です。");
  }
  const answer = heading + "\n\n" + lines.join("\n");
  return [{ ...calendar, text: answer, calendar_answer: answer, source: "山田町の地区別ごみ収集日程表（1ページ）" }];
}
