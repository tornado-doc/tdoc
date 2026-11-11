// Sheets: cell formatting, the viewer half. The markup and its validation are
// shared/sheet-format.mjs (SheetFormat); this draws a format (classes from a
// fixed palette, never a value from the markup in a style), merged cells in
// the virtualized grid, and in Edit mode the format toolbar: one slim icon
// row above the sheet (number formats, bold / italic, text colour, fill,
// merge, alignment, clear), its overflow in a "More" menu where the width
// runs out. Strikethrough, borders and vertical alignment in the markup
// (an import, an agent) are drawn; the toolbar does not offer them yet. Every change is one
// undoable step through the viewer's own record / afterChange, so it lands
// in the editor's draft and Save like any other sheet edit.
//
// Inlined by server/sheets-source.js before server/sheets-viewer.js, which
// calls SheetFormatUI(api) once with the few internals it needs.
function SheetFormatUI(api) {
  'use strict';
  var F = SheetFormat, Q = SheetQuery, M = SheetMarkup, K = F.KEY;
  var h = api.h;

  // ---- styles ----------------------------------------------------------------
  var css = [
    '.tdoc-sheet .fx-b{font-weight:600}',
    '.tdoc-sheet .fx-i{font-style:italic}',
    '.tdoc-sheet .fx-s,.tdoc-sheet .fx-s>span.ts-t{text-decoration:line-through}',
    '.tdoc-sheet .ts-c.fx-al-left,.tdoc-sheet .ts-c.fx-txt{justify-content:flex-start;text-align:left}',
    '.tdoc-sheet .ts-c.fx-al-center{justify-content:center;text-align:center}',
    '.tdoc-sheet .ts-c.fx-al-right,.tdoc-sheet .ts-c.fx-num{justify-content:flex-end;text-align:right}',
    '.tdoc-sheet .ts-c.fx-va-top{align-items:flex-start;padding-top:7px}',
    '.tdoc-sheet .ts-c.fx-va-middle{align-items:center;padding-top:0}',
    '.tdoc-sheet .ts-c.fx-va-bottom{align-items:flex-end;padding-bottom:6px}',
    '.ts-flat .fx-al-left,.ts-flat .fx-txt{text-align:left}.ts-flat .fx-al-center{text-align:center}.ts-flat .fx-al-right,.ts-flat .fx-num{text-align:right}',
    '.ts-flat td.fx-va-top{vertical-align:top}.ts-flat td.fx-va-middle{vertical-align:middle}.ts-flat td.fx-va-bottom{vertical-align:bottom}',
    // Ruled edges: right and bottom on the cell's own grid lines, top and
    // left drawn inside it.
    '.tdoc-sheet .ts-c.fx-e-r{border-right-color:var(--ts-ink)}.tdoc-sheet .ts-c.fx-e-b{border-bottom-color:var(--ts-ink)}',
    '.tdoc-sheet .ts-c.fx-e-t::before,.tdoc-sheet .ts-c.fx-e-l::before{content:"";position:absolute;inset:0;pointer-events:none;border:0 solid var(--ts-ink)}',
    '.tdoc-sheet .ts-c.fx-e-t::before{border-top-width:1px}.tdoc-sheet .ts-c.fx-e-l::before{border-left-width:1px}',
    '.ts-flat td.fx-e-t{border-top:1px solid var(--ts-ink)}.ts-flat td.fx-e-b{border-bottom:1px solid var(--ts-ink)}.ts-flat td.fx-e-l{border-left:1px solid var(--ts-ink)}.ts-flat td.fx-e-r{border-right:1px solid var(--ts-ink)}',
    // The selection and a search hit show over a fill.
    '.tdoc-sheet .ts-c.fx-fill.is-sel{background-image:linear-gradient(var(--ts-sel),var(--ts-sel))}',
    '.tdoc-sheet .ts-c.fx-fill.is-hit{background-image:linear-gradient(rgba(255,214,0,.22),rgba(255,214,0,.22))}',
    // Merged cells: the top-left cell spans the range; covered slots hold
    // their place, unseen. A frozen first column stays above a merge
    // scrolled under it.
    '.tdoc-sheet .ts-c.fx-span{z-index:1}.tdoc-sheet .ts-c.fx-tall{align-self:flex-start}',
    '.tdoc-sheet.fx-merged .ts-c.is-first{z-index:2}',
    '.tdoc-sheet .ts-c.fx-cov{visibility:hidden}',
    // The toolbar: one slim row of icons, Edit mode only.
    '.ts-fbar{display:flex;align-items:center;gap:2px;height:36px;margin:0 0 8px;padding:0 4px;border:1px solid var(--ts-line);border-radius:8px;background:var(--ts-head);overflow:hidden;white-space:nowrap}',
    '.ts-fbar[hidden]{display:none!important}',
    '.ts-fbar .ts-icon{width:30px;height:28px;position:relative;-webkit-tap-highlight-color:transparent}',
    '.ts-fbar .ts-icon svg{width:18px;height:18px}',
    '.ts-fbar .ts-icon[aria-pressed="true"]{background:var(--ts-accent-tint);color:var(--ts-accent)}',
    '.ts-fbar .ts-icon.fx-wide{width:auto;padding:0 6px;gap:2px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}',
    '.ts-fbar .ts-icon.fx-wide svg{width:12px;height:12px}',
    '.ts-fbar .fx-g{display:flex;align-items:center;gap:2px;flex:none}',
    '.ts-fbar .fx-g[hidden],.ts-fbar .fx-sep[hidden],.ts-fbar .fx-more[hidden]{display:none}',
    '.ts-fbar .fx-sep{flex:none;width:1px;height:18px;margin:0 4px;background:#d9d9df}',
    '.ts-fbar .fx-more{margin-left:auto}',
    '.ts-fbar .fx-bar-c{position:absolute;left:8px;right:8px;bottom:3px;height:3px;border-radius:1px;background:currentColor}',
    '.ts-swatches{display:grid;grid-template-columns:repeat(5,30px);gap:6px;padding:6px}',
    '.ts-swatch{width:30px;height:30px;border:1px solid rgba(0,0,0,.08);border-radius:8px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-weight:600;font-size:14px}',
    '.ts-swatch[aria-pressed="true"]{box-shadow:0 0 0 2px #fff,0 0 0 4px var(--ts-accent,#1652f0)}',
    '.ts-swatch.is-none{background:#fff;color:#8a8a94}',
    '.ts-mi .fx-ex{margin-left:auto;padding-left:16px;color:#8a8a94;font-size:12px;font-variant-numeric:tabular-nums}',
    '.ts-mi[aria-checked="true"] .fx-ex{margin-left:12px}',
    '.ts-mi .fx-mi-ic{display:inline-flex;color:#666}',
  ];
  Object.keys(Q.TAG_COLORS).forEach(function (name) {
    if (F.COLORS.indexOf(name) === -1) return;
    var c = Q.TAG_COLORS[name];
    css.push('.tdoc-sheet .fx-c-' + name + '{color:' + c[1] + '}');
    css.push('.tdoc-sheet .ts-c.fx-f-' + name + ',.tdoc-sheet .ts-flat td.fx-f-' + name + ',.tdoc-sheet .ts-card-l.fx-f-' + name + '{background-color:' + c[0] + '}');
  });
  var style = api.provider(document.createElement('style'));
  style.textContent = css.join('');
  document.head.appendChild(style);

  // ---- icons -------------------------------------------------------------------
  var S = function (body) { return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>'; };
  var T = function (text, size) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><text x="12" y="16.5" text-anchor="middle" font-size="' + (size || 14) + '" font-weight="600" font-family="system-ui,-apple-system,sans-serif" fill="currentColor">' + text + '</text></svg>'; };
  var I = {
    bold: S('<path d="M7.5 5h5a3.25 3.25 0 0 1 0 6.5h-5zM7.5 11.5h6a3.75 3.75 0 0 1 0 7.5h-6z" stroke-width="2.3"/>'),
    italic: S('<path d="M11 5h7M6 19h7M14.5 5l-5 14"/>'),
    color: S('<path d="M7 15L12 4l5 11M8.8 11h6.4"/>'),
    fill: S('<path d="M5.5 11.5L11 6l6.5 6.5L12 18z M11 6L8.5 3.5"/><path d="M19.5 14.5s1.5 1.8 1.5 2.8a1.5 1.5 0 0 1-3 0c0-1 1.5-2.8 1.5-2.8z" fill="currentColor" stroke="none"/>'),
    merge: S('<path d="M4 5v14M20 5v14"/><path d="M7.5 12H11M16.5 12H13M9.5 9.5L12 12l-2.5 2.5M14.5 9.5L12 12l2.5 2.5"/>'),
    left: S('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
    center: S('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
    right: S('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>'),
    clear: S('<path d="M6 5h11M11.5 5L9 15"/><path d="M14 14l6 6M20 14l-6 6"/>'),
    currency: T('$', 19),
    percent: T('%', 18),
    decLess: S('<path d="M4 14h.01" stroke-width="3"/><path d="M8.5 10.5a2.5 3.5 0 1 0 5 0a2.5 3.5 0 1 0-5 0" stroke-width="1.9"/><path d="M20 19.5h-9M13.5 17l-2.5 2.5 2.5 2.5" stroke-width="1.7"/>'),
    decMore: S('<path d="M2.5 14h.01" stroke-width="3"/><path d="M6 10.5a2 3.5 0 1 0 4 0a2 3.5 0 1 0-4 0M12.5 10.5a2 3.5 0 1 0 4 0a2 3.5 0 1 0-4 0" stroke-width="1.9"/><path d="M11 19.5h9M17.5 17l2.5 2.5-2.5 2.5" stroke-width="1.7"/>'),
    caret: S('<path d="M7 10l5 5 5-5"/>'),
    more: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="6" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18" cy="12" r="1.7"/></svg>',
    none: S('<path d="M5 19L19 5"/>'),
  };

  // ---- reading: formats and merges of a tab --------------------------------------
  // After readSheetTable: tab.fmt (Map of formats), and every merge with the
  // slots it covers, by document row and column.
  function read(tab) {
    tab.fmt = F.readFormats(tab.data, tab.table);
    var merges = tab.data.merges || [];
    tab.fcovered = null; tab.fanchor = null;
    if (!merges.length) return;
    tab.fcovered = new Map(); tab.fanchor = new Map();
    merges.forEach(function (m) {
      tab.fanchor.set(m.r * K + m.c, m);
      for (var r = m.r; r < m.r + m.rs; r++) for (var c = m.c; c < m.c + m.cs; c++) if (r !== m.r || c !== m.c) tab.fcovered.set(r * K + c, m);
    });
  }
  // After the view is run: the merges drawn merged, those whose rows the view
  // shows together and in order (a sort or filter that parts them shows
  // their cells one by one, as written).
  function view(tab) {
    tab.mview = null; tab.mlist = null;
    var merges = tab.data.merges || [];
    if (api.ui.root) api.ui.root.classList.toggle('fx-merged', !!merges.length);
    if (!merges.length) return;
    tab.mview = new Map(); tab.mlist = [];
    merges.forEach(function (m) {
      var i0 = tab.pos[m.r];
      if (i0 < 0) return;
      for (var k = 1; k < m.rs; k++) if (tab.pos[m.r + k] !== i0 + k) return;
      var v = { r: m.r, c: m.c, rs: m.rs, cs: m.cs, i0: i0 };
      tab.mlist.push(v);
      for (var r = m.r; r < m.r + m.rs; r++) for (var c = m.c; c < m.c + m.cs; c++) tab.mview.set(r * K + c, v);
    });
  }
  function covered(tab, r, c) { return !!(tab.fcovered && tab.fcovered.has(r * K + c)); }
  function fmtOf(tab, r, c) { return (tab.fmt && tab.fmt.get(r * K + c)) || null; }

  // ---- drawing ---------------------------------------------------------------------
  // A cell's classes and shown text from its format.
  function decor(f, type, text, colAlign) {
    var cls = '', shown = null;
    if (f.b) cls += ' fx-b';
    if (f.i) cls += ' fx-i';
    if (f.s) cls += ' fx-s';
    if (f.color) cls += ' fx-c-' + f.color;
    if (f.fill) cls += ' fx-fill fx-f-' + f.fill;
    if (f.align) cls += ' fx-al-' + f.align;
    if (f.valign) cls += ' fx-va-' + f.valign;
    if (f.border) f.border.split(' ').forEach(function (e) { cls += ' fx-e-' + e; });
    if (f.num && type !== 'tags' && type !== 'checkbox' && type !== 'url') {
      shown = F.displayValue(text, f.num);
      if (!f.align && !colAlign) {
        if (f.num.kind === 'text') cls += ' fx-txt';
        else if (F.isNumeric(f.num) && F.toNumber(text) != null) cls += ' fx-num';
      }
    }
    return { cls: cls, text: shown };
  }
  // The grid's cell r, c (document row, column) at view row i: null to draw
  // it as usual, else { skip } (a covered slot beside its merge's top-left,
  // drawn by it), { cov } (a covered slot below it: a placeholder), or
  // { cls, text, w, style } for a formatted or merged cell.
  function cell(tab, r, c, i, type, colAlign, text, w) {
    var m = tab.mview && tab.mview.get(r * K + c);
    var out = null;
    if (m) {
      if (m.r !== r || m.c !== c) {
        if (m.r === r) return { skip: true };
        return { cov: '<div class="ts-c fx-cov" aria-hidden="true" style="width:' + w + 'px"></div>' };
      }
      var ww = 0, hh = 0;
      for (var k = 0; k < m.cs; k++) ww += tab.widths[c + k] || 0;
      for (var j = 0; j < m.rs; j++) hh += api.rowH(tab, i + j);
      out = { cls: m.rs > 1 ? ' fx-span fx-tall' : ' fx-span', text: null, w: ww, style: m.rs > 1 ? ';height:' + hh + 'px' : '' };
    }
    var f = fmtOf(tab, r, c);
    if (!f) return out;
    var d = decor(f, type, text, colAlign);
    if (!out) return { cls: d.cls, text: d.text, w: w, style: '' };
    out.cls += d.cls; out.text = d.text;
    return out;
  }
  // The flat view's cell: { skip } for a covered slot, else classes, text and
  // a span. Merged only while the view shows the whole merge in order.
  function flat(tab, r, c, type, text, cards) {
    var m = !cards && tab.mview && tab.mview.get(r * K + c), out = { cls: '', text: null, span: '' };
    if (m) {
      if (m.r !== r || m.c !== c) return { skip: true };
      out.span = (m.cs > 1 ? ' colspan="' + m.cs + '"' : '') + (m.rs > 1 ? ' rowspan="' + m.rs + '"' : '');
    }
    var f = fmtOf(tab, r, c);
    if (f) { var d = decor(f, type, text, tab.align && tab.align[c]); out.cls = d.cls; out.text = d.text; }
    return out;
  }
  // The first row to draw: back to the top of a merge the window starts in.
  function firstRow(tab, first) {
    if (!tab.mlist) return first;
    var f = first;
    for (var k = 0; k < tab.mlist.length; k++) { var m = tab.mlist[k]; if (m.i0 < f && m.i0 + m.rs > first) f = m.i0; }
    return f;
  }

  // ---- selection over merges -----------------------------------------------------
  // A covered slot selects its merge's top-left cell.
  function snap(tab, i, c) {
    var r = tab.order[i], m = r != null && tab.mview && tab.mview.get(r * K + c);
    return m ? { i: m.i0, c: m.c } : { i: i, c: c };
  }
  // A step from a merged cell leaves it from its far edge.
  function past(tab, i, c, dr, dc) {
    var r = tab.order[i], m = r != null && tab.mview && tab.mview.get(r * K + c);
    if (!m) return null;
    return { i: (dr > 0 ? m.i0 + m.rs - 1 : m.i0) + dr, c: (dc > 0 ? m.c + m.cs - 1 : m.c) + dc };
  }
  // Structural changes run on the table laid out flat, then merged again.
  function wrap(tab, fn) {
    F.withMerges(tab.table, function () { return M.headerCells(tab.table); }, fn);
  }

  // ---- changing formats ------------------------------------------------------------
  function bounds() {
    var s = api.sel();
    return { ra: Math.min(s.r, s.r2), rb: Math.max(s.r, s.r2), ca: Math.min(s.c, s.c2), cb: Math.max(s.c, s.c2) };
  }
  function activeFmt() {
    var tab = api.cur(), s = api.sel(), r = tab.order[s.r];
    return r == null ? null : fmtOf(tab, r, s.c);
  }
  function activeText() {
    var tab = api.cur(), s = api.sel(), r = tab.order[s.r];
    return r == null ? '' : tab.index.cols[s.c].text[r];
  }
  function attrsOf(td) { var o = {}; F.FORMAT_ATTRS.forEach(function (a) { o[a] = td.getAttribute(a); }); return o; }
  function putAttrs(td, o) { F.FORMAT_ATTRS.forEach(function (a) { if (o[a] == null) td.removeAttribute(a); else td.setAttribute(a, o[a]); }); }
  // perCell(format, r, c, edges) → the cell's new format, over the selection
  // (a covered slot is its merge's: left alone). One undoable step.
  function change(perCell) {
    if (!api.canEdit()) return false;
    var tab = api.cur(), b = bounds(), list = [];
    if (!tab.order.length) return false;
    for (var i = b.ra; i <= b.rb; i++) {
      var r = tab.order[i];
      for (var c = b.ca; c <= b.cb; c++) {
        if (covered(tab, r, c)) continue;
        var m = tab.fanchor && tab.fanchor.get(r * K + c);
        var edges = { t: i === b.ra, l: c === b.ca, b: i + (m ? m.rs - 1 : 0) >= b.rb, r: c + (m ? m.cs - 1 : 0) >= b.cb };
        var old = fmtOf(tab, r, c), next = perCell(old, r, c, edges);
        if (F.sameFormat(old, next)) continue;
        list.push({ r: r, c: c, next: next });
      }
    }
    if (!list.length) return false;
    list.forEach(function (x) {
      var td = api.ensureCell(tab, x.r, x.c);
      x.td = td; x.before = attrsOf(td);
      F.writeFormat(td, x.next);
      x.after = attrsOf(td);
    });
    api.record({ tab: tab, undo: function () { list.forEach(function (x) { putAttrs(x.td, x.before); }); }, redo: function () { list.forEach(function (x) { putAttrs(x.td, x.after); }); } });
    tab.measured = new Map();
    // Formats move no row: the selection stays as it is.
    api.afterChange(tab, null);
    return true;
  }
  function patch(p) { return change(function (f) { return F.mergeFormat(f, p); }); }
  function toggle(k) { var on = !(activeFmt() || {})[k]; var p = {}; p[k] = on; return patch(p); }
  function setNum(spec) { return patch({ num: spec ? F.parseNum(spec) : null }); }
  function toggleNum(spec) {
    var f = activeFmt(), now = f && f.num ? F.numSpec(f.num) : '';
    var kind = spec.split(':')[0];
    return setNum(now && now.split(':')[0] === kind ? '' : spec);
  }
  function stepDec(d) {
    var tab = api.cur();
    return change(function (f, r, c) { return F.mergeFormat(f, { num: F.stepDecimals(tab.index.cols[c].text[r], f && f.num, d) }); });
  }
  function clearFormat() { return change(function () { return null; }); }

  // Merge the selection: all into one, one per row, or one per column; or
  // unmerge whatever merges it touches. The rows must be next to each other
  // in the document (a sort or filter can part them).
  function merge(kind) {
    if (!api.canEdit()) return;
    var tab = api.cur(), b = bounds();
    if (!tab.order.length) return;
    var rows = [];
    for (var i = b.ra; i <= b.rb; i++) rows.push(tab.order[i]);
    var single = b.ra === b.rb && b.ca === b.cb;
    if (kind !== 'unmerge') {
      if (single || (kind === 'horizontal' && b.ca === b.cb) || (kind === 'vertical' && b.ra === b.rb)) { api.toast('Select more than one cell to merge.'); return; }
      for (var k = 1; k < rows.length; k++) if (rows[k] !== rows[0] + k) { api.toast('These rows are not next to each other in the sheet. Clear the sort or filter to merge them.'); return; }
    }
    var trs = rows.map(function (r) { return tab.data.rows[r].tr; });
    var ths = tab.data.columns.slice(b.ca, b.cb + 1).map(function (col) { return col.th; });
    var touches = function (m) { return m.trs.some(function (tr) { return trs.indexOf(tr) !== -1; }) && m.ths.some(function (th) { return ths.indexOf(th) !== -1; }); };
    // What a merge keeps: its top-left value (as Excel and Google Sheets do).
    var lost = 0;
    if (kind !== 'unmerge') rows.forEach(function (r, ri) {
      for (var c = b.ca; c <= b.cb; c++) {
        var keep = kind === 'all' ? ri === 0 && c === b.ca : kind === 'horizontal' ? c === b.ca : ri === 0;
        if (!keep && tab.index.cols[c].text[r] !== '') lost++;
      }
    });
    var hadAny = false;
    // Its own snapshot: the viewer's (snapshotOp) lays the table flat and
    // merges it again as it was, which is what this changes.
    var table = tab.table, before = table.innerHTML;
    F.withMerges(table, function () { return M.headerCells(table); }, function () {}, function (list) {
      var kept = list.filter(function (m) { var t = touches(m); if (t) hadAny = true; return !t; });
      if (kind === 'all') kept.push({ trs: trs, ths: ths });
      else if (kind === 'horizontal') trs.forEach(function (tr) { kept.push({ trs: [tr], ths: ths }); });
      else if (kind === 'vertical') ths.forEach(function (th) { kept.push({ trs: trs, ths: [th] }); });
      return kept;
    });
    var after = table.innerHTML;
    if (after === before) { if (kind === 'unmerge') api.toast('Nothing to unmerge here.'); return; }
    api.record({ tab: tab, undo: function () { table.innerHTML = before; }, redo: function () { table.innerHTML = after; } });
    tab.measured = new Map();
    var s = api.sel();
    s.r = s.r2 = b.ra; s.c = s.c2 = b.ca;
    if (kind !== 'unmerge') { s.r2 = b.rb; s.c2 = b.cb; }
    api.afterChange(tab, rows[0]);
    if (kind === 'unmerge' && !hadAny) api.toast('Nothing to unmerge here.');
    else if (lost) api.toast('Merged. Only the top-left value of each merge is kept (' + lost + (lost === 1 ? ' value' : ' values') + ' cleared). Undo brings them back.');
  }

  // ---- popovers ------------------------------------------------------------------------
  function swatches(anchor, kind) {
    var now = (activeFmt() || {})[kind] || '';
    api.openPop(anchor, function (el) {
      el.appendChild(h('div', 'ts-ph', kind === 'color' ? 'Text colour' : 'Fill colour'));
      var grid = h('div', 'ts-swatches');
      grid.setAttribute('role', 'group');
      [''].concat(F.COLORS).forEach(function (name) {
        var b = h('button', 'ts-swatch' + (name ? '' : ' is-none'));
        b.type = 'button';
        var label = name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Default';
        b.setAttribute('aria-label', label); b.title = label;
        b.setAttribute('aria-pressed', name === now ? 'true' : 'false');
        if (!name) b.innerHTML = I.none;
        else if (kind === 'color') { b.textContent = 'A'; b.style.color = Q.TAG_COLORS[name][1]; b.style.background = '#fff'; }
        else b.style.background = Q.TAG_COLORS[name][0];
        if (name === now) b.setAttribute('data-autofocus', '');
        b.addEventListener('click', function (e) { e.stopPropagation(); api.closePop(true); var p = {}; p[kind] = name || null; patch(p); });
        grid.appendChild(b);
      });
      el.appendChild(grid);
    }, { label: kind === 'color' ? 'Text colour' : 'Fill colour', returnFocus: api.ui.grid });
  }
  function item(label, fn, opts) {
    return Object.assign({ label: label, onSelect: fn }, opts || {});
  }
  function numberMenu(anchor) {
    var f = activeFmt(), now = f && f.num ? F.numSpec(f.num) : '';
    var items = F.NUMBER_FORMATS.map(function (x) {
      // Number and Percent stand for any number of decimals.
      var same = x[0] === now || (/^(number|percent):/.test(x[0]) && now.split(':')[0] === x[0].split(':')[0]);
      return item(x[1], function () { setNum(x[0]); }, { checked: same, example: x[2] });
    });
    items.splice(2, 0, 'sep');
    items.push({ header: 'Currency' });
    ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR'].forEach(function (cur) {
      var spec = F.numSpec(F.parseNum('currency:' + cur));
      items.push(item(cur + ' ' + F.CURRENCIES[cur].trim(), function () { setNum(spec); }, { checked: now === spec, example: F.displayValue('1000.12', F.parseNum(spec)) }));
    });
    menu(anchor, items, 'Number format');
  }
  // A menu whose items may show an example on the right.
  function menu(anchor, items, label) {
    api.openPop(anchor, function (el) {
      api.menuItems(el, items);
      var buttons = el.querySelectorAll('button.ts-mi');
      var k = 0;
      items.forEach(function (it) {
        if (it === 'sep' || it.header) return;
        var b = buttons[k++];
        if (it.icon) { var ic = h('span', 'fx-mi-ic'); ic.innerHTML = it.icon; b.insertBefore(ic, b.firstChild); }
        if (it.example) b.appendChild(h('span', 'fx-ex', it.example));
      });
    }, { role: 'menu', label: label, returnFocus: api.ui.grid });
  }
  function mergeMenu(anchor) {
    var tab = api.cur(), b = bounds();
    var inMerge = false;
    if (tab.fanchor) tab.data.merges.forEach(function (m) {
      var i0 = tab.pos[m.r];
      if (i0 >= 0 && i0 <= b.rb && i0 + m.rs - 1 >= b.ra && m.c <= b.cb && m.c + m.cs - 1 >= b.ca) inMerge = true;
    });
    var one = b.ra === b.rb && b.ca === b.cb;
    menu(anchor, [
      item('Merge all', function () { merge('all'); }, { disabled: one }),
      item('Merge horizontally', function () { merge('horizontal'); }, { disabled: b.ca === b.cb }),
      item('Merge vertically', function () { merge('vertical'); }, { disabled: b.ra === b.rb }),
      item('Unmerge', function () { merge('unmerge'); }, { disabled: !inMerge }),
    ], 'Merge cells');
  }
  function alignMenu(anchor) {
    var now = (activeFmt() || {}).align || '';
    menu(anchor, ['left', 'center', 'right'].map(function (a) { return item(a.charAt(0).toUpperCase() + a.slice(1), function () { patch({ align: now === a ? null : a }); }, { checked: now === a, icon: I[a] }); }), 'Horizontal align');
  }
  // ---- the toolbar ----------------------------------------------------------------------
  // Groups, in order; where the row runs out of room, the last ones go into
  // the More menu (as menu items, each opening what its button opens).
  var MOD = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl+';
  // The common formats only (strikethrough, borders, vertical alignment and
  // the format painter are drawn from the markup but not offered yet).
  var GROUPS = [
    [
      { id: 'currency', icon: I.currency, label: 'Format as currency', run: function () { toggleNum('currency:USD:2'); } },
      { id: 'percent', icon: I.percent, label: 'Format as percent', run: function () { toggleNum('percent:2'); } },
      { id: 'decless', icon: I.decLess, label: 'Decrease decimal places', run: function () { stepDec(-1); } },
      { id: 'decmore', icon: I.decMore, label: 'Increase decimal places', run: function () { stepDec(1); } },
      { id: 'numfmt', html: '123' + I.caret, wide: true, label: 'More number formats', run: numberMenu, menu: true },
    ],
    [
      { id: 'bold', icon: I.bold, label: 'Bold (' + MOD + 'B)', run: function () { toggle('b'); }, toggle: true },
      { id: 'italic', icon: I.italic, label: 'Italic (' + MOD + 'I)', run: function () { toggle('i'); }, toggle: true },
      { id: 'color', icon: I.color, bar: true, label: 'Text colour', run: function (a) { swatches(a, 'color'); }, menu: true },
    ],
    [
      { id: 'fill', icon: I.fill, bar: true, label: 'Fill colour', run: function (a) { swatches(a, 'fill'); }, menu: true },
      { id: 'merge', icon: I.merge, label: 'Merge cells', run: mergeMenu, menu: true },
    ],
    [{ id: 'align', icon: I.left, label: 'Align', run: alignMenu, menu: true }],
    [{ id: 'clear', icon: I.clear, label: 'Clear formatting (' + MOD + '\\)', run: clearFormat }],
  ];
  var bar = null, btn = {}, groupEls = [], sepEls = [], moreBtn = null;
  function mount(root, before) {
    bar = api.provider(h('div', 'ts-fbar'));
    bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Format cells');
    bar.hidden = true;
    GROUPS.forEach(function (g, gi) {
      if (gi) { var sp = h('span', 'fx-sep'); sp.setAttribute('aria-hidden', 'true'); bar.appendChild(sp); sepEls.push(sp); }
      var ge = h('div', 'fx-g'); groupEls.push(ge);
      g.forEach(function (it) {
        var b = h('button', 'ts-icon' + (it.wide ? ' fx-wide' : ''));
        b.type = 'button';
        b.innerHTML = it.icon || it.html;
        b.setAttribute('aria-label', it.label.replace(/ \(.*\)$/, '')); b.title = it.label;
        if (it.toggle) b.setAttribute('aria-pressed', 'false');
        if (it.menu) b.setAttribute('aria-haspopup', 'true');
        if (it.bar) { var cb = h('span', 'fx-bar-c'); b.appendChild(cb); b._bar = cb; }
        // A press keeps the grid's focus (and its selection) where it is.
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); it.run(b); if (!it.menu) api.ui.grid.focus({ preventScroll: true }); });
        btn[it.id] = b; ge.appendChild(b);
      });
      bar.appendChild(ge);
    });
    moreBtn = h('button', 'ts-icon fx-more'); moreBtn.type = 'button'; moreBtn.innerHTML = I.more;
    moreBtn.setAttribute('aria-label', 'More formatting'); moreBtn.title = 'More formatting'; moreBtn.setAttribute('aria-haspopup', 'true');
    moreBtn.hidden = true;
    moreBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    moreBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); moreMenu(); });
    bar.appendChild(moreBtn);
    root.insertBefore(bar, before);
    if (window.ResizeObserver) new ResizeObserver(function () { fit(); }).observe(bar);
    wireGrid();
  }
  function moreMenu() {
    var items = [];
    GROUPS.forEach(function (g, gi) {
      if (!groupEls[gi].hidden) return;
      if (items.length) items.push('sep');
      g.forEach(function (it) {
        var f = activeFmt() || {};
        var checked = it.toggle ? !!f[{ bold: 'b', italic: 'i' }[it.id]] : undefined;
        items.push(item(it.label.replace(/ \(.*\)$/, '') + (it.menu ? '…' : ''), function () { setTimeout(function () { it.run(moreBtn); }, 0); }, { checked: checked, icon: it.icon || I.caret }));
      });
    });
    menu(moreBtn, items, 'More formatting');
  }
  // Show every group, then put groups away, least used first, until the row
  // fits: text style and colour stay longest (a phone keeps those).
  var HIDE_ORDER = [4, 3, 0, 2];
  function fit() {
    if (!bar || bar.hidden) return;
    groupEls.forEach(function (g) { g.hidden = false; });
    seps();
    moreBtn.hidden = true;
    if (bar.scrollWidth <= bar.clientWidth + 1) return;
    moreBtn.hidden = false;
    for (var k = 0; k < HIDE_ORDER.length && bar.scrollWidth > bar.clientWidth + 1; k++) { groupEls[HIDE_ORDER[k]].hidden = true; seps(); }
  }
  // A divider shows between two groups that show.
  function seps() {
    var seen = !groupEls[0].hidden;
    sepEls.forEach(function (sp, k) { var g = groupEls[k + 1]; sp.hidden = !(seen && !g.hidden); if (!g.hidden) seen = true; });
  }
  // The toolbar follows the mode and the active cell.
  function sync() {
    if (!bar) return;
    var show = api.canEdit() && !!api.cur();
    if (bar.hidden === show) { bar.hidden = !show; if (show) fit(); }
    if (!show) return;
    var f = activeFmt() || {};
    btn.bold.setAttribute('aria-pressed', f.b ? 'true' : 'false');
    btn.italic.setAttribute('aria-pressed', f.i ? 'true' : 'false');
    btn.currency.setAttribute('aria-pressed', f.num && f.num.kind === 'currency' ? 'true' : 'false');
    btn.percent.setAttribute('aria-pressed', f.num && f.num.kind === 'percent' ? 'true' : 'false');
    btn.color._bar.style.background = f.color ? Q.TAG_COLORS[f.color][1] : 'var(--ts-ink)';
    btn.fill._bar.style.background = f.fill ? Q.TAG_COLORS[f.fill][0] : 'transparent';
    btn.fill._bar.style.boxShadow = f.fill ? 'inset 0 0 0 1px rgba(0,0,0,.12)' : 'none';
    btn.align.innerHTML = I[f.align || 'left'];
  }

  // Keyboard: ⌘/Ctrl+B, I, \ clears, Shift+L / E / R align.
  function wireGrid() {
    api.ui.grid.addEventListener('keydown', function (e) {
      if (e.target !== api.ui.grid || !api.canEdit() || api.isEditing()) return;
      var mod = e.metaKey || e.ctrlKey, k = (e.key || '').toLowerCase(), done = true;
      if (mod && !e.shiftKey && !e.altKey && k === 'b') toggle('b');
      else if (mod && !e.shiftKey && !e.altKey && k === 'i') toggle('i');
      else if (mod && !e.shiftKey && (k === '\\' || e.code === 'Backslash')) clearFormat();
      else if (mod && e.shiftKey && (k === 'l' || k === 'e' || k === 'r')) patch({ align: { l: 'left', e: 'center', r: 'right' }[k] });
      else done = false;
      if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }

  return {
    read: read, view: view, cell: cell, flat: flat, firstRow: firstRow, covered: covered,
    snap: snap, past: past, wrap: wrap, mount: mount, sync: sync, fit: fit,
    // For tests: apply as the toolbar would.
    api: { patch: patch, toggle: toggle, setNum: setNum, stepDec: stepDec, clear: clearFormat, merge: merge },
  };
}
