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
//
// Layout a sheet's editors save with it (readers may change it for
// themselves, in their view only), all optional, all plain attributes:
//
//   <th data-width="180" data-wrap="wrap" data-align="right">   a column's
//     width in CSS px, Wrap text (absent: clip to one line) and alignment
//     (absent: the type's own, numbers right)
//   <tr data-row="r4" data-height="64">                        a row's height
//
// A line break inside a cell is a <br>: it survives any HTML tool, shows
// as a break where no viewer runs, and reads back as "\n".
//
// A cell's own format (bold, colours, number format, borders) and merged
// cells (rowspan / colspan) are shared/sheet-format.mjs's.

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
  return breaksHtml(text);
}

// Text with its line breaks as <br>.
function breaksHtml(text) {
  return String(text).split(/\r\n|\r|\n/).map(escapeHtml).join('<br>');
}

// The layout attributes, cleaned: a width or height is a whole number of px
// in a sane band, wrap is on or off, alignment one of three.
export const MIN_WIDTH = 40;
export const MAX_WIDTH = 1200;
export const MIN_HEIGHT = 24;
export const MAX_HEIGHT = 800;
export function cleanSize(value, min, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, n)) : 0;
}
export function cleanAlign(value) {
  const a = String(value || '').toLowerCase();
  return a === 'left' || a === 'center' || a === 'right' ? a : '';
}
function colAttrs(col) {
  const w = cleanSize(col.width, MIN_WIDTH, MAX_WIDTH);
  const align = cleanAlign(col.align);
  return (w ? ` data-width="${w}"` : '') + (col.wrap ? ' data-wrap="wrap"' : '') + (align ? ` data-align="${align}"` : '');
}

