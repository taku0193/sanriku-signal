"use strict";

const app = document.querySelector(".app");
const form = document.querySelector("#question-form");
const question = document.querySelector("#question");
const submit = document.querySelector("#submit");
const stop = document.querySelector("#stop");
const newChat = document.querySelector("#new-chat");
const mode = document.querySelector("#mode");
const followUp = document.querySelector("#follow-up");
const skipFollowUp = document.querySelector("#skip-follow-up");
const formError = document.querySelector("#form-error");
const welcome = document.querySelector("#welcome");
const conversation = document.querySelector("#conversation");
const scrollRegion = document.querySelector("#scroll-region");
const standaloneData = document.querySelector("#standalone-data");
const offlineSearch = standaloneData && createOfflineSearch(JSON.parse(standaloneData.textContent));
const eventType = "application/x-ndjson";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const progressLabels = {
  planning: "質問を確認しています…",
  searching: "山田町の資料を探しています…",
  reviewing: "資料を確認して回答をまとめています…",
};

let pending = null;
let recentTurns = [];
let active = null;

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content) node.textContent = content;
  return node;
}

function showText(node, content) {
  node.textContent = content;
  node.hidden = !content;
}

function bottomIsVisible() {
  return scrollRegion.scrollHeight - scrollRegion.scrollTop - scrollRegion.clientHeight < 80;
}

function scrollToBottom() {
  scrollRegion.scrollTop = scrollRegion.scrollHeight;
}

function transitionComposer(update) {
  if (reducedMotion.matches || !form.animate) return update();
  const before = form.getBoundingClientRect();
  form.getAnimations().forEach((animation) => animation.cancel());
  const result = update();
  const after = form.getBoundingClientRect();
  const deltaX = before.x - after.x;
  const deltaY = before.y - after.y;
  const widthRatio = before.width / after.width;
  const heightRatio = before.height / after.height;
  form.animate([
    { transform: `translate(${deltaX}px, ${deltaY}px) scale(${widthRatio}, ${heightRatio})` },
    { transform: "none" },
  ], { duration: 420, easing: "cubic-bezier(.2,.75,.25,1)" });
  return result;
}

function updateProgress(progress, stage) {
  const label = progressLabels[stage];
  if (!label || progress.textContent === label) return;
  progress.textContent = label;
  if (reducedMotion.matches || !progress.animate) return;
  progress.getAnimations().forEach((animation) => animation.cancel());
  progress.animate([
    { opacity: .5, transform: "translateY(4px)" },
    { opacity: 1, transform: "translateY(0)" },
  ], { duration: 180, easing: "ease-out" });
}

function updateComposer() {
  question.style.height = "";
  question.style.height = `${Math.min(question.scrollHeight, 144)}px`;
  question.placeholder = pending ? "地区名や目印を入力する" : "山田町について質問する";
  followUp.hidden = !pending;
  skipFollowUp.disabled = Boolean(active);
  submit.hidden = Boolean(active);
  submit.disabled = !question.value.trim();
  stop.hidden = !active;
}

function appendInline(parent, text) {
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\*([^*\n]+)\*/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(text.slice(offset, match.index));
    const [, bold, code, italic] = match;
    parent.append(element(bold ? "strong" : code ? "code" : "em", "", bold || code || italic));
    offset = match.index + match[0].length;
  }
  parent.append(text.slice(offset));
}

function formatAnswer(body, text) {
  let paragraph = [];
  let list = null;
  function flushParagraph() {
    if (!paragraph.length) return;
    const node = element("p");
    appendInline(node, paragraph.join("\n"));
    body.append(node);
    paragraph = [];
  }

  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    const bullet = line.match(/^\s*(?:([-+*])\s+|(・)\s*|(\d+)[.)]\s+)(.+)$/);
    if (heading || bullet || !line.trim()) flushParagraph();
    if (bullet) {
      const tag = bullet[3] ? "ol" : "ul";
      if (list?.localName !== tag) {
        list = element(tag);
        if (tag === "ol") list.start = Number(bullet[3]);
        body.append(list);
      }
      const item = element("li");
      appendInline(item, bullet[4]);
      list.append(item);
    } else {
      list = null;
      if (heading) {
        const title = element("h3");
        appendInline(title, heading[1]);
        body.append(title);
      } else if (line.trim()) {
        paragraph.push(line);
      }
    }
  }
  flushParagraph();
}

