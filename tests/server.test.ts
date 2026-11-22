import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { GuideResult, StreamEvent } from "../frontend/types.js";
import { AmbiguousDistrict, collectionBounds, findCollectionDays, namedWasteTypes, singleDistrictHint, todayInTokyo } from "../server/calendars.js";
import { makeRetriever } from "../server/embeddings.js";
import type { SearchStrategy } from "../server/embeddings.js";
import { OllamaError } from "../server/ollama.js";
import { makeDecider, runTurn, streamGroundedAnswer } from "../server/react.js";
import { loadRecords, makeSourceReader, NO_EVIDENCE } from "../server/records.js";
import { createGuideServer, readHistory, readPending } from "../server/web.js";

const records = loadRecords();
const keyword = makeRetriever(records, "keyword");
const searchMuseum = { action: "search", target: "official_documents", query: "鯨と海の科学館 入館料", missing_fact: "科学館の入館料" };

test("質問の対象を聞き返し、元の質問と返答を引き継ぐ", async () => {
  const first = await runTurn("料金はいくらですか？", async () => ({
    action: "clarify", field: "condition", answer: "どの施設の料金ですか？",
  }), keyword);
  assert.equal(first.action, "clarify");
  assert.deepEqual(first.sources, []);
  assert.equal(first.pending?.field, "condition");
  assert.throws(() => readPending({ ...first.pending, district_hint: "大沢" }), TypeError);
  const next = await runTurn("鯨と海の科学館です", async (state, actions) => {
    assert.equal(state.question, "料金はいくらですか？");
    assert.equal(state.follow_up?.reply, "鯨と海の科学館です");
    assert.ok(!actions.includes("clarify"));
    return state.observations.length
      ? { action: "answer", answer: "大人300円です。", sources: ["museum-fees"] }
      : searchMuseum;
  }, keyword, { pending: readPending(first.pending) });
  assert.equal(next.answer, "大人300円です。");
  assert.equal(next.sources[0].id, "museum-fees");
  assert.equal(next.pending, null);
});

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

