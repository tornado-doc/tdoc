// Sheets: formulas. A cell whose <td> carries data-formula="=SUM(B1:B9)" is a
// formula cell; its text is the last value computed, so a reader without
// JavaScript, an export or an agent reading the HTML sees the value. The
// viewer (server/sheets-viewer.js) recomputes on load and after each edit.
//
// This file is the whole engine: tokenizer, parser, a pure interpreter, the
// workbook with its dependency graph and incremental recompute, and the
// reference rewriting used when rows or columns move, a formula is filled
// or pasted, a tab is renamed, or a workbook goes to or from Excel. It is
// inlined into the frame viewer like sheet-query.mjs, so: no imports here.
//
// Coordinates. A1 is the first BODY row (the header row is not a row): the
// row numbers the grid shows. Rows and columns are 0-based inside.
//
// Safety. No eval, no Function, no regular expression built from user text.
// A formula is at most LIMITS.formulaChars long and LIMITS.depth deep; a
// recalculation reads at most LIMITS.work cells and runs for at most
// LIMITS.timeMs (what is left shows #BUSY!); a text result is at most
// LIMITS.textChars long. A cycle is #CYCLE!, never a hang. Values are data:
// the viewer renders them as text.

export const LIMITS = Object.freeze({
  formulaChars: 8192,
  tokens: 4096,
  depth: 64,
  args: 255,
  formulas: 200000,
  work: 200000000,
  timeMs: 1000,
  textChars: 32767,
  rows: 1048576,
  cols: 16384,
  // Range references in the whole workbook's dependency graph (a formula
  // over the limit is #BUSY!), and how many columns a range may span before
  // it is kept as one interval instead of one entry per column.
  rangeRefs: 1000000,
  narrowCols: 8,
});

// ---- errors ------------------------------------------------------------------

export class FormulaError {
  constructor(code) { this.code = code; }
  toString() { return this.code; }
}
export const ERROR_CODES = Object.freeze(['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#ERROR!', '#CYCLE!', '#BUSY!']);
const E = {};
ERROR_CODES.forEach((c) => { E[c] = Object.freeze(new FormulaError(c)); });
export const ERRORS = Object.freeze(E);
const isErr = (v) => v instanceof FormulaError;
export function isError(v) { return isErr(v); }

class ParseError extends Error {}
class Budget extends Error {}

// ---- references ----------------------------------------------------------------

export function colLetters(c) {
  let n = c + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function lettersCol(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) & 0x1f);
  return n - 1;
}

// A sheet name as a formula writes it: bare when it is a plain word, else quoted.
export function quoteSheet(name) {
  const s = String(name);
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(s) && !/^[A-Za-z]{1,3}\d+$/.test(s) && !/^(TRUE|FALSE)$/i.test(s)) return s;
  return "'" + s.replace(/'/g, "''") + "'";
}

// ---- tokenizer -----------------------------------------------------------------
// Tokens keep their place in the source (s, e) so a reference can be
// rewritten without touching the rest of what the author wrote.

