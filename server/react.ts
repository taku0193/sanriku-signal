import type { AnswerPresentation, Pending, ProgressStage, QuestionAndAnswer } from "../frontend/types.js";
import { mentionsSubject, normalize, quotedSubject } from "../shared/knowledge.js";
import type { SourceRecord } from "../shared/knowledge.js";
import { normalizeQuery } from "../shared/query.js";
import {
  AmbiguousDistrict, COLLECTION_PERIODS, COLLECTION_TYPES, collectionBounds, collectionMonthTypes, explicitCollectionDates, findCollectionDays,
  fiscalYear, hasCollectionYear, mentionedDistrict, namedWasteTypes, todayInTokyo,
} from "./calendars.js";
import type { WasteType } from "./calendars.js";
import type { RetrievalResult, Retriever, SearchMode, SearchStrategy } from "./embeddings.js";
import { isObject, readTextFile } from "./files.js";
import { chatJson, OllamaError, OllamaResponseError } from "./ollama.js";
import { asksForUpcomingEvent, documentsEventYear, documentsUpcomingEvent, requestedEventYear } from "./periods.js";
import { ANSWER_INSTRUCTIONS, NO_EVIDENCE, rankSections } from "./records.js";
import type { SourceReader } from "./records.js";

const MAX_SEARCHES = 5;
const MAX_DECISIONS = MAX_SEARCHES + 1;
const EVIDENCE_REVIEW_TIMEOUT = 8_000;
const EXCERPT_LIMIT = 600;
const DETAIL_LIMIT = 800;
const EARLIER_EXCERPT_LIMIT = 240;
const PRIOR_LIMIT = 300;
const MAX_PRIOR_PASSAGES = 3;
const TARGETS = ["official_documents", "collection_calendars"];
const NO_COLLECTION_DATES = "登録済みの日程表から、該当する収集日を確認できませんでした。";
const INVALID_COLLECTION_DATE = "指定の日付はカレンダーにありません。年月日を確認して、もう一度教えてください。";
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
const EVIDENCE_REVIEW_INSTRUCTIONS = "回答を作る前に、質問と取得資料を照合してください。対象、年や時期、金額、例外、質問された複数の項目を確認します。質問を裏づける資料IDだけを source_ids に入れます。案内を左右する条件が資料にある場合は、該当する短い原文を excerpts に入れます。複数の用件ではそれぞれの根拠を選び、地点・曜日・受付方法などで異なる条件を混同しません。登録資料で調べられそうな重要な項目が未確認の場合だけ、その項目を missing_fact、検索に使える具体的な固有名と項目を query に書きます。当日の混雑や空席など登録資料で確定できない状況には検索を追加しません。質問に答える本文は出さず、JSONだけ返してください。";
const BOOKING_SCHEDULE_INSTRUCTIONS = "運行日と電話・アプリの受付日は別々に確認します。地名や駅が指定されていれば、最初に適用される路線名と運行曜日を資料の表記で答えます。次に電話で当日予約できるかを先に答え、事前予約の方法とアプリの受付時間を区別します。平日の電話受付に土日を含めません。";

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

interface Passage extends Pick<SourceRecord, "id" | "title" | "text" | "source" | "checked" | "published" | "period"> {
  truncated?: true;
}

interface EvidenceReview {
  source_ids: string[];
  excerpts?: { source_id: string; text: string }[];
  missing_fact?: string;
  query?: string;
}

interface EvidenceReviewEvent {
  action: "review";
  status: "checked" | "unavailable";
  source_ids: string[];
  missing_fact?: string;
}

interface CollectionHints {
  district?: string;
  waste_types?: WasteType[];
}

interface TurnState {
  question: string;
  today: string;
  current_fiscal_year: number;
  requested_event_year?: number;
  requested_event_after?: string;
  observations: (SearchEvent & { passages: Passage[] })[];
  search_strategies: SearchStrategy[];
  expandable_source_ids?: string[];
  available_sections?: Record<string, string[]>;
  history?: QuestionAndAnswer[];
  prior_passages?: Passage[];
  follow_up?: { asked: string; reply: string };
  search_wording?: { question?: string; reply?: string };
  collection_hints?: CollectionHints;
  collection_excluded?: true;
  quoted_subject?: string;
  resolved_name?: string;
  reference_question?: string;
  answer_layout?: "comparison" | "multiple";
  round_trip_counts?: string[];
  remaining_searches?: number;
  evidence_review?: EvidenceReview;
}

export type Decider = ((
  state: TurnState, actions: Action[], signal?: AbortSignal, onContent?: (text: string) => void,
) => Promise<Record<string, unknown>>) & {
  reviewEvidence?: (state: TurnState, signal?: AbortSignal) => Promise<EvidenceReview>;
};

interface TurnOptions {
  pending?: Pending | null;
  history?: QuestionAndAnswer[];
  signal?: AbortSignal;
  searchMode?: SearchMode;
  readSource?: SourceReader;
  resolveName?: (question: string) => string | undefined;
  checkpoint?: readonly SourceRecord[];
  today?: string;
  onProgress?: (stage: ProgressStage, detail?: string) => void;
  onDelta?: (text: string) => void;
  onAction?: (action: SearchEvent | EvidenceReviewEvent | { action: Exclude<Action, "search"> }) => void;
}

interface TurnResult {
  action: Exclude<Action, "search">;
  answer: string;
  sources: SourceRecord[];
  presentation?: AnswerPresentation;
  pending: Pending | null;
  checkpoint?: SourceRecord[];
}

