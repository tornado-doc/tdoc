// Sheets: the markup half. A sheet is ordinary tdoc HTML, one table per tab:
//
//   <table data-tdoc-sheet data-name="Tab 1">
//     <thead><tr><th data-type="text">Name</th><th data-type="tags" data-palette="urgent:red">Labels</th>…</tr></thead>
//     <tbody><tr data-row="r1"><td>Alice</td><td><span data-tag>urgent</span> <span data-tag>q3</span></td>…</tr></tbody>
//   </table>
//
// Without JavaScript that is a readable table, and versions, diff, export and
// agent edits all see plain HTML. This file writes that markup (import, CLI),
// reads it back from a DOM (the viewer), and writes one cell (the editor). It
// inlines into the frame viewer like sheet-query.mjs, so: no imports here.
//
// A cell's comment anchors to its row and its column by id, not position:
// the `data-row` id on each body row (sorting and filtering are view state
// and never move a row in the document; inserting or deleting rows leaves
// the other ids alone) and the `data-key` on each header (kept through
// rename and type changes; inserting or deleting a column leaves the other
// keys alone). Markup without keys falls back to the column's position.

export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Only links a reader can follow safely.
export function safeHref(text) {
  const s = String(text || '').trim();
  if (/^https?:\/\//i.test(s) || /^mailto:[^\s]+$/i.test(s)) return s;
  if (/^www\.\S+$/i.test(s)) return 'https://' + s;
  return '';
}

const CHECK = '✓';
function checkboxOn(text) {
  return /^(✓|✔|☑|✅|x|true|yes|y|1|done|on)$/i.test(String(text == null ? '' : text).trim());
}

// ---- writing markup (strings) ----------------------------------------------

export function cellHtml(type, raw) {
  if (type === 'tags') {
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,;|\n]/).map((t) => t.trim()).filter(Boolean);
    return list.map((t) => `<span data-tag>${escapeHtml(t)}</span>`).join(' ');
  }
  if (type === 'checkbox') return checkboxOn(raw) ? CHECK : '';
  const text = raw == null ? '' : String(raw);
  if (type === 'url') {
    const href = safeHref(text);
    if (href) return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  }
  return escapeHtml(text);
}

