// Sheet embeds, the data half: one tab of a sheet doc's HTML as plain data
// (column names and types, then cell text), with the reference's saved view
// (filters, sort, search) applied and only the rows and columns the embed
// shows. The server answers /api/embed/sheet with this (worker.js and
// server/server.js, through server/sheet-embed-source.js), so the page that
// embeds a sheet receives text, never the sheet's HTML.
//
// No DOM here and no parser: one forward pass over the tags of the sheet
// tables, so an 8 MB sheet costs one linear scan and nothing quadratic. It
// reads what the sheet viewer reads (shared/sheet-markup.mjs readSheetTable):
// the last header row, data-type / data-key / data-palette on each <th>,
// data-row on each body row, <span data-tag> items in a tags cell. The view
// is applied with shared/sheet-query.mjs, passed in as `Q` (no imports: this
// file is inlined into the worker like the sheet modules are into the frame).

// Bounds. A sheet doc may hold 10,000+ rows; an embed shows at most
// EMBED_MAX_ROWS of them, but a filter or sort needs the whole tab.
export const DATA_LIMITS = Object.freeze({
  tables: 20,          // tabs read (the importer writes at most 20)
  rows: 20000,         // body rows read per tab
  columns: 200,        // columns read per tab
  cellChars: 10000,    // text kept per cell while scanning
  shownCellChars: 500, // text sent per cell
  tags: 50,            // tags per cell sent
  payloadChars: 200000, // the answer as JSON, at most (cells shrink to fit)
});

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', middot: '·', rarr: '→', larr: '←', times: '×', copy: '©', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', check: '✓', euro: '€', pound: '£', yen: '¥', deg: '°', plusmn: '±' };
function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? m : named;
  });
}

const ATTR_RES = new Map();
function attrOf(attrs, name) {
  let re = ATTR_RES.get(name);
  if (!re) {
    re = new RegExp('(?:^|\\s)' + name + '(?:\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>`]+)))?(?=\\s|$|/)', 'i');
    ATTR_RES.set(name, re);
  }
  const m = re.exec(attrs);
  if (!m) return null;
  return decodeEntities(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] != null ? m[3] : '');
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);

function squash(s) { return s.replace(/\s+/g, ' ').trim(); }

