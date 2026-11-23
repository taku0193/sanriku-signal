import { useLayoutEffect, useRef, useState } from "react";
import AnswerSources, { linkFor } from "./AnswerSources";
import AnswerText from "./AnswerText";
import { actionFacts } from "./actionFacts";
import GuideActionCard from "./GuideActionCard";
import MuseumCard, { museumFacts } from "./MuseumCard";
import type { ProgressStage, Turn } from "./types";

const progressLabels: Record<ProgressStage, string> = {
  planning: "質問を確認しています",
  searching: "地域の資料を探しています",
  reviewing: "見つけた資料を確認しています",
  generating: "回答をまとめています",
};

interface ChatTurnProps {
  turn: Turn;
  onRestore: (question: string) => void;
  onRetry?: () => void;
}

export default function ChatTurn({ turn, onRestore, onRetry }: ChatTurnProps) {
  const result = turn.result;
  const { stage, searchDetail } = turn;
  const sources = result?.sources ?? [];
  const nextAction = result?.action === "answer"
    ? actionFacts([turn.followUpQuestion, turn.question].filter(Boolean).join("\n"), sources) : undefined;
  const facts = !nextAction && (result?.action === "answer" || (result?.action === "search" && !result.notice))
    ? museumFacts(turn.question, sources) : undefined;
  const hasCard = Boolean(nextAction || facts);
  const waiting = !result && !turn.failure;
  const streaming = waiting && Boolean(turn.preview);
  const responseText = result?.answer ?? turn.failure?.partial ?? turn.preview;
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
    responseText && turn.preview && "has-streamed",
  ].filter(Boolean).join(" ");

  return (
    <article className="turn">
      <p className="user-message" aria-label="あなたの質問">{turn.question}</p>
      <div className="guide-message">
        <span className="guide-mark" aria-hidden="true"></span>
        <div className={rowClass}>
          <h2 className="message-label" tabIndex={-1}>やまだ案内</h2>
          <div className="message-content">
            <span className="visually-hidden" role="status">
              {result ? (result.action === "clarify" ? "確認の質問があります" : "結果を表示しました") :
                streaming ? "回答を表示しています" : waiting ? progressLabels[stage] : ""}
            </span>
            {result?.notice && <p className="notice">{result.notice}</p>}
            {nextAction ? <GuideActionCard facts={nextAction} /> : facts && <MuseumCard facts={facts} />}
            {responseText && (
              <div className={streaming ? "answer-prose streaming-answer" : "answer-prose"}
                aria-hidden={streaming || undefined}>
                <AnswerText text={responseText} streaming={streaming || turn.failure?.stopped} />
              </div>
            )}
            {result?.mode === "search" && !hasCard && !responseText && <p>質問に関連する資料が見つかりました。</p>}
            {waiting && !streaming && (
              <div className="message-status">
                <p>{progressLabels[stage]}</p>
                {searchDetail && (stage === "searching" || stage === "reviewing") &&
                  <p className="progress-detail">{searchDetail}</p>}
                <span className="progress-track" aria-hidden="true"></span>
              </div>
            )}
            {turn.failure && (
              <p className={turn.failure.stopped ? "stopped" : "message-error"} role={turn.failure.stopped ? "status" : "alert"}>
                {turn.failure.message}
              </p>
            )}
            {onRetry && <button type="button" className="quiet-button retry-button" onClick={onRetry}>AI回答を再試行</button>}
          </div>

          <AnswerSources sources={sources} direct={!hasCard && result?.mode === "ai"} expanded={result?.mode === "search" && !hasCard} />

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