function sourceCard(record) {
  const card = element("article", "source");
  const title = element("h3", "", record.title);
  const provenance = element("p", "source-detail");
  let sourceLink = null;
  if (record.url) {
    try {
      const url = new URL(record.url);
      if (url.protocol === "https:" || url.protocol === "http:") {
        sourceLink = element("a", "", record.source);
        sourceLink.href = url.href;
        sourceLink.target = "_blank";
        sourceLink.rel = "noopener";
      }
    } catch {
      // 出典名はブラウザーが開けるURLがない場合にも表示する。
    }
  }
  provenance.append(sourceLink || record.source);
  if (record.published) provenance.append(` · 掲載日 ${record.published}`);
  if (record.checked) provenance.append(` · 確認日 ${record.checked}`);
  card.append(title);
  if (record.text) {
    const excerpt = record.text.replace(/\n\s*\|\s*\n/g, " ").replace(/\s+/g, " ").trim();
    card.append(element("p", "source-excerpt", excerpt));
  }
  card.append(provenance);
  return card;
}

function attachSources(row, records, showSources) {
  if (!records.length) return;
  const sources = element("details", "sources");
  sources.open = showSources;
  const cards = element("div", "sources-list");
  cards.append(...records.map(sourceCard));
  sources.append(element("summary", "", `出典 ${records.length} 件`), cards);
  row.append(sources);
}

function attachCopy(row, text, label) {
  if (!text) return;
  const actions = element("div", "message-tools");
  const button = element("button", "quiet-button", label);
  button.type = "button";
  const feedback = element("span", "copy-status");
  feedback.setAttribute("role", "status");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      feedback.textContent = "コピーしました";
    } catch {
      let copyField = row.querySelector(".copy-field");
      if (!copyField) {
        copyField = element("textarea", "copy-field");
        copyField.readOnly = true;
        copyField.rows = 3;
        copyField.setAttribute("aria-label", "コピーする内容");
        row.append(copyField);
      }
      copyField.value = text;
      copyField.focus();
      copyField.select();
      feedback.textContent = "選択した内容をコピーしてください";
    }
  });
  actions.append(button, feedback);
  row.append(actions);
}

function createTurn(query) {
  const turn = element("article", "turn");
  const userMessage = element("p", "user-message", query);
  userMessage.setAttribute("aria-label", "あなたの質問");
  const guideMessage = element("div", "guide-message");
  const mark = element("span", "guide-mark");
  mark.setAttribute("aria-hidden", "true");
  const row = element("div", "message-main");
  const title = element("h2", "message-label", "やまだ案内");
  title.tabIndex = -1;
  const body = element("div", "message-content");
  body.setAttribute("aria-live", "polite");
  const status = element("p", "message-status");
  const activity = element("span", "activity-dots");
  activity.setAttribute("aria-hidden", "true");
  activity.append(element("span"), element("span"), element("span"));
  const progress = element("span", "", progressLabels.planning);
  status.append(activity, progress);
  body.append(status);
  row.append(title, body);
  guideMessage.append(mark, row);
  turn.append(userMessage, guideMessage);
  conversation.append(turn);
  conversation.hidden = false;
  welcome.hidden = true;
  newChat.hidden = false;
  app.classList.add("in-conversation");
  scrollToBottom();
  return { row, title, body, progress };
}

function displayResult(view, result) {
  view.body.replaceChildren();
  if (result.notice) view.body.append(element("p", "notice", result.notice));
  if (result.answer) formatAnswer(view.body, result.answer);
  if (result.mode === "search" && !result.answer) {
    view.body.append(element("p", "", "質問に関連する資料が見つかりました。"));
  }
  attachSources(view.row, result.sources, result.mode === "search");
  if (result.mode === "ai") {
    attachCopy(view.row, result.answer, "回答をコピー");
  } else {
    attachCopy(view.row, result.prompt, "質問と資料をコピー");
  }
  view.row.classList.add("result-ready");
}

