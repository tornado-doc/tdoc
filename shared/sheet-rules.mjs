// Sheets: find & replace, conditional formatting, dropdown validation and
// the fill handle's series, the pure half. No DOM and no imports: the
// in-frame viewer inlines this file (server/sheets-source.js) as
// `SheetRules`, and the tests import it as a module.
//
// What a sheet's editors save lives on the author's table as two attributes
// of JSON, read back through the parsers below (anything they do not know is
// dropped, never trusted):
//
//   <table data-tdoc-sheet
//     data-format-rules='[{"cols":["c3"],"when":"gt","value":"100","fill":"red"}]'
//     data-validation='[{"cols":["c2"],"kind":"list","values":["Open","Done"]}]'>
//
// A rule names its columns by key (data-key), so it follows a column that
// moves, and it covers the whole column. A fill is one of the sheet
// palette's names (sheet-query.mjs TAG_COLORS), drawn as its soft tint. No
// CSS is ever stored.
//
// The common, simple set for now: find & replace in plain text; greater
// than / less than / equal to / text contains / is empty, each with one
// fill; a dropdown of listed values (a value outside it is marked in Edit
// mode); fill copies, or continues a number or date series. Regular
// expressions, colour scales, date conditions, dropdowns from a range and
// reject / warn modes are later steps: the formats below are versioned by
// what they hold, and anything unknown is ignored until then.

// ---- palette ------------------------------------------------------------------

// The palette's names, as sheet-query.mjs TAG_COLORS (a test holds the two
// together).
export const COLOR_NAMES = Object.freeze(['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']);

// ---- find & replace -------------------------------------------------------------

// A finder for the Find and replace popover: { ok, test(text), replace(text,
// with) }. Plain text, matched case-insensitively unless matchCase;
// wholeCell asks for the cell's entire text.
export function makeFinder({ find, matchCase = false, wholeCell = false } = {}) {
  const needle = String(find == null ? '' : find);
  if (!needle) return { ok: false };
  const want = matchCase ? needle : needle.toLowerCase();
  const norm = (t) => (matchCase ? t : t.toLowerCase());
  return {
    ok: true,
    test(text) { const t = norm(String(text)); return wholeCell ? t === want : t.indexOf(want) !== -1; },
    replace(text, rep) {
      const str = String(text), r = String(rep == null ? '' : rep);
      if (wholeCell) return norm(str) === want ? r : str;
      // Lowercasing can change a string's length (İ → i̇): then match on
      // the text as written, so the positions stay true.
      const t = norm(str), exact = t.length === str.length;
      const hay = exact ? t : str, pin = exact ? want : needle;
      let out = '', at = 0, k;
      while ((k = hay.indexOf(pin, at)) !== -1) { out += str.slice(at, k) + r; at = k + pin.length; }
      return out + str.slice(at);
    },
  };
}

// ---- reading and writing the rules -----------------------------------------------

export const FORMAT_ATTR = 'data-format-rules';
export const VALIDATION_ATTR = 'data-validation';
export const MAX_RULES = 100;
const MAX_ATTR = 65536;
const MAX_TEXT = 500;
const KEY_RE = /^(?:[A-Za-z0-9_-]{1,64}|#\d{1,4})$/;

export const CONDITIONS = Object.freeze(['gt', 'lt', 'eq', 'textContains', 'empty']);
export const CONDITION_LABEL = Object.freeze({ gt: 'Greater than', lt: 'Less than', eq: 'Is equal to', textContains: 'Text contains', empty: 'Is empty' });
export function conditionArity(op) { return op === 'empty' ? 0 : 1; }

function plainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function text(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, MAX_TEXT);
}
function color(v) { return typeof v === 'string' && COLOR_NAMES.indexOf(v) !== -1 ? v : ''; }
function cols(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (let k = 0; k < v.length && out.length < 200; k++) if (typeof v[k] === 'string' && KEY_RE.test(v[k]) && out.indexOf(v[k]) === -1) out.push(v[k]);
  return out.length ? out : null;
}
function readJsonList(attr) {
  if (typeof attr !== 'string' || !attr || attr.length > MAX_ATTR) return [];
  let data;
  try { data = JSON.parse(attr); } catch { return []; }
  return Array.isArray(data) ? data.slice(0, MAX_RULES) : [];
}

function cleanFormatRule(o) {
  if (!plainObject(o)) return null;
  const c = cols(o.cols);
  const when = typeof o.when === 'string' && CONDITIONS.indexOf(o.when) !== -1 ? o.when : '';
  const fill = color(o.fill);
  if (!c || !when || !fill) return null;
  const rule = { cols: c, when, fill };
  if (conditionArity(when)) rule.value = text(o.value);
  return rule;
}
function cleanValidationRule(o) {
  if (!plainObject(o) || o.kind !== 'list') return null;
  const c = cols(o.cols);
  if (!c) return null;
  const values = [];
  (Array.isArray(o.values) ? o.values : []).forEach((v) => { const t = text(v).trim(); if (t && values.length < 500 && values.indexOf(t) === -1) values.push(t); });
  return values.length ? { cols: c, kind: 'list', values } : null;
}
export function parseFormatRules(attr) { return readJsonList(attr).map(cleanFormatRule).filter(Boolean); }
export function parseValidation(attr) { return readJsonList(attr).map(cleanValidationRule).filter(Boolean); }

