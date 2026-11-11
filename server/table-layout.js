// Shared provider/preflight table policy. A scroll wrapper prevents page
// overflow; it does NOT prevent auto-layout from sacrificing a CJK/value
// column to a long identifier. Reserve an intrinsic reading measure per cell.
// Nothing here depends on document text, table order, or author class names.
// Keep this function self-contained: preflight executes it in a browser too.
function layoutTables({ apply = true } = {}) {
  // Serve-time wrapping also covers historical files. This handles tables
  // inserted by the browser editor after the frame was served, using the
  // same ordinary wrapper that the provider already saves/exports.
  // A sheet (`table[data-tdoc-sheet]`) is drawn by the sheets viewer, which
  // sizes its own columns; measuring every cell of a 10,000-row sheet here
  // would cost seconds. Its wrapper still comes from serve time.
  // Tables the reader itself draws (inside a provider element, such as a
  // small sheet's flat view) size themselves and are not the author's.
  const isSheet = t => t.matches('table[data-tdoc-sheet]') || !!t.closest('[data-tdoc-provider]');
  if (apply) for (const table of document.querySelectorAll('table')) {
    if (isSheet(table) || table.parentElement.classList.contains('tdoc-table-scroll') ||
        getComputedStyle(table).display !== 'table' ||
        getComputedStyle(table).writingMode !== 'horizontal-tb') continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'tdoc-table-scroll';
    table.replaceWith(wrapper); wrapper.appendChild(table);
  }
  const styleId = 'tdoc-provider-table-layout';
  let style = document.querySelector(`style#${styleId}[data-tdoc-provider]`);
  if (!style) {
    style = document.createElement('style');
    style.id = styleId;
    style.setAttribute('data-tdoc-provider', '');
    (document.head || document.documentElement).appendChild(style);
  }
  const previous = style.textContent;
  // Recompute against the author's layout, not last time's repair. Otherwise
  // a repaired fixed-layout table would oscillate between fixed and auto.
  if (apply) style.textContent = '';
  // DOM paths avoid adding attributes/styles to author cells (which would
  // contaminate edit drafts, artifact identity and saved versions).
  const path = el => {
    const parts = [];
    for (; el && el !== document.documentElement; el = el.parentElement) {
      parts.unshift(`${el.localName}:nth-child(${[...el.parentElement.children].indexOf(el) + 1})`);
    }
    return 'html>' + parts.join('>');
  };
  const ink = cell => {
    const rects = [], walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(walker.currentNode);
      rects.push(...[...range.getClientRects()].filter(r => r.width > 0 && r.height > 0));
    }
    return rects;
  };
  // A standard table (the block-first guide's plain <table>, in a house-style
  // doc) is fitted to the reader: columns share the width and long text wraps,
  // a table that needs more room than the reading column takes the page width
  // beside it (up to 1200px), a table that still cannot fit scrolls with its
  // first column held, and on a phone a table of more than three columns reads
  // as one card per row. Everything is this provider style, for the screen
  // only: the author's HTML is never touched, print and export keep the
  // author's layout. Not standard, so left as the author made it: a custom
  // design or a slide deck, a table with its own style, width or class, one
  // inside a figure, an artifact or a classed wrapper (a custom component),
  // and anything under data-tdoc-table="fixed" (the author's opt-out).
  const html = document.documentElement;
  const designed = html.getAttribute('data-tdoc-design') === 'custom' || !!document.querySelector('[data-tdoc-slide]');
  const HOUSE = /^(wrap|content|container|tdoc-table-scroll|note|tdoc-card|tdoc-cards)$/;
  const standard = table => {
    if (designed || isSheet(table) || table.closest('[data-tdoc-table="fixed"]')) return false;
    if (table.hasAttribute('style') || table.hasAttribute('width') || table.className.trim() ||
        table.querySelector('[style],[width],table,colgroup')) return false;
    for (let el = table.parentElement; el && el !== document.body && el !== html; el = el.parentElement) {
      if (el.localName === 'figure' || el.hasAttribute('style') || el.hasAttribute('data-tdoc-artifact')) return false;
      for (const c of el.classList) if (!HOUSE.test(c)) return false;
    }
    return true;
  };
  const allTables = [...document.querySelectorAll('table')];
  const tables = allTables.filter(t => !isSheet(t) &&
    t.getClientRects().length && getComputedStyle(t).display === 'table' &&
    getComputedStyle(t).visibility !== 'hidden' && getComputedStyle(t).writingMode === 'horizontal-tb');
  const records = tables.map(table => {
    const cells = [...table.querySelectorAll('th,td')].filter(c => c.closest('table') === table &&
      c.getClientRects().length && getComputedStyle(c).display === 'table-cell' && getComputedStyle(c).visibility !== 'hidden');
    const wrap = table.parentElement && table.parentElement.classList.contains('tdoc-table-scroll') &&
      table.parentElement.children.length === 1 ? table.parentElement : null;
    const fit = !!wrap && standard(table);
    const spans = cells.some(c => c.colSpan > 1 || c.rowSpan > 1);
    // The header row: thead's last row, or a first row of <th> only.
    const head = table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1]
      : table.rows[0] && [...table.rows[0].cells].every(c => c.localName === 'th') ? table.rows[0] : null;
    return { table, wrap, fit, spans, head, index: allTables.indexOf(table), selector: path(table), cells: cells.map(cell => {
      const css = getComputedStyle(cell), font = parseFloat(css.fontSize);
      const padding = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
      const borders = parseFloat(css.borderLeftWidth) + parseFloat(css.borderRightWidth);
      const rects = ink(cell);
      const tops = rects.map(r => r.top).sort((a,b) => a-b);
      const lines = tops.filter((top,i) => !i || top - tops[i-1] > font * .6).length;
      return { cell, selector: path(cell), font, padding, borders, boxSizing: css.boxSizing,
        available: cell.clientWidth - padding, lines };
    }) };
  });
  const natural = records.map(r => `${r.selector}{table-layout:auto!important;width:max-content!important;min-width:0!important;max-width:none!important}` +
    r.cells.map(c => `${c.selector}{width:auto!important;min-width:0!important;max-width:none!important;white-space:nowrap!important;word-break:normal!important;overflow-wrap:normal!important}`).join('')).join('');
  const errors = [], adjustments = [];
  let fitted = '', printed = '';
  // The wrapper's own scrollbar is styled so it is drawn whenever the table
  // overflows. With overlay scrollbars (macOS/iOS default) a wide table was cut
  // at the column edge with nothing on screen saying it scrolls, and a mouse had
  // no bar to drag: readers reported such tables as not scrolling at all.
  // ::-webkit-scrollbar only (Chromium, Safari): setting scrollbar-width or
  // scrollbar-color would make Chromium ignore it and fall back to overlay.
  const bar = '.tdoc-table-scroll::-webkit-scrollbar';
  let rules = '.tdoc-table-scroll{min-width:0;max-width:100%;overflow-x:auto}' +
    `${bar}{height:10px;width:10px;background:transparent}${bar}-track{background:transparent}` +
    `${bar}-thumb{background-color:rgba(128,128,128,.45);border:2px solid transparent;border-radius:5px;background-clip:padding-box}` +
    `${bar}-thumb:hover{background-color:rgba(128,128,128,.7)}`;
  try {
    // A synchronous counterfactual layout measures each cell's own ink, not
    // the width allotted to it by competing columns. Explicit <br> stays a
    // line break. Restore before yielding so the measurement never paints.
    style.textContent = natural;
    for (const r of records) {
      let needsAuto = false;
      r.colNat = [];
      const narrow = innerWidth <= 480;
      r.cards = r.fit && narrow && !r.spans && !!r.head && r.head.cells.length > 3;
      for (const c of r.cells) {
        const rects = ink(c.cell);
        if (!rects.length) continue;
        const unwrapped = Math.max(...rects.map(x => x.right)) - Math.min(...rects.map(x => x.left));
        const value = c.cell.getAttribute('data-tdoc-cell') === 'value';
        if (r.fit) {
          // Fitted: a short value keeps its width, text wraps down to a
          // narrow measure (a long word still sets its column's minimum).
          const i = c.cell.cellIndex;
          r.colNat[i] = Math.max(r.colNat[i] || 0, Math.min(unwrapped, 15 * c.font) + c.padding + c.borders);
          const fitMin = Math.ceil(value ? unwrapped : Math.min(unwrapped, 6 * c.font)) + (c.boxSizing === 'border-box' ? c.padding + c.borders : 0);
          if (!r.cards) fitted += `${c.selector}{min-width:${fitMin}px!important${value ? ';white-space:nowrap!important' : ''}}`;
        }
        // 12em is the minimum reading measure for prose, not a minimum for
        // every column: a short value only reserves its natural ink width.
        // Explicit values are atomic even when longer than that measure.
        // A fitted table's measure is 6em on screen (its 12em floor is for print).
        const minimum = Math.ceil(value ? unwrapped : Math.min(unwrapped, (r.fit ? 6 : 12) * c.font));
        const cssMin = minimum + (c.boxSizing === 'border-box' ? c.padding + c.borders : 0);
        // (A fitted table keeps this floor for print, where it is as written.)
        const floor = `${c.selector}{min-width:${r.fit ? Math.ceil(value ? unwrapped : Math.min(unwrapped, 12 * c.font)) + (c.boxSizing === 'border-box' ? c.padding + c.borders : 0) : cssMin}px!important${value ? ';white-space:nowrap!important' : ''}}`;
        if (r.fit) printed += floor; else rules += floor;
        if (!r.cards && c.available + 2 < minimum && (c.lines >= 2 || value)) {
          const issue = `table ${r.index+1}, column ${c.cell.cellIndex+1}: compressed table column (${Math.round(c.available)}px available, ${minimum}px reading minimum, ${c.lines} lines): ${c.cell.textContent.trim().slice(0,70)}`;
          needsAuto = true;
          errors.push(issue);
          adjustments.push({ table: r.index+1, column: c.cell.cellIndex+1, available: Math.round(c.available), minimum });
        }
      }
      if (needsAuto) rules += `${r.selector}{table-layout:auto!important}`;
    }
  } finally {
    style.textContent = apply ? rules : previous;
    if (!apply && !previous) style.remove();
  }
  if (apply) {
    style.textContent = rules + (printed ? `@media print{${printed}}` : '') + fitRules(records, fitted, path) + wideRules();
    style.textContent += holdFirstColumn(records, path);
  }
  // The standard tables' screen layout (see `standard` above): cards on a
  // phone, the page width for a table the reading column cramps, and the first
  // column held while a table that still cannot fit scrolls.
  function fitRules(records, fitted, path) {
    const fit = records.filter(r => r.fit);
    if (!fit.length) return '';
    const esc = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
    let css = fitted;
    for (const r of fit) {
      const t = r.selector, w = path(r.wrap);
      if (r.cards) {
        // One card per row: the first cell is its title, every other cell a
        // "Column: value" line labelled from the header row.
        const labels = [...r.head.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim());
        css += `${t},${t}>tbody,${t}>tbody>tr,${t}>tbody>tr>*,${t}>tr,${t}>tr>*{display:block!important;width:auto!important;min-width:0!important;max-width:none!important}` +
          `${t}>thead{display:none!important}` +
          `${t}>tbody>tr,${t}>tr{margin:0 0 10px;padding:8px 12px;border:1px solid var(--td-line,#e5e5e5);border-radius:8px}` +
          `${t}>tbody>tr>*,${t}>tr>*{padding:2px 0!important;border:0!important;background:transparent!important;text-align:left!important;white-space:normal!important}` +
          `${t}>tbody>tr>:first-child,${t}>tr>:first-child{font-weight:600;padding-bottom:4px!important}`;
        if (!(r.table.tHead && r.table.tHead.rows.length)) css += `${path(r.head)}{display:none!important}`;
        labels.forEach((label, i) => { if (i && label) css += `${t}>tbody>tr>:nth-child(${i + 1})::before,${t}>tr>:nth-child(${i + 1})::before{content:${esc(label + ': ')};color:var(--td-muted,#666)}`; });
        css += `${w}{overflow:visible!important}`;
        continue;
      }
      // Room it reads well in: each column up to 15em of its text.
      if (!r.wrap.hasAttribute('data-tdoc-wide') && !r.table.hasAttribute('data-tdoc-wide'))
        css += breakout(r.wrap, Math.ceil(r.colNat.reduce((a, b) => a + (b || 0), 0)) + 2);
      r.held = !r.spans;
    }
    return css ? `@media screen{${css}}` : '';
  }
  // Wider than the reading column, centred on it, within the page (up to
  // 1200px, a margin from each edge), for a block that needs `need` px.
  function breakout(el, need) {
    const page = Math.min(1200, innerWidth - 48);
    const parent = el.parentElement;
    if (!parent || innerWidth <= 640) return '';
    const pcs = getComputedStyle(parent), pr = parent.getBoundingClientRect();
    const colLeft = pr.left + parseFloat(pcs.paddingLeft) + parseFloat(pcs.borderLeftWidth);
    const col = parent.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight);
    if (need <= col + 1 || page <= col + 1) return '';
    const width = Math.min(need, page), gap = (innerWidth - page) / 2;
    const left = Math.max(gap, Math.min(colLeft + col / 2 - width / 2, innerWidth - gap - width));
    return `${path(el)}{width:${Math.round(width)}px!important;max-width:none!important;margin-left:${Math.round(left - colLeft)}px!important;box-sizing:border-box!important}`;
  }
  // data-tdoc-wide: the author asks for the page width (a table, its wrapper,
  // or any block), also inside a container their own CSS keeps narrow.
  function wideRules() {
    if (document.querySelector('[data-tdoc-slide]')) return '';
    let css = '';
    for (let el of document.querySelectorAll('[data-tdoc-wide]')) {
      if (el.closest('[data-tdoc-provider]') || isSheet(el)) continue;
      if (el.localName === 'table' && el.parentElement && el.parentElement.classList.contains('tdoc-table-scroll')) el = el.parentElement;
      if (el.querySelector('table[data-tdoc-sheet]')) continue;
      css += breakout(el, Infinity);
    }
    return css ? `@media screen{${css}}` : '';
  }

  // After the fitted layout is in: a table that still scrolls keeps its first
  // column in view (unless that column is most of the width).
  function holdFirstColumn(records, path) {
    let css = '';
    for (const r of records) {
      if (!r.fit || !r.held || !r.wrap || r.wrap.scrollWidth <= r.wrap.clientWidth + 1) continue;
      const first = r.table.rows[0] && r.table.rows[0].cells[0];
      if (!first || first.getBoundingClientRect().width > r.wrap.clientWidth * 0.4) continue;
      let bg = '#fff';
      for (let el = r.wrap; el; el = el.parentElement) {
        const c = getComputedStyle(el).backgroundColor;
        if (c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(c)) { bg = c; break; }
      }
      const t = r.selector;
      css += `${t}>*>tr>:first-child,${t}>tr>:first-child{position:sticky;left:0;z-index:1;background-color:${bg};box-shadow:inset -1px 0 var(--td-line,#e5e5e5)}`;
    }
    return css ? `@media screen{${css}}` : '';
  }
  return { tables: allTables.length, nativeTables: records.length, errors, adjustments };
}

if (typeof module !== 'undefined') module.exports = { layoutTables };
