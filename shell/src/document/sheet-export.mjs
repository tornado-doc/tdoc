// Download a sheet doc as CSV (the tab on screen) or Excel (every tab), from
// the document's own <table data-tdoc-sheet> markup: the same reader the
// viewer uses (shared/sheet-markup.mjs), so a downloaded file holds what the
// doc holds, not what a search or filter shows right now. No DOM globals: an
// offline test runs this on a small DOM.
import { SHEET_SELECTOR, readSheetTable } from '../../../shared/sheet-markup.mjs';
import { KEY, readFormats, excelFormat, isNumeric, isDateLike, toNumber, toDateParts, nonOverlapping } from '../../../shared/sheet-format.mjs';
import { styleXlsx, colName } from '../../../shared/sheet-xlsx-style.mjs';
import { toExcel, unsupportedFunctions, isFormula, referencedSheets } from '../../../shared/sheet-formula.mjs';

export const CSV_MIME = 'text/csv';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// [{ name, columns: [{ name, type }], rows: [[text | string[]]], formats,
// merges, formulas }]: formats is Map(r * KEY + c → cell format) or null,
// merges [{ r, c, rs, cs }] (shared/sheet-format.mjs), formulas [{ r, c, f }]
// for the cells with a data-formula (the text in rows is the value it last
// showed). CSV writes values as the document holds them; Excel keeps number
// formats, styles, merges and formulas.
export function sheetsFromDocument(doc) {
  const tables = Array.prototype.filter.call(doc.querySelectorAll(SHEET_SELECTOR), (t) => !(t.closest && t.closest('[data-tdoc-provider]')));
  // Names as the viewer shows them: unique without regard to case (a second
  // "data" is "data (2)"), so a formula naming "data (2)" finds that tab.
  const seen = new Set();
  const unique = (name) => {
    let out = name, n = 1;
    while (seen.has(out.toLowerCase())) out = `${name} (${++n})`;
    seen.add(out.toLowerCase());
    return out;
  };
  return tables.map((table, i) => {
    const sheet = readSheetTable(table);
    return {
      name: unique(String(sheet.name || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 100) || `Sheet ${i + 1}`),
      columns: sheet.columns.map((c) => ({ name: c.name, type: c.type, width: c.width || 0 })),
      rows: sheet.rows.map((r) => r.cells),
      formats: readFormats(sheet, table),
      merges: sheet.merges || [],
      formulas: sheet.rows.flatMap((row, r) => row.tds.map((td, c) => {
        const f = td && td.getAttribute && td.getAttribute('data-formula');
        return f ? { r, c, f: f.trim()[0] === '=' ? f.trim() : '=' + f.trim() } : null;
      }).filter(Boolean)),
    };
  });
}

const cellText = (v) => (Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v));

// A value Excel or Sheets would run as a formula when it opens a CSV.
// Fullwidth ＝＋－＠ too: some spreadsheet apps read them as the ASCII ones.
const FORMULA = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;
const PLAIN_NUMBER = /^-?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?$/;

