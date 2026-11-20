// Markdown view of a document being edited (flag markdownEditMode).
//
//   toMarkdown(bodyHtml)            -> { ok, markdown, snapshot, reason?, kept }
//   fromMarkdown(markdown, snapshot) -> { bodyHtml, removedKept }
//
// The edit root's HTML (what the frame's editor serializes, draftBodyHtml)
// is cut into its top-level blocks. A block is shown as Markdown only when
// the Markdown converts back to the same block (checked here, block by
// block): the conversion out is the one Download / Copy as Markdown use
// (server/shell.js documentMarkdown), the way back is `marked` with every
// raw HTML token escaped, and its output passes an allow-list (sanitize
// below) before it reaches the page. Anything else (house blocks, sheets,
// figures, embeds, tables or lists Markdown would reshape, a block with
// markup Markdown has no syntax for) stays HTML, byte for byte: the
// Markdown holds one placeholder line for it, `<!-- tdoc:keep 3 cards -->`,
// and the line is swapped back for the exact source. Nothing typed in
// Markdown becomes markup outside the allow-list, and a placeholder only
// ever stands for HTML that was already in this document.
//
// Unchanged Markdown gives back the very same HTML; after an edit, every
// block whose Markdown did not change keeps its original bytes, and an
// edited block that stays the same kind keeps its attributes (ids, aids,
// classes), as typing into it in the rich editor would.
import { Lexer, Marked } from 'marked';
import '../../../server/shell.js';

const builder = () => globalThis.TDOC_SHELL_BUILDER;

// ---- a small HTML reader --------------------------------------------------
// For HTML a browser serialized (the editor's innerHTML) or marked wrote:
// tags closed, attributes quoted. Anything it cannot read for sure throws,
// and the doc keeps its rich editor.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
const MAX_NODES = 200_000;

export function parseFragment(html) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  let i = 0;
  let count = 0;
  const n = html.length;
  const top = () => stack[stack.length - 1];
  let lower = null;
  const add = (node) => {
    if (++count > MAX_NODES) throw new Error('too large');
    top().children.push(node);
  };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { add({ type: 'text', start: i, end: n, raw: html.slice(i) }); break; }
    if (lt > i) add({ type: 'text', start: i, end: lt, raw: html.slice(i, lt) });
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) throw new Error('open comment');
      add({ type: 'comment', start: lt, end: end + 3 });
      i = end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      if (end === -1) throw new Error('open declaration');
      add({ type: 'comment', start: lt, end: end + 1 });
      i = end + 1;
      continue;
    }
    const close = html[lt + 1] === '/';
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(lt + (close ? 2 : 1), lt + (close ? 2 : 1) + 64));
    if (!nameMatch) {
      // A lone '<' is text.
      add({ type: 'text', start: lt, end: lt + 1, raw: '<' });
      i = lt + 1;
      continue;
    }
    const tag = nameMatch[0].toLowerCase();
    let j = lt + (close ? 2 : 1) + nameMatch[0].length;
    const attrs = [];
    let selfClose = false;
    // Attributes: name, name=value, name="value", name='value'.
    for (;;) {
      while (j < n && /\s/.test(html[j])) j++;
      if (j >= n) throw new Error('open tag');
      if (html[j] === '>') { j++; break; }
      if (html[j] === '/' && html[j + 1] === '>') { selfClose = true; j += 2; break; }
      const an = /^[^\s"'>/=]+/.exec(html.slice(j, j + 256));
      if (!an) { j++; continue; }
      const name = an[0].toLowerCase();
      j += an[0].length;
      while (j < n && /\s/.test(html[j])) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, j + 1);
          if (end === -1) throw new Error('open attribute');
          value = html.slice(j + 1, end);
          j = end + 1;
        } else {
          const uv = /^[^\s>]*/.exec(html.slice(j));
          value = uv[0];
          j += value.length;
        }
      }
      attrs.push([name, decode(value)]);
    }
    if (close) {
      let k = stack.length - 1;
      while (k > 0 && stack[k].tag !== tag) k--;
      if (k === 0) throw new Error(`stray </${tag}>`);
      if (k !== stack.length - 1) throw new Error(`unclosed <${top().tag}>`);
      const el = stack.pop();
      el.end = j;
      el.innerEnd = lt;
      i = j;
      continue;
    }
    const el = { type: 'el', tag, attrs, children: [], start: lt, openEnd: j, end: j };
    add(el);
    i = j;
    if (VOID.has(tag) || selfClose) continue;
    if (RAW.has(tag)) {
      if (lower == null) lower = html.toLowerCase();
      const end = lower.indexOf(`</${tag}`, j);
      if (end === -1) throw new Error(`open <${tag}>`);
      const gt = html.indexOf('>', end);
      if (gt === -1) throw new Error(`open </${tag}>`);
      if (end > j) el.children.push({ type: 'text', start: j, end, raw: html.slice(j, end) });
      el.innerEnd = end;
      el.end = gt + 1;
      i = gt + 1;
      continue;
    }
    stack.push(el);
  }
  if (stack.length > 1) throw new Error(`unclosed <${top().tag}>`);
  return root.children;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decode(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v == null ? m : v;
  });
}
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');

