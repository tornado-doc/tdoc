// Sheets. A doc whose author HTML holds `<table data-tdoc-sheet>` tables is
// shown as a spreadsheet: one grid with a tab per table, a frozen header and
// first column, column resize, keyboard navigation, search with next and
// previous, per-column filters, multi-column sort and row virtualization.
//
// Like the slides viewer, this runs inside the sandboxed doc frame and is
// framework-free. The author's tables stay the source of truth: they are
// hidden (by a provider style, never by an attribute), and the grid is a
// provider element the editor strips when it saves. Filter, sort and search
// are view state: the shell keeps them in the page's #hash and in
// localStorage, and nothing here writes them into the document.
//
// In Edit mode (doc owners and editors, behind the `sheets` flag) a cell is
// edited in place and written back into its <td>, rows and columns are added
// and removed, a column's type is set, tags are picked from the column's
// own, and a range pasted from Excel or Google Sheets fills the grid. Every
// change goes through the editor's own draft and Save (a new version).
//
// Served at /sheets-viewer.js and loaded by server/sheets-loader.js only when
// the doc has a sheet. SheetQuery and SheetMarkup are shared/sheet-query.mjs
// and shared/sheet-markup.mjs, inlined by server/sheets-source.js.
(function () {
  'use strict';
  if (window === window.parent || window.__tdocSheets) return;
  if (new URLSearchParams(location.search).get('tdoc_compare') === '1') return;
  var Q = SheetQuery, M = SheetMarkup;
  var SEL = M.SHEET_SELECTOR;
  var NARROW = window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;
  var ROW_H = 32, HEAD_H = 34, OVERSCAN = 6, MAX_COLUMNS = 200;
  function numW() { return NARROW && NARROW.matches ? 36 : 48; }
  var hooks = window.__tdocElementHooks = window.__tdocElementHooks || {};

  function post(msg) { msg.source = 'tdoc-frame'; try { window.parent.postMessage(msg, '*'); } catch (e) {} }
  function provider(el) { el.setAttribute('data-tdoc-provider', ''); return el; }
  function h(tag, cls, text) { var el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; }
  function esc(s) { return M.escapeHtml(s); }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function mode() { return document.documentElement.getAttribute('data-tdoc-interaction-mode') || 'read'; }

  var ICON = {
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    filter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z" fill="currentColor"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    comment: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 2H12A10 10 0 1 1 2 12V2Z"/></svg>',
  };
  var TYPE_LABEL = { text: 'Text', number: 'Number', date: 'Date', tags: 'Tags', checkbox: 'Checkbox', url: 'Link' };
  var TYPE_GLYPH = { text: 'Aa', number: '#', date: '▦', tags: '◉', checkbox: '☑', url: '↗' };

  // ---- styles ---------------------------------------------------------------
  var style = provider(document.createElement('style'));
  style.textContent = [
    // The author's tables stay in the document, out of sight. A wrapper that
    // holds nothing but a sheet goes with it.
    'table[data-tdoc-sheet]{display:none!important}',
    '.tdoc-table-scroll:has(>table[data-tdoc-sheet]:only-child){display:none!important}',
    '.tdoc-sheet{--ts-accent:#1652f0;--ts-accent-tint:#e8eeff;--ts-ink:#17171a;--ts-muted:#666;--ts-line:#e6e6ea;--ts-head:#f7f7f8;--ts-sel:rgba(22,82,240,.08);--ts-hit:#fff1a8;--ts-hit-on:#ffd23f;',
    'position:relative;margin:0 0 2rem;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ts-ink);-webkit-user-select:none;user-select:none;text-align:left}',
    '.tdoc-sheet *{box-sizing:border-box}',
    '.tdoc-sheet button:not(.tdoc-comment-pill){font:inherit;color:inherit;cursor:pointer}',
    '.tdoc-sheet svg{width:16px;height:16px;flex:none;display:block;margin:0}',
    // tabs
    '.ts-tabs{display:flex;align-items:flex-end;gap:2px;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--ts-line);margin:0 0 8px}',
    '.ts-tabs::-webkit-scrollbar{display:none}',
    '.ts-tab{flex:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;height:34px;padding:0 14px;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;background:transparent;color:var(--ts-muted);font-weight:500}',
    '.ts-tab:hover{background:var(--ts-head);color:var(--ts-ink)}',
    '.ts-tab[aria-selected="true"]{background:#fff;border-color:var(--ts-line);color:var(--ts-ink);margin-bottom:-1px;height:35px}',
    '.ts-tab-add{flex:none;width:32px;height:32px;margin:0 0 2px 4px;border:0;border-radius:8px;background:transparent;color:var(--ts-muted);display:inline-flex;align-items:center;justify-content:center}',
    '.ts-tab-add:hover{background:var(--ts-head);color:var(--ts-ink)}',
    // toolbar
    '.ts-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 8px}',
    '.ts-search{display:flex;align-items:center;gap:6px;height:34px;padding:0 6px 0 10px;border:1px solid #d6d6dc;border-radius:8px;background:#fff;min-width:0;flex:0 1 320px}',
    '.ts-search:focus-within{border-color:var(--ts-accent);box-shadow:0 0 0 3px var(--ts-accent-tint)}',
    '.ts-search svg{color:var(--ts-muted)}',
    '.ts-search input{flex:1;min-width:60px;border:0;outline:0;background:transparent;font:inherit;font-size:14px;color:inherit;-webkit-user-select:text;user-select:text}',
    '.ts-search output{color:var(--ts-muted);font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.ts-icon{width:28px;height:28px;border:0;border-radius:6px;background:transparent;display:inline-flex;align-items:center;justify-content:center;color:var(--ts-muted);flex:none}',
    '.ts-icon:hover:not(:disabled){background:var(--ts-head);color:var(--ts-ink)}',
    '.ts-icon:disabled{opacity:.35;cursor:default}',
    '.ts-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
    '.ts-chip{display:inline-flex;align-items:center;gap:4px;height:28px;max-width:280px;padding:0 4px 0 10px;border:1px solid #c9d6fb;border-radius:999px;background:var(--ts-accent-tint);color:#1d3f9f;white-space:nowrap}',
    '.ts-chip span{overflow:hidden;text-overflow:ellipsis}',
    '.ts-chip button{width:22px;height:22px;border:0;border-radius:999px;background:transparent;display:inline-flex;align-items:center;justify-content:center;color:inherit;padding:0}',
    '.ts-chip button:hover{background:#d3defd}',
    '.ts-chip svg{width:14px;height:14px}',
    '.ts-link{border:0;background:transparent;color:var(--ts-accent);padding:4px 2px;font-weight:500}',
    '.ts-link:hover{text-decoration:underline}',
    '.ts-count{margin-left:auto;color:var(--ts-muted);font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.ts-btn{height:32px;padding:0 12px;border:1px solid #d6d6dc;border-radius:8px;background:#fff;font-weight:500;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
    '.ts-btn:hover{background:var(--ts-head)}',
    '.ts-btn[hidden],.ts-icon[hidden],.ts-link[hidden],.ts-note[hidden]{display:none!important}',
    '.ts-note{color:var(--ts-muted);font-size:12px}',
    // grid
    '.ts-grid{position:relative;width:max-content;max-width:100%;min-width:min(100%,360px);overflow:auto;border:1px solid var(--ts-line);border-radius:8px;background:#fff;outline:0;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}',
    '.ts-grid:focus-visible{box-shadow:0 0 0 3px var(--ts-accent-tint)}',
    '.ts-head{position:sticky;top:0;z-index:4;display:flex;height:' + HEAD_H + 'px;background:var(--ts-head);border-bottom:1px solid #d9d9df}',
    '.ts-corner{position:sticky;left:0;z-index:2;flex:none;background:var(--ts-head);border-right:1px solid var(--ts-line)}',
    '.ts-h{position:relative;flex:none;display:flex;align-items:center;gap:2px;padding:0 2px 0 8px;border-right:1px solid var(--ts-line);font-weight:600;min-width:0}',
    '.ts-h.is-first{position:sticky;z-index:2;background:var(--ts-head)}',
    '.ts-h.is-sel{background:#e6ecfb}',
    '.ts-hname{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:100%;border:0;background:transparent;padding:0;text-align:left;font-weight:600}',
    '.ts-hname b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ts-glyph{flex:none;width:16px;color:#8a8a94;font-size:11px;font-weight:600;text-align:center}',
    '.ts-sorted{flex:none;display:inline-flex;align-items:center;color:var(--ts-accent);font-size:10px;font-weight:700}',
    '.ts-sorted svg{width:14px;height:14px}',
    '.ts-h .ts-icon{width:24px;height:24px}',
    '.ts-h .ts-icon.is-on{color:var(--ts-accent)}',
    // The filter button shows on a filtered column, and on hover where there
    // is hover; the column menu (always shown) has Filter too.
    '.ts-h [data-act="filter"]:not(.is-on){display:none}',
    '@media (hover:hover){.ts-h:hover [data-act="filter"],.ts-h:focus-within [data-act="filter"]{display:inline-flex}}',
    '.ts-resize{position:absolute;top:0;right:-4px;width:8px;height:100%;cursor:col-resize;z-index:3;touch-action:none}',
    '.ts-resize:hover,.ts-resize.is-on{background:linear-gradient(90deg,transparent 3px,var(--ts-accent) 3px,var(--ts-accent) 5px,transparent 5px)}',
    '.ts-h-add{flex:none;width:40px;display:flex;align-items:center;justify-content:center}',
    '.ts-body{position:relative}',
    '.ts-rows{position:absolute;left:0;top:0}',
    '.ts-row{display:flex;height:' + ROW_H + 'px;background:#fff}',
    '.ts-row:hover{background:#fafafc}',
    '.ts-n{position:sticky;left:0;z-index:2;flex:none;display:flex;align-items:center;justify-content:flex-end;padding:0 8px;border-right:1px solid var(--ts-line);border-bottom:1px solid var(--ts-line);background:var(--ts-head);color:#8a8a94;font-size:11px;font-variant-numeric:tabular-nums}',
    '.ts-n.is-sel{background:#e6ecfb;color:var(--ts-ink)}',
    '.ts-c{position:relative;flex:none;display:flex;align-items:center;gap:4px;padding:0 8px;border-right:1px solid var(--ts-line);border-bottom:1px solid var(--ts-line);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;background:inherit}',
    '.ts-c>span.ts-t{overflow:hidden;text-overflow:ellipsis}',
    '.ts-c.is-first{position:sticky;z-index:1;background:#fff}',
    '.ts-row:hover .ts-c.is-first{background:#fafafc}',
    '.ts-c.is-num{justify-content:flex-end;font-variant-numeric:tabular-nums}',
    '.ts-c.is-sel{background:var(--ts-sel)}',
    '.ts-c.is-first.is-sel{background:#eef2fd}',
    '.ts-c.is-active{box-shadow:inset 0 0 0 2px var(--ts-accent)}',
    '.ts-c.is-hit{background:#fffbe0}',
    '.ts-c mark{background:var(--ts-hit);color:inherit;border-radius:2px;padding:0}',
    '.ts-c.is-hit-on mark{background:var(--ts-hit-on)}',
    '.ts-c a{color:var(--ts-accent);text-decoration:none;overflow:hidden;text-overflow:ellipsis}',
    '.ts-c a:hover{text-decoration:underline}',
    '.ts-tag{flex:none;display:inline-block;max-width:160px;overflow:hidden;text-overflow:ellipsis;padding:0 8px;border-radius:999px;font-size:12px;line-height:20px;font-weight:500}',
    '.ts-check{flex:none;width:16px;height:16px;border:1.5px solid #b9b9c2;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;color:#fff}',
    '.ts-check.is-on{background:var(--ts-accent);border-color:var(--ts-accent)}',
    '.ts-c.is-check{justify-content:center}',
    '.ts-c.has-comment::after{content:"";position:absolute;top:0;right:0;border-style:solid;border-width:0 9px 9px 0;border-color:transparent #f5a524 transparent transparent;cursor:pointer}',
    '.ts-c .tdoc-comment-pill{position:absolute;top:1px;right:2px;width:28px;height:28px;z-index:3}',
    '.ts-c .tdoc-comment-pill svg{width:14px;height:14px}',
    '.ts-off{position:absolute;left:50%;transform:translateX(-50%);z-index:5;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:1px solid #f0c36d;border-radius:999px;background:#fff8e6;color:#7a4b00;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.1);white-space:nowrap}',
    '.ts-off:hover{background:#ffefc2}',
    '.ts-off[hidden],.ts-off-hidden[hidden]{display:none!important}',
    '.ts-off-hidden{margin:-2px 0 8px;color:#7a4b00}',
    '.ts-empty{padding:28px 16px;color:var(--ts-muted);text-align:center;position:sticky;left:0}',
    '.ts-add-row{display:flex;align-items:center;gap:6px;margin:6px 0 0;padding:0 10px;height:32px;border:1px dashed #d0d0d8;border-radius:8px;background:transparent;color:var(--ts-muted);width:100%}',
    '.ts-add-row:hover{border-color:var(--ts-accent);color:var(--ts-accent)}',
    '.ts-add-row[hidden]{display:none}',
    // in-place editor
    '.ts-editor{position:absolute;z-index:6;margin:0;padding:0 8px;border:2px solid var(--ts-accent);border-radius:2px;background:#fff;font:inherit;font-size:13px;color:inherit;outline:0;box-shadow:0 4px 14px rgba(0,0,0,.12);-webkit-user-select:text;user-select:text}',
    // popovers (menus, filter panels, tag picker): one component for all
    '.ts-pop{box-sizing:border-box;position:fixed;z-index:2147483600;min-width:200px;max-width:min(340px,calc(100vw - 16px));max-height:min(440px,calc(100vh - 16px));overflow:auto;padding:6px;border:1px solid #dedee3;border-radius:10px;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.14),0 2px 6px rgba(0,0,0,.06);font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#17171a;-webkit-user-select:none;user-select:none}',
    '.ts-pop *{box-sizing:border-box}',
    '.ts-pop button{font:inherit;color:inherit;cursor:pointer}',
    '.ts-pop svg{width:16px;height:16px;flex:none}',
    '.ts-mi{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:4px 10px;border:0;border-radius:6px;background:transparent;text-align:left}',
    '.ts-mi:hover,.ts-mi:focus-visible,.ts-mi.is-hot{background:#f0f1f4;outline:0}',
    '.ts-mi.is-danger{color:#b42318}',
    '.ts-mi[aria-checked="true"]::after{content:"✓";margin-left:auto;color:#1652f0}',
    '.ts-mi:disabled{opacity:.45;cursor:default}',
    '.ts-sep{height:1px;margin:4px 6px;background:#eee}',
    '.ts-ph{padding:6px 10px 4px;color:#666;font-size:12px;font-weight:600}',
    '.ts-field{display:flex;align-items:center;gap:6px;height:32px;margin:4px;padding:0 8px;border:1px solid #d6d6dc;border-radius:8px}',
    '.ts-field:focus-within{border-color:#1652f0}',
    '.ts-field input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:14px;color:inherit;-webkit-user-select:text;user-select:text}',
    '.ts-vals{max-height:240px;overflow:auto;margin:2px 0}',
    '.ts-val{display:flex;align-items:center;gap:8px;min-height:30px;padding:2px 10px;border-radius:6px;cursor:pointer}',
    '.ts-val:hover{background:#f0f1f4}',
    '.ts-val input{margin:0;accent-color:#1652f0;width:16px;height:16px}',
    '.ts-val .ts-n-of{margin-left:auto;color:#888;font-variant-numeric:tabular-nums;font-size:12px}',
    '.ts-val .ts-blank{color:#888;font-style:italic}',
    '.ts-range{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px}',
    '.ts-range label{display:flex;flex-direction:column;gap:2px;color:#666;font-size:12px}',
    '.ts-range input{height:32px;padding:0 8px;border:1px solid #d6d6dc;border-radius:8px;font:inherit;font-size:14px;width:100%;-webkit-user-select:text;user-select:text}',
    '.ts-seg{display:flex;gap:4px;margin:4px}',
    '.ts-seg button{flex:1;height:30px;border:1px solid #d6d6dc;border-radius:8px;background:#fff}',
    '.ts-seg button[aria-pressed="true"]{background:#e8eeff;border-color:#1652f0;color:#1d3f9f}',
    '.ts-actions{display:flex;justify-content:space-between;gap:8px;margin:6px 4px 2px}',
    '.ts-actions button{height:30px;padding:0 12px;border:1px solid #d6d6dc;border-radius:8px;background:#fff;font-weight:500}',
    '.ts-actions button.is-primary{background:#1652f0;border-color:#1652f0;color:#fff}',
    '.ts-tagbox{display:flex;flex-wrap:wrap;gap:4px;padding:6px;margin:4px;border:1px solid #d6d6dc;border-radius:8px;min-height:38px;align-items:center}',
    '.ts-tagbox:focus-within{border-color:#1652f0}',
    '.ts-tagbox input{flex:1;min-width:80px;border:0;outline:0;font:inherit;font-size:14px;background:transparent;-webkit-user-select:text;user-select:text}',
    '.ts-tagbox .ts-tag{display:inline-flex;align-items:center;gap:2px;padding-right:2px}',
    '.ts-tagbox .ts-tag button{border:0;background:transparent;width:18px;height:18px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;color:inherit}',
    '.ts-tagbox .ts-tag svg{width:12px;height:12px}',
    '.ts-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483600;padding:10px 14px;border-radius:10px;background:#17171a;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2);max-width:calc(100vw - 32px)}',
    'html[data-tdoc-interaction-mode="comment"] .tdoc-sheet .ts-c{cursor:cell}',
    '@media (max-width:640px){',
    '.ts-bar{gap:6px}.ts-search{flex:1 1 100%}.ts-count{margin-left:0}',
    '.ts-pop{left:0!important;right:0!important;top:auto!important;bottom:0!important;max-width:none;width:100%;max-height:70vh;border-radius:14px 14px 0 0;padding:10px 10px max(10px,env(safe-area-inset-bottom))}.ts-pop .ts-actions{margin-right:84px}',
    '.ts-mi{min-height:44px}.ts-val{min-height:40px}',
    '.ts-n{padding:0 4px}',
    '}',
  ].join('');
  document.head.appendChild(style);

  // ---- one popover component: menus, filter panels and the tag picker -------
  var pop = null;
  function closePop(commit) {
    if (!pop) return;
    var p = pop; pop = null;
    if (p.onClose) try { p.onClose(commit !== false); } catch (e) {}
    p.el.remove();
    if (p.returnFocus && p.returnFocus.isConnected) p.returnFocus.focus({ preventScroll: true });
  }
  function openPop(anchor, build, opts) {
    closePop();
    var el = provider(h('div', 'ts-pop'));
    el.setAttribute('role', (opts && opts.role) || 'dialog');
    if (opts && opts.label) el.setAttribute('aria-label', opts.label);
    el.setAttribute('contenteditable', 'false');
    document.body.appendChild(el);
    pop = { el: el, onClose: null, returnFocus: (opts && opts.returnFocus) || document.activeElement };
    build(el, pop);
    var r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    var w = el.offsetWidth, ht = el.offsetHeight;
    var left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    var top = r.bottom + 4;
    if (top + ht > innerHeight - 8) top = Math.max(8, r.top - ht - 4);
    el.style.left = left + 'px'; el.style.top = top + 'px';
    var first = el.querySelector('input:not([type=checkbox]),[data-autofocus],button.ts-mi:not(:disabled)');
    if (first && !(NARROW && NARROW.matches && first.tagName === 'INPUT')) first.focus({ preventScroll: true });
    return pop;
  }
  document.addEventListener('pointerdown', function (e) {
    if (pop && !pop.el.contains(e.target)) closePop(true);
  }, true);
  // A menu: [{ label, onSelect, checked, danger, disabled }] or 'sep' / { header }.
  function menuItems(el, items) {
    el.setAttribute('role', 'menu');
    items.forEach(function (it) {
      if (it === 'sep') { el.appendChild(h('div', 'ts-sep')); return; }
      if (it.header) { el.appendChild(h('div', 'ts-ph', it.header)); return; }
      var b = h('button', 'ts-mi' + (it.danger ? ' is-danger' : ''), it.label);
      b.type = 'button';
      b.setAttribute('role', it.checked != null ? 'menuitemradio' : 'menuitem');
      if (it.checked != null) b.setAttribute('aria-checked', it.checked ? 'true' : 'false');
      if (it.disabled) b.disabled = true;
      b.addEventListener('click', function (e) { e.stopPropagation(); closePop(true); it.onSelect(); });
      el.appendChild(b);
    });
    el.addEventListener('keydown', function (e) {
      var list = Array.prototype.slice.call(el.querySelectorAll('button.ts-mi:not(:disabled)'));
      var i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
    });
  }
  function openMenu(anchor, items, label) { return openPop(anchor, function (el) { menuItems(el, items); }, { role: 'menu', label: label }); }
  document.addEventListener('keydown', function (e) {
    // A panel with an input of its own (the tag picker, a rename) decides what
    // Escape means there: cancel, not commit.
    if (pop && e.key === 'Escape' && !(pop.ownEscape && pop.el.contains(e.target))) { e.preventDefault(); e.stopPropagation(); closePop(true); }
  }, true);

  var toastTimer = null, toastEl = null;
  function toast(text) {
    if (!toastEl) { toastEl = provider(h('div', 'ts-toast')); toastEl.setAttribute('role', 'status'); }
    toastEl.textContent = text;
    document.body.appendChild(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (toastEl) toastEl.remove(); }, 3200);
  }

  // ---- the model --------------------------------------------------------------
  // A tab: one author table, its rows read once, the column index the query
  // runs on, and this reader's view of it (query, widths, selection).
  var book = null;
  function readTab(table, old) {
    var data = M.readSheetTable(table, Q.normalizeType);
    var tab = old || { query: Q.emptyQuery(), widths: [], matchAt: -1 };
    tab.table = table;
    tab.data = data;
    tab.name = cleanName(data.name) || 'Sheet ' + (book ? book.tabs.indexOf(tab) + 1 || book.tabs.length + 1 : 1);
    tab.index = Q.buildIndex(data);
    tab.palettes = data.columns.map(function (c) { return Q.parsePalette(c.palette); });
    tab.rowOf = new Map();
    data.rows.forEach(function (row, r) { tab.rowOf.set(row.tr, r); });
    var cols = data.columns.length;
    if (tab.widths.length !== cols) tab.widths = data.columns.map(function (c, i) { return tab.widths[i] || defaultWidth(tab, i); });
    return tab;
  }
  // A tab name is one line: line breaks and tabs read as a space.
  function cleanName(name) { return String(name || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 100); }
  function defaultWidth(tab, c) {
    var col = tab.index.cols[c], type = col.type;
    // Room for the header (type glyph, name, sort mark, menu) and for the
    // longest of the first few hundred values, within a sane band.
    var head = (tab.data.columns[c].name || '').length * 7.6 + 104;
    var longest = 0, n = Math.min(tab.index.size, 300);
    for (var r = 0; r < n; r++) longest = Math.max(longest, type === 'tags' ? col.text[r].length + col.tags[r].length * 3 : col.text[r].length);
    var w = Math.max(head, longest * 7.4 + 28);
    return Math.round(Math.max(type === 'checkbox' ? 72 : 96, Math.min(type === 'text' ? 340 : 280, w)));
  }
  function runTab(tab) {
    tab.order = Q.runQuery(tab.index, tab.query);
    tab.pos = new Int32Array(tab.index.size).fill(-1);
    for (var i = 0; i < tab.order.length; i++) tab.pos[tab.order[i]] = i;
    tab.matches = Q.searchMatches(tab.index, tab.order, tab.query.search);
    if (tab.matchAt >= tab.matches.hits.length) tab.matchAt = -1;
    tab.colLeft = [];
    var x = numW();
    for (var c = 0; c < tab.widths.length; c++) { tab.colLeft.push(x); x += tab.widths[c]; }
    tab.totalW = x;
  }
  function cur() { return book && book.tabs[book.active]; }

  // ---- mount --------------------------------------------------------------------
  var ui = {};
  var sel = { r: 0, c: 0, r2: 0, c2: 0 };
  var config = { editing: false, received: false };
  var undoStack = [], redoStack = [];

  function mount() {
    var tables = Array.prototype.slice.call(document.querySelectorAll(SEL)).filter(function (t) { return !t.closest('[data-tdoc-provider]'); });
    if (!tables.length) return false;
    book = { tabs: [], active: 0 };
    tables.forEach(function (t) { book.tabs.push(readTab(t)); });
    var first = tables[0];
    var host = first.parentElement && first.parentElement.classList.contains('tdoc-table-scroll') && first.parentElement.children.length === 1 ? first.parentElement : first;
    var root = provider(h('div', 'tdoc-sheet'));
    root.setAttribute('contenteditable', 'false');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Sheet');
    ui.root = root;
    ui.tabs = h('div', 'ts-tabs'); ui.tabs.setAttribute('role', 'tablist');
    ui.bar = h('div', 'ts-bar');
    // search
    var search = h('label', 'ts-search');
    search.innerHTML = ICON.search;
    ui.search = h('input'); ui.search.type = 'search'; ui.search.placeholder = 'Search this sheet'; ui.search.setAttribute('aria-label', 'Search this sheet');
    ui.hits = h('output'); ui.hits.setAttribute('aria-live', 'polite');
    ui.prev = iconButton(ICON.up, 'Previous match', function () { stepMatch(-1); });
    ui.next = iconButton(ICON.down, 'Next match', function () { stepMatch(1); });
    search.appendChild(ui.search); search.appendChild(ui.hits); search.appendChild(ui.prev); search.appendChild(ui.next);
    ui.bar.appendChild(search);
    ui.chips = h('div', 'ts-chips'); ui.bar.appendChild(ui.chips);
    ui.comment = h('button', 'ts-btn'); ui.comment.type = 'button'; ui.comment.innerHTML = ICON.comment + '<span>Comment on sheet</span>';
    // The whole sheet is an ordinary table comment (no label of its own), so
    // a new version reconciles it like any other table.
    ui.comment.addEventListener('click', function (e) { e.stopPropagation(); commentOn(cur().table, ui.comment.getBoundingClientRect()); });
    ui.note = h('span', 'ts-note');
    ui.count = h('span', 'ts-count'); ui.count.setAttribute('aria-live', 'polite');
    ui.bar.appendChild(ui.note); ui.bar.appendChild(ui.count); ui.bar.appendChild(ui.comment);
    // grid
    ui.grid = h('div', 'ts-grid');
    ui.grid.tabIndex = 0;
    ui.grid.setAttribute('role', 'grid');
    ui.head = h('div', 'ts-head'); ui.head.setAttribute('role', 'row');
    ui.body = h('div', 'ts-body');
    ui.rows = h('div', 'ts-rows'); ui.rows.setAttribute('role', 'rowgroup');
    ui.body.appendChild(ui.rows);
    ui.grid.appendChild(ui.head); ui.grid.appendChild(ui.body);
    ui.addRow = h('button', 'ts-add-row'); ui.addRow.type = 'button'; ui.addRow.innerHTML = ICON.plus + '<span>Add row</span>';
    ui.addRow.addEventListener('click', function (e) { e.stopPropagation(); insertRows(null, 1); ui.grid.focus({ preventScroll: true }); });
    ui.offAbove = h('button', 'ts-off'); ui.offBelow = h('button', 'ts-off');
    [ui.offAbove, ui.offBelow].forEach(function (b, k) {
      b.type = 'button'; b.hidden = true;
      b.innerHTML = (k ? ICON.down : ICON.up) + '<span></span>';
      b.addEventListener('click', function (e) { e.stopPropagation(); goOffscreen(b); });
    });
    ui.offHidden = h('div', 'ts-note ts-off-hidden'); ui.offHidden.hidden = true;
    root.appendChild(ui.tabs); root.appendChild(ui.bar); root.appendChild(ui.offHidden); root.appendChild(ui.grid); root.appendChild(ui.offAbove); root.appendChild(ui.offBelow); root.appendChild(ui.addRow);
    host.parentNode.insertBefore(root, host);
    wire();
    renderAll();
    post({ type: 'tdoc:sheetReady', tabs: book.tabs.map(function (t) { return t.name; }) });
    return true;
  }
  function iconButton(svg, label, fn) {
    var b = h('button', 'ts-icon'); b.type = 'button'; b.innerHTML = svg; b.setAttribute('aria-label', label); b.title = label;
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn(); });
    return b;
  }
  function canEdit() { return config.editing && mode() === 'edit'; }

  // ---- rendering -----------------------------------------------------------------
  function renderAll() {
    var tab = cur();
    runTab(tab);
    renderTabs(); renderBar(); layout(); renderHead(); renderBody();
  }
  function renderTabs() {
    ui.tabs.textContent = '';
    var editing = canEdit();
    ui.tabs.hidden = book.tabs.length < 2 && !editing;
    book.tabs.forEach(function (tab, i) {
      var b = h('button', 'ts-tab', tab.name);
      b.type = 'button'; b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', i === book.active ? 'true' : 'false');
      b.addEventListener('click', function (e) { e.stopPropagation(); if (book.active !== i) { book.active = i; sel = { r: 0, c: 0, r2: 0, c2: 0 }; ui.grid.scrollTop = 0; ui.grid.scrollLeft = 0; renderAll(); saveView(); } });
      if (editing) {
        b.addEventListener('dblclick', function (e) { e.stopPropagation(); renameTab(i, b); });
        b.addEventListener('contextmenu', function (e) { e.preventDefault(); tabMenu(i, b); });
      }
      ui.tabs.appendChild(b);
    });
    if (editing) {
      var add = iconButton(ICON.plus, 'Add a tab', addTab);
      add.className = 'ts-tab-add';
      ui.tabs.appendChild(add);
      var active = ui.tabs.children[book.active];
      if (active && book.tabs.length) active.title = 'Double-click to rename, right-click for more';
    }
  }
  function renderBar() {
    var tab = cur();
    if (document.activeElement !== ui.search && ui.search.value !== tab.query.search) ui.search.value = tab.query.search;
    var m = tab.matches;
    ui.hits.textContent = tab.query.search ? (m.total ? (tab.matchAt >= 0 ? (tab.matchAt + 1) + ' of ' : '') + fmt(m.total) + (m.capped ? '+' : '') : 'No matches') : '';
    ui.prev.hidden = ui.next.hidden = !m.total;
    ui.chips.textContent = '';
    var any = false;
    Object.keys(tab.query.filters).forEach(function (k) {
      var c = Number(k), col = tab.data.columns[c];
      if (!col) return;
      any = true;
      var chip = h('span', 'ts-chip');
      var label = h('span', null, col.name + ': ' + describeFilter(tab, c, tab.query.filters[k]));
      label.title = label.textContent;
      chip.appendChild(label);
      var x = iconButton(ICON.x, 'Remove filter on ' + col.name, function () { setQuery(Q.setFilter(tab.query, c, null)); });
      chip.appendChild(x);
      label.style.cursor = 'pointer';
      label.addEventListener('click', function (e) { e.stopPropagation(); openFilter(c, chip); });
      ui.chips.appendChild(chip);
    });
    if (tab.query.sort.length > 1 || any) {
      var clear = h('button', 'ts-link', 'Clear all'); clear.type = 'button';
      clear.addEventListener('click', function (e) { e.stopPropagation(); setQuery({ search: tab.query.search, filters: {}, sort: [] }); });
      ui.chips.appendChild(clear);
    }
    var total = tab.index.size, shown = tab.order.length;
    ui.count.textContent = shown === total ? fmt(total) + (total === 1 ? ' row' : ' rows') : fmt(shown) + ' of ' + fmt(total) + ' rows';
    var m2 = mode();
    ui.comment.hidden = m2 !== 'comment';
    ui.addRow.hidden = !canEdit();
    ui.note.hidden = !(m2 === 'edit');
    ui.note.textContent = canEdit() ? 'Type or double-click to edit · paste a range from Excel or Sheets' : m2 === 'edit' ? 'Editing sheets in the browser is not available yet' : '';
  }
  function describeFilter(tab, c, f) {
    var type = tab.index.cols[c].type;
    if (Array.isArray(f.values)) {
      var vals = f.values.map(function (v) { return v === '' ? '(blank)' : v; });
      return vals.length <= 2 ? vals.join(', ') : vals.slice(0, 2).join(', ') + ' +' + (vals.length - 2);
    }
    if (typeof f.checked === 'boolean') return f.checked ? 'checked' : 'unchecked';
    var show = function (v) { return type === 'date' ? Q.formatDate(v) : fmt(v); };
    if (f.min != null && f.max != null) return show(f.min) + ' – ' + show(f.max);
    if (f.min != null) return '≥ ' + show(f.min);
    return '≤ ' + show(f.max);
  }
  // The grid is as tall as its rows, up to most of the frame's height, so a
  // short sheet reads like a table and a long one scrolls inside its frame.
  function layout() {
    var tab = cur();
    var rowsH = Math.max(1, tab.order.length) * ROW_H;
    var room = Math.max(240, innerHeight - (NARROW && NARROW.matches ? 150 : 170));
    var hgt = Math.min(HEAD_H + rowsH + 2 + (tab.totalW > ui.grid.clientWidth ? 14 : 0), room);
    ui.grid.style.height = hgt + 'px';
    ui.body.style.height = (tab.order.length ? tab.order.length * ROW_H : 80) + 'px';
    ui.body.style.width = tab.totalW + 'px';
    ui.head.style.width = (tab.totalW + (canEdit() ? 40 : 0)) + 'px';
  }
  function renderHead() {
    var tab = cur(), W = numW();
    var html = '<div class="ts-corner" style="width:' + W + 'px"></div>';
    var a = Math.min(sel.c, sel.c2), b = Math.max(sel.c, sel.c2);
    tab.data.columns.forEach(function (col, c) {
      var s = -1, dir = null;
      tab.query.sort.forEach(function (k, i) { if (k.col === c) { s = i; dir = k.dir; } });
      var filtered = tab.query.filters[c] != null;
      html += '<div class="ts-h' + (c === 0 ? ' is-first' : '') + (c >= a && c <= b ? ' is-sel' : '') + '" role="columnheader" data-c="' + c + '" style="width:' + tab.widths[c] + 'px' + (c === 0 ? ';left:' + W + 'px' : '') + '"' +
        (dir ? ' aria-sort="' + (dir === 'asc' ? 'ascending' : 'descending') + '"' : '') + '>' +
        '<button type="button" class="ts-hname" data-act="sort" title="Sort by ' + esc(col.name) + ' (shift-click to add)"><span class="ts-glyph" aria-label="' + TYPE_LABEL[tab.index.cols[c].type] + '">' + TYPE_GLYPH[tab.index.cols[c].type] + '</span><b>' + esc(col.name) + '</b>' +
        (dir ? '<span class="ts-sorted">' + (dir === 'asc' ? ICON.up : ICON.down) + (tab.query.sort.length > 1 ? (s + 1) : '') + '</span>' : '') + '</button>' +
        '<button type="button" class="ts-icon' + (filtered ? ' is-on' : '') + '" data-act="filter" aria-label="Filter ' + esc(col.name) + '" title="Filter">' + ICON.filter + '</button>' +
        '<button type="button" class="ts-icon" data-act="menu" aria-label="' + esc(col.name) + ' column menu" title="More">' + ICON.down + '</button>' +
        '<span class="ts-resize" data-act="resize" aria-hidden="true"></span></div>';
    });
    if (canEdit()) html += '<div class="ts-h-add"><button type="button" class="ts-icon" data-act="addcol" aria-label="Add a column" title="Add a column">' + ICON.plus + '</button></div>';
    ui.head.innerHTML = html;
  }
  var rendered = { first: -1, last: -1, c0: -1, c1: -1, key: '' };
  function visibleCols(tab) {
    var left = ui.grid.scrollLeft, right = left + ui.grid.clientWidth;
    var c0 = 0, c1 = tab.widths.length - 1;
    for (var c = 0; c < tab.widths.length; c++) { if (tab.colLeft[c] + tab.widths[c] >= left + numW()) { c0 = c; break; } }
    for (var d = c0; d < tab.widths.length; d++) { if (tab.colLeft[d] > right) { c1 = d; break; } }
    return [Math.max(0, c0 - 1), Math.min(tab.widths.length - 1, c1 + 1)];
  }
  function renderBody(force) {
    var tab = cur();
    var n = tab.order.length;
    if (!n) {
      ui.rows.style.top = '0px';
      ui.rows.innerHTML = '<div class="ts-empty" style="width:' + ui.grid.clientWidth + 'px">' + (tab.index.size ? 'No rows match.' : 'This sheet has no rows yet.') + '</div>';
      rendered.key = 'empty';
      return;
    }
    var top = ui.grid.scrollTop, viewH = ui.grid.clientHeight - HEAD_H;
    var first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    var last = Math.min(n - 1, Math.ceil((top + viewH) / ROW_H) + OVERSCAN);
    var cols = tab.widths.length > 30 ? visibleCols(tab) : [0, tab.widths.length - 1];
    var key = first + ':' + last + ':' + cols[0] + ':' + cols[1];
    if (!force && key === rendered.key) return;
    rendered.key = key;
    var W = numW(), needle = tab.query.search.trim().toLowerCase();
    var ra = Math.min(sel.r, sel.r2), rb = Math.max(sel.r, sel.r2), ca = Math.min(sel.c, sel.c2), cb = Math.max(sel.c, sel.c2);
    var hit = tab.matchAt >= 0 ? tab.matches.hits[tab.matchAt] : null;
    var html = '';
    var list = [];
    if (cols[0] > 0) list.push(0);
    for (var c = cols[0]; c <= cols[1]; c++) list.push(c);
    for (var i = first; i <= last; i++) {
      var r = tab.order[i];
      var rowSel = i >= ra && i <= rb;
      html += '<div class="ts-row" role="row" data-i="' + i + '" style="width:' + tab.totalW + 'px"><div class="ts-n' + (rowSel ? ' is-sel' : '') + '" role="rowheader" style="width:' + W + 'px">' + (r + 1) + '</div>';
      for (var k = 0; k < list.length; k++) {
        var cc = list[k];
        if (k === 1 && list[0] === 0 && cols[0] > 1) html += '<div style="flex:none;width:' + (tab.colLeft[cols[0]] - tab.colLeft[1]) + 'px"></div>';
        html += cellHtml(tab, r, cc, i, rowSel && cc >= ca && cc <= cb, i === sel.r && cc === sel.c, needle, hit && hit.row === r && hit.col === cc);
      }
      html += '</div>';
    }
    ui.rows.style.top = (first * ROW_H) + 'px';
    ui.rows.innerHTML = html;
    placePill();
    placeOffscreen();
  }
  function tagStyle(tag, palette) {
    var colors = Q.TAG_COLORS[Q.tagColor(tag, palette)];
    return 'background:' + colors[0] + ';color:' + colors[1];
  }
  function cellHtml(tab, r, c, i, isSel, isActive, needle, isHitOn) {
    var col = tab.index.cols[c], type = col.type, inner = '', cls = 'ts-c';
    if (c === 0) cls += ' is-first';
    if (type === 'number') cls += ' is-num';
    if (type === 'checkbox') cls += ' is-check';
    if (isSel) cls += ' is-sel';
    if (isActive) cls += ' is-active';
    var hitHere = needle && col.lower[r].indexOf(needle) !== -1;
    if (hitHere) cls += ' is-hit';
    if (isHitOn) cls += ' is-hit-on';
    var td = tab.data.rows[r].tds[c];
    if (td && commented.has(td)) cls += ' has-comment';
    if (type === 'tags') {
      var tags = col.tags[r], pal = tab.palettes[c];
      for (var t = 0; t < tags.length; t++) inner += '<span class="ts-tag" style="' + tagStyle(tags[t], pal) + '">' + mark(tags[t], needle) + '</span>';
    } else if (type === 'checkbox') {
      var on = col.num[r] === 1;
      inner = '<span class="ts-check' + (on ? ' is-on' : '') + '" role="img" aria-label="' + (on ? 'Checked' : 'Not checked') + '">' + (on ? '✓' : '') + '</span>';
    } else {
      var text = col.text[r];
      var href = type === 'url' ? M.safeHref(text) : '';
      inner = href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + mark(text, needle) + '</a>' : '<span class="ts-t">' + mark(text, needle) + '</span>';
    }
    var w = tab.widths[c];
    return '<div class="' + cls + '" role="gridcell" data-c="' + c + '" style="width:' + w + 'px' + (c === 0 ? ';left:' + numW() + 'px' : '') + '"' + (isActive ? ' aria-selected="true"' : '') + ' title="' + esc(col.text[r].slice(0, 300)) + '">' + inner + '</div>';
  }
  function mark(text, needle) {
    if (!needle) return esc(text);
    var lower = String(text).toLowerCase(), out = '', at = 0, k;
    while ((k = lower.indexOf(needle, at)) !== -1) { out += esc(text.slice(at, k)) + '<mark>' + esc(text.slice(k, k + needle.length)) + '</mark>'; at = k + needle.length; }
    return out + esc(text.slice(at));
  }

  // ---- query & view state --------------------------------------------------------
  function setQuery(q, keep) {
    var tab = cur();
    var activeRow = tab.order && tab.order[sel.r];
    tab.query = q;
    tab.matchAt = -1;
    runTab(tab);
    // The active cell follows its row when it is still shown.
    var p = activeRow != null && keep !== false ? tab.pos[activeRow] : -1;
    sel.r = sel.r2 = p >= 0 ? p : 0;
    sel.c2 = sel.c;
    ui.grid.scrollTop = p >= 0 ? ui.grid.scrollTop : 0;
    renderBar(); layout(); renderHead(); renderBody(true);
    if (p >= 0) ensureVisible(p, sel.c);
    saveView();
    relayout();
  }
  var saveTimer = null;
  function viewObject() {
    var view = { active: book.tabs.length > 1 ? cur().name : '', tabs: {} };
    book.tabs.forEach(function (t) { view.tabs[t.name] = t.query; });
    return view;
  }
  function saveView() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var widths = {};
      book.tabs.forEach(function (t) { if (t.resized) widths[t.name] = t.widths; });
      post({ type: 'tdoc:sheetView', hash: Q.encodeView(viewObject()), widths: widths });
    }, 250);
  }
  function applyView(hash, widths) {
    var view = Q.decodeView(hash || '');
    book.tabs.forEach(function (t) {
      var q = view.tabs[t.name];
      if (q) {
        // A saved view never names a column that is not there.
        Object.keys(q.filters).forEach(function (k) { if (Number(k) >= t.data.columns.length) delete q.filters[k]; });
        q.sort = q.sort.filter(function (s) { return s.col < t.data.columns.length; });
        t.query = q;
      }
      var w = widths && widths[t.name];
      if (Array.isArray(w) && w.length === t.data.columns.length) { t.widths = w.map(function (x, i) { return Math.max(48, Math.min(1200, Number(x) || t.widths[i])); }); t.resized = true; }
    });
    var at = book.tabs.findIndex(function (t) { return t.name === view.active; });
    if (at >= 0) book.active = at;
    renderAll();
  }

  // ---- search ---------------------------------------------------------------------
  var searchTimer = null;
  function stepMatch(d) {
    var tab = cur(), m = tab.matches;
    if (!m.hits.length) return;
    tab.matchAt = tab.matchAt < 0 ? (d > 0 ? 0 : m.hits.length - 1) : (tab.matchAt + d + m.hits.length) % m.hits.length;
    var hit = m.hits[tab.matchAt];
    sel.r = sel.r2 = hit.at; sel.c = sel.c2 = hit.col;
    renderBar(); renderHead(); renderBody(true);
    ensureVisible(hit.at, hit.col);
  }

  // ---- selection & scrolling -------------------------------------------------------
  function ensureVisible(i, c) {
    var tab = cur(), g = ui.grid;
    var top = i * ROW_H, viewH = g.clientHeight - HEAD_H;
    if (top < g.scrollTop) g.scrollTop = top;
    else if (top + ROW_H > g.scrollTop + viewH) g.scrollTop = top + ROW_H - viewH;
    if (c > 0) {
      var left = tab.colLeft[c] - tab.colLeft[0] - tab.widths[0], right = tab.colLeft[c] + tab.widths[c];
      if (left < g.scrollLeft) g.scrollLeft = left;
      else if (right > g.scrollLeft + g.clientWidth) g.scrollLeft = right - g.clientWidth;
    }
    renderBody(true);
  }
  function select(i, c, extend) {
    var tab = cur(), n = tab.order.length, cols = tab.widths.length;
    if (!n || !cols) return;
    i = Math.max(0, Math.min(n - 1, i)); c = Math.max(0, Math.min(cols - 1, c));
    if (extend) { sel.r2 = i; sel.c2 = c; } else { sel.r = sel.r2 = i; sel.c = sel.c2 = c; }
    sel.touched = true;
    renderHead();
    if (extend) ensureVisible(i, c); else ensureVisible(sel.r, sel.c);
  }
  function cellAt(i, c) { return ui.rows.querySelector('.ts-row[data-i="' + i + '"] .ts-c[data-c="' + c + '"]'); }
  function srcCell(tab, i, c) {
    var r = tab.order[i];
    return r == null ? null : tab.data.rows[r].tds[c];
  }
  function refLabel(tab, r, c) { return (book.tabs.length > 1 ? tab.name + '!' : '') + Q.columnLetter(c) + (r + 1); }

  // ---- comments --------------------------------------------------------------------
  // A cell, header or whole table is commented through the probe's existing
  // element-comment path. The anchor is a selector stable under sorting and
  // filtering (which never move a row in the document): the table by name,
  // the row by its data-row id, the column by position.
  function attrSel(name, value) { return '[' + name + '="' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]'; }
  function tableSel(table) {
    var name = table.getAttribute('data-name');
    var all = Array.prototype.slice.call(document.querySelectorAll(SEL));
    // A name with a line break cannot sit in a selector string: position.
    if (name != null && !/[\u0000-\u001f\u007f]/.test(name)) {
      var same = all.filter(function (t) { return t.getAttribute('data-name') === name; });
      if (same.length === 1) return 'table[data-tdoc-sheet]' + attrSel('data-name', name);
    }
    return null;
  }
  hooks.selector = function (el) {
    if (!el || !el.closest) return null;
    var table = el.closest(SEL);
    if (!table) return null;
    var ts = tableSel(table);
    if (!ts) return null;
    if (el === table) return ts;
    var cell = el.closest('td,th');
    if (!cell || cell.closest(SEL) !== table) return null;
    var tr = cell.parentElement;
    var n = Array.prototype.indexOf.call(tr.children, cell) + 1;
    if (tr.parentElement && tr.parentElement.tagName === 'THEAD') return ts + ' > thead > tr > :nth-child(' + n + ')';
    var id = tr.getAttribute('data-row');
    if (!id) return null;
    return ts + ' tr' + attrSel('data-row', id) + ' > :nth-child(' + n + ')';
  };
  function locate(el) {
    if (!book || !el || !el.closest) return null;
    var table = el.closest(SEL);
    if (!table) return null;
    var t = book.tabs.findIndex(function (tab) { return tab.table === table; });
    if (t < 0) return null;
    var tab = book.tabs[t];
    if (el === table) return { t: t };
    var cell = el.closest('td,th');
    if (!cell) return { t: t };
    var tr = cell.parentElement;
    var c = Array.prototype.indexOf.call(tr.children, cell);
    if (tr.parentElement && tr.parentElement.tagName === 'THEAD') return { t: t, c: c, head: true };
    var r = tab.rowOf.get(tr);
    return r == null ? { t: t } : { t: t, r: r, c: c };
  }
  // Geometry for a source element the grid stands in for: the cell where it
  // is drawn, else the header, else the grid itself.
  hooks.proxy = function (el) {
    var at = locate(el);
    if (!at) return null;
    if (at.t !== book.active) return ui.tabs.children[at.t] && !ui.tabs.hidden ? ui.tabs.children[at.t] : ui.grid;
    if (at.head) return ui.head.querySelector('.ts-h[data-c="' + at.c + '"]') || ui.grid;
    if (at.r == null) return ui.grid;
    var i = cur().pos[at.r];
    // A row the search or a filter hides: the note under the toolbar.
    if (i < 0) return !ui.offHidden.hidden ? ui.offHidden : ui.count;
    var where = rowPlace(i);
    // Scrolled out of the grid: the "N comments above / below" marker at
    // that edge, so the pin points the way to scroll.
    if (where < 0) return !ui.offAbove.hidden ? ui.offAbove : ui.grid;
    if (where > 0) return !ui.offBelow.hidden ? ui.offBelow : ui.grid;
    return cellAt(i, at.c) || ui.grid;
  };
  // -1 above the grid's visible rows, 1 below, 0 in view.
  function rowPlace(i) {
    var top = i * ROW_H, view = ui.grid.clientHeight - HEAD_H;
    if (top + ROW_H <= ui.grid.scrollTop + 2) return -1;
    if (top >= ui.grid.scrollTop + view - 2) return 1;
    return 0;
  }
  // What the comment layer stores beside the selector: the table by name,
  // the row by id, the column by key. The selector (position) stays the
  // fallback for markup without keys and for a reader without this viewer.
  hooks.anchor = function (el) {
    var at = locate(el);
    if (!at) return null;
    var tab = book.tabs[at.t];
    var out = { table: tab.table.getAttribute('data-name') || '' };
    if (at.c != null) {
      var key = tab.data.columns[at.c] && tab.data.columns[at.c].key;
      if (key) out.key = key;
    }
    if (at.r != null && tab.data.rows[at.r].id) out.row = tab.data.rows[at.r].id;
    return out;
  };
  // The element a sheet anchor names now: its row by id, its column by key,
  // wherever columns have moved since. null when the row or column is gone.
  hooks.resolve = function (anchor) {
    var a = anchor && anchor.sheet;
    if (!a || typeof a !== 'object') return undefined;
    var tables = Array.prototype.slice.call(document.querySelectorAll(SEL)).filter(function (t) { return (t.getAttribute('data-name') || '') === String(a.table || ''); });
    if (tables.length !== 1) return undefined;
    var table = tables[0];
    // No key: markup from before keys, by position as written.
    if (!a.key) return undefined;
    var ths = M.headerCells(table);
    var c = -1;
    for (var k = 0; k < ths.length; k++) if (ths[k].getAttribute('data-key') === String(a.key)) { c = k; break; }
    if (c < 0) return null;
    if (!a.row) return ths[c];
    var tr = null, rows = table.querySelectorAll('tr[data-row]');
    for (var n = 0; n < rows.length; n++) if (rows[n].getAttribute('data-row') === String(a.row)) { tr = rows[n]; break; }
    return tr ? tr.cells[c] || null : null;
  };
  // Bring a source element into view: its tab, its row, its cell selected.
  hooks.reveal = function (el) {
    var at = locate(el);
    if (!at) return false;
    if (at.t !== book.active) { book.active = at.t; renderAll(); }
    if (at.r == null) { ui.root.scrollIntoView({ block: 'nearest' }); return true; }
    var i = cur().pos[at.r];
    if (i < 0) { toast('That cell is hidden by the search or a filter on this sheet.'); return false; }
    ui.root.scrollIntoView({ block: 'nearest' });
    select(i, at.c || 0, false);
    return true;
  };
  var commented = new Map();
  document.addEventListener('tdoc:anchors-resolved', function (e) {
    var d = e.detail || {};
    commented = new Map();
    var targets = d.targets || {};
    (d.comments || []).forEach(function (id) {
      var t = targets[id];
      if (t && t.element && t.element.closest && t.element.closest(SEL)) {
        var list = commented.get(t.element) || [];
        list.push(id);
        commented.set(t.element, list);
      }
    });
    if (book) { renderBody(true); placeOffscreen(); }
  });
  // Comments on rows that are off-screen or filtered out, counted at the
  // grid's edges; a press goes to the nearest one and opens it.
  function placeOffscreen() {
    if (!book || !ui.offAbove) return;
    var tab = cur(), above = [], below = [], hidden = 0;
    commented.forEach(function (ids, el) {
      var at = locate(el);
      if (!at || at.t !== book.active || at.r == null) return;
      var i = tab.pos[at.r];
      if (i < 0) { hidden += ids.length; return; }
      var where = rowPlace(i);
      if (where < 0) above.push({ i: i, ids: ids });
      else if (where > 0) below.push({ i: i, ids: ids });
    });
    var count = function (list) { return list.reduce(function (n, x) { return n + x.ids.length; }, 0); };
    var show = function (el, list, word) {
      var n = count(list);
      el.hidden = !n;
      if (!n) return;
      el.querySelector('span').textContent = n + (n === 1 ? ' comment ' : ' comments ') + word;
      el._target = list.sort(function (a, b) { return word === 'above' ? b.i - a.i : a.i - b.i; })[0];
    };
    show(ui.offAbove, above, 'above');
    show(ui.offBelow, below, 'below');
    ui.offHidden.hidden = !hidden;
    ui.offHidden.textContent = hidden ? hidden + (hidden === 1 ? ' comment is' : ' comments are') + ' on rows the search or filters hide' : '';
    var g = ui.grid.offsetTop;
    ui.offAbove.style.top = (g + HEAD_H + 6) + 'px';
    ui.offBelow.style.top = (g + ui.grid.offsetHeight - 36) + 'px';
  }
  function goOffscreen(el) {
    var t = el._target;
    if (!t) return;
    select(t.i, sel.c, false);
    post({ type: 'tdoc:anchorClick', id: t.ids[0] });
  }
  function commentOn(el, rect, label) {
    document.dispatchEvent(new CustomEvent('tdoc:comment-element', { detail: { el: el, rect: rect, label: label } }));
  }
  var pill = null;
  function placePill() {
    if (pill) { pill.remove(); }
    if (mode() !== 'comment' || !book || !sel.touched) return;
    var tab = cur();
    if (sel.r !== sel.r2 || sel.c !== sel.c2) return;
    var cell = cellAt(sel.r, sel.c), td = srcCell(tab, sel.r, sel.c);
    if (!cell) return;
    if (!pill) {
      pill = provider(h('button', 'tdoc-comment-pill'));
      pill.type = 'button';
      pill.innerHTML = ICON.comment;
    }
    var r = tab.order[sel.r];
    pill.setAttribute('aria-label', 'Comment on ' + refLabel(tab, r, sel.c));
    pill.title = 'Comment on ' + refLabel(tab, r, sel.c) + ' (⌘⌥M)';
    pill.onclick = function (e) { e.preventDefault(); e.stopPropagation(); commentOnCell(); };
    pill.hidden = !td && !ensureCell(tab, r, sel.c, true);
    cell.appendChild(pill);
  }
  function commentOnCell() {
    var tab = cur(), r = tab.order[sel.r];
    if (r == null) return;
    var td = tab.data.rows[r].tds[sel.c];
    if (!td) return;
    if (!tab.data.rows[r].id) { toast('This row has no id yet, so a comment would not survive edits. Comment on the sheet instead.'); }
    var cell = cellAt(sel.r, sel.c);
    commentOn(td, (pill && pill.isConnected ? pill : cell).getBoundingClientRect(), refLabel(tab, r, sel.c) + ' · ' + tab.data.columns[sel.c].name);
  }

  // ---- popover panels: filter ----------------------------------------------------
  function openFilter(c, anchor) {
    var tab = cur(), col = tab.index.cols[c], name = tab.data.columns[c].name;
    var f = tab.query.filters[c] || null;
    openPop(anchor, function (el, p) {
      el.appendChild(h('div', 'ts-ph', 'Filter ' + name));
      if (col.type === 'number' || col.type === 'date') {
        var range = Q.columnRange(tab.index, c) || {};
        var box = h('div', 'ts-range');
        var mk = function (label, val, ph) {
          var l = h('label', null, label), inp = h('input');
          inp.type = col.type === 'date' ? 'date' : 'number';
          if (col.type === 'number') inp.step = 'any';
          inp.placeholder = ph == null ? '' : col.type === 'date' ? Q.formatDate(ph) : String(ph);
          if (val != null) inp.value = col.type === 'date' ? Q.formatDate(val).slice(0, 10) : String(val);
          inp.setAttribute('aria-label', label + ' ' + name);
          l.appendChild(inp); box.appendChild(l); return inp;
        };
        var lo = mk('From', f && f.min, range.min), hi = mk('To', f && f.max, range.max);
        el.appendChild(box);
        var apply = function () {
          var read = function (inp, end) {
            if (!inp.value) return null;
            if (col.type === 'date') { var t = Q.parseDate(inp.value); return t == null ? null : end ? t + 86399999 : t; }
            var n = Number(inp.value); return Number.isFinite(n) ? n : null;
          };
          var a = read(lo, false), b = read(hi, true), next = {};
          if (a != null) next.min = a; if (b != null) next.max = b;
          setQuery(Q.setFilter(tab.query, c, Object.keys(next).length ? next : null));
        };
        var t = null;
        [lo, hi].forEach(function (inp) {
          inp.addEventListener('input', function () { clearTimeout(t); t = setTimeout(apply, 250); });
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); apply(); closePop(true); } });
        });
        // A debounced apply still pending when the panel closes would put
        // back a filter removed a moment later from its chip.
        p.onClose = function () { if (t !== null) { clearTimeout(t); t = null; apply(); } };
      } else if (col.type === 'checkbox') {
        var seg = h('div', 'ts-seg');
        [['All', null], ['Checked', true], ['Not checked', false]].forEach(function (o) {
          var b = h('button', null, o[0]); b.type = 'button';
          b.setAttribute('aria-pressed', (f ? f.checked === o[1] : o[1] === null) ? 'true' : 'false');
          b.addEventListener('click', function (e) {
            e.stopPropagation();
            setQuery(Q.setFilter(tab.query, c, o[1] === null ? null : { checked: o[1] }));
            Array.prototype.forEach.call(seg.children, function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
          });
          seg.appendChild(b);
        });
        el.appendChild(seg);
      } else {
        var values = Q.distinctValues(tab.index, c, 1000);
        var chosen = new Set(f && f.values ? f.values : []);
        var field = h('label', 'ts-field'); field.innerHTML = ICON.search;
        var find = h('input'); find.type = 'search'; find.placeholder = 'Find a value'; find.setAttribute('aria-label', 'Find a value in ' + name);
        field.appendChild(find); el.appendChild(field);
        var list = h('div', 'ts-vals'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Values');
        el.appendChild(list);
        var draw = function () {
          var needle = find.value.trim().toLowerCase();
          list.textContent = '';
          values.filter(function (v) { return !needle || v.value.toLowerCase().indexOf(needle) !== -1; }).slice(0, 300).forEach(function (v) {
            var row = h('label', 'ts-val');
            var cb = h('input'); cb.type = 'checkbox'; cb.checked = chosen.has(v.value);
            cb.addEventListener('change', function () {
              if (cb.checked) chosen.add(v.value); else chosen.delete(v.value);
              setQuery(Q.setFilter(tab.query, c, chosen.size ? { values: Array.from(chosen) } : null));
            });
            row.appendChild(cb);
            if (col.type === 'tags' && v.value) { var tg = h('span', 'ts-tag', v.value); tg.setAttribute('style', tagStyle(v.value, tab.palettes[c])); row.appendChild(tg); }
            else row.appendChild(v.value ? h('span', null, v.value) : h('span', 'ts-blank', '(blank)'));
            row.appendChild(h('span', 'ts-n-of', fmt(v.count)));
            list.appendChild(row);
          });
          if (!list.children.length) list.appendChild(h('div', 'ts-ph', 'No values match.'));
        };
        find.addEventListener('input', draw);
        draw();
      }
      var actions = h('div', 'ts-actions');
      var reset = h('button', null, 'Clear'); reset.type = 'button';
      reset.addEventListener('click', function (e) { e.stopPropagation(); setQuery(Q.setFilter(tab.query, c, null)); closePop(true); });
      var done = h('button', 'is-primary', 'Done'); done.type = 'button';
      done.addEventListener('click', function (e) { e.stopPropagation(); closePop(true); });
      actions.appendChild(reset); actions.appendChild(done);
      el.appendChild(actions);
    }, { label: 'Filter ' + name, returnFocus: ui.grid });
  }

  // ---- column menu -----------------------------------------------------------------
  function columnMenu(c, anchor) {
    var tab = cur(), col = tab.data.columns[c], type = tab.index.cols[c].type;
    var items = [
      { label: 'Sort ascending', onSelect: function () { setQuery(Object.assign(Q.cloneQuery(tab.query), { sort: [{ col: c, dir: 'asc' }] })); } },
      { label: 'Sort descending', onSelect: function () { setQuery(Object.assign(Q.cloneQuery(tab.query), { sort: [{ col: c, dir: 'desc' }] })); } },
      { label: 'Filter…', onSelect: function () { openFilter(c, anchor); } },
    ];
    if (mode() === 'comment') items.push({ label: 'Comment on this column', onSelect: function () { commentOn(col.th, anchor.getBoundingClientRect(), 'Column ' + Q.columnLetter(c) + ' · ' + col.name); } });
    if (canEdit()) {
      items.push('sep');
      items.push({ label: 'Rename…', onSelect: function () { renameColumn(c); } });
      items.push({ header: 'Type' });
      Q.TYPES.forEach(function (t) { items.push({ label: TYPE_LABEL[t], checked: t === type, onSelect: function () { if (t !== type) setColumnType(c, t); } }); });
      items.push('sep');
      items.push({ label: 'Insert column left', onSelect: function () { insertColumn(c); } });
      items.push({ label: 'Insert column right', onSelect: function () { insertColumn(c + 1); } });
      items.push({ label: 'Delete column', danger: true, disabled: tab.data.columns.length < 2, onSelect: function () { deleteColumn(c); } });
    }
    openMenu(anchor, items, col.name + ' column');
  }
  function rowMenu(i, anchor) {
    if (!canEdit()) return;
    var ra = Math.min(sel.r, sel.r2), rb = Math.max(sel.r, sel.r2);
    if (i < ra || i > rb) { ra = rb = i; select(i, sel.c, false); }
    var n = rb - ra + 1;
    openMenu(anchor, [
      { label: 'Insert row above', onSelect: function () { insertRows(cur().order[ra], 1, true); } },
      { label: 'Insert row below', onSelect: function () { insertRows(cur().order[rb], 1, false); } },
      { label: n > 1 ? 'Delete ' + n + ' rows' : 'Delete row', danger: true, onSelect: function () { deleteRows(ra, rb); } },
    ], 'Row menu');
  }
  function tabMenu(i, anchor) {
    openMenu(anchor, [
      { label: 'Rename…', onSelect: function () { renameTab(i, anchor); } },
      { label: 'Delete tab', danger: true, disabled: book.tabs.length < 2, onSelect: function () {
        // The sandbox has no confirm(): a second menu asks.
        openMenu(anchor, [{ header: 'Delete "' + book.tabs[i].name + '" and its ' + fmt(book.tabs[i].index.size) + ' rows?' }, { label: 'Delete tab', danger: true, onSelect: function () { deleteTab(i); } }, { label: 'Cancel', onSelect: function () {} }], 'Confirm delete');
      } },
    ], 'Tab menu');
  }

  // ---- editing ------------------------------------------------------------------------
  // Every change lands in the author's table, then the editor's own draft
  // and dirty state are told, exactly as typing in the page would.
  function changed() {
    document.dispatchEvent(new CustomEvent('tdoc:sheet-edit'));
  }
  function relayout() {
    document.dispatchEvent(new CustomEvent('tdoc:relayout'));
  }
  function record(op) {
    undoStack.push(op);
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
  }
  function undo(redo) {
    var from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack;
    var op = from.pop();
    if (!op) return;
    if (redo) op.redo(); else op.undo();
    to.push(op);
    afterChange(op.tab);
  }
  function afterChange(tab, keepSel) {
    var t = book.tabs.indexOf(tab);
    if (t < 0) { renderAll(); changed(); return; }
    readTab(tab.table, tab);
    if (t === book.active) {
      var activeRow = keepSel != null ? keepSel : null;
      runTab(tab);
      if (activeRow != null && tab.pos[activeRow] >= 0) sel.r = sel.r2 = tab.pos[activeRow];
      sel.r = Math.min(sel.r, Math.max(0, tab.order.length - 1)); sel.r2 = Math.min(sel.r2, Math.max(0, tab.order.length - 1));
      sel.c = Math.min(sel.c, tab.widths.length - 1); sel.c2 = Math.min(sel.c2, tab.widths.length - 1);
      renderTabs(); renderBar(); layout(); renderHead(); renderBody(true);
    }
    changed();
    relayout();
  }
  // A cell that is missing from a short row is created (with any before it).
  function ensureCell(tab, r, c, dryRun) {
    var row = tab.data.rows[r];
    if (row.tds[c]) return row.tds[c];
    if (dryRun) return null;
    var tr = row.tr;
    while (tr.cells.length <= c) tr.appendChild(document.createElement('td'));
    row.tds[c] = tr.cells[c];
    return tr.cells[c];
  }
  // [{ r, c, value }] → one undoable change.
  function setCells(tab, list, keepRow) {
    var before = [], after = [];
    list.forEach(function (ch) {
      var row = tab.data.rows[ch.r];
      var hadCells = row.tr.cells.length;
      var td = ensureCell(tab, ch.r, ch.c);
      before.push({ tr: row.tr, td: td, html: td.innerHTML, cells: hadCells });
      M.writeCell(td, tab.index.cols[ch.c].type, ch.value);
      after.push({ td: td, html: td.innerHTML });
    });
    var op = { tab: tab,
      undo: function () { before.slice().reverse().forEach(function (b) { b.td.innerHTML = b.html; while (b.tr.cells.length > b.cells) b.tr.removeChild(b.tr.lastElementChild); }); },
      redo: function () { after.forEach(function (a, k) { var b = before[k]; while (b.tr.cells.length < b.cells || !b.td.isConnected && b.tr.cells.length <= Array.prototype.indexOf.call(b.tr.cells, b.td)) b.tr.appendChild(document.createElement('td')); if (!b.td.isConnected) b.tr.appendChild(b.td); a.td.innerHTML = a.html; }); } };
    record(op);
    afterChange(tab, keepRow);
  }
  // Structural changes (rows, columns, types, tabs, pastes) snapshot the
  // table; the undo puts the snapshot back.
  function snapshotOp(tab, fn) {
    var table = tab.table;
    var before = { html: table.innerHTML, name: table.getAttribute('data-name') };
    fn();
    var after = { html: table.innerHTML, name: table.getAttribute('data-name') };
    var put = function (s) { table.innerHTML = s.html; if (s.name == null) table.removeAttribute('data-name'); else table.setAttribute('data-name', s.name); };
    record({ tab: tab, undo: function () { put(before); }, redo: function () { put(after); } });
  }

  var editor = null;
  function startEdit(initial) {
    if (!canEdit()) return;
    var tab = cur(), i = sel.r, c = sel.c, r = tab.order[i];
    if (r == null) return;
    sel.r2 = i; sel.c2 = c;
    var type = tab.index.cols[c].type;
    ensureVisible(i, c);
    var cell = cellAt(i, c);
    if (!cell) return;
    if (type === 'checkbox') { setCells(tab, [{ r: r, c: c, value: tab.index.cols[c].num[r] === 1 ? '' : Q.CHECK_MARK }], r); return; }
    if (type === 'tags') { openTagPicker(tab, r, c, cell, initial); return; }
    var input = provider(h('input', 'ts-editor'));
    input.type = 'text';
    input.setAttribute('aria-label', 'Edit ' + refLabel(tab, r, c));
    input.spellcheck = type === 'text';
    if (type === 'date') input.placeholder = 'YYYY-MM-DD';
    if (type === 'number') input.inputMode = 'decimal';
    if (type === 'url') input.inputMode = 'url';
    var g = ui.grid.getBoundingClientRect(), cr = cell.getBoundingClientRect();
    input.style.left = (cr.left - g.left + ui.grid.scrollLeft - 1) + 'px';
    input.style.top = (cr.top - g.top + ui.grid.scrollTop - 1) + 'px';
    input.style.width = Math.max(cr.width + 2, Math.min(420, cr.width * 1.6)) + 'px';
    input.style.height = (cr.height + 2) + 'px';
    input.value = initial != null ? initial : tab.index.cols[c].text[r];
    ui.grid.appendChild(input);
    editor = { input: input, tab: tab, r: r, c: c, i: i };
    input.focus({ preventScroll: true });
    if (initial == null) input.select(); else input.setSelectionRange(input.value.length, input.value.length);
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(); move(e.shiftKey ? -1 : 1, 0); }
      else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); move(0, e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });
    input.addEventListener('blur', function () { if (editor && editor.input === input) commitEdit(); });
    ['input', 'beforeinput', 'paste', 'copy', 'cut', 'keyup'].forEach(function (t) { input.addEventListener(t, function (e) { e.stopPropagation(); }); });
  }
  function commitEdit() {
    if (!editor) return;
    var ed = editor; editor = null;
    var value = ed.input.value;
    ed.input.remove();
    if (value !== ed.tab.index.cols[ed.c].text[ed.r]) setCells(ed.tab, [{ r: ed.r, c: ed.c, value: value }], ed.r);
    ui.grid.focus({ preventScroll: true });
  }
  function cancelEdit() {
    if (!editor) return;
    var ed = editor; editor = null;
    ed.input.remove();
    ui.grid.focus({ preventScroll: true });
  }
  function openTagPicker(tab, r, c, cell, initial) {
    var current = tab.index.cols[c].tags[r].slice();
    var all = Q.distinctValues(tab.index, c, 1000).map(function (v) { return v.value; }).filter(Boolean);
    var pal = tab.palettes[c];
    var start = current.join('\u0000');
    openPop(cell, function (el, p) {
      el.appendChild(h('div', 'ts-ph', tab.data.columns[c].name + ' · ' + refLabel(tab, r, c)));
      var box = h('div', 'ts-tagbox');
      var input = h('input'); input.placeholder = 'Add a tag'; input.setAttribute('aria-label', 'Add a tag');
      var list = h('div', 'ts-vals');
      var hot = 0, browsed = false;
      var draw = function () {
        Array.prototype.slice.call(box.querySelectorAll('.ts-tag')).forEach(function (x) { x.remove(); });
        current.forEach(function (t, k) {
          var tg = h('span', 'ts-tag', t); tg.setAttribute('style', tagStyle(t, pal));
          var x = iconButton(ICON.x, 'Remove ' + t, function () { current.splice(k, 1); draw(); input.focus(); });
          tg.appendChild(x); box.insertBefore(tg, input);
        });
        var needle = input.value.trim().toLowerCase();
        var options = all.filter(function (t) { return current.indexOf(t) === -1 && (!needle || t.toLowerCase().indexOf(needle) !== -1); }).slice(0, 50);
        var exact = all.some(function (t) { return t.toLowerCase() === needle; }) || current.some(function (t) { return t.toLowerCase() === needle; });
        list.textContent = '';
        if (needle && !exact) options.unshift('\u0001' + input.value.trim());
        hot = Math.min(hot, Math.max(0, options.length - 1));
        options.forEach(function (t, k) {
          var isNew = t.charAt(0) === '\u0001', name = isNew ? t.slice(1) : t;
          var b = h('button', 'ts-mi' + (k === hot && (browsed || input.value.trim()) ? ' is-hot' : '')); b.type = 'button';
          if (isNew) b.appendChild(h('span', null, 'Create '));
          var tg = h('span', 'ts-tag', name); tg.setAttribute('style', tagStyle(name, pal)); b.appendChild(tg);
          b.addEventListener('click', function (e) { e.stopPropagation(); add(name); });
          list.appendChild(b);
        });
        list._options = options;
      };
      var add = function (name) {
        name = String(name || '').trim();
        if (!name) return;
        if (current.indexOf(name) === -1) current.push(name);
        if (all.indexOf(name) === -1) all.push(name);
        input.value = ''; hot = 0; browsed = false; draw(); input.focus();
      };
      input.addEventListener('input', function () { hot = 0; browsed = false; draw(); });
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        var opts = list._options || [];
        // Enter adds what was typed (or the suggestion picked with the
        // arrows); on an empty box it is done.
        if (e.key === 'Enter') { e.preventDefault(); if ((input.value.trim() || browsed) && opts[hot]) add(opts[hot].charAt(0) === '\u0001' ? opts[hot].slice(1) : opts[hot]); else closePop(true); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); hot = browsed ? Math.min(opts.length - 1, hot + 1) : 0; browsed = true; draw(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); hot = Math.max(0, hot - 1); browsed = true; draw(); }
        else if (e.key === 'Backspace' && !input.value && current.length) { current.pop(); draw(); }
        else if (e.key === 'Escape') { e.preventDefault(); current = start ? start.split('\u0000') : []; closePop(true); }
        else if (e.key === 'Tab') { e.preventDefault(); closePop(true); move(0, e.shiftKey ? -1 : 1); }
      });
      box.appendChild(input); el.appendChild(box); el.appendChild(list);
      if (initial) input.value = initial;
      draw();
      p.ownEscape = true;
      p.onClose = function () {
        if (current.join('\u0000') !== start) setCells(tab, [{ r: r, c: c, value: current }], r);
      };
      setTimeout(function () { input.focus({ preventScroll: true }); }, 0);
    }, { label: 'Tags for ' + refLabel(tab, r, c), returnFocus: ui.grid });
  }
  function clearSelection() {
    var tab = cur(), list = [];
    forRange(function (r, c) { if (tab.index.cols[c].text[r] !== '') list.push({ r: r, c: c, value: '' }); });
    if (list.length) setCells(tab, list, tab.order[sel.r]);
  }
  function forRange(fn) {
    var tab = cur();
    var ra = Math.min(sel.r, sel.r2), rb = Math.max(sel.r, sel.r2), ca = Math.min(sel.c, sel.c2), cb = Math.max(sel.c, sel.c2);
    for (var i = ra; i <= rb; i++) for (var c = ca; c <= cb; c++) fn(tab.order[i], c, i);
  }
  function newRow(tab, id) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-row', id);
    for (var c = 0; c < tab.data.columns.length; c++) tr.appendChild(document.createElement('td'));
    return tr;
  }
  function rowIds(tab) {
    var max = 0;
    tab.data.rows.forEach(function (row) { var m = /^r(\d+)$/.exec(row.id); if (m) max = Math.max(max, Number(m[1])); });
    return function () { max += 1; return 'r' + max; };
  }
  function bodyOf(table) {
    var b = table.tBodies[table.tBodies.length - 1];
    if (!b) { b = document.createElement('tbody'); table.appendChild(b); }
    return b;
  }
  // Insert after (or before) the document row r; at the end when r is null.
  function insertRows(r, count, before) {
    if (!canEdit()) return;
    var tab = cur(), next = rowIds(tab), added;
    snapshotOp(tab, function () {
      var ref = r == null ? null : tab.data.rows[r].tr;
      for (var k = 0; k < count; k++) {
        var tr = newRow(tab, next());
        if (!ref) bodyOf(tab.table).appendChild(tr);
        else if (before) ref.parentNode.insertBefore(tr, ref);
        else ref.parentNode.insertBefore(tr, ref.nextSibling);
        if (!added) added = tr;
        if (ref && !before) ref = tr;
      }
    });
    readTab(tab.table, tab); runTab(tab);
    var newR = tab.rowOf.get(added);
    afterChange(tab, newR);
    var p = tab.pos[newR];
    if (p >= 0) select(p, r == null ? 0 : sel.c, false);
    else toast('Row added. The current search or filter hides it.');
  }
  function deleteRows(ra, rb) {
    var tab = cur(), trs = [];
    for (var i = ra; i <= rb; i++) trs.push(tab.data.rows[tab.order[i]].tr);
    snapshotOp(tab, function () { trs.forEach(function (tr) { tr.remove(); }); });
    sel.r2 = sel.r = ra;
    afterChange(tab);
  }
  function headRow(tab) {
    var ths = M.headerCells(tab.table);
    if (ths.length) return ths[0].parentElement;
    var thead = tab.table.tHead || tab.table.createTHead();
    var tr = thead.rows[0] || thead.appendChild(document.createElement('tr'));
    return tr;
  }
  // Every header carries a stable key (data-key); a cell comment hangs on
  // it, so a column added or removed elsewhere moves no comment. Markup from
  // before keys gets them the first time its columns change.
  function newHeader(hr, name) {
    var keys = Array.prototype.map.call(hr.cells, function (th) { return th.getAttribute('data-key') || ''; });
    var th = document.createElement('th');
    th.setAttribute('data-key', M.nextColumnKey(keys));
    th.setAttribute('data-type', 'text');
    th.textContent = name;
    return th;
  }
  function ensureKeys(hr) {
    Array.prototype.forEach.call(hr.cells, function (th) {
      if (th.getAttribute('data-key')) return;
      var keys = Array.prototype.map.call(hr.cells, function (x) { return x.getAttribute('data-key') || ''; });
      th.setAttribute('data-key', M.nextColumnKey(keys));
    });
  }
  function insertColumn(at) {
    var tab = cur(), name = 'Column ' + (tab.data.columns.length + 1);
    snapshotOp(tab, function () {
      var hr = headRow(tab);
      ensureKeys(hr);
      var th = newHeader(hr, name);
      hr.insertBefore(th, hr.cells[at] || null);
      tab.data.rows.forEach(function (row) {
        var tr = row.tr;
        while (tr.cells.length < at) tr.appendChild(document.createElement('td'));
        tr.insertBefore(document.createElement('td'), tr.cells[at] || null);
      });
    });
    tab.widths.splice(at, 0, 140);
    tab.query = Q.shiftQueryColumns(tab.query, at, 1);
    afterChange(tab);
    select(sel.r, at, false);
    renameColumn(at);
  }
  function deleteColumn(c) {
    var tab = cur();
    snapshotOp(tab, function () {
      var th = tab.data.columns[c].th; th.remove();
      tab.data.rows.forEach(function (row) { if (row.tr.cells[c]) row.tr.removeChild(row.tr.cells[c]); });
    });
    tab.widths.splice(c, 1);
    tab.query = Q.shiftQueryColumns(tab.query, c, -1);
    sel.c = sel.c2 = Math.max(0, Math.min(sel.c, tab.data.columns.length - 2));
    afterChange(tab);
    saveView();
  }
  function setColumnType(c, type) {
    var tab = cur(), from = tab.index.cols[c];
    snapshotOp(tab, function () {
      tab.data.columns[c].th.setAttribute('data-type', type);
      tab.data.rows.forEach(function (row, r) {
        var text = from.text[r];
        if (!row.tds[c] && !text) return;
        var td = row.tds[c] || ensureCell(tab, r, c);
        var value = type === 'tags' ? (from.tags ? from.tags[r] : Q.splitTags(text)) : type === 'checkbox' ? (Q.parseCheckbox(text) ? Q.CHECK_MARK : '') : text;
        M.writeCell(td, type, value);
      });
    });
    // Filters written for the old type no longer apply.
    tab.query = Q.setFilter(tab.query, c, null);
    afterChange(tab);
    saveView();
  }
  function inlineInput(anchor, value, label, done) {
    openPop(anchor, function (el, p) {
      el.appendChild(h('div', 'ts-ph', label));
      var field = h('label', 'ts-field');
      var input = h('input'); input.value = value; input.setAttribute('aria-label', label);
      field.appendChild(input); el.appendChild(field);
      var actions = h('div', 'ts-actions');
      var cancel = h('button', null, 'Cancel'); cancel.type = 'button';
      var ok = h('button', 'is-primary', 'Save'); ok.type = 'button';
      actions.appendChild(cancel); actions.appendChild(ok); el.appendChild(actions);
      var saved = false;
      p.ownEscape = true;
      var save = function () { if (saved) return; saved = true; var v = input.value.replace(/\s+/g, ' ').trim(); closePop(false); if (v && v !== value) done(v); };
      ok.addEventListener('click', function (e) { e.stopPropagation(); save(); });
      cancel.addEventListener('click', function (e) { e.stopPropagation(); saved = true; closePop(false); });
      input.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') { e.preventDefault(); saved = true; closePop(false); } });
      setTimeout(function () { input.focus(); input.select(); }, 0);
    }, { label: label, returnFocus: ui.grid });
  }
  function renameColumn(c) {
    var tab = cur(), col = tab.data.columns[c];
    var anchor = ui.head.querySelector('.ts-h[data-c="' + c + '"]') || ui.grid;
    inlineInput(anchor, col.name, 'Column name', function (v) {
      snapshotOp(tab, function () { col.th.textContent = v; });
      afterChange(tab);
    });
  }
  function renameTab(i, anchor) {
    var tab = book.tabs[i];
    inlineInput(anchor, tab.name, 'Tab name', function (v) {
      if (book.tabs.some(function (t, k) { return k !== i && t.name === v; })) { toast('Another tab already has that name.'); return; }
      snapshotOp(tab, function () {
        tab.table.setAttribute('data-name', v);
        var cap = tab.table.caption; if (cap) cap.textContent = v;
      });
      tab.name = v;
      afterChange(tab);
      saveView();
    });
  }
  // A new tab is a new table right after the last one, in the same wrapper
  // the importer writes.
  function addTab() {
    var last = book.tabs[book.tabs.length - 1].table;
    var after = last.parentElement && last.parentElement.classList.contains('tdoc-table-scroll') && last.parentElement.children.length === 1 ? last.parentElement : last;
    var n = book.tabs.length + 1, name = 'Sheet ' + n;
    while (book.tabs.some(function (t) { return t.name === name; })) name = 'Sheet ' + (++n);
    var wrap = document.createElement('div'); wrap.className = 'tdoc-table-scroll';
    var html = M.tableHtml({ name: name, columns: [{ name: 'Name', type: 'text' }, { name: 'Notes', type: 'text' }, { name: 'Tags', type: 'tags' }], rows: [{ cells: ['', '', []] }, { cells: ['', '', []] }, { cells: ['', '', []] }] });
    wrap.innerHTML = html;
    after.parentNode.insertBefore(wrap, after.nextSibling);
    var table = wrap.firstElementChild;
    var tab = readTab(table);
    book.tabs.push(tab);
    book.active = book.tabs.length - 1;
    record({ tab: tab, undo: function () { wrap.remove(); book.tabs.splice(book.tabs.indexOf(tab), 1); book.active = Math.min(book.active, book.tabs.length - 1); }, redo: function () { after.parentNode.insertBefore(wrap, after.nextSibling); book.tabs.push(tab); book.active = book.tabs.length - 1; } });
    sel = { r: 0, c: 0, r2: 0, c2: 0 };
    renderAll(); changed(); relayout();
  }
  function deleteTab(i) {
    var tab = book.tabs[i], table = tab.table;
    var node = table.parentElement && table.parentElement.classList.contains('tdoc-table-scroll') && table.parentElement.children.length === 1 ? table.parentElement : table;
    var parent = node.parentNode, nextSib = node.nextSibling;
    // The grid sits before the first table; if that one goes, it moves on.
    node.remove();
    book.tabs.splice(i, 1);
    book.active = Math.max(0, Math.min(book.active, book.tabs.length - 1));
    record({ tab: book.tabs[0], undo: function () { parent.insertBefore(node, nextSib); book.tabs.splice(i, 0, tab); book.active = i; }, redo: function () { node.remove(); book.tabs.splice(book.tabs.indexOf(tab), 1); book.active = Math.max(0, Math.min(book.active, book.tabs.length - 1)); } });
    sel = { r: 0, c: 0, r2: 0, c2: 0 };
    renderAll(); changed(); relayout(); saveView();
  }
  // A range copied from Excel or Google Sheets arrives as tab-separated text.
  // It fills from the active cell, adding rows and columns it needs.
  function pasteText(text) {
    if (!canEdit()) return;
    var grid = M.parseDelimited(String(text).replace(/\r?\n$/, ''), text.indexOf('\t') !== -1 ? '\t' : M.detectDelimiter(text));
    if (!grid.length) return;
    var tab = cur(), i0 = sel.r, c0 = sel.c;
    var single = grid.length === 1 && grid[0].length === 1;
    if (single && (sel.r !== sel.r2 || sel.c !== sel.c2)) {
      // One value into a selected range fills the range.
      var fill = [];
      forRange(function (r, c) { fill.push({ r: r, c: c, value: grid[0][0] }); });
      setCells(tab, fill, tab.order[i0]);
      return;
    }
    var width = grid.reduce(function (w, row) { return Math.max(w, row.length); }, 0);
    // A sheet has at most MAX_COLUMNS columns (as an import): what does not
    // fit is left out, and said so.
    if (c0 + width > MAX_COLUMNS) {
      toast('Only ' + (MAX_COLUMNS - c0) + ' of the ' + width + ' pasted columns fit: a sheet has at most ' + MAX_COLUMNS + ' columns.');
      width = Math.max(0, MAX_COLUMNS - c0);
      grid = grid.map(function (row) { return row.slice(0, width); });
      if (!width) return;
    }
    var cells = grid.length * width;
    if (cells > 200000) { toast('That paste is too large (' + fmt(cells) + ' cells). Import the file instead.'); return; }
    var activeRow = tab.order[i0];
    snapshotOp(tab, function () {
      var needCols = c0 + width - tab.data.columns.length;
      var hr = headRow(tab);
      if (needCols > 0) ensureKeys(hr);
      for (var k = 0; k < needCols; k++) hr.appendChild(newHeader(hr, 'Column ' + (tab.data.columns.length + k + 1)));
      var types = tab.data.columns.map(function (c) { return Q.normalizeType(c.th.getAttribute('data-type')); });
      for (var k2 = 0; k2 < needCols; k2++) types.push('text');
      var next = rowIds(tab);
      var lastTr = null;
      for (var g = 0; g < grid.length; g++) {
        var r = tab.order[i0 + g];
        var tr = r != null ? tab.data.rows[r].tr : null;
        if (!tr) {
          tr = newRow(tab, next());
          if (lastTr && lastTr.parentNode) lastTr.parentNode.insertBefore(tr, lastTr.nextSibling); else bodyOf(tab.table).appendChild(tr);
        }
        lastTr = tr;
        while (tr.cells.length < c0 + width) tr.appendChild(document.createElement('td'));
        for (var c = 0; c < grid[g].length; c++) M.writeCell(tr.cells[c0 + c], types[c0 + c], types[c0 + c] === 'tags' ? Q.splitTags(grid[g][c]) : grid[g][c]);
      }
      if (needCols > 0) tab.data.rows.forEach(function (row) { while (row.tr.cells.length < types.length) row.tr.appendChild(document.createElement('td')); });
    });
    if (tab.widths.length < tab.data.columns.length + 50) { /* widths re-derive in readTab */ }
    afterChange(tab, activeRow);
    sel.r2 = Math.min(tab.order.length - 1, sel.r + grid.length - 1); sel.c2 = Math.min(tab.widths.length - 1, c0 + width - 1);
    renderHead(); renderBody(true);
  }
  // Copied cells land in Excel or Google Sheets, which run a cell starting
  // with = + - @ (or a tab or CR) as a formula: quote it with a leading '.
  // A plain number (-5, +3.2) is left as it is.
  function safeForSpreadsheet(v) {
    if (!/^[=+\-@\t\r]/.test(v)) return v;
    if (/^[+-]?(\d[\d,]*(\.\d*)?|\.\d+)(e[+-]?\d+)?%?$/i.test(v)) return v;
    return "'" + v;
  }
  function copyText() {
    var tab = cur(), lines = [], ra = Math.min(sel.r, sel.r2), rb = Math.max(sel.r, sel.r2), ca = Math.min(sel.c, sel.c2), cb = Math.max(sel.c, sel.c2);
    for (var i = ra; i <= rb; i++) {
      var r = tab.order[i], cells = [];
      for (var c = ca; c <= cb; c++) { var v = safeForSpreadsheet(tab.index.cols[c].text[r]); cells.push(/[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v); }
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  }

  // ---- keyboard, pointer, clipboard ---------------------------------------------------
  function move(dr, dc, extend) {
    var tab = cur();
    var r = (extend ? sel.r2 : sel.r) + dr, c = (extend ? sel.c2 : sel.c) + dc;
    if (!extend && dc && (c < 0 || c >= tab.widths.length) && !dr) {
      // Tab past the last column wraps to the next row, like a spreadsheet.
      if (c >= tab.widths.length) { c = 0; r += 1; } else { c = tab.widths.length - 1; r -= 1; }
    }
    select(r, c, extend);
  }
  function onKey(e) {
    if (!book || editor || (pop && pop.el.contains(e.target))) return;
    var tab = cur(), k = e.key, mod = e.metaKey || e.ctrlKey;
    var page = Math.max(1, Math.floor((ui.grid.clientHeight - HEAD_H) / ROW_H) - 1);
    var last = tab.order.length - 1, lastC = tab.widths.length - 1;
    var handled = true;
    if (k === 'ArrowDown') { if (mod) select(e.shiftKey ? last : last, e.shiftKey ? sel.c2 : sel.c, e.shiftKey); else move(1, 0, e.shiftKey); }
    else if (k === 'ArrowUp') { if (mod) select(0, e.shiftKey ? sel.c2 : sel.c, e.shiftKey); else move(-1, 0, e.shiftKey); }
    else if (k === 'ArrowRight') { if (mod) select(e.shiftKey ? sel.r2 : sel.r, lastC, e.shiftKey); else move(0, 1, e.shiftKey); }
    else if (k === 'ArrowLeft') { if (mod) select(e.shiftKey ? sel.r2 : sel.r, 0, e.shiftKey); else move(0, -1, e.shiftKey); }
    else if (k === 'Tab') { move(0, e.shiftKey ? -1 : 1); }
    else if (k === 'Home') { if (mod) select(0, 0, e.shiftKey); else select(e.shiftKey ? sel.r2 : sel.r, 0, e.shiftKey); }
    else if (k === 'End') { if (mod) select(last, lastC, e.shiftKey); else select(e.shiftKey ? sel.r2 : sel.r, lastC, e.shiftKey); }
    else if (k === 'PageDown') move(page, 0, e.shiftKey);
    else if (k === 'PageUp') move(-page, 0, e.shiftKey);
    else if (k === 'Enter' || k === 'F2') { if (canEdit() && !e.shiftKey) startEdit(); else move(e.shiftKey ? -1 : 1, 0); }
    else if (k === 'Escape') { if (sel.r !== sel.r2 || sel.c !== sel.c2) select(sel.r, sel.c, false); else if (tab.query.search) { ui.search.value = ''; setQuery(Object.assign(Q.cloneQuery(tab.query), { search: '' })); } else handled = false; }
    else if (mod && k.toLowerCase() === 'a') { sel.r = 0; sel.c = 0; sel.r2 = last; sel.c2 = lastC; renderHead(); renderBody(true); }
    else if (mod && k.toLowerCase() === 'f') { ui.search.focus(); ui.search.select(); }
    else if (mod && k.toLowerCase() === 'z' && canEdit()) undo(e.shiftKey);
    else if (mod && k.toLowerCase() === 'y' && canEdit()) undo(true);
    else if (mod && e.altKey && (k.toLowerCase() === 'm' || e.code === 'KeyM') && mode() === 'comment') commentOnCell();
    else if ((k === 'Delete' || k === 'Backspace') && canEdit()) clearSelection();
    else if (k === ' ' && canEdit() && tab.index.cols[sel.c].type === 'checkbox') startEdit();
    else if (k.length === 1 && !mod && !e.altKey && canEdit()) { var type = tab.index.cols[sel.c].type; if (type !== 'checkbox') { startEdit(k); } }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }
  function cellFromEvent(e) {
    var cell = e.target.closest && e.target.closest('.ts-c,.ts-n');
    if (!cell || !ui.rows.contains(cell)) return null;
    var row = cell.parentElement;
    var i = Number(row.getAttribute('data-i'));
    var c = cell.classList.contains('ts-n') ? -1 : Number(cell.getAttribute('data-c'));
    return { i: i, c: c, el: cell };
  }
  var drag = null;
  function wire() {
    ui.grid.addEventListener('keydown', onKey);
    ['input', 'beforeinput', 'keyup'].forEach(function (t) { ui.root.addEventListener(t, function (e) { e.stopPropagation(); }); });
    ui.root.addEventListener('keydown', function (e) { if (e.target !== ui.grid) e.stopPropagation(); });
    ui.search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      var v = ui.search.value;
      searchTimer = setTimeout(function () { setQuery(Object.assign(Q.cloneQuery(cur().query), { search: v }), true); }, 140);
    });
    ui.search.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); if (ui.search.value !== cur().query.search) setQuery(Object.assign(Q.cloneQuery(cur().query), { search: ui.search.value }), true); stepMatch(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); if (ui.search.value) { ui.search.value = ''; setQuery(Object.assign(Q.cloneQuery(cur().query), { search: '' })); } else ui.grid.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); ui.grid.focus(); }
    });
    var ticking = false;
    ui.grid.addEventListener('scroll', function () {
      if (editor) commitEdit();
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; renderBody(); placeOffscreen(); });
      clearTimeout(scrollSettle); scrollSettle = setTimeout(relayout, 200);
    }, { passive: true });
    ui.head.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      var h = b.closest('.ts-h'), c = h ? Number(h.getAttribute('data-c')) : -1, act = b.getAttribute('data-act');
      if (act === 'sort') {
        if (mode() === 'comment' && e.altKey) { commentOn(cur().data.columns[c].th, b.getBoundingClientRect(), 'Column ' + cur().data.columns[c].name); return; }
        setQuery(Q.toggleSort(cur().query, c, e.shiftKey));
      } else if (act === 'filter') openFilter(c, b);
      else if (act === 'menu') columnMenu(c, b);
      else if (act === 'addcol') insertColumn(cur().widths.length);
    });
    // Column resize: drag the right edge of a header.
    ui.head.addEventListener('pointerdown', function (e) {
      var grip = e.target.closest('.ts-resize');
      if (!grip) return;
      e.preventDefault(); e.stopPropagation();
      var c = Number(grip.parentElement.getAttribute('data-c')), tab = cur(), x0 = e.clientX, w0 = tab.widths[c];
      grip.classList.add('is-on');
      grip.setPointerCapture(e.pointerId);
      var onMove = function (ev) { tab.widths[c] = Math.max(48, Math.min(1200, w0 + ev.clientX - x0)); runTab(tab); layout(); renderHead(); renderBody(true); var g2 = ui.head.querySelector('.ts-h[data-c="' + c + '"] .ts-resize'); if (g2) g2.classList.add('is-on'); };
      var onUp = function () { grip.removeEventListener('pointermove', onMove); tab.resized = true; saveView(); var g2 = ui.head.querySelector('.ts-resize.is-on'); if (g2) g2.classList.remove('is-on'); };
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp, { once: true });
      grip.addEventListener('pointercancel', onUp, { once: true });
    });
    ui.head.addEventListener('dblclick', function (e) {
      var h = e.target.closest('.ts-h');
      if (!h || e.target.closest('.ts-resize') || !canEdit()) return;
      renameColumn(Number(h.getAttribute('data-c')));
    });
    ui.rows.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var at = cellFromEvent(e);
      if (!at) return;
      if (e.target.closest('a[href]') && !canEdit()) return;
      if (e.target.closest('.tdoc-comment-pill')) return;
      if (editor) commitEdit();
      if (at.c < 0) {
        // The row number selects the whole row.
        if (e.shiftKey) { sel.r2 = at.i; } else { sel.r = sel.r2 = at.i; }
        sel.c = 0; sel.c2 = cur().widths.length - 1;
        renderHead(); renderBody(true);
        ui.grid.focus({ preventScroll: true });
        return;
      }
      // The comment marker opens the cell's thread.
      var td = srcCell(cur(), at.i, at.c);
      if (td && commented.has(td)) {
        var r = at.el.getBoundingClientRect();
        if (e.clientX > r.right - 12 && e.clientY < r.top + 12) {
          e.preventDefault(); e.stopPropagation();
          post({ type: 'tdoc:anchorClick', id: commented.get(td)[0] });
          return;
        }
      }
      var wasActive = sel.r === at.i && sel.c === at.c && sel.r === sel.r2 && sel.c === sel.c2;
      select(at.i, at.c, e.shiftKey);
      ui.grid.focus({ preventScroll: true });
      if (e.pointerType === 'mouse') drag = { i: at.i, c: at.c };
      // In Edit mode a click on a checkbox toggles it, a second click on a
      // tag cell opens its picker.
      if (canEdit() && !e.shiftKey) {
        var type = cur().index.cols[at.c].type;
        if (type === 'checkbox' && e.target.closest('.ts-check')) { e.preventDefault(); startEdit(); }
        else if (type === 'tags' && wasActive) { e.preventDefault(); startEdit(); }
      }
    });
    // Selecting re-renders the rows, which detaches the element the press
    // began on; left to itself the browser would then move focus to <body>
    // and the keyboard would stop reaching the grid. Focus is ours to move.
    ui.rows.addEventListener('mousedown', function (e) {
      if (!e.target.closest('a[href],input,button')) e.preventDefault();
    });
    ui.rows.addEventListener('pointermove', function (e) {
      if (!drag || !(e.buttons & 1)) { drag = null; return; }
      var at = cellFromEvent(e);
      if (at && at.c >= 0 && (at.i !== sel.r2 || at.c !== sel.c2)) select(at.i, at.c, true);
    });
    document.addEventListener('pointerup', function () { drag = null; });
    ui.rows.addEventListener('dblclick', function (e) {
      var at = cellFromEvent(e);
      if (!at || at.c < 0) return;
      if (canEdit()) { e.preventDefault(); select(at.i, at.c, false); startEdit(); }
    });
    ui.rows.addEventListener('contextmenu', function (e) {
      var at = cellFromEvent(e);
      if (!at || !canEdit()) return;
      e.preventDefault();
      rowMenu(at.i, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
    });
    ui.rows.addEventListener('click', function (e) {
      var at = cellFromEvent(e);
      if (at && at.c < 0 && canEdit()) rowMenu(at.i, at.el);
    });
    ui.grid.addEventListener('copy', function (e) {
      if (editor || !book) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', copyText());
    });
    ui.grid.addEventListener('cut', function (e) {
      if (editor || !canEdit()) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', copyText());
      clearSelection();
    });
    ui.grid.addEventListener('paste', function (e) {
      if (editor || !canEdit()) return;
      e.preventDefault(); e.stopPropagation();
      pasteText(e.clipboardData.getData('text/plain') || '');
    });
  }
  var scrollSettle = null;

  // ---- shell bridge ---------------------------------------------------------------------
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !e.data || e.data.source !== 'tdoc-shell' || !book) return;
    var d = e.data;
    if (d.type === 'tdoc:mode') {
      if (editor) commitEdit();
      closePop(true);
      renderTabs(); renderBar(); layout(); renderHead(); renderBody(true);
    } else if (d.type === 'tdoc:sheetConfig') {
      config.editing = d.editing === true;
      if (!config.received) { config.received = true; applyView(d.hash, d.widths); }
      else renderAll();
    } else if (d.type === 'tdoc:editRestore') {
      // A draft was restored into the page: read the tables again.
      setTimeout(reload, 0);
    }
  });
  function reload() {
    if (!book) return;
    var tables = Array.prototype.slice.call(document.querySelectorAll(SEL));
    var old = book.tabs;
    book.tabs = tables.map(function (t) { var o = old.find(function (x) { return x.name === (t.getAttribute('data-name') || ''); }); return readTab(t, o); });
    if (!book.tabs.length) { ui.root.remove(); book = null; return; }
    book.active = Math.min(book.active, book.tabs.length - 1);
    renderAll();
  }
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (book) { runTab(cur()); layout(); renderHead(); renderBody(true); } }, 60);
  });

  window.__tdocSheets = {
    mounted: false,
    // Read-only views for tests and the future comment panel.
    tabs: function () { return book ? book.tabs.map(function (t) { return { name: t.name, rows: t.index.size, shown: t.order ? t.order.length : 0, query: Q.cloneQuery(t.query) }; }) : []; },
    active: function () { return book ? book.active : -1; },
    selection: function () { return Object.assign({}, sel); },
  };
  // Mounted: the tables are hidden by the viewer's own style now, so the
  // frame's 200-row hold (#tdoc-sheets-pending) is no longer needed.
  if (mount()) { window.__tdocSheets.mounted = true; relayout(); }
  var held = document.getElementById('tdoc-sheets-pending');
  if (held) held.remove();
})();