function knownSourceIds(value: unknown, evidence: ReadonlyMap<string, unknown>): value is string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((id) => typeof id === "string" && evidence.has(id));
}

export function readGroundedPrefix<T>(content: string, evidence: ReadonlyMap<string, T>, matches?: (record: T) => boolean): string {
  const prefix = /^\s*\{\s*"action"\s*:\s*"answer"\s*,\s*"sources"\s*:\s*(\[(?:[^"\]]|"(?:[^"\\]|\\.)*")*\])\s*,\s*"answer"\s*:\s*"/.exec(content);
  if (!prefix) return "";
  try {
    const ids: unknown = JSON.parse(prefix[1]);
    if (!knownSourceIds(ids, evidence) || (matches && !ids.some((id) => matches(evidence.get(id)!)))) return "";
    const escaped = /^(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*/.exec(content.slice(prefix[0].length))![0];
    const answer = (JSON.parse('"' + escaped + '"') as string).replace(/[\uD800-\uDBFF]$/, "");
    return /[\uD800-\uDFFF]/u.test(answer) ? "" : answer.trimStart();
  } catch (error) {
    if (error instanceof SyntaxError) return "";
    throw error;
  }
}

export function streamGroundedAnswer<T>(evidence: ReadonlyMap<string, T>, onDelta: (text: string) => void,
                                        matches?: (record: T) => boolean) {
  let emitted = "";
  return (content: string) => {
    const answer = readGroundedPrefix(content, evidence, matches);
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

function stateForPrompt(state: TurnState): TurnState {
  if (state.observations.length <= 3) return state;
  return {
    ...state,
    observations: state.observations.map((observation, index) => index >= state.observations.length - 2 ? observation : {
      ...observation,
      passages: observation.passages.map((passage) => passage.text.length <= EARLIER_EXCERPT_LIMIT ? passage : {
        ...passage, text: passage.text.slice(0, EARLIER_EXCERPT_LIMIT).replace(/[\uD800-\uDBFF]$/, ""), truncated: true,
      }),
    }),
  };
}

const sentences = new Intl.Segmenter("ja", { granularity: "sentence" });

function asksBookingSchedule(wording: string) {
  const text = normalize(wording);
  return /平日|休日|曜日|土曜|日曜|祝日|土日/.test(text) && /電話|あぷり/.test(text) && /予約|受付|受け付/.test(text);
}

function bookingArea(wording: string, source?: SourceRecord) {
  if (!source || !asksBookingSchedule(wording) || !normalize(wording).includes("いぐばす")) return undefined;
  const area = /^([^。]+?)周辺は、日曜日を含め毎日運行する「([^」]+)」のエリア。/.exec(source.text);
  if (area && normalize(wording).includes(normalize(area[1]))) {
    return { name: area[2], sentence: `${area[1]}周辺は、通常は毎日運行する「${area[2]}」のエリアです。` };
  }
}

function omitUnaskedDailySchedule(answer: string, wording: string) {
  const timing = /営業|開館|休館|閉館|開[いくきけ]|休み|定休日|何時|いつ|何曜日|日中|午前|午後|夕方|今から|今朝|今夜|今日|本日|明日|当日|きょう|あした|現在|平日|休日|週末|祝日|[月火水木金土日]曜|\d+[月日時]/;
  if (timing.test(normalize(wording))) return answer;
  return [...sentences.segment(answer)].filter(({ segment }) => {
    const dated = /(?:本日|今日|明日)(?:は|の|も|[（(、])/.test(segment);
    const operating = /営業|開館|休館|閉館|開店|閉店|休業/.test(segment);
    const hours = /(?:営業|開館|閉館|開店|閉店)時間|休館日|定休日/.test(segment);
    return !hours && (!dated || !operating);
  }).map(({ segment }) => segment).join("").trim();
}

export function makeDecider(model: string, timeoutMs?: number): Decider {
  const decide: Decider = async (state, actions, signal, onContent) => {
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
    const normalizedWording = normalize(wording);
    const checkConstraints = !state.collection_hints && hasUseConstraint(wording);
    const applyThreshold = /\d+\s*(?:人|名|歳|か月|ヶ月)(?:で|と|に|の|以上|未満)|(?:小学|中学|高校)\d年/.test(normalizedWording);
    const missingRequirement = /(?:用意|準備|持参|提示|提出)できな(?:い|く)/.test(normalizedWording);
    const asksReservation = /予約(?:が|は)?(?:必要|必須|いり|いる)|要予約/.test(normalizedWording);
    const stream = checkConstraints ? undefined : onContent;
    const finalWithEvidence = actions.includes("answer") && !actions.includes("search");
    const sectioned = state.answer_layout && !regularClosingQuestion(wording) && actions.includes("answer");
    const properties = {
      action: { type: "string", enum: actions },
      target: { type: "string", enum: [
        ...TARGETS.filter((target) => !state.collection_excluded || target !== "collection_calendars"),
        ...(expandable?.length ? ["source_details"] : []),
      ] },
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
      ...(sectioned ? {
        sections: { type: "array", maxItems: 4, items: {
          type: "object", properties: {
            label: { type: "string" }, text: { type: "string" }, source_ids: sources,
          }, required: ["label", "text", "source_ids"], additionalProperties: false,
        } },
      } : {}),
    };
    const instructions = [
      INSTRUCTIONS, TOOL_INSTRUCTIONS, ...(checkConstraints ? [CONSTRAINT_INSTRUCTIONS] : []),
      ...(state.search_wording ? [SEARCH_WORDING_INSTRUCTIONS] : []),
      ...(state.quoted_subject ? ["quoted_subject は質問された固有名です。この名称や確認済みの別名が出る資料を探します。異なる名称の資料から創刊日、公開年、料金などを転用しません。"] : []),
      ...(state.resolved_name ? ["resolved_name は資料検索に使った正式表記です。資料で同じ対象を確認できたら、回答の最初に正式表記を書きます。"] : []),
      ...(state.evidence_review ? ["evidence_review は取得済みの資料の照合結果です。source_ids は資料候補、excerpts は質問の条件に対応する資料の原文です。回答するときは質問された用件それぞれと、結論を左右する条件を原文と照合し、使った資料IDを挙げます。missing_fact と query があり、質問の重要な項目が観察から確認できず、検索枠が残っていれば、そこに絞って追加検索します。"] : []),
      ...(state.requested_event_year ? ["requested_event_year は利用者が尋ねた開催年です。例年の時期や別の年の予定から開催日を決めず、指定年の資料で会場や日付を確認します。period は資料の対象期間です。"] : []),
      ...(state.requested_event_after ? ["requested_event_after は次回の開催を確認する基準日です。対象の行事がその日以降に開かれることを資料で確認します。過去の開催日や例年の時期を次回の日程として使いません。"] : []),
      ...(state.reference_question ? ["reference_question は、当日・将来の状況とは別に尋ねられた通常時の項目です。通常時の資料を先に探し、確認できたことを action=answer で出典とともに答えます。answer は reference_question の項目と適用条件だけを一文で答えます。閉館時刻なら開館時刻、売店、駐車場、道路休憩施設の案内は省きます。sources にはその時刻や料金が載っている資料IDだけを入れます。混雑見込みや確認できない旨は書きません。当日・将来の状況を確認できない旨はアプリが表示します。"] : []),
      ...(sectioned ? [
        "質問された項目ごとに、短い見出し label、質問に答える短い本文 text、直接の根拠に使う取得済み資料ID source_ids を sections に入れます。結論に必要な項目を省略せず、聞かれていない情報は入れません。資料に複数の対象が出るときは、対象と操作の関係を保ちます。例えば「AとBを本体から外す」を「AからBを外す」に変えません。資料IDは項目に最も直接対応するものを一つ選び、別の条件に別資料が必要なときだけ複数選びます。各 section の source_ids の和集合を sources に入れます。検索や聞き返しでは sections を空配列にします。",
        state.answer_layout === "comparison"
          ? "比較では、answer を「通常は〇〇の方が遅く閉まります」のような結論の一文にします。sections に対象ごとの具体的な値と比較に必要な条件を書きます。閉館の比較なら閉館時刻を示し、開館時刻・最終入館・併設店舗・道路休憩施設の案内は尋ねられたときだけ書きます。駅を手がかりに施設を特定した場合は該当する項目に駅との関係とその資料も含めます。比較に必要な資料が足りなければ検索し、検索時の answer は空文字にします。"
          : "別々の用件を sections に分けます。answer には各用件の結論だけを短く入れます。",
      ] : []),
      ...(state.round_trip_counts ? ["round_trip_counts は利用者が示した往復回数を片道回数に換算した結果です。資料の上限が片道単位なら換算後の回数に、追加分を足して上限と比べます。"] : []),
      ...(applyThreshold ? ["資料の人数や年齢の境目に利用者の条件を当てはめ、適用される区分を資料の表記で伝えます。団体料金の人数に満たない場合は、資料にあれば1人あたりの通常料金も金額で示します。代替の制度は、その利用条件まで確認できる資料があるときに案内します。"] : []),
      ...(missingRequirement ? ["書類や保証人などの要件を満たせない場合は query に元の手続きの正式名を残し、不足時の手順を探します。通常の要件に加え、代わりの手順や所要日数を確認して案内します。別の手続きの情報は省きます。"] : []),
      ...(asksReservation ? ["予約の要否が質問されています。資料で前日や何日前までの申込みが条件だと確認できた場合は『事前予約が必要です』と先に答え、期限と方法を続けます。"] : []),
      ...(asksBookingSchedule(wording) ? [BOOKING_SCHEDULE_INSTRUCTIONS] : []),
      ...(finalWithEvidence ? ["最後の判断です。回答する場合は、根拠として使う資料IDを一つ以上 sources に入れます。他の行動を選ぶ場合は sources を空配列にします。"] : []),
      ...(state.history ? [HISTORY_INSTRUCTIONS] : []), ...(stream ? [STREAM_INSTRUCTIONS] : []),
    ].join("\n\n");
    const decision = await chatJson({
      model, signal, onContent: stream, timeoutMs,
      messages: [{ role: "system", content: instructions }, { role: "user", content: formatPromptJson(stateForPrompt(state)) }],
      format: {
        type: "object",
        properties: stream ? Object.assign({ action: properties.action, sources, answer: properties.answer }, properties) : properties,
        required: [
          "action", ...(finalWithEvidence ? ["sources"] : []), ...(sectioned ? ["sections"] : []),
          ...(sectioned && state.answer_layout === "comparison" ? ["answer"] : []),
        ],
        additionalProperties: false,
      },
    });
    if (!ACTIONS.some((action) => action === decision.action)) {
      throw new OllamaResponseError("AIから検索や回答に必要な指示を読み取れませんでした。");
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

  decide.reviewEvidence = async ({ question, today, history, follow_up, observations, prior_passages, resolved_name }, signal) => {
    const passages = [...new Map([
      ...(prior_passages ?? []),
      ...observations.flatMap((observation) => observation.passages),
    ].map((passage) => [passage.id, passage])).values()];
    const byId = new Map(passages.map((passage) => [passage.id, passage]));
    const wording = question + " " + (follow_up?.reply ?? "");
    const reviewDates = asksCollectionDate(wording);
    const notes = [EVIDENCE_REVIEW_INSTRUCTIONS];
    if (asksBookingSchedule(wording)) notes.push(BOOKING_SCHEDULE_INSTRUCTIONS);
    if (resolved_name) notes.push("登録済みの名称だけを尋ねられた場合は、その名称で確認できる概要を照合します。同名の資料が複数あれば、確認できる意味ごとに扱います。");
    const review = await chatJson({
      model, signal, timeoutMs: Math.min(timeoutMs ?? EVIDENCE_REVIEW_TIMEOUT, EVIDENCE_REVIEW_TIMEOUT),
      messages: [
        { role: "system", content: notes.join("\n") },
        { role: "user", content: formatPromptJson({ question, today, history, follow_up, passages }) },
      ],
      format: {
        type: "object",
        properties: {
          source_ids: { type: "array", items: { type: "string", enum: [...byId.keys()] } },
          excerpts: { type: "array", maxItems: 3, items: {
            type: "object", properties: {
              source_id: { type: "string", enum: [...byId.keys()] }, text: { type: "string" },
            }, required: ["source_id", "text"], additionalProperties: false,
          } },
          missing_fact: { type: "string" }, query: { type: "string" },
        },
        required: ["source_ids"], additionalProperties: false,
      },
    });
    if (!Array.isArray(review.source_ids)) throw new OllamaResponseError("AIから資料の確認結果を読み取れませんでした。");
    const sourceIds = [...new Set(review.source_ids.filter((id): id is string => typeof id === "string" && byId.has(id)))];
    const excerpts = Array.isArray(review.excerpts) ? review.excerpts.slice(0, 3).flatMap((value) => {
      if (!isObject(value)) return [];
      const source_id = trimString(value.source_id);
      const text = trimString(value.text);
      return sourceIds.includes(source_id) && text.length >= 8 && text.length <= 140 &&
        byId.get(source_id)?.text.includes(text) ? [{ source_id, text }] : [];
    }) : [];
    const confirmed = { source_ids: sourceIds, ...(excerpts.length ? { excerpts } : {}) };
    const missing = trimString(review.missing_fact);
    const query = trimString(review.query);
    const noGap = /^(?:(?:特に)?(?:なし|無し|ありません)|不要|該当なし|none|null|n\/a)[。.]?$/i;
    const unaskedCollectionDate = !reviewDates && COLLECTION_DATE.test(normalize(missing));
    return missing && query && !unaskedCollectionDate && !noGap.test(missing) && !noGap.test(query) && [...query].length <= 400
      ? { ...confirmed, missing_fact: [...compactText(missing)].slice(0, 60).join(""), query }
      : confirmed;
  };
  return decide;
}

const COLLECTION_DATE = /収集日|収集予定|回収日|収集.*日程|ごみ.*日程|ごみの日/;
const EXCLUDED_COLLECTION_DATE = /(?:収集日(?:程)?|回収日|ごみの日)(?:の質問)?(?:では(?:なく|ありませ(?:ん)?|ない)|は(?:聞いてい|知りたく)ない|以外)/g;
const WASTE_PROCEDURE = /(?:申[し込]|予約|受付).{0,24}(?:締[め切]|期限|何日まで|いつまで|何時まで|方法|どう)|分別(?:方法|を確認|を知|を教)|分け方|出し方/;
const LIVE_STATUS = /混雑|行列|並ん|待ち時間|空席|空き|予約が取れ|運休|臨時|遅れ|開設/;

function asksCollectionDate(text: string) {
  const query = normalize(text).replace(EXCLUDED_COLLECTION_DATE, "");
  if (COLLECTION_DATE.test(query)) return true;
  if (WASTE_PROCEDURE.test(query)) return false;
  if (/創刊|発行|刊行|出版/.test(query) && !/ごみ|収集|回収|出[すせ]|捨て|処分/.test(query)) return false;
  return (/ごみ|ぺっとぼとる|蛍光灯/.test(query) || namedWasteTypes(query).length > 0) &&
    /今日|(?<!とう)きょう|明日|あした|次回|次の|つぎの|何日|何曜日|[0-9]+月|いつ(?!までに)/.test(query);
}

function collectionHints(wording: string[], district = mentionedDistrict(wording)?.district): CollectionHints {
  for (const phrase of wording) {
    const types = namedWasteTypes(phrase);
    if (types.length) return { district, waste_types: types };
  }
  // 「地区のごみ収集日」のように全区分を尋ねている場合にだけ空配列を指定する。
  const allTypes = wording.some((phrase) =>
    /(?:^|の|で)(?:次(?:の|回の))?ごみ(?:の?収集日|の日|はいつ)/.test(normalize(phrase)));
  return { district, ...(allTypes ? { waste_types: [] } : {}) };
}

function hasUseConstraint(wording: string) {
  return /以外|いがい(?:で|の)|を除[くい]|抜きで|が使えない|できない場合/u.test(normalize(wording));
}

function answerLayout(wording: string): TurnState["answer_layout"] {
  const text = normalize(wording);
  if (hasUseConstraint(text)) return undefined;
  if (/どちら.{0,20}(?:遅|早|安|高|近|遠|長|短)|どっち.{0,20}(?:遅|早|安|高|近|遠|長|短)|比較|比べ/.test(text)) return "comparison";
  if (!/と|および|あわせて|併せて|それに|(?:\?.*\?|また|それと)/s.test(text)) return undefined;
  const topics = [
    /料金|入館料|入場料|いくら|運賃/,
    /開館|閉館|営業時間|何時まで|最終入館/,
    /休館日|定休日|何曜日/,
    /行き方|アクセス|徒歩|最寄り/,
    /出し方|分別|どう出/,
  ];
  return topics.filter((topic) => topic.test(text)).length >= 2 ? "multiple" : undefined;
}

function referenceQuestion(question: string) {
  const text = normalize(question);
  if (!/今日|きょう|明日|あした|明後日|あさって|今朝|今夜|現在|当日|今[、の]|午[前後]/.test(text) || !LIVE_STATUS.test(text)) return undefined;
  const reference = /(?:通常|一般|普段)(?:時|の)?[^、。?\n]{0,16}(?:料金|入館料|開館時間|営業時間|閉館時刻|予約締切|受付時間|運行時刻)/.exec(text)?.[0];
  if (!reference) return undefined;
  const status = /混雑|行列|並ん|待ち時間/.test(text) ? "混雑や待ち時間" :
    /空席|空き|予約が取れ/.test(text) ? "空き状況" : "臨時の変更や当日の状況";
  return { reference, notice: `ご指定の日時の${status}は、登録資料からは確認できません。` };
}

function citationSources(decision: Record<string, unknown>, evidence: ReadonlyMap<string, SourceRecord>, wording: string) {
  if (!knownSourceIds(decision.sources, evidence)) return [];
  const sources = [...new Set(decision.sources)].map((id) => evidence.get(id)!);
  const station = /([\p{Script=Han}\p{Script=Katakana}]+駅)が最寄り/u.exec(wording)?.[1];
  if (station && /どちら|比較|比べ/.test(wording)) {
    const isAccess = (record: SourceRecord) => record.text.slice(0, EXCERPT_LIMIT).includes(station) &&
      /徒歩|隣接|最寄り/.test(record.text.slice(0, EXCERPT_LIMIT));
    const access = [...evidence.values()].find((record) => isAccess(record) && sources.some(({ url }) => url === record.url));
    if (access && !sources.some(isAccess)) sources.push(access);
  }
  return sources;
}

function formatPresentation(presentation: AnswerPresentation) {
  return [presentation.conclusion, ...presentation.sections.map(({ label, text }) =>
    `${label}\n${text}`)].filter(Boolean).join("\n\n");
}

function omitUnaskedClosingDetails(text: string, wording: string) {
  if (!/閉館時刻|閉館時間|[遅早]く閉|[遅早]くまで開/.test(wording)) return text;
  const auxiliary = /(?:最終入館|ラストオーダー|レストラン|併設店舗|道路休憩施設|テイクアウト)/g;
  return [...sentences.segment(text)].filter(({ segment }) =>
    [...segment.matchAll(auxiliary)].every(([term]) => wording.includes(term))).map(({ segment }) => segment).join("").trim();
}

function readSections(value: unknown, evidence: ReadonlyMap<string, SourceRecord>, comparisonWording?: string) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) return undefined;
  const sections: { label: string; text: string; sourceIds: string[] }[] = [];
  const labels = new Set<string>();
  for (const section of value) {
    if (!isObject(section) || !knownSourceIds(section.source_ids, evidence)) return undefined;
    const label = compactText(trimString(section.label).replace(/^#+\s*/, ""));
    const body = trimString(section.text);
    if (!label || label.length > 60 || !body || body.length > 450 || labels.has(normalize(label))) return undefined;
    const text = comparisonWording ? omitUnaskedClosingDetails(body, comparisonWording) : body;
    if (!text) continue;
    labels.add(normalize(label));
    sections.push({ label, text, sourceIds: [...new Set(section.source_ids)] });
  }
  return sections.length >= 2 ? sections : undefined;
}

function regularClosingQuestion(wording: string) {
  if (!/通常|普段/.test(wording) || LIVE_STATUS.test(normalize(wording)) ||
      /今日|明日|当日|特定|祝日|曜日|連休|休館日|最終入館|レストラン|道路休憩施設|料金|いくら|駐車|行き方|[0-9]+月/.test(wording)) return undefined;
  if (/遅く閉|遅くまで開/.test(wording)) return "later";
  if (/早く閉/.test(wording)) return "earlier";
}

function closingHours(record: SourceRecord) {
  const label = /^(.+)の(?:開館時間|営業時間)(?:・休館日)?$/.exec(record.title)?.[1];
  const range = /通常の(?:開館時間|営業時間)は\s*(\d{1,2}):(\d{2})\s*[〜～~-]\s*(\d{1,2}):(\d{2})/.exec(
    record.text.slice(0, EXCERPT_LIMIT).normalize("NFKC"));
  if (!label || !range) return undefined;
  const [openHour, openMinute, hour, minute] = range.slice(1).map(Number);
  const closing = hour * 60 + minute;
  if (openHour > 23 || openMinute > 59 || hour > 23 || minute > 59 || closing <= openHour * 60 + openMinute) return undefined;
  return { label, time: range[3].padStart(2, "0") + ":" + range[4], closing };
}

function closingComparison(wording: string, evidence: ReadonlyMap<string, SourceRecord>, readSource?: SourceReader) {
  const mentioned = normalize(wording).replace(/\s+/g, "");
  const station = /([\p{Script=Han}\p{Script=Katakana}]+駅)が最寄り/u.exec(wording)?.[1];
  const byFacility = new Map<string, {
    record: SourceRecord; hours: NonNullable<ReturnType<typeof closingHours>>; anchor: SourceRecord; access?: SourceRecord;
  }>();
  for (const anchor of evidence.values()) {
    for (const record of [anchor, ...(readSource?.(anchor) ?? [])]) {
      const hours = closingHours(record);
      if (!hours || byFacility.has(hours.label)) continue;
      const exactName = [hours.label, ...(record.keywords ?? [])].some((name) =>
        name.length >= 3 && mentioned.includes(normalize(name).replace(/\s+/g, "")));
      const access = station && [...evidence.values()].find((item) =>
        item.url === record.url && item.text.slice(0, EXCERPT_LIMIT).includes(station) &&
        /徒歩|隣接|最寄り/.test(item.text.slice(0, EXCERPT_LIMIT)));
      if (exactName || access) byFacility.set(hours.label, { record, hours, anchor, access: access || undefined });
    }
  }
  return byFacility.size === 2 ? [...byFacility.values()] : undefined;
}

function referenceAnswer(answer: string) {
  return [...sentences.segment(answer)].map(({ segment }) => {
    if (!LIVE_STATUS.test(normalize(segment))) return segment;
    const separator = /(?:(?:です|ます)(?:が|けれど)?[、，]?|ものの[、，]?|[、，])\s*(?=(?:今日|きょう|明日|あした|明後日|あさって|当日|現在|混雑|行列|空席|空き|待ち時間|予約状況))/.exec(segment);
    if (!separator) return "";
    const firstClause = segment.slice(0, separator.index).trim();
    if (LIVE_STATUS.test(normalize(firstClause)) || !/(?:料金|円|時[刻間]?|まで|締切)/.test(firstClause)) return "";
    const verb = /^(?:です|ます)/.exec(separator[0])?.[0];
    return firstClause + (verb ?? (/です$|ます$/.test(firstClause) ? "" : "です")) + "。\n";
  }).join("").trim();
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
  const { id, title, text, source, checked, published, period } = record;
  const excerpt = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
  return { id, title, text: excerpt, source, checked, published, period, ...(excerpt.length < text.length ? { truncated: true } : {}) };
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
  pending, history, signal, searchMode = "hybrid", readSource, resolveName, checkpoint, today = todayInTokyo(), onProgress, onDelta, onAction,
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
  const namedSubject = !pending ? resolveName?.(state.question) ?? resolveName?.(searchQuestion) : undefined;
  const searchReply = pending ? normalizeQuery(reply) : reply;
  if (searchQuestion !== state.question || searchReply !== reply) {
    state.search_wording = {
      question: searchQuestion !== state.question ? searchQuestion : undefined,
      reply: searchReply !== reply ? searchReply : undefined,
    };
  }
  const wording = pending ? [searchReply, searchQuestion] : [searchQuestion];
  const queryText = wording.join("\n");
  let calendarQuestion = pending?.field === "district" || asksCollectionDate(queryText);
  const eventYear = !calendarQuestion ? requestedEventYear(queryText, today) : undefined;
  state.requested_event_year = eventYear;
  const eventAfter = !calendarQuestion && (!eventYear || eventYear >= Number(today.slice(0, 4))) &&
    asksForUpcomingEvent(queryText) ? today : undefined;
  state.requested_event_after = eventAfter;
  const repeatedQuestion = !pending && history?.some((turn) => normalize(turn.question) === normalize(question));
  if (!calendarQuestion && (WASTE_PROCEDURE.test(normalize(queryText)) || COLLECTION_DATE.test(normalize(queryText)))) {
    state.collection_excluded = true;
  }
  const subject = calendarQuestion ? undefined : quotedSubject(state.question) ?? (pending ? quotedSubject(reply) : undefined);
  const canonical = subject && (resolveName?.(subject) ?? resolveName?.(normalizeQuery(subject)));
  const requiresSubjectEvidence = Boolean(subject || eventYear || eventAfter);
  state.quoted_subject = subject;
  state.resolved_name = namedSubject;
  const mixedQuestion = referenceQuestion(queryText);
  state.reference_question = mixedQuestion?.reference;
  if (!calendarQuestion && !mixedQuestion) state.answer_layout = answerLayout(queryText);
  const closingOrder = state.answer_layout === "comparison" ? regularClosingQuestion(queryText) : undefined;
  if (queryText.includes("片道")) {
    const counts = [...queryText.matchAll(/(?:^|[^\d.])(\d{1,6})\s*往復/g)]
      .map(([, count]) => `${count}往復は片道${Number(count) * 2}回`);
    if (counts.length) state.round_trip_counts = counts;
  }

  function matchesSubject(record: SourceRecord) {
    if (!subject) return true;
    const excerpt = record.text.slice(0, exposedLengths.get(record.id) ?? EXCERPT_LIMIT);
    return [record.title, ...(record.names ?? []), excerpt].some((text) =>
      mentionsSubject(text, subject) || Boolean(canonical && mentionsSubject(text, canonical)));
  }

  function supportsRequestedSubject(record: SourceRecord) {
    const length = exposedLengths.get(record.id) ?? EXCERPT_LIMIT;
    return matchesSubject(record) && (!eventYear || documentsEventYear(record, eventYear, length)) &&
      (!eventAfter || documentsUpcomingEvent(record, eventAfter, length));
  }

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

  const certificateQuestion = normalize(searchQuestion);
  if (!pending && !history?.length && /証明書/.test(certificateQuestion) && /代理|委任状|代わり/.test(certificateQuestion) &&
      /受け取|受取|交付|請求/.test(certificateQuestion) && !/戸籍|住民票|印鑑|所得|課税|納税|税証明|資産|身分証明|転出証明/.test(certificateQuestion)) {
    onAction?.({ action: "clarify" });
    return clarify("どの証明書を受け取る予定ですか？ 住民票の写しや戸籍、税証明など、種類を教えてください。", "condition");
  }

  let directCalendarTypes: WasteType[] | undefined;
  if (calendarQuestion) {
    let dates: ReturnType<typeof explicitCollectionDates>;
    try {
      dates = explicitCollectionDates(wording);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      onAction?.({ action: "insufficient" });
      return { action: "insufficient", answer: INVALID_COLLECTION_DATE, sources: [], pending: null };
    }
    if (dates && !hasCollectionYear(fiscalYear(dates[0]))) {
      onAction?.({ action: "insufficient" });
      return { action: "insufficient", answer: NO_COLLECTION_DATES, sources: [], pending: null };
    }
    const district = mentionedDistrict(wording);
    if (district && district.choices.length > 1) {
      onAction?.({ action: "clarify" });
      return clarify(`「${district.district}」には複数の収集区分があります。区番号や、ごみステーションの目印を教えてください。`, "district", district.district);
    }
    if (!pending && dates && district) directCalendarTypes = collectionMonthTypes(searchQuestion, district.district);
    state.collection_hints = directCalendarTypes
      ? { district: district?.district, waste_types: directCalendarTypes }
      : collectionHints(wording, district?.district);
  }

  const previous = new Map<string, LookupResult>();
  let ambiguity: AmbiguousDistrict | undefined;
  let searches = 0;
  let searchDetail: string | undefined;
  let insufficientReason: unknown;
  let referenceOnly: string | undefined;
  let retriedResponse = false;
  let reviewedEvidence = false;

  for (let step = 0; step < MAX_DECISIONS; step++) {
    signal?.throwIfAborted();
    const subjectObserved = !requiresSubjectEvidence || [...evidence.values()].some(supportsRequestedSubject);
    const canClarifyDistrict = calendarQuestion && !state.collection_hints?.district;
    const canClarifyCondition = !calendarQuestion && !pending && !namedSubject && subjectObserved;
    const needsSearch = step === 0 && !calendarQuestion && (repeatedQuestion || namedSubject || requiresSubjectEvidence || state.reference_question);
    const actions: Action[] = needsSearch ? [] : ["insufficient"];
    if (!needsSearch && (canClarifyDistrict || canClarifyCondition)) actions.unshift("clarify");
    if (evidence.size && subjectObserved) actions.push("answer");
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
    const area = bookingArea(queryText, evidence.get("md-igu-bus"));
    const stream = onDelta && actions.includes("answer") && !calendarQuestion && !mixedQuestion && !state.answer_layout && !area
      ? streamGroundedAnswer(evidence, onDelta, requiresSubjectEvidence ? supportsRequestedSubject : undefined) : undefined;
    const decisionState = referenceOnly
      ? { ...state, question: referenceOnly, follow_up: undefined, search_wording: undefined }
      : state;
    if (!reviewedEvidence && decide.reviewEvidence && actions.includes("answer")) {
      reviewedEvidence = true;
      try {
        const review = await decide.reviewEvidence(decisionState, signal);
        decisionState.evidence_review = review;
        onAction?.({ action: "review", status: "checked", source_ids: review.source_ids, missing_fact: review.missing_fact });
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof OllamaError)) throw error;
        onAction?.({ action: "review", status: "unavailable", source_ids: [] });
      }
    }
    const compared = closingOrder ? closingComparison(queryText, evidence, readSource) : undefined;
    if (compared?.every(({ record }) => evidence.has(record.id) && supportsRequestedSubject(record))) {
      const [first, second] = compared;
      const wantLater = closingOrder === "later";
      const winner = (wantLater ? first.hours.closing > second.hours.closing : first.hours.closing < second.hours.closing) ? first : second;
      const conclusion = first.hours.closing === second.hours.closing ? "通常の閉館時刻は同じです。" :
        `通常は${winner.hours.label}の方が${wantLater ? "遅く" : "早く"}閉まります。`;
      const sources: SourceRecord[] = [];
      const presentation = { conclusion, sections: compared.map(({ hours, record, access }) => {
        const sourceIndexes = [sources.length];
        sources.push(record);
        let text = `通常の閉館は${hours.time}です。`;
        if (access) {
          sourceIndexes.push(sources.length);
          sources.push(access);
          const route = [...sentences.segment(access.text.slice(0, EXCERPT_LIMIT))]
            .map(({ segment }) => segment.trim()).find((line) => line.includes("駅") && /徒歩|隣接|最寄り/.test(line));
          if (route) text += ` ${route}`;
        }
        return { label: hours.label, text, sourceIndexes };
      }) };
      onAction?.({ action: "answer" });
      return { action: "answer", answer: formatPresentation(presentation), presentation, sources, pending: null };
    }
    const missingHours = compared?.find(({ record }) => !evidence.has(record.id));
    let decision: Awaited<ReturnType<Decider>>;
    const directCalendarSearch = step === 0 && directCalendarTypes !== undefined;
    if (directCalendarSearch) {
      decision = { action: "search", target: "collection_calendars" };
    } else if (missingHours && actions.includes("search") && state.expandable_source_ids?.includes(missingHours.anchor.id)) {
      decision = {
        action: "search", target: "source_details", source_id: missingHours.anchor.id,
        query: "通常の開館時間・閉館時刻", missing_fact: missingHours.hours.label + "の閉館時刻",
      };
    } else if (compared) {
      decision = { action: "insufficient", reason: "missing_evidence" };
    } else {
      try {
        decision = await decide(decisionState, actions, signal, stream);
      } catch (error) {
        if (!(error instanceof OllamaResponseError) || retriedResponse) throw error;
        signal?.throwIfAborted();
        retriedResponse = true;
        onProgress?.(state.observations.length ? "reviewing" : "planning", searchDetail);
        decision = await decide(decisionState, actions, signal);
      }
    }

    const action = actions.find((allowed) => allowed === decision.action);
    if (!action) break;

    if (action === "search") {
      state.evidence_review = undefined;
      const target = decision.target === "collection_calendars" && state.collection_excluded
        ? "official_documents" : decision.target;
      let searchDecision = target === decision.target ? decision : { ...decision, query: searchQuestion };
      if (target === "official_documents" && !state.observations.length) {
        const query = trimString(searchDecision.query);
        if (namedSubject) searchDecision = { ...searchDecision, query: namedSubject };
        else if (subject && !mentionsSubject(query, subject) && !(canonical && mentionsSubject(query, canonical))) {
          searchDecision = { ...searchDecision, query: `${canonical ?? subject} ${searchQuestion}` };
        }
      }
      const event: SearchEvent = { action, target, status: "invalid", source_ids: [] };
      const missing = trimString(decision.missing_fact);
      if (missing) event.missing_fact = [...compactText(missing)].slice(0, 60).join("");
      if (event.target === "collection_calendars") {
        calendarQuestion = true;
        state.collection_hints ??= collectionHints(wording);
      }
      const search = event.target === "source_details"
        ? configureDetailSearch(event, searchDecision, state, readSource, evidence, exposedLengths)
        : configureSearch(event, searchDecision, today, wording, state.collection_hints, retrieve, state.search_strategies, signal);
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
            found = { ...result, records: result.records.filter((record) =>
              !record.period?.through || ((!eventYear || documentsEventYear(record, eventYear, EXCERPT_LIMIT)) &&
                (!eventAfter || documentsUpcomingEvent(record, eventAfter, EXCERPT_LIMIT)))).map((record) =>
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
      if (directCalendarSearch && hits[0]?.calendar_answer) {
        signal?.throwIfAborted();
        onAction?.({ action: "answer" });
        return { action: "answer", answer: hits[0].calendar_answer, sources: hits, pending: null };
      }
      state.observations.push({ ...event, passages });
      continue;
    }

    if (action === "insufficient" && decision.reason === "live_information" && mixedQuestion &&
        !referenceOnly && step + 1 < MAX_DECISIONS) {
      const observed = state.observations.find(({ target, status, query }) =>
        target === "official_documents" && status === "found" && query && !LIVE_STATUS.test(normalize(query)));
      if (observed?.query) {
        referenceOnly = `${observed.query}。${mixedQuestion.reference}を資料から教えてください。`;
        continue;
      }
    }

    onAction?.({ action });
    const answer = trimString(decision.answer);
    const sections = action === "answer" && !calendarQuestion && !area && state.answer_layout
      ? readSections(decision.sections, evidence, state.answer_layout === "comparison" ? queryText : undefined) : undefined;
    const citation = sections ? { sources: sections.flatMap(({ sourceIds }) => sourceIds) } : decision;
    const sources = citationSources(citation, evidence, wording.join("\n"));
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
      if ((answer || sections) && !calendarQuestion && sources.some(supportsRequestedSubject)) {
        const scopedAnswer = area && sources.some(({ id }) => id === "md-igu-bus") && !answer.includes(area.name)
          ? `${area.sentence}\n\n${answer}` : answer;
        if (mixedQuestion) {
          const confirmed = omitUnaskedClosingDetails(referenceAnswer(scopedAnswer), queryText);
          if (!confirmed) break;
          const presentation: AnswerPresentation = { sections: [
            { label: mixedQuestion.reference, text: confirmed, sourceIndexes: sources.map((_, index) => index) },
            { label: "確認できない情報", text: mixedQuestion.notice, sourceIndexes: [] },
          ] };
          return { action, answer: formatPresentation(presentation), presentation, sources, pending: null };
        }
        const conclusion = state.answer_layout === "comparison" && sections
          ? sentences.segment(scopedAnswer).containing(0)?.segment.trim() || undefined : undefined;
        const presentation: AnswerPresentation | undefined = sections && {
          ...(conclusion ? { conclusion } : {}),
          sections: sections.map(({ label, text, sourceIds }) => ({
            label, text, sourceIndexes: sourceIds.map((id) => sources.findIndex((source) => source.id === id)),
          })),
        };
        return { action, answer: presentation ? formatPresentation(presentation) : scopedAnswer,
          ...(presentation ? { presentation } : {}), sources, pending: null };
      }
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
    : subject ? `「${subject}」について、登録した資料からは回答の根拠を確認できませんでした。`
    : NO_EVIDENCE;
  return { action: "insufficient", answer, sources: [], pending: null };
}
