// What a doc is, for its row in My docs: a sheet, slides, or a doc. One
// definition for the server (worker/worker.js inlines this file as code, the
// way it inlines shell/src/notification-text.js) and the sheets viewer
// (server/sheets-source.js inlines it as `DocType`), so the label and the
// viewer cannot drift apart.
//
//   slides  any [data-tdoc-slide] element: slides are not embedded in prose
//           the way tables are, so a doc with slide sections is a deck (the
//           slides viewer's own test), even when a slide holds a sheet.
//   sheet   a pure sheet doc: one or more <table data-tdoc-sheet>, and at most
//           a title (<h1>) and a note (.sheet-note) around them -- the sheets
//           viewer's "sheet-only doc" (isSheetOnly: no expand button there).
//           A prose doc that merely holds sheet tables is a doc.
//   doc     everything else.
//
// Must not import anything and exports only `export const|function`: it is
// inlined into the worker and into the frame.

// Bumped whenever the rule changes: a stamp (meta.preview.kind_v) or a cached
// answer (doc-types:<actor>) that may not hold under this version is ignored
// and detected again. v1 (#1008) called any doc holding a sheet table a
// sheet, so of its answers only "sheet" is detected again: its "doc" and
// "slides" still hold (worker docTypeOfStamp).
export const DOC_TYPE_VERSION = 2;

// The sheet-only rule, as data: outside these elements a sheet-only doc's
// body holds no text and none of the media elements.
export const SHEET_ONLY_RULE = {
  sheet: { tag: 'table', attr: 'data-tdoc-sheet' },
  // The parts a sheet-only doc may have besides its tables.
  skipTags: ['script', 'style', 'noscript', 'template', 'h1', 'caption'],
  skipClasses: ['sheet-note'],
  skipAttrs: ['data-tdoc-provider'],
  // Content that is not text but still makes the doc more than a sheet.
  media: ['img', 'svg', 'video', 'canvas', 'iframe', 'figure'],
};

// The same rule as CSS selectors, for the viewer's DOM walk.
export const SHEET_ONLY_SKIP_SELECTOR = [
  SHEET_ONLY_RULE.sheet.tag + '[' + SHEET_ONLY_RULE.sheet.attr + ']',
  ...SHEET_ONLY_RULE.skipAttrs.map((a) => '[' + a + ']'),
  ...SHEET_ONLY_RULE.skipTags,
  ...SHEET_ONLY_RULE.skipClasses.map((c) => '.' + c),
].join(',');
export const SHEET_ONLY_MEDIA_SELECTOR = SHEET_ONLY_RULE.media.join(',');

// Is the attribute on some opening tag (tagOk(name) decides which)? One
// forward pass, linear in the HTML whatever it holds: each hit of the
// attribute name is checked against the last '<' and '>' seen so far (kept as
// the scan moves, never searched backwards), so a page of hostile markup
// costs what a page of prose does. No regex over the document: one that
// backtracked took 11 s on 256 KB.
export function htmlHasTagAttr(html, attr, tagOk) {
  let lastLt = -1;
  let lastGt = -1;
  let pos = 0;
  for (let hit = html.indexOf(attr); hit !== -1; hit = html.indexOf(attr, hit + attr.length)) {
    for (; pos < hit; pos++) {
      const c = html.charCodeAt(pos);
      if (c === 60) lastLt = pos; // <
      else if (c === 62) lastGt = pos; // >
    }
    // Inside a tag: a '<' with no '>' after it, and the name is a whole
    // attribute -- whitespace before, and '=', whitespace, '/', '>' or the
    // end after (so data-tdoc-slides is not data-tdoc-slide).
    if (lastLt === -1 || lastGt > lastLt) continue;
    const before = html.charCodeAt(hit - 1);
    if (!(before === 32 || (before >= 9 && before <= 13))) continue;
    const after = hit + attr.length < html.length ? html.charCodeAt(hit + attr.length) : -1;
    if (!(after === -1 || after === 61 || after === 47 || after === 62 || after === 32 || (after >= 9 && after <= 13))) continue;
    // The tag's name: letters, digits and '-' right after the '<', ended by
    // whitespace (a name ended by anything else is not an opening tag).
    let end = lastLt + 1;
    const nameLimit = Math.min(hit, lastLt + 65);
    while (end < nameLimit) {
      const c = html.charCodeAt(end);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57 && end > lastLt + 1) || (c === 45 && end > lastLt + 1)) end++;
      else break;
    }
    const sep = html.charCodeAt(end);
    if (end === lastLt + 1 || end > lastLt + 64 || !(sep === 32 || (sep >= 9 && sep <= 13))) continue;
    if (tagOk(html.slice(lastLt + 1, end).toLowerCase())) return true;
  }
  return false;
}