async function readEvents(response, onProgress) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "progress") onProgress(event.stage);
        if (event.type === "result") return event.data;
      }
      if (done) throw new Error("応答が途中で途切れました。もう一度お試しください。");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function ask(query, currentPending, signal, onProgress) {
  if (offlineSearch) return offlineSearch(query);
  const response = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: eventType },
    body: JSON.stringify({ question: query, pending: currentPending, history: recentTurns }),
    signal,
  });
  if (response.ok && response.headers.get("Content-Type")?.includes(eventType)) {
    return readEvents(response, onProgress);
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "質問を送信できませんでした。");
  return data;
}

function displayFailure(view, query, message, stopped) {
  const notice = element("p", stopped ? "stopped" : "message-error", message);
  notice.setAttribute("role", stopped ? "status" : "alert");
  view.body.replaceChildren(notice);
  const restore = element("button", "quiet-button", "質問を入力欄に戻す");
  restore.type = "button";
  restore.addEventListener("click", () => {
    question.value = query;
    updateComposer();
    question.focus();
  });
  view.row.append(restore);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (active) return;
  const query = question.value.trim();
  if (!query) {
    showText(formError, pending ? "地区名を入力してください。" : "質問を入力してください。");
    question.focus();
    return;
  }

  const currentPending = pending;
  const fromExample = document.activeElement.classList.contains("example");
  const controller = new AbortController();
  active = controller;
  question.value = "";
  showText(formError, "");
  updateComposer();
  const view = welcome.hidden ? createTurn(query) : transitionComposer(() => createTurn(query));
  if (fromExample) view.title.focus({ preventScroll: true });
  try {
    const result = await ask(query, currentPending, controller.signal, (stage) => {
      const atBottom = bottomIsVisible();
      updateProgress(view.progress, stage);
      if (atBottom) scrollToBottom();
    });
    if (active !== controller) return;

    const atBottom = bottomIsVisible();
    displayResult(view, result);
    pending = result.pending ?? null;
    if (result.mode === "ai" && result.action === "answer") {
      recentTurns = [...recentTurns, {
        question: currentPending?.question ?? query,
        answer: [...result.answer].slice(0, 700).join(""),
      }].slice(-2);
    }
    if (atBottom) scrollToBottom();
  } catch (error) {
    if (active !== controller) return;
    const atBottom = bottomIsVisible();
    const stopped = controller.signal.aborted;
    const message = stopped ? "応答の表示を停止しました。" : error instanceof TypeError
      ? "サーバーに接続できませんでした。接続を確認して、もう一度お試しください。"
      : error.message;
    displayFailure(view, query, message, stopped);
    if (atBottom) scrollToBottom();
  } finally {
    if (active === controller) {
      active = null;
      updateComposer();
    }
  }
});

question.addEventListener("input", () => {
  showText(formError, "");
  updateComposer();
});
question.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.shiftKey) return;
  event.preventDefault();
  if (!active && question.value.trim()) form.requestSubmit();
});

newChat.addEventListener("click", () => {
  transitionComposer(() => {
    active?.abort();
    active = null;
    pending = null;
    recentTurns = [];
    conversation.replaceChildren();
    conversation.hidden = true;
    welcome.hidden = false;
    newChat.hidden = true;
    app.classList.remove("in-conversation");
    question.value = "";
    showText(formError, "");
    scrollRegion.scrollTop = 0;
    updateComposer();
  });
  question.focus();
});

skipFollowUp.addEventListener("click", () => {
  pending = null;
  showText(formError, "");
  updateComposer();
  question.focus();
});
stop.addEventListener("click", () => active?.abort());

for (const example of document.querySelectorAll(".example")) {
  example.addEventListener("click", () => {
    question.value = example.dataset.question;
    updateComposer();
    form.requestSubmit();
  });
}

async function loadSettings() {
  if (offlineSearch) {
    showText(mode, "資料検索モード");
    return;
  }
  try {
    const response = await fetch("/api/settings");
    if (!response.ok) return;
    const settings = await response.json();
    showText(mode, settings.ai ? "AI回答モード" : "資料検索モード");
  } catch {
    // 質問を送れない場合は会話欄に表示する。
  }
}

updateComposer();
loadSettings();
