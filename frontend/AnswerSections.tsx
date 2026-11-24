import { linkFor } from "./AnswerSources";
import AnswerText from "./AnswerText";
import type { AnswerPresentation, Source } from "./types";

export default function AnswerSections({ presentation, sources }: { presentation: AnswerPresentation; sources: Source[] }) {
  return (
    <div className="answer-prose answer-sections">
      {presentation.conclusion && (
        <div className="answer-conclusion"><AnswerText text={presentation.conclusion} /></div>
      )}
      {presentation.sections.map(({ label, text, sourceIndexes }) => {
        const links = new Map<string, Source>();
        for (const index of sourceIndexes) {
          const source = sources[index];
          const href = source && linkFor(source.url);
          if (href && !links.has(href)) links.set(href, source);
        }
        return (
          <section className={sourceIndexes.length ? "answer-section" : "answer-section unconfirmed"} key={label}>
            <h3>{label}</h3>
            <div className="answer-section-text"><AnswerText text={text} /></div>
            {links.size > 0 && (
              <div className="answer-section-links">
                {[...links.entries()].map(([href, source]) => (
                  <a className="section-source" key={href} href={href} target="_blank" rel="noopener"
                    aria-label={`${label}の出典 ${source.title}（新しいタブ）`}>
                    <span>{source.source}</span><span aria-hidden="true">↗</span>
                  </a>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
