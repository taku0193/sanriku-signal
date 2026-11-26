import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { actionFacts } from "../frontend/actionFacts.js";
import type { GuideResult, StreamEvent } from "../frontend/types.js";
import { makeNameResolver } from "../shared/knowledge.js";
import { normalizeQuery } from "../shared/query.js";
import { AmbiguousDistrict, collectionBounds, findCollectionDays, namedWasteTypes, singleDistrictHint, todayInTokyo } from "../server/calendars.js";
import { makeRetriever } from "../server/embeddings.js";
import type { SearchStrategy } from "../server/embeddings.js";
import { OllamaError } from "../server/ollama.js";
import { withSourcePeriods } from "../server/periods.js";
import { makeDecider, runTurn, streamGroundedAnswer } from "../server/react.js";
import type { Decider } from "../server/react.js";
import { loadRecords, makeSourceReader, NO_EVIDENCE, summarizeSearchFallback } from "../server/records.js";
import { createGuideServer, readHistory, readPending } from "../server/web.js";

const records = loadRecords();
const keyword = makeRetriever(records, "keyword");
const searchMuseum = { action: "search", target: "official_documents", query: "鯨と海の科学館 入館料", missing_fact: "科学館の入館料" };

test("検索に切り替わっても、質問と一致した資料の記載を本文で返す", async () => {
  const exact = "鯨と海の科学館の大人の入館料は？";
  const { records: hits } = await keyword(exact);
  assert.match(summarizeSearchFallback(exact, hits), /入館料.*大人300円/s);
  for (const question of ["明日の鯨と海の科学館の混雑と入館料は？", "『海鳥科学館分館』の大人の入館料は？", "鯨と海の科学館以外の入館料は？"]) {
    assert.equal(summarizeSearchFallback(question, hits), "見つかった資料から、質問への答えを確認できませんでした。");
  }
  assert.equal(summarizeSearchFallback(exact, []), NO_EVIDENCE);
});

test("操作案内カードは質問に対応する資料と必要な根拠がそろった場合に表示できる", () => {
  const certificate = records.find(({ id }) => id === "md-resident-card-mynumber-proxy")!;
  const apply = "代理で証明書を受け取りたい。\n個人番号を載せた住民票です。";
  assert.equal(actionFacts(apply, [certificate])?.main.value, "本人へ簡易書留");
  assert.equal(actionFacts(apply, [{ ...certificate, text: "代理人が申請できます。" }]), undefined);
  assert.equal(actionFacts("個人番号を載せた住民票の手数料は？", [certificate]), undefined);

  const timetable = records.find(({ id }) => id === "md-yamada-local-fixed-bus")!;
  const travel = "祝日にF03は運行していますか？通常の時刻も教えて。";
  const times = actionFacts(travel, [timetable]);
  assert.equal(times?.main.value, "運休");
  assert.deepEqual(times?.details, [{ label: "山田駅前", value: "16:54 発" }, { label: "鯨科学館前", value: "17:08 着" }]);
  assert.equal(actionFacts(travel, [{ ...timetable, text: timetable.text.replace("F03は土日祝", "F03は年末") }]), undefined);
  assert.equal(actionFacts("祝日に別のバスで科学館に行くには？", [timetable]), undefined);
});

test("読みと1文字の誤字から、同じ公式資料を検索する", async () => {
  const cases = [
    ["くじらとうみのかがくかんのおとなのにゅうかんりょう", "museum-fees"],
    ["ｶｶﾞｸｶﾝのにゅうかんりょう", "museum-fees"],
    ["かがっかんの入館料", "museum-fees"],
    ["かくがかんの入館料", "museum-fees"],
    ["かがくかかんの入館料", "museum-fees"],
    ["かがかんの入館料", "museum-fees"],
    ["鯨と海の化学館の入館量", "museum-fees"],
    ["とよまんねえきのじこくひょう", "santetsu-timetable"],
    ["おらんだじまのかいすいよく", "md-oranda-island-beach-2026"],
    ["じゅうみんひょうをこんびにこうふでとるには？", "md-resident-certificate-convenience"],
    ["かんでんちのだしかた", "md-waste-batteries-and-lamps"],
    ["岩手県 救急車 相談番号 IP電話 受付時間", "md-iwate-emergency-number"],
  ];
  for (const [question, id] of cases) {
    assert.equal((await keyword(question)).records[0]?.id, id, question);
  }
  assert.equal(normalizeQuery("科学館のにゅうかんりょはいくら？"), "科学館の入館料はいくら?");
  assert.equal(normalizeQuery("🐋 İ かがくかんいがいで"), "🐋 İ 科学館いがいで");
  assert.equal(normalizeQuery("かがくかんれんのほん"), "かがくかんれんのほん");
  assert.equal(normalizeQuery("わにわに水晶博物館のにゅうかんりょう"), "わにわに水晶博物館の入館料");
  assert.equal(normalizeQuery("おおさ3くのもやさないごみ"), "おおさ3くのもやさないごみ");
});