test("再送した検索条件を使い回して未取得の出典を拒否する", async () => {
  const events: string[] = [];
  let decisions = 0, searches = 0;
  const result = await runTurn("料金は？", async (state) => {
    decisions++;
    if (decisions <= 2) return searchMuseum;
    assert.equal(state.remaining_searches, 1);
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

test("3回目の検索結果が最終判断に届き、4回目の検索を拒否する", async () => {
  const budgets: (number | undefined)[] = [];
  const queries: string[] = [];
  const result = await runTurn("山田町の資料を探して", async (state, actions) => {
    budgets.push(state.remaining_searches);
    const number = state.observations.length;
    assert.equal(actions.includes("search"), number < 3);
    if (number === 3) assert.equal(state.observations[2].status, "not_found");
    return { ...searchMuseum, query: `検索語 ${number + 1}` };
  }, async (query) => {
    queries.push(query);
    return { records: [], mode: "keyword" };
  });
  assert.deepEqual(budgets, [3, 2, 1, 0]);
  assert.deepEqual(queries, ["検索語 1", "検索語 2", "検索語 3"]);
  assert.equal(result.action, "insufficient");
});

test("同じ検索語で方式を切り替え、埋め込みの失敗を観察に返す", async () => {
  const strategies: (SearchStrategy | undefined)[] = [];
  const hybrid = makeRetriever(records, "hybrid", new URL("file:///dev/null/embeddings-cache.json"));
  const result = await runTurn("科学館の料金は？", async (state, actions) => {
    if (!state.observations.length) return { ...searchMuseum, strategy: "keyword" };
    if (state.observations.length === 1) return { ...searchMuseum, strategy: "semantic" };
    assert.ok(actions.includes("search"));
    assert.deepEqual(state.observations.map(({ retrieval }) => retrieval), ["keyword", "keyword_fallback"]);
    assert.deepEqual(state.observations[1].passages, []);
    return { action: "insufficient", answer: "無料です。", sources: ["museum-fees"] };
  }, hybrid, {
    onAction: (event) => {
      if (event.action === "search") strategies.push(event.strategy);
    },
  });
  assert.deepEqual(strategies, ["keyword", "semantic"]);
  assert.equal(result.answer, NO_EVIDENCE);
  assert.deepEqual(result.sources, []);
});

test("観察した資料の続きと関連節を取得し、未取得の資料IDは開けない", async () => {
  const access = records.find(({ id }) => id === "museum-access")!;
  const hours = records.find(({ id }) => id === "museum-hours")!;
  const long = { ...access, text: "あ".repeat(599) + "🐋本文の続き。" };
  const readSource = makeSourceReader([long, hours, { ...hours, id: "other", url: "https://example.org/" }]);
  const retrieve = async () => ({ mode: "keyword" as const, records: [long] });
  for (const id of [long.id, "other"]) {
    const result = await runTurn("駅から行ける科学館の閉館時刻は？", async (state) => {
      if (!state.observations.length) return searchMuseum;
      if (state.observations.length === 1) {
        const [excerpt] = state.observations[0].passages;
        assert.equal(excerpt.text.length, 599);
        assert.equal(excerpt.truncated, true);
        assert.deepEqual(state.expandable_source_ids, ["museum-access"]);
        return { action: "search", target: "source_details", source_id: id, query: "開館時間 閉館時刻" };
      }
      const detail = state.observations[1];
      if (id === long.id) {
        assert.equal(detail.status, "found");
        assert.deepEqual(detail.source_ids, ["museum-access", "museum-hours"]);
        assert.match(detail.passages[0].text, /🐋本文の続き/);
        assert.equal(detail.passages[0].truncated, undefined);
      } else {
        assert.equal(detail.status, "invalid");
        assert.deepEqual(detail.passages, []);
      }
      return { action: "answer", answer: "17時です。", sources: ["museum-hours"] };
    }, retrieve, { searchMode: "keyword", readSource });
    assert.equal(result.action, id === long.id ? "answer" : "insufficient");
  }
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

test("収集日の地区と品目は利用者の言い方から照合する", async () => {
  assert.equal(singleDistrictHint(["北浜の資源ごみの収集日は？"]), undefined);
  assert.equal(singleDistrictHint(["大沢３区の段ボールは2026年12月のいつ？"]), "大沢3区");
  assert.deepEqual(namedWasteTypes("不燃ごみと雑誌"), ["non_burnable_glass_batteries", "paper_and_hazardous_items"]);
  assert.deepEqual(namedWasteTypes("ペットボトルのキャップ"), ["plastic"]);
  assert.deepEqual(namedWasteTypes("割れた蛍光管とペンキの缶"), ["non_burnable_glass_batteries"]);

  const result = await runTurn("大沢で乾電池と雑誌は2026年12月のいつ出せますか？", async (state, actions) => {
    assert.ok(!actions.includes("clarify"));
    assert.deepEqual(state.collection_hints, {
      district: "大沢", waste_types: ["non_burnable_glass_batteries", "paper_and_hazardous_items"],
    });
    if (!state.observations.length) return {
      action: "search", target: "collection_calendars", district: "荒川", waste_types: ["burnable"],
    };
    return { action: "answer", sources: ["calendar-2026-osawa"] };
  }, keyword, { today: "2026-11-22" });
  assert.match(result.answer, /乾電池　2026年12月18日（金）/);
  assert.match(result.answer, /水銀血圧計　2026年12月25日（金）/);
  assert.doesNotMatch(result.answer, /・燃やせるごみ　/);
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

test("聞き返しで取得済みの一般資料をサーバーに保持して、続きの回答で引用できる", async (context) => {
  const received: (string[] | undefined)[] = [];
  const server = createGuideServer({
    records, retrieval: "keyword", decide: async (state) => {
      if (!state.follow_up) {
        if (!state.observations.length) return searchMuseum;
        return { action: "clarify", field: "district" };
      }
      if (!state.observations.length) {
        received.push(state.prior_passages?.map(({ id }) => id));
        return { action: "search", target: "collection_calendars", district: "大沢", waste_types: ["plastic"] };
      }
      return {
        action: "answer", sources: ["calendar-2026-osawa", "museum-fees"], other_answer: "科学館は大人300円です。",
      };
    },
  }).listen(0, "127.0.0.1");
  context.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ask`;
  const ask = async (input: { question: string; pending?: GuideResult["pending"] }) => {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    return await response.json() as GuideResult;
  };
  const question = "科学館の大人の料金と、2026年12月のプラスチックの収集日は？";
  const first = await ask({ question });
  assert.equal(first.action, "clarify");
  assert.ok(first.pending?.resume_token);
  assert.ok(!Object.hasOwn(first, "checkpoint"));
  const changed = await ask({ question: "大沢です", pending: { ...first.pending, question: question + " 教えて" } });
  assert.equal(changed.action, "insufficient");
  assert.equal(received[0], undefined);
  const next = await ask({ question: "大沢です", pending: first.pending });
  assert.ok(received[1]?.includes("museum-fees"));
  assert.equal(next.action, "answer");
  assert.match(next.answer, /12月8日（火）/);
  assert.match(next.answer, /300円/);
  assert.equal(next.sources.length, 2);
});

test("Ollamaの障害と検索条件の欠落で資料検索に切り替わり、根拠不足は出典なしで返す", async (context) => {
  const previousUrl = process.env.YAMADA_CHAT_URL;
  context.after(() => {
    if (previousUrl === undefined) delete process.env.YAMADA_CHAT_URL;
    else process.env.YAMADA_CHAT_URL = previousUrl;
  });
  let missingQueries = 0;
  let stalledAfterHeaders = false;
  const ollama = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { stream, messages } = JSON.parse(body);
    const state = JSON.parse(messages.at(-1).content);
    const send = (decision: object) => {
      const message = { content: JSON.stringify(decision) };
      response.end(stream ? JSON.stringify({ message, done: true }) + "\n" : JSON.stringify({ message }));
    };
    if (request.url === "/timeout") {
      if (!stream) send(searchMuseum);
      else {
        stalledAfterHeaders = true;
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.write('{"message":');
      }
    } else if (request.url === "/http-error") {
      response.writeHead(503).end();
    } else if (request.url === "/malformed") response.end("malformed response");
    else if (request.url === "/bad-action") send({ action: "unknown" });
    else if (request.url === "/missing-query" && state.remaining_searches > 0) {
      missingQueries++;
      send({ action: "search", target: "official_documents" });
    } else if (request.url === "/unknown-crowd" && !state.observations.length) {
      send({ action: "search", target: "official_documents", query: "道の駅やまだ 営業時間" });
    } else send({ action: "insufficient", answer: "根拠のない回答", sources: ["oisuta-hours"] });
  }).listen(0, "127.0.0.1");

  const guide = createGuideServer({ records, retrieval: "keyword", decide: makeDecider("gemma4:12b", 250) })
    .listen(0, "127.0.0.1");
  for (const server of [ollama, guide]) {
    context.after(() => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }));
  }
  await Promise.all([once(ollama, "listening"), once(guide, "listening")]);
  const stubUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
  const guideUrl = `http://127.0.0.1:${(guide.address() as AddressInfo).port}/api/ask`;
  const ask = async (endpoint: string, question = "鯨と海の科学館の大人の入館料は？") => {
    process.env.YAMADA_CHAT_URL = endpoint;
    const response = await fetch(guideUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ question }),
    });
    assert.equal(response.status, 200);
    const events: StreamEvent[] = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const last = events.at(-1);
    if (last?.type !== "result") throw new Error("結果イベントがありません。");
    return last.data;
  };

  const closed = createServer().listen(0, "127.0.0.1");
  await once(closed, "listening");
  const closedPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  for (const [url, message] of [
    [`http://127.0.0.1:${closedPort}/chat`, "AIに接続できませんでした。"],
    [stubUrl + "/timeout", "AIの回答生成がタイムアウトしました。"],
    [stubUrl + "/http-error", "AIサーバーがHTTP 503を返しました。"],
    [stubUrl + "/malformed", "AIから受け取った応答を読み取れませんでした。"],
    [stubUrl + "/bad-action", "AIから検索や回答に必要な指示を読み取れませんでした。"],
    [stubUrl + "/missing-query", "AIが検索語など、資料を探す条件を指定できませんでした。"],
  ]) {
    const result = await ask(url);
    assert.equal(result.mode, "search");
    assert.equal(result.action, "search");
    assert.equal(result.notice, message + "公式資料の検索結果を表示しています。");
    assert.ok(result.sources.some(({ url, text }) =>
      url === "https://yamada-kujirakan.jp/facility/" && text?.includes("大人300円")));
  }
  assert.equal(missingQueries, 3);
  assert.equal(stalledAfterHeaders, true);
  const insufficient = await ask(stubUrl + "/unknown-crowd", "明日の道の駅やまだは混んでいますか？");
  assert.equal(insufficient.mode, "ai");
  assert.equal(insufficient.action, "insufficient");
  assert.equal(insufficient.answer, NO_EVIDENCE);
  assert.deepEqual(insufficient.sources, []);
  assert.equal(insufficient.notice, "");
});
