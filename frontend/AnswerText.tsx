import { createElement as h } from "react";
import type { ReactElement } from "react";

function inline(text: string): Array<string | ReactElement> {
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\*([^*\n]+)\*/g;
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
  parts.push(text.slice(offset));
  return parts;
}

function formatAnswer(text: string): ReactElement[] {
  const blocks: ReactElement[] = [];
  let paragraph: string[] = [];
  const current: { list?: { tag: "ol" | "ul"; start?: number; items: ReactElement[] } } = {};

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push(h("p", { key: blocks.length }, inline(paragraph.join("\n"))));
    paragraph = [];
  }

  function flushList() {
    const list = current.list;
    if (!list) return;
    blocks.push(h(list.tag, { start: list.start, key: blocks.length }, list.items));
    current.list = undefined;
  }

  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    const bullet = line.match(/^\s*(?:([-+*])\s+|(・)\s*|(\d+)[.)]\s+)(.+)$/);
    if (heading || bullet || !line.trim()) flushParagraph();
    if (bullet) {
      const tag = bullet[3] ? "ol" : "ul";
      if (current.list?.tag !== tag) {
        flushList();
        current.list = { tag, start: bullet[3] ? Number(bullet[3]) : undefined, items: [] };
      }
      current.list.items.push(h("li", { key: current.list.items.length }, inline(bullet[4])));
    } else {
      flushList();
      if (heading) blocks.push(h("h3", { key: blocks.length }, inline(heading[1])));
      else if (line.trim()) paragraph.push(line);
    }
  }
  flushList();
  flushParagraph();
  return blocks;
}

export default function AnswerText({ text }: { text: string }) {
  return <>{formatAnswer(text)}</>;
}
