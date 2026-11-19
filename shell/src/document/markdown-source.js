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
import { Marked } from 'marked';
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
      const lower = html.toLowerCase();
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

function renderTokens(tokens, links) {
  const list = tokens.slice();
  list.links = links || {};
  return sanitizeHtml(marked.parser(list));
}
export function markdownToHtml(md) {
  const tokens = marked.lexer(String(md || ''));
  return renderTokens(tokens, tokens.links);
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
const HIDDEN = /^(script|style|link|meta|template|noscript)$/;
const HOUSE = /\b(tdoc-tiles|tdoc-tile|tdoc-cards|tdoc-card|note|diagram-box|slide|tdoc-artifact|tdoc-table-scroll)\b/;
const KEEP_LINE = /^<!--\s*tdoc:keep\s+(\d+)\b[^\n]*?-->$/;

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
  // Two blocks that Markdown would read as one (two lists in a row): the
  // second stays HTML. Checked on the whole text, as it will be read back.
  for (let pass = 0; pass < 8; pass++) {
    const tokens = blockTokens(segments.map((s) => s.md).join('\n\n'));
    let bad = -1;
    for (let k = 0; k < segments.length; k++) {
      if (!tokens[k] || tokens[k].text !== segments[k].md) { bad = k; break; }
    }
    if (bad === -1 && tokens.length === segments.length) break;
    if (bad === -1) bad = segments.length - 1;
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
  }
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

// Top-level blocks as Markdown reads them: { text, token }.
function blockTokens(md) {
  const tokens = marked.lexer(md);
  const out = [];
  for (const token of tokens) {
    if (token.type === 'space') continue;
    if (token.type === 'def') { out.push({ text: token.raw.trim(), token, def: true }); continue; }
    out.push({ text: token.raw.replace(/\s+$/, '').replace(/^\n+/, ''), token });
  }
  out.links = tokens.links;
  return out;
}

// Longest common subsequence of block texts: which blocks are untouched.
function alignBlocks(a, b) {
  const n = a.length, m = b.length;
  const pairs = [];
  let lo = 0;
  while (lo < n && lo < m && a[lo] === b[lo]) { pairs.push([lo, lo]); lo++; }
  let ea = n, eb = m;
  const tailPairs = [];
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; tailPairs.unshift([ea, eb]); }
  const na = ea - lo, nb = eb - lo;
  if (na && nb && na * nb <= 4_000_000) {
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
  }
  return pairs.concat(tailPairs);
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
  // For an edited block: the original block it replaced, if any (the
  // unmatched originals between the same two matched blocks, in order).
  const replaces = new Map();
  let prevOld = -1;
  let pending = [];
  const sorted = pairs.slice().sort((p, q) => p[1] - q[1]);
  let pi = 0;
  for (let nn = 0; nn <= blocks.length; nn++) {
    const nextOld = pi < sorted.length && sorted[pi][1] === nn ? sorted[pi][0] : (nn === blocks.length ? segs.length : null);
    if (nextOld != null) {
      const gapOld = [];
      for (let o = prevOld + 1; o < nextOld; o++) if (!matchedOld.has(o)) gapOld.push(o);
      pending.forEach((newIndex, k) => { if (k < gapOld.length) replaces.set(newIndex, gapOld[k]); });
      pending = [];
      if (nn < blocks.length) { prevOld = nextOld; pi++; }
      continue;
    }
    pending.push(nn);
  }
  let out = snapshot.prefix || '';
  const used = new Set();
  blocks.forEach((b, nn) => {
    if (b.def) return;
    const o = matchedNew.get(nn);
    if (o != null) {
      const seg = segs[o];
      out += seg.sep + (seg.kind === 'keep' ? seg.html : snapshot.bodyHtml.slice(seg.start, seg.end));
      if (seg.kind === 'keep') used.add(seg.id);
      return;
    }
    const key = newKeys[nn];
    if (key.startsWith('\u0000keep:')) {
      // A placeholder moved or copied: the same HTML, from this document.
      const seg = byId.get(Number(key.slice(6)));
      out += '\n' + seg.html;
      used.add(seg.id);
      return;
    }
    let blockHtml = renderTokens([b.token], blocks.links).replace(/\s+$/, '');
    const was = replaces.has(nn) ? segs[replaces.get(nn)] : null;
    if (was && was.kind === 'md') blockHtml = withAttrs(blockHtml, was.tag, was.attrs);
    if (blockHtml) out += (was ? was.sep : '\n') + blockHtml;
  });
  out += snapshot.tail;
  let removedKept = 0;
  for (const id of byId.keys()) if (!used.has(id)) removedKept++;
  return { bodyHtml: out, removedKept };
}
