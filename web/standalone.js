"use strict";

function createOfflineSearch({ records, limit, instructions, noEvidence, photos = [], photoLimit = 2 }) {
  function normalize(text) {
    return text.normalize("NFKC").toLowerCase().replace(/[ァ-ヶ]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0x60)
    );
  }

  return (question) => {
    const query = normalize(question);
    const ranked = [];
    for (const record of records) {
      const keywords = record.keywords.filter((term) => query.includes(normalize(term)));
      if (!keywords.length) continue;
      const topicScore = record.topics.reduce((score, topic) =>
        score + (query.includes(normalize(topic)) ? topic.length : 0), 0);
      ranked.push({ record, topicScore, keywordLength: Math.max(...keywords.map((term) => term.length)) });
    }
    ranked.sort((a, b) => b.topicScore - a.topicScore || b.keywordLength - a.keywordLength);

    // As in the Python search, first include the best section from each source.
    const firstPerSource = new Map();
    const remaining = [];
    for (const { record } of ranked) {
      if (firstPerSource.has(record.url)) remaining.push(record);
      else firstPerSource.set(record.url, record);
    }
    const sources = [...firstPerSource.values(), ...remaining].slice(0, limit);
    const sourceIds = new Set(sources.map((record) => record.id));
    const sections = sources.map((record) =>
      `[${record.id}] ${record.category} / ${record.title}\n${record.text}\n` +
      `出典　${record.source}（確認日 ${record.checked}）\n${record.url}`
    );
    return {
      mode: "search",
      answer: sources.length ? "" : noEvidence,
      sources,
      photos: photos.filter((photo) => photo.record_ids.some((id) => sourceIds.has(id))).slice(0, photoLimit),
      prompt: sources.length
        ? `${instructions}\n回答の根拠にした出典のURLを記載してください。\n\n質問\n${question}\n\n検索で見つかった資料\n${sections.join("\n\n")}`
        : "",
    };
  };
}
