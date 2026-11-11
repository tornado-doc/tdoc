// Sheets: the pure half. Column types, value parsing, type inference, and the
// view query (search, per-column filters, multi-column sort) over a sheet's
// rows. No DOM and no framework: the in-frame viewer (server/sheets-viewer.js,
// which inlines this file with its `export`s stripped), the shell (view state in
// the URL, and later the comment panel) and the CLI importer all run this same
// code. Filter, sort, search and the summary row are VIEW state: nothing here
// edits a document.
//
// Data shape. A sheet is { columns, rows }:
//   columns[c] = { name, type, palette? }      type: one of TYPES
//   rows[r]    = { id, cells: [raw, ...] }      raw: string, or string[] for tags
// buildIndex() turns that into column vectors once; runQuery() answers a query
// against the index with an array of row positions (filtered, then sorted).

export const TYPES = Object.freeze(['text', 'number', 'date', 'tags', 'checkbox', 'url']);

// Named tag colours. A column's palette (`data-palette="urgent:red, later:gray"`)
// picks from these; a tag the palette does not name gets a stable colour from
// its text, so the same tag is the same colour everywhere it appears.
export const TAG_COLORS = Object.freeze({
  gray: ['#eef0f3', '#3f4652'],
  red: ['#fde8e7', '#a3261d'],
  orange: ['#feeedd', '#9a4a07'],
  yellow: ['#fdf4cf', '#7a5a00'],
  green: ['#e3f5e6', '#1f6b31'],
  teal: ['#ddf3f1', '#11655d'],
  blue: ['#e3edfd', '#1d4fa8'],
  purple: ['#efe7fc', '#5b33a0'],
  pink: ['#fce6f1', '#9b2160'],
});
const AUTO_COLORS = ['blue', 'green', 'purple', 'orange', 'teal', 'pink', 'yellow', 'red', 'gray'];

export function normalizeType(type) {
  const t = String(type || '').trim().toLowerCase();
  return TYPES.includes(t) ? t : 'text';
}

// ---- palettes -------------------------------------------------------------

export function parsePalette(attr) {
  const out = {};
  String(attr || '').split(/[;,]/).forEach((part) => {
    const at = part.lastIndexOf(':');
    if (at <= 0) return;
    const tag = part.slice(0, at).trim();
    const color = part.slice(at + 1).trim().toLowerCase();
    if (tag && TAG_COLORS[color]) out[tag] = color;
  });
  return out;
}

export function formatPalette(palette) {
  return Object.keys(palette || {})
    .filter((tag) => TAG_COLORS[palette[tag]] && !/[,;:]/.test(tag))
    .map((tag) => `${tag}:${palette[tag]}`).join(', ');
}

export function tagColor(tag, palette) {
  const named = palette && palette[tag];
  if (named && TAG_COLORS[named]) return named;
  let h = 0;
  const s = String(tag).toLowerCase();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AUTO_COLORS[h % AUTO_COLORS.length];
}

// ---- values ---------------------------------------------------------------

const NUM_STRIP = /[\s,  '’_]|^[$€£¥₹₩]|[$€£¥₹₩]$/g;
export function parseNumber(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  let s = String(text == null ? '' : text).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  let percent = false;
  if (s.endsWith('%')) { percent = true; s = s.slice(0, -1); }
  s = s.replace(NUM_STRIP, '').replace(/^[$€£¥₹₩]/, '').replace(/^\+/, '');
  if (!/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // 12% sorts and filters as 12, as written; the display keeps the sign.
  return negative ? -n : percent ? n : n;
}

// Dates are compared as UTC milliseconds at midnight (or the given time).
// ISO first, then the two common slash orders. Ambiguous d/m vs m/d resolves
// to month-first unless the first number cannot be a month.
export function parseDate(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return utc(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
  if (m) return utc(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    let a = +m[1], b = +m[2], y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (a > 12 && b <= 12) [a, b] = [b, a];
    return utc(y, a, b);
  }
  // "Jan 5, 2026", "5 January 2026": only with a month name, so a bare number
  // is never read as a date.
  if (/[a-z]{3}/i.test(s) && /\d{4}/.test(s)) {
    const t = Date.parse(s + (/(\d{1,2}:\d{2})|[zZ]$|GMT|UTC/.test(s) ? '' : ' UTC'));
    if (Number.isFinite(t)) return t;
  }
  return null;
}
function utc(y, mo, d, h = 0, mi = 0, se = 0) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, se);
  const check = new Date(t);
  return check.getUTCDate() === d ? t : null;
}
export function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return d.getUTCHours() || d.getUTCMinutes() ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}