test("固有名や読みから、地域資料と同名の作品を照合する", async () => {
  for (const question of ["海よ光れ", "『海よ、光れ！』", "うみよひかれってなに？", "うみよひかふ"]) {
    assert.equal((await keyword(question)).records[0]?.id, "md-umi-yo-hikare-overview", question);
  }
  assert.equal((await keyword("海よ光れのラジオ放送日")).records[0]?.id, "md-umi-yo-hikare-radio");
  assert.equal((await keyword("『八幡館』って何？")).records[0]?.id, "regional-143");
  assert.ok((await keyword("おおうらとらまい")).records.some(({ id }) => id === "regional-199"));
  assert.ok(!(await keyword("星よ光れ")).records.some(({ id }) => id.startsWith("md-umi-yo-hikare")));

  const resolveName = makeNameResolver(records);
  const monument = await runTurn("ひのえさるかいしょうのきって何ですか？", async (state, actions) => {
    if (!state.observations.length) {
      assert.deepEqual(actions, ["search"]);
      return { action: "search", target: "official_documents", query: "ひのえさるかいしょう きって" };
    }
    assert.equal(state.observations[0].query, "丙申海嘯之記");
    return { action: "answer", sources: ["md-hinoesaru-tsunami-inscription"], answer: "明治三陸津波を伝える石碑です。" };
  }, keyword, { resolveName });
  assert.equal(monument.action, "answer");

  const newspaper = await runTurn("学校新聞『海よ光れ』はいつ創刊されましたか？", async (state) => {
    assert.equal(state.collection_hints, undefined);
    return state.observations.length
      ? { action: "answer", sources: ["md-umi-yo-hikare-newspaper"], answer: "2004年9月に創刊されました。" }
      : { action: "search", target: "official_documents", query: "海よ光れ 学校新聞 創刊" };
  }, keyword);
  assert.equal(newspaper.action, "answer");
});

test("指定された作品名を確認できない資料から本文を配信しない", async () => {
  const play = records.find(({ id }) => id === "md-umi-yo-hikare-play")!;
  const fees = records.find(({ id }) => id === "museum-fees")!;
  const chunks: string[] = [];
  for (const title of ["波よ光れ", "海よ光れ"]) {
    const result = await runTurn(`学校劇『${title}』は何年に始まりましたか？`, async (state, actions, _signal, stream) => {
      if (!state.observations.length) return { action: "search", target: "official_documents", query: "学校劇 海よ光れ" };
      assert.ok(state.observations[0].query?.includes(title));
      assert.equal(actions.includes("answer"), title === "海よ光れ");
      const decision = { action: "answer", sources: [fees.id], answer: "1988年からです。" };
      stream?.(JSON.stringify(decision));
      return decision;
    }, async () => ({ records: [play, fees], mode: "keyword" }), { onDelta: (chunk) => chunks.push(chunk) });
    assert.equal(result.action, "insufficient");
    assert.deepEqual(result.sources, []);
  }
  assert.deepEqual(chunks, []);
});

test("通常料金に出典を付け、当日の混雑を確認できる範囲を伝える", async () => {
  const question = "明日の鯨と海の科学館に何人並んでいるかと、大人の通常料金を教えて。";
  const result = await runTurn(question, async (state, actions, _signal, stream) => {
    assert.equal(state.reference_question, "通常料金");
    assert.equal(stream, undefined);
    if (!state.observations.length) {
      assert.deepEqual(actions, ["search"]);
      return searchMuseum;
    }
    if (state.question === question) return { action: "insufficient", reason: "live_information" };
    assert.match(state.question, /鯨と海の科学館.*通常料金/);
    assert.doesNotMatch(state.question, /明日|何人/);
    return { action: "answer", answer: "大人の通常料金は300円ですが、明日の混雑は分かりません。", sources: ["museum-fees"] };
  }, keyword, { onDelta: () => assert.fail("確認前の回答を配信した") });
  assert.match(result.answer, /大人の通常料金は300円です。.*混雑や待ち時間.*確認できません/s);
  assert.equal((result.answer.match(/混雑/g) ?? []).length, 1);
  assert.equal(result.sources[0].id, "museum-fees");
  assert.deepEqual(result.presentation?.sections.map(({ sourceIndexes }) => sourceIndexes), [[0], []]);
});

