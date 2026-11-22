import type { Pending, ProgressStage, QuestionAndAnswer } from "../frontend/types.js";
import { normalize } from "../shared/knowledge.js";
import type { SourceRecord } from "../shared/knowledge.js";
import { normalizeQuery } from "../shared/query.js";
import {
  AmbiguousDistrict, COLLECTION_PERIODS, COLLECTION_TYPES, collectionBounds, findCollectionDays, fiscalYear, namedWasteTypes, singleDistrictHint, todayInTokyo,
} from "./calendars.js";
import type { WasteType } from "./calendars.js";
import type { RetrievalResult, Retriever, SearchMode, SearchStrategy } from "./embeddings.js";
import { isObject, readTextFile } from "./files.js";
import { chatJson, OllamaError } from "./ollama.js";
import { ANSWER_INSTRUCTIONS, NO_EVIDENCE, rankSections } from "./records.js";
import type { SourceReader } from "./records.js";

const MAX_SEARCHES = 3;
const MAX_DECISIONS = MAX_SEARCHES + 1;
const EXCERPT_LIMIT = 600;
const DETAIL_LIMIT = 800;
const PRIOR_LIMIT = 300;
const MAX_PRIOR_PASSAGES = 3;
const TARGETS = ["official_documents", "collection_calendars"];
const NO_COLLECTION_DATES = "登録済みの日程表から、該当する収集日を確認できませんでした。";
const NO_LIVE_INFORMATION = "手元の資料では、現在の状況や当日の変更を確認できませんでした。施設や運営元、町の最新のお知らせをご確認ください。";
const OUTSIDE_SCOPE = "岩手県山田町の観光や暮らしを案内しています。山田町に関係する内容をお尋ねください。";
const INSTRUCTIONS = readTextFile("prompts/react.md").trimEnd()
  .replace("{ANSWER_INSTRUCTIONS}", ANSWER_INSTRUCTIONS)
  .replace("{TYPE_GUIDE}", Object.entries(COLLECTION_TYPES).map(([key, label]) => `  ${key} は ${label}`).join("\n"));
const TOOL_INSTRUCTIONS = readTextFile("prompts/react-tools.md").trimEnd();
const HISTORY_INSTRUCTIONS = "history は、直前までの質問と回答です。指示語や省略された対象を解釈するためだけに使います。同じ質問を再度された場合も資料を検索し、今回の observations を回答の根拠とします。";
const SEARCH_WORDING_INSTRUCTIONS = "search_wording は、質問や返答の読み・誤字から資料検索用に補った表記です。検索語を決める参考にし、質問の対象や条件は元の question と follow_up で確認します。";
const STREAM_INSTRUCTIONS = "回答を返す場合は、JSONを action、sources、answer の順で書いてください。";
const CONSTRAINT_INSTRUCTIONS = "候補ごとに年齢・移動手段・除外指定などを資料と照合します。必須条件が未確認なら、候補の実名と不足条件で検索します。徒歩で行けるという案内には、徒歩、距離、隣接のいずれかを示す資料を使います。適合する施設の名前、行きやすい理由、実際にできることを簡潔に説明し、対象外の候補は回答から省きます。営業時間を聞かれていなければ、今日の営業状況、曜日、営業時間は回答に入れません。「遊べる場所」のように活動が広い場合は、児童図書の読書など資料にある活動を具体的に伝え、遊具などは資料で確認した場合だけ案内します。";
const REVIEW_INSTRUCTIONS = "候補回答を引用資料と照合します。確認できた部分を先に見つけます。資料が駅との隣接を示せば徒歩での案内ができます。『遊べる場所』のように活動の指定が広ければ、資料にある児童図書の読書など具体的な過ごし方を案内できます。遊具は指定があるときだけ確認します。回答全体が裏づけられれば supported=true。無関係な候補や、今日の開館など未確認の断定を除く必要があれば supported=false とし、残せる文章を回答から一字一句変えずに一続きで excerpt に抜き出します。該当する文章もなく、調べられる条件があれば具体的な検索語を query に入れます。";
const REVIEW_FORMAT = {
  type: "object",
  properties: { supported: { type: "boolean" }, excerpt: { type: "string" }, query: { type: "string" } },
  required: ["supported"], additionalProperties: false,
};

const ACTIONS = ["answer", "clarify", "insufficient", "search"] as const;
type Action = (typeof ACTIONS)[number];

export class KnowledgeSearchError extends Error {}

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
  strategy?: SearchStrategy;
  source_id?: string;
}