const TRUE_WORDS = new Set(['✓', '✔', '☑', '✅', 'x', 'true', 'yes', 'y', '1', 'done', 'on']);
const FALSE_WORDS = new Set(['', '☐', '✗', '✘', 'false', 'no', 'n', '0', 'off', '-']);
export function parseCheckbox(text) {
  const s = String(text == null ? '' : text).trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return null;
}
export const CHECK_MARK = '✓';

export function isUrl(text) {
  return /^(https?:\/\/|mailto:|www\.)\S+$/i.test(String(text || '').trim());
}

// Tags written as text ("a, b; c") when there are no <span data-tag> items.
export function splitTags(text) {
  return String(text || '').split(/[,;|\n]/).map((t) => t.trim()).filter(Boolean);
}

// ---- inference ------------------------------------------------------------

// Pick a column type from sample values. Conservative: a column becomes a
// number, date or checkbox only when nearly every non-empty value parses; a
// text column becomes tags when it is short, comma-listed or repeats a small
// set of values. Header words nudge ambiguous cases.
export function inferType(values, header = '') {
  const sample = [];
  for (let i = 0; i < values.length && sample.length < 2000; i++) {
    const v = values[i] == null ? '' : String(values[i]).trim();
    if (v) sample.push(v);
  }
  if (!sample.length) return 'text';
  const share = (fn) => sample.filter(fn).length / sample.length;
  const h = String(header).toLowerCase();
  const checkboxes = share((v) => parseCheckbox(v) !== null && !/^[01]$/.test(v) || /^[01]$/.test(v) && /^(done|is|has|ok|active|enabled|checked)\b|\?$/.test(h));
  if (checkboxes >= 0.98 && new Set(sample.map((v) => v.toLowerCase())).size <= 4) return 'checkbox';
  if (share((v) => parseNumber(v) !== null) >= 0.95) {
    // Four-digit years in a "date"/"when" column are still numbers; a value
    // like 20260131 is a number too.
    return 'number';
  }
  if (share((v) => parseDate(v) !== null) >= 0.95) return 'date';
  if (share(isUrl) >= 0.9) return 'url';
  const distinct = new Set(sample);
  const listed = share((v) => /[,;]\s*\S/.test(v) && v.length <= 120 && splitTags(v).every((t) => t.length <= 24));
  const short = share((v) => v.length <= 24);
  if (/\b(tags?|labels?|categor(y|ies)|status|stage|priority|type|kind|team)\b/.test(h) && short >= 0.9 && distinct.size <= Math.max(12, sample.length / 3)) return 'tags';
  if (listed >= 0.5 && short + listed >= 0.9) return 'tags';
  if (sample.length >= 8 && short >= 0.95 && distinct.size <= Math.min(12, Math.ceil(sample.length / 4))) return 'tags';
  return 'text';
}

// ---- references -----------------------------------------------------------