// ---- sanitize: what Markdown may put in the page --------------------------
const ALLOWED = {
  p: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: ['start'], li: [], blockquote: [], pre: [], hr: [], br: [],
  table: [], thead: [], tbody: [], tr: [], th: ['align'], td: ['align'],
  strong: [], em: [], code: ['class'], del: [], s: [],
  a: ['href', 'title'], img: ['src', 'alt', 'title'],
};
// Links and images: the web, mail, and addresses inside this document.
export function safeUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(u)) return '';
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  if (!scheme) return u;
  return /^(https?|mailto)$/i.test(scheme[1]) ? u : '';
}
function cleanAttr(tag, name, value) {
  if (tag === 'a' && name === 'href') return safeUrl(value) || null;
  if (tag === 'img' && name === 'src') return safeUrl(value) || null;
  if (tag === 'code' && name === 'class') return /^language-[\w+-]{1,40}$/.test(value) ? value : null;
  if (tag === 'ol' && name === 'start') return /^\d{1,9}$/.test(value) ? value : null;
  if ((tag === 'th' || tag === 'td') && name === 'align') return /^(left|center|right)$/.test(value) ? value : null;
  return value;
}
function sanitizeNodes(nodes, html) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') { out += escText(decode(node.raw)); continue; }
    if (node.type !== 'el') continue;
    const allowed = ALLOWED[node.tag];
    if (!allowed) {
      // Unknown markup is never written: a raw-text element (script, style)
      // goes with its text, anything else leaves its text behind.
      if (!RAW.has(node.tag)) out += sanitizeNodes(node.children, html);
      continue;
    }
    if (node.tag === 'img') {
      const src = cleanAttr('img', 'src', (node.attrs.find(([k]) => k === 'src') || [])[1]);
      if (!src) { const alt = (node.attrs.find(([k]) => k === 'alt') || [])[1]; if (alt) out += escText(alt); continue; }
    }
    if (node.tag === 'a' && !cleanAttr('a', 'href', (node.attrs.find(([k]) => k === 'href') || [])[1])) {
      // A link to somewhere a page may not link (javascript:, data:): its words only.
      out += sanitizeNodes(node.children, html);
      continue;
    }
    let attrs = '';
    for (const [k, v] of node.attrs) {
      if (!allowed.includes(k)) continue;
      const clean = cleanAttr(node.tag, k, v);
      if (clean != null) attrs += ` ${k}="${escAttr(clean)}"`;
    }
    out += `<${node.tag}${attrs}>`;
    if (VOID.has(node.tag)) continue;
    out += sanitizeNodes(node.children, html);
    out += `</${node.tag}>`;
  }
  return out;
}
export function sanitizeHtml(html) {
  return sanitizeNodes(parseFragment(html), html);
}

// ---- Markdown -> HTML ----------------------------------------------------
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Raw HTML typed in Markdown stays text.
    html({ text }) { return escapeHtml(text); },
  },
});

// One block's Markdown as HTML: its inline text read only now (the doc
// itself is read block by block, below), with the doc's link definitions.
function renderBlock(raw, links) {
  try {
    const lexer = new Lexer(marked.defaults);
    Object.assign(lexer.tokens.links, links || {});
    const tokens = lexer.lex(raw);
    return sanitizeHtml(marked.parser(tokens));
  } catch (error) {
    throw new MarkdownTooComplex('This Markdown is too large to convert');
  }
}
export function markdownToHtml(md) {
  return renderBlock(String(md || ''), null);
}

