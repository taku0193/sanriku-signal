import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { GuideResult, StreamEvent } from "../frontend/types.js";
import { AmbiguousDistrict, collectionBounds, findCollectionDays, todayInTokyo } from "../server/calendars.js";
import { makeRetriever } from "../server/embeddings.js";
import { OllamaError } from "../server/ollama.js";
import { runTurn, streamGroundedAnswer } from "../server/react.js";
import { loadRecords } from "../server/records.js";
import { createGuideServer, readHistory } from "../server/web.js";

const records = loadRecords();
const keyword = makeRetriever(records, "keyword");
const searchMuseum = { action: "search", target: "official_documents", query: "鯨と海の科学館 入館料", missing_fact: "科学館の入館料" };

test("Unicodeの本文は取得済みの資料IDを確認した後にだけ流す", () => {
  const evidence = new Map([["museum-fees", true]]);
  const deltas: string[] = [];
  const stream = streamGroundedAnswer(evidence, (text) => deltas.push(text));
  stream('{"action":"answer","sources":["unseen"],"answer":"誤った引用"}');
  assert.deepEqual(deltas, []);
  const answer = '入館料は「300円」です。\n記号 " と 🐋';
  const payload = JSON.stringify({ action: "answer", sources: ["museum-fees"], answer }).replace("🐋", "\\ud83d\\udc0b");
  for (let i = 0; i <= payload.length; i++) stream(payload.slice(0, i));
  assert.equal(deltas.join(""), answer);
  assert.ok(deltas.length > 1);
});

test("検索上限を守り、再送した検索条件を使い回して未取得の出典を拒否する", async () => {
  const events: string[] = [];
  let decisions = 0, searches = 0;
  const result = await runTurn("料金は？", async (_state, actions) => {
    decisions++;
    if (decisions <= 2) return searchMuseum;
    assert.ok(!actions.includes("search"));
    return { action: "answer", answer: "根拠のない文", sources: ["unseen"] };
  }, async (query) => {
    searches++;
    return keyword(query);
  }, { history: readHistory([{ question: "科学館はどこ？", answer: "船越です。" }]),
    onAction: (event) => events.push(event.action === "search" ? event.status : event.action) });
  assert.equal(decisions, 3);
  assert.equal(searches, 1);
  assert.deepEqual(events, ["found", "reused", "answer"]);
  assert.equal(result.action, "insufficient");
  assert.deepEqual(result.sources, []);
});

test("日本時間と日程表を照合し、複数地区に当てはまる呼び名を聞き返せる", () => {
  assert.equal(todayInTokyo(new Date("2026-11-19T15:01:00Z")), "2026-11-20");
  const bounds = collectionBounds({}, "2026-11-20", ["北浜のごみの日"]);
  assert.throws(() => findCollectionDays("山田1", bounds, ["burnable"], ["北浜のごみの日"]), AmbiguousDistrict);
  const december = collectionBounds({}, "2026-11-20", ["大沢の2026年12月のプラスチック収集日は？"]);
  assert.deepEqual(december, { year: 2026, start: "2026-12-01", end: "2026-12-31" });
  const hit = findCollectionDays("大沢", december, ["plastic"], ["大沢の2026年12月のプラスチック収集日は？"])[0];
  assert.equal(hit.id, "calendar-2026-osawa");
  assert.match(hit.calendar_answer!, /2026年12月8日（火）.*2026年12月25日（金）/);
});

test("HTTPで動画の部分配信とNDJSONの回答を返す", async (context) => {
  const server = createGuideServer({
    records, retrieval: "keyword", decide: async (state, _actions, _signal, onContent) => {
      if (state.question.includes("大沢")) {
        return state.observations.length ? { action: "answer", sources: ["calendar-2026-osawa"], answer: "未照合の日付" } : {
          action: "search", target: "collection_calendars", district: "大沢", waste_types: ["plastic"],
        };
      }
      if (!state.observations.length) return searchMuseum;
      const result = { action: "answer", sources: ["museum-fees"], answer: "大人300円です。" };
      onContent?.(JSON.stringify(result));
      return result;
    },
  }).listen(0, "127.0.0.1");
  context.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  await once(server, "listening");
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const video = await fetch(root + "/sanriku-coast.mp4", { headers: { Range: "bytes=0-1" } });
  assert.equal(video.status, 206);
  assert.match(video.headers.get("content-range")!, /^bytes 0-1\/\d+$/);
  assert.equal((await video.arrayBuffer()).byteLength, 2);
  const invalidRange = await fetch(root + "/sanriku-coast.mp4", { headers: { Range: "bytes=-0" } });
  assert.equal(invalidRange.status, 416);
  await invalidRange.arrayBuffer();

  const response = await fetch(root + "/api/ask", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify({ question: "鯨と海の科学館の入館料は？" }),
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as StreamEvent);
  assert.ok(events.some((event) => event.type === "progress" && event.detail === "科学館の入館料"));
  assert.ok(events.some((event) => event.type === "delta" && event.text === "大人300円です。"));
  const last = events.at(-1);
  assert.equal(last?.type, "result");
  if (last?.type === "result") {
    assert.equal(last.data.sources[0].url, "https://yamada-kujirakan.jp/facility/");
    assert.equal(last.data.photos?.[0].src, "/photos/museum.webp");
  }
  const calendarResponse = await fetch(root + "/api/ask", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "大沢の2026年12月のプラスチック収集日は？" }),
  });
  const calendar = await calendarResponse.json() as GuideResult;
  assert.equal(calendar.action, "answer");
  assert.match(calendar.answer, /12月8日（火）.*12月25日（金）/);
  assert.equal(calendar.sources[0].url, undefined);
});

test("埋め込み索引なしでも資料を検索でき、モデル切断時は保留中の質問を返す", async (context) => {
  const hybrid = makeRetriever(records, "hybrid", new URL("file:///dev/null/embeddings-cache.json"));
  const fallback = await hybrid("鯨と海の科学館の入館料は？");
  assert.equal(fallback.mode, "keyword_fallback");
  assert.equal(fallback.records[0].id, "museum-fees");

  const server = createGuideServer({
    records, retrieval: "keyword", decide: async () => { throw new OllamaError("テスト"); },
  }).listen(0, "127.0.0.1");
  context.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ask`;
  const pending = { question: "粗大ごみの予約方法は？", field: "district", prompt: "地区名を教えてください。" };
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "大沢", pending }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.mode, "search");
  assert.deepEqual(result.pending, pending);
  assert.match(result.notice, /再試行/);
});
