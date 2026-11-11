// Sheets: cell formatting, the markup half. A cell's format is a handful of
// whitelisted attributes on its <td>, never CSS:
//
//   data-fmt="b i s"          bold, italic, strikethrough (any of the three)
//   data-color="red"          text colour, a name from COLORS
//   data-fill="yellow"        fill, a name from COLORS
//   data-align="center"       horizontal: left | center | right (a <th>'s
//                             data-align is the column's; a cell's wins)
//   data-valign="top"         vertical: top | middle | bottom
//   data-border="t r b l"     the cell's ruled edges (any of the four)
//   data-num="currency:USD:2" how a value shows (NUMBER_FORMATS below); the
//                             cell keeps the value as written
//   colspan / rowspan         a merged range, on its top-left cell; the
//                             cells it covers are not in the markup
//
// Every value is read through a validator: an unknown token, colour, format
// or an over-long attribute reads as no format, so author markup can only
// ever pick from this list. The viewer turns a format into its own classes
// (sheets-format-ui.js); nothing here is written into a style attribute.
// It inlines into the frame viewer like sheet-markup.mjs, so: no imports.

export const COLORS = Object.freeze(['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']);
export const STYLES = Object.freeze(['b', 'i', 's']);
export const ALIGNS = Object.freeze(['left', 'center', 'right']);
export const VALIGNS = Object.freeze(['top', 'middle', 'bottom']);
export const EDGES = Object.freeze(['t', 'r', 'b', 'l']);
export const FORMAT_ATTRS = Object.freeze(['data-fmt', 'data-color', 'data-fill', 'data-align', 'data-valign', 'data-border', 'data-num']);
// A merge spans at most this many rows or columns.
export const MAX_SPAN = 1000;

export const CURRENCIES = Object.freeze({
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: 'CN¥', INR: '₹', KRW: '₩', CAD: 'CA$', AUD: 'A$', CHF: 'CHF ', HKD: 'HK$', SGD: 'S$',
});
// Decimals a currency shows by default.
const CURRENCY_DEC = { JPY: 0, KRW: 0 };
export const DATE_STYLES = Object.freeze({
  date: ['iso', 'us', 'eu', 'medium', 'long'],
  time: ['24', '12'],
  datetime: ['iso', 'medium'],
});
// The formats the toolbar offers, in its order: [spec, label, example].
export const NUMBER_FORMATS = Object.freeze([
  ['', 'Automatic', ''],
  ['text', 'Plain text', ''],
  ['number:2', 'Number', '1,000.12'],
  ['percent:2', 'Percent', '10.12%'],
  ['currency:USD:2', 'Currency', '$1,000.12'],
  ['date:iso', 'Date', '2026-09-26'],
  ['date:us', 'Date (US)', '9/26/2026'],
  ['date:eu', 'Date (day first)', '26/09/2026'],
  ['date:medium', 'Date (short month)', 'Sep 26, 2026'],
  ['date:long', 'Date (long)', 'September 26, 2026'],
  ['time:24', 'Time', '15:59'],
  ['time:12', 'Time (AM/PM)', '3:59 PM'],
  ['datetime:iso', 'Date time', '2026-09-26 15:59'],
  ['datetime:medium', 'Date time (short month)', 'Sep 26, 2026 3:59 PM'],
]);

const MAX_ATTR = 64;
function attr(el, name) {
  const v = el.getAttribute(name);
  return v == null || v.length > MAX_ATTR ? '' : v.trim().toLowerCase();
}
function tokens(value, allowed) {
  const out = [];
  String(value || '').split(/\s+/).forEach((t) => { if (allowed.indexOf(t) !== -1 && out.indexOf(t) === -1) out.push(t); });
  return allowed.filter((t) => out.indexOf(t) !== -1);
}

// ---- number formats ----------------------------------------------------------