test("比較の結論と各項目の根拠をまとめ、取得していない引用は表示しない", async () => {
  const question = "科学館と道の駅やまだではどちらが遅く閉まりますか？";
  const hits = records.filter(({ id }) => ["museum-hours", "oisuta-hours"].includes(id));
  const conclusion = "道の駅やまだの方が遅く閉まります。";
  for (const secondSource of ["oisuta-hours", "missing"] as const) {
    const result = await runTurn(question, async (state, _actions, _signal, stream) => {
      assert.equal(state.answer_layout, "comparison");
      assert.equal(stream, undefined);
      if (!state.observations.length) return searchMuseum;
      return {
        action: "answer", answer: conclusion, sources: ["museum-hours", "oisuta-hours"],
        sections: [
          { label: "鯨と海の科学館", text: "通常は17:00まで。", source_ids: ["museum-hours"] },
          { label: "道の駅やまだ", text: "通常は18:00まで。", source_ids: [secondSource] },
        ],
      };
    }, async () => ({ records: hits, mode: "keyword" }), { onDelta: () => assert.fail("比較を途中で表示した") });
    assert.equal(result.action, "answer");
    if (secondSource === "missing") {
      assert.equal(result.presentation, undefined);
      assert.equal(result.answer, conclusion);
    } else {
      assert.equal(result.presentation?.conclusion, conclusion);
      assert.deepEqual(result.presentation?.sections.map(({ sourceIndexes }) =>
        sourceIndexes.map((index) => result.sources[index].id)), [["museum-hours"], ["oisuta-hours"]]);
      assert.match(result.answer, /^道の駅やまだの方が遅く閉まります。.*17:00.*18:00/s);
    }
  }
});

test("駅名から比較する場合はアクセス案内と閉館時刻を別々に確認する", async () => {
  const source = (id: string) => records.find((record) => record.id === id)!;
  const question = "岩手船越駅が最寄りの施設とおいすたは、通常どちらが遅く閉まりますか？";
  const searchTargets: unknown[] = [];
  const result = await runTurn(question, async (state) => {
    if (!state.observations.length) return searchMuseum;
    return { action: "answer", answer: "科学館は20:00まで開きます。", sources: ["museum-access"] };
  }, async () => ({ records: [source("museum-access"), source("oisuta-hours")], mode: "keyword" }), {
    readSource: makeSourceReader(records),
    onAction: (event) => { if (event.action === "search") searchTargets.push(event.target); },
  });
  assert.deepEqual(searchTargets, ["official_documents", "source_details"]);
  assert.match(result.presentation?.conclusion ?? "", /おいすたの方が遅く閉まります/);
  assert.match(result.answer, /18:00/);
  assert.match(result.answer, /17:00/);
  assert.doesNotMatch(result.answer, /20:00/);
  const museum = result.presentation?.sections.find(({ label }) => label === "鯨と海の科学館");
  assert.deepEqual(museum?.fact, { label: "通常の閉館", value: "17:00", note: "三陸鉄道の岩手船越駅から徒歩約10分。" });
  assert.deepEqual(museum?.sourceIndexes.map((index) => result.sources[index].id), ["museum-hours", "museum-access"]);
});