export function columnLetter(index) {
  let n = index + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---- the index ------------------------------------------------------------

// Column vectors, computed once per (re)load: lowercased text for search,
// numbers for number/date/checkbox sorting and ranges, tag arrays for tags.
export function buildIndex(sheet) {
  const columns = sheet.columns || [];
  const rows = sheet.rows || [];
  const cols = columns.map((col, c) => {
    const type = normalizeType(col.type);
    const n = rows.length;
    const text = new Array(n), lower = new Array(n);
    const num = type === 'number' || type === 'date' || type === 'checkbox' ? new Float64Array(n) : null;
    const tags = type === 'tags' ? new Array(n) : null;
    for (let r = 0; r < n; r++) {
      const raw = rows[r].cells[c];
      if (tags) {
        const list = Array.isArray(raw) ? raw.map(String) : splitTags(raw);
        tags[r] = list;
        text[r] = list.join(', ');
      } else {
        text[r] = raw == null ? '' : String(raw);
      }
      lower[r] = text[r].toLowerCase();
      if (num) {
        const v = type === 'number' ? parseNumber(text[r]) : type === 'date' ? parseDate(text[r]) : (parseCheckbox(text[r]) ? 1 : 0);
        num[r] = v == null ? NaN : v;
      }
    }
    return { type, name: col.name, text, lower, num, tags };
  });
  return { cols, size: rows.length };
}

// ---- queries --------------------------------------------------------------

export function emptyQuery() {
  return { search: '', filters: {}, sort: [], totals: {} };
}

export function isEmptyQuery(q) {
  return !q || (!q.search && !Object.keys(q.filters || {}).length && !(q.sort || []).length && !Object.keys(q.totals || {}).length);
}

// ---- the summary row ------------------------------------------------------
// One figure per column, picked by the reader, over the rows the view shows
// (search and filters applied). totals = { [col]: 'sum' | 'avg' | 'count' |
// 'unique' }: Sum and Average for a number column, Count (non-blank; checked
// for a checkbox) and Unique for any column.
export const TOTALS = Object.freeze(['sum', 'avg', 'count', 'unique']);
export const TOTAL_LABEL = Object.freeze({ sum: 'Sum', avg: 'Average', count: 'Count', unique: 'Unique' });

export function totalsFor(type) {
  return normalizeType(type) === 'number' ? ['sum', 'avg', 'count'] : ['count', 'unique'];
}

// The figure for column c over the rows in `order`: a number, or null for an
// average of no numbers.
export function columnTotal(index, order, c, fn) {
  const col = index.cols[c];
  if (!col) return null;
  if (fn === 'sum' || fn === 'avg') {
    if (!col.num || col.type !== 'number') return null;
    let sum = 0, n = 0;
    for (const r of order) { const v = col.num[r]; if (!Number.isNaN(v)) { sum += v; n++; } }
    if (fn === 'sum') return n ? Math.round(sum * 1e9) / 1e9 : 0;
    return n ? sum / n : null;
  }
  if (fn === 'count') {
    let n = 0;
    if (col.type === 'checkbox') { for (const r of order) if (col.num[r] === 1) n++; }
    else for (const r of order) if (col.text[r].trim() !== '') n++;
    return n;
  }
  if (fn === 'unique') {
    const seen = new Set();
    for (const r of order) {
      if (col.tags) col.tags[r].forEach((t) => seen.add(t.toLowerCase()));
      else if (col.text[r].trim() !== '') seen.add(col.lower[r].trim());
    }
    return seen.size;
  }
  return null;
}

export function setTotal(query, col, fn) {
  const q = cloneQuery(query);
  if (fn && TOTALS.includes(fn)) q.totals[col] = fn; else delete q.totals[col];
  return q;
}

// One filter per column, keyed by column position:
//   { values: [..] }           text/url/tags: keep rows whose value (or any tag) is listed;
//                              '' stands for blank
//   { min, max }               number/date: inclusive, either end optional
//   { checked: true|false }    checkbox
function filterTest(col, f) {
  if (!f) return null;
  if (Array.isArray(f.values)) {
    const want = new Set(f.values.map(String));
    if (col.tags) {
      const blank = want.has('');
      return (r) => { const t = col.tags[r]; if (!t.length) return blank; for (let i = 0; i < t.length; i++) if (want.has(t[i])) return true; return false; };
    }
    return (r) => want.has(col.text[r].trim());
  }
  if (typeof f.checked === 'boolean') {
    const v = f.checked ? 1 : 0;
    return (r) => (col.num ? col.num[r] : parseCheckbox(col.text[r]) ? 1 : 0) === v;
  }
  const lo = f.min == null || f.min === '' ? -Infinity : Number(f.min);
  const hi = f.max == null || f.max === '' ? Infinity : Number(f.max);
  if (!col.num || (lo === -Infinity && hi === Infinity)) return null;
  return (r) => { const v = col.num[r]; return v === v && v >= lo && v <= hi; };
}

export function rowMatchesSearch(index, r, needle) {
  for (let c = 0; c < index.cols.length; c++) if (index.cols[c].lower[r].indexOf(needle) !== -1) return true;
  return false;
}

const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
function compareText(a, b) { return collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0; }

// Positions of the rows that pass, in display order. Empty values sort last
// in both directions, the way spreadsheets do. Ties keep document order.
export function runQuery(index, query) {
  const q = query || emptyQuery();
  const tests = [];
  Object.keys(q.filters || {}).forEach((key) => {
    const col = index.cols[Number(key)];
    const test = col && filterTest(col, q.filters[key]);
    if (test) tests.push(test);
  });
  const needle = String(q.search || '').trim().toLowerCase();
  const out = [];
  for (let r = 0; r < index.size; r++) {
    let keep = true;
    for (let i = 0; i < tests.length && keep; i++) keep = tests[i](r);
    if (keep && needle) keep = rowMatchesSearch(index, r, needle);
    if (keep) out.push(r);
  }
  const sort = (q.sort || []).filter((s) => index.cols[s.col]);
  if (sort.length) {
    const keys = sort.map((s) => {
      const col = index.cols[s.col];
      const dir = s.dir === 'desc' ? -1 : 1;
      if (col.num) return { dir, num: col.num };
      return { dir, text: col.text };
    });
    out.sort((a, b) => {
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        let d;
        if (key.num) {
          const x = key.num[a], y = key.num[b];
          const xe = x !== x, ye = y !== y;
          if (xe || ye) { if (xe && ye) continue; return xe ? 1 : -1; }
          d = x - y;
        } else {
          const x = key.text[a], y = key.text[b];
          if (!x || !y) { if (!x && !y) continue; return !x ? 1 : -1; }
          d = compareText(x, y);
        }
        if (d) return d * key.dir;
      }
      return a - b;
    });
  }
  return out;
}