function decimals(text) {
  if (!/^\d{1,2}$/.test(text)) return null;
  const n = Number(text);
  return n <= 10 ? n : null;
}
// A data-num value → { kind, dec?, cur?, style? }, or null when it is not one
// of the formats above.
export function parseNum(spec) {
  const s = String(spec == null ? '' : spec).trim();
  if (!s || s.length > 32) return null;
  const p = s.split(':');
  const kind = p[0].toLowerCase();
  if (kind === 'text') return p.length === 1 ? { kind } : null;
  if (kind === 'number' || kind === 'percent') {
    if (p.length > 2) return null;
    const dec = p.length === 2 ? decimals(p[1]) : 2;
    return dec == null ? null : { kind, dec };
  }
  if (kind === 'currency') {
    if (p.length > 3) return null;
    const cur = (p[1] || 'USD').toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(CURRENCIES, cur)) return null;
    const dec = p.length === 3 ? decimals(p[2]) : (cur in CURRENCY_DEC ? CURRENCY_DEC[cur] : 2);
    return dec == null ? null : { kind, cur, dec };
  }
  if (Object.prototype.hasOwnProperty.call(DATE_STYLES, kind)) {
    if (p.length !== 2) return null;
    const style = p[1].toLowerCase();
    return DATE_STYLES[kind].indexOf(style) === -1 ? null : { kind, style };
  }
  return null;
}
export function numSpec(n) {
  if (!n) return '';
  if (n.kind === 'text') return 'text';
  if (n.kind === 'number' || n.kind === 'percent') return `${n.kind}:${n.dec}`;
  if (n.kind === 'currency') return `currency:${n.cur}:${n.dec}`;
  return `${n.kind}:${n.style}`;
}
export function isNumeric(n) { return !!n && (n.kind === 'number' || n.kind === 'percent' || n.kind === 'currency'); }
export function isDateLike(n) { return !!n && (n.kind === 'date' || n.kind === 'time' || n.kind === 'datetime'); }

// A value as written → a number: 1,200.50, $12, (5), 12% (0.12), or null.
export function toNumber(text) {
  let s = String(text == null ? '' : text).trim();
  if (!s || s.length > 64) return null;
  let neg = false, pct = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim(); }
  s = s.replace(/[\s,  '’_]/g, '').replace(/^(-?)(?:[A-Z]{0,3}[$€£¥₹₩]|CHF)/, '$1').replace(/[$€£¥₹₩]$/, '').replace(/^\+/, '');
  if (!/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (pct) n /= 100;
  return neg ? -n : n;
}
// A value as written → its date parts: ISO 2026-03-01 or 2026-03-01 14:30.
export function toDateParts(text) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(text == null ? '' : text).trim());
  if (!m) {
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text == null ? '' : text).trim());
    return t && +t[1] < 24 ? { y: 0, mo: 0, d: 0, h: +t[1], mi: +t[2], s: +(t[3] || 0), timeOnly: true } : null;
  }
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d, h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0), time: m[4] != null };
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
function clock(p, style) {
  if (style === '12') return `${p.h % 12 || 12}:${pad(p.mi)} ${p.h < 12 ? 'AM' : 'PM'}`;
  return `${pad(p.h)}:${pad(p.mi)}`;
}
function day(p, style) {
  if (style === 'us') return `${p.mo}/${p.d}/${p.y}`;
  if (style === 'eu') return `${pad(p.d)}/${pad(p.mo)}/${p.y}`;
  if (style === 'medium') return `${MONTHS[p.mo - 1].slice(0, 3)} ${p.d}, ${p.y}`;
  if (style === 'long') return `${MONTHS[p.mo - 1]} ${p.d}, ${p.y}`;
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}
function grouped(n, dec) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
// What a cell shows: its value in its format, or the value as written when
// the format does not apply to it (text in a number format, say).
export function displayValue(text, n) {
  const raw = text == null ? '' : String(text);
  if (!n || n.kind === 'text' || raw === '') return raw;
  if (isNumeric(n)) {
    const v = toNumber(raw);
    if (v == null) return raw;
    if (n.kind === 'percent') return `${grouped(v * 100, n.dec)}%`;
    if (n.kind === 'currency') return `${v < 0 ? '-' : ''}${CURRENCIES[n.cur]}${grouped(Math.abs(v), n.dec)}`;
    return grouped(v, n.dec);
  }
  const p = toDateParts(raw);
  if (!p) return raw;
  if (p.timeOnly) return n.kind === 'time' ? clock(p, n.style) : raw;
  if (n.kind === 'time') return clock(p, n.style);
  if (n.kind === 'datetime') return `${day(p, n.style === 'medium' ? 'medium' : 'iso')} ${clock(p, n.style === 'medium' ? '12' : '24')}`;
  return day(p, n.style);
}
// The decimals a value shows now: its format's, else as written.
export function shownDecimals(text, n) {
  if (isNumeric(n)) return n.dec;
  const m = /\.(\d+)/.exec(String(text || '').replace(/[^\d.]/g, ''));
  return m ? Math.min(10, m[1].length) : 0;
}
// One more or one fewer decimal, from what the cell shows now.
export function stepDecimals(text, n, delta) {
  const dec = Math.max(0, Math.min(10, shownDecimals(text, n) + delta));
  if (isNumeric(n)) return Object.assign({}, n, { dec });
  return { kind: 'number', dec };
}