test("駅から施設を特定する比較は、最初の資料から両方の閉館とアクセスを出典付きで返せる", async () => {
  const question = "岩手船越駅から徒歩で行ける施設と、おいすたでは、通常どっちが遅くまで開いていますか？";
  const query = "岩手船越駅 おいすた 営業時間";
  const actions: string[] = [];
  const decide: Decider = async (state) => {
    assert.equal(state.observations.length, 0);
    return { action: "search", target: "official_documents", query };
  };
  decide.reviewEvidence = async () => assert.fail("比較に必要な資料がそろっている");
  const result = await runTurn(question, decide, keyword, {
    searchMode: "keyword", readSource: makeSourceReader(records), onAction: ({ action }) => actions.push(action),
  });
  assert.deepEqual(actions, ["search", "answer"]);
  assert.match(result.presentation?.conclusion ?? "", /おいすたの方が遅く閉まります/);
  const museum = result.presentation?.sections.find(({ label }) => label === "鯨と海の科学館");
  assert.match(museum?.text ?? "", /17:00.*岩手船越駅から徒歩約10分/);
  assert.deepEqual(museum?.sourceIndexes.map((index) => result.sources[index].id), ["museum-hours", "museum-access"]);
  assert.match(result.answer, /18:00/);

  const withDeadline = question + " 粗大ごみの予約締切も教えてください。";
  assert.ok(!(await keyword(query, undefined, "keyword", withDeadline)).records.some(({ id }) => id === "museum-hours"));
});

test("別々の用件には対応する根拠を付け、共通の前置きを省く", async () => {
  const result = await runTurn("科学館の大人の料金と空き缶の出し方は？", async (state) => {
    assert.equal(state.answer_layout, "multiple");
    if (!state.observations.length) return searchMuseum;
    return { action: "answer", sections: [
      { label: "入館料", text: "大人300円です。", source_ids: ["museum-fees"] },
      { label: "空き缶の出し方", text: "中をすすいで透明か半透明の袋へ。", source_ids: ["md-waste-cans-and-bottles"] },
    ] };
  }, async () => ({
    records: records.filter(({ id }) => ["museum-fees", "md-waste-cans-and-bottles"].includes(id)), mode: "keyword",
  }));
  assert.match(result.answer, /入館料\n大人300円.*空き缶の出し方\n中をすすいで/s);
  assert.equal(result.presentation?.conclusion, undefined);
  assert.deepEqual(result.presentation?.sections.map(({ sourceIndexes }) => sourceIndexes), [[0], [1]]);
});

test("出典で確認したいぐバスの路線と曜日を予約案内に添える", async () => {
  const station = "陸中山田駅";
  const source = records.find(({ id }) => id === "md-igu-bus")!;
  const makeAnswer = (question: string, hits: typeof records) => runTurn(question, async (state) => {
    if (!state.observations.length) return {
      action: "search", target: "official_documents", query: "いぐバス 予約",
    };
    return { action: "answer", sources: [hits[0].id], answer: "日曜の電話予約はできません。アプリは24時間受付です。" };
  }, async () => ({ records: hits, mode: "keyword" }));
  const question = (location: string) => `${location}周辺で日曜にいぐバスを電話予約できる？`;
  const result = await makeAnswer(question(station), [source]);
  assert.match(result.answer, /^陸中山田駅周辺は、通常は毎日運行する「まちなか線」のエリアです。/);
  assert.deepEqual(result.sources, [source]);
  assert.doesNotMatch((await makeAnswer(question("織笠駅"), [source])).answer, /まちなか線/);
  const otherSource = { ...source, id: "other" };
  assert.doesNotMatch((await makeAnswer(question(station), [otherSource])).answer, /まちなか線/);
});

test("前年の祭りの案内を翌年の日程として引用しない", async () => {
  const saved = records.find(({ id }) => id === "md-yamada-festival-2026")!;
  assert.deepEqual(saved.period, { from: "2026-09-19", through: "2026-09-21" });
  const snapshot = { ...saved, period: undefined, id: "town-1657-3" };
  const [fromImportedVersion, newVersion] = withSourcePeriods([
    { ...snapshot, published: "2026-09-07" }, { ...snapshot, published: "2027-09-01" },
  ]);
  assert.deepEqual(fromImportedVersion.period, saved.period);
  assert.equal(newVersion.period, undefined);
  const search = { action: "search", target: "official_documents", query: "大杉神社 宵宮の日程" };
  const today = "2026-11-22";
  for (const [label, year, upcoming, answer] of [
    ["2026年の", 2026, false, true], ["2027年の", 2027, false, false],
    ["前回の", undefined, false, true], ["次の", undefined, true, false],
  ] as const) {
    const result = await runTurn(
      `${label}山田祭りの大杉神社の宵宮祭は何日？`, async (state, actions) => {
        assert.equal(state.requested_event_year, year);
        assert.equal(state.requested_event_after, upcoming ? today : undefined);
        if (!state.observations.length) return search;
        assert.equal(actions.includes("answer"), answer);
        return { action: "answer", answer: "9月20日です。", sources: [fromImportedVersion.id] };
      }, async () => ({ records: [fromImportedVersion], mode: "hybrid" }), { today },
    );
    assert.equal(result.action, answer ? "answer" : "insufficient");
    assert.equal(result.sources.length, answer ? 1 : 0);
  }
});

