// Sheets: structure. Row groups (an outline up to three levels, a thin
// gutter with − / + toggles), hidden rows and columns (a small marker where
// they were, for editors), frozen rows and columns (the corner's menu), and
// the tab operations (reorder, delete with an undo).
//
// The markup and the pure logic are shared/sheet-outline.mjs (SheetOutline);
// this file is the UI half. It is inlined by server/sheets-source.js before
// server/sheets-viewer.js, which calls SheetStructure(api) once and reaches
// it only through the hooks marked [structure] there.
//
// Who changes what. Collapsing or expanding a group is anyone's view (kept by
// the shell beside the #hash, like a reader's column widths); in Edit mode it
// is the document's default instead (data-collapsed). Freezing is a reader's
// own view, and the document's for someone who may edit it (through Edit mode
// and Save, as column widths are). Grouping, hiding, unhiding and the tab
// operations are Edit mode's, each one undoable. Read mode shows the outline
// (it is the author's structure) and nothing else: no markers.
function SheetStructure(api) {
  'use strict';
  var O = SheetOutline, Q = api.Q, h = api.h;
  var LANE = 12;
  var ATTRS = ['data-group', 'data-collapsed', 'data-hidden'];
  var FREEZE_ATTRS = ['data-freeze-rows', 'data-freeze-cols'];
  var SVG = {
    minus: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    plus: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6M6 3v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    // Two small arrows pointing away from where rows (columns) are hidden.
    hidR: '<svg viewBox="0 0 14 8" aria-hidden="true"><path d="M4 3.2l3-2.4 3 2.4M4 4.8l3 2.4 3-2.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    hidC: '<svg viewBox="0 0 8 14" aria-hidden="true"><path d="M3.2 4L.8 7l2.4 3M4.8 4l2.4 3-2.4 3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  // ---- styles: the viewer's own tokens (--ts-*), nothing new to learn ---------
  var style = api.provider(document.createElement('style'));
  style.textContent = [
    '.tdoc-sheet .ts-head{z-index:5}',
    // The outline gutter rides over the row numbers' left edge.
    '.ts-outline{position:sticky;left:0;z-index:3;height:0;width:0;overflow:visible}',
    '.ts-otog{position:absolute;z-index:1;width:12px;height:12px;padding:0;margin:0;border:1px solid #c9c9d1;border-radius:3px;background:#fff;color:var(--ts-muted);display:flex;align-items:center;justify-content:center;cursor:pointer}',
    '.tdoc-sheet .ts-otog svg{width:10px;height:10px}',
    '.ts-otog:hover,.ts-otog:focus-visible{border-color:var(--ts-accent);color:var(--ts-accent);outline:0}',
    '.ts-obr{position:absolute;width:5px;border-left:1px solid #c9c9d1;border-bottom:1px solid #c9c9d1;pointer-events:none}',
    // Hidden rows / columns: a small pair of arrows on the line, for editors.
    '.ts-hid{position:absolute;z-index:2;padding:0;margin:0;border:0;border-radius:3px;background:var(--ts-head);color:#8a8a94;display:flex;align-items:center;justify-content:center;cursor:pointer}',
    '.ts-hid.is-r{width:16px;height:10px}.ts-hid.is-c{width:10px;height:16px}',
    '.tdoc-sheet .ts-hid.is-r svg{width:14px;height:8px}.tdoc-sheet .ts-hid.is-c svg{width:8px;height:14px}',
    '.ts-hid:hover,.ts-hid:focus-visible{color:var(--ts-accent);background:var(--ts-accent-tint);outline:0}',
    // Frozen rows: drawn over the top of the body, a 2px rule under them.
    '.ts-frozen{position:sticky;z-index:4;background:#fff;box-shadow:0 2px 0 #d3d3da}',
    '.ts-frozen:empty{display:none}',
    // The corner opens the sheet's view menu (freeze, groups, hidden).
    '.ts-cmenu{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;background:transparent;color:var(--ts-muted);display:flex;align-items:center;justify-content:center;opacity:0;cursor:pointer}',
    '.ts-cmenu:hover,.ts-cmenu:focus-visible{opacity:1;background:#ececf0;outline:0}',
    '@media (hover:none){.ts-cmenu{opacity:.55}}',
    // Dragging a tab to a new place: a line where it will land.
    '.ts-guide{position:fixed;z-index:8;width:2px;background:var(--ts-accent);pointer-events:none}',
    '.ts-tab.is-drag{opacity:.45}',
    // Flat view and phone cards: a collapsed group is one summary row.
    '.ts-flat tr.ts-fsum td{background:var(--ts-head);padding:4px 8px}',
    '.ts-fsum button{display:flex;align-items:center;gap:6px;width:100%;min-height:28px;border:0;background:transparent;color:var(--ts-muted);padding:0;text-align:left;font:inherit;cursor:pointer}',
    '.ts-fsum button:hover{color:var(--ts-accent)}',
    '.ts-card.ts-fsum{background:var(--ts-head);padding:4px 12px}',
    '.ts-ftog{display:inline-flex;vertical-align:-2px;width:16px;height:16px;margin:0 4px 0 -2px;padding:0;border:0;border-radius:3px;background:transparent;color:var(--ts-muted);align-items:center;justify-content:center;cursor:pointer}',
    '.ts-ftog:hover{color:var(--ts-accent);background:var(--ts-accent-tint)}',
    '.tdoc-sheet .ts-ftog svg,.tdoc-sheet .ts-fsum svg{width:12px;height:12px}',
  ].join('');
  document.head.appendChild(style);

  // ---- reading ------------------------------------------------------------------
  function read(tab) {
    var rows = tab.data.rows, cols = tab.data.columns, n = rows.length;
    var trs = new Array(n), ids = new Array(n);
    for (var r = 0; r < n; r++) { trs[r] = rows[r].tr; ids[r] = rows[r].id; }
    var st = {
      rows: O.readAxis(trs),
      cols: O.readAxis(cols.map(function (c) { return c.th; })),
      rowIds: ids,
      colKeys: cols.map(function (c, i) { return c.key || '#' + i; }),
      table: O.readTable(tab.table),
    };
    st.rowGroups = st.rows.any ? O.groupsOf(st.rows.level) : [];
    st.colGroups = []; // column groups: later
    st.rowMax = O.maxLevel(st.rowGroups);
    if (!tab.ov) tab.ov = { r: Object.create(null), c: Object.create(null) };
    tab.st = st;
    readCols(tab);
  }
  function readCols(tab) {
    var st = tab.st;
    // Columns are hidden, never grouped (column groups are for later).
    st.colShown = st.cols.any ? O.shownMask(st.cols, [], st.colKeys, tab.ov.c) : null;
  }
  // The view order: tab.order from the query becomes tab.sorder (hidden rows
  // out) and tab.order (collapsed groups out too, unless a sort is on: a
  // sorted view does not keep groups together, so it shows them open).
  function run(tab) {
    var st = tab.st;
    st.flat = tab.query.sort.length > 0;
    st.sp = null;
    if (!st.rows.any) { tab.sorder = tab.order; st.rowShown = null; return; }
    var shown = st.rowShown = O.shownMask(st.rows, st.rowGroups, st.rowIds, tab.ov.r);
    var q = tab.order, sorder = [], order = [];
    for (var i = 0; i < q.length; i++) {
      var r = q[i];
      if (st.rows.hidden[r]) continue;
      sorder.push(r);
      if (st.flat || shown[r]) order.push(r);
    }
    tab.sorder = sorder;
    tab.order = order;
  }
  // Where the groups and hidden runs sit in the view (after tab.pos is in).
  function spans(tab) {
    var st = tab.st;
    if (!st.rows.any || st.flat) { st.sp = null; return; }
    var pass = new Uint8Array(st.rowIds.length);
    for (var i = 0; i < tab.sorder.length; i++) pass[tab.sorder[i]] = 1;
    st.sp = O.spans(st.rowGroups, st.rows, st.rowIds, tab.ov.r, tab.order, pass);
  }

  // ---- geometry the viewer asks for --------------------------------------------
  function cur() { return api.cur(); }
  function gutterW() {
    var tab = api.book && cur();
    return tab && tab.st && tab.st.rowMax && !tab.st.flat ? tab.st.rowMax * LANE + 4 : 0;
  }
  function colShown(tab, c) { return !tab.st || !tab.st.colShown || !!tab.st.colShown[c]; }
  function colW(tab, c) { return colShown(tab, c) ? tab.widths[c] : 0; }
  function frozenCount(tab) {
    var v = tab.ov && tab.ov.fc != null ? tab.ov.fc : tab.st.table.freezeCols;
    return Math.min(v, tab.data.columns.length);
  }
  function frozenRows(tab) {
    var v = tab.ov && tab.ov.fr != null ? tab.ov.fr : tab.st.table.freezeRows;
    return api.flatView() ? 0 : Math.min(v, tab.order ? tab.order.length : 0);
  }
  function frozenH(tab) { var f = frozenRows(tab); return f ? api.rowTop(tab, f) : 0; }
  function frozenW(tab) { var w = 0, fc = frozenCount(tab); for (var c = 0; c < fc; c++) w += colW(tab, c); return w; }
  function frozenCls(tab, c) { return c < frozenCount(tab) ? ' is-first' : ''; }
  function frozenLeft(tab, c) { return c < frozenCount(tab) ? ';left:' + tab.colLeft[c] + 'px' : ''; }
  // The nearest shown column to c, looking the way the selection moved.
  function shownCol(tab, c, from) {
    if (colShown(tab, c)) return c;
    var n = tab.data.columns.length, dir = c >= from ? 1 : -1;
    for (var k = c; k >= 0 && k < n; k += dir) if (colShown(tab, k)) return k;
    for (var j = c; j >= 0 && j < n; j -= dir) if (colShown(tab, j)) return j;
    return c;
  }
  function unhiddenCount(tab) { return tab.index.size - (tab.st.rows.any ? hiddenCount(tab, 'r') : 0); }
  function hiddenRow(tab, r) { return !!(tab.st.rows.hidden[r]); }
  function emptyText(tab) {
    if (tab.sorder && tab.sorder.length && !tab.order.length) return 'Every row is in a collapsed group.';
    if (tab.index.size && tab.st.rows.any && !tab.sorder.length && !Object.keys(tab.query.filters).length && !tab.query.search) return 'Every row is hidden.';
    return '';
  }

  // ---- drawing --------------------------------------------------------------------
  function cornerHtml(tab) {
    return '<button type="button" class="ts-cmenu" data-sact="view" aria-label="Sheet view: freeze, groups, hidden rows" title="Freeze, groups, hidden rows">' + SVG.more + '</button>';
  }
  function editorMarks() { return api.canEdit(); }
  function rangeLabel(a, b) { return a === b ? String(a + 1) : (a + 1) + '–' + (b + 1); }
  function afterHead(tab) {
    var head = api.ui.head, html = '', st = tab.st;
    // Hidden columns: arrows on the line where they were (editors).
    if (editorMarks() && st.cols.any) {
      var n = tab.data.columns.length;
      for (var c2 = 0; c2 < n; c2++) {
        if (!st.cols.hidden[c2]) continue;
        var s = c2;
        while (c2 + 1 < n && st.cols.hidden[c2 + 1]) c2++;
        var x = (c2 + 1 < n ? tab.colLeft[c2 + 1] : tab.totalW) - 5;
        var lab = 'Unhide column' + (c2 > s ? 's ' + Q.columnLetter(s) + '–' + Q.columnLetter(c2) : ' ' + Q.columnLetter(s));
        html += '<button type="button" class="ts-hid is-c" data-sact="unhide" data-ax="c" data-a="' + s + '" data-b="' + c2 + '" aria-label="' + lab + '" title="' + lab + '" style="left:' + x + 'px;top:9px">' + SVG.hidC + '</button>';
      }
    }
    if (html) head.insertAdjacentHTML('beforeend', html);
  }
  function afterBody(tab, first, last, cols) {
    var ui = api.ui, st = tab.st, html = '';
    // Row outline in the gutter.
    if (st.sp && gutterW() && last >= first) {
      var top = api.rowTop(tab, first), bottom = api.rowTop(tab, last) + api.rowH(tab, last);
      st.sp.groups.forEach(function (s) {
        var x = (s.level - 1) * LANE + 2, g = st.rowGroups[s.g];
        var label = 'rows ' + rangeLabel(g.start, g.end);
        if (s.collapsed) {
          if (s.at < first || s.at > last + 1) return;
          var y = s.at < tab.order.length ? api.rowTop(tab, s.at) : api.rowTop(tab, tab.order.length - 1) + api.rowH(tab, tab.order.length - 1);
          html += '<button type="button" class="ts-otog" data-sact="tog" data-ax="r" data-g="' + s.g + '" aria-expanded="false" aria-label="Expand ' + label + ' (' + s.count + ')" title="Expand ' + label + '" style="left:' + x + 'px;top:' + Math.max(1, y - 6) + 'px">' + SVG.plus + '</button>';
          return;
        }
        if (s.i1 < s.i0) return;
        var y0 = api.rowTop(tab, s.i0), y1 = api.rowTop(tab, s.i1) + api.rowH(tab, s.i1);
        if (y1 < top || y0 > bottom) return;
        var ty = y0 + Math.max(2, (api.rowH(tab, s.i0) - 12) / 2);
        html += '<button type="button" class="ts-otog" data-sact="tog" data-ax="r" data-g="' + s.g + '" aria-expanded="true" aria-label="Collapse ' + label + '" title="Collapse ' + label + '" style="left:' + x + 'px;top:' + ty + 'px">' + SVG.minus + '</button>';
        if (y1 - ty > 18) html += '<span class="ts-obr" style="left:' + (x + 5) + 'px;top:' + (ty + 12) + 'px;height:' + (y1 - ty - 15) + 'px"></span>';
      });
    }
    if (st.sp && editorMarks()) {
      var W = api.numW();
      st.sp.hidden.forEach(function (run) {
        if (run.at < first || run.at > last + 1) return;
        var n = tab.order.length, y = run.at < n ? api.rowTop(tab, run.at) : (n ? api.rowTop(tab, n - 1) + api.rowH(tab, n - 1) : 0);
        var lab = 'Unhide row' + (run.end > run.start ? 's ' + rangeLabel(run.start, run.end) : ' ' + (run.start + 1));
        html += '<button type="button" class="ts-hid is-r" data-sact="unhide" data-ax="r" data-a="' + run.start + '" data-b="' + run.end + '" aria-label="' + lab + '" title="' + lab + '" style="left:' + (W - 18) + 'px;top:' + Math.max(0, y - 5) + 'px">' + SVG.hidR + '</button>';
      });
    }
    ui.outline.innerHTML = html;
    // Frozen rows: the first rows of the view, drawn again over the body's top.
    var f = frozenRows(tab), fr = ui.frozen;
    if (f && last >= first) {
      var fh = frozenH(tab);
      fr.innerHTML = api.rowsHtml(tab, 0, f - 1, cols);
      fr.style.top = api.HEAD_H + 'px';
      fr.style.height = fh + 'px';
      fr.style.marginBottom = -fh + 'px';
      fr.style.width = tab.totalW + 'px';
    } else if (fr.firstChild || fr.style.height) {
      fr.textContent = '';
      fr.style.height = fr.style.marginBottom = '';
    }
  }

  // ---- flat view (a small sheet in a prose doc) and phone cards -----------------------
  function flatSummary(tab, i, cards, ncols) {
    var st = tab.st;
    if (!st.sp) return '';
    var out = '';
    st.sp.groups.forEach(function (s) {
      if (!s.collapsed || s.at !== i) return;
      var g = st.rowGroups[s.g], c0 = shownCol(tab, 0, 0);
      var name = tab.index.cols[c0] ? tab.index.cols[c0].text[g.start] : '';
      var label = s.count + (s.count === 1 ? ' row' : ' rows') + (name ? ' · ' + name.split('\n')[0] + (s.count > 1 ? ' …' : '') : '');
      var b = '<button type="button" data-otog="' + s.g + '" aria-expanded="false" aria-label="Show ' + s.count + ' grouped rows">' + SVG.plus + '<span>' + api.esc(label) + '</span></button>';
      out += cards ? '<div class="ts-card ts-fsum" role="listitem">' + b + '</div>' : '<tr class="ts-fsum"><td colspan="' + ncols + '">' + b + '</td></tr>';
    });
    return out;
  }
  function flatToggle(tab, i) {
    var st = tab.st;
    if (!st.sp) return '';
    var out = '';
    st.sp.groups.forEach(function (s) {
      if (s.collapsed || s.i0 !== i || s.i1 < s.i0) return;
      out += '<button type="button" class="ts-ftog" data-otog="' + s.g + '" aria-expanded="true" aria-label="Collapse these ' + (s.i1 - s.i0 + 1) + ' grouped rows" title="Collapse group">' + SVG.minus + '</button>';
    });
    return out;
  }
  function flatClick(e) {
    var b = e.target.closest && e.target.closest('[data-otog]');
    if (!b) return false;
    e.stopPropagation();
    toggle(cur(), 'r', Number(b.getAttribute('data-otog')));
    return true;
  }

  // ---- collapse / expand --------------------------------------------------------------
  function groupsOf(tab, ax) { return ax === 'r' ? tab.st.rowGroups : tab.st.colGroups; }
  function axisOf(tab, ax) { return ax === 'r' ? tab.st.rows : tab.st.cols; }
  function idsOf(tab, ax) { return ax === 'r' ? tab.st.rowIds : tab.st.colKeys; }
  function elOf(tab, ax, i) { return ax === 'r' ? tab.data.rows[i].tr : tab.data.columns[i].th; }
  function collapsedNow(tab, ax, g) { return O.isCollapsed(g, axisOf(tab, ax), idsOf(tab, ax), tab.ov[ax]); }
  // Groups in a view change: in Edit mode the document's default, else the view's.
  function setCollapsed(tab, ax, list) {
    if (!list.length) return;
    if (api.canEdit()) {
      var els = list.map(function (x) { return elOf(tab, ax, x.g.start); });
      docChange(tab, els, ATTRS, function () {
        list.forEach(function (x) { O.writeCollapsed(elOf(tab, ax, x.g.start), x.g.level, x.on); delete tab.ov[ax][O.groupKey(x.g, idsOf(tab, ax))]; });
      });
      return;
    }
    list.forEach(function (x) { tab.ov[ax][O.groupKey(x.g, idsOf(tab, ax))] = x.on; });
    refresh(tab);
    api.saveView();
  }
  function toggle(tab, ax, gi) {
    var g = groupsOf(tab, ax)[gi];
    if (!g) return;
    setCollapsed(tab, ax, [{ g: g, on: !collapsedNow(tab, ax, g) }]);
  }
  // Show levels below k only (k > max: everything open).
  function showLevel(tab, ax, k) {
    setCollapsed(tab, ax, groupsOf(tab, ax).map(function (g) { return { g: g, on: g.level >= k }; }).filter(function (x) { return collapsedNow(tab, ax, x.g) !== x.on; }));
  }
  // Open every collapsed group holding row r (column c): a search match or a
  // comment there is then in view. The reader's view only, never the document.
  function expandTo(tab, r, c) {
    var changed = false;
    [['r', r], ['c', c]].forEach(function (p) {
      if (p[1] == null) return;
      groupsOf(tab, p[0]).forEach(function (g) {
        if (p[1] >= g.start && p[1] <= g.end && collapsedNow(tab, p[0], g)) { tab.ov[p[0]][O.groupKey(g, idsOf(tab, p[0]))] = false; changed = true; }
      });
    });
    if (!changed) return;
    readCols(tab);
    api.runTab(tab);
    api.layout();
    api.saveView();
  }
  // After a view-only change: the active cell stays on its row where it can.
  function refresh(tab) {
    var sel = api.sel, keep = tab.order && tab.order[sel.r];
    readCols(tab);
    api.runTab(tab);
    var p = keep != null ? tab.pos[keep] : -1;
    if (p >= 0) { var d = sel.r2 - sel.r; sel.r = p; sel.r2 = Math.max(0, Math.min(tab.order.length - 1, p + d)); }
    else { sel.r = Math.min(sel.r, Math.max(0, tab.order.length - 1)); sel.r2 = sel.r; }
    sel.c = shownCol(tab, sel.c, sel.c); sel.c2 = shownCol(tab, sel.c2, sel.c2);
    api.renderBar(); api.layout(); api.renderHead(); api.renderBody(true);
    api.relayout();
  }

  // ---- document changes: attributes, with an undo ------------------------------------------
  var pending = null;
  // Someone who may edit the doc changes it in Edit mode (asked for when in
  // another; the change lands once it is on, after the editor's baseline).
  function docChange(tab, els, attrs, fn) {
    if (api.mode() !== 'edit') {
      pending = { tab: tab, els: els, attrs: attrs, fn: fn };
      api.post({ type: 'tdoc:requestMode', mode: 'edit' });
      return;
    }
    var snap = function () { return els.map(function (el) { var o = {}; attrs.forEach(function (a) { o[a] = el.getAttribute(a); }); return o; }); };
    var put = function (list) { els.forEach(function (el, k) { attrs.forEach(function (a) { if (list[k][a] == null) el.removeAttribute(a); else el.setAttribute(a, list[k][a]); }); }); };
    var before = snap();
    fn();
    var after = snap();
    if (JSON.stringify(before) === JSON.stringify(after)) { refresh(tab); return; }
    api.record({ tab: tab, undo: function () { put(before); }, redo: function () { put(after); } });
    api.afterChange(tab, tab.order[api.sel.r]);
  }
  function onMode(m) {
    var p = pending; pending = null;
    if (!p) return;
    setTimeout(function () {
      if (m === 'edit' && api.mode() === 'edit' && api.book && api.book.tabs.indexOf(p.tab) >= 0) docChange(p.tab, p.els, p.attrs, p.fn);
    }, 0);
  }
  function needSort(tab) {
    if (!tab.query.sort.length) return false;
    api.toast('Clear the sort first: groups and row order follow the document, not a sorted view.');
    return true;
  }
  // The document rows of view rows a..b.
  function viewRows(tab, a, b) { var out = []; for (var i = a; i <= b; i++) if (tab.order[i] != null) out.push(tab.order[i]); return out; }
  function regroup(tab, ax, a, b, delta) {
    if (ax === 'r' && needSort(tab)) return;
    var axis = axisOf(tab, ax), next = O.regroup(axis.level, a, b, delta), els = [];
    for (var i = a; i <= b; i++) if (next[i] !== axis.level[i]) els.push(i);
    if (!els.length) { api.toast(delta > 0 ? 'Groups go ' + O.MAX_LEVEL + ' levels deep at most.' : 'Nothing there is grouped.'); return; }
    var nodes = els.map(function (i) { return elOf(tab, ax, i); });
    docChange(tab, nodes, ATTRS, function () { els.forEach(function (i, k) { O.writeLevel(nodes[k], next[i]); }); });
  }
  function groupRows(tab, ra, rb, delta) {
    var rows = viewRows(tab, ra, rb);
    if (!rows.length) return;
    regroup(tab, 'r', Math.min.apply(null, rows), Math.max.apply(null, rows), delta);
  }
  function setHidden(tab, ax, list, on) {
    if (!list.length) return;
    if (on && ax === 'c') {
      var left = 0;
      tab.data.columns.forEach(function (col, c) { if (!tab.st.cols.hidden[c] && list.indexOf(c) < 0) left++; });
      if (!left) { api.toast('A sheet shows at least one column.'); return; }
    }
    var nodes = list.map(function (i) { return elOf(tab, ax, i); });
    docChange(tab, nodes, ATTRS, function () { nodes.forEach(function (el) { O.writeHidden(el, on); }); });
  }
  function unhideRange(tab, ax, a, b) { var list = []; for (var i = a; i <= b; i++) if (axisOf(tab, ax).hidden[i]) list.push(i); setHidden(tab, ax, list, false); }
  function unhideAll(tab, ax) { unhideRange(tab, ax, 0, axisOf(tab, ax).level.length - 1); }
  function hiddenCount(tab, ax) { var n = 0, hd = axisOf(tab, ax).hidden; for (var i = 0; i < hd.length; i++) n += hd[i]; return n; }

  // ---- freeze ----------------------------------------------------------------------------------
  function setFreeze(tab, rows, cols) {
    if (api.config.canEditDoc) {
      docChange(tab, [tab.table], FREEZE_ATTRS, function () {
        O.writeFreeze(tab.table, rows, cols);
        if (rows !== undefined) delete tab.ov.fr;
        if (cols !== undefined) delete tab.ov.fc;
      });
      return;
    }
    if (rows !== undefined) tab.ov.fr = O.cleanFreeze(rows, 0);
    if (cols !== undefined) tab.ov.fc = O.cleanFreeze(cols, 1);
    refresh(tab);
    api.saveView();
  }
  function freezeItems(tab) {
    var fr = tab.ov.fr != null ? tab.ov.fr : tab.st.table.freezeRows, fc = frozenCount(tab), sel = api.sel;
    var upR = Math.max(sel.r, sel.r2) + 1, upC = Math.max(sel.c, sel.c2) + 1;
    var items = [{ header: 'Freeze' }];
    [0, 1, 2].forEach(function (n) { items.push({ label: n ? n + (n === 1 ? ' row' : ' rows') : 'No rows', checked: fr === n, onSelect: function () { setFreeze(tab, n, undefined); } }); });
    if (upR > 2 && upR <= O.MAX_FREEZE) items.push({ label: 'Up to row ' + upR, checked: fr === upR, onSelect: function () { setFreeze(tab, upR, undefined); } });
    [0, 1, 2].forEach(function (n) { items.push({ label: n ? n + (n === 1 ? ' column' : ' columns') : 'No columns', checked: fc === n, onSelect: function () { setFreeze(tab, undefined, n); } }); });
    if (upC > 2 && upC <= O.MAX_FREEZE) items.push({ label: 'Up to column ' + Q.columnLetter(upC - 1), checked: fc === upC, onSelect: function () { setFreeze(tab, undefined, upC); } });
    return items;
  }
  // The corner's menu: freeze, groups by level, what is hidden.
  function viewMenu(anchor) {
    var tab = cur(), st = tab.st, items = freezeItems(tab);
    if (st.rowMax) {
      items.push({ header: 'Row groups' });
      items.push({ label: 'Expand all', onSelect: function () { showLevel(tab, 'r', O.MAX_LEVEL + 1); } });
      items.push({ label: 'Collapse all', onSelect: function () { showLevel(tab, 'r', 1); } });
      // Excel's level buttons: open the outer levels, fold level k and deeper.
      for (var k = 2; k <= st.rowMax; k++) (function (k) { items.push({ label: 'Collapse level ' + k, onSelect: function () { showLevel(tab, 'r', k); } }); })(k);
      if (st.flat) items.push({ label: 'Sorted: groups show open', disabled: true, onSelect: function () {} });
    }
    if (api.canEdit()) {
      var hr = hiddenCount(tab, 'r'), hc = hiddenCount(tab, 'c');
      if (hr || hc) items.push({ header: 'Hidden' });
      if (hr) items.push({ label: 'Unhide ' + hr + (hr === 1 ? ' row' : ' rows'), onSelect: function () { unhideAll(tab, 'r'); } });
      if (hc) items.push({ label: 'Unhide ' + hc + (hc === 1 ? ' column' : ' columns'), onSelect: function () { unhideAll(tab, 'c'); } });
    }
    api.openMenu(anchor, items, 'Sheet view');
  }
  function groupMenu(tab, ax, gi, anchor) {
    var g = groupsOf(tab, ax)[gi];
    if (!g) return;
    var items = [
      { label: collapsedNow(tab, ax, g) ? 'Expand group' : 'Collapse group', onSelect: function () { toggle(tab, ax, gi); } },
      { label: 'Expand all', onSelect: function () { showLevel(tab, ax, O.MAX_LEVEL + 1); } },
      { label: 'Collapse all', onSelect: function () { showLevel(tab, ax, 1); } },
    ];
    if (api.canEdit()) items.push('sep', { label: 'Remove group', onSelect: function () { regroup(tab, ax, g.start, g.end, -1); } });
    api.openMenu(anchor, items, 'Group');
  }

  // ---- menus the viewer adds to ------------------------------------------------------------
  function rowItems(tab, ra, rb) {
    var n = rb - ra + 1, rows = viewRows(tab, ra, rb), sorted = tab.query.sort.length > 0;
    var lo = Math.min.apply(null, rows), hi = Math.max.apply(null, rows), grouped = false;
    for (var r = lo; r <= hi; r++) if (tab.st.rows.level[r]) grouped = true;
    var label = rangeLabel(lo, hi);
    var items = ['sep',
      { label: 'Hide ' + (n > 1 ? n + ' rows' : 'row'), onSelect: function () { setHidden(tab, 'r', rows, true); } },
      'sep',
      { label: 'Group rows ' + label, disabled: sorted, onSelect: function () { groupRows(tab, ra, rb, 1); } },
    ];
    if (grouped) items.push({ label: 'Ungroup rows ' + label, disabled: sorted, onSelect: function () { groupRows(tab, ra, rb, -1); } });
    if (rb + 1 <= O.MAX_FREEZE) items.push({ label: 'Freeze up to row ' + (rb + 1), onSelect: function () { setFreeze(tab, rb + 1, undefined); } });
    return items;
  }
  function columnItems(tab, c) {
    var items = [];
    if (c + 1 <= O.MAX_FREEZE) items.push({ label: frozenCount(tab) === c + 1 ? 'Unfreeze columns' : 'Freeze up to this column', onSelect: function () { setFreeze(tab, undefined, frozenCount(tab) === c + 1 ? 0 : c + 1); } });
    if (!api.canEdit()) return items;
    var sel = api.sel, ca = Math.min(sel.c, sel.c2), cb = Math.max(sel.c, sel.c2);
    if (c < ca || c > cb) ca = cb = c;
    var many = cb > ca, label = Q.columnLetter(ca) + (many ? '–' + Q.columnLetter(cb) : '');
    var list = []; for (var j = ca; j <= cb; j++) list.push(j);
    items.push('sep', { label: 'Hide ' + (many ? 'columns ' : 'column ') + label, onSelect: function () { setHidden(tab, 'c', list, true); } });
    return items;
  }

  // ---- tabs: reorder, delete with undo -------------------------------------------------------------
  function nodeOf(table) {
    var p = table.parentElement;
    return p && p.classList.contains('tdoc-table-scroll') && p.children.length === 1 ? p : table;
  }
  // Tab `from` to position `to` in the strip (and its table in the document).
  function moveTab(from, to) {
    var book = api.book, tabs = book.tabs;
    to = Math.max(0, Math.min(tabs.length - 1, to));
    if (from === to) return;
    var tab = tabs[from], active = tabs[book.active], node = nodeOf(tab.table);
    var parent = node.parentNode, next = node.nextSibling;
    var order = tabs.slice(); order.splice(from, 1); order.splice(to, 0, tab);
    var place = function () {
      var after = order[to - 1], before = order[to + 1];
      if (before) { var b = nodeOf(before.table); b.parentNode.insertBefore(node, b); }
      else { var a = nodeOf(after.table); a.parentNode.insertBefore(node, a.nextSibling); }
      book.tabs = order.slice(); book.active = book.tabs.indexOf(active);
    };
    var prev = tabs.slice();
    place();
    api.record({ tab: tab,
      undo: function () { parent.insertBefore(node, next); book.tabs = prev.slice(); book.active = Math.max(0, book.tabs.indexOf(active)); },
      redo: place });
    api.renderAll(); api.changed(); api.relayout(); api.saveView();
  }
  function tabItems(i, anchor) {
    var n = api.book.tabs.length;
    return [
      { label: 'Move left', disabled: i === 0, onSelect: function () { moveTab(i, i - 1); } },
      { label: 'Move right', disabled: i >= n - 1, onSelect: function () { moveTab(i, i + 1); } },
    ];
  }
  // Delete at once, with Undo in the toast (no confirm step to click through).
  var undoToast = null;
  function deleteTabWithUndo(i) {
    var name = api.book.tabs[i].name;
    api.deleteTab(i);
    var op = api.undoStack[api.undoStack.length - 1];
    if (undoToast) undoToast.remove();
    var t = undoToast = api.provider(h('div', 'ts-toast'));
    t.setAttribute('role', 'status');
    t.appendChild(h('span', null, 'Deleted "' + name + '". '));
    var b = h('button', 'ts-link', 'Undo'); b.type = 'button';
    b.style.color = '#9db6ff';
    // Above the page's footer bar, which can cover the frame's last 48px.
    t.style.bottom = '72px';
    b.addEventListener('click', function (e) {
      e.stopPropagation(); t.remove();
      if (api.undoStack[api.undoStack.length - 1] === op) api.undo(false);
    });
    t.appendChild(b);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 8000);
  }
  function decorateTab(b, tab, i, editing) {
    if (!editing) return;
    var press = null;
    b.addEventListener('pointerdown', function (e) {
      press = { x: e.clientX, type: e.pointerType, active: api.book.active === i };
      if (e.button !== 0 || e.pointerType === 'touch') return;
      var moving = false, guide = null;
      var target = function (x) {
        var list = Array.prototype.filter.call(api.ui.tabs.children, function (el) { return el.classList.contains('ts-tab'); });
        var k = 0;
        list.forEach(function (el, j) { var r = el.getBoundingClientRect(); if (x > r.left + r.width / 2) k = j + 1; });
        return { k: k, list: list };
      };
      var move = function (ev) {
        if (!moving && Math.abs(ev.clientX - press.x) < 6) return;
        if (!moving) { moving = true; b.classList.add('is-drag'); guide = api.provider(h('div', 'ts-guide')); document.body.appendChild(guide); }
        var t = target(ev.clientX), el = t.list[Math.min(t.k, t.list.length - 1)], r = el.getBoundingClientRect();
        guide.style.left = (t.k >= t.list.length ? r.right : r.left) - 1 + 'px'; guide.style.top = r.top + 'px'; guide.style.height = r.height + 'px';
      };
      var up = function (ev) {
        document.removeEventListener('pointermove', move, true); document.removeEventListener('pointerup', up, true);
        if (!moving) return;
        b.classList.remove('is-drag'); if (guide) guide.remove();
        swallowClick();
        var k = target(ev.clientX).k;
        moveTab(i, k > i ? k - 1 : k);
      };
      document.addEventListener('pointermove', move, true); document.addEventListener('pointerup', up, true);
    });
    // A finger has no right click: a tap on the open tab opens its menu.
    b.addEventListener('click', function () {
      if (press && press.type !== 'mouse' && press.active) b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      press = null;
    });
  }
  function swallowClick() {
    var stop = function (e) { e.stopPropagation(); e.preventDefault(); document.removeEventListener('click', stop, true); };
    document.addEventListener('click', stop, true);
    setTimeout(function () { document.removeEventListener('click', stop, true); }, 0);
  }

  // ---- pointer: toggles and markers ---------------------------------------------------------------
  function wire() {
    var ui = api.ui;
    var onClick = function (e) {
      var b = e.target.closest && e.target.closest('[data-sact]');
      if (!b) return;
      var act = b.getAttribute('data-sact'), tab = cur();
      e.preventDefault(); e.stopPropagation();
      if (act === 'tog') toggle(tab, b.getAttribute('data-ax'), Number(b.getAttribute('data-g')));
      else if (act === 'unhide') unhideRange(tab, b.getAttribute('data-ax'), Number(b.getAttribute('data-a')), Number(b.getAttribute('data-b')));
      else if (act === 'view') viewMenu(b);
    };
    var onMenu = function (e) {
      var b = e.target.closest && e.target.closest('[data-sact="tog"]');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      groupMenu(cur(), b.getAttribute('data-ax'), Number(b.getAttribute('data-g')), b);
    };
    [ui.outline, ui.head].forEach(function (el) { el.addEventListener('click', onClick); el.addEventListener('contextmenu', onMenu); });
    // Keys on a toggle are the toggle's, not the grid's.
    [ui.outline, ui.head].forEach(function (el) { el.addEventListener('keydown', function (e) { if (e.target.closest && e.target.closest('[data-sact]') && (e.key === 'Enter' || e.key === ' ')) { e.stopPropagation(); } }); });
  }

  // ---- keyboard: Alt+Shift+→ / ← group and ungroup rows (as in Google Sheets) ----------------------
  function onKey(e) {
    if (e.target && e.target.closest && e.target.closest('[data-sact]')) return 'skip';
    if (!e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') || !api.canEdit()) return false;
    var sel = api.sel;
    groupRows(cur(), Math.min(sel.r, sel.r2), Math.max(sel.r, sel.r2), e.key === 'ArrowRight' ? 1 : -1);
    return true;
  }

  // ---- view state: expanded / collapsed groups, a reader's freeze ------------------------------------
  function viewState(tab) {
    var ov = tab.ov, o = {}, any = false;
    ['r', 'c'].forEach(function (ax) {
      var keys = Object.keys(ov[ax] || {}).slice(0, 2000);
      if (!keys.length) return;
      o[ax] = {}; keys.forEach(function (k) { o[ax][k] = !!ov[ax][k]; }); any = true;
    });
    if (ov.fr != null) { o.fr = ov.fr; any = true; }
    if (ov.fc != null) { o.fc = ov.fc; any = true; }
    return any ? o : null;
  }
  function applyViewState(tab, o) {
    if (!o || typeof o !== 'object') return;
    var ov = tab.ov = { r: Object.create(null), c: Object.create(null) };
    ['r', 'c'].forEach(function (ax) {
      var src = o[ax];
      if (!src || typeof src !== 'object' || Array.isArray(src)) return;
      Object.keys(src).slice(0, 2000).forEach(function (k) { if (typeof src[k] === 'boolean' && /^[1-3]:/.test(k) && k.length <= 210) ov[ax][k] = src[k]; });
    });
    // A reader's freeze only: an editor's is the document's.
    if (!api.config.canEditDoc) {
      if (o.fr != null) ov.fr = O.cleanFreeze(o.fr, 0);
      if (o.fc != null) ov.fc = O.cleanFreeze(o.fc, 1);
    }
    readCols(tab);
  }
  function describe(tab) {
    var st = tab.st;
    return {
      rowLevels: st.rowMax, gutter: gutterW(),
      frozenRows: frozenRows(tab), frozenCols: frozenCount(tab),
      hiddenRows: hiddenCount(tab, 'r'), hiddenCols: hiddenCount(tab, 'c'),
      shown: tab.order.length, rows: tab.sorder ? tab.sorder.length : tab.order.length,
      shownCols: tab.data.columns.filter(function (c, i) { return colShown(tab, i); }).length,
      groups: st.sp ? st.sp.groups.map(function (s) { return { level: s.level, collapsed: s.collapsed, count: s.count, key: s.key }; }) : [],
      view: viewState(tab),
    };
  }

  return {
    read: read, run: run, spans: spans, gutterW: gutterW, colShown: colShown, colW: colW,
    frozenCount: frozenCount, frozenRows: frozenRows, frozenH: frozenH, frozenW: frozenW, frozenCls: frozenCls, frozenLeft: frozenLeft,
    shownCol: shownCol, hiddenRow: hiddenRow, unhiddenCount: unhiddenCount, emptyText: emptyText, cornerHtml: cornerHtml, afterHead: afterHead, afterBody: afterBody,
    flatSummary: flatSummary, flatToggle: flatToggle, flatClick: flatClick, expandTo: expandTo, onMode: onMode,
    rowItems: rowItems, columnItems: columnItems, tabItems: tabItems, deleteTabWithUndo: deleteTabWithUndo, decorateTab: decorateTab,
    wire: wire, onKey: onKey, viewState: viewState, applyViewState: applyViewState, describe: describe,
  };
}
