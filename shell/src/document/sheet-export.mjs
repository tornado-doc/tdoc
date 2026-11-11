// Download a sheet doc as CSV (the tab on screen) or Excel (every tab), from
// the document's own <table data-tdoc-sheet> markup: the same reader the
// viewer uses (shared/sheet-markup.mjs), so a downloaded file holds what the
// doc holds, not what a search or filter shows right now. No DOM globals: an
// offline test runs this on a small DOM.
import { SHEET_SELECTOR, readSheetTable } from '../../../shared/sheet-markup.mjs';
import { toExcel, unsupportedFunctions, isFormula } from '../../../shared/sheet-formula.mjs';

export const CSV_MIME = 'text/csv';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// [{ name, columns: [{ name, type }], rows: [[text | string[]]], formulas }]
// formulas: [{ r, c, f }] for the cells with a data-formula (the text in
// rows is the value it last showed).
export function sheetsFromDocument(doc) {
  const tables = Array.prototype.filter.call(doc.querySelectorAll(SHEET_SELECTOR), (t) => !(t.closest && t.closest('[data-tdoc-provider]')));
  return tables.map((table, i) => {
    const sheet = readSheetTable(table);
    return {
      name: sheet.name || `Sheet ${i + 1}`,
      columns: sheet.columns.map((c) => ({ name: c.name, type: c.type, width: c.width || 0 })),
      rows: sheet.rows.map((r) => r.cells),
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

export function xlsxBytes(XLSX, sheets) {
  const book = XLSX.utils.book_new();
  const names = workbookNames(sheets);
  // A tab's name as the workbook spells it, for references to it.
  const renamed = new Map(sheets.map((sheet, i) => [String(sheet.name).toLowerCase(), names[i]]));
  sheets.forEach((sheet, i) => {
    const ws = XLSX.utils.aoa_to_sheet(sheetRows(sheet));
    addFormulas(XLSX, ws, sheet, renamed);
    // A column's saved width goes with it (Excel's own unit, from px).
    if (sheet.columns.some((c) => c.width)) ws['!cols'] = sheet.columns.map((c) => (c.width ? { wpx: c.width } : {}));
    XLSX.utils.book_append_sheet(book, ws, names[i]);
  });
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx', compression: true }));
}

// Formulas go into the workbook as formulas (Excel's row 1 is the header,
// so every row moves down one), beside the value they last showed. Only
// formulas the engine itself computes: anything else stays a value, so an
// export never carries a function the sheet could not run (no WEBSERVICE,
// no external links).
export function addFormulas(XLSX, ws, sheet, renamed) {
  for (const { r, c, f } of sheet.formulas || []) {
    if (!isFormula(f)) continue;
    const missing = unsupportedFunctions(f);
    if (!missing || missing.length) continue;
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
