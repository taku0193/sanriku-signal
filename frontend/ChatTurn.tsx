import { useLayoutEffect, useRef, useState } from "react";
import AnswerText from "./AnswerText";
import type { ProgressStage, Turn } from "./types";

const progressLabels: Record<ProgressStage, string> = {
  planning: "質問を確認しています…",
  searching: "山田町の資料を探しています…",
  reviewing: "資料を確認して回答をまとめています…",
  generating: "回答を生成しています…",
};

function linkFor(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    // URLを開けない場合も出典名を表示する。
  }
}

interface ChatTurnProps {
  turn: Turn;
  onRestore: (question: string) => void;
}

export default function ChatTurn({ turn, onRestore }: ChatTurnProps) {
  const result = turn.result;
  const { stage, searchDetail } = turn;
  let progressLabel = progressLabels[stage];
  if (searchDetail && stage === "searching") progressLabel = `「${searchDetail}」の資料を探しています…`;
  if (searchDetail && stage === "reviewing") progressLabel = `「${searchDetail}」の資料を確認しています…`;
  const sources = result?.sources ?? [];
  const photos = result?.photos ?? [];
  const copyText = result?.mode === "ai" ? result.answer : result?.prompt ?? "";
  const [copyStatus, setCopyStatus] = useState("");
  const [showCopyField, setShowCopyField] = useState(false);
  const copyField = useRef<HTMLTextAreaElement>(null);

  function selectCopyField() {
    copyField.current?.focus();
    copyField.current?.select();
  }

  useLayoutEffect(() => {
    if (showCopyField) selectCopyField();
  }, [showCopyField]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyStatus("コピーしました");
    } catch {
      if (showCopyField) selectCopyField();
      else setShowCopyField(true);
      setCopyStatus("選択した内容をコピーしてください");
    }
  }

  const rowClass = [
    "message-main",
    result && "result-ready",
    turn.preview && result?.action === "answer" && "has-streamed",
  ].filter(Boolean).join(" ");

  return (
    <article className="turn">
      <p className="user-message" aria-label="あなたの質問">{turn.question}</p>
      <div className="guide-message">
        <span className="guide-mark" aria-hidden="true"></span>
        <div className={rowClass}>
          <h2 className="message-label" tabIndex={-1}>やまだ案内</h2>
          <div className="message-content" aria-live="polite">
            {result ? (
              <>
                {result.notice && <p className="notice">{result.notice}</p>}
                {result.answer ? <AnswerText text={result.answer} /> :
                  result.mode === "search" && <p>質問に関連する資料が見つかりました。</p>}
              </>
            ) : turn.failure ? (
              <>
                {turn.failure.partial && <AnswerText text={turn.failure.partial} />}
                <p className={turn.failure.stopped ? "stopped" : "message-error"} role={turn.failure.stopped ? "status" : "alert"}>
                  {turn.failure.message}
                </p>
              </>
            ) : (
              <>
                <p className="message-status">
                  <span className="activity-dots" aria-hidden="true"><span></span><span></span><span></span></span>
                  <span key={progressLabel} className="progress-caption">{progressLabel}</span>
                </p>
                <p className="streaming-answer" aria-hidden="true" hidden={!turn.preview}>{turn.preview}</p>
              </>
            )}
          </div>

          {photos.length > 0 && (
            <div className="answer-photos">
              {photos.map((photo) => (
                <figure key={photo.page} className="answer-photo">
                  <img src={photo.src} alt={photo.alt} width={photo.width} height={photo.height} loading="lazy" decoding="async" />
                  <figcaption>
                    <strong>{photo.title}</strong>
                    <span className="answer-photo-meta">
                      {photo.taken} · <a href={linkFor(photo.page)} target="_blank" rel="noopener">{photo.author}</a>
                      {" · "}<a href={linkFor(photo.license_url)} target="_blank" rel="noopener">{photo.license}</a>
                      {" · 縮小・WebP変換"}
                    </span>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}

          {sources.length > 0 && (
            <details className="sources" open={result?.mode === "search"}>
              <summary>出典 {sources.length} 件</summary>
              <div className="sources-list">
                {sources.map((source, index) => {
                  const link = linkFor(source.url);
                  const excerpt = source.text?.replace(/\n\s*\|\s*\n/g, " ").replace(/\s+/g, " ").trim();
                  return (
                    <article key={index} className="source">
                      <h3>{source.title}</h3>
                      {excerpt && <p className="source-excerpt">{excerpt}</p>}
                      <p className="source-detail">
                        {link ? <a href={link} target="_blank" rel="noopener">{source.source}</a> : source.source}
                        {source.published && <> · 掲載日 {source.published}</>}
                        {source.checked && <> · 確認日 {source.checked}</>}
                      </p>
                    </article>
                  );
                })}
              </div>
            </details>
          )}

          {copyText && (
            <div className="message-tools">
              <button type="button" className="quiet-button" onClick={copy}>
                {result?.mode === "ai" ? "回答をコピー" : "質問と資料をコピー"}
              </button>
              <span className="copy-status" role="status">{copyStatus}</span>
            </div>
          )}
          {showCopyField && <textarea ref={copyField} className="copy-field" rows={3} aria-label="コピーする内容" value={copyText} readOnly />}
          {turn.failure && (
            <button type="button" className="quiet-button" onClick={() => onRestore(turn.question)}>
              質問を入力欄に戻す
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