// Each tag name the walk cares about, with what it is (bit flags), looked up
// once per tag. Built from SHEET_ONLY_RULE, plus how HTML parses: void
// elements, raw text, and what a <head> may hold.
// Keyed by a hash of the name computed as the walk reads it (no string made
// per tag), and checked against the name itself.
const DT_SKIP = 1, DT_MEDIA = 2, DT_RAW = 4, DT_RAW_TEXT = 8, DT_VOID = 16, DT_HEAD_OK = 32, DT_HEAD = 64, DT_BODY = 128, DT_SHEET = 256;
const DOC_TYPE_TAGS = new Map();
function docTypeHash(name) { let h = 0; for (let k = 0; k < name.length; k++) h = (Math.imul(h, 31) + name.charCodeAt(k)) | 0; return h; }
function docTypeFlag(names, flag) {
  for (const name of names) {
    const h = docTypeHash(name);
    const entry = DOC_TYPE_TAGS.get(h) || { name, flags: 0 };
    if (entry.name !== name) throw new Error('doc-type: tag hash collision ' + name);
    entry.flags |= flag;
    DOC_TYPE_TAGS.set(h, entry);
  }
}
docTypeFlag(SHEET_ONLY_RULE.skipTags, DT_SKIP);
docTypeFlag(SHEET_ONLY_RULE.media, DT_MEDIA);
docTypeFlag(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'], DT_VOID);
// Raw text, jumped over to its end tag: a script, style or title holds no
// content; a textarea and the like do (DT_RAW_TEXT).
docTypeFlag(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext'], DT_RAW);
docTypeFlag(['textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext'], DT_RAW_TEXT);
// What a <head> may hold; anything else starts the body (as a parser does).
docTypeFlag(['meta', 'link', 'title', 'style', 'script', 'base', 'noscript', 'template'], DT_HEAD_OK);
docTypeFlag(['head'], DT_HEAD);
docTypeFlag(['body'], DT_BODY);
docTypeFlag([SHEET_ONLY_RULE.sheet.tag], DT_SHEET);

// Is the HTML a sheet-only doc (SHEET_ONLY_RULE)? A tokenizer walk, each
// character read once: tags and their attributes left to right, comments and
// raw text (script, style) and skipped elements (docTypeSkipPast) jumped
// over with indexOf from the current place. Returns false at the first text
// or media outside the skipped parts.
export function htmlIsSheetOnly(html) {
  const n = html.length;
  const lower = html.toLowerCase();
  // No sheet table at all: the cheap scan answers.
  if (!htmlHasTagAttr(html, SHEET_ONLY_RULE.sheet.attr, (tag) => tag === SHEET_ONLY_RULE.sheet.tag)) return false;
  let sheets = 0;
  let inHead = false;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (!inHead) {
      for (let k = i; k < textEnd; k++) {
        const c = html.charCodeAt(k);
        if (c === 32 || (c >= 9 && c <= 13) || c === 160) continue;
        // &nbsp; and its numeric forms are whitespace to trim() too.
        if (c === 38 && (lower.startsWith('&nbsp;', k) || lower.startsWith('&#160;', k) || lower.startsWith('&#xa0;', k))) { k += 5; continue; }
        return false;
      }
    }
    if (lt === -1) break;
    i = lt + 1;
    const c0 = html.charCodeAt(i);
    if (c0 === 33) { // <!-- comment --> or <!doctype>
      if (html.startsWith('!--', i)) { const e = html.indexOf('-->', i + 3); i = e === -1 ? n : e + 3; }
      else { const e = html.indexOf('>', i); i = e === -1 ? n : e + 1; }
      continue;
    }
    if (c0 === 63) { const e = html.indexOf('>', i); i = e === -1 ? n : e + 1; continue; } // <?...>
    const closing = c0 === 47;
    if (closing) i++;
    const c1 = lower.charCodeAt(i);
    if (!(c1 >= 97 && c1 <= 122)) {
      // Not a tag: a bare '<' is text.
      if (closing) { const e = html.indexOf('>', i); i = e === -1 ? n : e + 1; continue; }
      if (!inHead) return false;
      continue;
    }
    const nameStart = i;
    let hash = 0;
    for (; i < n; i++) {
      const c = lower.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 58 || c === 46)) break;
      hash = (Math.imul(hash, 31) + c) | 0;
    }
    const nameLen = i - nameStart;
    const known = DOC_TYPE_TAGS.get(hash);
    const tag = known && known.name.length === nameLen && lower.startsWith(known.name, nameStart) ? known : null;
    const flags = tag ? tag.flags : 0;
    // The attributes, each read once and compared in place, never sliced (a
    // tag may hold a million of them).
    let sheetAttr = false, skipAttr = false, skipClass = false;
    while (i < n) {
      const c = html.charCodeAt(i);
      if (c === 62) { i++; break; }
      if (c === 32 || (c >= 9 && c <= 13) || c === 47) { i++; continue; }
      const aStart = i;
      for (; i < n; i++) {
        const a = html.charCodeAt(i);
        if (a === 32 || (a >= 9 && a <= 13) || a === 61 || a === 62 || a === 47) break;
      }
      if (i === aStart) { i++; continue; }
      const attr = closing ? 0 : docTypeAttr(lower, aStart, i - aStart);
      if (attr === 1) sheetAttr = true;
      else if (attr === 2) skipAttr = true;
      let j = i;
      while (j < n) { const w = html.charCodeAt(j); if (w === 32 || (w >= 9 && w <= 13)) j++; else break; }
      if (html.charCodeAt(j) !== 61) continue;
      j++;
      while (j < n) { const w = html.charCodeAt(j); if (w === 32 || (w >= 9 && w <= 13)) j++; else break; }
      const q = html.charCodeAt(j);
      let vStart, vEnd;
      if (q === 34 || q === 39) {
        const e = html.indexOf(q === 34 ? '"' : "'", j + 1);
        vStart = j + 1; vEnd = e === -1 ? n : e;
        i = e === -1 ? n : e + 1;
      } else {
        vStart = j;
        while (j < n) { const w = html.charCodeAt(j); if (w === 32 || (w >= 9 && w <= 13) || w === 62) break; j++; }
        vEnd = j;
        i = j;
      }
      if (attr === 3 && !skipClass) skipClass = docTypeHasClass(lower, vStart, vEnd);
    }
    if (flags & DT_HEAD) { inHead = !closing; continue; }
    if ((flags & DT_BODY) && !closing) { inHead = false; continue; }
    if (inHead && !closing && !(flags & DT_HEAD_OK)) inHead = false;
    if (closing) continue;
    const isSheet = (flags & DT_SHEET) && sheetAttr;
    if (isSheet) sheets++;
    const skipped = isSheet || skipAttr || skipClass || (flags & DT_SKIP) || inHead;
    if (!skipped && (flags & DT_MEDIA)) return false;
    if (flags & DT_RAW) {
      if (!skipped && (flags & DT_RAW_TEXT)) return false;
      i = docTypeAfterRaw(lower, tag.name, i, n);
      continue;
    }
    if (skipped && !inHead && !(flags & DT_VOID) && html.charCodeAt(i - 2) !== 47) {
      i = docTypeSkipPast(lower, lower.slice(nameStart, nameStart + nameLen), i, n);
    }
  }
  return sheets > 0;
}
// Which of the rule's attributes this is: 1 the sheet's, 2 a skipped part's,
// 3 class, 0 any other.
function docTypeAttr(lower, at, len) {
  if (len === 5) return lower.startsWith('class', at) ? 3 : 0;
  if (len === SHEET_ONLY_RULE.sheet.attr.length && lower.startsWith(SHEET_ONLY_RULE.sheet.attr, at)) return 1;
  const skip = SHEET_ONLY_RULE.skipAttrs;
  for (let k = 0; k < skip.length; k++) if (len === skip[k].length && lower.startsWith(skip[k], at)) return 2;
  return 0;
}
// Does the class value lower[from, to) hold one of the rule's classes as a
// whole token?
function docTypeHasClass(lower, from, to) {
  const classes = SHEET_ONLY_RULE.skipClasses;
  for (let k = 0; k < classes.length; k++) {
    const cls = classes[k];
    for (let at = lower.indexOf(cls, from); at !== -1 && at + cls.length <= to; at = lower.indexOf(cls, at + 1)) {
      const before = at === from ? 32 : lower.charCodeAt(at - 1);
      const after = at + cls.length === to ? 32 : lower.charCodeAt(at + cls.length);
      if ((before === 32 || (before >= 9 && before <= 13)) && (after === 32 || (after >= 9 && after <= 13))) return true;
    }
  }
  return false;
}
// Past the end tag that closes a skipped element opened just before `from`
// (a sheet table, the title, a note): what is inside is not looked at, only
// the nesting of its own name, found with indexOf -- the next opening and the
// next closing tag, each searched for again only once passed, so the whole
// skip reads each character a bounded number of times.
function docTypeSkipPast(lower, name, from, n) {
  const open = '<' + name, close = '</' + name;
  let depth = 1;
  let pos = from;
  let o = docTypeFind(lower, open, pos);
  for (;;) {
    const c = docTypeFind(lower, close, pos);
    if (c === -1) return n;
    while (o !== -1 && o < c) { depth++; o = docTypeFind(lower, open, o + 1); }
    pos = c + close.length;
    if (--depth === 0) {
      const gt = lower.indexOf('>', pos);
      return gt === -1 ? n : gt + 1;
    }
  }
}
// The next `<name` or `</name` from `at` that is the whole name.
function docTypeFind(lower, what, at) {
  for (let o = lower.indexOf(what, at); o !== -1; o = lower.indexOf(what, o + 1)) {
    const c = lower.charCodeAt(o + what.length);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 58 || c === 46)) return o;
  }
  return -1;
}
// Past the end tag of a raw-text element opened just before `from`.
function docTypeAfterRaw(lower, name, from, n) {
  const e = lower.indexOf('</' + name, from);
  if (e === -1) return n;
  const gt = lower.indexOf('>', e);
  return gt === -1 ? n : gt + 1;
}

export function docTypeFromHtml(html) {
  const text = typeof html === 'string' ? html : '';
  if (htmlHasTagAttr(text, 'data-tdoc-slide', () => true)) return 'slides';
  if (htmlIsSheetOnly(text)) return 'sheet';
  return 'doc';
}