// Every cell, in display order, that contains the search text: what "next"
// and "previous" walk. Capped so a one-letter search in a huge sheet stays
// cheap; the count says when it was capped.
export function searchMatches(index, order, search, limit = 5000) {
  const needle = String(search || '').trim().toLowerCase();
  const hits = [];
  if (!needle) return { hits, total: 0, capped: false };
  let total = 0;
  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    for (let c = 0; c < index.cols.length; c++) {
      if (index.cols[c].lower[r].indexOf(needle) !== -1) {
        total++;
        if (hits.length < limit) hits.push({ row: r, col: c, at: i });
      }
    }
  }
  return { hits, total, capped: total > hits.length };
}

// The values a value-filter offers, most common first: each tag on its own
// for a tags column, with '' for blank cells.
export function distinctValues(index, c, limit = 500) {
  const col = index.cols[c];
  if (!col) return [];
  const counts = new Map();
  for (let r = 0; r < index.size; r++) {
    if (col.tags) {
      const t = col.tags[r];
      if (!t.length) counts.set('', (counts.get('') || 0) + 1);
      for (let i = 0; i < t.length; i++) counts.set(t[i], (counts.get(t[i]) || 0) + 1);
    } else {
      const v = col.text[r].trim();
      counts.set(v, (counts.get(v) || 0) + 1);
    }
  }
  return Array.from(counts, ([value, count]) => ({ value, count }))
    .sort((a, b) => (b.count - a.count) || compareText(a.value, b.value))
    .slice(0, limit);
}

// The range a number/date filter starts from.
export function columnRange(index, c) {
  const col = index.cols[c];
  if (!col || !col.num) return null;
  let min = Infinity, max = -Infinity;
  for (let r = 0; r < index.size; r++) { const v = col.num[r]; if (v === v) { if (v < min) min = v; if (v > max) max = v; } }
  return min === Infinity ? null : { min, max };
}

// ---- toggles the UI uses ----------------------------------------------------

// A header click: sort by this column alone, flipping asc → desc → off.
// Shift-click adds or flips it as a further key.
export function toggleSort(query, col, additive) {
  const q = cloneQuery(query);
  const at = q.sort.findIndex((s) => s.col === col);
  const current = at === -1 ? null : q.sort[at].dir;
  const next = current === null ? 'asc' : current === 'asc' ? 'desc' : null;
  if (!additive) q.sort = next ? [{ col, dir: next }] : [];
  else if (at === -1) q.sort.push({ col, dir: 'asc' });
  else if (next) q.sort[at] = { col, dir: next };
  else q.sort.splice(at, 1);
  return q;
}

export function setFilter(query, col, filter) {
  const q = cloneQuery(query);
  if (!filter) delete q.filters[col];
  else q.filters[col] = filter;
  return q;
}

