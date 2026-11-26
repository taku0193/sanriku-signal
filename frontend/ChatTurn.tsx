import { useId, useLayoutEffect, useRef, useState } from "react";
import AnswerSections from "./AnswerSections";
import AnswerSources, { answerWithSources, groupSources, linkFor } from "./AnswerSources";
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

type AnswerPanel = "sources" | "photos" | "facts";

export default function ChatTurn({ turn, onRestore, onRetry }: ChatTurnProps) {
  const result = turn.result;
  const { stage, searchDetail } = turn;
  const sources = result?.sources ?? [];
  const sourceGroups = groupSources(sources);
  const presentation = result?.presentation;
  const nextAction = !presentation && result?.action === "answer"
    ? actionFacts([turn.followUpQuestion, turn.question].filter(Boolean).join("\n"), sources) : undefined;
  const facts = result?.mode === "search" && result.action === "search" && !result.notice && !result.answer
    ? museumFacts(turn.question, sources) : undefined;
  const waiting = !result && !turn.failure;
  const streaming = waiting && Boolean(turn.preview);
  const responseText = result?.answer ?? turn.failure?.partial ?? turn.preview;
  const photos = result?.photos ?? [];
  const primarySource = result?.action === "answer" && !presentation && sourceGroups.length === 1 ? sourceGroups[0] : undefined;
  const directSource = nextAction ? { href: linkFor(nextAction.url), label: nextAction.linkLabel } :
    primarySource?.href ? { href: primarySource.href, label: "出典を開く", title: primarySource.entries[0].title } : undefined;
  const copyText = result?.mode === "ai"
    ? result.action === "answer" && result.answer ? answerWithSources(result.answer, sourceGroups) : ""
    : result?.prompt ?? "";
  const copyLabel = result?.mode === "search" ? "質問と資料をコピー" :
    sourceGroups.length ? "回答と出典をコピー" : "回答をコピー";
  const id = useId();
  const [selectedPanel, setSelectedPanel] = useState<AnswerPanel | null>();
  const asksForPhoto = /(?:写真|画像)(?:も|を|が|は)?(?:見せ|見たい|あります)/.test(turn.question);
  const defaultPanel = photos.length && asksForPhoto ? "photos" : result?.mode === "search" && !facts ? "sources" : null;
  const openPanel = selectedPanel === undefined ? defaultPanel : selectedPanel;
  const [copyStatus, setCopyStatus] = useState("");
  const [showCopyField, setShowCopyField] = useState(false);
  const copyField = useRef<HTMLTextAreaElement>(null);

  function selectCopyField() {
    copyField.current?.focus();
    copyField.current?.select();
  }

  function togglePanel(panel: AnswerPanel) {
    setSelectedPanel(openPanel === panel ? null : panel);
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
            {facts && <MuseumCard facts={facts} />}
            {presentation ? <AnswerSections presentation={presentation} sources={sources} /> : responseText && (
              <div className={streaming ? "answer-prose streaming-answer" : "answer-prose"}
                aria-hidden={streaming || undefined}>
                <AnswerText text={responseText} streaming={streaming || turn.failure?.stopped} />
              </div>
            )}
            {result?.mode === "search" && !facts && !responseText && <p>質問に関連する資料が見つかりました。</p>}
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

          {(sourceGroups.length > 0 || photos.length > 0 || copyText) && (
            <div className="message-tools">
              {directSource?.href && (
                <a className="primary-source" href={directSource.href} target="_blank" rel="noopener"
                  aria-label={directSource.title ? `${directSource.label}（${directSource.title}・新しいタブ）` : undefined}>
                  <span>{directSource.label}</span><span aria-hidden="true">↗</span>
                </a>
              )}
              {sourceGroups.length > 0 && (
                <button type="button" className="answer-disclosure quiet-button" aria-controls={id + "-sources"}
                  aria-expanded={openPanel === "sources"} onClick={() => togglePanel("sources")}>
                  {directSource?.href && sourceGroups.length === 1 ? "資料の抜粋" : `出典 ${sourceGroups.length}件`}
                </button>
              )}
              {copyText && (
                <button type="button" className="quiet-button" onClick={copy} aria-label={copyLabel} title={copyLabel}>
                  {result?.mode === "search" ? copyLabel : "コピー"}
                </button>
              )}
              {nextAction && (
                <button type="button" className="answer-disclosure quiet-button" aria-controls={id + "-facts"}
                  aria-expanded={openPanel === "facts"} onClick={() => togglePanel("facts")}>
                  資料の要点
                </button>
              )}
              {photos.length > 0 && (
                <button type="button" className="answer-disclosure quiet-button" aria-controls={id + "-photos"}
                  aria-expanded={openPanel === "photos"} onClick={() => togglePanel("photos")}>
                  現地の写真 {photos.length}枚
                </button>
              )}
              <span className={copyStatus ? "copy-status" : "visually-hidden"} role="status">{copyStatus}</span>
            </div>
          )}
          {showCopyField && <textarea ref={copyField} className="copy-field" rows={3} aria-label="コピーする内容" value={copyText} readOnly />}
          {sourceGroups.length > 0 && <AnswerSources groups={sourceGroups} id={id + "-sources"} open={openPanel === "sources"} />}
          {nextAction && <div id={id + "-facts"} className="answer-action-details" hidden={openPanel !== "facts"}>
            <GuideActionCard facts={nextAction} />
          </div>}

          {photos.length > 0 && (
            <div className="answer-photos" id={id + "-photos"} hidden={openPanel !== "photos"}>
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
