// "Copy for agent": comment threads as one Markdown block that any agent
// (Claude Code, Codex, Cursor, a chat window) can act on when pasted, with
// no setup and no connection to tdoc. One formatter for every surface (the
// doc page, slides and sheets, the feedback widget, the feedback space
// page); each passes only what is its own: the page's title and address and
// how a comment's tdoc link is built. Pure: no DOM, no React.
//
// What a thread says: who wrote it and what, the words it was left on, the
// element (selector, accessible name), the app state it was left in (dialog,
// tabs), the box and viewport, its replies, its id and its tdoc link. A
// missing piece is left out, never written as "undefined" or an empty line.
//
// Escaping: names, titles and labels are inline text (Markdown punctuation
// escaped, one line); a selector or id is a code span fenced past any
// backticks inside it; the comment, a reply and a quote are block quotes
// with every line prefixed, so nothing written in a comment ("## 2.",
// "---", a code fence) can end the block or forge another thread. Links are
// http(s) only, as <autolinks>. A React component chain and source file
// (anchor.react, reactSourceCapture) come from the site's page: names must
// look like identifiers (at most 8), the file a plain path, the line
// and column small integers; names inline-escaped, the file a code span.
// No imports: bin/lib/watch.js and the tests load this file on its own.

const MAX_QUOTE = 1000;
const MAX_ELEMENT_TEXT = 200;

