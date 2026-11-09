// Sheets: import. A .csv, .tsv or .xlsx file becomes a sheet document (one
// tab per worksheet). The shell runs this in the browser (new-doc flow and a
// file dropped on My docs) and bin/tdoc-new runs it for --from-csv and
// --from-xlsx, so the two produce the same markup.
//
// SheetJS parses .xlsx. It is passed in (`loadXlsx`), never imported here:
// the browser lazy-loads it only when an .xlsx is chosen, and the CLI
// requires it from node_modules.

import { inferType } from './sheet-query.mjs';
import { sheetDocumentHtml, parseDelimited, detectDelimiter } from './sheet-markup.mjs';

export { parseDelimited, detectDelimiter };

// Sized for a browser tab and a doc people open on phones: the viewer is
// tested at 10k rows × 20 columns, these leave headroom above that.
export const LIMITS = Object.freeze({
  bytes: 15 * 1024 * 1024,
  cells: 600_000,
  rows: 50_000,
  columns: 200,
  sheets: 20,
  cellChars: 10_000,
  // A doc is at most 2 MB of HTML (the save and publish limit, both hosts).
  // That is the cap that usually binds: about 5,000-8,000 rows of 20 short
  // columns.
  htmlBytes: 2 * 1024 * 1024,
});

export class SheetImportError extends Error {
  constructor(message, code) { super(message); this.name = 'SheetImportError'; this.code = code || 'import_failed'; }
}

const MB = (n) => `${Math.round(n / 1024 / 1024)} MB`;

export function fileKind(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (ext === 'csv') return 'csv';
  if (ext === 'tsv' || ext === 'tab') return 'tsv';
  if (ext === 'txt') return 'text';
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (ext === 'xls' || ext === 'ods' || ext === 'numbers') return 'unsupported';
  return '';
}

export function isSheetFile(name) {
  const kind = fileKind(name);
  return kind === 'csv' || kind === 'tsv' || kind === 'xlsx';
}

// ---- grid → sheet -------------------------------------------------------------

function trimGrid(grid) {
  // Drop fully empty trailing rows and columns (spreadsheets export them).
  let rows = grid.filter((r) => Array.isArray(r));
  while (rows.length && rows[rows.length - 1].every((v) => String(v == null ? '' : v).trim() === '')) rows.pop();
  let width = 0;
  rows.forEach((r) => { for (let c = r.length - 1; c >= 0; c--) if (String(r[c] == null ? '' : r[c]).trim() !== '') { width = Math.max(width, c + 1); break; } });
  return { rows, width };
}

// A 2D array (first row = headers) into { name, columns, rows } with inferred
// types. Blank or duplicate headers get a name; ragged rows are padded.
export function sheetFromGrid(name, grid, { warnings = [] } = {}) {
  const { rows, width } = trimGrid(grid);
  if (!rows.length || !width) return null;
  if (width > LIMITS.columns) throw new SheetImportError(`"${name}" has ${width} columns. A sheet can have up to ${LIMITS.columns}.`, 'too_many_columns');
  const header = rows[0];
  const body = rows.slice(1);
  if (body.length > LIMITS.rows) throw new SheetImportError(`"${name}" has ${body.length.toLocaleString('en-US')} rows. A sheet can have up to ${LIMITS.rows.toLocaleString('en-US')}.`, 'too_many_rows');
  const seen = new Map();
  const names = [];
  for (let c = 0; c < width; c++) {
    let h = String(header[c] == null ? '' : header[c]).replace(/\s+/g, ' ').trim() || `Column ${c + 1}`;
    const k = h.toLowerCase();
    if (seen.has(k)) { const n = seen.get(k) + 1; seen.set(k, n); h = `${h} (${n})`; } else seen.set(k, 1);
    names.push(h);
  }
  let clipped = 0;
  const data = body.map((r) => {
    const cells = new Array(width);
    for (let c = 0; c < width; c++) {
      let v = r[c] == null ? '' : String(r[c]);
      if (v.length > LIMITS.cellChars) { v = v.slice(0, LIMITS.cellChars); clipped++; }
      cells[c] = v;
    }
    return cells;
  });
  if (clipped) warnings.push(`${clipped} long cell${clipped === 1 ? ' was' : 's were'} cut to ${LIMITS.cellChars.toLocaleString('en-US')} characters.`);
  const columns = names.map((n, c) => {
    const type = inferType(data.map((r) => r[c]), n);
    return { name: n, type };
  });
  return {
    name: String(name || 'Sheet 1').slice(0, 100),
    columns,
    rows: data.map((cells, i) => ({
      id: `r${i + 1}`,
      cells: cells.map((v, c) => normalizeForType(columns[c].type, v)),
    })),
  };
}