function csvField(value) {
  let s = cellText(value);
  if (FORMULA.test(s) && !(s.length > 1 && PLAIN_NUMBER.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// RFC 4180, CRLF rows, with a byte-order mark so Excel reads UTF-8.
export function sheetCsv(sheet) {
  const lines = [sheet.columns.map((c) => csvField(c.name)).join(',')];
  for (const row of sheet.rows) lines.push(sheet.columns.map((_, c) => csvField(row[c])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// Rows for a workbook: numbers and checkboxes as values, the rest as text
// (a text cell is never read as a formula).
export function sheetRows(sheet) {
  const head = sheet.columns.map((c) => c.name);
  const body = sheet.rows.map((row) => sheet.columns.map((col, c) => {
    const s = cellText(row[c]).trim();
    if (col.type === 'number' && s && PLAIN_NUMBER.test(s)) {
      const n = Number(s.replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
    if (col.type === 'checkbox') return s !== '';
    return cellText(row[c]);
  }));
  return [head, ...body];
}

// Excel's sheet-name rules: 31 characters, none of []:*?/\, unique.
export function workbookNames(sheets) {
  const seen = new Set();
  return sheets.map((sheet, i) => {
    let base = String(sheet.name || `Sheet ${i + 1}`).replace(/\[/g, '(').replace(/\]/g, ')').replace(/[:*?/\\]/g, ' ')
      .replace(/\s+/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Sheet ${i + 1}`;
    let name = base;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

// Days since Excel's epoch (1899-12-30) for an ISO date or date-time.
function excelSerial(text) {
  const p = toDateParts(text);
  if (!p) return null;
  if (p.timeOnly) return (p.h * 3600 + p.mi * 60 + p.s) / 86400;
  const days = (Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(1899, 11, 30)) / 86400000;
  return days + (p.h * 3600 + p.mi * 60 + p.s) / 86400;
}

// A cell's number format as Excel's: the value as a number (a date as its
// serial) with the format's code, where the value reads as one.
function formatCell(ws, ref, value, f) {
  const n = f && f.num;
  if (!n || n.kind === 'text') return;
  const text = Array.isArray(value) ? '' : String(value == null ? '' : value);
  let v = null;
  if (isNumeric(n)) v = toNumber(text);
  else if (isDateLike(n)) v = excelSerial(text);
  if (v == null) return;
  ws[ref] = { t: 'n', v, z: excelFormat(n) };
}

export function xlsxBytes(XLSX, sheets) {
  const book = XLSX.utils.book_new();
  const names = workbookNames(sheets);
  const styled = [];
  // A tab's name as the workbook spells it, for references to it.
  const renamed = new Map(sheets.map((sheet, i) => [String(sheet.name).toLowerCase(), names[i]]));
  sheets.forEach((sheet, i) => {
    const ws = XLSX.utils.aoa_to_sheet(sheetRows(sheet));
    // A column's saved width goes with it (Excel's own unit, from px).
    if (sheet.columns.some((c) => c.width)) ws['!cols'] = sheet.columns.map((c) => (c.width ? { wpx: c.width } : {}));
    // Number formats on the cells (body rows start at Excel row 2), the
    // rest of each format for styleXlsx below, and merged ranges.
    const cells = new Map();
    if (sheet.formats) sheet.formats.forEach((f, key) => {
      const r = Math.floor(key / KEY), c = key % KEY;
      if (r >= sheet.rows.length || c >= sheet.columns.length) return;
      const ref = `${colName(c)}${r + 2}`;
      formatCell(ws, ref, sheet.rows[r][c], f);
      // A styled empty cell is written, so its fill and borders show.
      if (!ws[ref]) ws[ref] = { t: 's', v: '' };
      cells.set(ref, f);
    });
    // Never two merges over one cell (Excel calls such a file corrupt).
    const merges = nonOverlapping((sheet.merges || []).filter((m) => m.r + m.rs <= sheet.rows.length && m.c + m.cs <= sheet.columns.length));
    if (merges.length) ws['!merges'] = merges.map((m) => ({ s: { r: m.r + 1, c: m.c }, e: { r: m.r + m.rs, c: m.c + m.cs - 1 } }));
    // After the number formats (formatCell replaces a cell): the formula
    // goes onto the cell as written, its format kept.
    addFormulas(XLSX, ws, sheet, renamed);
    styled.push({ cells });
    XLSX.utils.book_append_sheet(book, ws, names[i]);
  });
  const bytes = new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true }));
  // Bold, italic, strikethrough, colours, fills, borders and alignment:
  // SheetJS's community build does not write them; styleXlsx does.
  try { return styleXlsx(XLSX, bytes, styled); } catch { return bytes; }
}

// Formulas go into the workbook as formulas (Excel's row 1 is the header,
// so every row moves down one), beside the value they last showed. Only
// formulas the engine itself computes: anything else stays a value, so an
// export never carries a function the sheet could not run (no WEBSERVICE)
// nor a reference outside the workbook.
export function addFormulas(XLSX, ws, sheet, renamed) {
  for (const { r, c, f } of sheet.formulas || []) {
    if (!isFormula(f)) continue;
    const missing = unsupportedFunctions(f);
    if (!missing || missing.length) continue;
    // Only references to tabs of this workbook.
    const used = referencedSheets(f) || [];
    if (used.some((n) => !renamed.has(String(n).toLowerCase()))) continue;
    const addr = XLSX.utils.encode_cell({ r: r + 1, c });
    const cell = ws[addr] || (ws[addr] = { t: 's', v: '' });
    cell.f = toExcel(f, { names: renamed });
  }
}

// The tab on screen: its name from the view in the page's #hash (the
// viewer's encodeView `a`), else the first.
export function activeSheet(sheets, activeName) {
  return sheets.find((s) => s.name === activeName) || sheets[0] || null;
}

// A file name from the doc slug plus, for one tab of several, the tab.
export function sheetFileName(slug, sheet, sheets, ext) {
  const tab = sheets.length > 1 && sheet ? `-${String(sheet.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : '';
  return `${slug}${tab && tab !== '-' ? tab : ''}.${ext}`;
}
