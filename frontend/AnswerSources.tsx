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

function groupSources(sources: Source[]) {
  const byUrl = new Map<string, { href?: string; entries: Source[] }>();
  sources.forEach((source, index) => {
    const href = linkFor(source.url);
    const key = href ?? String(index);
    const group = byUrl.get(key);
    if (group) group.entries.push(source);
    else byUrl.set(key, { href, entries: [source] });
  });
  return [...byUrl.values()];
}

export default function AnswerSources({ sources, direct, expanded }: {
  sources: Source[]; direct: boolean; expanded: boolean;
}) {
  const groups = groupSources(sources);
  if (!groups.length) return null;
  const primary = direct ? groups.find(({ href }) => href) : undefined;
  return (
    <div className="answer-sources">
      {primary && (
        <a className="primary-source" href={primary.href} target="_blank" rel="noopener"
          aria-label={primary.entries[0].title + "を開く（新しいタブ）"}>
          <span>出典を開く</span><span aria-hidden="true">↗</span>
        </a>
      )}
      <details className="sources" open={expanded || undefined}>
        <summary>出典 {groups.length}件</summary>
        <div className="sources-list">
          {groups.map(({ href, entries }, index) => (
            <article key={href ?? index} className="source">
              {entries.map((entry, section) => {
                const excerpt = entry.text?.replace(/\n\s*\|\s*\n/g, " ").replace(/\s+/g, " ").trim();
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
      </details>
    </div>
  );
}