// JSON for the attribute. Inside strings a ':' is written \u003a (and < > &
// likewise), so a value such as "javascript:" never reads as a URL scheme
// or markup to anything scanning the page (the sheet size scan, a
// sanitiser); JSON.parse reads it back as written.
function serialize(list) {
  if (!list.length) return '';
  return JSON.stringify(list).replace(/"(?:[^"\\]|\\.)*"/g, (s) => s.replace(/:/g, '\\u003a').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'));
}
export function formatFormatRules(list) { return serialize((list || []).map(cleanFormatRule).filter(Boolean).slice(0, MAX_RULES)); }
export function formatValidation(list) { return serialize((list || []).map(cleanValidationRule).filter(Boolean).slice(0, MAX_RULES)); }

// Column keys ↔ letters for the panel's "Apply to" field: "C", "B:D", "A, C".
export function colsToRange(keys, allKeys, letter) {
  const at = keys.map((k) => allKeys.indexOf(k)).filter((x) => x >= 0).sort((a, b) => a - b);
  const parts = [];
  for (let k = 0; k < at.length; k++) {
    let j = k;
    while (j + 1 < at.length && at[j + 1] === at[j] + 1) j++;
    parts.push(j > k ? letter(at[k]) + ':' + letter(at[j]) : letter(at[k]));
    k = j;
  }
  return parts.join(', ');
}
export function rangeToCols(range, allKeys) {
  const toIndex = (s) => { let n = 0; for (let k = 0; k < s.length; k++) n = n * 26 + (s.charCodeAt(k) - 64); return n - 1; };
  const out = [];
  const parts = String(range || '').toUpperCase().split(/[,;]/).map((p) => p.replace(/\d+/g, '').trim()).filter(Boolean);
  for (const p of parts) {
    const m = /^([A-Z]{1,3})(?::([A-Z]{1,3}))?$/.exec(p);
    if (!m) return null;
    let a = toIndex(m[1]), b = m[2] ? toIndex(m[2]) : a;
    if (a > b) { const t = a; a = b; b = t; }
    for (let c = a; c <= b; c++) { if (c >= allKeys.length) return null; if (out.indexOf(allKeys[c]) === -1) out.push(allKeys[c]); }
  }
  return out.length ? out : null;
}

// ---- conditional formatting -------------------------------------------------------

// The formats of a sheet: for each column, a style per row (or null).
//   sheet = { keys: [key per column], types: [type per column], cols: index.cols, size }
//   ctx   = { parseNumber, parseDate, colors: TAG_COLORS }
// A style is { fill, css }; css is what the viewer draws. The first rule
// (in order) that matches a cell decides it. Greater / less / equal compare
// numbers (dates in a date column); text is matched case-insensitively.
export function evaluateFormats(rules, sheet, ctx) {
  const out = new Array(sheet.keys.length).fill(null);
  if (!rules || !rules.length) return out;
  const colors = ctx.colors || {};
  rules.forEach((rule) => {
    const tint = colors[rule.fill];
    if (!tint) return;
    const style = { fill: rule.fill, css: 'background:' + tint[0] };
    rule.cols.forEach((key) => {
      const c = sheet.keys.indexOf(key);
      if (c < 0) return;
      const test = conditionTest(rule, sheet.cols[c], sheet.types[c], ctx);
      if (!test) return;
      const slot = out[c] || (out[c] = new Array(sheet.size).fill(null));
      for (let r = 0; r < sheet.size; r++) if (!slot[r] && test(r)) slot[r] = style;
    });
  });
  return out;
}
function conditionTest(rule, col, type, ctx) {
  const textAt = (r) => String(col.text[r] == null ? '' : col.text[r]).trim();
  if (rule.when === 'empty') return (r) => textAt(r) === '';
  if (rule.when === 'textContains') {
    const want = String(rule.value || '').trim().toLowerCase();
    return want ? (r) => textAt(r).toLowerCase().indexOf(want) !== -1 : null;
  }
  const date = type === 'date';
  const a = date ? ctx.parseDate(rule.value) : ctx.parseNumber(rule.value);
  if (a == null) return null;
  const numAt = (r) => {
    if (col.num && (type === 'number' || date)) { const v = col.num[r]; return v === v ? v : null; }
    return ctx.parseNumber(col.text[r]);
  };
  const cmp = rule.when === 'gt' ? (v) => v > a : rule.when === 'lt' ? (v) => v < a : (v) => v === a;
  return (r) => { const v = numAt(r); return v != null && cmp(v); };
}

