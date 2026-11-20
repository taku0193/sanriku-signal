import type { Pending, ProgressStage, QuestionAndAnswer } from "../frontend/types.js";
import { normalize } from "../shared/knowledge.js";
import type { SourceRecord } from "../shared/knowledge.js";
import {
  AmbiguousDistrict, COLLECTION_PERIODS, COLLECTION_TYPES, collectionBounds, findCollectionDays, fiscalYear, todayInTokyo,
} from "./calendars.js";
import type { WasteType } from "./calendars.js";
import type { RetrievalResult, Retriever } from "./embeddings.js";
import { isObject, readTextFile } from "./files.js";
import { chatJson } from "./ollama.js";
import { ANSWER_INSTRUCTIONS, NO_EVIDENCE } from "./records.js";

const MAX_SEARCHES = 2;
const MAX_DECISIONS = 3;
const TARGETS = ["official_documents", "collection_calendars"];
const NO_COLLECTION_DATES = "登録済みの日程表から、該当する収集日を確認できませんでした。";
const INSTRUCTIONS = readTextFile("prompts/react.md").trimEnd()
  .replace("{ANSWER_INSTRUCTIONS}", ANSWER_INSTRUCTIONS)
  .replace("{TYPE_GUIDE}", Object.entries(COLLECTION_TYPES).map(([key, label]) => `  ${key} は ${label}`).join("\n"));
const HISTORY_INSTRUCTIONS = "history は、直前までの質問と回答です。指示語や省略された対象を解釈するためだけに使い、回答の根拠は今回の observations に限定します。";
const STREAM_INSTRUCTIONS = "回答を返す場合は、JSONを action、sources、answer の順で書いてください。";

type Action = "answer" | "clarify" | "insufficient" | "search";

interface SearchEvent {
  action: "search";
  target: unknown;
  status: "invalid" | "reused" | "error" | "ambiguous" | "found" | "not_found";
  source_ids: string[];
  missing_fact?: string;
  query?: string;
  district?: string;
  fiscal_year?: number;
  start_date?: string;
  end_date?: string;
  waste_types?: WasteType[];
  district_candidates?: string[];
  retrieval?: RetrievalResult["mode"];
}

interface TurnState {
  question: string;
  today: string;
  current_fiscal_year: number;
  observations: (SearchEvent & {
    passages: Pick<SourceRecord, "id" | "title" | "text" | "source" | "checked" | "published">[];
  })[];
  history?: QuestionAndAnswer[];
  follow_up?: { asked: string; reply: string };
  remaining_searches?: number;
}

export type Decider = (
  state: TurnState, actions: Action[], signal?: AbortSignal, onContent?: (text: string) => void,
) => Promise<Record<string, unknown>>;

interface TurnOptions {
  pending?: Pending | null;
  history?: QuestionAndAnswer[];
  signal?: AbortSignal;
  today?: string;
  onProgress?: (stage: ProgressStage, detail?: string) => void;
  onDelta?: (text: string) => void;
  onAction?: (action: SearchEvent | { action: Exclude<Action, "search"> }) => void;
}

interface TurnResult {
  action: Exclude<Action, "search">;
  answer: string;
  sources: SourceRecord[];
  pending: Pending | null;
}

function knownSourceIds(value: unknown, evidence: ReadonlyMap<string, unknown>): value is string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((id) => typeof id === "string" && evidence.has(id));
}