// Every <table data-tdoc-sheet> in `html`, in document order:
// [{ name, columns:[{ key, name, type, palette }], rows:[{ id, cells }] }]
// with a tags cell as an array of tags and every other cell as its text.
// A table that holds another table is skipped (the viewer reads no such
// sheet either).
export function extractSheetTables(html, limits) {
  const L = Object.assign({}, DATA_LIMITS, limits || {});
  const src = String(html || '');
  const out = [];
  if (src.indexOf('data-tdoc-sheet') === -1) return out;
  let t = null;        // the table being read
  let depth = 0;       // nested tables inside it
  let section = '';    // 'head' | 'body'
  let row = null;      // { head, id, cells: [{ text, tags, isTh, th }] }
  let cell = null;
  let tag = null;      // text of an open <span data-tag>
  let tagDepth = 0;
  const text = (s) => {
    if (!cell || !s) return;
    if (tag !== null) { if (tag.length < 200) tag += s; return; }
    if (cell.text.length < L.cellChars) cell.text += s;
  };
  const endCell = () => {
    if (!cell || !row) { cell = null; return; }
    if (row.cells.length < L.columns) row.cells.push(cell);
    cell = null; tag = null; tagDepth = 0;
  };
  const endRow = () => {
    endCell();
    if (!row || !t) { row = null; return; }
    if (row.head || (row.cells.length && row.cells.every((c) => c.isTh) && !t.header && !t.rows.length)) t.header = row;
    else if (t.rows.length < L.rows) t.rows.push(row);
    else t.truncated = true;
    row = null;
  };
  const finish = () => {
    endRow();
    if (!t.bad) {
      const ths = t.header ? t.header.cells : [];
      const columns = ths.map((c, i) => ({
        key: c.th.key || '',
        name: squash(decodeEntities(c.text)) || `Column ${i + 1}`,
        type: String(c.th.type || 'text').toLowerCase(),
        palette: c.th.palette || '',
      }));
      const rows = t.rows.map((r) => ({
        id: r.id || '',
        cells: columns.map((col, i) => {
          const c = r.cells[i];
          if (!c) return col.type === 'tags' ? [] : '';
          if (col.type === 'tags') {
            if (c.tags.length) return c.tags.map((x) => squash(decodeEntities(x))).filter(Boolean);
            return squash(decodeEntities(c.text)).split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
          }
          return squash(decodeEntities(c.text + (c.tags.length ? ' ' + c.tags.join(' ') : '')));
        }),
      }));
      out.push({ name: t.name, columns, rows, truncated: !!t.truncated });
    }
    t = null; depth = 0; section = ''; row = null; cell = null;
  };
  // One forward pass. Every index only moves forward: a tag is read to its
  // '>' (quotes respected) and the scan goes on after it, so the time is
  // linear in the input whatever it holds. An unclosed quote or comment ends
  // the scan, as it ends the markup in a browser.
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { if (t) text(src.slice(i)); break; }
    if (t && lt > i) text(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const c1 = src.charCodeAt(lt + 1);
    const closing = c1 === 47;
    const c2 = closing ? src.charCodeAt(lt + 2) : c1;
    if (!((c2 >= 97 && c2 <= 122) || (c2 >= 65 && c2 <= 90))) {
      if (c1 === 33 || c1 === 63 || closing) {
        const end = src.indexOf('>', lt + 1);
        if (end === -1) break;
        i = end + 1;
      } else {
        if (t) text('<');
        i = lt + 1;
      }
      continue;
    }
    let j = lt + (closing ? 2 : 1);
    const nameStart = j;
    while (j < n) {
      const ch = src.charCodeAt(j);
      if ((ch >= 97 && ch <= 122) || (ch >= 65 && ch <= 90) || (ch >= 48 && ch <= 57) || ch === 45) j++;
      else break;
    }
    const name = src.slice(nameStart, j).toLowerCase();
    let k = j, quote = 0;
    for (; k < n; k++) {
      const ch = src.charCodeAt(k);
      if (quote) { if (ch === quote) quote = 0; } else if (ch === 34 || ch === 39) quote = ch; else if (ch === 62) break;
    }
    if (k >= n) break;
    const attrs = src.slice(j, k);
    i = k + 1;
    if (!closing && RAW_TEXT.has(name)) {
      // Skip to its end tag: nothing inside is markup.
      const re = new RegExp('</' + name + '[\\s/>]', 'ig');
      re.lastIndex = i;
      const end = re.exec(src);
      if (!end) break;
      i = end.index;
      continue;
    }
    if (!t) {
      if (!closing && name === 'table' && attrOf(attrs, 'data-tdoc-sheet') !== null) {
        if (out.length >= L.tables) break;
        t = { name: squash(attrOf(attrs, 'data-name') || '') || `Sheet ${out.length + 1}`, header: null, rows: [], bad: false };
        depth = 0;
      }
      continue;
    }
    if (name === 'table') {
      if (closing) { if (depth === 0) { finish(); } else depth--; }
      else { depth++; t.bad = true; }
      continue;
    }
    if (depth > 0) continue;
    if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
      endRow();
      section = closing ? '' : name === 'thead' ? 'head' : 'body';
      continue;
    }
    if (name === 'caption' || name === 'colgroup' || name === 'col') continue;
    if (name === 'tr') {
      endRow();
      if (!closing) row = { head: section === 'head', id: attrOf(attrs, 'data-row') || '', cells: [] };
      continue;
    }
    if (name === 'td' || name === 'th') {
      endCell();
      if (!closing) {
        if (!row) row = { head: section === 'head', id: '', cells: [] };
        cell = { text: '', tags: [], isTh: name === 'th', th: name === 'th' ? { key: attrOf(attrs, 'data-key'), type: attrOf(attrs, 'data-type'), palette: attrOf(attrs, 'data-palette') } : {} };
      }
      continue;
    }
    if (!cell) continue;
    if (name === 'br') { text(' '); continue; }
    if (name === 'span') {
      if (!closing && tag === null && attrOf(attrs, 'data-tag') !== null) { tag = ''; tagDepth = 0; continue; }
      if (tag !== null) {
        if (!closing) tagDepth++;
        else if (tagDepth > 0) tagDepth--;
        else { if (cell.tags.length < 500) cell.tags.push(tag); tag = null; }
        continue;
      }
    }
    // Any other inline tag: its text counts, the tag does not.
    text(' ');
  }
  if (t) finish();
  return out;
}