// Excel's number format code for a format (export), and back (import).
export function excelFormat(n) {
  if (!n) return '';
  const dec = (d) => (d ? `.${'0'.repeat(d)}` : '');
  if (n.kind === 'text') return '@';
  if (n.kind === 'number') return `#,##0${dec(n.dec)}`;
  if (n.kind === 'percent') return `0${dec(n.dec)}%`;
  if (n.kind === 'currency') return `"${CURRENCIES[n.cur].trim()}"#,##0${dec(n.dec)}`;
  const DATE = { iso: 'yyyy-mm-dd', us: 'm/d/yyyy', eu: 'dd/mm/yyyy', medium: 'mmm d, yyyy', long: 'mmmm d, yyyy' };
  if (n.kind === 'date') return DATE[n.style];
  if (n.kind === 'time') return n.style === '12' ? 'h:mm AM/PM' : 'hh:mm';
  return n.style === 'medium' ? 'mmm d, yyyy h:mm AM/PM' : 'yyyy-mm-dd hh:mm';
}
export function fromExcelFormat(code) {
  const z = String(code || '');
  if (!z || z === 'General' || z.length > 120) return null;
  if (z === '@') return { kind: 'text' };
  // The first section (positive numbers), without colours, quotes kept.
  const first = z.split(';')[0].replace(/\[(?:Red|Black|Blue|Green|Color\d+)\]/gi, '');
  const plain = first.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/_.|\*./g, '');
  const decs = (/0\.(0+)/.exec(plain) || [, ''])[1].length;
  const dateish = /[dmyhs]/i.test(plain.replace(/\[[^\]]*\]/g, '')) && !/[0#]/.test(plain);
  if (dateish) {
    const p = plain.replace(/\[[^\]]*\]/g, '').toLowerCase();
    const hasDay = /d|y/.test(p), hasTime = /h|s/.test(p) || /:m/.test(p);
    const ampm = /am\/pm|a\/p/.test(p);
    if (hasDay && hasTime) return { kind: 'datetime', style: /mmm/.test(p) ? 'medium' : 'iso' };
    if (hasTime) return { kind: 'time', style: ampm ? '12' : '24' };
    if (/mmmm/.test(p)) return { kind: 'date', style: 'long' };
    if (/mmm/.test(p)) return { kind: 'date', style: 'medium' };
    if (/^y/.test(p)) return { kind: 'date', style: 'iso' };
    if (/^d/.test(p)) return { kind: 'date', style: 'eu' };
    if (/^m/.test(p)) return { kind: 'date', style: 'us' };
    return { kind: 'date', style: 'iso' };
  }
  if (!/[0#]/.test(plain)) return null;
  if (/%/.test(plain)) return { kind: 'percent', dec: Math.min(10, decs) };
  const sym = (/"([^"]+)"/.exec(first) || [])[1] || (/\[\$([^\]-]*)/.exec(first) || [])[1] || (/([$€£¥₹₩])/.exec(first) || [])[1] || '';
  if (sym) {
    const s = sym.trim();
    const cur = Object.keys(CURRENCIES).find((k) => CURRENCIES[k].trim() === s || k === s.toUpperCase())
      || (s === '¥' ? 'JPY' : s === '$' ? 'USD' : '');
    if (cur) return { kind: 'currency', cur, dec: Math.min(10, decs) };
  }
  if (/,/.test(plain) || decs) return { kind: 'number', dec: Math.min(10, decs) };
  return null;
}

// ---- a cell's format ---------------------------------------------------------

