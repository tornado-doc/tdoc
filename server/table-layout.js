// Shared provider/preflight table policy. A scroll wrapper prevents page
// overflow; it does NOT prevent auto-layout from sacrificing a CJK/value
// column to a long identifier. Reserve an intrinsic reading measure per cell.
// Nothing here depends on document text, table order, or author class names.
// Keep this function self-contained: preflight executes it in a browser too.
function layoutTables({ apply = true } = {}) {
  // Serve-time wrapping also covers historical files. This handles tables
  // inserted by the browser editor after the frame was served, using the
  // same ordinary wrapper that the provider already saves/exports.
  if (apply) for (const table of document.querySelectorAll('table')) {
    if (table.parentElement.classList.contains('tdoc-table-scroll') ||
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
  const allTables = [...document.querySelectorAll('table')];
  const tables = allTables.filter(t =>
    t.getClientRects().length && getComputedStyle(t).display === 'table' &&
    getComputedStyle(t).visibility !== 'hidden' && getComputedStyle(t).writingMode === 'horizontal-tb');
  const records = tables.map(table => {
    const cells = [...table.querySelectorAll('th,td')].filter(c => c.closest('table') === table &&
      c.getClientRects().length && getComputedStyle(c).display === 'table-cell' && getComputedStyle(c).visibility !== 'hidden');
    return { table, index: allTables.indexOf(table), selector: path(table), cells: cells.map(cell => {
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
  let rules = '.tdoc-table-scroll{min-width:0;max-width:100%;overflow-x:auto}';
  try {
    // A synchronous counterfactual layout measures each cell's own ink, not
    // the width allotted to it by competing columns. Explicit <br> stays a
    // line break. Restore before yielding so the measurement never paints.
    style.textContent = natural;
    for (const r of records) {
      let needsAuto = false;
      for (const c of r.cells) {
        const rects = ink(c.cell);
        if (!rects.length) continue;
        const unwrapped = Math.max(...rects.map(x => x.right)) - Math.min(...rects.map(x => x.left));
        const value = c.cell.getAttribute('data-tdoc-cell') === 'value';
        // 12em is the minimum reading measure for prose, not a minimum for
        // every column: a short value only reserves its natural ink width.
        // Explicit values are atomic even when longer than that measure.
        const minimum = Math.ceil(value ? unwrapped : Math.min(unwrapped, 12 * c.font));
        const cssMin = minimum + (c.boxSizing === 'border-box' ? c.padding + c.borders : 0);
        rules += `${c.selector}{min-width:${cssMin}px!important${value ? ';white-space:nowrap!important' : ''}}`;
        if (c.available + 2 < minimum && (c.lines >= 2 || value)) {
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
  return { tables: allTables.length, nativeTables: records.length, errors, adjustments };
}

if (typeof module !== 'undefined') module.exports = { layoutTables };