function cut(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// The tab a reference names: data-tab by name (case and spacing ignored),
// else ?sheet=<n> by position, else the view's open tab, else the first.
export function pickTab(tables, ref, view) {
  if (!tables.length) return -1;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (ref.tab) {
    const at = tables.findIndex((t) => norm(t.name) === norm(ref.tab));
    return at;
  }
  if (ref.tabIndex) return ref.tabIndex <= tables.length ? ref.tabIndex - 1 : -1;
  if (view && view.active) {
    const at = tables.findIndex((t) => t.name === view.active);
    if (at !== -1) return at;
  }
  return 0;
}

// Which columns to show: data-columns names them (by header text or data-key,
// comma separated, in that order); else the first EMBED_MAX_COLUMNS.
function pickColumns(columns, wanted, max) {
  const list = String(wanted || '').split(',').map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
  if (!list.length) return columns.map((_, i) => i).slice(0, max);
  const out = [];
  for (const w of list) {
    const at = columns.findIndex((c, i) => !out.includes(i) && (c.name.toLowerCase() === w || (c.key && c.key.toLowerCase() === w)));
    if (at !== -1) out.push(at);
    if (out.length >= max) break;
  }
  return out.length ? out : columns.map((_, i) => i).slice(0, max);
}

// The embed's data, or { error } (no_sheet: the doc holds no sheet table;
// no_tab: the named tab is not there). `Q` is shared/sheet-query.mjs.
export function embedPayload(html, ref, Q, opts) {
  const o = Object.assign({ maxRows: 50, maxColumns: 12 }, opts || {});
  const tables = extractSheetTables(html, o.limits);
  if (!tables.length) return { error: 'no_sheet' };
  const view = Q.decodeView(ref.view || '');
  const at = pickTab(tables, ref, view);
  if (at === -1) return { error: 'no_tab', tabs: tables.map((t) => cut(t.name, 120)).slice(0, 20) };
  const tab = tables[at];
  const query = view.tabs[tab.name] || Q.emptyQuery();
  const sheet = { columns: tab.columns.map((c) => ({ name: c.name, type: Q.normalizeType(c.type) })), rows: tab.rows };
  const index = Q.buildIndex(sheet);
  const order = Q.runQuery(index, query);
  const cols = pickColumns(tab.columns, ref.columns, o.maxColumns);
  const rowsWanted = Math.max(1, Math.min(o.maxRows, Number(ref.rows) || 10));
  let cellChars = DATA_LIMITS.shownCellChars;
  const build = () => order.slice(0, rowsWanted).map((r) => ({
    id: cut(tab.rows[r].id, 40),
    cells: cols.map((c) => {
      const v = tab.rows[r].cells[c];
      return Array.isArray(v) ? v.slice(0, DATA_LIMITS.tags).map((x) => cut(x, 80)) : cut(v, cellChars);
    }),
  }));
  let rows = build();
  // Bound the answer: wide text columns shrink before anything is dropped.
  while (JSON.stringify(rows).length > DATA_LIMITS.payloadChars && cellChars > 40) {
    cellChars = Math.floor(cellChars / 2);
    rows = build();
  }
  const filtered = Object.keys(query.filters || {}).length > 0 || !!query.search;
  return {
    tab: cut(tab.name, 200),
    tab_number: at + 1,
    tabs: tables.length,
    columns: cols.map((c) => ({
      name: cut(tab.columns[c].name, 120),
      type: Q.normalizeType(tab.columns[c].type),
      ...(tab.columns[c].palette ? { palette: cut(tab.columns[c].palette, 500) } : {}),
    })),
    hidden_columns: Math.max(0, tab.columns.length - cols.length),
    rows,
    total_rows: tab.rows.length,
    matching_rows: order.length,
    filtered,
    sorted: (query.sort || []).length > 0,
    truncated: !!tab.truncated,
  };
}