// One line for the rules list: "Greater than 100", "Dropdown: a, b".
export function describeFormat(rule) {
  const label = CONDITION_LABEL[rule.when] || rule.when;
  return conditionArity(rule.when) ? label + ' ' + (rule.value || '…') : label;
}
export function describeValidation(rule) {
  const v = rule.values;
  return 'Dropdown: ' + v.slice(0, 3).join(', ') + (v.length > 3 ? ' +' + (v.length - 3) : '');
}

// ---- dropdown validation ---------------------------------------------------------

// The rule for each column position (the first that names it), or null.
export function validationByColumn(rules, keys) {
  const out = new Array(keys.length).fill(null);
  (rules || []).forEach((rule) => rule.cols.forEach((key) => { const c = keys.indexOf(key); if (c >= 0 && !out[c]) out[c] = rule; }));
  return out;
}
// null when `value` is one of the rule's values (any case) or blank; else
// what to say. A tags cell passes when each of its tags does.
export function checkValue(rule, value) {
  if (!rule) return null;
  const list = Array.isArray(value) ? value : [value];
  for (const item of list) {
    const v = String(item == null ? '' : item).trim().toLowerCase();
    if (v && !rule.values.some((x) => x.toLowerCase() === v)) return 'Not in the list: ' + rule.values.slice(0, 6).join(', ') + (rule.values.length > 6 ? '…' : '');
  }
  return null;
}

// ---- the fill handle's series -----------------------------------------------------

const DAY = 86400000;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
function decimals(s) { const m = /\.(\d+)/.exec(s); return m ? Math.min(10, m[1].length) : 0; }

// The values a drag from `src` (the source cells in sheet order) fills into
// `count` cells: after them, or with backward before them (nearest first).
// Plain numbers and dates continue their step (one number or date: +1);
// anything else, or copy, repeats the source.
//   ctx = { parseDate, formatDate }
export function fillSeries(src, count, { copy = false, backward = false } = {}, ctx = {}) {
  const n = src.length, out = [];
  if (!n || count <= 0) return out;
  const vals = src.map((s) => String(s == null ? '' : s).trim());
  const pos = (k) => (backward ? -1 - k : n + k);
  const repeat = () => { for (let k = 0; k < count; k++) { const p = pos(k); out.push(src[((p % n) + n) % n]); } return out; };
  if (copy) return repeat();
  // Numbers.
  if (vals.every((v) => PLAIN_NUMBER.test(v))) {
    const nums = vals.map(Number), dec = Math.max.apply(null, vals.map(decimals));
    const step = n > 1 ? (nums[n - 1] - nums[0]) / (n - 1) : 1;
    if (n > 2 && nums.some((x, k) => k && Math.abs(x - nums[k - 1] - step) > 1e-9 * Math.max(1, Math.abs(step)))) return repeat();
    for (let k = 0; k < count; k++) {
      let x = Number((nums[n - 1] + (pos(k) - (n - 1)) * step).toFixed(dec));
      if (Object.is(x, -0)) x = 0;
      out.push(x.toFixed(dec));
    }
    return out;
  }
  // Dates written as dates (ISO, d/m/y or a month name).
  if (ctx.parseDate && vals.every((v) => /\d/.test(v) && /[-/.]|[a-z]{3}/i.test(v) && ctx.parseDate(v) != null)) {
    const ts = vals.map((v) => ctx.parseDate(v));
    const fmt = ctx.formatDate || ((t) => new Date(t).toISOString().slice(0, 10));
    const ds = ts.map((t) => new Date(t));
    // The same day of the month, an even step in months: by months.
    if (n > 1 && ds.every((d) => d.getUTCDate() === ds[0].getUTCDate())) {
      const mi = ds.map((d) => d.getUTCFullYear() * 12 + d.getUTCMonth()), step = mi[1] - mi[0];
      if (step && mi.every((m, k) => !k || m - mi[k - 1] === step)) {
        for (let k = 0; k < count; k++) {
          const m = mi[n - 1] + (pos(k) - (n - 1)) * step, y = Math.floor(m / 12), mo = ((m % 12) + 12) % 12;
          out.push(fmt(Date.UTC(y, mo, Math.min(ds[0].getUTCDate(), new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()))));
        }
        return out;
      }
    }
    const days = ts.map((t) => Math.round(t / DAY));
    const step = n > 1 ? (days[n - 1] - days[0]) / (n - 1) : 1;
    if (!step || days.some((d, k) => k && d - days[k - 1] !== step)) return repeat();
    for (let k = 0; k < count; k++) out.push(fmt((days[n - 1] + (pos(k) - (n - 1)) * step) * DAY));
    return out;
  }
  return repeat();
}