// Dates a spreadsheet exported as "1/31/2026" are written as ISO so the
// markup sorts and reads the same everywhere; everything else stays as typed.
function normalizeForType(type, v) {
  const s = String(v).trim();
  if (type === 'date') {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) {
      let a = +m[1], b = +m[2];
      if (a > 12 && b <= 12) [a, b] = [b, a];
      return `${m[3]}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
    }
  }
  if (type === 'tags') return s.split(/[,;|\n]/).map((t) => t.trim()).filter(Boolean);
  return s;
}

function checkTotals(sheets) {
  const cells = sheets.reduce((n, s) => n + s.columns.length * (s.rows.length + 1), 0);
  if (cells > LIMITS.cells) {
    throw new SheetImportError(`This file has about ${cells.toLocaleString('en-US')} cells. An imported sheet can have up to ${LIMITS.cells.toLocaleString('en-US')}; split it or remove columns you do not need.`, 'too_many_cells');
  }
}

// ---- workbooks ----------------------------------------------------------------

// SheetJS workbook → sheets. Each worksheet is read as formatted text (what
// the spreadsheet shows), except dates, which come out ISO.
export function sheetsFromWorkbook(XLSX, wb, { warnings = [] } = {}) {
  const names = (wb.SheetNames || []).slice();
  if (names.length > LIMITS.sheets) {
    warnings.push(`Only the first ${LIMITS.sheets} of ${names.length} worksheets were imported.`);
    names.length = LIMITS.sheets;
  }
  const sheets = [];
  for (const name of names) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rowsN = range.e.r - range.s.r + 1, colsN = range.e.c - range.s.c + 1;
    if (rowsN * colsN > LIMITS.cells * 4) throw new SheetImportError(`"${name}" is too large to import (${rowsN.toLocaleString('en-US')} rows × ${colsN} columns).`, 'too_many_cells');
    isoDates(XLSX, ws);
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
    const sheet = sheetFromGrid(name, grid, { warnings });
    if (sheet) sheets.push(sheet);
  }
  return sheets;
}

// A date cell is a serial number with a date format. Write its text as ISO
// from the serial itself (no Date object, so no time zone can shift a day),
// keeping the time when the format shows one.
function isoDates(XLSX, ws) {
  const SSF = XLSX.SSF;
  const pad = (n) => String(n).padStart(2, '0');
  for (const key of Object.keys(ws)) {
    if (key[0] === '!') continue;
    const cell = ws[key];
    if (!cell || cell.t !== 'n' || !cell.z || !SSF.is_date(cell.z)) continue;
    const d = SSF.parse_date_code(cell.v);
    if (!d) continue;
    const day = `${d.y}-${pad(d.m)}-${pad(d.d)}`;
    cell.w = (d.H || d.M) && /h|s/i.test(String(cell.z).replace(/"[^"]*"/g, '')) ? `${day} ${pad(d.H)}:${pad(d.M)}` : day;
  }
}

// ---- one entry point -----------------------------------------------------------

function baseName(name) {
  return String(name || 'Imported sheet').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Imported sheet';
}

// file: { name, size?, text? (csv/tsv), bytes? (Uint8Array|ArrayBuffer, xlsx) }
// → { title, sheets, warnings, html }
export async function importSheetFile(file, { loadXlsx, title, kind: asKind } = {}) {
  // `kind` reads a file as csv/tsv/xlsx whatever its extension (the CLI's
  // --from-csv data.txt).
  const kind = asKind || fileKind(file && file.name);
  if (kind === 'unsupported') throw new SheetImportError('Save the file as .xlsx or .csv first: older .xls, .ods and .numbers files are not supported.', 'unsupported_type');
  if (!kind) throw new SheetImportError('Choose a .csv, .tsv or .xlsx file.', 'unsupported_type');
  const size = Number(file.size || (file.bytes && file.bytes.byteLength) || (file.text && file.text.length) || 0);
  if (size > LIMITS.bytes) throw new SheetImportError(`That file is ${MB(size)}. Sheets import files up to ${MB(LIMITS.bytes)}.`, 'too_large');
  const warnings = [];
  let sheets = [];
  if (kind === 'xlsx') {
    if (typeof loadXlsx !== 'function') throw new SheetImportError('Reading .xlsx files is not available here. Save it as .csv and try again.', 'xlsx_unavailable');
    const XLSX = await loadXlsx();
    let wb;
    try {
      const bytes = file.bytes instanceof ArrayBuffer ? new Uint8Array(file.bytes) : file.bytes;
      wb = XLSX.read(bytes, { type: 'array', cellDates: false, cellNF: true, sheetStubs: false });
    } catch (error) {
      throw new SheetImportError('This file could not be read as an Excel workbook. If it is password-protected, remove the password and try again.', 'unreadable');
    }
    sheets = sheetsFromWorkbook(XLSX, wb, { warnings });
  } else {
    let text = typeof file.text === 'string' ? file.text : null;
    if (text == null && file.bytes) text = new TextDecoder('utf-8').decode(file.bytes);
    if (text == null) throw new SheetImportError('The file could not be read.', 'unreadable');
    if (/\u0000/.test(text.slice(0, 4096))) throw new SheetImportError('This does not look like a text CSV file. If it is an Excel file, use the .xlsx extension.', 'unreadable');
    const delimiter = kind === 'tsv' ? '\t' : kind === 'csv' ? detectDelimiter(text) : undefined;
    const grid = parseDelimited(text, delimiter);
    const sheet = sheetFromGrid(baseName(file.name), grid, { warnings });
    if (sheet) sheets = [sheet];
  }
  if (!sheets.length) throw new SheetImportError('The file has no rows to import.', 'empty');
  checkTotals(sheets);
  const docTitle = String(title || baseName(file.name)).slice(0, 120);
  const rowCount = sheets.reduce((n, s) => n + s.rows.length, 0);
  const note = `Imported from ${String(file.name).replace(/^.*[\\/]/, '')}: ${rowCount.toLocaleString('en-US')} row${rowCount === 1 ? '' : 's'}${sheets.length > 1 ? ` in ${sheets.length} tabs` : ''}.`;
  const html = sheetDocumentHtml({ title: docTitle, sheets, note });
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > LIMITS.htmlBytes) {
    throw new SheetImportError(`As a doc this sheet would be ${(bytes / 1024 / 1024).toFixed(1)} MB, and a doc can be up to ${MB(LIMITS.htmlBytes)}. Remove rows or columns you do not need, or split it into several files.`, 'too_large');
  }
  return { title: docTitle, sheets, warnings, html, bytes };
}
