"use strict";

const form = document.querySelector("#question-form");
const question = document.querySelector("#question");
const questionLabel = document.querySelector("#question-label");
const previousQuestion = document.querySelector("#previous-question");
const shortcut = document.querySelector("#shortcut");
const newQuestion = document.querySelector("#new-question");
const submit = document.querySelector("#submit");
const submitLabel = document.querySelector("#submit-label");
const mode = document.querySelector("#mode");
const status = document.querySelector("#status");
const error = document.querySelector("#error");
const results = document.querySelector("#results");
const resultTitle = document.querySelector("#result-title");
const resultQuestion = document.querySelector("#result-question");
const notice = document.querySelector("#notice");
const answer = document.querySelector("#answer");
const sources = document.querySelector("#sources");
const copy = document.querySelector("#copy");
const copyStatus = document.querySelector("#copy-status");
const copyFallback = document.querySelector("#copy-fallback");
const promptText = document.querySelector("#prompt-text");
const examples = [...document.querySelectorAll(".example")];
const standaloneData = document.querySelector("#standalone-data");
const offlineSearch = standaloneData && createOfflineSearch(JSON.parse(standaloneData.textContent));
const originalPlaceholder = question.placeholder;
let aiEnabled = false;
let pending = null;

function showText(element, value) {
  element.textContent = value;
  element.hidden = !value;
}

function setPending(nextPending) {
  pending = nextPending;
  questionLabel.textContent = pending ? pending.prompt : "質問する";
  question.placeholder = pending ? "例　大沢" : originalPlaceholder;
  showText(previousQuestion, pending ? `元の質問　${pending.question}` : "");
  if (pending) question.setAttribute("aria-describedby", previousQuestion.id);
  else question.removeAttribute("aria-describedby");
  shortcut.hidden = Boolean(pending);
  newQuestion.hidden = !pending;
  if (pending) submitLabel.textContent = "返答を送信";
  else submitLabel.textContent = aiEnabled ? "AIに質問" : "資料を検索";
}

function sourceCard(record) {
  const card = document.createElement("article");
  card.className = "source";

  const category = document.createElement("span");
  category.className = record.category === "観光" ? "category tourism" : "category life";
  category.textContent = record.category;

  const title = document.createElement("h3");
  title.textContent = record.title;

  const excerpt = document.createElement("p");
  excerpt.textContent = record.text;

  const metadata = document.createElement("p");
  metadata.className = "source-meta";
  if (record.url) {
    const link = document.createElement("a");
    link.href = record.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = record.source;
    metadata.append(link);
  } else {
    metadata.append(record.source);
  }
  const published = record.published ? `掲載日 ${record.published} / ` : "";
  metadata.append(`（${published}確認日 ${record.checked}）`);

  card.append(category, title);
  if (record.text) card.append(excerpt);
  card.append(metadata);
  return card;
}

function renderResult(query, data) {
  resultTitle.textContent = "検索結果";
  if (data.mode === "ai") {
    resultTitle.textContent = data.action === "insufficient" ? "確認できなかったこと" : "AIの回答";
  }
  resultQuestion.textContent = query;
  showText(answer, data.answer);
  showText(notice, data.notice || "");
  sources.replaceChildren(...data.sources.map(sourceCard));
  promptText.value = data.prompt;
  copy.hidden = !data.prompt;
  copyFallback.hidden = true;
  showText(copyStatus, "");
  results.hidden = false;
  resultTitle.focus({ preventScroll: true });
  resultTitle.scrollIntoView({ block: "nearest" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  const query = question.value.trim();
  if (!query) {
    showText(error, pending ? "地区名を入力してください。" : "質問を入力してください。");
    question.focus();
    return;
  }

  const currentPending = pending;
  let focusQuestion = false;
  submit.disabled = true;
  question.readOnly = true;
  newQuestion.disabled = true;
  examples.forEach((example) => { example.disabled = true; });
  results.hidden = true;
  showText(error, "");
  showText(status, aiEnabled ? "AIが確認しています…" : "公式資料を検索しています…");

  try {
    if (offlineSearch) {
      renderResult(query, offlineSearch(query));
      return;
    }
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: query, pending: currentPending }),
    });
    const data = await response.json();
    if (!response.ok) {
      showText(error, data.error || "検索できませんでした。もう一度お試しください。");
      return;
    }
    setPending(data.pending ?? null);
    if (data.action === "clarify") {
      question.value = "";
      focusQuestion = true;
      return;
    }
    if (currentPending && !pending) question.value = "";
    renderResult(currentPending?.question ?? query, data);
  } catch {
    showText(error, offlineSearch
      ? "資料を検索できませんでした。ページを開き直してください。"
      : "ローカルサーバーに接続できませんでした。起動状況を確認してください。");
  } finally {
    submit.disabled = false;
    question.readOnly = false;
    newQuestion.disabled = false;
    examples.forEach((example) => { example.disabled = false; });
    showText(status, "");
    if (focusQuestion) question.focus();
  }
});

question.addEventListener("keydown", (event) => {
  if (!event.isComposing && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    form.requestSubmit();
  }
});

newQuestion.addEventListener("click", () => {
  setPending(null);
  question.value = "";
  results.hidden = true;
  showText(error, "");
  question.focus();
});

for (const example of examples) {
  example.addEventListener("click", () => {
    if (pending) setPending(null);
    question.value = example.textContent.trim();
    form.requestSubmit();
  });
}

copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(promptText.value);
    showText(copyStatus, "質問と根拠資料をコピーしました。チャットに貼って使えます。");
  } catch {
    copyFallback.hidden = false;
    promptText.select();
    showText(copyStatus, "選択したテキストをコピーして、チャットに貼ってください。");
  }
});

async function loadSettings() {
  if (offlineSearch) {
    showText(mode, "資料検索モード");
    return;
  }
  try {
    const response = await fetch("/api/settings");
    if (!response.ok) return;
    const settings = await response.json();
    aiEnabled = settings.ai;
    showText(mode, aiEnabled ? "AI回答モード" : "資料検索モード");
    setPending(pending);
  } catch {
    // 検索時のエラーはフォーム内に表示する。
  }
}

loadSettings();