// One <table data-tdoc-sheet>. sheet = { name, columns:[{name,type,palette?}], rows:[{id?, cells:[raw]}] }
export function tableHtml(sheet, { caption = false } = {}) {
  const cols = sheet.columns || [];
  const head = cols.map((col, i) => {
    const pal = col.palette ? ` data-palette="${escapeHtml(col.palette)}"` : '';
    return `<th data-key="${escapeHtml(col.key || `c${i + 1}`)}" data-type="${escapeHtml(col.type || 'text')}"${pal}>${escapeHtml(col.name)}</th>`;
  }).join('');
  const body = (sheet.rows || []).map((row, i) => {
    const id = row.id || `r${i + 1}`;
    const cells = cols.map((col, c) => `<td>${cellHtml(col.type, row.cells[c])}</td>`).join('');
    return `<tr data-row="${escapeHtml(id)}">${cells}</tr>`;
  }).join('\n');
  const name = sheet.name || 'Sheet 1';
  const cap = caption ? `<caption>${escapeHtml(name)}</caption>\n` : '';
  return `<table data-tdoc-sheet data-name="${escapeHtml(name)}">\n${cap}<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

// What a sheet looks like where no viewer runs (an export, a feed reader, a
// doc opened from disk): tags as pills, hairline rules, a header that stays.
export const SHEET_FALLBACK_CSS = `table[data-tdoc-sheet]{border-collapse:collapse;font-size:14px;margin:0 0 2rem}
table[data-tdoc-sheet] caption{text-align:left;font-weight:600;padding:0 0 .5rem}
table[data-tdoc-sheet] th,table[data-tdoc-sheet] td{border-bottom:1px solid #e4e4e9;padding:.35rem .6rem;text-align:left;vertical-align:top}
table[data-tdoc-sheet] th{position:sticky;top:0;background:#fafafb;font-weight:600;white-space:nowrap}
table[data-tdoc-sheet] [data-tag]{display:inline-block;margin:0 .25rem .15rem 0;padding:0 .5rem;border-radius:999px;background:#eef0f3;font-size:.85em;line-height:1.6}`;

// A whole document: the page the importer creates and the CLI writes. With
// more than one tab each table carries its name as a <caption>, so the plain
// page still says where one table ends and the next begins; the viewer hides
// it with the table and shows the tab strip instead.
export function sheetDocumentHtml({ title, sheets, note }) {
  const t = String(title || 'Untitled sheet');
  const parts = (sheets || []).map((sheet, i) => (
    `<div class="tdoc-table-scroll">\n${tableHtml({ ...sheet, name: sheet.name || `Sheet ${i + 1}` }, { caption: sheets.length > 1 })}\n</div>`
  ));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t)}</title>
<style>
  body { margin: 0; background: #fff; color: #17171a;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 72rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
  h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 .5rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.2rem; margin: 2rem 0 .75rem; }
  .sheet-note { color: #55555f; margin: 0 0 1.5rem; }
  ${SHEET_FALLBACK_CSS.split('\n').join('\n  ')}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(t)}</h1>
${note ? `<p class="sheet-note">${escapeHtml(note)}</p>\n` : ''}${parts.join('\n')}
</main>
</body>
</html>
`;
}

// ---- delimited text (import, and a range pasted from Excel or Sheets) ----------

// The delimiter a text file uses: whichever of tab, comma or semicolon splits
// its first lines into the most consistent number of fields.
export function detectDelimiter(text) {
  const lines = String(text).split(/\r\n|\n|\r/, 20).filter((l) => l.trim());
  let best = ',', score = -1;
  for (const d of ['\t', ',', ';']) {
    const counts = lines.map((l) => splitQuotedLine(l, d).length);
    if (!counts.length || counts[0] < 2) continue;
    const same = counts.filter((n) => n === counts[0]).length;
    const s = same * 100 + counts[0];
    if (s > score) { score = s; best = d; }
  }
  return best;
}
function splitQuotedLine(line, d) {
  return parseDelimited(line, d, { maxRows: 1 })[0] || [];
}

// RFC 4180 with the usual leniency: quoted fields may hold the delimiter,
// doubled quotes and newlines; CRLF, LF or CR end a row; a stray quote inside
// an unquoted field is kept as text. A BOM is dropped.
export function parseDelimited(text, delimiter, { maxRows = Infinity } = {}) {
  const s = String(text || '').replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(s);
  const rows = [];
  let row = [], field = '', i = 0, quoted = false, fieldStart = true;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && fieldStart) { quoted = true; fieldStart = false; i++; continue; }
    if (ch === d) { row.push(field); field = ''; fieldStart = true; i++; continue; }
    if (ch === '\n' || ch === '\r') {
      row.push(field); rows.push(row); row = []; field = ''; fieldStart = true;
      if (ch === '\r' && s[i + 1] === '\n') i++;
      i++;
      if (rows.length >= maxRows) return rows;
      continue;
    }
    field += ch; fieldStart = false; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "New sheet": one tab, a few typed columns, a few empty rows, so the grid
// opens ready to type into and shows what each column type looks like.
export function blankSheetHtml(title = 'Untitled sheet') {
  return sheetDocumentHtml({
    title,
    sheets: [{
      name: 'Sheet 1',
      columns: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'tags', palette: 'Done:green, In progress:blue, Blocked:red, To do:gray' },
        { name: 'Due', type: 'date' },
        { name: 'Amount', type: 'number' },
        { name: 'Done', type: 'checkbox' },
      ],
      rows: Array.from({ length: 5 }, () => ({ cells: ['', [], '', '', ''] })),
    }],
  });
}

// ---- reading markup (DOM) ----------------------------------------------------

export const SHEET_SELECTOR = 'table[data-tdoc-sheet]';

function ownRows(table, section) {
  const out = [];
  const groups = section === 'head'
    ? (table.tHead ? [table.tHead] : [])
    : Array.prototype.filter.call(table.tBodies || [], () => true);
  groups.forEach((g) => Array.prototype.forEach.call(g.rows, (tr) => out.push(tr)));
  return out;
}

function cellText(el) {
  return String(el.textContent || '').replace(/\s+/g, ' ').trim();
}

// The header row: the last row of <thead>, else a first body row made of <th>.
export function headerCells(table) {
  const head = ownRows(table, 'head');
  if (head.length) return Array.prototype.slice.call(head[head.length - 1].cells);
  const first = ownRows(table, 'body')[0];
  if (first && first.cells.length && Array.prototype.every.call(first.cells, (c) => c.tagName === 'TH')) return Array.prototype.slice.call(first.cells);
  return [];
}

export function readCell(td, type) {
  if (!td) return type === 'tags' ? [] : '';
  if (type === 'tags') {
    // Tags are usually the cell's own children; a selector query per cell is
    // the slow path on a 10,000-row sheet, so it is only the fallback.
    const own = [];
    for (let el = td.firstElementChild; el; el = el.nextElementSibling) if (el.hasAttribute('data-tag')) own.push(el);
    const spans = own.length ? own : td.querySelectorAll('[data-tag]');
    if (spans.length) return Array.prototype.map.call(spans, cellText).filter(Boolean);
    return cellText(td).split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
  }
  if (type === 'checkbox') return checkboxOn(cellText(td)) ? CHECK : '';
  return cellText(td);
}

// { name, columns:[{name,type,palette,th}], rows:[{id, tr, tds, cells}] }
// tds[c] is the source cell (or null where the row is short): the element a
// cell comment anchors to and the one an edit writes into.
export function readSheetTable(table, normalize) {
  const ths = headerCells(table);
  const norm = typeof normalize === 'function' ? normalize : (t) => String(t || 'text').toLowerCase();
  const columns = ths.map((th, i) => ({
    key: th.getAttribute('data-key') || '',
    name: cellText(th) || `Column ${i + 1}`,
    type: norm(th.getAttribute('data-type')),
    palette: th.getAttribute('data-palette') || '',
    th,
  }));
  const headRow = ths.length ? ths[0].parentElement : null;
  const rows = [];
  ownRows(table, 'body').forEach((tr) => {
    if (tr === headRow) return;
    const tds = [];
    const cells = [];
    for (let c = 0; c < columns.length; c++) {
      const td = tr.cells[c] || null;
      tds.push(td);
      cells.push(readCell(td, columns[c].type));
    }
    rows.push({ id: tr.getAttribute('data-row') || '', tr, tds, cells });
  });
  return { name: table.getAttribute('data-name') || '', columns, rows, table };
}

// ---- writing one cell (DOM) ------------------------------------------------

// Replace a cell's contents with `value` in the markup of its column type.
// Built from nodes, never from an HTML string, so a value is always text.
export function writeCell(td, type, value) {
  const doc = td.ownerDocument;
  while (td.firstChild) td.removeChild(td.firstChild);
  if (type === 'tags') {
    const list = Array.isArray(value) ? value : String(value || '').split(/[,;|\n]/).map((t) => t.trim()).filter(Boolean);
    list.forEach((tag, i) => {
      if (i) td.appendChild(doc.createTextNode(' '));
      const span = doc.createElement('span');
      span.setAttribute('data-tag', '');
      span.textContent = tag;
      td.appendChild(span);
    });
    return;
  }
  if (type === 'checkbox') { td.textContent = checkboxOn(value) || value === true ? CHECK : ''; return; }
  const text = value == null ? '' : String(value);
  if (type === 'url' && safeHref(text)) {
    const a = doc.createElement('a');
    a.setAttribute('href', safeHref(text));
    a.textContent = text;
    td.appendChild(a);
    return;
  }
  td.textContent = text;
}

// The next unused column key among `keys`: c<max+1>.
export function nextColumnKey(keys) {
  let max = 0;
  (keys || []).forEach((k) => { const m = /^c(\d+)$/.exec(k || ''); if (m) max = Math.max(max, Number(m[1])); });
  return `c${max + 1}`;
}

// The next unused row id in a table: r<max+1>.
export function nextRowId(table) {
  let max = 0;
  Array.prototype.forEach.call(table.querySelectorAll('tr[data-row]'), (tr) => {
    const m = /^r(\d+)$/.exec(tr.getAttribute('data-row') || '');
    if (m) max = Math.max(max, Number(m[1]));
  });
  return `r${max + 1}`;
}