const str = (value) => (value === null || value === undefined ? '' : String(value));
const oneLine = (value) => str(value).replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Inline text: one line, Markdown's punctuation escaped.
export function escapeInline(value) {
  return oneLine(value).replace(/[\\`*_[\]<>|~]/g, '\\$&');
}

// A code span that holds any text: fenced with one backtick more than the
// longest run inside, padded when the text starts or ends with one.
export function codeSpan(value) {
  const text = oneLine(value);
  if (!text) return '';
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

// A block quote: every line prefixed, blank lines kept as ">", so the text
// stays inside it whatever it holds.
export function quoteBlock(value, indent = '') {
  const text = str(value).replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
  if (!text) return '';
  return text.split('\n').map((line) => (line.trim() ? `${indent}> ${line}` : `${indent}>`)).join('\n');
}

// http(s) only, normalised (spaces and angle brackets percent-encoded) and
// written as an autolink; anything else is not a link.
export function safeLink(value) {
  const raw = str(value).trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `<${url.href.replace(/[<>\s]/g, (c) => encodeURIComponent(c))}>`;
  } catch (_) {
    return '';
  }
}

export function authorName(author) {
  if (!author) return 'anonymous';
  if (typeof author === 'string') return oneLine(author) || 'anonymous';
  if (author.kind === 'agent') {
    const name = oneLine(author.name || author.handle || author.login || 'agent');
    return `${name} (agent)`;
  }
  const name = oneLine(author.name);
  const login = oneLine(author.login);
  if (name && login && name.toLowerCase() !== login.toLowerCase()) return `${name} (@${login})`;
  return name || (login ? `@${login}` : 'anonymous');
}

// The words a comment was left on: a quote picked on an app page, the text
// selected in a doc, or the label of a box / a part of a doc frame.
function quoteOf(anchor) {
  if (!anchor) return '';
  if (anchor.quote && anchor.quote.text) return str(anchor.quote.text);
  if (anchor.kind === 'text' && anchor.text) return str(anchor.text);
  return '';
}

function stateLine(state) {
  if (!state || typeof state !== 'object') return '';
  const parts = [];
  if (state.dialog) parts.push(`dialog "${escapeInline(state.dialog)}"`);
  else if (state.layer) parts.push(`layer "${escapeInline(state.layer)}"`);
  const tabs = Array.isArray(state.tabs) ? state.tabs.map(oneLine).filter(Boolean) : [];
  if (tabs.length) parts.push(`${tabs.length === 1 ? 'tab' : 'tabs'} ${tabs.map(escapeInline).join(' › ')}`);
  return parts.join(' · ');
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
function areaLine(anchor) {
  const parts = [];
  const rect = anchor.rect;
  if (rect && finite(rect.width) && finite(rect.height)) {
    const at = finite(rect.x) && finite(rect.y) ? ` at ${Math.round(rect.x)},${Math.round(rect.y)}` : '';
    parts.push(`${Math.round(rect.width)}×${Math.round(rect.height)}px${at}`);
  }
  const region = anchor.region;
  if (region && finite(region.x) && finite(region.y) && finite(region.width) && finite(region.height)) {
    const pct = (n) => `${Math.round(n * 100)}%`;
    parts.push(`box ${pct(region.width)}×${pct(region.height)} of the element at ${pct(region.x)},${pct(region.y)}`);
  }
  const vp = anchor.viewport;
  if (vp && finite(vp.width) && finite(vp.height)) {
    const dpr = finite(vp.device_pixel_ratio) && vp.device_pixel_ratio !== 1 ? ` @${vp.device_pixel_ratio}x` : '';
    parts.push(`viewport ${Math.round(vp.width)}×${Math.round(vp.height)}${dpr}`);
  }
  return parts.join(' · ');
}

function elementLine(anchor) {
  if (!anchor || anchor.page) return anchor && anchor.page ? 'the whole page' : '';
  const parts = [];
  if (anchor.selector) parts.push(codeSpan(anchor.selector));
  const name = oneLine(anchor.accessible_name);
  if (name) parts.push(`"${escapeInline(name)}"`);
  else if ((anchor.region || anchor.frame) && anchor.label) parts.push(`"${escapeInline(anchor.label)}"`);
  if (anchor.tag) parts.push(`(${escapeInline(anchor.tag)})`);
  return parts.join(' ');
}

// "App › Pricing › PlanCard" and `src/Pricing.jsx:42:7`, from anchor.react
// (the rules of selection/anchors/react-source.js cleanReactSource).
const REACT_NAME = /^[A-Z][A-Za-z0-9_$.]{2,59}$/;
// ASCII path characters and the [ ] ( ) $ of route files; no spaces.
const REACT_PATH = /^[A-Za-z0-9._@+\-/[\]()$]{1,200}$/;
const smallInt = (n) => (Number.isInteger(n) && n >= 1 && n <= 10000000 ? n : null);
function reactLines(anchor) {
  const react = anchor && anchor.react;
  if (!react || typeof react !== 'object') return [];
  const out = [];
  const names = (Array.isArray(react.components) ? react.components : [])
    .filter((name) => typeof name === 'string' && REACT_NAME.test(name)).slice(-8);
  if (names.length) out.push(`- component: ${names.map(escapeInline).join(' › ')}`);
  const file = typeof react.file === 'string' && REACT_PATH.test(react.file) && !react.file.split('/').includes('..') ? react.file : '';
  if (file) {
    const line = smallInt(react.line);
    const column = line ? smallInt(react.column) : null;
    out.push(`- source: ${codeSpan(`${file}${line ? `:${line}${column ? `:${column}` : ''}` : ''}`)}`);
  }
  return out;
}

function liveReplies(comment) {
  return (comment.replies || []).filter((reply) => reply && !reply.deleted && oneLine(reply.text));
}

// One thread. `n` / `of` number it in a list; `pageUrl` is the page the
// whole block is about (a thread on another page says its own).
export function threadMarkdown(comment, { n = 1, of = 1, pageUrl = '', linkFor = null } = {}) {
  if (!comment) return '';
  const anchor = comment.anchor || {};
  const status = comment.deleted ? 'deleted' : comment.status === 'applied' ? 'resolved' : 'open';
  const head = `## ${of > 1 ? `${n}. ` : ''}${escapeInline(authorName(comment.author))}${status === 'open' ? '' : ` · ${status}`}`;
  const facts = [];
  if (comment.id) facts.push(`- id: ${codeSpan(comment.id)}`);
  const link = linkFor ? safeLink(linkFor(comment)) : '';
  if (link) facts.push(`- tdoc: ${link}`);
  const page = anchor.url && anchor.url !== pageUrl ? safeLink(anchor.url) : '';
  if (page) facts.push(`- page: ${page}`);
  const element = elementLine(anchor);
  if (element) facts.push(`- element: ${element}`);
  const elementText = anchor.kind === 'product' && !anchor.quote && !anchor.page ? oneLine(anchor.text) : '';
  if (elementText && elementText !== oneLine(anchor.accessible_name)) facts.push(`- element text: "${escapeInline(clip(elementText, MAX_ELEMENT_TEXT))}"`);
  facts.push(...reactLines(anchor));
  const state = stateLine(anchor.state);
  if (state) facts.push(`- state: ${state}`);
  const area = areaLine(anchor);
  if (area) facts.push(`- area: ${area}`);
  const quote = quoteOf(anchor);
  if (quote) facts.push(`- on the words:\n${quoteBlock(clip(quote.trim(), MAX_QUOTE), '  ')}`);
  const out = [head];
  if (facts.length) out.push(facts.join('\n'));
  const body = comment.deleted ? '' : quoteBlock(comment.text);
  out.push(body || '> (comment deleted)');
  const replies = liveReplies(comment);
  if (replies.length) {
    out.push(`Replies:\n${replies.map((reply) => `- ${escapeInline(authorName(reply.author))}:\n${quoteBlock(reply.text, '  ')}`).join('\n')}`);
  }
  return out.join('\n\n');
}

// The block: what it is, the page, then every thread. `title` and `pageUrl`
// name the page (or the space); `scope` says which threads ("open").
export function commentsMarkdown(comments, { title = '', pageUrl = '', linkFor = null, scope = '' } = {}) {
  const list = (Array.isArray(comments) ? comments : []).filter(Boolean);
  const count = list.length;
  const what = count === 1 ? `1 ${scope ? `${scope} ` : ''}comment` : `${count} ${scope ? `${scope} ` : ''}comments`;
  const name = oneLine(title);
  const head = [`# ${what}${name ? ` on ${escapeInline(name)}` : ''}`];
  const page = safeLink(pageUrl);
  if (page) head.push(`Page: ${page}`);
  head.push(count
    ? 'Comments from tdoc: for each, where it points, then what was said. Act on them; reply or resolve on tdoc by id.'
    : 'No comments.');
  return [head.join('\n'), ...list.map((comment, i) => threadMarkdown(comment, { n: i + 1, of: count, pageUrl, linkFor }))]
    .join('\n\n') + '\n';
}