// The format a <td> carries: { b, i, s, color, fill, align, valign, border,
// num } (only what is set), or null when it carries none.
export function readFormat(td) {
  if (!td || !td.hasAttributes || !td.hasAttributes()) return null;
  let out = null;
  const set = (k, v) => { (out || (out = {}))[k] = v; };
  const st = tokens(attr(td, 'data-fmt'), STYLES);
  st.forEach((t) => set(t, true));
  const color = attr(td, 'data-color');
  if (color && COLORS.indexOf(color) !== -1) set('color', color);
  const fill = attr(td, 'data-fill');
  if (fill && COLORS.indexOf(fill) !== -1) set('fill', fill);
  const align = attr(td, 'data-align');
  if (ALIGNS.indexOf(align) !== -1) set('align', align);
  const valign = attr(td, 'data-valign');
  if (VALIGNS.indexOf(valign) !== -1) set('valign', valign);
  const border = tokens(attr(td, 'data-border'), EDGES);
  if (border.length) set('border', border.join(' '));
  const num = parseNum(td.getAttribute('data-num'));
  if (num) set('num', num);
  return out;
}
// The attributes a format writes: [[name, value]] for every one of
// FORMAT_ATTRS, value null where it is unset.
export function formatAttrs(f) {
  f = f || {};
  const st = STYLES.filter((t) => f[t]);
  const border = tokens(f.border, EDGES);
  return [
    ['data-fmt', st.length ? st.join(' ') : null],
    ['data-color', COLORS.indexOf(f.color) !== -1 ? f.color : null],
    ['data-fill', COLORS.indexOf(f.fill) !== -1 ? f.fill : null],
    ['data-align', ALIGNS.indexOf(f.align) !== -1 ? f.align : null],
    ['data-valign', VALIGNS.indexOf(f.valign) !== -1 ? f.valign : null],
    ['data-border', border.length ? border.join(' ') : null],
    ['data-num', f.num ? numSpec(typeof f.num === 'string' ? parseNum(f.num) : f.num) || null : null],
  ];
}
export function writeFormat(td, f) {
  formatAttrs(f).forEach(([name, value]) => { if (value == null) td.removeAttribute(name); else td.setAttribute(name, value); });
}
// The same, as a markup string for a writer (import): ` data-fmt="b" …`.
export function formatAttrString(f) {
  return formatAttrs(f).filter((a) => a[1] != null).map(([name, value]) => ` ${name}="${String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
}
// A format with `patch` laid over it (a null value unsets), or null if empty.
export function mergeFormat(f, patch) {
  const out = Object.assign({}, f || {});
  Object.keys(patch || {}).forEach((k) => { if (patch[k] == null || patch[k] === false || patch[k] === '') delete out[k]; else out[k] = patch[k]; });
  return Object.keys(out).length ? out : null;
}
export function sameFormat(a, b) {
  return JSON.stringify(formatAttrs(a)) === JSON.stringify(formatAttrs(b));
}

// Every formatted cell of a sheet read by readSheetTable: Map(r * 256 + c →
// format), or null when the sheet has none. 256 > the 200-column cap.
export const KEY = 256;
export function readFormats(data, table) {
  // One native query answers "any formats at all" for a plain sheet.
  if (table && table.querySelector && !table.querySelector('td[data-fmt],td[data-color],td[data-fill],td[data-align],td[data-valign],td[data-border],td[data-num]')) return null;
  let map = null;
  const rows = data.rows;
  for (let r = 0; r < rows.length; r++) {
    const tds = rows[r].tds;
    for (let c = 0; c < tds.length; c++) {
      const td = tds[c];
      if (!td || !td.hasAttributes()) continue;
      const f = readFormat(td);
      if (f) (map || (map = new Map())).set(r * KEY + c, f);
    }
  }
  return map;
}

// ---- merges ------------------------------------------------------------------

export function cleanSpan(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 1 ? Math.min(n, MAX_SPAN) : 1;
}
// Merges [{ r, c, rs, cs }] with any that overlaps one before it (in row,
// then column order) left out, at most `max` of them: linear in merges ×
// columns (a column's covered-until row), never per covered cell. For a
// writer (import, export) whatever the source said.
export const MAX_MERGES = 5000;
export function nonOverlapping(merges, max = MAX_MERGES) {
  const list = (merges || []).filter((m) => m && m.rs >= 1 && m.cs >= 1 && m.cs <= KEY && (m.rs > 1 || m.cs > 1))
    .slice().sort((a, b) => a.r - b.r || a.c - b.c);
  const until = new Map();
  const out = [];
  for (const m of list) {
    if (out.length >= max) break;
    let free = true;
    for (let c = m.c; c < m.c + m.cs; c++) if ((until.get(c) ?? -1) >= m.r) { free = false; break; }
    if (!free) continue;
    for (let c = m.c; c < m.c + m.cs; c++) until.set(c, m.r + m.rs - 1);
    out.push(m);
  }
  return out;
}

// Body rows of a sheet table, in order.
function bodyRows(table) {
  const out = [];
  Array.prototype.forEach.call(table.tBodies || [], (b) => Array.prototype.forEach.call(b.rows, (tr) => out.push(tr)));
  return out;
}
// Merged cells hold rowspan / colspan; the cells they cover are not in the
// markup. To change rows or columns positionally (insert, delete, paste),
// the table is first laid out flat (`expand`: an empty <td> in every covered
// slot, no spans), changed, then merged again (`restore`), each merge by the
// rows and header cells it spanned that are still there.
export function hasMerges(table) {
  return !!(table && table.querySelector && table.querySelector('td[colspan],td[rowspan]'));
}
export function expandMerges(table, columns) {
  const trs = bodyRows(table);
  const merges = [];
  const carry = new Array(columns).fill(0);
  const plan = [];
  trs.forEach((tr, r) => {
    let k = 0;
    for (let c = 0; c < columns; c++) {
      if (carry[c] > 0) { carry[c]--; plan.push({ tr, at: c }); continue; }
      const td = tr.cells[k++];
      if (!td) continue;
      let cs = Math.min(cleanSpan(td.getAttribute('colspan')), columns - c);
      let rs = Math.min(cleanSpan(td.getAttribute('rowspan')), trs.length - r);
      if (td.hasAttribute('colspan') || td.hasAttribute('rowspan')) { td.removeAttribute('colspan'); td.removeAttribute('rowspan'); }
      // A merge over a slot another merge covers is no merge (readSheetTable's rule).
      for (let j = 1; j < cs; j++) if (carry[c + j] > 0) { cs = 1; rs = 1; break; }
      if (cs > 1 || rs > 1) {
        merges.push({ r, c, rs, cs });
        for (let j = 0; j < cs; j++) carry[c + j] = rs - 1;
        for (let j = 1; j < cs; j++) plan.push({ tr, at: c + j });
        c += cs - 1;
      }
    }
  });
  // Covered slots, in row order and left to right, so each lands at its column.
  plan.forEach((p) => {
    const doc = p.tr.ownerDocument;
    while (p.tr.cells.length < p.at) p.tr.appendChild(doc.createElement('td'));
    p.tr.insertBefore(doc.createElement('td'), p.tr.cells[p.at] || null);
  });
  return merges.map((m) => ({ trs: trs.slice(m.r, m.r + m.rs), cols: m }));
}
// `merges` as expandMerges gave them (each with `ths`, the header cells it
// spanned, set by withMerges), on a flat table.
export function restoreMerges(table, merges, headerCells) {
  const trs = bodyRows(table);
  const ths = headerCells;
  const remove = [];
  const spans = [];
  merges.forEach((m) => {
    const ri = m.trs.map((tr) => trs.indexOf(tr)).filter((i) => i >= 0);
    const ci = m.ths.map((th) => ths.indexOf(th)).filter((i) => i >= 0);
    if (!ri.length || !ci.length) return;
    const r0 = Math.min.apply(null, ri), r1 = Math.max.apply(null, ri), c0 = Math.min.apply(null, ci), c1 = Math.max.apply(null, ci);
    if (r0 === r1 && c0 === c1) return;
    const anchor = trs[r0].cells[c0];
    if (!anchor) return;
    spans.push({ td: anchor, rs: r1 - r0 + 1, cs: c1 - c0 + 1 });
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (r === r0 && c === c0) continue;
      const td = trs[r].cells[c];
      if (td) remove.push(td);
    }
  });
  remove.forEach((td) => td.remove());
  spans.forEach((s) => {
    if (s.cs > 1) s.td.setAttribute('colspan', String(s.cs)); else s.td.removeAttribute('colspan');
    if (s.rs > 1) s.td.setAttribute('rowspan', String(s.rs)); else s.td.removeAttribute('rowspan');
  });
}
// Run fn on the table laid out flat, then merge again. `ths()` reads the
// header cells now (they may change in fn). `edit(merges)` may change the
// list (merge or unmerge a range) before it is restored.
export function withMerges(table, ths, fn, edit) {
  if (!hasMerges(table) && !edit) { fn(); return; }
  const before = ths();
  const merges = expandMerges(table, before.length).map((m) => ({ trs: m.trs, ths: before.slice(m.cols.c, m.cols.c + m.cols.cs) }));
  fn();
  const list = edit ? edit(merges, bodyRows(table), ths()) : merges;
  restoreMerges(table, list, ths());
}