const CELL_RE = /(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})/y;
const COLS_RE = /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/y;
const ROWS_RE = /(\$?)([0-9]{1,7}):(\$?)([0-9]{1,7})/y;
const NUM_RE = /(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const WORD_RE = /[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*/y;
const SHEET_RE = /([A-Za-z_À-￿][A-Za-z0-9_.À-￿]*)!/y;

function at(re, src, i) { re.lastIndex = i; return re.exec(src); }
function boundary(src, j) {
  const ch = src[j];
  return ch === undefined || !/[A-Za-z0-9_.(!$À-￿]/.test(ch);
}

// A reference body at i: A1, $A$1, A1:B9, A:C, 2:5.
function refBody(src, i) {
  let m = at(CELL_RE, src, i);
  if (m) {
    const a = { c: lettersCol(m[2].toUpperCase()), r: Number(m[4]) - 1, ac: !!m[1], ar: !!m[3] };
    let j = i + m[0].length;
    if (src[j] === ':') {
      const m2 = at(CELL_RE, src, j + 1);
      if (m2 && boundary(src, j + 1 + m2[0].length)) {
        const b = { c: lettersCol(m2[2].toUpperCase()), r: Number(m2[4]) - 1, ac: !!m2[1], ar: !!m2[3] };
        return { ref: { kind: 'area', a, b }, end: j + 1 + m2[0].length };
      }
    }
    if (boundary(src, j)) return { ref: { kind: 'cell', a, b: null }, end: j };
  }
  m = at(COLS_RE, src, i);
  if (m && boundary(src, i + m[0].length)) {
    return { ref: { kind: 'cols', a: { c: lettersCol(m[2].toUpperCase()), ac: !!m[1] }, b: { c: lettersCol(m[4].toUpperCase()), ac: !!m[3] } }, end: i + m[0].length };
  }
  m = at(ROWS_RE, src, i);
  if (m && boundary(src, i + m[0].length)) {
    return { ref: { kind: 'rows', a: { r: Number(m[2]) - 1, ar: !!m[1] }, b: { r: Number(m[4]) - 1, ar: !!m[3] } }, end: i + m[0].length };
  }
  return null;
}

const OPS2 = ['<=', '>=', '<>'];
const OPS1 = '+-*/^&=<>%(),;{}';

export function tokenize(src) {
  const s = String(src);
  if (s.length > LIMITS.formulaChars) throw new ParseError('too long');
  const out = [];
  let i = 0;
  const n = s.length;
  const push = (t) => { if (out.length >= LIMITS.tokens) throw new ParseError('too many tokens'); out.push(t); };
  while (i < n) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ') { i++; continue; }
    if (ch === '"') {
      let j = i + 1, v = '';
      for (;;) {
        if (j >= n) throw new ParseError('unterminated string');
        if (s[j] === '"') { if (s[j + 1] === '"') { v += '"'; j += 2; continue; } break; }
        v += s[j++];
      }
      push({ k: 'str', v, s: i, e: j + 1 });
      i = j + 1;
      continue;
    }
    if (ch === '#') {
      const up = s.slice(i, i + 8).toUpperCase();
      const code = ERROR_CODES.find((c) => up.startsWith(c));
      if (!code) throw new ParseError('bad error literal');
      push({ k: 'err', v: E[code], s: i, e: i + code.length });
      i += code.length;
      continue;
    }
    if (ch === "'") {
      let j = i + 1, name = '';
      for (;;) {
        if (j >= n) throw new ParseError('unterminated sheet name');
        if (s[j] === "'") { if (s[j + 1] === "'") { name += "'"; j += 2; continue; } break; }
        name += s[j++];
      }
      if (s[j + 1] !== '!') throw new ParseError('sheet name without !');
      const body = refBody(s, j + 2);
      if (!body) throw new ParseError('bad reference');
      body.ref.sheet = name;
      push({ k: 'ref', ref: body.ref, s: i, e: body.end });
      i = body.end;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      if (ch !== '.') {
        const rb = refBody(s, i);
        if (rb && rb.ref.kind === 'rows') { push({ k: 'ref', ref: rb.ref, s: i, e: rb.end }); i = rb.end; continue; }
      }
      const m = at(NUM_RE, s, i);
      if (!m) throw new ParseError('bad number');
      push({ k: 'num', v: Number(m[0]), s: i, e: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (ch === '$' || /[A-Za-z_À-￿]/.test(ch)) {
      const sm = ch !== '$' && at(SHEET_RE, s, i);
      if (sm) {
        const body = refBody(s, i + sm[0].length);
        if (!body) throw new ParseError('bad reference');
        body.ref.sheet = sm[1];
        push({ k: 'ref', ref: body.ref, s: i, e: body.end });
        i = body.end;
        continue;
      }
      const rb = refBody(s, i);
      if (rb) { push({ k: 'ref', ref: rb.ref, s: i, e: rb.end }); i = rb.end; continue; }
      const w = at(WORD_RE, s, i);
      if (!w) throw new ParseError('unexpected character');
      let j = i + w[0].length;
      let k = j;
      while (s[k] === ' ') k++;
      const word = w[0];
      if (s[k] === '(') push({ k: 'func', v: word.toUpperCase().replace(/^_XLFN\.(_XLWS\.)?/, ''), s: i, e: j });
      else if (/^(TRUE|FALSE)$/i.test(word)) push({ k: 'bool', v: word.toUpperCase() === 'TRUE', s: i, e: j });
      else push({ k: 'name', v: word, s: i, e: j });
      i = j;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (OPS2.includes(two)) { push({ k: 'op', v: two, s: i, e: i + 2 }); i += 2; continue; }
    if (OPS1.indexOf(ch) !== -1) {
      if (ch === '{' || ch === '}') throw new ParseError('array constants are not supported');
      push({ k: ch === '(' || ch === ')' ? ch : ch === ',' || ch === ';' ? ',' : 'op', v: ch === ';' ? ',' : ch, s: i, e: i + 1 });
      i++;
      continue;
    }
    throw new ParseError('unexpected character');
  }
  return out;
}

// ---- parser ------------------------------------------------------------------------
// Excel's precedence, lowest first: comparison, &, + -, * /, ^, unary - +, %.
// ^ is left-associative and a leading minus binds tighter: -2^2 is 4.

export function parse(formula) {
  let src = String(formula == null ? '' : formula);
  if (src.length > LIMITS.formulaChars + 1) throw new ParseError('too long');
  if (src[0] === '=') src = src.slice(1);
  const toks = tokenize(src);
  let p = 0, depth = 0;
  const peek = () => toks[p];
  const isOp = (v) => toks[p] && toks[p].k === 'op' && toks[p].v === v;
  function expr() { return comparison(); }
  function comparison() {
    let a = concat();
    while (toks[p] && toks[p].k === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(toks[p].v)) {
      const op = toks[p++].v;
      a = { t: 'bin', op, a, b: concat() };
    }
    return a;
  }
  function concat() {
    let a = additive();
    while (isOp('&')) { p++; a = { t: 'bin', op: '&', a, b: additive() }; }
    return a;
  }
  function additive() {
    let a = mult();
    while (isOp('+') || isOp('-')) { const op = toks[p++].v; a = { t: 'bin', op, a, b: mult() }; }
    return a;
  }
  function mult() {
    let a = power();
    while (isOp('*') || isOp('/')) { const op = toks[p++].v; a = { t: 'bin', op, a, b: power() }; }
    return a;
  }
  function power() {
    let a = unary();
    while (isOp('^')) { p++; a = { t: 'bin', op: '^', a, b: unary() }; }
    return a;
  }
  function unary() {
    if (++depth > LIMITS.depth) throw new ParseError('too deep');
    let out;
    if (isOp('-') || isOp('+')) { const op = toks[p++].v; const a = unary(); out = op === '-' ? { t: 'neg', a } : a; }
    else {
      out = primary();
      while (isOp('%')) { p++; out = { t: 'pct', a: out }; }
    }
    depth--;
    return out;
  }
  function primary() {
    const t = toks[p];
    if (!t) throw new ParseError('unexpected end');
    if (t.k === 'num') { p++; return { t: 'n', v: t.v }; }
    if (t.k === 'str') { p++; return { t: 's', v: t.v }; }
    if (t.k === 'bool') { p++; return { t: 'b', v: t.v }; }
    if (t.k === 'err') { p++; return { t: 'e', v: t.v }; }
    if (t.k === 'ref') { p++; return { t: 'ref', ref: t.ref }; }
    if (t.k === 'name') { p++; return { t: 'name', v: t.v }; }
    if (t.k === '(') {
      p++;
      const e = expr();
      if (!toks[p] || toks[p].k !== ')') throw new ParseError('missing )');
      p++;
      return e;
    }
    if (t.k === 'func') {
      p += 2;
      const args = [];
      if (toks[p] && toks[p].k === ')') { p++; return { t: 'f', name: t.v, args }; }
      for (;;) {
        if (args.length >= LIMITS.args) throw new ParseError('too many arguments');
        if (toks[p] && (toks[p].k === ',' || toks[p].k === ')')) args.push({ t: 'missing' });
        else args.push(expr());
        if (!toks[p]) throw new ParseError('missing )');
        if (toks[p].k === ',') { p++; continue; }
        if (toks[p].k === ')') { p++; break; }
        throw new ParseError('expected , or )');
      }
      return { t: 'f', name: t.v, args };
    }
    throw new ParseError('unexpected token');
  }
  if (!toks.length) throw new ParseError('empty');
  const ast = expr();
  if (p !== toks.length) throw new ParseError('unexpected token');
  return ast;
}

export function isFormula(text) {
  return typeof text === 'string' && text.length > 1 && text[0] === '=';
}

// Every function a formula names (upper case), or null when it does not parse.
export function functionNames(formula) {
  let toks;
  try { toks = tokenize(String(formula).replace(/^=/, '')); } catch { return null; }
  return toks.filter((t) => t.k === 'func').map((t) => t.v);
}
// The tab names a formula refers to (as written), or null when it does not
// parse.
export function referencedSheets(formula) {
  let toks;
  try { toks = tokenize(String(formula).replace(/^=/, '')); } catch { return null; }
  return toks.filter((t) => t.k === 'ref' && t.ref.sheet != null).map((t) => t.ref.sheet);
}
// A sheet name no workbook tab can have: Excel's external and path
// references ([1]Sheet, 'C:\dir\[book.xlsx]Sheet') use these.
export function isExternalSheetName(name) {
  return /[[\]\\/:?*]/.test(String(name));
}

// The functions a formula names that this engine does not have.
export function unsupportedFunctions(formula) {
  const names = functionNames(formula);
  if (!names) return null;
  return names.filter((n) => !FUNCS[n]);
}

// ---- rewriting references ------------------------------------------------------------
// transform(formula, fn): fn gets each reference ({ sheet, kind, a, b })
// and returns a new one, null for #REF!, or undefined to keep it as written.

function refText(ref) {
  const pre = ref.sheet != null ? quoteSheet(ref.sheet) + '!' : '';
  const cell = (x) => (x.ac ? '$' : '') + colLetters(x.c) + (x.ar ? '$' : '') + (x.r + 1);
  if (ref.kind === 'cell') return pre + cell(ref.a);
  if (ref.kind === 'area') return pre + cell(ref.a) + ':' + cell(ref.b);
  if (ref.kind === 'cols') return pre + (ref.a.ac ? '$' : '') + colLetters(ref.a.c) + ':' + (ref.b.ac ? '$' : '') + colLetters(ref.b.c);
  return pre + (ref.a.ar ? '$' : '') + (ref.a.r + 1) + ':' + (ref.b.ar ? '$' : '') + (ref.b.r + 1);
}
export function formatRef(ref) { return refText(ref); }

function cloneRef(ref) {
  return { sheet: ref.sheet, kind: ref.kind, a: Object.assign({}, ref.a), b: ref.b ? Object.assign({}, ref.b) : null };
}

export function transform(formula, fn) {
  const text = String(formula);
  const lead = text[0] === '=' ? '=' : '';
  const src = lead ? text.slice(1) : text;
  let toks;
  try { toks = tokenize(src); } catch { return text; }
  let out = '', last = 0, changed = false;
  for (const t of toks) {
    if (t.k !== 'ref') continue;
    const next = fn(cloneRef(t.ref));
    if (next === undefined) continue;
    const valid = next && validRef(next);
    const piece = valid ? refText(next) : (t.ref.sheet != null ? quoteSheet(t.ref.sheet) + '!' : '') + '#REF!';
    out += src.slice(last, t.s) + piece;
    last = t.e;
    changed = true;
  }
  if (!changed) return text;
  return lead + out + src.slice(last);
}
function validRef(ref) {
  const okR = (r) => Number.isInteger(r) && r >= 0 && r < LIMITS.rows;
  const okC = (c) => Number.isInteger(c) && c >= 0 && c < LIMITS.cols;
  if (ref.kind === 'cols') return okC(ref.a.c) && okC(ref.b.c);
  if (ref.kind === 'rows') return okR(ref.a.r) && okR(ref.b.r);
  if (!okR(ref.a.r) || !okC(ref.a.c)) return false;
  return !ref.b || (okR(ref.b.r) && okC(ref.b.c));
}

const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function refSheet(ref, host) { return ref.sheet != null ? ref.sheet : host; }

// A formula moved by (dr, dc), as fill and paste move it: relative parts move,
// $-anchored parts stay. A part pushed off the sheet is #REF!.
export function offsetFormula(formula, dr, dc) {
  if (!dr && !dc) return String(formula);
  return transform(formula, (ref) => {
    for (const x of [ref.a, ref.b]) {
      if (!x) continue;
      if (x.r != null && !x.ar) x.r += dr;
      if (x.c != null && !x.ac) x.c += dc;
    }
    return ref;
  });
}

// Rows (axis 'row') or columns ('col') inserted (count > 0) or deleted
// (count < 0) at `at` on sheet `target`; `host` is the sheet the formula is
// on. Every reference to `target` follows its cells: absolute or not, as
// in a spreadsheet. A reference to a deleted cell is #REF!; a range loses
// the deleted part, and is #REF! only when all of it went.
export function shiftFormula(formula, { target, host, axis, at: pos, count }) {
  const key = axis === 'row' ? 'r' : 'c';
  return transform(formula, (ref) => {
    if (!sameName(refSheet(ref, host), target)) return undefined;
    if (axis === 'row' && ref.kind === 'cols') return undefined;
    if (axis === 'col' && ref.kind === 'rows') return undefined;
    let touched = false;
    if (count > 0) {
      for (const x of [ref.a, ref.b]) if (x && x[key] >= pos) { x[key] += count; touched = true; }
      return touched ? ref : undefined;
    }
    const del = -count, end = pos + del;
    const move = (v) => (v >= end ? v - del : v);
    if (!ref.b) {
      const v = ref.a[key];
      if (v >= pos && v < end) return null;
      if (v >= end) { ref.a[key] = v - del; return ref; }
      return undefined;
    }
    let lo = ref.a[key], hi = ref.b[key];
    const flip = lo > hi;
    if (flip) { const t = lo; lo = hi; hi = t; }
    if (lo >= pos && hi < end) return null;
    if (hi < pos) return undefined;
    const nlo = lo >= pos && lo < end ? pos : move(lo);
    const nhi = hi >= pos && hi < end ? pos - 1 : move(hi);
    if (nlo === lo && nhi === hi) return undefined;
    if (flip) { ref.a[key] = nhi; ref.b[key] = nlo; } else { ref.a[key] = nlo; ref.b[key] = nhi; }
    return ref;
  });
}

// A tab renamed: references naming it by its old name name the new one.
export function renameSheetIn(formula, from, to) {
  return transform(formula, (ref) => {
    if (ref.sheet == null || !sameName(ref.sheet, from)) return undefined;
    ref.sheet = to;
    return ref;
  });
}

// Excel's A1 counts the header as row 1; a sheet's A1 is the first row under
// it. toExcel / fromExcel move every row by the header (plus where each
// worksheet starts); names maps sheet names (tdoc tab → workbook name, or
// back). A reference into the header row is #REF! coming in; a range that
// starts on the header starts under it.
export function toExcel(formula, { names, rowOffset = 1 } = {}) {
  const off = typeof rowOffset === 'function' ? rowOffset : () => rowOffset;
  const out = transform(formula, (ref) => {
    const sheet = ref.sheet;
    if (sheet != null && names && names.has(String(sheet).toLowerCase())) ref.sheet = names.get(String(sheet).toLowerCase());
    if (ref.kind !== 'cols') {
      const d = off(sheet);
      ref.a.r += d;
      if (ref.b) ref.b.r += d;
    }
    return ref;
  });
  return out.replace(/^=/, '');
}
export function fromExcel(formula, { names, rowOffset = 1, colOffset = 0 } = {}) {
  const off = typeof rowOffset === 'function' ? rowOffset : () => rowOffset;
  const coff = typeof colOffset === 'function' ? colOffset : () => colOffset;
  const out = transform('=' + String(formula).replace(/^=/, ''), (ref) => {
    const sheet = ref.sheet;
    if (sheet != null && names && names.has(String(sheet).toLowerCase())) ref.sheet = names.get(String(sheet).toLowerCase());
    const d = off(sheet), dc = coff(sheet);
    if (ref.kind !== 'rows') { ref.a.c -= dc; if (ref.b) ref.b.c -= dc; }
    if (ref.kind === 'cols') return ref;
    if (!ref.b) { ref.a.r -= d; return ref.a.r < 0 ? null : ref; }
    const lo = Math.min(ref.a.r, ref.b.r) - d, hi = Math.max(ref.a.r, ref.b.r) - d;
    if (hi < 0) return null;
    if (ref.a.r <= ref.b.r) { ref.a.r = Math.max(0, lo); ref.b.r = hi; } else { ref.b.r = Math.max(0, lo); ref.a.r = hi; }
    return ref;
  });
  return out;
}

// ---- values ----------------------------------------------------------------------------
// A value is a number, a string, a boolean, null (blank) or a FormulaError.
// Dates are serial numbers, days since 1899-12-30, as in Google Sheets.

const DAY_MS = 86400000;
const EPOCH = 25569; // serial of 1970-01-01
export function serialFromMs(ms) { return ms / DAY_MS + EPOCH; }
export function msFromSerial(s) { return Math.round((s - EPOCH) * DAY_MS); }
const pad2 = (n) => String(n).padStart(2, '0');
function ymd(serial) {
  const d = new Date(msFromSerial(Math.floor(serial)));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay() };
}
function serialOf(y, m, d) { return serialFromMs(Date.UTC(y, m - 1, d)); }
export function formatSerial(serial, withTime) {
  if (!Number.isFinite(serial)) return '';
  const p = ymd(serial);
  const day = `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  if (!withTime) return day;
  const mins = Math.round((serial - Math.floor(serial)) * 1440);
  return `${day} ${pad2(Math.floor(mins / 60) % 24)}:${pad2(mins % 60)}`;
}

const PLAIN_NUM = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
// Text a formula reads as a number: 12, -3.5, 1,200, $12, 15%, 2026-03-01.
export function textToNumber(text) {
  let s = String(text).trim();
  if (!s || s.length > 64) return null;
  if (PLAIN_NUM.test(s)) return Number(s);
  let m = ISO_DATE.exec(s);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const ms = Date.UTC(y, mo - 1, d, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    if (new Date(ms).getUTCDate() !== d) return null;
    return serialFromMs(ms);
  }
  let neg = false, pct = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1).trim(); }
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1).trim(); }
  s = s.replace(/^[$€£¥]/, '').replace(/[$€£¥]$/, '');
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  let v = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  if (pct) v /= 100;
  return neg ? -v : v;
}

// A literal cell's value from its text and its column type. deps are
// sheet-query.mjs's parseNumber and parseDate (passed in: no imports here).
export function cellValue(type, text, deps) {
  if (Array.isArray(text)) text = text.join(', ');
  const s = text == null ? '' : String(text);
  if (s.trim() === '') return null;
  if (type === 'checkbox') return /^(✓|✔|☑|✅|x|true|yes|y|1|done|on)$/i.test(s.trim());
  if (type === 'number') {
    // A percentage is its fraction, as in a spreadsheet: 15% is 0.15.
    const n = textToNumber(s);
    if (n != null) return n;
    const m = deps && deps.parseNumber ? deps.parseNumber(s) : null;
    return m == null ? s : m;
  }
  if (type === 'date') {
    const ms = deps && deps.parseDate ? deps.parseDate(s) : null;
    if (ms != null) return serialFromMs(ms);
    const n = textToNumber(s);
    return n == null ? s : n;
  }
  if (type === 'tags' || type === 'url') return s;
  return PLAIN_NUM.test(s.trim()) ? Number(s.trim()) : s;
}

export function formatNumber(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  if (Object.is(n, -0) || n === 0) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  // 15 significant digits at most (no 0.30000000000000004), and at most
  // 10 decimals, as a spreadsheet's automatic format shows them.
  let r = parseFloat(n.toPrecision(15));
  if (Math.abs(r) >= 1e-6 && Math.abs(r) < 1e15) {
    r = parseFloat(r.toFixed(10));
    const s = String(r);
    if (!/e/i.test(s)) return s;
  }
  return r.toExponential().replace(/\.?0+e/, 'e').replace('e+', 'E+').replace('e-', 'E-');
}

function toText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatNumber(v);
  return String(v);
}
function toNum(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isErr(v)) return v;
  if (typeof v === 'string') { if (v.trim() === '') return E['#VALUE!']; const n = textToNumber(v); return n == null ? E['#VALUE!'] : n; }
  return E['#VALUE!'];
}
function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null || v === undefined) return false;
  if (isErr(v)) return v;
  const s = String(v).trim().toUpperCase();
  if (s === 'TRUE') return true;
  if (s === 'FALSE') return false;
  return E['#VALUE!'];
}
function checkNum(n) { return Number.isFinite(n) ? n : E['#NUM!']; }
function checkText(s) { return s.length > LIMITS.textChars ? E['#VALUE!'] : s; }

// Spreadsheet order: numbers < text < booleans; text without case.
function typeRank(v) { return typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 3; }
function compare(a, b) {
  if (a === null || a === undefined) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null || b === undefined) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  if (ra === 2) return (a ? 1 : 0) - (b ? 1 : 0);
  return a < b ? -1 : a > b ? 1 : 0;
}

// The work meter of the recalculation running now: text work (wildcards,
// comparisons) is charged by its length, so a long string costs what it
// costs and the budget holds. A no-op outside a recalculation.
let charge = () => {};
// Criteria and lookup patterns are at most this long, as in Excel.
const MAX_PATTERN = 255;

// * any run, ? one character, ~ escapes the next. Matching in
// O(pattern × text) steps at worst, each charged (no regex built from what
// the sheet holds).
function wildcardMatch(pattern, text) {
  const p = [], lit = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~' && i + 1 < pattern.length) { p.push(pattern[++i].toLowerCase()); lit.push(true); }
    else { p.push(ch === '*' || ch === '?' ? ch : ch.toLowerCase()); lit.push(ch !== '*' && ch !== '?'); }
  }
  const t = text.toLowerCase();
  charge(1 + (t.length >> 4));
  let pi = 0, ti = 0, star = -1, mark = 0, steps = 0;
  while (ti < t.length) {
    if (++steps === 256) { charge(256); steps = 0; }
    if (pi < p.length && (lit[pi] ? p[pi] === t[ti] : p[pi] === '?')) { pi++; ti++; }
    else if (pi < p.length && !lit[pi] && p[pi] === '*') { star = pi++; mark = ti; }
    else if (star !== -1) { pi = star + 1; ti = ++mark; }
    else return false;
  }
  while (pi < p.length && !lit[pi] && p[pi] === '*') pi++;
  return pi === p.length;
}
const hasWild = (s) => /[*?~]/.test(s);

// A COUNTIF-style criterion: 5, ">5", "<>done", "a*", "" (blank).
function criterion(c) {
  if (isErr(c)) return () => false;
  if (typeof c === 'number') return (v) => (typeof v === 'number' ? v === c : typeof v === 'string' && textToNumber(v) === c);
  if (typeof c === 'boolean') return (v) => v === c;
  if (c === null || c === undefined) return (v) => v === null || v === '';
  const s = String(c);
  let op = '=', rest = s;
  const m = /^(<=|>=|<>|<|>|=)/.exec(s);
  if (m) { op = m[1]; rest = s.slice(m[1].length); }
  if (rest === '') {
    if (op === '=') return (v) => v === null || v === '';
    if (op === '<>') return (v) => v !== null && v !== '';
  }
  const num = textToNumber(rest);
  if (num !== null) {
    return (v) => {
      let x = typeof v === 'number' ? v : null;
      if (x === null && typeof v === 'string' && (op === '=' || op === '<>')) { charge(1 + (v.length >> 4)); x = textToNumber(v); }
      if (op === '<>') return x === null || x !== num;
      if (x === null) return false;
      return op === '=' ? x === num : op === '<' ? x < num : op === '>' ? x > num : op === '<=' ? x <= num : x >= num;
    };
  }
  const up = rest.toUpperCase();
  if (up === 'TRUE' || up === 'FALSE') {
    const b = up === 'TRUE';
    return op === '<>' ? (v) => v !== b : (v) => v === b;
  }
  if (op === '=' || op === '<>') {
    const wild = hasWild(rest);
    const low = rest.toLowerCase();
    const eq = (v) => typeof v === 'string' && (wild ? wildcardMatch(rest, v) : (charge(1 + (v.length >> 4)), v.toLowerCase() === low));
    return op === '=' ? eq : (v) => !eq(v);
  }
  return (v) => {
    if (typeof v !== 'string') return false;
    charge(1 + (v.length >> 4));
    const d = compare(v, rest);
    return op === '<' ? d < 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : d >= 0;
  };
}

// ---- TEXT(value, format) -------------------------------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatText(value, fmt) {
  if (fmt.length > 255) return E['#VALUE!'];
  if (typeof value === 'string') { const n = textToNumber(value); if (n === null) return value; value = n; }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value === null) value = 0;
  const sections = splitSections(fmt);
  let f = sections[0];
  let v = value;
  if (v < 0 && sections.length > 1) { f = sections[1]; v = -v; }
  else if (v === 0 && sections.length > 2) f = sections[2];
  if (/[yYdDhHsS]|(^|[^0#?])m+/.test(stripQuoted(f)) && !/[0#]/.test(stripQuoted(f))) return formatDatePattern(v, f);
  return formatNumberPattern(v, f, sections.length > 1 && value < 0);
}
function stripQuoted(f) { return f.replace(/"[^"]*"/g, '').replace(/\\./g, ''); }
function splitSections(f) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < f.length; i++) {
    const ch = f[i];
    if (ch === '"') q = !q;
    if (ch === '\\' && i + 1 < f.length) { cur += ch + f[++i]; continue; }
    if (ch === ';' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function formatDatePattern(serial, f) {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2958466) return E['#VALUE!'];
  const p = ymd(serial);
  const secs = Math.round((serial - Math.floor(serial)) * 86400);
  let H = Math.floor(secs / 3600) % 24, Mi = Math.floor(secs / 60) % 60, S = secs % 60;
  const ampm = /AM\/PM|A\/P/i.test(f);
  let out = '', i = 0, lastWasHour = false;
  const lower = f.toLowerCase();
  while (i < f.length) {
    const ch = f[i], lc = lower[i];
    if (ch === '"') { const j = f.indexOf('"', i + 1); out += f.slice(i + 1, j < 0 ? f.length : j); i = j < 0 ? f.length : j + 1; continue; }
    if (ch === '\\') { out += f[i + 1] || ''; i += 2; continue; }
    if (lower.startsWith('am/pm', i)) { out += H < 12 ? 'AM' : 'PM'; i += 5; continue; }
    if (lower.startsWith('a/p', i)) { out += H < 12 ? 'A' : 'P'; i += 3; continue; }
    let n = 1;
    while (lower[i + n] === lc) n++;
    if (lc === 'y') { out += n <= 2 ? pad2(p.y % 100) : String(p.y); i += n; lastWasHour = false; continue; }
    if (lc === 'd') { out += n === 1 ? p.d : n === 2 ? pad2(p.d) : n === 3 ? DAYS[p.w].slice(0, 3) : DAYS[p.w]; i += n; lastWasHour = false; continue; }
    if (lc === 'h') { const h12 = ampm ? (H % 12 || 12) : H; out += n >= 2 ? pad2(h12) : h12; i += n; lastWasHour = true; continue; }
    if (lc === 's') { out += n >= 2 ? pad2(S) : S; i += n; lastWasHour = false; continue; }
    if (lc === 'm') {
      const nextS = /^[^a-z]*s/.test(lower.slice(i + n));
      if (lastWasHour || (nextS && n <= 2)) out += n >= 2 ? pad2(Mi) : Mi;
      else out += n === 1 ? p.m : n === 2 ? pad2(p.m) : n === 3 ? MONTHS[p.m - 1].slice(0, 3) : MONTHS[p.m - 1];
      i += n; lastWasHour = false; continue;
    }
    out += ch; i++;
  }
  return out;
}
function formatNumberPattern(v, f, signShown) {
  if (!Number.isFinite(v)) return E['#VALUE!'];
  let prefix = '', suffix = '', core = '', i = 0, inCore = false, done = false;
  // Literal text around the digits: "…", \x, $, spaces and the like.
  while (i < f.length) {
    const ch = f[i];
    let lit = null;
    if (ch === '"') { const j = f.indexOf('"', i + 1); lit = f.slice(i + 1, j < 0 ? f.length : j); i = j < 0 ? f.length : j + 1; }
    else if (ch === '\\') { lit = f[i + 1] || ''; i += 2; }
    else if ('0#?.,'.includes(ch) || ((ch === 'E' || ch === 'e') && inCore && /[+-]/.test(f[i + 1] || ''))) {
      if (done) { suffix += ch; i++; continue; }
      inCore = true;
      if (ch === 'E' || ch === 'e') { core += f.slice(i, i + 2); i += 2; while (f[i] === '0' || f[i] === '#') core += f[i++]; continue; }
      core += ch; i++; continue;
    } else if (ch === '%') { lit = '%'; v *= 100; i++; }
    else { lit = ch; i++; }
    if (lit !== null) { if (inCore) { done = true; suffix += lit; } else prefix += lit; }
  }
  if (!core) return prefix + suffix;
  let exp = null;
  const em = /[eE]([+-])([0#]+)$/.exec(core);
  if (em) { exp = em; core = core.slice(0, em.index); }
  const dot = core.indexOf('.');
  const intPat = dot === -1 ? core : core.slice(0, dot);
  const decPat = dot === -1 ? '' : core.slice(dot + 1).replace(/,/g, '');
  const thousands = /[0#?],[0#?]/.test(intPat);
  // A trailing comma scales by a thousand.
  let scale = 0;
  let ip = intPat;
  while (ip.endsWith(',')) { scale++; ip = ip.slice(0, -1); }
  v /= Math.pow(1000, scale);
  const neg = v < 0 && !signShown;
  let a = Math.abs(v);
  let expText = '';
  if (exp) {
    let e = a === 0 ? 0 : Math.floor(Math.log10(a));
    a = a / Math.pow(10, e);
    if (Number(a.toFixed(Math.min(decPat.length, 30))) >= 10) { a /= 10; e += 1; }
    expText = 'E' + (e < 0 ? '-' : exp[1] === '+' ? '+' : '') + String(Math.abs(e)).padStart(exp[2].length, '0');
  }
  const decs = Math.min(decPat.length, 30);
  if (a >= 1e21) return formatNumber(neg ? -a : a);
  const fixed = roundHalfAway(a, decs).toFixed(decs);
  let [intPart, decPart = ''] = fixed.split('.');
  const minInt = (ip.replace(/,/g, '').match(/0/g) || []).length;
  if (intPart === '0' && minInt === 0) intPart = '';
  intPart = intPart.padStart(minInt, '0');
  if (thousands) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // Optional decimals (#) drop trailing zeros.
  let optional = 0;
  for (let k = decPat.length - 1; k >= 0 && decPat[k] === '#'; k--) optional++;
  while (optional-- > 0 && decPart.endsWith('0')) decPart = decPart.slice(0, -1);
  const body = intPart + (decPart || decPat.length && /0/.test(decPat) ? '.' + decPart : '') + expText;
  return (neg ? '-' : '') + prefix + body + suffix;
}
function roundHalfAway(x, digits) {
  const m = Math.pow(10, digits);
  const y = Math.abs(x) * m;
  const r = Math.round(Number(y.toPrecision(15)));
  return Math.sign(x) * r / m;
}

// ---- the interpreter --------------------------------------------------------------------------

// A range as a value: a function reads its cells; anywhere else a single
// cell reads as that cell, a larger range is #VALUE!.
class Area {
  constructor(sheet, r1, c1, r2, c2) { this.sheet = sheet; this.r1 = r1; this.c1 = c1; this.r2 = r2; this.c2 = c2; }
  get rows() { return this.r2 - this.r1 + 1; }
  get cols() { return this.c2 - this.c1 + 1; }
}

const PENDING = Object.freeze({ pending: true });

// The function table: name → [min args, max args, fn(args, cx)]. Arguments
// arrive as AST nodes; cx.ev(node) evaluates one (an Area for a range),
// cx.sc(node) evaluates one to a single value.
const FUNCS = Object.create(null);
function def(name, min, max, fn) { FUNCS[name] = { min, max, fn }; }

function eachValue(cx, args, fn) {
  // Values for SUM-like functions: from a range, the cells as they are;
  // a value written in the call, as the call wrote it.
  for (const a of args) {
    if (a.t === 'missing') continue;
    const v = cx.ev(a);
    if (v instanceof Area) {
      const r = cx.eachCell(v, (x) => fn(x, true));
      if (r === false) return false;
    } else if (fn(v, false) === false) return false;
  }
  return true;
}
// SUM, AVERAGE, MIN, MAX over their arguments in one pass: a range's
// numbers (text, booleans and blanks in a range are skipped), a written
// value coerced. → { n, sum, min, max } or an error.
function aggregate(cx, args) {
  let n = 0, sum = 0, min = Infinity, max = -Infinity;
  for (const a of args) {
    if (a.t === 'missing') continue;
    const v = cx.ev(a);
    if (v instanceof Area) {
      // Every cell of a range is final once a formula reads it, so the same
      // range read again in this recalculation (=SUM(A:A) in many cells) is
      // the same figures.
      const key = v.sheet.name + '\u0000' + v.r1 + ',' + v.c1 + ',' + v.r2 + ',' + v.c2;
      const hit = cx.memo.get(key);
      if (hit) {
        if (hit.err) return hit.err;
        n += hit.n; sum += hit.sum; if (hit.min < min) min = hit.min; if (hit.max > max) max = hit.max;
        continue;
      }
      const g = areaAggregate(cx, v);
      if (cx.memo.size < 10000) cx.memo.set(key, g);
      if (g.err) return g.err;
      n += g.n; sum += g.sum; if (g.min < min) min = g.min; if (g.max > max) max = g.max;
    } else {
      if (isErr(v)) return v;
      if (v === null) continue;
      const x = toNum(v);
      if (isErr(x)) return x;
      n++; sum += x; if (x < min) min = x; if (x > max) max = x;
    }
  }
  return { n, sum, min, max };
}
function areaAggregate(cx, v) {
  let n = 0, sum = 0, min = Infinity, max = -Infinity;
  {
    {
      const s = v.sheet;
      const r2 = Math.min(v.r2, s.rows - 1), c2 = Math.min(v.c2, s.cols - 1);
      for (let r = v.r1; r <= r2; r++) {
        const row = s.vals[r];
        cx.tick(c2 - v.c1 + 1);
        for (let c = v.c1; c <= c2; c++) {
          const x = row[c];
          if (typeof x === 'number') { n++; sum += x; if (x < min) min = x; if (x > max) max = x; }
          else if (x === PENDING) return { err: E['#CYCLE!'] };
          else if (x instanceof FormulaError) return { err: x };
        }
      }
    }
  }
  return { n, sum, min, max, err: null };
}
function areaOf(cx, node) {
  if (node.t === 'missing') return E['#VALUE!'];
  const v = cx.ev(node);
  if (v instanceof Area || isErr(v)) return v;
  // A single value stands for a 1×1 range.
  return { single: v };
}
function areaGet(cx, a, i, j) {
  if (a.single !== undefined) return i === 0 && j === 0 ? a.single : null;
  return cx.cell(a.sheet, a.r1 + i, a.c1 + j);
}
function areaDims(a) { return a.single !== undefined ? [1, 1] : [a.rows, a.cols]; }
function argNum(cx, node, dflt) {
  if (!node || node.t === 'missing') return dflt;
  const v = cx.sc(node);
  return isErr(v) ? v : toNum(v);
}
function argText(cx, node) {
  const v = cx.sc(node);
  return isErr(v) ? v : toText(v);
}

def('SUM', 1, 255, (args, cx) => { const g = aggregate(cx, args); return isErr(g) ? g : checkNum(g.sum); });
def('AVERAGE', 1, 255, (args, cx) => { const g = aggregate(cx, args); if (isErr(g)) return g; return g.n ? checkNum(g.sum / g.n) : E['#DIV/0!']; });
def('MIN', 1, 255, (args, cx) => { const g = aggregate(cx, args); return isErr(g) ? g : g.n ? g.min : 0; });
def('MAX', 1, 255, (args, cx) => { const g = aggregate(cx, args); return isErr(g) ? g : g.n ? g.max : 0; });
def('COUNT', 1, 255, (args, cx) => {
  let k = 0;
  eachValue(cx, args, (v, inRange) => { if (typeof v === 'number' || (!inRange && (typeof v === 'boolean' || (typeof v === 'string' && textToNumber(v) !== null)))) k++; });
  return k;
});
def('COUNTA', 1, 255, (args, cx) => { let k = 0; eachValue(cx, args, (v) => { if (v !== null && v !== undefined) k++; }); return k; });

// *IF and *IFS: ranges walked in step.
function ifsMatch(cx, pairs) {
  // pairs: [[areaNode, critNode], …] → { dims, test(i, j) }
  let dims = null;
  const list = [];
  for (const [rn, cn] of pairs) {
    const a = areaOf(cx, rn);
    if (isErr(a)) return a;
    const d = areaDims(a);
    if (dims && (d[0] !== dims[0] || d[1] !== dims[1])) return E['#VALUE!'];
    dims = d;
    const c = cx.sc(cn);
    if (isErr(c)) return c;
    if (typeof c === 'string' && c.length > MAX_PATTERN) return E['#VALUE!'];
    list.push({ a, test: criterion(c) });
  }
  return { dims, test: (i, j) => list.every((x) => x.test(areaGet(cx, x.a, i, j))) };
}
function walk(cx, dims, fn) {
  for (let i = 0; i < dims[0]; i++) for (let j = 0; j < dims[1]; j++) { cx.tick(); fn(i, j); }
}
function pairsFrom(args, from) {
  const out = [];
  for (let k = from; k + 1 < args.length; k += 2) out.push([args[k], args[k + 1]]);
  return out;
}
def('COUNTIF', 2, 2, (args, cx) => {
  const m = ifsMatch(cx, [[args[0], args[1]]]); if (isErr(m)) return m;
  let k = 0; walk(cx, m.dims, (i, j) => { if (m.test(i, j)) k++; }); return k;
});
def('COUNTIFS', 2, 254, (args, cx) => {
  if (args.length % 2) return E['#N/A'];
  const m = ifsMatch(cx, pairsFrom(args, 0)); if (isErr(m)) return m;
  let k = 0; walk(cx, m.dims, (i, j) => { if (m.test(i, j)) k++; }); return k;
});
function sumIf(cx, rangeNode, critNode, sumNode, avg) {
  const m = ifsMatch(cx, [[rangeNode, critNode]]); if (isErr(m)) return m;
  let s = m;
  let target = null;
  if (sumNode && sumNode.t !== 'missing') { target = areaOf(cx, sumNode); if (isErr(target)) return target; }
  else target = areaOf(cx, rangeNode);
  let sum = 0, n = 0, err = null;
  walk(cx, s.dims, (i, j) => {
    if (err || !s.test(i, j)) return;
    const v = areaGet(cx, target, i, j);
    if (isErr(v)) { err = v; return; }
    if (typeof v === 'number') { sum += v; n++; }
  });
  if (err) return err;
  if (avg) return n ? sum / n : E['#DIV/0!'];
  return checkNum(sum);
}
def('SUMIF', 2, 3, (args, cx) => sumIf(cx, args[0], args[1], args[2], false));
def('AVERAGEIF', 2, 3, (args, cx) => sumIf(cx, args[0], args[1], args[2], true));
function sumIfs(args, cx, avg) {
  if (args.length % 2 === 0) return E['#N/A'];
  const target = areaOf(cx, args[0]); if (isErr(target)) return target;
  const m = ifsMatch(cx, pairsFrom(args, 1)); if (isErr(m)) return m;
  const d = areaDims(target);
  if (d[0] !== m.dims[0] || d[1] !== m.dims[1]) return E['#VALUE!'];
  let sum = 0, n = 0, err = null;
  walk(cx, m.dims, (i, j) => {
    if (err || !m.test(i, j)) return;
    const v = areaGet(cx, target, i, j);
    if (isErr(v)) { err = v; return; }
    if (typeof v === 'number') { sum += v; n++; }
  });
  if (err) return err;
  return avg ? (n ? sum / n : E['#DIV/0!']) : checkNum(sum);
}
def('SUMIFS', 3, 255, (args, cx) => sumIfs(args, cx, false));
def('AVERAGEIFS', 3, 255, (args, cx) => sumIfs(args, cx, true));

// Logic: IF and friends evaluate only the branch they take.
def('IF', 1, 3, (args, cx) => {
  const c = toBool(cx.sc(args[0]));
  if (isErr(c)) return c;
  const branch = c ? args[1] : args[2];
  if (!branch) return c ? true : false;
  if (branch.t === 'missing') return c ? 0 : false;
  return cx.ev(branch);
});
def('IFS', 2, 254, (args, cx) => {
  if (args.length % 2) return E['#N/A'];
  for (let k = 0; k < args.length; k += 2) {
    const c = toBool(cx.sc(args[k]));
    if (isErr(c)) return c;
    if (c) return cx.ev(args[k + 1]);
  }
  return E['#N/A'];
});
def('IFERROR', 1, 2, (args, cx) => {
  const v = cx.sc(args[0]);
  if (!isErr(v)) return v;
  return args[1] && args[1].t !== 'missing' ? cx.ev(args[1]) : '';
});
function logic(args, cx, isAnd) {
  let seen = false, out = isAnd, err = null;
  eachValue(cx, args, (v, inRange) => {
    if (isErr(v)) { err = v; return false; }
    if (inRange && typeof v !== 'boolean' && typeof v !== 'number') return true;
    const b = toBool(v);
    if (isErr(b)) { err = b; return false; }
    seen = true;
    if (isAnd && !b) out = false;
    if (!isAnd && b) out = true;
    return true;
  });
  if (err) return err;
  return seen ? out : E['#VALUE!'];
}
def('AND', 1, 255, (args, cx) => logic(args, cx, true));
def('OR', 1, 255, (args, cx) => logic(args, cx, false));
def('NOT', 1, 1, (args, cx) => { const b = toBool(cx.sc(args[0])); return isErr(b) ? b : !b; });

// Math.
def('ROUND', 1, 2, (args, cx) => {
  const x = argNum(cx, args[0], 0), d = argNum(cx, args[1], 0);
  if (isErr(x)) return x; if (isErr(d)) return d;
  return checkNum(roundHalfAway(x, Math.trunc(d)));
});
function roundDir(args, cx, up) {
  const x = argNum(cx, args[0], 0), d = argNum(cx, args[1], 0);
  if (isErr(x)) return x; if (isErr(d)) return d;
  const m = Math.pow(10, Math.trunc(d));
  const y = Number((Math.abs(x) * m).toPrecision(15));
  return checkNum(Math.sign(x) * (up ? Math.ceil(y) : Math.floor(y)) / m);
}
def('ROUNDUP', 1, 2, (args, cx) => roundDir(args, cx, true));
def('ROUNDDOWN', 1, 2, (args, cx) => roundDir(args, cx, false));
def('ABS', 1, 1, (args, cx) => { const x = argNum(cx, args[0], 0); return isErr(x) ? x : Math.abs(x); });

// Lookup.
function exactEq(a, b, wild) {
  if (typeof a === 'string' && typeof b === 'string') charge(1 + (a.length >> 4));
  if (typeof a === 'string' && typeof b === 'string') return wild && hasWild(b) ? wildcardMatch(b, a) : a.toLowerCase() === b.toLowerCase();
  if (a === null || a === undefined) return b === '' ;
  return typeof a === typeof b && a === b;
}
// Position (0-based) of key in a 1-D list read by get(i), n long.
// mode 0: exact (wild: * ? ~); 1: largest ≤ key in ascending data;
// -1: smallest ≥ key in descending data. -1 when there is none.
function findIn(cx, n, get, key, mode, wild, reverse) {
  if (typeof key === 'string' && key.length > MAX_PATTERN && wild && hasWild(key)) return -1;
  if (mode === 0) {
    for (let k = 0; k < n; k++) { cx.tick(); const i = reverse ? n - 1 - k : k; if (exactEq(get(i), key, wild)) return i; }
    return -1;
  }
  let best = -1;
  for (let i = 0; i < n; i++) {
    cx.tick();
    const v = get(i);
    if (v === null || typeRank(v) !== typeRank(key)) continue;
    if (typeof v === 'string') charge(1 + (v.length >> 4));
    const d = compare(v, key);
    if (mode === 1) { if (d <= 0) best = i; else break; }
    else { if (d >= 0) best = i; else break; }
  }
  return best;
}
function lookup(args, cx, vertical) {
  const key = cx.sc(args[0]);
  if (isErr(key)) return key;
  const a = areaOf(cx, args[1]);
  if (isErr(a)) return a;
  const idx = argNum(cx, args[2], 1);
  if (isErr(idx)) return idx;
  let sorted = true;
  if (args[3] && args[3].t !== 'missing') { const s = toBool(cx.sc(args[3])); if (isErr(s)) return s; sorted = s; }
  const [rows, cols] = areaDims(a);
  const k = Math.trunc(idx);
  if (k < 1) return E['#VALUE!'];
  if (k > (vertical ? cols : rows)) return E['#REF!'];
  const n = vertical ? rows : cols;
  const at = findIn(cx, n, (i) => (vertical ? areaGet(cx, a, i, 0) : areaGet(cx, a, 0, i)), key, sorted ? 1 : 0, true, false);
  if (at < 0) return E['#N/A'];
  return vertical ? areaGet(cx, a, at, k - 1) : areaGet(cx, a, k - 1, at);
}
def('VLOOKUP', 3, 4, (args, cx) => lookup(args, cx, true));
def('HLOOKUP', 3, 4, (args, cx) => lookup(args, cx, false));
def('XLOOKUP', 3, 6, (args, cx) => {
  const key = cx.sc(args[0]);
  if (isErr(key)) return key;
  const look = areaOf(cx, args[1]), ret = areaOf(cx, args[2]);
  if (isErr(look)) return look; if (isErr(ret)) return ret;
  const mm = argNum(cx, args[4], 0), sm = argNum(cx, args[5], 1);
  if (isErr(mm)) return mm; if (isErr(sm)) return sm;
  const [lr, lc] = areaDims(look);
  if (lr !== 1 && lc !== 1) return E['#VALUE!'];
  const vertical = lc === 1 && lr !== 1 || (lr === 1 && lc === 1);
  const n = vertical ? lr : lc;
  const get = (i) => (vertical ? areaGet(cx, look, i, 0) : areaGet(cx, look, 0, i));
  let pos = -1;
  if (mm === 0 || mm === 2) pos = findIn(cx, n, get, key, 0, mm === 2, sm < 0);
  else if (mm === -1 || mm === 1) {
    // Next smaller (-1) or next larger (1) when there is no exact match.
    let best = -1, bestV = null;
    for (let i = 0; i < n; i++) {
      cx.tick();
      const v = get(i);
      if (v === null || typeRank(v) !== typeRank(key)) continue;
      const d = compare(v, key);
      if (d === 0) { best = i; break; }
      if (mm === -1 && d < 0 && (bestV === null || compare(v, bestV) > 0)) { best = i; bestV = v; }
      if (mm === 1 && d > 0 && (bestV === null || compare(v, bestV) < 0)) { best = i; bestV = v; }
    }
    pos = best;
  } else return E['#VALUE!'];
  if (pos < 0) return args[3] && args[3].t !== 'missing' ? cx.ev(args[3]) : E['#N/A'];
  const [rr, rc] = areaDims(ret);
  if (vertical) { if (rr !== n) return E['#VALUE!']; return areaGet(cx, ret, pos, 0); }
  if (rc !== n) return E['#VALUE!'];
  return areaGet(cx, ret, 0, pos);
});
def('INDEX', 2, 3, (args, cx) => {
  const a = areaOf(cx, args[0]);
  if (isErr(a)) return a;
  let r = argNum(cx, args[1], 0), c = argNum(cx, args[2], 0);
  if (isErr(r)) return r; if (isErr(c)) return c;
  r = Math.trunc(r); c = Math.trunc(c);
  const [rows, cols] = areaDims(a);
  if (rows === 1 && (!args[2] || args[2].t === 'missing') && cols > 1) { c = r; r = 1; }
  if (r < 0 || c < 0 || r > rows || c > cols) return E['#REF!'];
  if (a.single !== undefined) return a.single;
  if (r === 0 && c === 0) return a;
  if (r === 0) return new Area(a.sheet, a.r1, a.c1 + c - 1, a.r2, a.c1 + c - 1);
  if (c === 0) { if (cols === 1) c = 1; else return new Area(a.sheet, a.r1 + r - 1, a.c1, a.r1 + r - 1, a.c2); }
  return areaGet(cx, a, r - 1, c - 1);
});
def('MATCH', 2, 3, (args, cx) => {
  const key = cx.sc(args[0]);
  if (isErr(key)) return key;
  const a = areaOf(cx, args[1]);
  if (isErr(a)) return a;
  const t = argNum(cx, args[2], 1);
  if (isErr(t)) return t;
  const [rows, cols] = areaDims(a);
  if (rows !== 1 && cols !== 1) return E['#N/A'];
  const vertical = cols === 1;
  const n = vertical ? rows : cols;
  const mode = t > 0 ? 1 : t < 0 ? -1 : 0;
  const pos = findIn(cx, n, (i) => (vertical ? areaGet(cx, a, i, 0) : areaGet(cx, a, 0, i)), key, mode, true, false);
  return pos < 0 ? E['#N/A'] : pos + 1;
});

// Text.
function joinValues(cx, args, sep, skipEmpty) {
  let out = '', first = true, err = null;
  eachValue(cx, args, (v) => {
    if (isErr(v)) { err = v; return false; }
    const s = toText(v);
    if (skipEmpty && s === '') return true;
    out += (first ? '' : sep) + s;
    first = false;
    if (out.length > LIMITS.textChars) { err = E['#VALUE!']; return false; }
    return true;
  });
  return err || out;
}
def('CONCAT', 1, 255, (args, cx) => joinValues(cx, args, '', false));
def('CONCATENATE', 1, 255, (args, cx) => joinValues(cx, args, '', false));
def('TEXTJOIN', 3, 255, (args, cx) => {
  const sep = argText(cx, args[0]); if (isErr(sep)) return sep;
  const skip = toBool(cx.sc(args[1])); if (isErr(skip)) return skip;
  return joinValues(cx, args.slice(2), sep, skip);
});
function strNum(args, cx, k, dflt) { return argNum(cx, args[k], dflt); }
def('LEFT', 1, 2, (args, cx) => {
  const s = argText(cx, args[0]); if (isErr(s)) return s;
  const n = strNum(args, cx, 1, 1); if (isErr(n)) return n;
  if (n < 0) return E['#VALUE!'];
  return Array.from(s).slice(0, Math.trunc(n)).join('');
});
def('RIGHT', 1, 2, (args, cx) => {
  const s = argText(cx, args[0]); if (isErr(s)) return s;
  const n = strNum(args, cx, 1, 1); if (isErr(n)) return n;
  if (n < 0) return E['#VALUE!'];
  const ch = Array.from(s), k = Math.trunc(n);
  return k ? ch.slice(Math.max(0, ch.length - k)).join('') : '';
});
def('MID', 3, 3, (args, cx) => {
  const s = argText(cx, args[0]); if (isErr(s)) return s;
  const st = strNum(args, cx, 1, 1); if (isErr(st)) return st;
  const n = strNum(args, cx, 2, 0); if (isErr(n)) return n;
  if (st < 1 || n < 0) return E['#VALUE!'];
  return Array.from(s).slice(Math.trunc(st) - 1, Math.trunc(st) - 1 + Math.trunc(n)).join('');
});
def('LEN', 1, 1, (args, cx) => { const s = argText(cx, args[0]); return isErr(s) ? s : Array.from(s).length; });
def('TRIM', 1, 1, (args, cx) => { const s = argText(cx, args[0]); return isErr(s) ? s : s.replace(/ +/g, ' ').trim(); });
def('UPPER', 1, 1, (args, cx) => { const s = argText(cx, args[0]); return isErr(s) ? s : s.toUpperCase(); });
def('LOWER', 1, 1, (args, cx) => { const s = argText(cx, args[0]); return isErr(s) ? s : s.toLowerCase(); });
def('SUBSTITUTE', 3, 4, (args, cx) => {
  const s = argText(cx, args[0]); if (isErr(s)) return s;
  const from = argText(cx, args[1]); if (isErr(from)) return from;
  const to = argText(cx, args[2]); if (isErr(to)) return to;
  if (!from) return s;
  const parts = s.split(from);
  if (args[3] && args[3].t !== 'missing') {
    const k = argNum(cx, args[3], 1); if (isErr(k)) return k;
    const n = Math.trunc(k);
    if (n < 1) return E['#VALUE!'];
    if (n >= parts.length) return s;
    return checkText(parts.slice(0, n).join(from) + to + parts.slice(n).join(from));
  }
  if (s.length + (parts.length - 1) * (to.length - from.length) > LIMITS.textChars) return E['#VALUE!'];
  return parts.join(to);
});
def('TEXT', 2, 2, (args, cx) => {
  const v = cx.sc(args[0]); if (isErr(v)) return v;
  const f = argText(cx, args[1]); if (isErr(f)) return f;
  return formatText(v, f);
});
def('VALUE', 1, 1, (args, cx) => {
  const v = cx.sc(args[0]);
  if (isErr(v) || typeof v === 'number') return v;
  if (v === null) return 0;
  if (typeof v === 'boolean') return E['#VALUE!'];
  const n = textToNumber(v);
  return n === null ? E['#VALUE!'] : n;
});

// Dates.
def('TODAY', 0, 0, (args, cx) => { const d = new Date(cx.now()); return serialOf(d.getFullYear(), d.getMonth() + 1, d.getDate()); });
def('NOW', 0, 0, (args, cx) => {
  const d = new Date(cx.now());
  return serialOf(d.getFullYear(), d.getMonth() + 1, d.getDate()) + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
});
def('DATE', 3, 3, (args, cx) => {
  let y = argNum(cx, args[0], 0), m = argNum(cx, args[1], 0), d = argNum(cx, args[2], 0);
  if (isErr(y)) return y; if (isErr(m)) return m; if (isErr(d)) return d;
  y = Math.trunc(y); m = Math.trunc(m); d = Math.trunc(d);
  if (y < 0 || y > 9999) return E['#NUM!'];
  if (y < 1900) y += 1900;
  const s = serialFromMs(Date.UTC(y, m - 1, 1)) + d - 1;
  if (!Number.isFinite(s) || s < 0) return E['#NUM!'];
  return s;
});
function datePart(args, cx, part) {
  const v = cx.sc(args[0]);
  if (isErr(v)) return v;
  const n = typeof v === 'string' ? textToNumber(v) : toNum(v);
  if (n === null || isErr(n)) return E['#VALUE!'];
  if (n < 0 || n >= 2958466) return E['#NUM!'];
  const p = ymd(n);
  return p[part];
}
def('YEAR', 1, 1, (args, cx) => datePart(args, cx, 'y'));
def('MONTH', 1, 1, (args, cx) => datePart(args, cx, 'm'));
def('DAY', 1, 1, (args, cx) => datePart(args, cx, 'd'));
def('DATEDIF', 3, 3, (args, cx) => {
  const a = argNum(cx, args[0], 0), b = argNum(cx, args[1], 0);
  if (isErr(a)) return a; if (isErr(b)) return b;
  const unit = argText(cx, args[2]); if (isErr(unit)) return unit;
  const s = Math.floor(a), e = Math.floor(b);
  if (s > e) return E['#NUM!'];
  const p = ymd(s), q = ymd(e);
  let months = (q.y - p.y) * 12 + (q.m - p.m);
  if (q.d < p.d) months--;
  switch (unit.toUpperCase()) {
    case 'D': return e - s;
    case 'M': return months;
    case 'Y': return Math.floor(months / 12);
    case 'YM': return months % 12;
    case 'MD': {
      if (q.d >= p.d) return q.d - p.d;
      // Days from the start's day-of-month in the month before the end.
      const prev = serialOf(q.y, q.m, 1) - 1;
      const pm = ymd(prev);
      return e - serialOf(pm.y, pm.m, Math.min(p.d, pm.d));
    }
    case 'YD': {
      let start = serialOf(q.y, p.m, p.d);
      if (start > e) start = serialOf(q.y - 1, p.m, p.d);
      return e - start;
    }
    default: return E['#NUM!'];
  }
});

export const FUNCTION_NAMES = Object.freeze(Object.keys(FUNCS).sort());

// What kind of number a formula gives, for display: a date, a date-time, or
// a plain number. Only the plain cases: a date function, a date cell, and a
// date plus or minus a number.
function kindOf(node, refKind) {
  if (!node) return null;
  if (node.t === 'f') {
    if (node.name === 'TODAY' || node.name === 'DATE') return 'date';
    if (node.name === 'NOW') return 'datetime';
    if (node.name === 'IF' || node.name === 'IFERROR') return kindOf(node.args[1], refKind) || kindOf(node.args[2], refKind);
    if (node.name === 'MIN' || node.name === 'MAX') return node.args.length ? kindOf(node.args[0], refKind) : null;
    return null;
  }
  if (node.t === 'ref') return refKind(node.ref);
  if (node.t === 'bin' && (node.op === '+' || node.op === '-')) {
    const a = kindOf(node.a, refKind), b = kindOf(node.b, refKind);
    if (a && !b) return a;
    if (b && !a && node.op === '+') return b;
  }
  return null;
}

// ---- the workbook -------------------------------------------------------------------------------
// Sheets of literal values and formula cells. load() takes them all and
// computes every formula; update() takes one sheet again, finds the cells
// that changed and recomputes only the formulas that depend on them.

const ROWK = 16384; // columns per row in a cell key
function keyOf(r, c) { return r * ROWK + c; }

export function createWorkbook(options = {}) { return new Workbook(options); }

export class Workbook {
  constructor({ now, limits } = {}) {
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.limits = Object.assign({}, LIMITS, limits || {});
    this.sheets = [];
    this.byName = new Map();
    this.stats = { formulas: 0, evaluated: 0, ms: 0, busy: false, full: true };
  }
  sheet(name) { return this.byName.get(String(name).toLowerCase()) || null; }

  // input: { name, rows, cols, types?: [column type], cell(r, c) → value | { f: '=…' } }
  _read(input) {
    const rows = Math.max(0, Math.min(this.limits.rows, input.rows | 0)), cols = Math.max(0, Math.min(this.limits.cols, input.cols | 0));
    const vals = new Array(rows);
    const fsrc = new Map();
    for (let r = 0; r < rows; r++) {
      const row = new Array(cols);
      for (let c = 0; c < cols; c++) {
        const v = input.cell(r, c);
        if (v && typeof v === 'object' && typeof v.f === 'string') { fsrc.set(keyOf(r, c), v.f); row[c] = PENDING; }
        else row[c] = v === undefined ? null : v;
      }
      vals[r] = row;
    }
    return { name: String(input.name), rows, cols, types: (input.types || []).slice(), vals, fsrc };
  }

  // Every sheet at once; returns the formula cells: [{ sheet, r, c }].
  load(inputs) {
    this.sheets = [];
    this.byName = new Map();
    for (const input of inputs) {
      const s = this._read(input);
      s.fx = new Map();
      if (this.byName.has(s.name.toLowerCase())) continue;
      this.sheets.push(s);
      this.byName.set(s.name.toLowerCase(), s);
    }
    return this._rebuild();
  }

  // One sheet again (same name): what changed is recomputed, and so is
  // everything that depends on it. A new or resized sheet recomputes all.
  // Returns the formula cells whose value may have changed.
  update(input) {
    const old = this.sheet(input.name);
    const next = this._read(input);
    if (!old || old.rows !== next.rows || old.cols !== next.cols) {
      if (old) { const i = this.sheets.indexOf(old); this.sheets[i] = next; } else this.sheets.push(next);
      this.byName.set(next.name.toLowerCase(), next);
      next.fx = new Map();
      return this._rebuild();
    }
    // Same shape: diff the cells.
    const changed = [];
    const formulaEdits = [];
    let n = 0;
    old.types = next.types;
    for (let r = 0; r < next.rows; r++) {
      const a = old.vals[r], b = next.vals[r];
      for (let c = 0; c < next.cols; c++) {
        const k = keyOf(r, c);
        const of = old.fx.get(k), nf = next.fsrc.get(k);
        if (of || nf !== undefined) {
          if (!of || nf === undefined || of.src !== nf) { formulaEdits.push({ r, c, src: nf }); n++; }
          continue;
        }
        const x = a[c], y = b[c];
        if (x !== y && !(x === null && y === undefined)) { a[c] = y; changed.push(k); n++; }
      }
    }
    if (!n) return [];
    if (formulaEdits.length > 500) {
      for (const e of formulaEdits) old.vals[e.r][e.c] = e.src === undefined ? next.vals[e.r][e.c] : PENDING;
      old.fsrc = next.fsrc;
      return this._rebuild();
    }
    for (const e of formulaEdits) {
      const k = keyOf(e.r, e.c);
      const f = old.fx.get(k);
      if (f) this._unlink(f);
      if (e.src === undefined) { old.fx.delete(k); old.vals[e.r][e.c] = next.vals[e.r][e.c]; removeSorted(old.fcols[e.c], e.r); }
      else {
        const nf = this._compile(old, e.r, e.c, e.src);
        old.fx.set(k, nf);
        this._link(nf);
        if (!f) insertSorted(old.fcols[e.c], e.r);
      }
      changed.push(k);
    }
    old.fsrc = next.fsrc;
    return this._recompute(old, changed);
  }

  _compile(sheet, r, c, src) {
    const f = { sheet, r, c, src, ast: null, err: null, prec: [], kind: null, state: 2, frame: -1, cyc: false };
    try {
      if (String(src).length > this.limits.formulaChars + 1) throw new ParseError('too long');
      f.ast = parse(src);
    } catch (e) {
      f.err = E['#ERROR!'];
    }
    return f;
  }
  _resolve(f, ref) {
    // → { s, r1, c1, r2, c2 } in the sheet's bounds (whole rows/columns
    // clipped to what the sheet holds), or null when the sheet is unknown.
    const s = ref.sheet != null ? this.sheet(ref.sheet) : f.sheet;
    if (!s) return null;
    let r1, r2, c1, c2;
    if (ref.kind === 'cell') { r1 = r2 = ref.a.r; c1 = c2 = ref.a.c; }
    else if (ref.kind === 'area') { r1 = Math.min(ref.a.r, ref.b.r); r2 = Math.max(ref.a.r, ref.b.r); c1 = Math.min(ref.a.c, ref.b.c); c2 = Math.max(ref.a.c, ref.b.c); }
    else if (ref.kind === 'cols') { r1 = 0; r2 = Math.max(0, s.rows - 1); c1 = Math.min(ref.a.c, ref.b.c); c2 = Math.max(ref.a.c, ref.b.c); }
    else { c1 = 0; c2 = Math.max(0, s.cols - 1); r1 = Math.min(ref.a.r, ref.b.r); r2 = Math.max(ref.a.r, ref.b.r); }
    return { s, r1, c1, r2, c2, single: ref.kind === 'cell' };
  }
  _link(f) {
    f.prec = [];
    f.links = [];
    if (!f.ast) return;
    const refs = [];
    (function collect(n) {
      if (!n) return;
      if (n.t === 'ref') refs.push(n.ref);
      else if (n.t === 'f') n.args.forEach(collect);
      else if (n.t === 'bin') { collect(n.a); collect(n.b); }
      else if (n.t === 'neg' || n.t === 'pct') collect(n.a);
    })(f.ast);
    // The same range written many times is one dependency.
    const seen = new Set();
    for (const ref of refs) {
      const p = this._resolve(f, ref);
      if (!p) continue;
      const id = p.s.name + '\u0000' + p.r1 + ',' + p.c1 + ',' + p.r2 + ',' + p.c2;
      if (seen.has(id)) continue;
      seen.add(id);
      const s = p.s;
      if (p.single) {
        f.prec.push(p);
        const k = keyOf(p.r1, p.c1);
        let set = s.points.get(k);
        if (!set) s.points.set(k, set = new Set());
        set.add(f);
        f.links.push({ point: k, s });
        continue;
      }
      if (++this.rangeRefs > this.limits.rangeRefs) { this.rangeRefs--; this._unlink(f); f.err = E['#BUSY!']; return; }
      f.prec.push(p);
      const c2 = Math.min(p.c2, s.cols - 1);
      if (c2 - p.c1 + 1 <= this.limits.narrowCols) {
        for (let c = p.c1; c <= c2; c++) { const e = { r1: p.r1, r2: p.r2, f, dead: false }; s.areas[c].push(e); s.live++; f.links.push({ entry: e, s }); }
      } else {
        const e = { r1: p.r1, r2: p.r2, c1: p.c1, c2, f, dead: false };
        s.wide.push(e);
        s.live++;
        f.links.push({ entry: e, s });
      }
    }
    this._relinkKind(f);
  }
  // Undo _link: point sets lose the formula; range entries are marked dead
  // (no search), and a sheet's lists are compacted once half of them are.
  _unlink(f) {
    for (const l of f.links || []) {
      if (l.point !== undefined) {
        const set = l.s.points.get(l.point);
        if (set) { set.delete(f); if (!set.size) l.s.points.delete(l.point); }
      } else if (!l.entry.dead) {
        l.entry.dead = true;
        this.rangeRefs--;
        if (++l.s.dead > 1024 && l.s.dead * 2 > l.s.live) this._compact(l.s);
      }
    }
    f.links = [];
    f.prec = [];
  }
  _compact(s) {
    for (let c = 0; c < s.areas.length; c++) s.areas[c] = s.areas[c].filter((e) => !e.dead);
    s.wide = s.wide.filter((e) => !e.dead);
    s.live = s.wide.length + s.areas.reduce((n, a) => n + a.length, 0);
    s.dead = 0;
  }
  // The formulas that read cell (r, c) of sheet s.
  _readers(s, r, c, k, out) {
    const pts = s.points.get(k);
    if (pts) for (const g of pts) out(g);
    const areas = s.areas[c];
    if (areas) for (let i = 0; i < areas.length; i++) { const a = areas[i]; if (!a.dead && r >= a.r1 && r <= a.r2) out(a.f); }
    const wide = s.wide;
    for (let i = 0; i < wide.length; i++) { const a = wide[i]; if (!a.dead && r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2) out(a.f); }
  }

  _rebuild() {
    let count = 0;
    this.rangeRefs = 0;
    for (const s of this.sheets) {
      s.fx = new Map();
      s.points = new Map();
      s.areas = Array.from({ length: s.cols }, () => []);
      s.wide = [];
      s.dead = 0;
      s.live = 0;
      s.fcols = Array.from({ length: s.cols }, () => []);
    }
    const all = [];
    for (const s of this.sheets) {
      for (const [k, src] of s.fsrc) {
        const r = Math.floor(k / ROWK), c = k % ROWK;
        if (count >= this.limits.formulas) { s.vals[r][c] = E['#BUSY!']; continue; }
        count++;
        const f = this._compile(s, r, c, src);
        s.fx.set(k, f);
        s.fcols[c].push(r);
        all.push(f);
      }
      s.fcols.forEach((list) => list.sort((x, y) => x - y));
    }
    for (const f of all) this._link(f);
    // Kinds that hang on other formulas' kinds: one more pass settles chains.
    for (const f of all) if (!f.kind && f.ast) this._relinkKind(f);
    this.stats.full = true;
    this._evaluate(all);
    return all.map((f) => ({ sheet: f.sheet.name, r: f.r, c: f.c }));
  }
  _relinkKind(f) {
    f.kind = kindOf(f.ast, (ref) => {
      if (ref.kind !== 'cell') return null;
      const s = ref.sheet != null ? this.sheet(ref.sheet) : f.sheet;
      if (s && s.types && s.types[ref.a.c] === 'date') return 'date';
      const g = s && s.fx.get(keyOf(ref.a.r, ref.a.c));
      return g && g !== f ? g.kind : null;
    });
  }

  // The formulas that depend on the changed cells of `sheet`, and theirs,
  // and so on: recomputed.
  _recompute(sheet, changedKeys) {
    const dirty = new Set();
    const queue = [];
    const add = (g) => { if (!dirty.has(g)) { dirty.add(g); queue.push(g); } };
    for (const k of changedKeys) {
      const f = sheet.fx.get(k);
      if (f) add(f);
      this._readers(sheet, Math.floor(k / ROWK), k % ROWK, k, add);
    }
    for (let q = 0; q < queue.length; q++) {
      const f = queue[q];
      this._readers(f.sheet, f.r, f.c, keyOf(f.r, f.c), add);
    }
    this.stats.full = false;
    this._evaluate(queue);
    return queue.map((f) => ({ sheet: f.sheet.name, r: f.r, c: f.c }));
  }

  _evaluate(list) {
    const t0 = Date.now();
    const deadline = t0 + this.limits.timeMs;
    let work = 0;
    const maxWork = this.limits.work;
    const self = this;
    let busy = false;
    for (const f of list) { f.state = 0; f.cyc = false; f.frame = -1; f.sheet.vals[f.r][f.c] = PENDING; }
    // The clock is read every 4096 units of work, whatever size the steps.
    let nextCheck = 4096;
    const tick = (n) => {
      work += n || 1;
      if (work > maxWork) throw new Budget();
      if (work >= nextCheck) { nextCheck = work + 4096; if (Date.now() > deadline) throw new Budget(); }
    };
    const prevCharge = charge;
    charge = tick;
    const cell = (s, r, c) => {
      if (r < 0 || c < 0 || r >= s.rows || c >= s.cols) return null;
      const v = s.vals[r][c];
      return v === PENDING ? E['#CYCLE!'] : v;
    };
    const cx = {
      wb: this,
      memo: new Map(),
      now: this.now,
      tick,
      cell,
      eachCell(a, fn) {
        const s = a.sheet;
        const r2 = Math.min(a.r2, s.rows - 1), c2 = Math.min(a.c2, s.cols - 1);
        for (let r = a.r1; r <= r2; r++) {
          const row = s.vals[r];
          tick(c2 - a.c1 + 1);
          for (let c = a.c1; c <= c2; c++) {
            let v = row[c];
            if (v === PENDING) v = E['#CYCLE!'];
            if (fn(v === undefined ? null : v) === false) return false;
          }
        }
        return true;
      },
      host: null,
      ev: null,
      sc: null,
    };
    cx.ev = (node) => evalNode(node, cx);
    cx.sc = (node) => scalar(evalNode(node, cx), cx);
    // Precedent formulas not yet computed, for the depth-first walk.
    const pendingPrec = (f) => {
      const out = [];
      for (const p of f.prec) {
        const s = p.s;
        const c2 = Math.min(p.c2, s.cols - 1), r2 = Math.min(p.r2, s.rows - 1);
        for (let c = p.c1; c <= c2; c++) {
          const rows = s.fcols[c];
          tick();
          if (!rows || !rows.length) continue;
          let lo = lowerBound(rows, p.r1);
          for (; lo < rows.length && rows[lo] <= r2; lo++) {
            tick();
            const g = s.fx.get(keyOf(rows[lo], c));
            if (g && g.state !== 2) out.push(g);
          }
        }
      }
      return out;
    };
    const finish = (f, v) => {
      f.state = 2;
      f.sheet.vals[f.r][f.c] = v;
      self.stats.evaluated++;
    };
    const compute = (f) => {
      if (f.err) return f.err;
      if (f.cyc) return E['#CYCLE!'];
      cx.host = f;
      let v;
      try { v = scalar(evalNode(f.ast, cx), cx); } catch (e) { if (e instanceof Budget) throw e; v = E['#ERROR!']; }
      if (v === undefined) v = null;
      if (typeof v === 'number' && !Number.isFinite(v)) v = E['#NUM!'];
      if (typeof v === 'string' && v.length > this.limits.textChars) v = E['#VALUE!'];
      return v;
    };
    this.stats.evaluated = 0;
    try {
      for (const root of list) {
        if (root.state === 2) continue;
        const stack = [{ f: root, deps: null, i: 0 }];
        root.state = 1; root.frame = 0;
        while (stack.length) {
          const top = stack[stack.length - 1];
          if (!top.deps) top.deps = pendingPrec(top.f);
          let pushed = false;
          while (top.i < top.deps.length) {
            const g = top.deps[top.i++];
            if (g.state === 2) continue;
            if (g.state === 1) { for (let k = g.frame; k < stack.length; k++) stack[k].f.cyc = true; continue; }
            g.state = 1; g.frame = stack.length;
            stack.push({ f: g, deps: null, i: 0 });
            pushed = true;
            break;
          }
          if (pushed) continue;
          stack.pop();
          tick();
          finish(top.f, compute(top.f));
        }
      }
    } catch (e) {
      busy = true;
      // Over budget (or, never expected, anything else): what is left is
      // #BUSY!, and the engine stays usable.
      for (const f of list) if (f.state !== 2) finish(f, e instanceof Budget ? E['#BUSY!'] : E['#ERROR!']);
    } finally {
      charge = prevCharge;
    }
    this.stats.busy = busy;
    this.stats.ms = Date.now() - t0;
    this.stats.formulas = this.sheets.reduce((n, s) => n + s.fx.size, 0);
  }

  // The value of a cell (computed for a formula), or null.
  value(name, r, c) {
    const s = this.sheet(name);
    if (!s || r < 0 || c < 0 || r >= s.rows || c >= s.cols) return null;
    const v = s.vals[r][c];
    return v === PENDING ? E['#BUSY!'] : v;
  }
  formula(name, r, c) {
    const s = this.sheet(name);
    const f = s && s.fx.get(keyOf(r, c));
    return f ? f.src : null;
  }
  // A formula cell's value as the cell shows it; null for a cell without one.
  display(name, r, c) {
    const s = this.sheet(name);
    const f = s && s.fx.get(keyOf(r, c));
    if (!f) return null;
    return displayValue(this.value(name, r, c), f.kind || (s.types[c] === 'date' ? 'date' : null));
  }
  // [{ r, c, src }] of a sheet's formula cells.
  formulas(name) {
    const s = this.sheet(name);
    if (!s) return [];
    return Array.from(s.fx.values(), (f) => ({ r: f.r, c: f.c, src: f.src }));
  }
}

export function displayValue(v, kind) {
  if (v === null || v === undefined) return '';
  if (isErr(v)) return v.code;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (kind === 'date' && v >= 0 && v < 2958466) return formatSerial(v, v !== Math.floor(v));
    if (kind === 'datetime' && v >= 0 && v < 2958466) return formatSerial(v, true);
    return formatNumber(v);
  }
  return String(v);
}

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
function insertSorted(arr, x) { const i = lowerBound(arr, x); if (arr[i] !== x) arr.splice(i, 0, x); }
function removeSorted(arr, x) { const i = lowerBound(arr, x); if (arr[i] === x) arr.splice(i, 1); }

function scalar(v, cx) {
  if (v instanceof Area) {
    if (v.r1 === v.r2 && v.c1 === v.c2) return cx.cell(v.sheet, v.r1, v.c1);
    return E['#VALUE!'];
  }
  return v;
}

function evalNode(node, cx) {
  switch (node.t) {
    case 'n': case 's': case 'b': return node.v;
    case 'e': return node.v;
    case 'missing': return null;
    case 'name': return E['#NAME?'];
    case 'ref': {
      const ref = node.ref;
      const s = ref.sheet != null ? cx.wb.sheet(ref.sheet) : cx.host.sheet;
      if (!s) return E['#REF!'];
      if (ref.kind === 'cell') return cx.cell(s, ref.a.r, ref.a.c);
      let r1, r2, c1, c2;
      if (ref.kind === 'area') { r1 = Math.min(ref.a.r, ref.b.r); r2 = Math.max(ref.a.r, ref.b.r); c1 = Math.min(ref.a.c, ref.b.c); c2 = Math.max(ref.a.c, ref.b.c); }
      else if (ref.kind === 'cols') { r1 = 0; r2 = Math.max(0, s.rows - 1); c1 = Math.min(ref.a.c, ref.b.c); c2 = Math.max(ref.a.c, ref.b.c); }
      else { c1 = 0; c2 = Math.max(0, s.cols - 1); r1 = Math.min(ref.a.r, ref.b.r); r2 = Math.max(ref.a.r, ref.b.r); }
      return new Area(s, r1, c1, r2, c2);
    }
    case 'neg': {
      const v = scalar(evalNode(node.a, cx), cx);
      if (isErr(v)) return v;
      const n = toNum(v);
      return isErr(n) ? n : -n;
    }
    case 'pct': {
      const v = scalar(evalNode(node.a, cx), cx);
      if (isErr(v)) return v;
      const n = toNum(v);
      return isErr(n) ? n : n / 100;
    }
    case 'bin': {
      const a = scalar(evalNode(node.a, cx), cx);
      const b = scalar(evalNode(node.b, cx), cx);
      if (isErr(a)) return a;
      if (isErr(b)) return b;
      const op = node.op;
      if (op === '&') return checkText(toText(a) + toText(b));
      if (op === '=' ) return compare(a, b) === 0;
      if (op === '<>') return compare(a, b) !== 0;
      if (op === '<') return compare(a, b) < 0;
      if (op === '>') return compare(a, b) > 0;
      if (op === '<=') return compare(a, b) <= 0;
      if (op === '>=') return compare(a, b) >= 0;
      const x = toNum(a), y = toNum(b);
      if (isErr(x)) return x;
      if (isErr(y)) return y;
      if (op === '+') return checkNum(x + y);
      if (op === '-') return checkNum(x - y);
      if (op === '*') return checkNum(x * y);
      if (op === '/') return y === 0 ? E['#DIV/0!'] : checkNum(x / y);
      if (op === '^') { if (x === 0 && y < 0) return E['#DIV/0!']; return checkNum(Math.pow(x, y)); }
      return E['#VALUE!'];
    }
    case 'f': {
      const fn = FUNCS[node.name];
      if (!fn) return E['#NAME?'];
      if (node.args.length < fn.min || node.args.length > fn.max) return E['#N/A'];
      cx.tick();
      // A function that throws (a bug, an edge it did not foresee) is
      // #ERROR! in its cell, never an exception out of the engine.
      let v;
      try { v = fn.fn(node.args, cx); } catch (e) { if (e instanceof Budget) throw e; return E['#ERROR!']; }
      return v === undefined ? null : v;
    }
    default: return E['#ERROR!'];
  }
}

// One formula on its own, against a lookup of cells (tests, the formula bar
// preview): evaluate('=1+2') → 3.
export function evaluate(formula, { now } = {}) {
  const wb = new Workbook({ now });
  wb.load([{ name: 'Sheet1', rows: 1, cols: 1, cell: () => ({ f: String(formula).startsWith('=') ? formula : '=' + formula }) }]);
  return wb.value('Sheet1', 0, 0);
}
