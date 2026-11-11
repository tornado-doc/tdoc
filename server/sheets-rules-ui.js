// Sheets: Find and replace, conditional formatting, dropdowns and the fill
// handle, the in-frame half (shared/sheet-rules.mjs is the pure half).
// Inlined by server/sheets-source.js before server/sheets-viewer.js, which
// calls SheetRulesUI.install(api) once and then the returned hooks at a few
// places marked [sheet-rules]. Nothing here keeps its own copy of the grid:
// it reads the viewer's tabs and writes through its setCells / record /
// afterChange, so every change is one step of the sheet's Undo and reaches
// the editor's draft and Save like any other edit.
//
//   Find and replace   a compact popover from the search box (⌘⇧H / Ctrl+H):
//                      match case, entire cell, this tab or every tab;
//                      Replace all is one Undo.
//   Rules panel        one side panel (a bottom sheet on a phone) with two
//                      lists, Conditional formatting and Dropdowns, opened
//                      from a column's or the selection's menu in Edit mode.
//                      Saved on the table as data-format-rules /
//                      data-validation (JSON, never CSS).
//   Fill handle        a dot at the selection's corner in Edit mode: drag it
//                      down / up / right / left to continue a number or date
//                      series, hold Ctrl (⌘ or Option) to copy instead.
// Read mode shows the formats and the dropdown chips, and nothing else.
var SheetRulesUI = (function () {
  'use strict';
  function install(A) {
    var Q = A.Q, R = A.R, h = A.h, ICON = A.ICON;
    var REPLACE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h12.5M13 4.5 16.5 8 13 11.5M20 16H7.5M11 12.5 7.5 16l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var CARET = '<i aria-hidden="true">▾</i>';

    var style = A.provider(document.createElement('style'));
    style.textContent = [
      // dropdown chips (data validation), soft tints from the palette
      '.ts-dd{display:inline-flex;align-items:center;gap:3px;max-width:100%;min-width:0;padding:0 8px;border-radius:999px;font-size:12px;line-height:20px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ts-dd i{flex:none;font-style:normal;font-size:9px;opacity:.55;cursor:pointer}',
      '.ts-dd.is-empty{padding:0 4px;color:#9a9aa3;background:transparent}',
      '.ts-c.is-dd{gap:4px}',
      // an invalid value (Edit mode only): a small corner mark with its reason
      '.ts-inv{position:absolute;top:0;left:0;width:0;height:0;border-style:solid;border-width:7px 7px 0 0;border-color:#e5484d transparent transparent transparent;z-index:1}',
      // fill handle: a small dot at the selection's corner
      '.ts-fill{position:absolute;z-index:3;width:9px;height:9px;border-radius:50%;background:var(--ts-accent);box-shadow:0 0 0 2px #fff;cursor:crosshair;touch-action:none}',
      '.ts-fill::before{content:"";position:absolute;inset:-7px}',
      '@media (pointer:coarse){.ts-fill{width:12px;height:12px}.ts-fill::before{inset:-14px}}',
      '.ts-fill[hidden],.ts-fillbox[hidden]{display:none!important}',
      '.ts-fillbox{position:absolute;z-index:3;border:1.5px dashed var(--ts-accent);border-radius:2px;pointer-events:none}',
      '.tdoc-sheet.is-filling,.tdoc-sheet.is-filling *{cursor:crosshair!important}',
      // the side panel: the popover component, docked
      '.ts-pop.ts-side{left:auto;right:12px;top:12px;width:320px;max-height:calc(100vh - 24px);padding:0;display:flex;flex-direction:column;overflow:hidden}',
      '.ts-side-hd{flex:none;display:flex;align-items:center;gap:4px;padding:8px 6px 0 8px}',
      '.ts-side-hd .ts-seg{flex:1;margin:0}',
      '.ts-side-hd .ts-seg button{font-size:12px;height:28px;padding:0 6px;white-space:nowrap}',
      '.ts-side-hd .ts-icon{width:28px;height:28px;border:0;border-radius:6px;background:transparent;display:inline-flex;align-items:center;justify-content:center;color:#666}',
      '.ts-side-hd .ts-icon:hover{background:#f0f1f4}',
      '.ts-side-bd{flex:1 1 auto;overflow:auto;padding:8px 8px 10px}',
      '.ts-side-bd .ts-note{margin:6px 4px 10px;color:#666;font-size:12px}',
      '.ts-rule{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;margin:0 0 6px;padding:6px 6px 6px 8px;border:1px solid #e6e6ea;border-radius:8px;background:#fff;text-align:left;cursor:pointer}',
      '.ts-rule:hover{background:#fafafb}',
      '.ts-rule-t{flex:1;min-width:0}.ts-rule-t b{display:block;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ts-rule-t small{display:block;color:#777;font-size:12px}',
      '.ts-rule .ts-icon{width:26px;height:26px;border:0;border-radius:6px;background:transparent;display:inline-flex;align-items:center;justify-content:center;color:#888}',
      '.ts-rule .ts-icon:hover{background:#eef0f3;color:#17171a}',
      '.ts-rule .ts-icon svg{width:14px;height:14px}',
      '.ts-sw-prev{flex:none;width:34px;height:24px;border-radius:6px;border:1px solid #e6e6ea;display:flex;align-items:center;justify-content:center;font-size:12px;background:#fff;overflow:hidden}',
      '.ts-add-rule{display:flex;align-items:center;gap:6px;width:100%;height:34px;padding:0 10px;border:1px dashed #d0d0d8;border-radius:8px;background:transparent;color:#55555f}',
      '.ts-add-rule:hover{border-color:#1652f0;color:#1652f0}',
      '.ts-lbl{display:block;margin:10px 4px 2px;color:#666;font-size:12px;font-weight:600}',
      '.ts-pick{display:flex;align-items:center;justify-content:space-between;gap:8px;width:calc(100% - 8px);height:32px;margin:4px;padding:0 10px;border:1px solid #d6d6dc;border-radius:8px;background:#fff;text-align:left}',
      '.ts-pick:hover{background:#fafafb}',
      '.ts-sws{display:flex;flex-wrap:wrap;gap:6px;margin:4px}',
      '.ts-sw{position:relative;width:22px;height:22px;padding:0;border:1px solid rgba(0,0,0,.1);border-radius:50%}',
      '.ts-sw[aria-pressed="true"]{box-shadow:0 0 0 2px #fff,0 0 0 4px #1652f0}',
      '.ts-preview{margin:8px 4px 2px;padding:6px 10px;border:1px solid #e6e6ea;border-radius:8px}',
      '.ts-err{margin:6px 4px 0;color:#b42318;font-size:12px}',
      '.ts-side .ts-actions{margin:12px 4px 2px}',
      '.ts-actions .ts-grow{flex:1}',
      '.ts-actions button.is-danger{color:#b42318;border-color:transparent;background:transparent;padding:0 6px}',
      // Find and replace: compact
      '.ts-pop.ts-find{width:300px}',
      '.ts-find .ts-field{margin:4px}',
      '.ts-find .ts-opts{display:flex;flex-wrap:wrap;gap:0 10px;margin:2px 4px}',
      '.ts-find .ts-opts label{display:flex;align-items:center;gap:5px;min-height:26px;color:#444;font-size:12px;cursor:pointer}',
      '.ts-find .ts-opts input{margin:0;accent-color:#1652f0}',
      '.ts-find .ts-seg button{height:26px;font-size:12px}',
      '.ts-find-st{min-height:16px;margin:2px 8px;color:#666;font-size:12px}',
      '.ts-find .ts-actions{justify-content:flex-end}',
      '.ts-find .ts-actions button{padding:0 10px}',
      '.ts-mi .ts-dd{max-width:220px}',
      '@media (max-width:640px){.ts-pop.ts-side{width:100%;max-height:75vh}.ts-side .ts-actions{margin-right:84px}.ts-sw{width:30px;height:30px}.ts-pick{height:40px}.ts-pop.ts-find{width:100%}.ts-side-hd .ts-seg button{height:34px}}',
    ].join('');
    document.head.appendChild(style);

    var numCtx = { parseNumber: Q.parseNumber, parseDate: Q.parseDate, colors: Q.TAG_COLORS };
    var fillCtx = { parseDate: Q.parseDate, formatDate: Q.formatDate };
    function keysOf(tab) { return tab.data.columns.map(function (_, c) { return A.colKey(tab, c); }); }
    function letter(c) { return Q.columnLetter(c); }
    function cellText(tab, r, c) { var col = tab.index.cols[c]; return col.text[r]; }
    function orderOf(tab) { return tab.order || Q.runQuery(tab.index, tab.query); }
    function stop(el) { ['keydown', 'keyup', 'input', 'beforeinput', 'paste', 'copy', 'cut'].forEach(function (t) { el.addEventListener(t, function (e) { e.stopPropagation(); }); }); }
    function button(cls, label, fn) {
      var b = h('button', cls || null, label); b.type = 'button';
      if (fn) b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn(e); });
      return b;
    }
    function seg(options, value, onPick, label) {
      var s = h('div', 'ts-seg'); s.setAttribute('role', 'group'); if (label) s.setAttribute('aria-label', label);
      options.forEach(function (o) {
        var b = button('', o[1], function () { Array.prototype.forEach.call(s.children, function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); }); onPick(o[0]); });
        b.setAttribute('aria-pressed', o[0] === value ? 'true' : 'false');
        s.appendChild(b);
      });
      return s;
    }
    function field(placeholder, value, label) {
      var f = h('label', 'ts-field'), i = h('input');
      i.value = value || ''; i.placeholder = placeholder; i.setAttribute('aria-label', label || placeholder); i.spellcheck = false;
      f.appendChild(i);
      return { el: f, input: i };
    }

    // ---- reading the table's rules -----------------------------------------------
    function readTab(tab) {
      var t = tab.table;
      tab.fmtRules = R.parseFormatRules(t.getAttribute(R.FORMAT_ATTR));
      tab.validRules = R.parseValidation(t.getAttribute(R.VALIDATION_ATTR));
      var keys = keysOf(tab);
      tab.fmt = tab.fmtRules.length ? R.evaluateFormats(tab.fmtRules, { keys: keys, types: tab.index.cols.map(function (c) { return c.type; }), cols: tab.index.cols, size: tab.index.size }, numCtx, tab.fmt) : null;
      tab.valid = tab.validRules.length ? R.validationByColumn(tab.validRules, keys) : null;
    }
    var CHIP = 'background:' + Q.TAG_COLORS.gray[0] + ';color:' + Q.TAG_COLORS.gray[1];
    function isDropdown(rule, type) { return !!rule && type !== 'tags' && type !== 'checkbox'; }

    // ---- drawing a cell ----------------------------------------------------------------
    // A format's fill; in a dropdown column the value as a chip (a caret in
    // Edit mode) and, in Edit mode, a corner mark on a value not in the list.
    function cell(tab, r, c, needle, inner) {
      var st = tab.fmt && tab.fmt[c] && tab.fmt[c][r];
      var rule = tab.valid && tab.valid[c];
      if (!st && !rule) return null;
      var out = { cls: '', style: st ? st.css : '' };
      if (!rule) return out;
      var col = tab.index.cols[c], edit = A.canEdit();
      if (isDropdown(rule, col.type)) {
        var v = col.text[r];
        out.cls += ' is-dd';
        out.inner = v ? '<span class="ts-dd" style="' + CHIP + '">' + A.mark(v, needle) + (edit ? CARET : '') + '</span>' : edit ? '<span class="ts-dd is-empty">' + CARET + '</span>' : '';
      }
      var msg = edit && R.checkValue(rule, col.tags ? col.tags[r] : col.text[r]);
      if (msg) out.inner = '<span class="ts-inv" role="img" title="' + A.esc(msg) + '" aria-label="' + A.esc(msg) + '"></span>' + (out.inner != null ? out.inner : inner);
      return out;
    }
    function flatStyle(tab, r, c) { var st = tab.fmt && tab.fmt[c] && tab.fmt[c][r]; return st ? A.esc(st.css) : ''; }

    // ---- dropdown cells in Edit mode ----------------------------------------------------------
    function startEdit(tab, r, c, cellEl, initial) {
      var rule = tab.valid && tab.valid[c];
      if (initial == null && isDropdown(rule, tab.index.cols[c].type)) { openDropdown(tab, r, c, cellEl, rule); return true; }
      return false;
    }
    function press(e, at) {
      var tab = A.cur(), r = tab.order[at.i], rule = tab.valid && tab.valid[at.c];
      if (r == null || !isDropdown(rule, tab.index.cols[at.c].type) || !e.target.closest('.ts-dd')) return false;
      openDropdown(tab, r, at.c, at.el.isConnected ? at.el : e.target, rule);
      return true;
    }
    function openDropdown(tab, r, c, anchor, rule) {
      var values = rule.values, current = cellText(tab, r, c).trim();
      A.openPop(anchor, function (el) {
        el.setAttribute('role', 'listbox');
        el.appendChild(h('div', 'ts-ph', tab.data.columns[c].name + ' · ' + A.refLabel(tab, r, c)));
        var find = values.length > 8 ? field('Find a value', '') : null;
        if (find) el.appendChild(find.el);
        var list = h('div', 'ts-vals');
        el.appendChild(list);
        var pick = function (v) { A.closePop(true); if (v !== current) A.setCells(tab, [{ r: r, c: c, value: v }], r); };
        var draw = function () {
          var needle = find ? find.input.value.trim().toLowerCase() : '';
          list.textContent = '';
          values.filter(function (v) { return !needle || v.toLowerCase().indexOf(needle) !== -1; }).slice(0, 300).forEach(function (v) {
            var b = button('ts-mi', null, function () { pick(v); });
            b.setAttribute('role', 'option');
            b.setAttribute('aria-selected', v.toLowerCase() === current.toLowerCase() ? 'true' : 'false');
            if (v.toLowerCase() === current.toLowerCase()) b.setAttribute('aria-checked', 'true');
            var chip = h('span', 'ts-dd', v); chip.setAttribute('style', CHIP);
            b.appendChild(chip);
            list.appendChild(b);
          });
          if (!list.children.length) list.appendChild(h('div', 'ts-ph', 'No values match.'));
        };
        draw();
        if (current) { el.appendChild(h('div', 'ts-sep')); el.appendChild(button('ts-mi', 'Clear', function () { pick(''); })); }
        if (find) { find.input.addEventListener('input', draw); find.input.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') { var first = list.querySelector('button'); if (first) first.click(); } }); }
        el.addEventListener('keydown', function (e) {
          var items = Array.prototype.slice.call(el.querySelectorAll('button.ts-mi'));
          var k = items.indexOf(document.activeElement);
          if (e.key === 'ArrowDown') { e.preventDefault(); (items[k + 1] || items[0]).focus(); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); (items[k - 1] || items[items.length - 1]).focus(); }
        });
        stop(el);
      }, { label: 'Pick a value for ' + A.refLabel(tab, r, c), returnFocus: A.ui.grid });
    }

    // ---- Find and replace ---------------------------------------------------------------
    var fr = { find: '', repl: '', matchCase: false, wholeCell: false, all: false };
    var replaceBtn = null;
    function mountSearch(box) {
      replaceBtn = A.iconButton(REPLACE_ICON, 'Find and replace (⌘⇧H)', function () { openFind(); });
      replaceBtn.classList.add('ts-replace');
      replaceBtn.hidden = true;
      box.appendChild(replaceBtn);
    }
    function scopeTabs() { var book = A.book(); return fr.all ? book.tabs.slice() : [A.cur()]; }
    function finder() { return R.makeFinder(fr); }
    // Matches in view order (the tabs in order, then rows as shown), capped.
    function hits(f, limit) {
      var book = A.book(), out = [];
      scopeTabs().forEach(function (tab) {
        var t = book.tabs.indexOf(tab), order = orderOf(tab), n = tab.data.columns.length;
        for (var i = 0; i < order.length && out.length < limit; i++) {
          for (var c = 0; c < n; c++) if (tab.index.cols[c].type !== 'checkbox' && f.test(cellText(tab, order[i], c))) { out.push({ t: t, i: i, c: c }); if (out.length >= limit) break; }
        }
      });
      return out;
    }
    // Every match Replace all would touch: every row, the hidden ones too.
    function countAll(f, limit) {
      var n = 0;
      scopeTabs().forEach(function (tab) {
        var w = tab.data.columns.length;
        for (var r = 0; r < tab.index.size && n < limit; r++) for (var c = 0; c < w; c++) if (tab.index.cols[c].type !== 'checkbox' && f.test(cellText(tab, r, c))) n++;
      });
      return n;
    }
    function openFind() {
      var editing = A.canEdit();
      var f0 = A.ui.search.value || '';
      if (!fr.find && f0) fr.find = f0;
      A.openPop(A.ui.searchBox, function (el) {
        el.classList.add('ts-find');
        el.appendChild(h('div', 'ts-ph', editing ? 'Find and replace' : 'Find'));
        var find = field('Find', fr.find), repl = editing ? field('Replace with', fr.repl) : null;
        el.appendChild(find.el); if (repl) el.appendChild(repl.el);
        var opts = h('div', 'ts-opts');
        [['matchCase', 'Match case'], ['wholeCell', 'Entire cell']].forEach(function (o) {
          var l = h('label'), cb = h('input'); cb.type = 'checkbox'; cb.checked = !!fr[o[0]];
          cb.addEventListener('change', function () { fr[o[0]] = cb.checked; recount(); });
          l.appendChild(cb); l.appendChild(document.createTextNode(o[1])); opts.appendChild(l);
        });
        el.appendChild(opts);
        if (A.book().tabs.length > 1) el.appendChild(seg([[false, 'This tab'], [true, 'All tabs']], fr.all, function (v) { fr.all = v; recount(); }, 'Search in'));
        var status = h('div', 'ts-find-st'); status.setAttribute('aria-live', 'polite');
        el.appendChild(status);
        var actions = h('div', 'ts-actions');
        actions.appendChild(button('', 'Find', function () { go(1); }));
        if (editing) {
          actions.appendChild(button('', 'Replace', replaceOne));
          actions.appendChild(button('is-primary', 'Replace all', replaceAll));
        }
        el.appendChild(actions);
        var say = function (text) { status.textContent = text; };
        var timer = null;
        var recount = function () {
          clearTimeout(timer);
          timer = setTimeout(function () {
            var f = finder();
            if (!f.ok) { say(''); return; }
            // The count is what Replace all changes; rows the search or a
            // filter hides are said so (Find steps through the shown ones).
            var shown = hits(f, 100000).length, all = countAll(f, 100000);
            var num = function (x) { return x >= 100000 ? A.fmt(100000) + '+' : A.fmt(x); };
            say(all ? num(all) + (all === 1 ? ' match' : ' matches') + (all > shown ? ' (incl. ' + num(all - shown) + ' hidden)' : '') : 'No matches');
          }, 120);
        };
        // The next (or previous) match after the active cell, across tabs.
        var go = function (dir) {
          var f = finder();
          if (!f.ok) { say('Type something to find.'); return; }
          var list = hits(f, 10000);
          if (!list.length) { say('No matches'); return; }
          var book = A.book(), s = A.sel(), here = { t: book.active, i: s.r, c: s.c };
          var cmp = function (a, b) { return a.t - b.t || a.i - b.i || a.c - b.c; };
          var k;
          if (dir > 0) { k = list.findIndex(function (x) { return cmp(x, here) > 0; }); if (k < 0) k = 0; }
          else { k = -1; for (var j = list.length - 1; j >= 0; j--) if (cmp(list[j], here) < 0) { k = j; break; } if (k < 0) k = list.length - 1; }
          var hit = list[k];
          if (hit.t !== book.active) { book.active = hit.t; A.renderAll(); A.saveView(); }
          A.select(hit.i, hit.c, false);
          say((k + 1) + ' of ' + A.fmt(list.length));
        };
        var newValue = function (tab, c, text) { return tab.index.cols[c].type === 'tags' ? Q.splitTags(text) : text; };
        function replaceOne() {
          var f = finder();
          if (!f.ok) { say('Type something to find.'); return; }
          var tab = A.cur(), s = A.sel(), r = tab.order[s.r], c = s.c;
          if (r != null && tab.index.cols[c].type !== 'checkbox' && f.test(cellText(tab, r, c))) {
            var next = f.replace(cellText(tab, r, c), fr.repl);
            if (next !== cellText(tab, r, c)) A.setCells(tab, [{ r: r, c: c, value: newValue(tab, c, next) }], r);
          }
          go(1);
        }
        // Every row (the search and filters do not hide any from it), every
        // tab in scope: one change, one Undo.
        function replaceAll() {
          var f = finder();
          if (!f.ok) { say('Type something to find.'); return; }
          var groups = [], cells = 0;
          scopeTabs().forEach(function (tab) {
            var list = [], n = tab.data.columns.length;
            for (var r = 0; r < tab.index.size; r++) for (var c = 0; c < n; c++) {
              if (tab.index.cols[c].type === 'checkbox') continue;
              var text = cellText(tab, r, c);
              if (!text || !f.test(text)) continue;
              var next = f.replace(text, fr.repl);
              if (next !== text) list.push({ r: r, c: c, value: newValue(tab, c, next) });
            }
            if (list.length) { groups.push({ tab: tab, list: list }); cells += list.length; }
          });
          if (!groups.length) { say('No matches'); return; }
          var cur = A.cur();
          var ops = groups.map(function (g) { return A.writeCells(g.tab, g.list); });
          A.record({ tab: cur, tabs: groups.map(function (g) { return g.tab; }),
            undo: function () { ops.slice().reverse().forEach(function (o) { o.undo(); }); },
            redo: function () { ops.forEach(function (o) { o.redo(); }); } });
          groups.forEach(function (g) { if (g.tab !== cur) A.readTab(g.tab.table, g.tab); });
          A.afterChange(cur);
          say('Replaced ' + A.fmt(cells) + (cells === 1 ? ' cell' : ' cells'));
        }
        find.input.addEventListener('input', function () { fr.find = find.input.value; recount(); });
        if (repl) repl.input.addEventListener('input', function () { fr.repl = repl.input.value; });
        find.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); } });
        if (repl) repl.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } });
        stop(el);
        recount();
        setTimeout(function () { find.input.focus({ preventScroll: true }); find.input.select(); }, 0);
      }, { label: editing ? 'Find and replace' : 'Find', returnFocus: A.ui.grid });
    }
    function key(e) {
      var k = (e.key || '').toLowerCase();
      // Edit mode only: in Read, Ctrl+H stays the browser's.
      if (A.canEdit() && ((e.metaKey && e.shiftKey && k === 'h') || (e.ctrlKey && !e.metaKey && k === 'h'))) { openFind(); return true; }
      return false;
    }

    // ---- the rules panel --------------------------------------------------------------------
    var panel = null;
    function menuItems(c) {
      return ['sep',
        { label: 'Conditional formatting…', onSelect: function () { openPanel('format', c); } },
        { label: 'Dropdown…', onSelect: function () { openPanel('valid', c); } }];
    }
    function selectionCols() {
      var tab = A.cur(), s = A.sel(), keys = keysOf(tab), out = [];
      for (var c = Math.min(s.c, s.c2); c <= Math.max(s.c, s.c2); c++) out.push(keys[c]);
      return out;
    }
    function openPanel(kind, c) {
      if (!A.canEdit()) return;
      A.closePop(true);
      if (!panel) {
        var el = A.provider(h('div', 'ts-pop ts-side'));
        el.setAttribute('role', 'dialog');
        el.setAttribute('contenteditable', 'false');
        stop(el);
        el.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !A.pop()) { e.preventDefault(); closePanel(); } });
        document.body.appendChild(el);
        panel = { el: el };
      }
      panel.kind = kind;
      panel.tab = A.cur();
      // From a column's menu: that column is the one a new rule is for.
      var s = A.sel();
      if (c != null && (c < Math.min(s.c, s.c2) || c > Math.max(s.c, s.c2))) { s.c = s.c2 = c; s.touched = true; A.renderHead(); A.renderBody(true); }
      panel.draft = null;
      // From a column with no rule of its kind yet: straight to a new one.
      var tab = panel.tab, key = c != null ? A.colKey(tab, c) : null;
      var rules = kind === 'format' ? tab.fmtRules : tab.validRules;
      if (key && !rules.some(function (x) { return x.cols.indexOf(key) !== -1; })) edit(-1);
      else draw();
      var first = panel.el.querySelector('input,button.ts-rule,button.ts-add-rule');
      if (first && !(A.NARROW && A.NARROW.matches)) first.focus({ preventScroll: true });
    }
    function closePanel() {
      if (!panel) return;
      panel.el.remove();
      panel = null;
      if (A.ui.grid) A.ui.grid.focus({ preventScroll: true });
    }
    function rulesOf(tab, kind) { return kind === 'format' ? tab.fmtRules : tab.validRules; }
    // Rules name columns by data-key. Markup from before keys gets them now
    // (in the same Undo step), and a positional '#n' becomes its column's
    // key, in both kinds of rules.
    function setRules(tab, kind, list) {
      var ths = tab.data.columns.map(function (col) { return col.th; });
      var keysBefore = ths.map(function (th) { return th.getAttribute('data-key'); });
      if (!keysBefore.some(function (k) { return !k; })) return putRules(tab, kind, list, null);
      A.ensureKeys(tab);
      var keysAfter = ths.map(function (th) { return th.getAttribute('data-key'); });
      var map = function (rule) { return Object.assign({}, rule, { cols: rule.cols.map(function (key) { var m = /^#(\d+)$/.exec(key); return m && keysAfter[Number(m[1])] ? keysAfter[Number(m[1])] : key; }) }); };
      list = list.map(map);
      var other = kind === 'format' ? R.VALIDATION_ATTR : R.FORMAT_ATTR;
      var otherBefore = tab.table.getAttribute(other);
      var otherList = (kind === 'format' ? tab.validRules : tab.fmtRules).map(map);
      var otherAfter = (kind === 'format' ? R.formatValidation(otherList) : R.formatFormatRules(otherList)) || null;
      var set = function (el, name, v) { if (v == null) el.removeAttribute(name); else el.setAttribute(name, v); };
      set(tab.table, other, otherAfter);
      return putRules(tab, kind, list, function (back) {
        ths.forEach(function (th, k) { set(th, 'data-key', back ? keysBefore[k] : keysAfter[k]); });
        set(tab.table, other, back ? otherBefore : otherAfter);
      });
    }
    function putRules(tab, kind, list, also) {
      var attr = kind === 'format' ? R.FORMAT_ATTR : R.VALIDATION_ATTR;
      var after = (kind === 'format' ? R.formatFormatRules(list) : R.formatValidation(list)) || null;
      var table = tab.table, before = table.getAttribute(attr);
      var put = function (v) { if (v == null) table.removeAttribute(attr); else table.setAttribute(attr, v); };
      if (before === after && !also) return;
      put(after);
      A.record({ tab: tab, undo: function () { put(before); if (also) also(true); }, redo: function () { put(after); if (also) also(false); } });
      A.afterChange(tab);
    }
    function header() {
      var hd = h('div', 'ts-side-hd');
      hd.appendChild(seg([['format', 'Conditional formatting'], ['valid', 'Dropdowns']], panel.kind, function (k) { panel.kind = k; panel.draft = null; draw(); }, 'Rules'));
      var x = A.iconButton(ICON.x, 'Close', closePanel);
      hd.appendChild(x);
      return hd;
    }
    function preview(rule) {
      var sw = h('span', 'ts-sw-prev', panel.kind === 'format' ? '123' : '▾');
      if (panel.kind === 'format') sw.style.background = Q.TAG_COLORS[rule.fill][0];
      return sw;
    }
    function draw() {
      var el = panel.el, tab = panel.tab = A.cur();
      el.textContent = '';
      el.setAttribute('aria-label', (panel.kind === 'format' ? 'Conditional formatting' : 'Dropdowns') + ' · ' + tab.name);
      el.appendChild(header());
      var bd = h('div', 'ts-side-bd');
      el.appendChild(bd);
      if (panel.draft) { (panel.kind === 'format' ? formatEditor : validEditor)(bd, tab); return; }
      var rules = rulesOf(tab, panel.kind), keys = keysOf(tab);
      if (panel.kind === 'format' && tab.fmt && tab.fmt.skipped) bd.appendChild(h('p', 'ts-note', 'Some rules are not shown: this sheet has too many rules × columns × rows to colour them all.'));
      if (!rules.length) bd.appendChild(h('p', 'ts-note', panel.kind === 'format' ? 'Colour cells by their value: a rule per column, the first that matches wins.' : 'Offer a list of values: cells show them as chips to pick from.'));
      rules.forEach(function (rule, k) {
        var row = h('div', 'ts-rule'); row.tabIndex = 0; row.setAttribute('role', 'button');
        row.appendChild(preview(rule));
        var t = h('span', 'ts-rule-t');
        t.appendChild(h('b', null, panel.kind === 'format' ? R.describeFormat(rule) : R.describeValidation(rule)));
        t.appendChild(h('small', null, R.colsToRange(rule.cols, keys, letter) || '(no column)'));
        row.appendChild(t);
        row.title = t.textContent;
        var del = A.iconButton(ICON.x, 'Remove rule', function () { var list = rules.slice(); list.splice(k, 1); setRules(tab, panel.kind, list); draw(); });
        row.appendChild(del);
        row.addEventListener('click', function () { edit(k); });
        row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); edit(k); } });
        bd.appendChild(row);
      });
      var add = button('ts-add-rule', null, function () { edit(-1); });
      add.innerHTML = ICON.plus + '<span>Add rule</span>';
      bd.appendChild(add);
    }
    function edit(k) {
      var tab = A.cur(), rules = rulesOf(tab, panel.kind);
      var base = k >= 0 ? JSON.parse(JSON.stringify(rules[k])) : null;
      if (!base) {
        var cols = selectionCols();
        if (panel.kind === 'format') base = { cols: cols, when: tab.index.cols[keysOf(tab).indexOf(cols[0])].type === 'text' ? 'textContains' : 'gt', value: '', fill: 'green' };
        else base = newValidation(tab, cols);
      }
      panel.draft = { at: k, rule: base, range: R.colsToRange(base.cols, keysOf(tab), letter) };
      draw();
    }
    // A new dropdown offers the column's own values (up to 12 of them).
    function newValidation(tab, cols) {
      var c = keysOf(tab).indexOf(cols[0]);
      // Up to 13 (blank aside): more than 12 is not a list to offer.
      var vals = Q.distinctValues(tab.index, c, 14).map(function (v) { return v.value; }).filter(Boolean).slice(0, 13);
      return { cols: cols, kind: 'list', values: vals.length && vals.length <= 12 ? vals : ['Option 1', 'Option 2'] };
    }
    function picker(label, items, value, onPick) {
      var b = button('ts-pick', null);
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-label', label);
      var show = function (v) { b.textContent = ''; b.appendChild(h('span', null, (items.filter(function (x) { return x[0] === v; })[0] || ['', '…'])[1])); var caret = h('span'); caret.innerHTML = ICON.down; b.appendChild(caret); };
      show(value);
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        A.openMenu(b, items.map(function (x) { return { label: x[1], checked: x[0] === value, onSelect: function () { value = x[0]; show(value); onPick(value); } }; }), label);
      });
      return b;
    }
    function swatches(label, value, onPick) {
      var row = h('div', 'ts-sws'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', label);
      R.COLOR_NAMES.forEach(function (n) {
        var b = button('ts-sw', null, function () {
          Array.prototype.forEach.call(row.children, function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
          onPick(n);
        });
        b.style.background = Q.TAG_COLORS[n][0];
        b.setAttribute('aria-label', n + ' ' + label.toLowerCase());
        b.title = n;
        b.setAttribute('aria-pressed', value === n ? 'true' : 'false');
        row.appendChild(b);
      });
      return row;
    }
    function rangeField(bd, d) {
      bd.appendChild(h('span', 'ts-lbl', 'Apply to columns'));
      var f = field('e.g. C or B:D', d.range, 'Apply to columns');
      f.input.addEventListener('input', function () { d.range = f.input.value; });
      bd.appendChild(f.el);
    }
    function actions(bd, d, save) {
      var err = h('p', 'ts-err'); err.hidden = true; bd.appendChild(err);
      var row = h('div', 'ts-actions');
      if (d.at >= 0) row.appendChild(button('is-danger', 'Remove', function () { var tab = A.cur(), list = rulesOf(tab, panel.kind).slice(); list.splice(d.at, 1); setRules(tab, panel.kind, list); panel.draft = null; draw(); }));
      row.appendChild(h('span', 'ts-grow'));
      row.appendChild(button('', 'Cancel', function () { panel.draft = null; draw(); }));
      row.appendChild(button('is-primary', 'Done', function () {
        var tab = A.cur(), cols = R.rangeToCols(d.range, keysOf(tab));
        if (!cols) { err.hidden = false; err.textContent = 'Name columns by letter, such as C or B:D.'; return; }
        var rule = Object.assign({}, d.rule, { cols: cols });
        var problem = save(rule);
        if (problem) { err.hidden = false; err.textContent = problem; return; }
        var list = rulesOf(tab, panel.kind).slice();
        if (d.at >= 0) list[d.at] = rule; else list.push(rule);
        setRules(tab, panel.kind, list);
        panel.draft = null;
        draw();
      }));
      bd.appendChild(row);
    }
    function formatEditor(bd) {
      var d = panel.draft, rule = d.rule;
      rangeField(bd, d);
      bd.appendChild(h('span', 'ts-lbl', 'Format cells if…'));
      var values = h('div');
      var drawValue = function () {
        values.textContent = '';
        if (!R.conditionArity(rule.when)) return;
        var f = field(rule.when === 'textContains' ? 'Text' : 'Value', rule.value, 'Value');
        f.input.addEventListener('input', function () { rule.value = f.input.value; });
        values.appendChild(f.el);
      };
      bd.appendChild(picker('Condition', R.CONDITIONS.map(function (op) { return [op, R.CONDITION_LABEL[op]]; }), rule.when, function (op) {
        rule.when = op;
        if (!R.conditionArity(op)) delete rule.value;
        drawValue();
      }));
      bd.appendChild(values);
      drawValue();
      bd.appendChild(h('span', 'ts-lbl', 'Fill'));
      var pv = h('div', 'ts-preview', 'Sample 123');
      var redraw = function () { pv.style.background = Q.TAG_COLORS[rule.fill][0]; };
      bd.appendChild(swatches('Fill', rule.fill, function (n) { rule.fill = n; redraw(); }));
      bd.appendChild(pv);
      redraw();
      actions(bd, d, function (r) { return R.conditionArity(r.when) && !String(r.value || '').trim() ? 'Enter a value.' : null; });
    }
    function validEditor(bd) {
      var d = panel.draft, rule = d.rule;
      rangeField(bd, d);
      bd.appendChild(h('span', 'ts-lbl', 'Values, separated by commas'));
      var f = field('Open, Done, Blocked', rule.values.join(', '), 'Values');
      f.input.addEventListener('input', function () { rule.values = f.input.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean); });
      bd.appendChild(f.el);
      bd.appendChild(h('p', 'ts-note', 'A value outside the list is marked while editing.'));
      actions(bd, d, function (r) { return r.values.length ? null : 'Enter at least one value.'; });
    }
    function bar() {
      var edit = A.canEdit();
      if (replaceBtn) replaceBtn.hidden = !edit;
      if (!panel) return;
      if (!edit) { closePanel(); return; }
      if (panel.tab !== A.cur()) { panel.draft = null; draw(); }
    }

    // ---- the fill handle ------------------------------------------------------------------
    var dot = null, box = null, filling = null;
    function range() { var s = A.sel(); return { ra: Math.min(s.r, s.r2), rb: Math.max(s.r, s.r2), ca: Math.min(s.c, s.c2), cb: Math.max(s.c, s.c2) }; }
    function bodyTop() { return A.ui.body.offsetTop; }
    function colX(tab, c) { return c === 0 ? Math.max(tab.colLeft[0], A.ui.grid.scrollLeft + A.numW()) : tab.colLeft[c]; }
    function painted() {
      var ui = A.ui;
      if (!ui.grid) return;
      if (!dot) {
        dot = h('div', 'ts-fill'); dot.setAttribute('aria-hidden', 'true'); dot.title = 'Drag to fill · hold Ctrl to copy';
        box = h('div', 'ts-fillbox'); box.hidden = true;
        dot.addEventListener('pointerdown', startFill);
        ui.grid.appendChild(box); ui.grid.appendChild(dot);
      }
      var tab = A.cur();
      var show = A.canEdit() && tab.order && tab.order.length && !ui.root.classList.contains('is-flat') && ui.rows.firstElementChild && ui.rows.firstElementChild.classList.contains('ts-row');
      if (!show) { dot.hidden = true; return; }
      var g = range();
      if (g.rb >= tab.order.length || g.cb >= tab.widths.length) { dot.hidden = true; return; }
      var x = colX(tab, g.cb) + tab.widths[g.cb], y = bodyTop() + A.rowTop(tab, g.rb) + A.rowH(tab, g.rb);
      if (g.cb > 0 && x < ui.grid.scrollLeft + A.numW() + tab.widths[0] + 2) { dot.hidden = true; return; }
      dot.hidden = false;
      var half = dot.offsetWidth / 2 || 4.5;
      dot.style.left = (x - half) + 'px';
      dot.style.top = (y - half) + 'px';
    }
    function startFill(e) {
      if (e.button > 0 || !A.canEdit()) return;
      e.preventDefault(); e.stopPropagation();
      var tab = A.cur(), src = range(), ui = A.ui;
      filling = { tab: tab, src: src, to: null };
      ui.root.classList.add('is-filling');
      var last = null, frame = 0;
      var move = function (ev) {
        if (ev.pointerId !== e.pointerId) return;
        ev.preventDefault();
        last = ev;
        if (!frame) frame = requestAnimationFrame(function () { frame = 0; if (last) track(last); });
      };
      var up = function (ev) {
        if (ev.pointerId !== e.pointerId) return;
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('pointerup', up, true);
        document.removeEventListener('pointercancel', up, true);
        if (frame) cancelAnimationFrame(frame);
        if (last) track(last);
        ui.root.classList.remove('is-filling');
        box.hidden = true;
        var f = filling; filling = null;
        if (f && f.to && ev.type === 'pointerup') fill(f.tab, f.src, f.to, ev.ctrlKey || ev.metaKey || ev.altKey);
        painted();
      };
      document.addEventListener('pointermove', move, true);
      document.addEventListener('pointerup', up, true);
      document.addEventListener('pointercancel', up, true);
    }
    function track(ev) {
      var ui = A.ui, tab = filling.tab, g = filling.src;
      var rect = ui.grid.getBoundingClientRect();
      if (ev.clientY > rect.bottom - 24) ui.grid.scrollTop += 24;
      else if (ev.clientY < rect.top + A.HEAD_H + 6) ui.grid.scrollTop -= 24;
      if (ev.clientX > rect.right - 24) ui.grid.scrollLeft += 24;
      else if (ev.clientX < rect.left + A.numW() + 6) ui.grid.scrollLeft -= 24;
      var under = document.elementFromPoint(ev.clientX, ev.clientY);
      var cellEl = under && under.closest && under.closest('.ts-c');
      if (!cellEl || !ui.rows.contains(cellEl)) return;
      var i = Number(cellEl.parentElement.getAttribute('data-i')), c = Number(cellEl.getAttribute('data-c'));
      var down = i - g.rb, upw = g.ra - i, right = c - g.cb, left = g.ca - c;
      var vert = Math.max(down, upw, 0), horiz = Math.max(right, left, 0), to = null;
      if (vert || horiz) to = vert >= horiz ? (down > 0 ? { dir: 'down', n: down } : { dir: 'up', n: upw }) : (right > 0 ? { dir: 'right', n: right } : { dir: 'left', n: left });
      filling.to = to;
      if (!to) { box.hidden = true; return; }
      var r0 = g.ra, r1 = g.rb, c0 = g.ca, c1 = g.cb;
      if (to.dir === 'down') r1 += to.n; else if (to.dir === 'up') r0 -= to.n; else if (to.dir === 'right') c1 += to.n; else c0 -= to.n;
      var top = bodyTop() + A.rowTop(tab, r0), bottom = bodyTop() + A.rowTop(tab, r1) + A.rowH(tab, r1);
      var lx = colX(tab, c0), rx = colX(tab, c1) + tab.widths[c1];
      box.hidden = false;
      box.style.left = lx + 'px'; box.style.top = top + 'px';
      box.style.width = (rx - lx) + 'px'; box.style.height = (bottom - top) + 'px';
    }
    function valueAt(tab, r, c) { var col = tab.index.cols[c]; return col.tags ? col.tags[r].join(', ') : col.text[r]; }
    var MAX_FILL = 50000;
    function fill(tab, g, to, copy) {
      var order = tab.order, list = [], vertical = to.dir === 'down' || to.dir === 'up', back = to.dir === 'up' || to.dir === 'left';
      // At most MAX_FILL cells in one drag (one Undo step, one re-read).
      var across = vertical ? g.cb - g.ca + 1 : g.rb - g.ra + 1;
      if (to.n * across > MAX_FILL) {
        to = { dir: to.dir, n: Math.max(1, Math.floor(MAX_FILL / across)) };
        A.toast('A fill covers at most ' + A.fmt(MAX_FILL) + ' cells: filled ' + A.fmt(to.n) + (vertical ? ' rows.' : ' columns.'));
      }
      var put = function (r, c, v) { list.push({ r: r, c: c, value: tab.index.cols[c].type === 'tags' ? Q.splitTags(v) : v }); };
      if (vertical) {
        for (var c = g.ca; c <= g.cb; c++) {
          var src = [];
          for (var i = g.ra; i <= g.rb; i++) src.push(valueAt(tab, order[i], c));
          var out = R.fillSeries(src, to.n, { copy: copy, backward: back }, fillCtx);
          for (var k = 0; k < out.length; k++) { var ii = back ? g.ra - 1 - k : g.rb + 1 + k; if (ii >= 0 && ii < order.length) put(order[ii], c, out[k]); }
        }
      } else {
        for (var i2 = g.ra; i2 <= g.rb; i2++) {
          var r = order[i2], src2 = [];
          for (var c2 = g.ca; c2 <= g.cb; c2++) src2.push(valueAt(tab, r, c2));
          var out2 = R.fillSeries(src2, to.n, { copy: copy, backward: back }, fillCtx);
          for (var k2 = 0; k2 < out2.length; k2++) { var cc = back ? g.ca - 1 - k2 : g.cb + 1 + k2; if (cc >= 0 && cc < tab.widths.length) put(r, cc, out2[k2]); }
        }
      }
      // The selection grows over what was filled (after the write, which
      // puts the active cell back on its row).
      if (list.length) A.setCells(tab, list, order[to.dir === 'up' ? g.rb : g.ra]);
      var s = A.sel(), n = tab.order.length, w = tab.widths.length;
      s.r = to.dir === 'up' ? g.rb : g.ra; s.r2 = to.dir === 'up' ? g.ra : g.rb;
      s.c = to.dir === 'left' ? g.cb : g.ca; s.c2 = to.dir === 'left' ? g.ca : g.cb;
      if (to.dir === 'down') s.r2 = Math.min(n - 1, g.rb + to.n);
      else if (to.dir === 'up') s.r2 = Math.max(0, g.ra - to.n);
      else if (to.dir === 'right') s.c2 = Math.min(w - 1, g.cb + to.n);
      else s.c2 = Math.max(0, g.ca - to.n);
      A.renderHead(); A.renderBody(true);
    }

    return {
      readTab: readTab, cell: cell, flatStyle: flatStyle, startEdit: startEdit, press: press,
      key: key, menuItems: menuItems, mountSearch: mountSearch, bar: bar, painted: painted,
      // for tests: open the panel or the popover without the menus
      openPanel: openPanel, openFind: openFind,
    };
  }
  return { install: install };
})();