export function cloneQuery(query) {
  const q = query || emptyQuery();
  return {
    search: String(q.search || ''),
    filters: JSON.parse(JSON.stringify(q.filters || {})),
    sort: (q.sort || []).map((s) => ({ col: s.col, dir: s.dir })),
    totals: Object.assign({}, q.totals || {}),
  };
}

// Columns move when somebody inserts or deletes one. A saved view is keyed by
// position, so the viewer re-keys it rather than filtering the wrong column.
export function shiftQueryColumns(query, at, delta) {
  const q = cloneQuery(query);
  const move = (c) => (c >= at ? c + delta : c);
  const filters = {};
  Object.keys(q.filters).forEach((k) => {
    const c = Number(k);
    if (delta < 0 && c === at) return;
    filters[move(c)] = q.filters[k];
  });
  q.filters = filters;
  q.sort = q.sort.filter((s) => !(delta < 0 && s.col === at)).map((s) => ({ col: move(s.col), dir: s.dir }));
  const totals = {};
  Object.keys(q.totals).forEach((k) => {
    const c = Number(k);
    if (delta < 0 && c === at) return;
    totals[move(c)] = q.totals[k];
  });
  q.totals = totals;
  return q;
}

// ---- view state in a URL ----------------------------------------------------

// The whole view of a doc (each tab's query plus which tab is open) as one
// compact string for the page's #hash. Unknown or malformed input decodes to
// an empty view, never an exception.
export function encodeView(view) {
  const tabs = {};
  Object.keys((view && view.tabs) || {}).forEach((tab) => {
    const q = view.tabs[tab];
    if (isEmptyQuery(q)) return;
    const o = {};
    if (q.search) o.q = q.search;
    if (Object.keys(q.filters || {}).length) o.f = q.filters;
    if ((q.sort || []).length) o.s = q.sort.map((s) => (s.dir === 'desc' ? '-' : '') + s.col).join(',');
    if (Object.keys(q.totals || {}).length) o.g = q.totals;
    tabs[tab] = o;
  });
  const out = {};
  if (Object.keys(tabs).length) out.t = tabs;
  if (view && view.active) out.a = view.active;
  if (!Object.keys(out).length) return '';
  return encodeURIComponent(JSON.stringify(out)).replace(/%2C/g, ',').replace(/%3A/g, ':');
}

export function decodeView(text) {
  const view = { active: '', tabs: {} };
  if (!text) return view;
  let data;
  try { data = JSON.parse(decodeURIComponent(String(text))); } catch { return view; }
  if (!data || typeof data !== 'object') return view;
  if (typeof data.a === 'string') view.active = data.a.slice(0, 200);
  const tabs = data.t && typeof data.t === 'object' ? data.t : {};
  Object.keys(tabs).slice(0, 50).forEach((tab) => {
    const o = tabs[tab] || {};
    const q = emptyQuery();
    if (typeof o.q === 'string') q.search = o.q.slice(0, 500);
    if (o.f && typeof o.f === 'object') {
      Object.keys(o.f).forEach((k) => {
        const c = Number(k), f = o.f[k];
        if (!Number.isInteger(c) || c < 0 || !f || typeof f !== 'object') return;
        if (Array.isArray(f.values)) q.filters[c] = { values: f.values.slice(0, 1000).map(String) };
        else if (typeof f.checked === 'boolean') q.filters[c] = { checked: f.checked };
        else if (f.min != null || f.max != null) {
          const r = {};
          if (Number.isFinite(Number(f.min)) && f.min !== '' && f.min !== null) r.min = Number(f.min);
          if (Number.isFinite(Number(f.max)) && f.max !== '' && f.max !== null) r.max = Number(f.max);
          if (Object.keys(r).length) q.filters[c] = r;
        }
      });
    }
    if (typeof o.s === 'string') {
      o.s.split(',').slice(0, 10).forEach((part) => {
        const m = /^(-?)(\d+)$/.exec(part.trim());
        if (m) q.sort.push({ col: Number(m[2]), dir: m[1] ? 'desc' : 'asc' });
      });
    }
    if (o.g && typeof o.g === 'object') {
      Object.keys(o.g).slice(0, 200).forEach((k) => {
        const c = Number(k);
        if (Number.isInteger(c) && c >= 0 && TOTALS.includes(o.g[k])) q.totals[c] = o.g[k];
      });
    }
    view.tabs[tab] = q;
  });
  return view;
}
