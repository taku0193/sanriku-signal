import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { loadMode, requestAnswer } from "./api";
import ChatTurn from "./ChatTurn";
import { searchOffline } from "./offline";
import type { OfflineData } from "./offline";
import type { Pending, QuestionAndAnswer, Turn } from "./types";

const entryTitle = document.title;
const nicknameKey = "yamada-guide-nickname";
const nicknameLimit = 24;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const examples = [
  ["科学館の入館料", "鯨と海の科学館の大人の入館料は？"],
  ["ごみの収集日", "大沢のプラスチックの収集日は？"],
  ["道の駅の営業時間", "道の駅やまだは何時まで開いてる？"],
  ["粗大ごみの予約", "粗大ごみの収集はどう予約する？"],
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
  const [nickname, setNickname] = useState(savedNickname);
  const nicknameRef = useRef(nickname);
  const [entryName, setEntryName] = useState(nickname);
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
  const scrollAfterRender = useRef<"bottom" | "keep" | "top" | null>(null);
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

  function updateJumpLatest() {
    setShowJump(hasTurns && !bottomIsVisible());
  }

  function jumpToLatest() {
    const region = scrollRegion.current;
    if (!region) return;
    focusLastMessage();
    region.scrollTo({
      top: region.scrollHeight,
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

  function updateTurn(id: number, change: Partial<Pick<Turn, "stage" | "preview" | "result" | "failure">>) {
    scrollAfterRender.current = bottomIsVisible() ? "bottom" : "keep";
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
    setNickname(name);
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
    scrollAfterRender.current = "bottom";
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
            updateTurn(id, { stage: event.stage, preview: "" });
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
  return (
    <div className={appClass}>
      <header className="site-header">
        <div className="wide header-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true"></span>
            <div><strong>やまだ案内</strong><small>岩手県山田町</small></div>
          </div>
          <div id="chat-header" className="header-actions" hidden={!inChat}>
            <p id="mode" className="mode" hidden={!mode}>{mode}</p>
          </div>
        </div>
      </header>

      <main id="entry-screen" className="guide" hidden={inChat}>
        <div className="scroll-region">
          <section className="welcome wide" aria-labelledby="page-title">
            <div className="welcome-copy">
              <h1 id="page-title">
                <span className="title-line"><span>山田町のことを、</span></span>
                <span className="title-line"><span>聞いてみる。</span></span>
              </h1>
              <p>観光や交通、くらしの疑問に、<br className="desktop-break" />地域の資料をもとにお答えします。</p>
            </div>
            <figure className="place">
              <img src={offlineData?.heroImage ?? "/yamada-bay.webp"} width={1200} height={900} alt="山田湾の向こうに山が連なる山田港の風景" />
              <figcaption>
                <span>山田湾・山田港</span>
                <span className="credit"><a href="https://commons.wikimedia.org/wiki/File:Port_yamada_20130601.JPG" target="_blank" rel="noopener">Opqr</a> /
                  <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a></span>
              </figcaption>
            </figure>
          </section>
        </div>

        <section className="composer-area entry-dock" aria-labelledby="entry-title">
          <div className="dock-inner wide">
            <div className="dock-intro">
              <h2 id="entry-title">案内をはじめる</h2>
              <p>チャット画面でお呼びする名前を入力してください。</p>
            </div>
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
          </div>
        </section>
      </main>

      <main id="chat-screen" className="chat-screen" hidden={!inChat}>
        <aside className="chat-rail" aria-label="会話の操作">
          <button id="new-chat" type="button" className="new-chat" onClick={newChat}>
            <span className="plus" aria-hidden="true"></span>新しい会話
          </button>
          <div className="chat-rail-bottom">
            <p id="profile-name" className="profile-name">{nickname}</p>
            <button id="back-to-entry" type="button" className="quiet-button" onClick={() => navigate(urls.entry)}>案内の入口へ戻る</button>
          </div>
        </aside>
        <div className="guide">
          <div className="chat-timeline">
            <div ref={scrollRegion} id="scroll-region" className="scroll-region" onScroll={updateJumpLatest}>
              <section id="welcome" className="chat-welcome content" aria-labelledby="chat-heading" hidden={hasTurns}>
                <span className="brand-mark" aria-hidden="true"></span>
                <h1 ref={chatHeading} id="chat-heading" tabIndex={-1}><span id="greeting-name">{nickname}</span>さん、こんにちは。</h1>
                <p>山田町について、何を知りたいですか？</p>
                <div className="examples" aria-label="質問例">
                  {examples.map(([label, question]) => (
                    <button key={question} className="example" type="button" onClick={() => void send(question, true)}>{label}</button>
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
                    <span className="stop-icon" aria-hidden="true"></span>
                  </button>
                </div>
                <p id="form-error" className="form-error" role="alert" hidden={!formError}>{formError}</p>
              </form>
              <p className="composer-foot">
                <span>学習用の試作です。最新情報は出典をご確認ください。</span>
                <a href="https://www.town.yamada.iwate.jp/" target="_blank" rel="noopener">山田町公式サイト <span aria-hidden="true">↗</span></a>
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
