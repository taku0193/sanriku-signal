import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { loadMode, requestAnswer } from "./api";
import ChatTurn from "./ChatTurn";
import CoastHero from "./CoastHero";
import { searchOffline } from "./offline";
import type { OfflineData } from "./offline";
import type { Pending, QuestionAndAnswer, Turn } from "./types";

const entryTitle = document.title;
const nicknameKey = "yamada-guide-nickname";
const nicknameLimit = 24;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const examples = [
  ["科学館へはどう行く？", "岩手船越駅からのアクセス", "岩手船越駅から鯨と海の科学館への行き方は？"],
  ["ごみはいつ出せる？", "地区ごとの収集日", "うちの地区のごみ収集日はいつですか？"],
  ["科学館の入館料", "大人・学生・小中学生", "鯨と海の科学館の大人の入館料は？"],
  ["科学館は何時まで？", "開館時間・休館日", "鯨と海の科学館の通常の開館時間と休館日を教えてください。"],
];

function savedNickname(): string {
  try {
    const name = sessionStorage.getItem(nicknameKey)?.trim() ?? "";
    return name.length <= nicknameLimit ? name : "";
  } catch {
    return "";
  }
}

function pageUrls(offline: boolean) {
  const entry = new URL(offline ? location.href : "/", location.href);
  entry.hash = "";
  return { entry, chat: new URL(offline ? "#chat" : "/chat", entry) };
}

