import { foldKana } from "./knowledge.js";

// 山田町の資料で使われている表記と、質問に現れやすい読みを対応づける。
const readings: Record<string, string> = {
  くじらとうみのかがくかん: "鯨と海の科学館",
  くじらと海の科学館: "鯨と海の科学館",
  鯨と海の化学館: "鯨と海の科学館",
  科学舘: "科学館",
  かがくかん: "科学館",
  くじらかん: "くじら館",
  みちのえきやまだ: "道の駅やまだ",
  みちの駅やまだ: "道の駅やまだ",
  おらんだじま: "オランダ島",
  おらんだしま: "オランダ島",
  くじらさん: "鯨山",
  うみよひかれ: "海よ光れ",
  海よひかれ: "海よ光れ",
  さんりくてつどう: "三陸鉄道",
  りあすせん: "リアス線",
  りくちゅうやまだえき: "陸中山田駅",
  やまだえき: "山田駅",
  とよまねえき: "豊間根駅",
  おりかさえき: "織笠駅",
  いわてふなこしえき: "岩手船越駅",
  ふなこしえき: "船越駅",
  やまだびょういん: "山田病院",
  やまだゆうびんきょく: "山田郵便局",
  やまだちょうやくば: "山田町役場",
  やまだちょうない: "山田町内",
  やまだちょう: "山田町",
  ちょうりつとしょかん: "町立図書館",
  としょかん: "図書館",
  れんたさいくる: "レンタサイクル",
  けんぽくばす: "県北バス",
  さっぱせん: "サッパ船",
  とよまね: "豊間根",
  おりかさ: "織笠",
  ふなこし: "船越",
  おおさわ: "大沢",
  あらかわ: "荒川",
  おおうら: "大浦",
  たのはま: "田の浜",
  うらのはま: "浦の浜",
  いしとうげ: "石峠",
  もりがおか: "森が丘",
  かわむかい: "川向",
  きたはま: "北浜",
  やなぎさわ: "柳沢",
  おとな: "大人",
  しょうがくせい: "小学生",
  ちゅうがくせい: "中学生",
  こうこうせい: "高校生",
  にゅうかんりょう: "入館料",
  入館量: "入館料",
  にゅうじょうりょう: "入場料",
  りょうきん: "料金",
  えいぎょうじかん: "営業時間",
  かいかんじかん: "開館時間",
  さいしゅうにゅうかん: "最終入館",
  きゅうかんび: "休館日",
  かいすいよく: "海水浴",
  ちゅうしゃじょう: "駐車場",
  なんじ: "何時",
  なんにち: "何日",
  なんようび: "何曜日",
  いきかた: "行き方",
  とほ: "徒歩",
  じこくひょう: "時刻表",
  うんこう: "運行",
  よやく: "予約",
  うけつけ: "受付",
  じゅうみんひょう: "住民票",
  こんびにこうふ: "コンビニ交付",
  てすうりょう: "手数料",
  てんにゅうとどけ: "転入届",
  ひっこし: "引っ越し",
  しんせい: "申請",
  こくみんけんこうほけん: "国民健康保険",
  ほいくえん: "保育園",
  ほいくしょ: "保育所",
  ひなんじょ: "避難所",
  ひなんばしょ: "避難場所",
  すいどう: "水道",
  もやせるごみ: "燃やせるごみ",
  もえるごみ: "燃えるごみ",
  もやせないごみ: "燃やせないごみ",
  もえないごみ: "燃えないごみ",
  そだいごみ: "粗大ごみ",
  かんでんち: "乾電池",
  けいこうとう: "蛍光灯",
  しんぶん: "新聞",
  かみぱっく: "紙パック",
  しゅうしゅうび: "収集日",
  しゅうしゅうよてい: "収集予定",
  かいしゅうび: "回収日",
  ぶんべつ: "分別",
  だしかた: "出し方",
  すてかた: "捨て方",
};

// 意味の変わりやすい地区名・品目・日付は登録した読みだけで照合する。
const typoTerms = [
  "くじらとうみのかがくかん", "かがくかん", "にゅうかんりょう", "えいぎょうじかん",
  "りくちゅうやまだえき", "とよまねえき", "おりかさえき", "いわてふなこしえき",
  "さんりくてつどう", "れんたさいくる", "じゅうみんひょう", "こんびにこうふ",
  "やまだびょういん", "やまだゆうびんきょく", "うみよひかれ",
];

const exactTerms = new Map<string, string[]>();
for (const term of Object.keys(readings).sort((a, b) => b.length - a.length)) {
  const terms = exactTerms.get(term[0]) ?? [];
  terms.push(term);
  exactTerms.set(term[0], terms);
}

const leftBoundary = /[\s\p{P}のはがをにでとへやも]/u;
const kana = /[ぁ-ゖー]/u;
const kanaWord = /^[ぁ-ゖー]+$/u;

function atWordEnd(text: string, end: number) {
  const next = text[end];
  return !next || !kana.test(next) || /[のはがをにでとへやもからまよね]/u.test(next) || text.startsWith("いがい", end) ||
    (exactTerms.get(next) ?? []).some((term) => text.startsWith(term, end));
}

function differsByOneEdit(input: string, term: string) {
  let start = 0;
  while (start < Math.min(input.length, term.length) && input[start] === term[start]) start++;
  if (input.length > term.length) return input.slice(start + 1) === term.slice(start);
  if (input.length < term.length) return input.slice(start) === term.slice(start + 1);
  if (start === term.length) return false;
  return input.slice(start + 1) === term.slice(start + 1) ||
    (input[start] === term[start + 1] && input[start + 1] === term[start] && input.slice(start + 2) === term.slice(start + 2));
}

function findTypo(text: string, start: number) {
  let match: { term: string; length: number; score: number } | undefined;
  let ambiguous = false;
  for (const term of typoTerms) {
    for (const length of [term.length, term.length - 1, term.length + 1]) {
      const input = text.slice(start, start + length);
      if (input.length !== length || !atWordEnd(text, start + length) || !kanaWord.test(input)) continue;
      if (length > term.length && input[0] !== term[0]) continue;
      // 末尾の文字が抜けた語の直後に助詞があれば、助詞を誤記と見なさず残す。
      if (length === term.length && input.slice(0, -1) === term.slice(0, -1) &&
          atWordEnd(text, start + length - 1)) continue;
      const sharedEdge = input.startsWith(term.slice(0, 2)) || input.endsWith(term.slice(-2));
      if (!sharedEdge || !differsByOneEdit(input, term)) continue;
      const score = Math.min(length, term.length) * 2 + Number(length === term.length);
      if (match && match.term !== term && match.score === score) ambiguous = true;
      if (!match || score > match.score) {
        match = { term, length, score };
        ambiguous = false;
      }
    }
  }
  if (!ambiguous) return match;
}

export function normalizeQuery(raw: string) {
  const text = raw.normalize("NFKC");
  const folded = foldKana(text);
  let output = "";
  let copied = 0;
  for (let i = 0; i < folded.length;) {
    const exact = (exactTerms.get(folded[i]) ?? []).find((term) =>
      folded.startsWith(term, i) && atWordEnd(folded, i + term.length));
    const typo = !exact && kana.test(folded[i]) && (!i || leftBoundary.test(folded[i - 1]))
      ? findTypo(folded, i) : undefined;
    const term = exact ?? typo?.term;
    if (term) {
      output += text.slice(copied, i) + readings[term];
      i += typo?.length ?? term.length;
      copied = i;
    } else i++;
  }
  return copied ? output + text.slice(copied) : raw;
}