interface Passage extends Pick<SourceRecord, "id" | "title" | "text" | "source" | "checked" | "published"> {
  truncated?: true;
}

interface CollectionHints {
  district?: string;
  waste_types?: WasteType[];
}

interface TurnState {
  question: string;
  today: string;
  current_fiscal_year: number;
  observations: (SearchEvent & { passages: Passage[] })[];
  search_strategies: SearchStrategy[];
  expandable_source_ids?: string[];
  available_sections?: Record<string, string[]>;
  history?: QuestionAndAnswer[];
  prior_passages?: Passage[];
  follow_up?: { asked: string; reply: string };
  search_wording?: { question?: string; reply?: string };
  collection_hints?: CollectionHints;
  remaining_searches?: number;
}

export type Decider = (
  state: TurnState, actions: Action[], signal?: AbortSignal, onContent?: (text: string) => void,
) => Promise<Record<string, unknown>>;

interface TurnOptions {
  pending?: Pending | null;
  history?: QuestionAndAnswer[];
  signal?: AbortSignal;
  searchMode?: SearchMode;
  readSource?: SourceReader;
  checkpoint?: readonly SourceRecord[];
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
  checkpoint?: SourceRecord[];
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

const sentences = new Intl.Segmenter("ja", { granularity: "sentence" });

function omitUnaskedDailySchedule(answer: string, wording: string) {
  const timing = /営業|開館|休館|閉館|開[いくきけ]|休み|定休日|何時|いつ|何曜日|日中|今から|今朝|今夜|今日|本日|明日|当日|きょう|あした|現在|平日|休日|週末|祝日|[月火水木金土日]曜|\d+[月日時]/;
  if (timing.test(normalize(wording))) return answer;
  return [...sentences.segment(answer)].filter(({ segment }) => {
    const dated = /(?:本日|今日|明日)(?:は|の|も|[（(、])/.test(segment);
    const operating = /営業|開館|休館|閉館|開店|閉店|休業/.test(segment);
    return !dated || !operating;
  }).map(({ segment }) => segment).join("").trim();
}

export function makeDecider(model: string, timeoutMs?: number): Decider {
  return async (state, actions, signal, onContent) => {
    const sourceIds = new Set([
      ...state.observations.flatMap(({ source_ids }) => source_ids),
      ...(state.prior_passages ?? []).map(({ id }) => id),
    ]);
    const sources = {
      type: "array",
      items: { type: "string", ...(sourceIds.size ? { enum: [...sourceIds] } : {}) },
    };
    const expandable = state.expandable_source_ids;
    const wording = state.question + " " + (state.follow_up?.reply ?? "");
    const checkConstraints = !state.collection_hints &&
      /以外|いがい(?:で|の)|を除[くい]|抜きで|が使えない|できない場合/u.test(normalize(wording));
    const stream = checkConstraints ? undefined : onContent;
    const properties = {
      action: { type: "string", enum: actions },
      target: { type: "string", enum: expandable?.length ? [...TARGETS, "source_details"] : TARGETS },
      strategy: { type: "string", enum: state.search_strategies },
      ...(expandable?.length ? { source_id: { type: "string", enum: expandable } } : {}),
      query: { type: "string" },
      missing_fact: { type: "string" },
      district: { type: "string" },
      fiscal_year: { type: "integer" },
      period: { type: "string", enum: COLLECTION_PERIODS },
      start_date: { type: "string" },
      end_date: { type: "string" },
      waste_types: { type: "array", items: { type: "string", enum: Object.keys(COLLECTION_TYPES) } },
      field: { type: "string", enum: ["district", "condition"] },
      reason: { type: "string", enum: ["missing_evidence", "live_information", "outside_scope"] },
      answer: { type: "string" },
      other_answer: { type: "string" },
      sources,
    };
    const instructions = [
      INSTRUCTIONS, TOOL_INSTRUCTIONS, ...(checkConstraints ? [CONSTRAINT_INSTRUCTIONS] : []),
      ...(state.search_wording ? [SEARCH_WORDING_INSTRUCTIONS] : []),
      ...(state.history ? [HISTORY_INSTRUCTIONS] : []), ...(stream ? [STREAM_INSTRUCTIONS] : []),
    ].join("\n\n");
    const decision = await chatJson({
      model, signal, onContent: stream, timeoutMs,
      messages: [{ role: "system", content: instructions }, { role: "user", content: formatPromptJson(state) }],
      format: {
        type: "object",
        properties: stream ? Object.assign({ action: properties.action, sources, answer: properties.answer }, properties) : properties,
        required: ["action"], additionalProperties: false,
      },
    });
    if (!ACTIONS.some((action) => action === decision.action)) {
      throw new OllamaError("AIから検索や回答に必要な指示を読み取れませんでした。");
    }
    if (checkConstraints && decision.action === "answer" && actions.includes("answer") &&
        Array.isArray(decision.sources) && typeof decision.answer === "string") {
      const context = [wording, ...(state.history ?? []).map(({ question }) => question)].join("\n");
      const answer = omitUnaskedDailySchedule(decision.answer, context);
      if (!answer) return { action: "insufficient" };
      const cited = new Set(decision.sources);
      const passages = new Map([
        ...(state.prior_passages ?? []),
        ...state.observations.flatMap(({ passages }) => passages),
      ].filter(({ id }) => cited.has(id)).map((passage) => [passage.id, passage]));
      const review = await chatJson({
        model, signal, timeoutMs, format: REVIEW_FORMAT,
        messages: [
          { role: "system", content: REVIEW_INSTRUCTIONS },
          { role: "user", content: formatPromptJson({
            question: state.question, follow_up: state.follow_up, answer, passages: [...passages.values()],
          }) },
        ],
      });
      if (review.supported !== true) {
        const excerpt = trimString(review.excerpt);
        if (excerpt && answer.includes(excerpt)) return { ...decision, answer: excerpt };
        const query = trimString(review.query);
        return actions.includes("search") && query && [...query].length <= 400
          ? { action: "search", target: "official_documents", query, missing_fact: "候補と利用条件の照合" }
          : { action: "insufficient" };
      }
      return { ...decision, answer };
    }
    return decision;
  };
}

function asksReservationDeadline(text: string) {
  return /申[し込]|予約|受付/.test(text) && /(?:何日|いつ|何時)まで/.test(text);
}

function asksCollectionDate(text: string) {
  const query = normalize(text);
  if (/収集日|収集予定|回収日|収集.*日程|ごみ.*日程|ごみの日/.test(query)) return true;
  if (asksReservationDeadline(query)) return false;
  return (/ごみ|ぺっとぼとる|蛍光灯/.test(query) || namedWasteTypes(query).length > 0) &&
    /今日|(?<!とう)きょう|明日|あした|次回|次の|つぎの|何日|何曜日|[0-9]+月|いつ(?!までに)/.test(query);
}

function collectionHints(wording: string[]): CollectionHints {
  const district = singleDistrictHint(wording);
  for (const phrase of wording) {
    const types = namedWasteTypes(phrase);
    if (types.length) return { district, waste_types: types };
  }
  // 「地区のごみ収集日」のように全区分を尋ねている場合にだけ空配列を指定する。
  const allTypes = wording.some((phrase) =>
    /(?:^|の|で)(?:次(?:の|回の))?ごみ(?:の?収集日|の日|はいつ)/.test(normalize(phrase)));
  return { district, ...(allTypes ? { waste_types: [] } : {}) };
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

function passageFor(record: SourceRecord, limit: number): Passage {
  const { id, title, text, source, checked, published } = record;
  const excerpt = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
  return { id, title, text: excerpt, source, checked, published, ...(excerpt.length < text.length ? { truncated: true } : {}) };
}

function configureSearch(event: SearchEvent, decision: Record<string, unknown>, today: string,
                         wording: string[], hints: CollectionHints | undefined, retrieve: Retriever, strategies: SearchStrategy[], signal?: AbortSignal) {
  if (event.target === "official_documents") {
    const searchTerms = trimString(decision.query);
    if (!searchTerms) return;
    const ageGroups = [...new Set(wording.join(" ").match(/小学生|中学生|高校生|未就学児|乳幼児/g))];
    const ageGroup = ageGroups.length === 1 ? ageGroups[0] : undefined;
    const query = ageGroup && /屋内|遊|子[供ど]|こども|親子/u.test(searchTerms) && !searchTerms.includes(ageGroup)
      ? searchTerms + " " + ageGroup : searchTerms;
    if ([...query].length > 400) return;
    const strategy = decision.strategy === undefined ? strategies[0] : strategies.find((value) => value === decision.strategy);
    if (!strategy) return;
    Object.assign(event, { query, strategy });
    return {
      key: JSON.stringify([event.target, strategy, compactText(normalize(normalizeQuery(query)))]),
      lookup: (): Promise<LookupResult> => retrieve(query, signal, strategy),
    };
  }
  if (event.target === "collection_calendars") {
    const district = hints?.district ?? trimString(decision.district);
    const types = hints?.waste_types ?? decision.waste_types ?? [];
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

function configureDetailSearch(event: SearchEvent, decision: Record<string, unknown>, state: TurnState,
                               readSource: SourceReader | undefined, evidence: ReadonlyMap<string, SourceRecord>,
                               exposedLengths: ReadonlyMap<string, number>) {
  const sourceId = trimString(decision.source_id);
  const query = trimString(decision.query);
  if (!readSource || !state.expandable_source_ids?.includes(sourceId) || !query || [...query].length > 400) return;
  const anchor = evidence.get(sourceId)!;
  Object.assign(event, { source_id: sourceId, query });
  return {
    key: JSON.stringify([event.target, sourceId, compactText(normalize(normalizeQuery(query)))]),
    lookup: async (): Promise<LookupResult> => {
      const records = exposedLengths.get(sourceId)! < Math.min(anchor.text.length, DETAIL_LIMIT) ? [anchor] : [];
      const unseen = readSource(anchor).filter(({ id }) => !evidence.has(id));
      return { records: [...records, ...rankSections(unseen, query, 2 - records.length)] };
    },
  };
}

export async function runTurn(question: string, decide: Decider, retrieve: Retriever, {
  pending, history, signal, searchMode = "hybrid", readSource, checkpoint, today = todayInTokyo(), onProgress, onDelta, onAction,
}: TurnOptions = {}): Promise<TurnResult> {
  const state: TurnState = {
    question: pending?.question ?? question, today, current_fiscal_year: fiscalYear(today), observations: [],
    search_strategies: searchMode === "keyword" ? ["keyword"] : ["hybrid", "keyword", "semantic"],
  };
  if (history?.length) state.history = history;
  const hint = pending?.district_hint;
  const reply = hint && /^[0-9]+(?:区|く(?=$|です|[のでにはがとを]))/.test(normalize(question)) ? hint + question : question;
  if (pending) state.follow_up = { asked: pending.prompt, reply };
  const searchQuestion = normalizeQuery(state.question);
  const searchReply = pending ? normalizeQuery(reply) : reply;
  if (searchQuestion !== state.question || searchReply !== reply) {
    state.search_wording = {
      question: searchQuestion !== state.question ? searchQuestion : undefined,
      reply: searchReply !== reply ? searchReply : undefined,
    };
  }
  const wording = pending ? [searchReply, searchQuestion] : [searchQuestion];
  let calendarQuestion = asksCollectionDate(wording.join("\n"));
  const repeatedQuestion = !pending && history?.some((turn) => normalize(turn.question) === normalize(question));
  if (calendarQuestion) state.collection_hints = collectionHints(wording);

  const evidence = new Map<string, SourceRecord>();
  const exposedLengths = new Map<string, number>();
  if (pending && checkpoint?.length) {
    state.prior_passages = checkpoint.slice(0, MAX_PRIOR_PASSAGES).map((record) => {
      const passage = passageFor(record, PRIOR_LIMIT);
      evidence.set(record.id, record);
      exposedLengths.set(record.id, passage.text.length);
      return passage;
    });
  }

  function clarify(prompt: string, field: Pending["field"], districtHint?: string): TurnResult {
    const prior = [...evidence.values()].filter((record) => !record.calendar_answer).slice(0, MAX_PRIOR_PASSAGES);
    return {
      action: "clarify", answer: prompt, sources: [],
      pending: { question: state.question, field, prompt, ...(districtHint ? { district_hint: districtHint } : {}) },
      ...(prior.length ? { checkpoint: prior } : {}),
    };
  }

  const previous = new Map<string, LookupResult>();
  let ambiguity: AmbiguousDistrict | undefined;
  let searches = 0;
  let searchDetail: string | undefined;
  let insufficientReason: unknown;

  for (let step = 0; step < MAX_DECISIONS; step++) {
    signal?.throwIfAborted();
    const canClarifyDistrict = calendarQuestion && !state.collection_hints?.district;
    const canClarifyCondition = !calendarQuestion && !pending;
    const repeatNeedsSearch = step === 0 && repeatedQuestion && !calendarQuestion;
    const actions: Action[] = repeatNeedsSearch ? [] : ["insufficient"];
    if (!repeatNeedsSearch && (canClarifyDistrict || canClarifyCondition)) actions.unshift("clarify");
    if (evidence.size) actions.push("answer");
    const remaining = Math.min(MAX_SEARCHES - searches, MAX_DECISIONS - step - 1);
    if (remaining) actions.push("search");
    state.remaining_searches = remaining;
    state.expandable_source_ids = readSource && [...evidence.values()].filter((record) =>
      !record.calendar_answer && (exposedLengths.get(record.id)! < Math.min(record.text.length, DETAIL_LIMIT) ||
        readSource(record).some(({ id }) => !evidence.has(id)))
    ).map(({ id }) => id);
    state.available_sections = readSource && state.expandable_source_ids?.length
      ? Object.fromEntries(state.expandable_source_ids.map((id) => {
        const sections = readSource(evidence.get(id)!).filter((record) => !evidence.has(record.id));
        const ranked = sections.length <= 3 ? sections : rankSections(sections, state.question, 3);
        return [id, ranked.map((record) => (record.heading ?? record.title).slice(0, 80))];
      }))
      : undefined;
    onProgress?.(state.observations.length ? "reviewing" : "planning", searchDetail);
    const stream = onDelta && evidence.size && !calendarQuestion ? streamGroundedAnswer(evidence, onDelta) : undefined;
    const decision = await decide(state, actions, signal, stream);
    const action = actions.find((allowed) => allowed === decision.action);
    if (!action) break;

    if (action === "search") {
      const event: SearchEvent = { action, target: decision.target, status: "invalid", source_ids: [] };
      const missing = trimString(decision.missing_fact);
      if (missing) event.missing_fact = [...compactText(missing)].slice(0, 60).join("");
      if (event.target === "collection_calendars") {
        calendarQuestion = true;
        state.collection_hints ??= collectionHints(wording);
      }
      const search = event.target === "source_details"
        ? configureDetailSearch(event, decision, state, readSource, evidence, exposedLengths)
        : configureSearch(event, decision, today, wording, state.collection_hints, retrieve, state.search_strategies, signal);
      let found: LookupResult | undefined;
      if (search) {
        found = previous.get(search.key);
        if (found) event.status = "reused";
        else {
          searchDetail = event.missing_fact ?? (event.target === "source_details" ? "見つけた資料の詳しい内容" : undefined);
          onProgress?.("searching", searchDetail);
          searches++;
          try {
            const result = await search.lookup();
            found = { ...result, records: result.records.map((record) =>
              record.calendar_answer && evidence.has(record.id) && evidence.get(record.id)!.text !== record.text
                ? { ...record, id: `${record.id}-lookup-${searches}` } : record
            ) };
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
      const hits = found?.records ?? [];
      const limit = event.target === "source_details" ? DETAIL_LIMIT : EXCERPT_LIMIT;
      const passages = hits.flatMap((record) => {
        const passage = passageFor(record, limit);
        const length = exposedLengths.get(record.id);
        if (length !== undefined && length >= passage.text.length) return [];
        evidence.set(record.id, record);
        exposedLengths.set(record.id, passage.text.length);
        return [passage];
      });
      event.source_ids = hits.map(({ id }) => id);
      if (found?.mode) event.retrieval = found.mode;
      onAction?.(event);
      state.observations.push({ ...event, passages });
      continue;
    }

    onAction?.({ action });
    const answer = trimString(decision.answer);
    const sources = knownSourceIds(decision.sources, evidence)
      ? [...new Set(decision.sources)].map((id) => evidence.get(id)!) : [];
    if (ambiguity) return clarify(`「${ambiguity.district}」には複数の収集区分があります。区番号や、ごみステーションの目印を教えてください。`, "district", ambiguity.district);
    if (action === "clarify" && decision.field === "district" && canClarifyDistrict) {
      return clarify("山田町内のどの地区か教えてください。", "district", hint);
    }
    if (action === "clarify" && decision.field === "condition" && canClarifyCondition &&
        answer && [...answer].length <= 120 && !/https?:\/\//i.test(answer)) {
      return clarify(compactText(answer), "condition");
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
    if (action === "insufficient") insufficientReason = decision.reason;
    break;
  }
  if (state.observations.length && state.observations.every(({ status }) => status === "invalid" || status === "error")) {
    throw new KnowledgeSearchError(searches ? "AIが資料の検索を完了できませんでした。" : "AIが検索語など、資料を探す条件を指定できませんでした。");
  }
  const answer = calendarQuestion ? NO_COLLECTION_DATES
    : insufficientReason === "live_information" ? NO_LIVE_INFORMATION
    : insufficientReason === "outside_scope" ? OUTSIDE_SCOPE
    : NO_EVIDENCE;
  return { action: "insufficient", answer, sources: [], pending: null };
}