export default function App({ offlineData }: { offlineData?: OfflineData }) {
  const [urls] = useState(() => pageUrls(Boolean(offlineData)));
  const [entryName, setEntryName] = useState(savedNickname);
  const nicknameRef = useRef(entryName);
  const [inChat, setInChat] = useState(false);
  const [mode, setMode] = useState(offlineData ? "資料検索モード" : "");
  const [entryError, setEntryError] = useState("");
  const [draft, setDraft] = useState("");
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [showJump, setShowJump] = useState(false);
  const hasTurns = turns.length > 0;

  const nameField = useRef<HTMLInputElement>(null);
  const chatHeading = useRef<HTMLHeadingElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const questionField = useRef<HTMLTextAreaElement>(null);
  const conversation = useRef<HTMLElement>(null);
  const scrollRegion = useRef<HTMLDivElement>(null);
  const active = useRef<AbortController | null>(null);
  const nextTurnId = useRef(0);
  const recentTurns = useRef<QuestionAndAnswer[]>([]);
  const focusAfterRoute = useRef(false);
  const focusNextAnswer = useRef(false);
  const scrollAfterRender = useRef<"bottom" | "result" | "keep" | "top" | null>(null);
  const previousComposer = useRef<DOMRect | null>(null);

  function readRoute(focus = false) {
    const wantsChat = offlineData ? location.hash === "#chat" : location.pathname === urls.chat.pathname;
    const openChat = wantsChat && nicknameRef.current !== "";
    if (wantsChat && !openChat) history.replaceState(null, "", urls.entry);
    if (!openChat) active.current?.abort();
    focusAfterRoute.current = focus;
    setInChat(openChat);
  }

  useLayoutEffect(() => {
    readRoute();
    const onBackOrForward = () => readRoute(true);
    window.addEventListener("popstate", onBackOrForward);
    return () => {
      window.removeEventListener("popstate", onBackOrForward);
      active.current?.abort();
    };
  }, [urls, offlineData]);

  useEffect(() => {
    if (!offlineData) void loadMode().then(setMode);
  }, [offlineData]);

  useLayoutEffect(() => {
    document.title = inChat ? "やまだ案内 | チャット" : entryTitle;
    if (!focusAfterRoute.current) return;
    focusAfterRoute.current = false;
    const field = inChat ? (hasTurns ? questionField.current : chatHeading.current) : nameField.current;
    field?.focus({ preventScroll: true });
  }, [inChat]);

  useLayoutEffect(() => {
    const field = questionField.current;
    if (!field || !inChat) return;
    field.style.height = "";
    field.style.height = `${Math.min(field.scrollHeight, 144)}px`;
  }, [draft, inChat]);

  useLayoutEffect(() => {
    const before = previousComposer.current;
    previousComposer.current = null;
    const form = composer.current;
    if (!form || !before) return;
    const after = form.getBoundingClientRect();
    if (!after.width || !after.height) return;

    const deltaX = before.x - after.x;
    const deltaY = before.y - after.y;
    const widthRatio = before.width / after.width;
    const heightRatio = before.height / after.height;
    form.animate([
      { transform: `translate(${deltaX}px, ${deltaY}px) scale(${widthRatio}, ${heightRatio})` },
      { transform: "none" },
    ], { duration: 420, easing: "cubic-bezier(.2,.75,.25,1)" });
  }, [hasTurns]);

  useLayoutEffect(() => {
    const scrolling = scrollAfterRender.current;
    scrollAfterRender.current = null;
    const region = scrollRegion.current;
    if (region && scrolling) {
      if (scrolling === "bottom") region.scrollTop = region.scrollHeight;
      if (scrolling === "result") region.scrollTop = latestScrollTop(region);
      if (scrolling === "top") region.scrollTop = 0;
      updateJumpLatest();
    }
    if (focusNextAnswer.current) {
      focusNextAnswer.current = false;
      focusLastMessage();
    }
  });

  function navigate(url: URL) {
    history.pushState(null, "", url);
    readRoute(true);
  }

  function focusLastMessage() {
    conversation.current?.lastElementChild?.querySelector<HTMLElement>(".message-label")?.focus({ preventScroll: true });
  }

  function bottomIsVisible(): boolean {
    const region = scrollRegion.current;
    return !region || region.scrollHeight - region.scrollTop - region.clientHeight < 80;
  }

  function latestScrollTop(region: HTMLElement): number {
    const bottom = region.scrollHeight - region.clientHeight;
    const result = conversation.current?.lastElementChild?.querySelector(".result-ready");
    if (!result) return bottom;
    const start = region.scrollTop + result.getBoundingClientRect().top - region.getBoundingClientRect().top;
    return Math.max(0, Math.min(bottom, start - 12));
  }

  function updateJumpLatest() {
    const region = scrollRegion.current;
    setShowJump(Boolean(hasTurns && region && region.scrollTop + 80 < latestScrollTop(region)));
  }

  function jumpToLatest() {
    const region = scrollRegion.current;
    if (!region) return;
    focusLastMessage();
    region.scrollTo({
      top: latestScrollTop(region),
      behavior: reducedMotion.matches ? "auto" : "smooth",
    });
    updateJumpLatest();
  }

  function prepareComposerTransition() {
    const form = composer.current;
    if (!form?.animate || reducedMotion.matches) return;
    const before = form.getBoundingClientRect();
    form.getAnimations().forEach((animation) => animation.cancel());
    if (before.width && before.height) previousComposer.current = before;
  }

  function updateTurn(id: number, change: Partial<Pick<Turn, "stage" | "searchDetail" | "preview" | "result" | "failure">>) {
    scrollAfterRender.current = bottomIsVisible() ? (change.result ? "result" : "bottom") : "keep";
    setTurns((current) => current.map((turn) => turn.id === id ? { ...turn, ...change } : turn));
  }

  function resetConversation() {
    active.current?.abort();
    active.current = null;
    recentTurns.current = [];
    scrollAfterRender.current = "top";
    setTurns([]);
    setBusy(false);
    setPending(null);
    setDraft("");
    setFormError("");
    setShowJump(false);
  }

  function enter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = nameField.current?.value.trim() ?? "";
    if (!name || name.length > nicknameLimit) {
      setEntryError("ニックネームは1〜24文字で入力してください。");
      nameField.current?.focus();
      return;
    }
    if (nicknameRef.current !== name) resetConversation();
    nicknameRef.current = name;
    setEntryName(name);
    setEntryError("");
    try {
      sessionStorage.setItem(nicknameKey, name);
    } catch {
      // ストレージを使えない場合も、開いているページ内で名前を使う。
    }
    navigate(urls.chat);
  }

  async function send(query: string, fromExample = false) {
    if (active.current || !inChat) return;
    if (!query) {
      setFormError(pending ? "地区名を入力してください。" : "質問を入力してください。");
      questionField.current?.focus();
      return;
    }

    if (!hasTurns) prepareComposerTransition();
    const id = ++nextTurnId.current;
    const controller = new AbortController();
    const currentPending = pending;
    const history = recentTurns.current;
    active.current = controller;
    focusNextAnswer.current = fromExample;
    const region = scrollRegion.current;
    const lastTurn = conversation.current?.lastElementChild;
    const readingPast = region && lastTurn && !bottomIsVisible() &&
      lastTurn.getBoundingClientRect().top > region.getBoundingClientRect().top;
    scrollAfterRender.current = readingPast ? "keep" : "bottom";
    setTurns((current) => [...current, { id, question: query, stage: "planning", preview: "", result: null, failure: null }]);
    setDraft("");
    setFormError("");
    setBusy(true);

    let partial = "";
    let frame: number | undefined;
    function cancelPreviewFrame() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    }

    try {
      const result = offlineData
        ? searchOffline(query, offlineData)
        : await requestAnswer({ question: query, pending: currentPending, history }, controller.signal, (event) => {
          if (active.current !== controller || controller.signal.aborted) return;
          if (event.type === "progress") {
            cancelPreviewFrame();
            partial = "";
            updateTurn(id, { stage: event.stage, searchDetail: event.detail, preview: "" });
          } else {
            partial += event.text;
            if (frame === undefined) {
              frame = requestAnimationFrame(() => {
                frame = undefined;
                if (active.current === controller) updateTurn(id, { stage: "generating", preview: partial });
              });
            }
          }
        });
      if (active.current !== controller) return;
      updateTurn(id, { result });
      setPending(result.pending ?? null);
      if (result.mode === "ai" && result.action === "answer") {
        recentTurns.current = [...history, {
          question: currentPending?.question ?? query,
          answer: [...result.answer].slice(0, 700).join(""),
        }].slice(-2);
      }
    } catch (error) {
      if (active.current !== controller) return;
      const stopped = controller.signal.aborted;
      let message = "サーバーに接続できませんでした。接続を確認して、もう一度お試しください。";
      if (stopped) message = "回答を途中で停止しました。";
      else if (error instanceof Error && !(error instanceof TypeError)) message = error.message;
      updateTurn(id, { failure: { message, stopped, partial: stopped ? partial.trim() : "" } });
    } finally {
      cancelPreviewFrame();
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(questionField.current?.value.trim() ?? "");
  }

  function onQuestionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229 || event.shiftKey) return;
    event.preventDefault();
    if (!busy && event.currentTarget.value.trim()) composer.current?.requestSubmit();
  }

  function newChat() {
    if (hasTurns) prepareComposerTransition();
    resetConversation();
    questionField.current?.focus();
  }

  function restoreQuestion(question: string) {
    setDraft(question);
    questionField.current?.focus();
  }

  function skipFollowUp() {
    setPending(null);
    setFormError("");
    questionField.current?.focus();
  }

  const appClass = ["app", inChat && "in-chat", hasTurns && "in-conversation"].filter(Boolean).join(" ");
  const brand = (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true"></span>
      <div><strong>やまだ案内</strong><small>岩手県山田町</small></div>
    </div>
  );
  const entryForm = (
    <form id="entry-form" className="entry-form" onSubmit={enter}>
      <label htmlFor="nickname">ニックネーム</label>
      <div className="entry-input-row">
        <input ref={nameField} id="nickname" type="text" maxLength={nicknameLimit} autoComplete="nickname" required
          placeholder="例　なぎ" aria-describedby="entry-error" value={entryName}
          onChange={(event) => {
            setEntryName(event.currentTarget.value);
            setEntryError("");
          }} />
        <button type="submit" className="enter-button">案内へ進む <span aria-hidden="true">→</span></button>
      </div>
      <p id="entry-error" className="form-error" role="alert" hidden={!entryError}>{entryError}</p>
    </form>
  );
  return (
    <div className={appClass}>
      <header className="site-header" hidden={!inChat}>
        <div className="wide header-inner">
          {brand}
          <div id="chat-header" className="header-actions">
            <p id="mode" className="mode" hidden={!mode}>{mode}</p>
            <button id="new-chat" type="button" className="header-button" aria-label="新しい会話" onClick={newChat}>
              <span className="plus" aria-hidden="true"></span><span>新規</span>
            </button>
            <button id="back-to-entry" type="button" className="header-button" aria-label="案内の入口へ戻る"
              onClick={() => navigate(urls.entry)}>入口</button>
          </div>
        </div>
      </header>

      <main id="entry-screen" className="entry-screen" hidden={inChat}>
        {!inChat && (
          <CoastHero poster={offlineData?.heroImage ?? "/sanriku-coast.webp"}
            source={offlineData ? offlineData.heroVideo : "/sanriku-coast.mp4"} brand={brand} entryForm={entryForm}>
            <div className="welcome-copy">
              <h1 id="page-title">
                <span className="title-line"><span>山田町のことを、</span></span>
                <span className="title-line"><span>聞いてみる。</span></span>
              </h1>
              <p>観光や交通、くらしの疑問に、<br />地域の資料をもとにお答えします。</p>
            </div>
          </CoastHero>
        )}
      </main>

      <main id="chat-screen" className="chat-screen" hidden={!inChat}>
        <div className="guide">
          <div className="chat-timeline">
            <div ref={scrollRegion} id="scroll-region" className="scroll-region" onScroll={updateJumpLatest}>
              <section id="welcome" className="chat-welcome content" aria-labelledby="chat-heading" hidden={hasTurns}>
                <div className="welcome-photo">
                  <img src={offlineData?.heroImage ?? "/sanriku-coast.webp"} alt="" />
                  <div className="chat-welcome-copy">
                    <p>岩手県山田町</p>
                    <h1 ref={chatHeading} id="chat-heading" tabIndex={-1}>山田町で、<br />何を知りたいですか？</h1>
                  </div>
                </div>
                <div className="suggestions-heading" id="examples-label">質問例</div>
                <div className="examples" aria-labelledby="examples-label" role="group">
                  {examples.map(([label, detail, question]) => (
                    <button key={question} className="example" type="button" onClick={() => void send(question, true)}>
                      <span className="example-text"><strong>{label}</strong><small>{detail}</small></span>
                      <span className="example-arrow" aria-hidden="true">→</span>
                    </button>
                  ))}
                </div>
              </section>
              <section ref={conversation} id="conversation" className="conversation content" aria-label="会話" hidden={!hasTurns}>
                {turns.map((turn) => <ChatTurn key={turn.id} turn={turn} onRestore={restoreQuestion} />)}
              </section>
            </div>
            <button id="jump-latest" className="jump-latest" type="button" aria-controls="conversation" hidden={!showJump} onClick={jumpToLatest}>
              <span aria-hidden="true">↓</span> 最新のメッセージへ
            </button>
          </div>

          <div className="composer-area chat-dock">
            <div className="content">
              <form ref={composer} id="question-form" className="composer" onSubmit={submitQuestion}>
                <label className="visually-hidden" htmlFor="question">山田町について質問する</label>
                <div id="follow-up" className="follow-up" hidden={!pending}>
                  <span>地区の確認に返信</span>
                  <button id="skip-follow-up" className="quiet-button" type="button" disabled={busy} onClick={skipFollowUp}>別の質問へ</button>
                </div>
                <div className="input-row">
                  <textarea ref={questionField} id="question" name="question" rows={1} maxLength={400} required
                    placeholder={pending ? "地区名や目印を入力する" : "山田町について質問する"}
                    value={draft} onKeyDown={onQuestionKeyDown} onChange={(event) => {
                      setDraft(event.currentTarget.value);
                      setFormError("");
                    }} />
                  <button id="submit" className="send-button" type="submit" aria-label="質問を送信" title="質問を送信" hidden={busy} disabled={!draft.trim()}>
                    <span className="send-icon" aria-hidden="true"></span>
                  </button>
                  <button id="stop" className="send-button stop-button" type="button" aria-label="回答を停止" title="回答を停止" hidden={!busy}
                    onClick={() => active.current?.abort()}>
                    <span className="stop-icon" aria-hidden="true"></span><span>停止</span>
                  </button>
                </div>
                <p id="form-error" className="form-error" role="alert" hidden={!formError}>{formError}</p>
              </form>
              <p className="composer-foot">
                <a href="https://www.town.yamada.iwate.jp/" target="_blank" rel="noopener">山田町公式サイト <span aria-hidden="true">↗</span></a>
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
