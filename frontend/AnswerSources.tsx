import type { Source } from "./types";

export function linkFor(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    // URLを開けない場合も出典名を表示する。
  }
}

interface SourceGroup {
  href?: string;
  entries: Source[];
}

export function groupSources(sources: Source[]): SourceGroup[] {
  const byUrl = new Map<string, SourceGroup>();
  sources.forEach((source, index) => {
    const href = linkFor(source.url);
    const key = href ?? String(index);
    const group = byUrl.get(key);
    if (group) group.entries.push(source);
    else byUrl.set(key, { href, entries: [source] });
  });
  return [...byUrl.values()];
}

export function answerWithSources(answer: string, groups: SourceGroup[]) {
  if (!groups.length) return answer;
  const citations = groups.map(({ href, entries }) =>
    "・" + entries[0].source + (href ? "\n" + href : ""));
  return [answer.trimEnd(), "出典\n" + citations.join("\n")].join("\n\n");
}

export default function AnswerSources({ groups, id, open }: { groups: SourceGroup[]; id: string; open: boolean }) {
  return (
    <div className="sources-list" id={id} hidden={!open}>
      {groups.map(({ href, entries }, index) => (
        <article key={href ?? index} className="source">
          {entries.map((entry, section) => {
            const excerpt = entry.text?.replace(/\n\s*\|\s*\n/g, " ").trim();
            return (
              <div key={section} className="source-section">
                <h3>{entry.title}</h3>
                {excerpt && <p className="source-excerpt">{excerpt}</p>}
                {(entry.published || entry.checked) && (
                  <p className="source-detail">
                    {[entry.published && "掲載 " + entry.published, entry.checked && "確認 " + entry.checked]
                      .filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
            );
          })}
          {href ? (
            <a className="source-link" href={href} target="_blank" rel="noopener">
              <span>{entries[0].source}</span><span aria-hidden="true">↗</span>
            </a>
          ) : <p className="source-detail">{entries[0].source}</p>}
        </article>
      ))}
    </div>
  );
}