// One <table data-tdoc-sheet>. sheet = { name, columns:[{name,type,palette?}], rows:[{id?, cells:[raw]}] }
export function tableHtml(sheet, { caption = false } = {}) {
  const cols = sheet.columns || [];
  const head = cols.map((col, i) => {
    const pal = col.palette ? ` data-palette="${escapeHtml(col.palette)}"` : '';
    return `<th data-key="${escapeHtml(col.key || `c${i + 1}`)}" data-type="${escapeHtml(col.type || 'text')}"${pal}${colAttrs(col)}>${escapeHtml(col.name)}</th>`;
  }).join('');
  // Merged ranges ({ r, c, rs, cs }) and each cell's attributes as markup
  // (row.attrs[c], from shared/sheet-format.mjs formatAttrString): the
  // writer's (import) to validate; covered cells are left out.
  const covered = new Set(), spans = new Map();
  (sheet.merges || []).forEach((m) => {
    spans.set(m.r * 256 + m.c, m);
    for (let r = m.r; r < m.r + m.rs; r++) for (let c = m.c; c < m.c + m.cs; c++) if (r !== m.r || c !== m.c) covered.add(r * 256 + c);
  });
  const body = (sheet.rows || []).map((row, i) => {
    const id = row.id || `r${i + 1}`;
    const cells = cols.map((col, c) => {
      if (covered.size && covered.has(i * 256 + c)) return '';
      const m = spans.size ? spans.get(i * 256 + c) : null;
      const span = m ? (m.cs > 1 ? ` colspan="${m.cs}"` : '') + (m.rs > 1 ? ` rowspan="${m.rs}"` : '') : '';
      return `<td${(row.attrs && row.attrs[c]) || ''}${span}>${cellHtml(col.type, row.cells[c])}</td>`;
    }).join('');
    const ht = cleanSize(row.height, MIN_HEIGHT, MAX_HEIGHT);
    return `<tr data-row="${escapeHtml(id)}"${ht ? ` data-height="${ht}"` : ''}>${cells}</tr>`;
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

// A cell's text with its <br>s as line breaks; every other run of
// whitespace reads as one space, as the page shows it. Most cells hold a
// single text node or none: that is the fast path on a 10,000-row sheet.
function multilineText(el) {
  const kids = el.childNodes;
  if (!kids || !kids.length || (kids.length === 1 && kids[0].nodeType === 3)) return cellText(el);
  const lines = [''];
  (function walk(node) {
    const list = node.childNodes;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.nodeType === 3) lines[lines.length - 1] += n.data;
      else if (n.nodeType === 1) {
        const tag = String(n.tagName).toUpperCase();
        if (tag === 'BR') lines.push('');
        else if (tag !== 'SCRIPT' && tag !== 'STYLE') walk(n);
      }
    }
  })(el);
  if (lines.length === 1) return cellText(el);
  const out = lines.map((l) => l.replace(/\s+/g, ' ').trim());
  while (out.length && !out[out.length - 1]) out.pop();
  while (out.length && !out[0]) out.shift();
  return out.join('\n');
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
  return type === 'url' ? cellText(td) : multilineText(td);
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
    width: cleanSize(th.getAttribute('data-width'), MIN_WIDTH, MAX_WIDTH),
    wrap: th.getAttribute('data-wrap') === 'wrap',
    align: cleanAlign(th.getAttribute('data-align')),
    th,
  }));
  const headRow = ths.length ? ths[0].parentElement : null;
  const rows = [];
  // Merged cells (rowspan / colspan, shared/sheet-format.mjs): a cell sits
  // at the first column no merge above or beside it covers; a covered slot
  // has no <td> (tds[c] null, read as empty). One query tells a sheet
  // without merges, which keeps the plain positional read.
  const merged = !!(table.querySelector && table.querySelector('td[colspan],td[rowspan],th[colspan],th[rowspan]'));
  const merges = [];
  const carry = merged ? new Array(columns.length).fill(0) : null;
  const trs = ownRows(table, 'body').filter((tr) => tr !== headRow);
  trs.forEach((tr, r) => {
    const tds = [];
    const cells = [];
    if (!merged) {
      for (let c = 0; c < columns.length; c++) {
        const td = tr.cells[c] || null;
        tds.push(td);
        cells.push(readCell(td, columns[c].type));
      }
    } else {
      let k = 0;
      for (let c = 0; c < columns.length; c++) {
        if (carry[c] > 0) { carry[c]--; tds.push(null); cells.push(readCell(null, columns[c].type)); continue; }
        const td = tr.cells[k++] || null;
        tds.push(td);
        cells.push(readCell(td, columns[c].type));
        if (!td) continue;
        const cs = Math.min(spanOf(td.getAttribute('colspan')), columns.length - c);
        const rs = Math.min(spanOf(td.getAttribute('rowspan')), trs.length - r);
        if (cs > 1 || rs > 1) {
          merges.push({ r, c, rs, cs });
          for (let j = 0; j < cs; j++) carry[c + j] = rs - 1;
          for (let j = 1; j < cs; j++) { tds.push(null); cells.push(readCell(null, columns[c + j].type)); }
          c += cs - 1;
        }
      }
    }
    const height = tr.hasAttribute('data-height') ? cleanSize(tr.getAttribute('data-height'), MIN_HEIGHT, MAX_HEIGHT) : 0;
    rows.push({ id: tr.getAttribute('data-row') || '', tr, tds, cells, height });
  });
  return { name: table.getAttribute('data-name') || '', columns, rows, table, merges };
}
// A rowspan / colspan: a whole number from 1 to 1000.
function spanOf(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 1 ? Math.min(n, 1000) : 1;
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
  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((line, i) => {
    if (i) td.appendChild(doc.createElement('br'));
    if (line) td.appendChild(doc.createTextNode(line));
  });
}

// A column's or row's layout, written onto its <th> or <tr>; a falsy value
// removes the attribute (the default).
export function writeColumnLayout(th, { width, wrap, align } = {}) {
  if (width !== undefined) { const w = cleanSize(width, MIN_WIDTH, MAX_WIDTH); if (w) th.setAttribute('data-width', String(w)); else th.removeAttribute('data-width'); }
  if (wrap !== undefined) { if (wrap) th.setAttribute('data-wrap', 'wrap'); else th.removeAttribute('data-wrap'); }
  if (align !== undefined) { const a = cleanAlign(align); if (a) th.setAttribute('data-align', a); else th.removeAttribute('data-align'); }
}
export function writeRowHeight(tr, height) {
  const ht = cleanSize(height, MIN_HEIGHT, MAX_HEIGHT);
  if (ht) tr.setAttribute('data-height', String(ht)); else tr.removeAttribute('data-height');
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
