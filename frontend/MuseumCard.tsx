import type { Source } from "./types";
import { normalizeQuery } from "../shared/query.js";

const facility = "鯨と海の科学館";
const officialUrl = "https://yamada-kujirakan.jp/facility/";

type MuseumFacts =
  | { kind: "fee"; adult: string; students?: string; children?: string }
  | { kind: "hours"; hours: string; lastEntry: string; closed: string; extraClosures?: string }
  | { kind: "route"; station: string; walk: string };

export function museumFacts(question: string, sources: Source[]): MuseumFacts | undefined {
  const input = normalizeQuery(question).normalize("NFKC");
  if (!/科学館|くじら館/.test(input) ||
      /比較|比べ|くらべ|どちら|おいすた|道の駅|車[いイ]す|くるまいす|車椅子|バリアフリー|予約|ごみ|以外|いがい/.test(input)) return;

  const route = /行き方|どう行|アクセス|最寄り|徒歩|歩い|行け|行けば/.test(input);
  const hours = /開館|閉館|営業時間|最終入館|休館|何時|開いて|開き/.test(input);
  const fee = /料金|入館料|入場料|いくら|値段/.test(input);
  if (Number(route) + Number(hours) + Number(fee) !== 1) return;
  if (route && (/車で|車なら|くるまで|くるまなら|駐車|バス|ばす|タクシー|たくしー/.test(input) ||
      (/から/.test(input) && !/(岩手船越駅|最寄り駅)$/.test(input.split("から")[0].trimEnd())))) return;
  if (hours && /今日|きょう|明日|あした|明後日|あさって|今週|こんしゅう|来週|らいしゅう|年末年始|祝日|しゅくじつ|大型連休|[月火水木金土日]曜|(?:げつ|か|すい|もく|きん|ど|にち)ようび|\d+月|臨時/.test(input)) return;
  if (fee && /団体|だんたい|割引|わりびき|無料|むりょう|学生|がくせい|高校|中学|小学|子ども|子供|こども|幼児|ようじ/.test(input)) return;

  for (const hit of sources) {
    if (hit.url !== officialUrl || !hit.text) continue;
    const text = hit.text.normalize("NFKC");
    if (route && hit.title === facility + "へのアクセス") {
      const found = text.match(/(岩手船越駅)から徒歩(約\s*\d+分)/);
      if (found) return { kind: "route", station: found[1], walk: "徒歩 " + found[2] };
    }
    if (hours && hit.title === facility + "の開館時間・休館日") {
      const opening = text.match(/開館時間は\s*(\d{1,2}:\d{2})\s*[〜～~–−-]\s*(\d{1,2}:\d{2})/);
      const last = text.match(/最終入館は\s*(\d{1,2}:\d{2})/);
      const closed = text.match(/([月火水木金土日]曜日)は休館(?:\(([^。)]+)\))?/);
      const extra = text.match(/。([^。]+も休館する)。/);
      if (opening && last && closed) {
        return {
          kind: "hours", hours: opening[1] + "〜" + opening[2], lastEntry: last[1],
          closed: closed[1] + (closed[2] ? `（${closed[2]}）` : ""),
          extraClosures: extra?.[1],
        };
      }
    }
    if (fee && hit.title === facility + "の入館料") {
      const general = text.match(/一般料金は([^。]+)/)?.[1] ?? "";
      const adult = general.match(/大人\s*([\d,]+円)/)?.[1];
      const students = general.match(/高校生・学生\s*([\d,]+円)/)?.[1];
      const children = general.match(/小中学生\s*([\d,]+円)/)?.[1];
      if (adult) return { kind: "fee", adult, students, children };
    }
  }
}

export default function MuseumCard({ facts }: { facts: MuseumFacts }) {
  return (
    <section className="answer-card museum-card" aria-label={facility + "の案内"}>
      <h3>{facts.kind === "route" ? "科学館への行き方" : facility}</h3>
      {facts.kind === "route" ? (
        <dl className="route-steps">
          <div className="route-stop"><dt>出発</dt><dd>{facts.station}</dd></div>
          <div className="route-walk"><dt className="visually-hidden">移動の目安</dt><dd>{facts.walk}</dd></div>
          <div className="route-stop route-arrival"><dt>到着</dt><dd>{facility}</dd></div>
        </dl>
      ) : facts.kind === "hours" ? (
        <dl className="facility-facts">
          <div className="main-fact"><dt>通常の開館時間</dt><dd>{facts.hours}</dd></div>
          <div><dt>最終入館</dt><dd>{facts.lastEntry}</dd></div>
          <div><dt>休館日</dt><dd>{facts.closed}</dd></div>
        </dl>
      ) : (
        <dl className="facility-facts">
          <div className="main-fact"><dt>大人の一般入館料</dt><dd>{facts.adult}</dd></div>
          {facts.students && <div><dt>高校生・学生</dt><dd>{facts.students}</dd></div>}
          {facts.children && <div><dt>小中学生</dt><dd>{facts.children}</dd></div>}
        </dl>
      )}
      {facts.kind === "hours" && facts.extraClosures && <p className="facility-note">{facts.extraClosures}。</p>}
      <a className="facility-link" href={officialUrl} target="_blank" rel="noopener">
        公式の施設情報を見る <span aria-hidden="true">↗</span>
      </a>
    </section>
  );
}