export function readGroundedPrefix(content: string, evidence: ReadonlyMap<string, unknown>): string {
  const prefix = /^\s*\{\s*"action"\s*:\s*"answer"\s*,\s*"sources"\s*:\s*(\[(?:[^"\]]|"(?:[^"\\]|\\.)*")*\])\s*,\s*"answer"\s*:\s*"/.exec(content);
  if (!prefix) return "";
  try {
    if (!knownSourceIds(JSON.parse(prefix[1]), evidence)) return "";
    const escaped = /^(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*/.exec(content.slice(prefix[0].length))![0];
    const answer = (JSON.parse('"' + escaped + '"') as string).replace(/[\uD800-\uDBFF]$/, "");
    return /[\uD800-\uDFFF]/u.test(answer) ? "" : answer.trimStart();
  } catch (error) {
    if (error instanceof SyntaxError) return "";
    throw error;
  }
}

export function streamGroundedAnswer(evidence: ReadonlyMap<string, unknown>, onDelta: (text: string) => void) {
  let emitted = "";
  return (content: string) => {
    const answer = readGroundedPrefix(content, evidence);
    if (answer.length > emitted.length && answer.startsWith(emitted)) {
      onDelta(answer.slice(emitted.length));
      emitted = answer;
    }
  };
}

function formatPromptJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(formatPromptJson).join(", ") + "]";
  if (isObject(value)) return "{" + Object.entries(value).filter(([, field]) => field !== undefined)
    .map(([key, field]) => JSON.stringify(key) + ": " + formatPromptJson(field)).join(", ") + "}";
  return JSON.stringify(value);
}

export function makeDecider(model: string): Decider {
  return (state, actions, signal, onContent) => {
    const sources = {
      type: "array",
      items: {
        type: "string",
        ...(onContent ? { enum: [...new Set(state.observations.flatMap((observation) => observation.source_ids))] } : {}),
      },
    };
    const properties = {
      action: { type: "string", enum: actions },
      target: { type: "string", enum: TARGETS },
      query: { type: "string" },
      missing_fact: { type: "string" },
      district: { type: "string" },
      fiscal_year: { type: "integer" },
      period: { type: "string", enum: COLLECTION_PERIODS },
      start_date: { type: "string" },
      end_date: { type: "string" },
      waste_types: { type: "array", items: { type: "string", enum: Object.keys(COLLECTION_TYPES) } },
      field: { type: "string", enum: ["district"] },
      answer: { type: "string" },
      other_answer: { type: "string" },
      sources,
    };
    const instructions = [
      INSTRUCTIONS, ...(state.history ? [HISTORY_INSTRUCTIONS] : []), ...(onContent ? [STREAM_INSTRUCTIONS] : []),
    ].join("\n\n");
    return chatJson({
      model, signal, onContent,
      messages: [{ role: "system", content: instructions }, { role: "user", content: formatPromptJson(state) }],
      format: {
        type: "object",
        properties: onContent ? Object.assign({ action: properties.action, sources, answer: properties.answer }, properties) : properties,
        required: ["action"], additionalProperties: false,
      },
    });
  };
}

function asksReservationDeadline(text: string) {
  return /申[し込]|予約|受付/.test(text) && /(?:何日|いつ|何時)まで/.test(text);
}

function asksCollectionDate(text: string) {
  const query = normalize(text);
  if (/収集日|収集予定|回収日|収集.*日程|ごみ.*日程|ごみの日/.test(query)) return true;
  if (asksReservationDeadline(query)) return false;
  return /ごみ|ぺっとぼとる|空き?びん|乾電池|ぷら|[段だん]ぼーる|缶|新聞|紙ぱっく|蛍光[管灯]|水銀/.test(query) &&
    /今日|明日|次回|次の|何日|何曜日|[0-9]+月|いつ(?!までに)/.test(query);
}

function compactText(text: string) {
  return text.trim().replace(/\s+/g, " ");
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isWasteType(value: unknown): value is WasteType {
  return typeof value === "string" && Object.hasOwn(COLLECTION_TYPES, value);
}

type LookupResult = { records: SourceRecord[]; mode?: RetrievalResult["mode"] };

function configureSearch(event: SearchEvent, decision: Record<string, unknown>, today: string,
                         wording: string[], retrieve: Retriever, signal?: AbortSignal) {
  if (event.target === "official_documents") {
    const query = trimString(decision.query);
    if (!query || [...query].length > 400) return;
    event.query = query;
    return {
      key: JSON.stringify([event.target, compactText(normalize(query))]),
      lookup: (): Promise<LookupResult> => retrieve(query, signal),
    };
  }
  if (event.target === "collection_calendars") {
    const district = trimString(decision.district);
    const types = Object.hasOwn(decision, "waste_types") ? decision.waste_types : [];
    if (!district || [...district].length > 80 || !Array.isArray(types) || !types.every(isWasteType)) return;
    let bounds: ReturnType<typeof collectionBounds>;
    try {
      bounds = collectionBounds(decision, today, wording);
    } catch (error) {
      if (error instanceof RangeError) return;
      throw error;
    }
    const wasteTypes = [...new Set(types)].sort();
    Object.assign(event, {
      district, fiscal_year: bounds.year, start_date: bounds.start, waste_types: wasteTypes,
      ...(bounds.end ? { end_date: bounds.end } : {}),
    });
    return {
      key: JSON.stringify([event.target, compactText(normalize(district)), bounds.year, bounds.start, bounds.end, wasteTypes]),
      lookup: (): Promise<LookupResult> => Promise.resolve({ records: findCollectionDays(district, bounds, wasteTypes, wording) }),
    };
  }
}

export async function runTurn(question: string, decide: Decider, retrieve: Retriever, {
  pending, history, signal, today = todayInTokyo(), onProgress, onDelta, onAction,
}: TurnOptions = {}): Promise<TurnResult> {
  const state: TurnState = {
    question: pending?.question ?? question, today, current_fiscal_year: fiscalYear(today), observations: [],
  };
  if (history?.length) state.history = history;
  const hint = pending?.district_hint;
  const reply = hint && /^[0-9]+区/.test(normalize(question)) ? hint + question : question;
  if (pending) state.follow_up = { asked: pending.prompt, reply };
  const wording = pending ? [reply, pending.question] : [question];
  let calendarQuestion = asksCollectionDate(wording.join("\n"));
  const reservationOnly = !calendarQuestion && asksReservationDeadline(normalize(state.question));

  function clarify(prompt: string, districtHint?: string): TurnResult {
    return {
      action: "clarify", answer: prompt, sources: [],
      pending: { question: state.question, field: "district", prompt, ...(districtHint ? { district_hint: districtHint } : {}) },
    };
  }

  const evidence = new Map<string, SourceRecord>();
  const previous = new Map<string, LookupResult>();
  let ambiguity: AmbiguousDistrict | undefined;
  let searches = 0;
  let searchDetail: string | undefined;

  for (let step = 0; step < MAX_DECISIONS; step++) {
    signal?.throwIfAborted();
    const actions: Action[] = reservationOnly ? ["insufficient"] : ["clarify", "insufficient"];
    if (evidence.size) actions.push("answer");
    const remaining = Math.min(MAX_SEARCHES - searches, MAX_DECISIONS - step - 1);
    if (remaining) actions.push("search");
    state.remaining_searches = remaining;
    onProgress?.(state.observations.length ? "reviewing" : "planning", searchDetail);
    const stream = onDelta && evidence.size && !calendarQuestion ? streamGroundedAnswer(evidence, onDelta) : undefined;
    const decision = await decide(state, actions, signal, stream);
    const action = actions.find((allowed) => allowed === decision.action);
    if (!action) break;

    if (action === "search") {
      const event: SearchEvent = { action, target: decision.target, status: "invalid", source_ids: [] };
      const missing = trimString(decision.missing_fact);
      if (missing) event.missing_fact = missing;
      if (event.target === "collection_calendars") calendarQuestion = true;
      const search = configureSearch(event, decision, today, wording, retrieve, signal);
      let found: LookupResult | undefined;
      if (search) {
        found = previous.get(search.key);
        if (found) event.status = "reused";
        else {
          searchDetail = [...compactText(missing)].slice(0, 60).join("") || undefined;
          onProgress?.("searching", searchDetail);
          searches++;
          try {
            found = await search.lookup();
            found.records = found.records.map((record) =>
              record.calendar_answer && evidence.has(record.id) && evidence.get(record.id)!.text !== record.text
                ? { ...record, id: `${record.id}-lookup-${searches}` } : record
            );
            previous.set(search.key, found);
            event.status = found.records.length ? "found" : "not_found";
            if (event.target === "collection_calendars" && found.records.length) ambiguity = undefined;
          } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (error instanceof AmbiguousDistrict) {
              ambiguity = error;
              event.status = "ambiguous";
              event.district_candidates = error.choices;
            } else event.status = "error";
          }
        }
      }
      const passages = found?.records ?? [];
      for (const record of passages) evidence.set(record.id, record);
      event.source_ids = passages.map((record) => record.id);
      if (found?.mode) event.retrieval = found.mode;
      onAction?.(event);
      state.observations.push({
        ...event, passages: event.status === "reused" ? [] : passages.map(({ id, title, text, source, checked, published }) =>
          ({ id, title, text, source, checked, published })),
      });
      continue;
    }

    onAction?.({ action });
    const answer = trimString(decision.answer);
    const sources = knownSourceIds(decision.sources, evidence)
      ? [...new Set(decision.sources)].map((id) => evidence.get(id)!) : [];
    if (ambiguity) return clarify(`「${ambiguity.district}」には複数の収集区分があります。区番号や、ごみステーションの目印を教えてください。`, ambiguity.district);
    if (action === "clarify" && decision.field === "district") {
      return clarify(answer && [...answer].length <= 400 ? answer : "山田町内のどの地区か教えてください。", hint);
    }
    if (action === "answer" && sources.length) {
      const dates = sources.flatMap((record) => record.calendar_answer ? [record.calendar_answer] : []);
      if (dates.length) {
        const additional = trimString(decision.other_answer);
        if (additional && dates.length < sources.length) dates.push(additional);
        return { action, answer: dates.join("\n\n"), sources, pending: null };
      }
      if (answer && !calendarQuestion) return { action, answer, sources, pending: null };
    }
    if (action === "insufficient" && !calendarQuestion) {
      return { action, answer: answer || NO_EVIDENCE, sources, pending: null };
    }
    break;
  }
  return { action: "insufficient", answer: calendarQuestion ? NO_COLLECTION_DATES : NO_EVIDENCE, sources: [], pending: null };
}
