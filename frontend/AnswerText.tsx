import { createElement as h } from "react";
import type { ReactElement } from "react";

function inline(text: string, streaming: boolean): Array<string | ReactElement> {
  const pattern = /(?<!\*)\*\*([^*\n]+)\*\*(?!\*)|`([^`\n]+)`|(?<!\*)\*([^*\n]+)\*(?!\*)/g;
  const parts: Array<string | ReactElement> = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(offset, match.index));
    const [, bold, code, italic] = match;
    if (bold) parts.push(h("strong", { key: match.index }, bold));
    else if (code) parts.push(h("code", { key: match.index }, code));
    else parts.push(h("em", { key: match.index }, italic));
    offset = match.index + match[0].length;
  }
  const rest = text.slice(offset);
  const unfinished = streaming ? /\*\*([^*\n]*)(?:\*)?$|`([^`\n]*)$|\*([^*\n]*)$/.exec(rest) : null;
  if (unfinished) {
    parts.push(rest.slice(0, unfinished.index));
    const [, bold, code, italic] = unfinished;
    const tag = bold !== undefined ? "strong" : code !== undefined ? "code" : "em";
    const value = bold ?? code ?? italic;
    if (value) parts.push(h(tag, { key: text.length }, value));
  } else parts.push(rest);
  return parts;
}

function formatAnswer(text: string, streaming: boolean): ReactElement[] {
  const blocks: ReactElement[] = [];
  let paragraph: string[] = [];
  const current: { list?: { tag: "ol" | "ul"; start?: number; items: ReactElement[] } } = {};

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push(h("p", { key: blocks.length }, inline(paragraph.join("\n"), streaming)));
    paragraph = [];
  }

  function flushList() {
    const list = current.list;
    if (!list) return;
    blocks.push(h(list.tag, { start: list.start, key: blocks.length }, list.items));
    current.list = undefined;
  }

  for (const line of text.split(/\r?\n/)) {
    if (streaming && /^\s*(?:#{1,6}|[-+*](?:\s+\*{1,2})?|\d+[.)](?:\s+\*{1,2})?)\s*$/.test(line)) continue;
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    const bullet = line.match(/^\s*(?:([-+*])\s+|(・)\s*|(\d+)[.)]\s+)(.+)$/);
    if (heading || bullet || !line.trim()) flushParagraph();
    if (bullet) {
      const tag = bullet[3] ? "ol" : "ul";
      if (current.list?.tag !== tag) {
        flushList();
        current.list = { tag, start: bullet[3] ? Number(bullet[3]) : undefined, items: [] };
      }
      current.list.items.push(h("li", { key: current.list.items.length }, inline(bullet[4], streaming)));
    } else {
      flushList();
      if (heading) blocks.push(h("h3", { key: blocks.length }, inline(heading[1], streaming)));
      else if (line.trim()) paragraph.push(line);
    }
  }
  flushList();
  flushParagraph();
  return blocks;
}

export default function AnswerText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <>{formatAnswer(text, streaming)}</>;
}