test("証明書の種類を聞き返し、個人番号記載の住民票は受取方法の資料を探す", async () => {
  const initial = await runTurn("委任状で証明書を友人が受け取れますか？",
    async () => assert.fail("証明書の種類を確認する"), keyword);
  assert.equal(initial.pending?.field, "condition");
  assert.match(initial.answer, /どの証明書/);
  const followed = await runTurn("個人番号を載せた住民票です。", async (state) => {
    assert.equal(state.follow_up?.reply, "個人番号を載せた住民票です。");
    return state.observations.length
      ? { action: "answer", answer: "本人に簡易書留で送られます。", sources: ["md-resident-card-mynumber-proxy"] }
      : { action: "search", target: "official_documents", query: "住民票 個人番号 委任状 受取" };
  }, keyword, { pending: initial.pending });
  assert.equal(followed.action, "answer");
  assert.match(followed.answer, /簡易書留/);
});

test("質問の対象を聞き返し、元の質問と返答を引き継ぐ", async () => {
  const first = await runTurn("料金はいくらですか？", async () => ({
    action: "clarify", field: "condition", answer: "どの施設の料金ですか？",
  }), keyword);
  assert.equal(first.action, "clarify");
  assert.deepEqual(first.sources, []);
  assert.equal(first.pending?.field, "condition");
  assert.throws(() => readPending({ ...first.pending, district_hint: "大沢" }), TypeError);
  const next = await runTurn("かがっかんです", async (state, actions) => {
    assert.equal(state.question, "料金はいくらですか？");
    assert.equal(state.follow_up?.reply, "かがっかんです");
    assert.deepEqual(state.search_wording, { question: undefined, reply: "科学館です" });
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
    assert.equal(state.remaining_searches, 3);
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

test("5回目の検索結果が最終判断に届き、6回目の検索を拒否する", async () => {
  const budgets: (number | undefined)[] = [];
  const queries: string[] = [];
  const result = await runTurn("山田町の資料を探して", async (state, actions) => {
    budgets.push(state.remaining_searches);
    const number = state.observations.length;
    assert.equal(actions.includes("search"), number < 5);
    if (number === 5) assert.equal(state.observations[4].status, "not_found");
    return { ...searchMuseum, query: `検索語 ${number + 1}` };
  }, async (query) => {
    queries.push(query);
    return { records: [], mode: "keyword" };
  });
  assert.deepEqual(budgets, [5, 4, 3, 2, 1, 0]);
  assert.deepEqual(queries, ["検索語 1", "検索語 2", "検索語 3", "検索語 4", "検索語 5"]);
  assert.equal(result.action, "insufficient");
});

test("資料の照合は一度だけ行い、不足項目を追加検索に使える", async () => {
  for (const scenario of ["ready", "missing", "unavailable"]) {
    const needsHours = scenario === "missing";
    const decisions: string[] = [];
    const decide: Decider = Object.assign<Decider, Pick<Decider, "reviewEvidence">>(async (state) => {
      if (!state.observations.length) return searchMuseum;
      if (state.evidence_review?.query) return { ...searchMuseum, query: state.evidence_review.query };
      return { action: "answer", sources: [needsHours ? "museum-hours" : "museum-fees"],
        answer: needsHours ? "17時です。" : "大人300円です。" };
    }, {
      reviewEvidence: async (state) => {
        assert.equal(state.observations[0].source_ids[0], "museum-fees");
        if (scenario === "unavailable") throw new OllamaError("タイムアウト");
        return needsHours ? { source_ids: [], missing_fact: "閉館時刻", query: "科学館の閉館時刻" }
          : { source_ids: ["museum-fees"] };
      },
    });
    const result = await runTurn(needsHours ? "科学館は何時まで？" : "科学館の入館料は？", decide, keyword, {
      onAction: (event) => decisions.push(event.action),
    });
    assert.equal(result.action, "answer");
    assert.deepEqual(decisions, needsHours ? ["search", "review", "search", "answer"] : ["search", "review", "answer"]);
  }
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

  const result = await runTurn("大沢で2026年12月に乾電池と雑誌を出せる日は？", async (state, actions) => {
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

test("年月と品目が明確な収集日の質問は、日程表だけで日付と出典を返せる", async () => {
  const cases = [
    ["大沢の雑誌は2026年12月のいつ出せますか？", /雑誌.*2026年12月25日（金）/],
    ["大沢の乾電池と新聞は2026年12月の何日に出せますか？", /乾電池.*12月18日.*新聞.*12月25日/s],
    ["大沢の2026年12月のペットボトルの収集日は？", /ペットボトル.*12月8日/],
  ] as const;
  for (const [question, expected] of cases) {
    const actions: string[] = [];
    const result = await runTurn(question, async () => { throw new OllamaError("AIに接続できませんでした。"); },
      keyword, { today: "2026-11-25", onAction: ({ action }) => actions.push(action) });
    assert.equal(result.action, "answer");
    assert.match(result.answer, expected);
    assert.deepEqual(result.sources.map(({ id }) => id), ["calendar-2026-osawa"]);
    assert.deepEqual(actions, ["search", "answer"]);
  }
});

test("今日・明日・次回は日本時間で別々の日程を照合する", async () => {
  const today = todayInTokyo(new Date("2026-11-24T15:01:00Z"));
  const cases = [
    ["大沢で今日は燃やせるごみを出せますか？", /燃やせるごみ　2026年11月25日（水）.*午前8時/s],
    ["明日、大沢で燃やせるごみは出せますか？", /11月26日（木）.*燃やせるごみ　この日の収集予定はありません/s],
    ["大沢の次の燃やせるごみの日は？", /燃やせるごみ　2026年11月28日（土）/],
    ["大沢で次の不燃ごみはいつ出せる？", /燃やせないごみ.*2026年12月18日（金）/],
  ] as const;
  const unreachableModel: Decider = async () => assert.fail("日程表だけで回答できる");
  for (const [question, expected] of cases) {
    const result = await runTurn(question, unreachableModel, keyword, { today });
    assert.equal(result.action, "answer");
    assert.match(result.answer, expected);
    assert.equal(result.sources[0]?.id, "calendar-2026-osawa");
  }

  const holiday = await runTurn("大沢で明日の燃えるごみの収集はありますか？", unreachableModel, keyword, { today: "2026-12-31" });
  assert.match(holiday.answer, /2027年1月1日（金）.*1月1日〜3日は収集休止/s);
  assert.equal(holiday.sources[0]?.id, "calendar-2026-osawa");

  const unpublished = await runTurn("大沢の次回の不燃ごみの収集日は？", unreachableModel, keyword, { today: "2027-03-31" });
  assert.equal(unpublished.action, "insufficient");
  assert.match(unpublished.answer, /収集日を確認できません/);
  assert.deepEqual(unpublished.sources, []);
});

test("日程表に必要な地区を聞き返し、返答から元の品目と次回の日程を照合する", async () => {
  const unreachableModel: Decider = async () => assert.fail("地区名の確認と日程表の照合だけで回答できる");
  const cases = [
    ["うちの地区の次の燃やせるごみの日は？", /どの地区/, "大沢です", "calendar-2026-osawa", /11月28日（土）/],
    ["北浜の次の燃やせるごみの日は？", /複数の収集区分/, "4区です", "calendar-2026-yamada-1", /11月26日（木）/],
  ] as const;
  for (const [question, clarification, reply, sourceId, expected] of cases) {
    const first = await runTurn(question, unreachableModel, keyword, { today: "2026-11-25" });
    assert.equal(first.action, "clarify");
    assert.match(first.answer, clarification);
    assert.deepEqual(first.sources, []);
    const next = await runTurn(reply, unreachableModel, keyword, { today: "2026-11-25", pending: first.pending });
    assert.equal(next.action, "answer");
    assert.equal(next.sources[0]?.id, sourceId);
    assert.match(next.answer, expected);
  }
});

test("収集日と一緒に別の用件がある質問は、日程表だけで回答しない", async () => {
  for (const question of [
    "大沢の雑誌は2026年12月のいつ出せますか？出し方も教えてください。",
    "大沢の2026年12月の汚れた紙の収集日は？",
    "大沢の2026年12月の雑誌以外の収集日は？",
    "大沢の次の雑誌の収集日は？あと、出し方も教えてください。",
    "大沢の不燃ごみを今日と明日のどちらに出せますか？",
  ]) {
    const unavailable = new OllamaError("AIに接続できませんでした。");
    await assert.rejects(runTurn(question, async () => { throw unavailable; }, keyword), (error) => error === unavailable);
  }
});

test("ひらがなの地区名と区番号を照合し、地区の曖昧さを保つ", async () => {
  const question = "おおさわ３くのもやせないごみは2026年12月のいつ？";
  const result = await runTurn(question, async (state) => {
    assert.equal(state.question, question);
    assert.deepEqual(state.collection_hints, {
      district: "大沢3区", waste_types: ["non_burnable_glass_batteries"],
    });
    return state.observations.length ? { action: "answer", sources: ["calendar-2026-osawa"] }
      : { action: "search", target: "collection_calendars" };
  }, keyword, { today: "2026-11-22" });
  assert.match(result.answer, /大沢.*2026年12月/s);
  assert.match(result.answer, /燃やせないごみ.*2026年12月18日/);
  assert.doesNotMatch(result.answer, /・燃やせるごみ　/);
  assert.equal(singleDistrictHint([normalizeQuery("ふなこしのごみのしゅうしゅうび")]), undefined);
});

test("暦の日付から年度を確定し、存在しない日付と未収録年度を検索前に判定する", async () => {
  const today = "2026-11-22";
  const input = "2027年1月2日、大沢で燃やせるごみの収集はありますか？";
  const result = await runTurn(input, async (state) => state.observations.length
    ? { action: "answer", sources: ["calendar-2026-osawa"] }
    : { action: "search", target: "collection_calendars", period: "period", start_date: "2027-01-02", fiscal_year: 2027 },
  keyword, { today });
  assert.equal(result.action, "answer");
  assert.match(result.answer, /2027年1月2日.*1月1日〜3日は収集休止/s);
  assert.equal(result.sources[0].id, "calendar-2026-osawa");

  for (const [date, expected] of [["2026年2月30日", /日付/], ["2031年12月", /確認できません/]] as const) {
    const invalid = await runTurn(`大沢の${date}の不燃ごみの収集日は？`, async () => assert.fail("日程は確定できない"), keyword, { today });
    assert.equal(invalid.action, "insufficient");
    assert.match(invalid.answer, expected);
    assert.deepEqual(invalid.sources, []);
  }

  const ambiguous = await runTurn("羽々の下ですが大沢やほかの集積所は除いて、燃やせないごみの日程を教えて。",
    async () => assert.fail("目印を聞く必要がある"), keyword, { today });
  assert.equal(ambiguous.pending?.district_hint, "羽々の下");
});

test("収集日を除外した分別や予約締切の質問は一般資料で調べる", async () => {
  const cases = [
    ["大沢の粗大ごみ収集の申込みは何日締切？収集日の質問ではありません。", "oversized-waste", "収集月の20日までです。"],
    ["粗大ごみを収集してもらうなら何日までに予約しますか？", "oversized-waste", "収集月の20日までです。"],
    ["割れた蛍光管は大沢の収集日ではなく分別を確認したい。", "md-waste-batteries-and-lamps", "紙で包んで燃やせないごみとして出します。"],
  ];
  for (const [question, source, answer] of cases) {
    const result = await runTurn(question, async (state) => {
      assert.equal(state.collection_hints, undefined);
      assert.equal(state.collection_excluded, true);
      if (!state.observations.length) return { action: "search", target: "collection_calendars" };
      assert.equal(state.observations[0].target, "official_documents");
      return { action: "answer", sources: [source], answer };
    }, keyword);
    assert.equal(result.answer, answer);
    assert.equal(result.sources[0].id, source);
  }
});

test("HTTPで動画の部分配信とNDJSONの回答を返す", async (context) => {
  const server = createGuideServer({
    records, retrieval: "keyword", decide: async (state, _actions, _signal, onContent) => {
      if (state.question.includes("大沢")) {
        throw new OllamaError("AIに接続できませんでした。");
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
  assert.equal(calendarResponse.status, 200);
  assert.equal(calendar.action, "answer");
  assert.match(calendar.answer, /12月8日（火）.*12月25日（金）/);
  assert.equal(calendar.sources[0].url, undefined);
});

test("埋め込み索引なしでも資料を検索でき、モデル切断時は保留中の質問を返す", async (context) => {
  const hybrid = makeRetriever(records, "hybrid", new URL("file:///dev/null/embeddings-cache.json"));
  const fallback = await hybrid("かがっかんのにゅうかんりょうは？");
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
  let recoveredAttempts = 0;
  const reviewedAnswers: string[] = [];
  const ollama = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { stream, messages, format } = JSON.parse(body);
    const state = JSON.parse(messages.at(-1).content);
    const send = (decision: object) => {
      const message = { content: JSON.stringify(decision) };
      response.end(stream ? JSON.stringify({ message, done: true }) + "\n" : JSON.stringify({ message }));
    };
    if (format.required.includes("source_ids")) {
      send({ source_ids: state.passages.map(({ id }: { id: string }) => id) });
    } else if (request.url === "/timeout") {
      if (!stream) send(searchMuseum);
      else {
        stalledAfterHeaders = true;
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.write('{"message":');
      }
    } else if (request.url === "/recover-response") {
      if (!state.observations.length) send(searchMuseum);
      else {
        recoveredAttempts++;
        assert.equal(state.observations[0].source_ids[0], "museum-fees");
        if (stream) {
          response.end(JSON.stringify({ message: { content: '{"action":"answer","sources":["museum-fees"],"answer":"作成中' } }) + "\n");
        } else send({ action: "answer", sources: ["museum-fees"], answer: "大人の入館料は300円です。" });
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
    } else if (request.url === "/unasked-hours") {
      if (state.passages) {
        reviewedAnswers.push(state.answer);
        send({ supported: true });
      } else if (!state.observations.length) {
        send({ action: "search", target: "official_documents", query: "はぴね 児童図書 開館時間" });
      } else {
        send({ action: "answer", sources: ["md-hapine-family", "md-hapine-hours"],
          answer: "はぴねの児童図書コーナーを利用できます。なお、本日（日曜）は17:00まで開館します。" });
      }
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
  let lastEvents: StreamEvent[] = [];
  const ask = async (endpoint: string, question = "鯨と海の科学館の大人の入館料は？") => {
    process.env.YAMADA_CHAT_URL = endpoint;
    const response = await fetch(guideUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ question }),
    });
    assert.equal(response.status, 200);
    lastEvents = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const last = lastEvents.at(-1);
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
    assert.match(result.answer, /大人300円/);
    assert.ok(result.sources.some(({ url, text }) =>
      url === "https://yamada-kujirakan.jp/facility/" && text?.includes("大人300円")));
  }
  assert.equal(missingQueries, 5);
  assert.equal(stalledAfterHeaders, true);
  const recovered = await ask(stubUrl + "/recover-response");
  assert.equal(recoveredAttempts, 2);
  assert.equal(recovered.mode, "ai");
  assert.equal(recovered.answer, "大人の入館料は300円です。");
  const partial = lastEvents.findIndex((event) => event.type === "delta" && event.text === "作成中");
  assert.ok(partial >= 0);
  assert.ok(lastEvents.slice(partial + 1).some((event) => event.type === "progress" && event.stage === "reviewing"));

  const liveFallback = await ask(stubUrl + "/http-error", "明日の道の駅やまだの混雑を教えて。");
  assert.match(liveFallback.answer, /確認できませんでした/);
  assert.doesNotMatch(liveFallback.answer, /9:00|18:00/);
  const insufficient = await ask(stubUrl + "/unknown-crowd", "明日の道の駅やまだは混んでいますか？");
  assert.equal(insufficient.mode, "ai");
  assert.equal(insufficient.action, "insufficient");
  assert.equal(insufficient.answer, NO_EVIDENCE);
  assert.deepEqual(insufficient.sources, []);
  assert.equal(insufficient.notice, "");

  const visit = await ask(stubUrl + "/unasked-hours", "科学館以外で小学生が本を読める施設は？");
  assert.equal(visit.answer, "はぴねの児童図書コーナーを利用できます。");
  const hours = await ask(stubUrl + "/unasked-hours", "科学館以外で小学生が本を読める施設は？今日の開館時間も教えて。");
  assert.match(hours.answer, /17:00まで開館/);
  assert.deepEqual(reviewedAnswers, [visit.answer, hours.answer]);
});
