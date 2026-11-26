import type { ActionFacts } from "./actionFacts";

export default function GuideActionCard({ facts }: { facts: ActionFacts }) {
  return (
    <section className="answer-card action-card" aria-label={facts.title}>
      <h3>{facts.title}</h3>
      <dl className="facility-facts">
        <div className="main-fact"><dt>{facts.main.label}</dt><dd>{facts.main.value}</dd></div>
      </dl>
      <div>
        {facts.detailsHeading && <p className="facility-note">{facts.detailsHeading}</p>}
        <dl className="facility-facts">
          {facts.details.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        {facts.note && <p className="facility-note">{facts.note}</p>}
      </div>
    </section>
  );
}
