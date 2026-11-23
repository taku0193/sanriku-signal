import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { makeRetriever } from "../server/embeddings.js";
import type { SearchStrategy } from "../server/embeddings.js";
import { readJsonFile } from "../server/files.js";
import { DEFAULT_MODEL } from "../server/ollama.js";
import { makeDecider, runTurn } from "../server/react.js";
import { loadRecords, makeSourceReader } from "../server/records.js";
import { makeNameResolver } from "../shared/knowledge.js";

interface Expectations {
  question: string;
  required_patterns: string[];
  forbidden_patterns?: string[];
  required_sources: Record<string, string>;
  one_of_sources?: Record<string, string>;
  source_urls?: string[][];
  action?: string;
  first_action?: string;
}

interface AnswerCase extends Expectations {
  id: string;
  react?: Partial<Expectations> & { as_of?: string; follow_up?: Expectations };
}

interface RetrievalCase {
  id: string;
  question: string;
  expected_sources: string[][];
}

const { values } = parseArgs({
  options: { model: { type: "string", default: DEFAULT_MODEL }, case: { type: "string" },
    output: { type: "string" }, suite: { type: "string", default: "standard" } },
});
if (values.suite !== "standard" && values.suite !== "field") throw new Error("評価セットは standard または field を指定してください。");
const questions = readJsonFile<AnswerCase[]>(values.suite === "field" ? "evaluation/field-questions.json" : "evaluation/questions.json")
  .filter(({ id }) => !values.case || id === values.case);
if (!questions.length) throw new Error(`評価質問が見つかりません。${values.case}`);

const records = loadRecords();
const retrieve = makeRetriever(records, "hybrid");
const decide = makeDecider(values.model);
const readSource = makeSourceReader(records);
const resolveName = makeNameResolver(records);

async function evaluateRetrieval() {
  const cases = readJsonFile<RetrievalCase[]>("evaluation/retrieval_cases.json");
  const strategies: SearchStrategy[] = ["keyword", "semantic", "hybrid"];
  const results = [];
  for (const strategy of strategies) {
    const rows = [];
    for (const item of cases) {
      const started = performance.now();
      const { records: hits, mode } = await retrieve(item.question, undefined, strategy);
      const ids = hits.map(({ id }) => id);
      const passed = mode === strategy && item.expected_sources.every((group) => group.some((id) => ids.includes(id)));
      rows.push({ id: item.id, mode, ids, passed, millis: performance.now() - started });
    }
    console.log(`${strategy} ${rows.filter(({ passed }) => passed).length}/${rows.length}`);
    results.push({ strategy, rows });
  }
  return results;
}

async function evaluateAnswer(item: AnswerCase) {
  const expected = { ...item, ...item.react };
  let previous: Awaited<ReturnType<typeof runTurn>> | undefined;
  const turns = [];
  for (const turn of [expected, ...(expected.follow_up ? [expected.follow_up] : [])]) {
    if (turn !== expected && !previous?.pending) break;
    const actions: object[] = [];
    const chunks: string[] = [];
    let firstAction: string | undefined;
    const started = performance.now();
    try {
      previous = await runTurn(turn.question, decide, retrieve, {
        pending: previous?.pending, checkpoint: previous?.checkpoint, today: expected.as_of, readSource, resolveName,
        onAction: (event) => {
          if (event.action !== "review") firstAction ??= event.action;
          actions.push(event);
        },
        onProgress: () => { chunks.length = 0; },
        onDelta: (text) => chunks.push(text),
      });
    } catch (error) {
      turns.push({ question: turn.question, error: String(error), actions, passed: false, millis: performance.now() - started });
      break;
    }
    const answer = previous.answer.normalize("NFKC").trim().replace(/\s+/g, " ");
    const sources = previous.sources.map(({ id, url }) => ({ id, url }));
    const missingPatterns = turn.required_patterns.filter((pattern) => !new RegExp(pattern, "u").test(answer));
    const forbidden = (turn.forbidden_patterns ?? []).filter((pattern) => new RegExp(pattern, "u").test(answer));
    const expectedSources = Object.entries(turn.required_sources);
    const equivalentSources = Object.entries(turn.one_of_sources ?? {});
    const cited = ([id, url]: [string, string]) => sources.some((hit) => hit.id === id && hit.url === url);
    const missingSources = expectedSources.filter((source) => !cited(source));
    if (equivalentSources.length && !equivalentSources.some(cited)) missingSources.push(...equivalentSources);
    const missingSourceUrls = (turn.source_urls ?? []).filter((alternatives) =>
      !alternatives.some((url) => sources.some((hit) => hit.url && hit.url.split("#")[0] === url.split("#")[0])));
    const expectsSource = expectedSources.length > 0 || equivalentSources.length > 0 || Boolean(turn.source_urls?.length);
    const expectedAction = turn.action ?? (expectsSource ? "answer" : "insufficient");
    const passed = previous.action === expectedAction && (!turn.first_action || firstAction === turn.first_action) &&
      !missingPatterns.length && !forbidden.length && !missingSources.length && !missingSourceUrls.length && (expectsSource || !sources.length) &&
      (!chunks.length || chunks.join("").trimEnd() === previous.answer);
    turns.push({
      question: turn.question, action: previous.action, expectedAction, firstAction, answer: previous.answer,
      sources, actions, missingPatterns, forbidden, missingSources, missingSourceUrls, passed, millis: performance.now() - started,
    });
  }
  const passed = (!expected.follow_up || turns.length === 2) && turns.every((turn) => turn.passed);
  console.log(`${passed ? "合格" : "未達"} ${item.id} ${(turns.reduce((sum, { millis }) => sum + millis, 0) / 1000).toFixed(2)}秒`);
  return { id: item.id, passed, turns };
}

const retrieval = values.case || values.suite === "field" ? [] : await evaluateRetrieval();
const answers = [];
for (const question of questions) answers.push(await evaluateAnswer(question));
const passed = answers.filter((row) => row.passed).length;
console.log(`回答と出典 ${passed}/${answers.length}`);
if (values.output) {
  await writeFile(values.output, JSON.stringify({ model: values.model, records: records.length, retrieval, answers }, null, 2) + "\n");
}
if (passed !== answers.length || retrieval.some(({ strategy, rows }) => rows.some(({ mode }) => mode !== strategy))) {
  process.exitCode = 1;
}
