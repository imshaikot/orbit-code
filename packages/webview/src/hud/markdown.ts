import { button, el } from './dom';

// Claude's replies as Markdown, built as DOM nodes: every piece of text goes in as a text node, never as HTML.
// Covers what Claude Code writes: headings, paragraphs, lists (nested, tasks), fenced code, quotes, tables,
// rules, and inline code, emphasis, strike-through and links. A link without a scheme is taken as a
// workspace path and opens the file (the host refuses anything outside the workspace); other links show
// their target on hover but do not navigate.

type Parent = HTMLElement | DocumentFragment;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>\s?/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<!\w)_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)|\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export function renderMarkdown(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  blocks(text.replace(/\r\n?/g, '\n').split('\n'), fragment);
  return fragment;
}

function blocks(lines: string[], parent: Parent): void {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
      i++;
      const pre = el('pre', 'md-code');
      if (fence[2]) pre.dataset.lang = fence[2];
      pre.append(el('code', undefined, body.join('\n')));
      parent.append(pre);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const element = el(level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5', 'md-heading');
      inline(heading[2], element);
      parent.append(element);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      parent.append(el('hr', 'md-rule'));
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''));
      const quote = el('blockquote', 'md-quote');
      blocks(body, quote);
      parent.append(quote);
      continue;
    }

    if (ITEM.test(line)) {
      i = list(lines, i, parent);
      continue;
    }

    if (isTableStart(lines, i)) {
      i = table(lines, i, parent);
      continue;
    }

    // A paragraph: single newlines stay line breaks, the way Claude Code prints them.
    const paragraph = el('p', 'md-p');
    inline(lines[i++].trim(), paragraph);
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      paragraph.append(el('br'));
      inline(lines[i++].trim(), paragraph);
    }
    parent.append(paragraph);
  }
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(lines, i);
}

function isTableStart(lines: string[], i: number): boolean {
  const divider = lines[i + 1];
  return lines[i].includes('|') && divider !== undefined && divider.includes('-') && TABLE_DIVIDER.test(divider);
}

/** One list starting at `start`, with every item's indented continuation (nested lists included). Returns the next line. */
function list(lines: string[], start: number, parent: Parent): number {
  const first = ITEM.exec(lines[start])!;
  const indent = width(first[1]);
  const ordered = /\d/.test(first[2]);
  const element = el(ordered ? 'ol' : 'ul', 'md-list');
  if (ordered && Number.parseInt(first[2], 10) !== 1) (element as HTMLOListElement).start = Number.parseInt(first[2], 10);

  const items: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const item = ITEM.exec(lines[i]);
    if (!item || width(item[1]) !== indent || /\d/.test(item[2]) !== ordered) break;
    const body = [item[3]];
    items.push(body);
    const contentIndent = indent + item[2].length + 1;
    for (i++; i < lines.length; i++) {
      const next = lines[i];
      if (!next.trim()) {
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && width(leading(lines[j])) > indent) {
          for (; i < j; i++) body.push('');
          i--;
          continue;
        }
        const sibling = j < lines.length ? ITEM.exec(lines[j]) : null;
        if (sibling && width(sibling[1]) === indent && /\d/.test(sibling[2]) === ordered) i = j;
        break;
      }
      const spaces = width(leading(next));
      if (spaces > indent) {
        body.push(next.trimStart().padStart(next.trimStart().length + Math.max(0, spaces - contentIndent), ' '));
        continue;
      }
      if (startsBlock(lines, i)) break;
      body.push(next.trim());
    }
  }

  for (const body of items) {
    const li = el('li');
    const task = TASK.exec(body[0]);
    if (task) {
      body[0] = body[0].slice(task[0].length);
      li.className = 'md-task';
      li.dataset.done = String(task[1] !== ' ');
    }
    blocks(body, li);
    const only = li.firstElementChild;
    if (only?.classList.contains('md-p')) only.replaceWith(...only.childNodes);
    element.append(li);
  }
  parent.append(element);
  return i;
}

function table(lines: string[], start: number, parent: Parent): number {
  const aligns = cells(lines[start + 1]).map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : ''));
  const row = (line: string, tag: 'th' | 'td') => {
    const tr = el('tr');
    cells(line).forEach((cell, k) => {
      const element = el(tag);
      if (aligns[k]) element.style.textAlign = aligns[k];
      inline(cell, element);
      tr.append(element);
    });
    return tr;
  };
  const head = el('thead');
  head.append(row(lines[start], 'th'));
  const body = el('tbody');
  let i = start + 2;
  for (; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) body.append(row(lines[i], 'td'));
  const wrap = el('div', 'md-table');
  const element = el('table');
  element.append(head, body);
  wrap.append(element);
  parent.append(wrap);
  return i;
}

function cells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function inline(text: string, parent: Parent): void {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[1] !== undefined) {
      parent.append(el('code', 'md-inline-code', match[2].replace(/^ (.+) $/, '$1')));
    } else if (match[8] !== undefined) {
      parent.append(link(match[8], match[9]));
    } else {
      const [tag, content] =
        match[3] !== undefined || match[4] !== undefined
          ? (['strong', match[3] ?? match[4]] as const)
          : match[5] !== undefined
            ? (['del', match[5]] as const)
            : (['em', match[6] ?? match[7]] as const);
      const element = el(tag);
      inline(content, element);
      parent.append(element);
    }
  }
  if (last < text.length) parent.append(text.slice(last));
}

function link(label: string, target: string): HTMLElement {
  if (!SCHEME.test(target) && !target.startsWith('#')) {
    const path = safeDecode(target.replace(/#.*$/, '').replace(/:\d+(?::\d+)?$/, ''));
    if (path) {
      const open = button('', 't-link md-link', `Open ${path}`);
      open.dataset.file = path;
      inline(label, open);
      return open;
    }
  }
  const external = el('span', 'md-link-external');
  external.title = target;
  inline(label, external);
  return external;
}

function safeDecode(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

function leading(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

function width(whitespace: string): number {
  return whitespace.replace(/\t/g, '    ').length;
}