// ---- comparing a block with what its Markdown gives back ------------------
const BLOCKISH = 'p|h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tr|th|td|hr|br';
const BLOCK_EDGE = new RegExp(`\\s*(<\\/?(?:${BLOCKISH})\\b[^>]*>)\\s*`, 'g');
const CANON_ATTRS = { a: ['href'], img: ['src', 'alt'], ol: ['start'], th: ['align'], td: ['align'] };
const SAME_TAG = { b: 'strong', i: 'em', strike: 's', del: 's' };
function canonNodes(nodes, inPre) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      const t = decode(node.raw).replace(/ /g, ' ');
      out += escText(inPre ? t : t.replace(/\s+/g, ' '));
      continue;
    }
    if (node.type === 'comment') { out += '<!---->'; continue; }
    out += canonEl(node, false, inPre);
  }
  return out;
}
function canonEl(node, top, inPre) {
  let tag = SAME_TAG[node.tag] || node.tag;
  if (tag === 'pre') {
    // <pre>x</pre> and <pre><code class="language-js">x</code></pre> are the
    // same block; the language is part of it.
    const only = node.children.filter((c) => !(c.type === 'text' && !c.raw.length));
    let lang = '';
    let kids = node.children;
    if (only.length === 1 && only[0].type === 'el' && only[0].tag === 'code') {
      const cls = (only[0].attrs.find(([k]) => k === 'class') || [])[1] || '';
      const m = /(?:^|\s)(?:language|lang)-([\w+-]+)/.exec(cls);
      if (m) lang = m[1];
      if (only[0].attrs.some(([k]) => k !== 'class')) lang += '*';
      kids = only[0].children;
    }
    const text = canonNodes(kids, true).replace(/^\n/, '').replace(/\s+$/, '');
    return `<pre${lang ? ` lang="${lang}"` : ''}${top ? '' : attrKey(node)}>${text}</pre>`;
  }
  const keep = CANON_ATTRS[tag] || [];
  let attrs = '';
  if (!top) {
    const sorted = node.attrs.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [k, v] of sorted) {
      // Anything beyond what Markdown can say marks the block as different.
      attrs += keep.includes(k) ? ` ${k}="${escAttr(v)}"` : ` ${k}*="${escAttr(v)}"`;
    }
  }
  if (VOID.has(node.tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${canonNodes(node.children, inPre)}</${tag}>`;
}
function attrKey(node) {
  return node.attrs.map(([k, v]) => ` ${k}*="${escAttr(v)}"`).join('');
}
function canonical(nodes, top) {
  const parts = nodes.filter((n) => !(n.type === 'text' && !n.raw.trim()));
  const s = parts.map((n) => (n.type === 'el' ? canonEl(n, top, false) : canonNodes([n], false))).join('');
  return s.replace(BLOCK_EDGE, '$1').trim();
}

// ---- HTML -> Markdown ----------------------------------------------------
const SIMPLE = /^(p|h[1-6]|ul|ol|blockquote|pre|hr|table)$/;
// A top-level attribute that makes a block the page's, not prose: kept as is.
const OWNED_ATTR = /^(data-tdoc-(?!aid$)|contenteditable$|hidden$)/;
const MAX_SPLIT_PASSES = 2000;
const HIDDEN = /^(script|style|link|meta|template|noscript)$/;
const HOUSE = /\b(tdoc-tiles|tdoc-tile|tdoc-cards|tdoc-card|note|diagram-box|slide|tdoc-artifact|tdoc-table-scroll)\b/;
// One placeholder, alone on its line: nothing after its `-->`.
const KEEP_LINE = /^<!--\s*tdoc:keep\s+(\d+)(?:\s(?:(?!-->)[^\n])*)?-->$/;

const SIMPLE_NAMES = { p: 'paragraph', ul: 'list', ol: 'list', blockquote: 'quote', pre: 'code', table: 'table', hr: 'divider' };
function label(node, html) {
  const kind = kindOf(node);
  const words = node.type === 'el' && !RAW.has(node.tag) && !/^(svg|template)$/.test(node.tag)
    ? decode(html.slice(node.openEnd, node.innerEnd).replace(/<(script|style|svg|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<\/?(?:b|strong|i|em|code|a|span|small|sup|sub|mark|u|s|abbr|kbd)\b[^>]*>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
    : '';
  return words ? `${kind}: ${words.length > 40 ? `${words.slice(0, 40).trim()}…` : words}` : kind;
}
function kindOf(node) {
  if (node.type === 'comment') return 'comment';
  if (node.type === 'text') return 'text';
  const attr = (k) => (node.attrs.find(([n]) => n === k) || [])[1];
  const cls = attr('class') || '';
  if (attr('data-tdoc-sheet') != null) return 'sheet';
  if (attr('data-tdoc-embed')) return `${attr('data-tdoc-embed')} embed`;
  if (attr('data-tdoc-excalidraw') != null || /\bdiagram-box\b/.test(cls)) return 'diagram';
  if (attr('data-tdoc-artifact') != null) return 'interactive block';
  const house = /\b(tdoc-tiles|tdoc-cards|note|tdoc-table-scroll|slide)\b/.exec(cls);
  if (house) return ({ 'tdoc-tiles': 'tiles', 'tdoc-cards': 'cards', note: 'note', 'tdoc-table-scroll': 'table', slide: 'slide' })[house[1]];
  if (node.tag === 'details') return 'details';
  if (node.tag === 'figure') return 'figure';
  if (node.tag === 'aside') return 'note';
  if (SIMPLE_NAMES[node.tag]) return SIMPLE_NAMES[node.tag];
  if (/^h[1-6]$/.test(node.tag)) return 'heading';
  if (/^(script|style|link|meta|template)$/.test(node.tag)) return 'page code';
  if (/^(img|svg|picture|video|audio|canvas|iframe)$/.test(node.tag)) return node.tag === 'iframe' ? 'embed' : 'media';
  return 'HTML';
}

// Text, images or media inside: an empty <p></p> or <p><br></p> is
// spacing, kept where it is.
function isEmpty(node, html) {
  if (node.type === 'text') return !node.raw.trim();
  if (node.type !== 'el') return false;
  if (!/^(p|div|h[1-6])$/.test(node.tag) || node.attrs.length) return false;
  const inner = html.slice(node.openEnd, node.innerEnd);
  return !/<(?!br\b|\/)/i.test(inner) && !decode(inner.replace(/<[^>]*>/g, '')).replace(/ /g, ' ').trim();
}

function blockMarkdown(node, html) {
  if (node.type !== 'el' || !SIMPLE.test(node.tag)) return null;
  if (node.attrs.some(([k]) => OWNED_ATTR.test(k))) return null;
  // The bare element through the shared converter: attributes on the block
  // itself are carried separately.
  const bare = `<${node.tag}>${html.slice(node.openEnd, node.innerEnd)}</${node.tag}>`;
  let md;
  if (node.tag === 'hr') md = '---';
  else md = builder().documentMarkdown(bare, {}).trim();
  if (!md || /\n{3,}/.test(md) || KEEP_LINE.test(md)) return null;
  // The way back has to give the same block. The download escapes every
  // character that could be syntax; the lighter text is used where it reads
  // back the same.
  const want = canonical([node], true);
  const same = (text) => {
    try { return canonical(parseFragment(markdownToHtml(text)), true) === want; } catch { return false; }
  };
  // Bounded before marked reads it: a block too heavy to read back stays
  // HTML (an agent can write 6,000 images with `*` in their alt text).
  try { guardMarkdown(md); } catch { return null; }
  const light = relaxEscapes(md);
  if (light !== md && same(light)) return light;
  return same(md) ? md : null;
}

// Backslashes Markdown does not need in running text: `\!` not before `[`,
// `\&` that starts no entity, `\_` inside a word, `\>` and `\<` mid-line
// before a space. Only ever used when the block reads back the same.
function relaxEscapes(md) {
  if (/^(```|~~~)/m.test(md)) return md;
  return md
    .replace(/\\!(?!\[)/g, '!')
    .replace(/\\&(?![#a-zA-Z0-9]+;)/g, '&')
    .replace(/(\w)\\_(?=\w)/g, '$1_')
    .replace(/(\S[^\S\n]*)\\>/g, '$1>')
    .replace(/\\<(?=[\s\d=])/g, '<');
}

// One placeholder per run of blocks Markdown cannot show.
function keepLine(id, labels) {
  const what = labels.length > 1 ? `${labels[0]} (+${labels.length - 1} more)` : labels[0];
  // The label is a reminder for the eye only: the number is what is read.
  return `<!-- tdoc:keep ${id} · ${what.replace(/[<>\n]/g, ' ').replace(/-{2,}/g, '-').replace(/-$/, '')} -->`;
}

export function toMarkdown(bodyHtml) {
  const html = String(bodyHtml == null ? '' : bodyHtml);
  let nodes;
  try { nodes = parseFragment(html); } catch {
    return { ok: false, reason: 'This doc\'s HTML can\'t be read as Markdown' };
  }
  // A doc wrapped in one plain container (<div class="page">…</div>): its
  // blocks are the doc's; the wrapper's tags stay as they are.
  let from = 0;
  for (let depth = 0; depth < 4; depth++) {
    const solid = nodes.filter((n) => !isEmpty(n, html) && n.type !== 'comment' && !(n.type === 'el' && HIDDEN.test(n.tag)));
    const only = solid.length === 1 ? solid[0] : null;
    if (!only || only.type !== 'el' || !/^(div|section|article|main)$/.test(only.tag)) break;
    if (only.attrs.some(([k, v]) => OWNED_ATTR.test(k) || (k === 'class' && HOUSE.test(v)))) break;
    nodes = only.children;
    from = only.openEnd;
  }
  // segments: { kind: 'md'|'keep', start, end, sep, md?, tag?, attrs?, id? }
  const segments = [];
  let sepStart = from;
  let run = null;
  const flushRun = () => {
    if (!run) return;
    segments.push(run);
    run = null;
  };
  for (const node of nodes) {
    if (isEmpty(node, html)) continue;
    const md = blockMarkdown(node, html);
    if (md != null) {
      flushRun();
      segments.push({ kind: 'md', start: node.start, end: node.end, sep: html.slice(sepStart, node.start), md, tag: node.tag, attrs: html.slice(node.start + 1 + node.tag.length, node.openEnd - 1) });
      sepStart = node.end;
      continue;
    }
    if (!run) run = { kind: 'keep', start: node.start, end: node.end, sep: html.slice(sepStart, node.start), labels: [] };
    run.end = node.end;
    run.labels.push(label(node, html));
    sepStart = node.end;
  }
  flushRun();
  const tail = html.slice(sepStart);
  let id = 0;
  for (const seg of segments) {
    if (seg.kind === 'keep') { seg.id = ++id; seg.md = keepLine(seg.id, seg.labels); seg.html = html.slice(seg.start, seg.end); }
  }
  // First, neighbour by neighbour (linear): a block that its predecessor
  // would swallow as Markdown (two lists in a row) stays HTML.
  for (let k = 1; k < segments.length; k++) {
    const a = segments[k - 1], b = segments[k];
    if (b.kind !== 'md') continue;
    const toks = blockTokens(`${a.md}\n\n${b.md}`);
    if (toks.length === 2 && toks[0].text === a.md && toks[1].text === b.md) continue;
    b.kind = 'keep';
    b.labels = [label(nodes.find((n) => n.start === b.start), html)];
    b.md = keepLine(0, b.labels);
  }
  for (let m = segments.length - 1; m > 0; m--) {
    const a = segments[m - 1], b = segments[m];
    if (a.kind === 'keep' && b.kind === 'keep') { a.end = b.end; a.labels = a.labels.concat(b.labels); segments.splice(m, 1); }
  }
  id = 0;
  for (const seg of segments) if (seg.kind === 'keep') { seg.id = ++id; seg.md = keepLine(seg.id, seg.labels); seg.html = html.slice(seg.start, seg.end); }
  // Two blocks that Markdown would read as one (two lists in a row): the
  // second stays HTML. Checked on the text as it will be read back, from
  // the block before the last mismatch on, until every block reads back as
  // itself; a doc where that does not settle keeps its rich editor.
  let from0 = 0;
  let settled = false;
  for (let pass = 0; pass <= MAX_SPLIT_PASSES; pass++) {
    const tokens = blockTokens(segments.slice(from0).map((s) => s.md).join('\n\n'));
    let bad = -1;
    for (let k = from0; k < segments.length; k++) {
      const tok = tokens[k - from0];
      if (!tok || tok.text !== segments[k].md) { bad = k; break; }
    }
    if (bad === -1 && tokens.length === segments.length - from0) { settled = true; break; }
    if (pass === MAX_SPLIT_PASSES) break;
    if (bad === -1) bad = segments.length - 1;
    from0 = Math.max(0, bad - 1);
    // Usually block `bad` swallowed the next one: the next one stays HTML.
    const target = bad + 1 < segments.length && segments[bad + 1].kind === 'md' ? bad + 1 : bad;
    const seg = segments[target];
    if (seg.kind !== 'md') return { ok: false, reason: 'This doc\'s layout can\'t be shown as Markdown' };
    seg.kind = 'keep';
    seg.labels = [label(nodes.find((n) => n.start === seg.start), html)];
    seg.html = html.slice(seg.start, seg.end);
    // Merge with keep neighbours and renumber.
    for (let m = segments.length - 1; m > 0; m--) {
      const a = segments[m - 1], b = segments[m];
      if (a.kind === 'keep' && b.kind === 'keep') {
        a.html = html.slice(a.start, b.end); a.end = b.end; a.labels = a.labels.concat(b.labels);
        segments.splice(m, 1);
      }
    }
    id = 0;
    for (const s of segments) if (s.kind === 'keep') { s.id = ++id; s.md = keepLine(s.id, s.labels); s.html = html.slice(s.start, s.end); }
    from0 = Math.min(from0, Math.max(0, segments.length - 1));
  }
  if (!settled) return { ok: false, reason: 'This doc\'s layout can\'t be shown as Markdown' };
  const mdCount = segments.filter((s) => s.kind === 'md').length;
  const keptCount = segments.length - mdCount;
  if (!mdCount && keptCount) {
    return { ok: false, reason: 'This doc is built from blocks Markdown can\'t show' };
  }
  const markdown = segments.map((s) => s.md).join('\n\n') + (segments.length ? '\n' : '');
  return {
    ok: true,
    markdown,
    kept: keptCount,
    snapshot: { bodyHtml: html, markdown, segments, prefix: html.slice(0, from), tail },
  };
}

// Top-level blocks as Markdown reads them: { text, token }. Block structure
// only: the inline text of a block is read when it is rendered, so blocks
// nobody edited cost nothing each time the page follows the view.
function blockTokens(md) {
  const lexer = new Lexer(marked.defaults);
  const tokens = lexer.blockTokens(String(md).replace(/\r\n?/g, '\n'), []);
  tokens.links = lexer.tokens.links;
  const out = [];
  for (const token of tokens) {
    if (token.type === 'space') continue;
    if (token.type === 'def') { out.push({ text: token.raw.trim(), token, def: true }); continue; }
    out.push({ text: token.raw.replace(/\s+$/, '').replace(/^\n+/, ''), token });
  }
  out.links = tokens.links;
  return out;
}

// Which blocks are untouched: the longest common subsequence of block
// texts. Past LCS_CELLS (a very long doc edited in many places) the middle
// is matched greedily on equal texts, in order: still only ever equal
// blocks paired, so untouched blocks keep their bytes.
const LCS_CELLS = 4_000_000;
function alignBlocks(a, b) {
  const n = a.length, m = b.length;
  const pairs = [];
  let lo = 0;
  while (lo < n && lo < m && a[lo] === b[lo]) { pairs.push([lo, lo]); lo++; }
  let ea = n, eb = m;
  const tailPairs = [];
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; tailPairs.unshift([ea, eb]); }
  const na = ea - lo, nb = eb - lo;
  if (na && nb && na * nb <= LCS_CELLS) {
    const w = nb + 1;
    const dp = new Uint32Array((na + 1) * w);
    for (let x = na - 1; x >= 0; x--) {
      for (let y = nb - 1; y >= 0; y--) {
        dp[x * w + y] = a[lo + x] === b[lo + y] ? dp[(x + 1) * w + y + 1] + 1 : Math.max(dp[(x + 1) * w + y], dp[x * w + y + 1]);
      }
    }
    let x = 0, y = 0;
    while (x < na && y < nb) {
      if (a[lo + x] === b[lo + y]) { pairs.push([lo + x, lo + y]); x++; y++; }
      else if (dp[(x + 1) * w + y] >= dp[x * w + y + 1]) x++;
      else y++;
    }
  } else if (na && nb) {
    const where = new Map();
    for (let x = lo; x < ea; x++) {
      const list = where.get(a[x]);
      if (list) list.push(x); else where.set(a[x], [x]);
    }
    const next = new Map();
    let last = lo - 1;
    for (let y = lo; y < eb; y++) {
      const list = where.get(b[y]);
      if (!list) continue;
      let i = next.get(b[y]) || 0;
      while (i < list.length && list[i] <= last) i++;
      next.set(b[y], i);
      if (i < list.length) { pairs.push([list[i], y]); last = list[i]; next.set(b[y], i + 1); }
    }
  }
  return pairs.concat(tailPairs);
}

const MAX_LIKENESS_PAIRS = 250_000;
const LIKENESS_WINDOW = 6;
// The numbers in a block, in order: "team 10, week 3" -> "10 3".
function numberKey(text) {
  const nums = String(text).match(/\d+(?:[.,]\d+)*/g);
  return nums ? nums.join(' ') : '';
}
// How alike two blocks' words are (0..1): an edited block keeps the
// attributes of the block it replaced only when it is that block.
function words(text) {
  return new Set(String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}
function likeness(x, y) {
  if (!x.size && !y.size) return 1;
  let same = 0;
  for (const w of x) if (y.has(w)) same++;
  return (2 * same) / (x.size + y.size);
}

// A copy of a kept block must not carry the original's ids: an id names
// one place (comment anchors, links), a sheet's id one sheet.
function withoutIds(blockHtml, copy) {
  let nodes;
  try { nodes = parseFragment(blockHtml); } catch { return blockHtml; }
  const edits = [];
  const walk = (list) => list.forEach((node) => {
    if (node.type !== 'el') return;
    // An SVG's ids are its own references (url(#arrow), <use href>): left
    // as they are, so the copy draws the same.
    if (node.tag === 'svg' || node.tag === 'math') return;
    const sheet = node.attrs.some(([k]) => k === 'data-tdoc-sheet');
    let changed = false;
    const attrs = [];
    for (const [k, v] of node.attrs) {
      if (k === 'id' || k === 'data-tdoc-aid') { changed = true; continue; }
      if (k === 'data-tdoc-sheet' && v) { attrs.push([k, `${v}-copy${copy}`]); changed = true; continue; }
      if (k === 'data-name' && sheet) { attrs.push([k, `${v || 'Sheet'} (copy${copy > 1 ? ` ${copy}` : ''})`]); changed = true; continue; }
      attrs.push([k, v]);
    }
    if (changed) {
      const self = /\/>$/.test(blockHtml.slice(node.start, node.openEnd)) ? ' /' : '';
      edits.push([node.start, node.openEnd, `<${node.tag}${attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')}${self}>`]);
    }
    walk(node.children);
  });
  walk(nodes);
  let out = blockHtml;
  for (let i = edits.length - 1; i >= 0; i--) out = out.slice(0, edits[i][0]) + edits[i][2] + out.slice(edits[i][1]);
  return out;
}

// An edited block that is still the same kind keeps the block's own
// attributes (id, data-tdoc-aid, class).
function withAttrs(blockHtml, tag, attrs) {
  if (!attrs || !attrs.trim()) return blockHtml;
  const open = `<${tag}`;
  if (!blockHtml.startsWith(open)) return blockHtml;
  const after = blockHtml[open.length];
  if (after !== '>' && after !== ' ') return blockHtml;
  // marked's own attributes (an ordered list's start) give way to the
  // original's only where the original has none.
  const gt = blockHtml.indexOf('>');
  const own = blockHtml.slice(open.length, gt);
  const merged = /\S/.test(own) && !/\bstart=/.test(attrs) ? `${attrs}${own}` : attrs;
  return `${open}${merged.startsWith(' ') ? '' : ' '}${merged}${blockHtml.slice(gt)}`;
}

export function fromMarkdown(markdown, snapshot) {
  const md = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
  if (md === snapshot.markdown) return { bodyHtml: snapshot.bodyHtml, removedKept: 0 };
  if (!snapshot.lines) snapshot.lines = new Set(snapshot.markdown.split('\n'));
  guardMarkdown(md, snapshot.lines);
  const segs = snapshot.segments;
  const byId = new Map(segs.filter((s) => s.kind === 'keep').map((s) => [s.id, s]));
  const blocks = blockTokens(md);
  const oldKeys = segs.map((s) => (s.kind === 'keep' ? `\u0000keep:${s.id}` : s.md));
  const keyOf = (b) => {
    const k = KEEP_LINE.exec(b.text);
    if (k && b.token.type === 'html' && byId.has(Number(k[1]))) return `\u0000keep:${Number(k[1])}`;
    return b.text;
  };
  const newKeys = blocks.map(keyOf);
  const pairs = alignBlocks(oldKeys, newKeys);
  const matchedNew = new Map(pairs.map(([o, nn]) => [nn, o]));
  const matchedOld = new Set(pairs.map(([o]) => o));
  // For an edited block: the original block it replaced, from the
  // unmatched originals between the same two matched blocks. One for one
  // when the gap is one block on each side; otherwise only an original whose
  // words it mostly shares (a deleted neighbour never lends its id).
  const replaces = new Map();
  let compared = 0;
  const pairGap = (gapNew, gapOld) => {
    const olds = gapOld.filter((o) => segs[o].kind === 'md');
    const news = gapNew.filter((nn) => !newKeys[nn].startsWith('\u0000keep:') && !blocks[nn].def);
    if (gapOld.length === 1 && gapNew.length === 1 && olds.length === 1 && news.length === 1) {
      replaces.set(news[0], olds[0]);
      return;
    }
    // A rewrite of thousands of blocks at once: past the budget, edited
    // blocks start without the originals' attributes rather than freeze
    // the page (never with a wrong block's).
    const oldWords = new Map(olds.map((o) => [o, words(segs[o].md)]));
    compared += olds.length * news.length;
    if (compared > MAX_LIKENESS_PAIRS) {
      // Thousands rewritten at once: in order and linear. A block with
      // numbers in it ("team 10") only looks at originals with the same
      // numbers (an index, so a run of deleted look-alikes in between can't
      // hand it their ids); any other block, at the next few originals.
      const byNumbers = new Map();
      olds.forEach((o, k) => {
        const key = numberKey(segs[o].md);
        if (!key) return;
        const list = byNumbers.get(key);
        if (list) list.push(k); else byNumbers.set(key, [k]);
      });
      let at = 0;
      for (const nn of news) {
        const mine = words(blocks[nn].text);
        const key = numberKey(blocks[nn].text);
        const candidates = key
          ? (byNumbers.get(key) || []).filter((k) => k >= at).slice(0, LIKENESS_WINDOW)
          : Array.from({ length: Math.max(0, Math.min(olds.length, at + LIKENESS_WINDOW) - at) }, (_, i) => at + i).filter((k) => !numberKey(segs[olds[k]].md));
        let best = -1, score = 0.5;
        for (const k of candidates) {
          const sc = likeness(mine, oldWords.get(olds[k]));
          if (sc > score || (best === -1 && sc >= score)) { best = k; score = sc; }
        }
        if (best !== -1) { replaces.set(nn, olds[best]); at = best + 1; }
      }
      return;
    }
    const taken = new Set();
    for (const nn of news) {
      const mine = words(blocks[nn].text);
      let best = -1, score = 0.5;
      for (const o of olds) {
        if (taken.has(o)) continue;
        const sc = likeness(mine, oldWords.get(o));
        // On a tie the earlier original wins (two paragraphs merged keep the first's id).
        if (sc > score || (best === -1 && sc >= score)) { best = o; score = sc; }
      }
      if (best !== -1) { taken.add(best); replaces.set(nn, best); }
    }
  };
  let prevOld = -1;
  let pending = [];
  const sorted = pairs.slice().sort((p, q) => p[1] - q[1]);
  let pi = 0;
  for (let nn = 0; nn <= blocks.length; nn++) {
    const nextOld = pi < sorted.length && sorted[pi][1] === nn ? sorted[pi][0] : (nn === blocks.length ? segs.length : null);
    if (nextOld != null) {
      const gapOld = [];
      for (let o = prevOld + 1; o < nextOld; o++) if (!matchedOld.has(o)) gapOld.push(o);
      if (pending.length && gapOld.length) pairGap(pending, gapOld);
      pending = [];
      if (nn < blocks.length) { prevOld = nextOld; pi++; }
      continue;
    }
    pending.push(nn);
  }
  // Every block that will be read as Markdown now (not matched to an
  // original) is bounded first, whatever its lines looked like before: a
  // code fence's opening line deleted turns its known lines into a new
  // paragraph, and that paragraph is new to marked.
  const fresh = [];
  blocks.forEach((b, nn) => {
    if (b.def || matchedNew.has(nn) || newKeys[nn].startsWith('\u0000keep:')) return;
    fresh.push(b.token.raw);
  });
  if (fresh.length) guardMarkdown(fresh.join('\n\n'));
  let out = snapshot.prefix || '';
  const uses = new Map();
  const keepHtml = (seg) => {
    const n = (uses.get(seg.id) || 0) + 1;
    uses.set(seg.id, n);
    return n === 1 ? seg.html : withoutIds(seg.html, n - 1);
  };
  // Matched placeholders first: a moved or copied one is the copy, never
  // the one still in its place.
  for (const [o] of pairs) if (segs[o].kind === 'keep') uses.set(segs[o].id, 1);
  blocks.forEach((b, nn) => {
    if (b.def) return;
    const o = matchedNew.get(nn);
    if (o != null) {
      const seg = segs[o];
      out += seg.sep + (seg.kind === 'keep' ? seg.html : snapshot.bodyHtml.slice(seg.start, seg.end));
      return;
    }
    const key = newKeys[nn];
    if (key.startsWith('\u0000keep:')) {
      // A placeholder moved or copied: the same HTML, from this document.
      out += '\n' + keepHtml(byId.get(Number(key.slice(6))));
      return;
    }
    let blockHtml = renderBlock(b.token.raw, blocks.links).replace(/\s+$/, '');
    const was = replaces.has(nn) ? segs[replaces.get(nn)] : null;
    if (was && was.kind === 'md') blockHtml = withAttrs(blockHtml, was.tag, was.attrs);
    if (blockHtml) out += (was ? was.sep : '\n') + blockHtml;
  });
  out += snapshot.tail;
  let removedKept = 0;
  for (const id of byId.keys()) if (!uses.has(id)) removedKept++;
  return { bodyHtml: out, removedKept };
}

// Markdown a person could type but marked takes seconds (or the stack) to
// read: refused with a reason, before it is read. A real doc is far inside.
export class MarkdownTooComplex extends Error {}
const MAX_MD_CHARS = 4_000_000;
const MAX_QUOTE_DEPTH = 16;
const MAX_LIST_DEPTH = 16;
// Emphasis is where marked's work grows with the square of the input:
// delimiter runs that could open or close (measured: 1,000 unclosed openers
// 0.3 s, 2,000 1-2 s, and the punctuation before them does not matter).
// So the guard bounds the work, not a pattern: in one run of inline text
// it counts every `*` / `~` run except one with spaces on both sides, and
// every `_` run except one inside a word (snake_case), skipping escaped
// ones. A paragraph, a heading, a list item and a table row are runs of
// their own; code (fenced or indented) is not inline text and is never
// counted; and only runs with a line that is not in the doc as it opened
// are checked, so text that was already there is never refused.
const MAX_DELIMITERS_PER_RUN = 800;
// Link openers `](` waiting for their `)`: worse still (400 of them 0.4 s,
// 800 3 s). And since the cost of a run grows with the square of its count,
// the whole edited text has a budget too: many runs each just under their
// cap (50 list items of 790) would add up to seconds.
const MAX_LINK_OPENERS_PER_RUN = 150;
const MAX_TOTAL_COST = 4;
function linkOpeners(line) {
  let n = 0;
  for (let i = line.indexOf(']('); i !== -1; i = line.indexOf('](', i + 2)) {
    let slashes = 0;
    for (let k = i - 1; k >= 0 && line[k] === '\\'; k--) slashes++;
    if (slashes % 2 === 0) n++;
  }
  return n;
}
const ALNUM = /[\p{L}\p{N}]/u;
function delimiterRuns(line) {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== '*' && c !== '_' && c !== '~') continue;
    let j = i;
    while (j + 1 < line.length && line[j + 1] === c) j++;
    let slashes = 0;
    for (let k = i - 1; k >= 0 && line[k] === '\\'; k--) slashes++;
    const before = i > 0 ? line[i - 1] : ' ';
    const after = j + 1 < line.length ? line[j + 1] : ' ';
    const escaped = slashes % 2 === 1 && i === j;
    const spaced = /\s/.test(before) && /\s/.test(after);
    const inWord = c === '_' && ALNUM.test(before) && ALNUM.test(after);
    if (!escaped && !spaced && !inWord) n++;
    i = j;
  }
  return n;
}
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const MARKER = /^([ \t]*)((?:>[ \t]?)*)[ \t]*((?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))/;
const indentOf = (line) => /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
export function guardMarkdown(md, known = null) {
  if (md.length > MAX_MD_CHARS) throw new MarkdownTooComplex('This Markdown is too long to convert');
  let run = 0;
  let links = 0;
  let total = 0;
  let runNew = false;
  let fence = null;
  let prevBlank = true;
  let inCode = false;
  let stack = [];
  const endRun = () => {
    if (runNew) {
      if (run > MAX_DELIMITERS_PER_RUN) throw new MarkdownTooComplex('A paragraph has too much * or _ formatting to convert');
      if (links > MAX_LINK_OPENERS_PER_RUN) throw new MarkdownTooComplex('A paragraph has too many links to convert');
      total += (run / MAX_DELIMITERS_PER_RUN) ** 2 + (links / MAX_LINK_OPENERS_PER_RUN) ** 2;
      if (total > MAX_TOTAL_COST) throw new MarkdownTooComplex('This edit has too much formatting to convert at once');
    }
    run = 0; links = 0; runNew = false;
  };
  let start = 0;
  while (start <= md.length) {
    let end = md.indexOf('\n', start);
    if (end === -1) end = md.length;
    const line = md.slice(start, end);
    start = end + 1;
    if (fence) {
      const close = FENCE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !line.slice(close[0].length).trim()) fence = null;
      continue;
    }
    const open = FENCE.exec(line);
    if (open && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) { endRun(); fence = open[1]; prevBlank = false; continue; }
    if (!line.trim()) { endRun(); prevBlank = true; inCode = false; continue; }
    const lead = indentOf(line);
    // Indented code: 4+ spaces opening a block outside a list.
    if (!stack.length && lead >= 4 && (prevBlank || inCode)) { inCode = true; prevBlank = false; continue; }
    inCode = false;
    const quotes = /^(?:[ \t]{0,3}>)+/.exec(line);
    if (quotes && quotes[0].split('>').length - 1 > MAX_QUOTE_DEPTH) throw new MarkdownTooComplex('Quotes are nested too deeply to convert');
    const isNew = !known || !known.has(line);
    if (RULE.test(line)) { endRun(); prevBlank = false; continue; }
    const marker = MARKER.exec(line);
    if (marker) {
      endRun();
      // Nesting: an item deeper than the open ones nests under them.
      const at = lead + (marker[2] ? marker[2].length : 0);
      while (stack.length && stack[stack.length - 1] >= at) stack.pop();
      stack.push(at);
      // `- - - x` nests on one line.
      const rest = line.slice(marker[0].length);
      const same = /^(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*/.exec(rest)[0];
      const extra = (same.match(/(?:[-*+]|\d{1,9}[.)])[ \t]+/g) || []).length;
      if (stack.length + extra > MAX_LIST_DEPTH) throw new MarkdownTooComplex('Lists are nested too deeply to convert');
    } else if (prevBlank && lead === 0) {
      stack = [];
    }
    if (/^[ \t]*(?:#{1,6}[ \t]|\|)/.test(line)) endRun();
    run += delimiterRuns(line);
    links += linkOpeners(line);
    if (isNew) runNew = true;
    if (/^[ \t]*#{1,6}[ \t]/.test(line)) endRun();
    prevBlank = false;
  }
  endRun();
}
