import { normalizeQuery } from "../shared/query.js";
import type { Source } from "./types.js";

interface Fact {
  label: string;
  value: string;
}

export interface ActionFacts {
  title: string;
  main: Fact;
  detailsHeading?: string;
  details: Fact[];
  note?: string;
  url: string;
  linkLabel: string;
}

const proxyDocument = "https://www.town.yamada.iwate.jp/fs/1/0/9/0/6/6/_/___.pdf";
const busOperator = "https://www.iwate-kenpokubus.co.jp/";

export function actionFacts(question: string, sources: Source[]): ActionFacts | undefined {
  const wording = normalizeQuery(question).normalize("NFKC");
  if (/住民票/.test(wording) && /マイナンバー|まいなんばー|個人番号/.test(wording) &&
      /代理|委任状|代わり/.test(wording) && /受け取|受取|窓口|申請/.test(wording) &&
      !/手数料|本人確認書類|比較|郵送請求/.test(wording)) {
    const source = sources.find(({ url }) => url?.split("#")[0] === proxyDocument);
    const text = source?.text?.normalize("NFKC") ?? "";
    const shipping = /本人の住所地、または居所として届け出ている場所に、(簡易書留)で送付/.exec(text);
    if (!source?.url || !shipping || !/本人の委任状で代理人が申請できます/.test(text) ||
        !/代理人へ窓口で交付されません/.test(text)) return;
    return {
      title: "個人番号入り住民票",
      main: { label: "受け取り", value: "本人へ" + shipping[1] },
      details: [
        { label: "代理人の手続き", value: "本人の委任状で窓口申請" },
        { label: "送付先", value: "本人の住所地・届け出た居所" },
      ],
      url: source.url,
      linkLabel: "町の委任状と記入上の注意（PDF）",
    };
  }

  if (!/\bF03\b/i.test(wording) || !/土日|土曜|日曜|祝日|休日/.test(wording) ||
      /運賃|料金|乗り換え|代替|別の便|比較|以外/.test(wording)) return;

  const source = sources.find(({ title, url, text }) => title === "山田町内線の定期便と山田駅前・山田病院の時刻" &&
    url?.startsWith(busOperator) && text?.includes("F03は土日祝"));
  const times = /山田駅前から鯨科学館前に停まる夕方の便はF03で、山田駅前(\d{1,2}:\d{2})発、鯨科学館前(\d{1,2}:\d{2})着/.exec(source?.text ?? "");
  const closures = /F03は土日祝(?:、([^。]+))?は運休する/.exec(source?.text ?? "");
  if (!source?.url || !times || !closures) return;

  return {
    title: "山田町内線 F03",
    main: { label: "土日・祝日", value: "運休" },
    detailsHeading: "平日の通常時刻",
    details: [
      { label: "山田駅前", value: times[1] + " 発" },
      { label: "鯨科学館前", value: times[2] + " 着" },
    ],
    note: closures[1] ? closures[1] + "も運休" : undefined,
    url: source.url,
    linkLabel: "岩手県北バスの時刻表（PDF）",
  };
}
