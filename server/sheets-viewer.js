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
// localStorage, and nothing here writes them into the document. So is the
// summary row at the grid's foot (Sum / Average / Count / Unique per column,
// over the rows the view shows), picked from a column's menu or the row itself.
//
// Column widths, row heights, Wrap text and alignment are the document's
// (data-width / data-height / data-wrap / data-align, sheet-markup.mjs) when
// someone who may edit the doc changes them: the change goes through Edit
// mode and the editor's own draft and Save, from whichever mode it was
// made in. A reader without edit rights changes them for themselves only:
// view state, kept by the shell beside the #hash, never saved. A wrapped
// column grows its rows: row tops are a prefix sum over estimated heights,
// corrected by measuring the rows on screen, so 10,000 rows still scroll.
//
// In Edit mode (doc owners and editors) a cell is
// edited in place and written back into its <td>, rows and columns are added
// and removed, a column's type is set, tags are picked from the column's
// own, and a range pasted from Excel or Google Sheets fills the grid. Every
// change goes through the editor's own draft and Save (a new version).
//
// Structure (row groups, hidden rows and columns, freeze, reordering tabs)
// is server/sheets-structure.js, reached through the hooks marked
// [structure] below; its markup and pure logic are shared/sheet-outline.mjs.
//
// Served at /sheets-viewer.js and loaded by server/sheets-loader.js only when
// the doc has a sheet. SheetQuery, SheetMarkup and DocType are
// shared/sheet-query.mjs, shared/sheet-markup.mjs and shared/doc-type.mjs,
// inlined by server/sheets-source.js.
(function () {
  'use strict';
  if (window === window.parent || window.__tdocSheets) return;
  if (new URLSearchParams(location.search).get('tdoc_compare') === '1') return;
  var Q = SheetQuery, M = SheetMarkup;
  var SEL = M.SHEET_SELECTOR;
  var NARROW = window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;
  var ROW_H = 32, HEAD_H = 34, OVERSCAN = 6, MAX_COLUMNS = 200;
  // A sheet of COMPACT_ROWS rows or fewer in a prose doc is a small table
  // (server/block-lint.js warns about it): compact, at most EMBED_ROWS tall.
  var COMPACT_ROWS = 20, EMBED_ROWS = 15;
  // [structure] the row-number column grows by the row outline's gutter.
  function numW() { return (NARROW && NARROW.matches ? 36 : 48) + (S ? S.gutterW() : 0); }
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
    expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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
    // Column resize: a 12px grip over the header's right edge (24px where
    // the pointer is a finger), a 2px line where it is.
    '.ts-resize{position:absolute;top:0;right:-6px;width:12px;height:100%;cursor:col-resize;z-index:3;touch-action:none}',
    '.ts-resize:hover,.ts-resize.is-on{background:linear-gradient(90deg,transparent 5px,var(--ts-accent) 5px,var(--ts-accent) 7px,transparent 7px)}',
    '@media (pointer:coarse){.ts-resize{right:-12px;width:24px}.ts-resize:hover,.ts-resize.is-on{background:linear-gradient(90deg,transparent 11px,var(--ts-accent) 11px,var(--ts-accent) 13px,transparent 13px)}}',
    '.ts-head.is-sizing,.ts-head.is-sizing *{cursor:col-resize!important}',
    '.ts-rows.is-sizing,.ts-rows.is-sizing *{cursor:row-resize!important}',
    '.tdoc-sheet.is-sizing{-webkit-user-select:none;user-select:none}',
    // Row resize: the same grip along the row number's bottom edge.
    '.ts-rresize{position:absolute;left:0;right:0;bottom:-5px;height:10px;cursor:row-resize;z-index:3;touch-action:none}',
    '.ts-rresize:hover,.ts-rresize.is-on{background:linear-gradient(180deg,transparent 4px,var(--ts-accent) 4px,var(--ts-accent) 6px,transparent 6px)}',
    '@media (pointer:coarse){.ts-rresize{bottom:-10px;height:20px}.ts-rresize:hover,.ts-rresize.is-on{background:linear-gradient(180deg,transparent 9px,var(--ts-accent) 9px,var(--ts-accent) 11px,transparent 11px)}}',
    '.ts-h-add{flex:none;width:40px;display:flex;align-items:center;justify-content:center}',
    '.ts-body{position:relative}',
    // summary row: stuck to the grid's foot, one figure per column
    '.ts-foot{position:sticky;bottom:0;z-index:4;display:flex;height:' + ROW_H + 'px;background:var(--ts-head);border-top:1px solid #d9d9df}',
    '.ts-foot[hidden]{display:none!important}',
    '.ts-fcorner{position:sticky;left:0;z-index:2;flex:none;display:flex;align-items:center;justify-content:center;background:var(--ts-head);border-right:1px solid var(--ts-line);color:#8a8a94;font-weight:600}',
    '.ts-fc{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0;height:100%;padding:0 8px;border:0;border-right:1px solid var(--ts-line);border-radius:0;background:var(--ts-head);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-align:right}',
    '.ts-fc.is-first{position:sticky;z-index:1}',
    '.ts-fc:hover{background:#ececf0}',
    '.ts-fc small{color:var(--ts-muted);font-size:11px;font-weight:500}',
    '.ts-fc b{font-weight:600;overflow:hidden;text-overflow:ellipsis}',
    '.ts-fc.is-none small{opacity:0}',
    '.ts-fc.is-none:hover small,.ts-fc.is-none:focus-visible small{opacity:1}',
    '.ts-rows{position:absolute;left:0;top:0}',
    '.ts-row{display:flex;height:' + ROW_H + 'px;background:#fff}',
    '.ts-row:hover{background:#fafafc}',
    '.ts-n{position:sticky;left:0;z-index:2;flex:none;display:flex;align-self:stretch;align-items:center;justify-content:flex-end;padding:0 8px;border-right:1px solid var(--ts-line);border-bottom:1px solid var(--ts-line);background:var(--ts-head);color:#8a8a94;font-size:11px;font-variant-numeric:tabular-nums}',
    '.ts-n.is-sel{background:#e6ecfb;color:var(--ts-ink)}',
    '.ts-c{position:relative;flex:none;display:flex;align-items:center;gap:4px;padding:0 8px;border-right:1px solid var(--ts-line);border-bottom:1px solid var(--ts-line);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;background:inherit}',
    '.ts-c>span.ts-t{overflow:hidden;text-overflow:ellipsis}',
    // A line break shows: clipped, the cell keeps its first line in place
    // (and more in a taller row); wrapped, the text wraps and the row grows.
    '.ts-c.is-ml{align-items:flex-start;padding-top:7px}',
    '.ts-c.is-ml>span.ts-t{white-space:pre}',
    '.ts-c.is-wrap{align-items:flex-start;flex-wrap:wrap;align-content:flex-start;padding-top:7px;padding-bottom:7px;white-space:normal}',
    '.ts-c.is-wrap>span.ts-t,.ts-c.is-wrap>a{white-space:pre-wrap;overflow-wrap:anywhere;text-overflow:clip;min-width:0;max-width:100%}',
    '.ts-c.is-num-t{font-variant-numeric:tabular-nums}',
    '.ts-c.al-left{justify-content:flex-start;text-align:left}',
    '.ts-c.al-center{justify-content:center;text-align:center}',
    '.ts-c.al-right{justify-content:flex-end;text-align:right}',
    '.ts-c.is-first{position:sticky;z-index:1;background:#fff}',
    '.ts-row:hover .ts-c.is-first{background:#fafafc}',
    '.ts-c.is-num{justify-content:flex-end;text-align:right;font-variant-numeric:tabular-nums}',
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
    '.ts-editor{position:absolute;z-index:6;margin:0;padding:6px 8px;resize:none;overflow:hidden;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere;border:2px solid var(--ts-accent);border-radius:2px;background:#fff;font:inherit;font-size:13px;color:inherit;outline:0;box-shadow:0 4px 14px rgba(0,0,0,.12);-webkit-user-select:text;user-select:text}',
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
    // Read mode shows no comment affordances, as on a prose page.
    'html:not([data-tdoc-interaction-mode="comment"]):not([data-tdoc-interaction-mode="edit"]) .tdoc-sheet .ts-c.has-comment::after{display:none}',
    // Full screen: the same grid, fixed over the page (the shell makes the
    // frame fill the window), so its view and comments carry over as they are.
    // Not the top layer: menus and filter panels open from <body> and must
    // stay above it, and the reader's dark inversion on <html> keeps applying.
    '.tdoc-sheet.is-expanded{position:fixed;inset:0;z-index:2147483000;margin:0;display:flex;flex-direction:column;background:#fff;padding:10px max(16px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}',
    // A gutter on the right for the page's comment pins, where the window
    // has room for one (as beside a doc's reading column).
    '@media (min-width:900px){.tdoc-sheet.is-expanded{padding-right:56px}}',
    '.tdoc-sheet.is-expanded .ts-grid{flex:1 1 auto;min-height:0;width:100%;max-width:none}',
    '.tdoc-sheet.is-expanded .ts-tabs,.tdoc-sheet.is-expanded .ts-bar,.tdoc-sheet.is-expanded .ts-add-row{flex:none}',
    '.ts-xhead{display:flex;align-items:center;gap:8px;min-height:36px;margin:0 0 8px}',
    '.ts-xhead[hidden],.tdoc-sheet.is-expanded .ts-tabs[hidden]{display:none!important}',
    '.ts-xtitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:600}',
    'a.ts-btn{text-decoration:none;color:inherit}',
    '.ts-xhead .ts-icon{width:32px;height:32px}',
    '.ts-xhead .ts-icon svg{width:18px;height:18px}',
    '@media (max-width:640px){',
    '.ts-bar{gap:6px}.ts-search{flex:1 1 100%}.ts-count{margin-left:0}',
    '.ts-search{order:-2}.ts-bar>.ts-expand{order:-1}.ts-bar:has(>.ts-expand:not([hidden])) .ts-search{flex-basis:calc(100% - 40px)}',
    '.tdoc-sheet.is-expanded{padding-top:6px}.ts-xhead .ts-btn{padding:0 8px}.ts-xhead .ts-btn span{display:none}',
    '.ts-pop{left:0!important;right:0!important;top:auto!important;bottom:0!important;max-width:none;width:100%;max-height:70vh;border-radius:14px 14px 0 0;padding:10px 10px max(10px,env(safe-area-inset-bottom))}.ts-pop .ts-actions{margin-right:84px}',
    '.ts-mi{min-height:44px}.ts-val{min-height:40px}',
    '.ts-n{padding:0 4px}',
    '}',
    // A small sheet in a prose doc is one block among paragraphs: one short row
    // of controls. Search is its icon until clicked (or holding a query), the
    // count and buttons are small, and the grid is as tall as its rows.
    '.tdoc-sheet.is-compact:not(.is-expanded) .ts-bar{gap:4px;min-height:28px;margin:0 0 6px}',
    '.tdoc-sheet.is-compact:not(.is-expanded) .ts-search{order:0;height:28px;flex:1 1 180px;max-width:300px}',
    '.tdoc-sheet.is-compact:not(.is-expanded) .ts-search:not(:focus-within):not(.has-q){flex:0 0 28px;padding:0 5px;border-color:transparent;cursor:pointer}',
    '.tdoc-sheet.is-compact:not(.is-expanded) .ts-search:not(:focus-within):not(.has-q):hover{background:var(--ts-head)}',
    '.tdoc-sheet.is-compact:not(.is-expanded) .ts-search:not(:focus-within):not(.has-q) input{flex:0 0 0;min-width:0;width:0;padding:0}',
    '.tdoc-sheet.is-compact:not(.is-expanded) .ts-count{order:1;margin-left:auto;font-size:12px}',
    '.tdoc-sheet.is-compact:not(.is-expanded) .ts-bar>.ts-btn,.tdoc-sheet.is-compact:not(.is-expanded) .ts-bar>.ts-expand{order:2}',
    '.tdoc-sheet.is-compact:not(.is-expanded) .ts-bar>.ts-btn{height:28px;padding:0 6px;border-color:transparent;background:transparent;color:var(--ts-muted)}',
    '.tdoc-sheet.is-compact:not(.is-expanded) .ts-bar>.ts-btn:hover{background:var(--ts-head);color:var(--ts-ink)}',
    '.tdoc-sheet.is-compact:not(.is-expanded) .ts-bar>.ts-btn span{display:none}',
    // ...and its rows read as a table that fits the column: text wraps and
    // rows grow, columns share the width, at most about 15 rows tall. On a
    // phone, more than three columns read as one card per row. Full screen
    // and Edit mode keep the grid.
    '.tdoc-sheet.is-flat .ts-grid{display:none!important}.tdoc-sheet:not(.is-flat) .ts-flat{display:none}',
    '.ts-flat{position:relative;overflow:auto;border:1px solid var(--ts-line);border-radius:8px;background:#fff;overscroll-behavior:auto}',
    '.ts-flat table{width:100%;border-collapse:separate;border-spacing:0;table-layout:auto;margin:0;font:inherit}',
    '.ts-flat th{position:sticky;top:0;z-index:2;padding:0;background:var(--ts-head);border-bottom:1px solid #d9d9df;text-align:left;vertical-align:bottom}',
    '.ts-flat th button{display:flex;align-items:center;gap:4px;width:100%;min-height:' + HEAD_H + 'px;padding:6px 8px;border:0;background:transparent;font-weight:600;text-align:left;white-space:normal}',
    '.ts-flat th button:hover{background:#ececf0}',
    '.ts-flat td{position:relative;padding:7px 8px;border-bottom:1px solid var(--ts-line);vertical-align:top;white-space:normal;overflow-wrap:break-word;min-width:6em;max-width:28em;background:#fff}',
    '.ts-flat tr:last-child td{border-bottom:0}',
    '.ts-flat :is(th,td):first-child{position:sticky;left:0;z-index:1}.ts-flat th:first-child{z-index:3}',
    '.ts-flat td.is-num{text-align:right;white-space:nowrap;min-width:0;font-variant-numeric:tabular-nums}',
    '.ts-flat td.is-short{white-space:nowrap;min-width:0}',
    '.ts-flat .is-ml{white-space:pre-line}.ts-flat td.al-left{text-align:left}.ts-flat td.al-center{text-align:center}.ts-flat td.al-right{text-align:right}',
    '.ts-flat td.is-hit{background:#fffbe0}',
    '.ts-flat .ts-tag{display:inline-block;margin:1px 4px 1px 0;max-width:none;white-space:nowrap}',
    '.ts-flat mark{background:var(--ts-hit);color:inherit;border-radius:2px;padding:0}',
    '.ts-flat a{color:var(--ts-accent);text-decoration:none}',
    '.ts-flat .has-comment::after{content:"";position:absolute;top:0;right:0;border-style:solid;border-width:0 9px 9px 0;border-color:transparent #f5a524 transparent transparent}',
    'html[data-tdoc-interaction-mode="comment"] .ts-flat :is(td,.ts-card-l,.ts-card-t){cursor:cell}',
    '.ts-flat-empty{margin:0;padding:12px;color:var(--ts-muted)}',
    '.ts-flat.is-cards{border:0;background:transparent}',
    '.ts-card{border:1px solid var(--ts-line);border-radius:8px;padding:8px 12px;margin:0 0 8px;background:#fff}',
    '.ts-card-t{position:relative;margin:0 0 4px;font-weight:600;font-size:14px}',
    '.ts-card-l{position:relative;margin:2px 0;overflow-wrap:break-word}.ts-card-k{color:var(--ts-muted)}',
    // A sheet the reading column cramps takes the page width beside it.
    '@media screen{.tdoc-sheet.is-wide:not(.is-expanded){width:var(--ts-wide-w);max-width:none;margin-left:var(--ts-wide-ml)}}',
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
    var tab = old || { query: Q.emptyQuery(), widths: [], matchAt: -1, local: emptyLocal(), defW: {} };
    tab.table = table;
    tab.data = data;
    tab.name = cleanName(data.name) || 'Sheet ' + (book ? book.tabs.indexOf(tab) + 1 || book.tabs.length + 1 : 1);
    tab.index = Q.buildIndex(data);
    tab.palettes = data.columns.map(function (c) { return Q.parsePalette(c.palette); });
    FX.read(tab); // [format] cell formats and merges (sheets-format-ui.js)
    tab.rowOf = new Map();
    data.rows.forEach(function (row, r) { tab.rowOf.set(row.tr, r); });
    // Measured heights are kept by row element across a re-read: an edit
    // forgets only the rows it touched (setCells), a layout change all.
    if (!tab.measured) tab.measured = new Map();
    // Rows with a line break in a cell: as many lines tall as their longest
    // (as Excel and Sheets do once a break is typed). Found once per read.
    tab.lines = null;
    tab.index.cols.forEach(function (col) {
      if (col.type === 'tags' || col.type === 'checkbox') return;
      for (var r = 0; r < col.text.length; r++) {
        var t = col.text[r];
        if (t.indexOf('\n') === -1) continue;
        var n = t.split('\n').length;
        if (!tab.lines) tab.lines = new Map();
        if (n > (tab.lines.get(r) || 1)) tab.lines.set(r, n);
      }
    });
    readLayout(tab);
    S.read(tab); // [structure]
    return tab;
  }
  // ---- layout: widths, heights, wrap, alignment ------------------------------
  // The document's (data-width … on the markup) unless this reader set their
  // own (tab.local, by column key and row id); a reader who may edit the doc
  // has no own layout: what they change is the document's.
  // Keyed by the author's column keys and row ids: no prototype, so a key
  // such as "constructor" is only ever a key.
  function emptyLocal() { return { w: Object.create(null), h: Object.create(null), wrap: Object.create(null), align: Object.create(null) }; }
  function colKey(tab, c) { return tab.data.columns[c].key || '#' + c; }
  function useLocal() { return !config.canEditDoc; }
  function readLayout(tab) {
    var loc = useLocal() ? tab.local : emptyLocal();
    tab.widths = tab.data.columns.map(function (col, c) {
      var k = colKey(tab, c);
      if (loc.w[k]) return loc.w[k];
      if (col.width) return col.width;
      return tab.defW[k] || (tab.defW[k] = defaultWidth(tab, c));
    });
    tab.wrap = tab.data.columns.map(function (col, c) { var k = colKey(tab, c); return k in loc.wrap ? !!loc.wrap[k] : col.wrap; });
    tab.align = tab.data.columns.map(function (col, c) { var k = colKey(tab, c); return loc.align[k] || col.align || ''; });
    tab.anyWrap = tab.wrap.some(Boolean);
    var hs = null;
    tab.data.rows.forEach(function (row, r) {
      var v = (row.id && loc.h[row.id]) || row.height;
      if (v) { if (!hs) hs = new Map(); hs.set(r, v); }
    });
    tab.heights = hs;
  }
  // A row's height: set by hand, else one line, else (a wrapped column) as
  // tall as its longest wrapped cell: measured once drawn, estimated before.
  var LINE_H = 18, PAD_Y = 14, CHAR_W = 7.1;
  function rowHeight(tab, r) {
    var set = tab.heights && tab.heights.get(r);
    if (set) return set;
    var lines = (tab.lines && tab.lines.get(r)) || 1;
    if (!tab.anyWrap) return lines > 1 ? Math.min(M.MAX_HEIGHT, lines * LINE_H + PAD_Y) : ROW_H;
    var m = tab.measured.get(tab.data.rows[r].tr);
    if (m) return m;
    for (var c = 0; c < tab.wrap.length; c++) {
      if (!tab.wrap[c]) continue;
      var text = tab.index.cols[c].text[r];
      if (!text) continue;
      var room = Math.max(8, (tab.widths[c] - 18) / CHAR_W), n = 0, seg = text.split('\n');
      for (var k = 0; k < seg.length; k++) n += Math.max(1, Math.ceil(seg[k].length / room));
      if (n > lines) lines = n;
    }
    return Math.min(M.MAX_HEIGHT, Math.max(ROW_H, lines * LINE_H + PAD_Y));
  }
  // Row geometry in view order: tops[i] is row i's top, tops[n] the total.
  // null while every row is ROW_H tall (most sheets): i * ROW_H then.
  function buildTops(tab) {
    var n = tab.order.length;
    if (!tab.heights && !tab.anyWrap && !tab.lines) { tab.tops = null; return; }
    var tops = new Float64Array(n + 1), y = 0;
    for (var i = 0; i < n; i++) { tops[i] = y; y += rowHeight(tab, tab.order[i]); }
    tops[n] = y;
    tab.tops = tops;
  }
  function rowTop(tab, i) { return tab.tops ? tab.tops[i] : i * ROW_H; }
  function rowH(tab, i) { return tab.tops ? tab.tops[i + 1] - tab.tops[i] : ROW_H; }
  function rowsHeight(tab) { return tab.tops ? tab.tops[tab.order.length] : tab.order.length * ROW_H; }
  // The row at y (in the body), by binary search over the tops.
  function rowAtY(tab, y) {
    var n = tab.order.length;
    if (!tab.tops) return Math.max(0, Math.min(n - 1, Math.floor(y / ROW_H)));
    var lo = 0, hi = n - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (tab.tops[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo;
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
    // [structure] hidden rows out (tab.sorder), then collapsed groups (tab.order).
    S.run(tab);
    tab.pos = new Int32Array(tab.index.size).fill(-1);
    for (var i = 0; i < tab.order.length; i++) tab.pos[tab.order[i]] = i;
    // Search finds a match in a collapsed group too; stepping to it opens it.
    tab.matches = S.shownHits(tab, Q.searchMatches(tab.index, tab.sorder, tab.query.search)); // [structure] not in hidden columns
    S.spans(tab);
    FX.view(tab); // [format] which merges this view draws merged (after [structure]: hidden rows and columns, freeze)
    if (tab.matchAt >= tab.matches.hits.length) tab.matchAt = -1;
    tab.colLeft = [];
    var x = numW();
    for (var c = 0; c < tab.widths.length; c++) { tab.colLeft.push(x); x += S.colW(tab, c); }
    tab.totalW = x;
    buildTops(tab);
  }
  // Widths changed (a resize): the columns' lefts and, where a column
  // wraps, the rows' heights follow.
  function reflow(tab) {
    tab.colLeft = [];
    var x = numW();
    for (var c = 0; c < tab.widths.length; c++) { tab.colLeft.push(x); x += S.colW(tab, c); }
    tab.totalW = x;
    if (tab.anyWrap) tab.measured = new Map();
    buildTops(tab);
  }
  function cur() { return book && book.tabs[book.active]; }

  // ---- mount --------------------------------------------------------------------
  var ui = {};
  // Full screen: on, opened as the sheet's own page (alone: its tab, 1-based),
  // whether the doc is nothing but the sheet, and the doc path from the shell.
  var expand = { on: false, alone: 0, sheetOnly: false, embed: false, fit: false, path: '', scroll: null, style: null };
  var sel = { r: 0, c: 0, r2: 0, c2: 0 };
  var config = { editing: false, canEditDoc: false, received: false };
  var undoStack = [], redoStack = [];
  // [format] Cell formatting and merged cells: server/sheets-format-ui.js,
  // given the few internals it needs. The hooks below are marked [format].
  var FX = SheetFormatUI({
    ui: ui, h: h, provider: provider, cur: cur, sel: function () { return sel; }, canEdit: canEdit,
    isEditing: function () { return !!editor; }, openPop: openPop, closePop: closePop, menuItems: menuItems,
    toast: toast, record: record, afterChange: afterChange, ensureCell: ensureCell, rowH: rowH,
    embedded: function () { return !expand.sheetOnly && !expand.on; },
    structure: function () { return S; }, // [structure] hidden columns and freeze, for which merges draw merged
  });

  // [structure] groups, hidden rows and columns, freeze and tab operations
  // live in server/sheets-structure.js; it reaches the viewer only through
  // this object.
  var S = SheetStructure({
    Q: Q, HEAD_H: HEAD_H,
    get book() { return book; }, get sel() { return sel; },
    get config() { return config; }, get undoStack() { return undoStack; }, get expand() { return expand; },
    ui: ui, h: h, provider: provider, esc: esc, mode: mode, canEdit: canEdit, cur: cur, numW: numW,
    openMenu: openMenu, toast: toast, post: post, record: record, undo: undo, afterChange: afterChange, runTab: runTab,
    renderAll: renderAll, renderBar: renderBar, layout: layout, renderHead: renderHead, renderBody: renderBody, rowsHtml: rowsHtml,
    relayout: relayout, changed: changed, saveView: saveView, flatView: flatView, rowTop: rowTop, rowH: rowH, deleteTab: deleteTab,
  });

  function mount() {
    var tables = Array.prototype.slice.call(document.querySelectorAll(SEL)).filter(function (t) { return !t.closest('[data-tdoc-provider]'); });
    if (!tables.length) return false;
    book = { tabs: [], active: 0 };
    tables.forEach(function (t) { book.tabs.push(readTab(t)); });
    book.tabs = S.stripOrder(book.tabs); // [structure] data-order: the strip's order
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
    ui.searchBox = search;
    ui.comment = h('button', 'ts-btn'); ui.comment.type = 'button'; ui.comment.innerHTML = ICON.comment + '<span>Comment on sheet</span>'; ui.comment.setAttribute('aria-label', 'Comment on sheet'); ui.comment.title = 'Comment on sheet';
    // The whole sheet is an ordinary table comment (no label of its own), so
    // a new version reconciles it like any other table.
    ui.comment.addEventListener('click', function (e) { e.stopPropagation(); commentOn(cur().table, ui.comment.getBoundingClientRect()); });
    ui.note = h('span', 'ts-note');
    ui.count = h('span', 'ts-count'); ui.count.setAttribute('aria-live', 'polite');
    ui.bar.appendChild(ui.note); ui.bar.appendChild(ui.count); ui.bar.appendChild(ui.comment);
    // Full screen, at the toolbar's end. A doc that is only the sheet has
    // nothing else to hide, so it has no such button.
    ui.expand = iconButton(ICON.expand, 'Expand sheet to full screen', function () { setExpanded(true); });
    ui.expand.classList.add('ts-expand');
    ui.bar.appendChild(ui.expand);
    ui.xhead = h('div', 'ts-xhead'); ui.xhead.hidden = true;
    ui.xtitle = h('span', 'ts-xtitle');
    ui.back = h('a', 'ts-btn'); ui.back.innerHTML = ICON.back + '<span>Open the doc</span>'; ui.back.setAttribute('aria-label', 'Open the doc');
    ui.alone = h('a', 'ts-btn'); ui.alone.target = '_blank'; ui.alone.rel = 'noopener'; ui.alone.innerHTML = ICON.external + '<span>Open on its own</span>'; ui.alone.setAttribute('aria-label', 'Open this sheet on its own page');
    ui.close = iconButton(ICON.x, 'Close full screen (Esc)', function () { setExpanded(false); });
    // Kept current with the view (renderBar), and once more when pressed.
    [ui.back, ui.alone].forEach(function (a) { a.addEventListener('pointerdown', linkHrefs); a.addEventListener('focus', linkHrefs); });
    ui.xhead.appendChild(ui.back); ui.xhead.appendChild(ui.xtitle); ui.xhead.appendChild(ui.alone); ui.xhead.appendChild(ui.close);
    // grid
    ui.grid = h('div', 'ts-grid');
    ui.grid.tabIndex = 0;
    ui.grid.setAttribute('role', 'grid');
    ui.head = h('div', 'ts-head'); ui.head.setAttribute('role', 'row');
    ui.body = h('div', 'ts-body');
    ui.rows = h('div', 'ts-rows'); ui.rows.setAttribute('role', 'rowgroup');
    // [structure] the outline gutter (over the row numbers) and the frozen rows.
    ui.outline = h('div', 'ts-outline'); ui.body.appendChild(ui.outline);
    ui.frozen = h('div', 'ts-frozen'); ui.frozen.setAttribute('role', 'rowgroup');
    ui.body.appendChild(ui.rows);
    ui.foot = h('div', 'ts-foot'); ui.foot.setAttribute('role', 'row'); ui.foot.setAttribute('aria-label', 'Summary'); ui.foot.hidden = true;
    ui.grid.appendChild(ui.head); ui.grid.appendChild(ui.frozen); ui.grid.appendChild(ui.body); ui.grid.appendChild(ui.foot);
    ui.flat = h('div', 'ts-flat');
    ui.flat.addEventListener('click', flatClick);
    ui.addRow = h('button', 'ts-add-row'); ui.addRow.type = 'button'; ui.addRow.innerHTML = ICON.plus + '<span>Add row</span>';
    ui.addRow.addEventListener('click', function (e) { e.stopPropagation(); insertRows(null, 1); ui.grid.focus({ preventScroll: true }); });
    ui.offAbove = h('button', 'ts-off'); ui.offBelow = h('button', 'ts-off');
    [ui.offAbove, ui.offBelow].forEach(function (b, k) {
      b.type = 'button'; b.hidden = true;
      b.innerHTML = (k ? ICON.down : ICON.up) + '<span></span>';
      b.addEventListener('click', function (e) { e.stopPropagation(); goOffscreen(b); });
    });
    ui.offHidden = h('div', 'ts-note ts-off-hidden'); ui.offHidden.hidden = true;
    root.appendChild(ui.xhead); root.appendChild(ui.tabs); root.appendChild(ui.bar); root.appendChild(ui.offHidden); root.appendChild(ui.grid); root.appendChild(ui.flat); root.appendChild(ui.offAbove); root.appendChild(ui.offBelow); root.appendChild(ui.addRow);
    FX.mount(root, ui.tabs); // [format] Edit mode's format toolbar, above the tabs
    host.parentNode.insertBefore(root, host);
    expand.sheetOnly = isSheetOnly();
    expand.embed = !expand.sheetOnly && isProseDoc();
    // Fitted to the reader (flat view, page width) only in a house-style doc
    // and not where the author opted out, as server/table-layout.js does.
    expand.fit = expand.embed && document.documentElement.getAttribute('data-tdoc-design') !== 'custom' &&
      !document.querySelector('[data-tdoc-slide]') && !first.closest('[data-tdoc-table="fixed"]');
    // data-tdoc-wide on the sheet (or its wrapper): the author asks for the page width.
    expand.wide = !expand.sheetOnly && !document.querySelector('[data-tdoc-slide]') && !!(first.hasAttribute('data-tdoc-wide') || host.hasAttribute('data-tdoc-wide'));
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
    // On its own page the sheet is one tab: no strip.
    ui.tabs.hidden = (book.tabs.length < 2 && !editing) || !!expand.alone;
    book.tabs.forEach(function (tab, i) {
      var b = h('button', 'ts-tab', tab.name);
      b.type = 'button'; b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', i === book.active ? 'true' : 'false');
      b.addEventListener('click', function (e) { e.stopPropagation(); if (book.active !== i) { book.active = i; sel = { r: 0, c: 0, r2: 0, c2: 0 }; ui.grid.scrollTop = 0; ui.grid.scrollLeft = 0; renderAll(); saveView(); } });
      if (editing) {
        b.addEventListener('dblclick', function (e) { e.stopPropagation(); renameTab(i, b); });
        b.addEventListener('contextmenu', function (e) { e.preventDefault(); tabMenu(i, b); });
      }
      S.decorateTab(b, tab, i, editing); // [structure] in Edit: drag to reorder, a tap on the open tab for its menu
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
    ui.searchBox.classList.toggle('has-q', !!tab.query.search);
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
      clear.addEventListener('click', function (e) { e.stopPropagation(); setQuery({ search: tab.query.search, filters: {}, sort: [], totals: Object.assign({}, tab.query.totals) }); });
      ui.chips.appendChild(clear);
    }
    // [structure] collapsed groups are not a filter; hidden rows are not counted.
    var total = S.unhiddenCount(tab), shown = tab.sorder.length;
    ui.count.textContent = shown === total ? fmt(total) + (total === 1 ? ' row' : ' rows') : fmt(shown) + ' of ' + fmt(total) + ' rows';
    var m2 = mode();
    ui.comment.hidden = m2 !== 'comment';
    ui.addRow.hidden = !canEdit();
    ui.expand.hidden = expand.on || expand.sheetOnly || !canExpand();
    ui.xhead.hidden = !expand.on;
    ui.close.hidden = ui.alone.hidden = !!expand.alone;
    ui.back.hidden = !expand.alone;
    ui.xtitle.textContent = expand.alone ? docTitle() + ' · ' + tab.name : docTitle();
    if (expand.on) linkHrefs();
    ui.note.hidden = !(m2 === 'edit');
    ui.note.textContent = canEdit() ? 'Type or double-click to edit · Alt+Enter for a new line · paste a range from Excel or Sheets' : m2 === 'edit' ? 'Editing sheets in the browser is not available yet' : '';
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
  function compact() { return expand.embed && cur().index.size <= COMPACT_ROWS; }
  function flatView() { return compact() && expand.fit && !expand.on && mode() !== 'edit'; }
  // The grid is as tall as its rows, up to most of the frame's height (a small
  // sheet in a prose doc, up to EMBED_ROWS rows), so a short sheet reads like a table and
  // a long one scrolls inside its frame.
  function layout() {
    var tab = cur();
    var rowsH = Math.max(ROW_H, rowsHeight(tab));
    var room = Math.max(240, innerHeight - (NARROW && NARROW.matches ? 150 : 170));
    ui.root.classList.toggle('is-compact', compact());
    ui.root.classList.toggle('is-flat', flatView());
    pageWidth(tab);
    if (flatView()) return;
    if (compact()) room = Math.min(room, HEAD_H + EMBED_ROWS * ROW_H + footH() + 18);
    ui.body.style.height = (tab.order.length ? rowsHeight(tab) : 80) + 'px';
    ui.body.style.width = tab.totalW + 'px';
    ui.head.style.width = (tab.totalW + (canEdit() ? 40 : 0)) + 'px';
    // Room for a horizontal scrollbar only where it takes room (none with
    // overlay scrollbars): measured once the widths above are in.
    var bar = ui.grid.offsetHeight ? Math.max(0, ui.grid.offsetHeight - ui.grid.clientHeight - 2) : (tab.totalW > ui.grid.clientWidth ? 14 : 0);
    var hgt = Math.min(HEAD_H + rowsH + footH() + 2 + bar, room);
    // Full screen, the grid takes whatever the window leaves it.
    ui.grid.style.height = expand.on ? '' : hgt + 'px';
  }
  function renderHead() {
    var tab = cur(), W = numW();
    var html = '<div class="ts-corner" style="width:' + W + 'px">' + S.cornerHtml(tab) + '</div>'; // [structure]
    var a = Math.min(sel.c, sel.c2), b = Math.max(sel.c, sel.c2);
    tab.data.columns.forEach(function (col, c) {
      if (!S.colShown(tab, c)) return; // [structure] a hidden column
      var s = -1, dir = null;
      tab.query.sort.forEach(function (k, i) { if (k.col === c) { s = i; dir = k.dir; } });
      var filtered = tab.query.filters[c] != null;
      html += '<div class="ts-h' + S.frozenCls(tab, c) + (c >= a && c <= b ? ' is-sel' : '') + '" role="columnheader" data-c="' + c + '" style="width:' + tab.widths[c] + 'px' + S.frozenLeft(tab, c) + '"' +
        (dir ? ' aria-sort="' + (dir === 'asc' ? 'ascending' : 'descending') + '"' : '') + '>' +
        '<button type="button" class="ts-hname" data-act="sort" title="Sort by ' + esc(col.name) + ' (shift-click to add)"><span class="ts-glyph" aria-label="' + TYPE_LABEL[tab.index.cols[c].type] + '">' + TYPE_GLYPH[tab.index.cols[c].type] + '</span><b>' + esc(col.name) + '</b>' +
        (dir ? '<span class="ts-sorted">' + (dir === 'asc' ? ICON.up : ICON.down) + (tab.query.sort.length > 1 ? (s + 1) : '') + '</span>' : '') + '</button>' +
        '<button type="button" class="ts-icon' + (filtered ? ' is-on' : '') + '" data-act="filter" aria-label="Filter ' + esc(col.name) + '" title="Filter">' + ICON.filter + '</button>' +
        '<button type="button" class="ts-icon" data-act="menu" aria-label="' + esc(col.name) + ' column menu" title="More">' + ICON.down + '</button>' +
        '<span class="ts-resize" data-act="resize" aria-hidden="true"></span></div>';
    });
    if (canEdit()) html += '<div class="ts-h-add"><button type="button" class="ts-icon" data-act="addcol" aria-label="Add a column" title="Add a column">' + ICON.plus + '</button></div>';
    ui.head.innerHTML = html;
    S.afterHead(tab); // [structure] hidden-column markers
    renderFoot();
    FX.sync(); // [format] the toolbar follows the mode and the active cell
  }
  // ---- summary row -----------------------------------------------------------------
  function hasTotals(tab) { return Object.keys(tab.query.totals || {}).some(function (k) { return Number(k) < tab.data.columns.length; }); }
  function footH() { var tab = cur(); return tab && hasTotals(tab) ? ROW_H : 0; }
  function totalText(tab, c, fn) {
    var v = Q.columnTotal(tab.index, tab.sorder || tab.order, c, fn); // [structure] collapsed rows still count
    if (v == null) return '–';
    if (fn === 'avg') return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
    return fmt(v);
  }
  function renderFoot() {
    var tab = cur(), W = numW();
    var any = hasTotals(tab);
    ui.foot.hidden = !any;
    if (!any) { ui.foot.textContent = ''; return; }
    var html = '<div class="ts-fcorner" style="width:' + W + 'px" title="Summary of the rows shown">Σ</div>';
    tab.data.columns.forEach(function (col, c) {
      if (!S.colShown(tab, c)) return; // [structure]
      var fn = tab.query.totals[c];
      var label = fn ? Q.TOTAL_LABEL[fn] : 'Summary';
      html += '<button type="button" class="ts-fc' + S.frozenCls(tab, c) + (fn ? '' : ' is-none') + '" data-c="' + c + '" role="gridcell"' +
        ' aria-label="' + esc(col.name) + ' summary' + (fn ? ': ' + label + ' ' + esc(totalText(tab, c, fn)) : '') + '"' +
        ' style="width:' + tab.widths[c] + 'px' + S.frozenLeft(tab, c) + '">' +
        '<small>' + esc(label) + '</small>' + (fn ? '<b>' + esc(totalText(tab, c, fn)) + '</b>' : '') + '</button>';
    });
    ui.foot.innerHTML = html;
    ui.foot.style.width = (tab.totalW + (canEdit() ? 40 : 0)) + 'px';
  }
  function totalItems(c) {
    var tab = cur(), on = tab.query.totals[c] || null;
    var items = [{ label: 'None', checked: !on, onSelect: function () { setQuery(Q.setTotal(tab.query, c, null)); } }];
    Q.totalsFor(tab.index.cols[c].type).forEach(function (fn) {
      items.push({ label: Q.TOTAL_LABEL[fn], checked: on === fn, onSelect: function () { setQuery(Q.setTotal(tab.query, c, fn)); } });
    });
    return items;
  }
  var rendered = { first: -1, last: -1, c0: -1, c1: -1, key: '' };
  function visibleCols(tab) {
    var left = ui.grid.scrollLeft, right = left + ui.grid.clientWidth;
    var c0 = 0, c1 = tab.widths.length - 1;
    for (var c = 0; c < tab.widths.length; c++) { if (tab.colLeft[c] + tab.widths[c] >= left + numW() + S.frozenW(tab)) { c0 = c; break; } }
    for (var d = c0; d < tab.widths.length; d++) { if (tab.colLeft[d] > right) { c1 = d; break; } }
    return [Math.max(0, c0 - 1), Math.min(tab.widths.length - 1, c1 + 1)];
  }
  function renderBody(force) {
    if (flatView()) { renderFlat(); return; }
    var tab = cur();
    var n = tab.order.length;
    if (!n) {
      ui.rows.style.top = '0px';
      ui.rows.innerHTML = '<div class="ts-empty" style="width:' + ui.grid.clientWidth + 'px">' + (S.emptyText(tab) || (tab.index.size ? 'No rows match.' : 'This sheet has no rows yet.')) + '</div>';
      S.afterBody(tab, 0, -1, [0, -1]); // [structure]
      rendered.key = 'empty';
      return true;
    }
    var top = ui.grid.scrollTop, viewH = ui.grid.clientHeight - HEAD_H;
    var first = FX.firstRow(tab, Math.max(0, rowAtY(tab, top) - OVERSCAN)); // [format] a merge's top row
    var last = Math.min(n - 1, rowAtY(tab, top + viewH) + OVERSCAN);
    var cols = tab.widths.length > 30 ? visibleCols(tab) : [0, tab.widths.length - 1];
    var key = first + ':' + last + ':' + cols[0] + ':' + cols[1] + ':' + (tab.tops ? tab.tops[n] : 0);
    if (!force && key === rendered.key) return false;
    rendered.key = key;
    var html = rowsHtml(tab, first, last, cols);
    ui.rows.style.top = rowTop(tab, first) + 'px';
    ui.rows.innerHTML = html;
    S.afterBody(tab, first, last, cols); // [structure] outline gutter, markers, frozen rows
    if (tab.anyWrap && measureRows(tab, first, last)) return true;
    placePill();
    placeOffscreen();
    return true;
  }
  // View rows first..last as markup, with the columns cols[0]..cols[1] (and
  // the frozen ones before them, a spacer standing for those between).
  function rowsHtml(tab, first, last, cols) {
    var W = numW(), needle = tab.query.search.trim().toLowerCase();
    var ra = Math.min(sel.r, sel.r2), rb = Math.max(sel.r, sel.r2), ca = Math.min(sel.c, sel.c2), cb = Math.max(sel.c, sel.c2);
    var hit = tab.matchAt >= 0 ? tab.matches.hits[tab.matchAt] : null;
    var html = '';
    // [structure] the frozen columns, then the scrolled range; hidden ones skipped.
    var fc = S.frozenCount(tab), from = Math.max(cols[0], fc), list = [];
    for (var f = 0; f < fc; f++) if (S.colShown(tab, f)) list.push(f);
    var gap = from > fc ? tab.colLeft[from] - tab.colLeft[fc] : 0, gapAt = list.length;
    for (var c = from; c <= cols[1]; c++) if (S.colShown(tab, c)) list.push(c);
    for (var i = first; i <= last; i++) {
      var r = tab.order[i];
      var rowSel = i >= ra && i <= rb;
      html += '<div class="ts-row" role="row" data-i="' + i + '" style="width:' + tab.totalW + 'px' + (tab.tops ? ';height:' + rowH(tab, i) + 'px' : '') + '"><div class="ts-n' + (rowSel ? ' is-sel' : '') + '" role="rowheader" style="width:' + W + 'px">' + (r + 1) + '<span class="ts-rresize" data-act="rresize" aria-hidden="true"></span></div>';
      for (var k = 0; k < list.length; k++) {
        var cc = list[k];
        if (k === gapAt && gap > 0) html += '<div style="flex:none;width:' + gap + 'px"></div>';
        html += cellHtml(tab, r, cc, i, rowSel && cc >= ca && cc <= cb, i === sel.r && cc === sel.c, needle, hit && hit.row === r && hit.col === cc);
      }
      html += '</div>';
    }
    return html;
  }
  // Wrapped rows drawn: their real heights replace the estimates. true when
  // one changed (the body is drawn again with the new tops).
  function measureRows(tab, first, last) {
    var changed = false, rows = ui.rows.children;
    for (var k = 0; k < rows.length; k++) {
      var el = rows[k], i = Number(el.getAttribute('data-i')), r = tab.order[i];
      if (r == null || (tab.heights && tab.heights.get(r))) continue;
      var ln = (tab.lines && tab.lines.get(r)) || 1;
      var need = ln > 1 ? Math.min(M.MAX_HEIGHT, ln * LINE_H + PAD_Y) : ROW_H;
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (!c.classList || !c.classList.contains('is-wrap') || c.classList.contains('fx-span')) continue;
        var kids = c.children, inner = 0;
        for (var j = 0; j < kids.length; j++) inner = Math.max(inner, kids[j].offsetTop + kids[j].offsetHeight);
        need = Math.max(need, Math.ceil(inner + 7 + 1));
      }
      var tr = tab.data.rows[r].tr;
      if (Math.abs(need - rowH(tab, i)) > 1) { tab.measured.set(tr, need); changed = true; }
      else if (!tab.measured.has(tr)) tab.measured.set(tr, rowH(tab, i));
    }
    if (!changed) return false;
    var keep = ui.grid.scrollTop;
    buildTops(tab);
    layout();
    ui.grid.scrollTop = keep;
    renderBody(true);
    return true;
  }
  function tagStyle(tag, palette) {
    var colors = Q.TAG_COLORS[Q.tagColor(tag, palette)];
    return 'background:' + colors[0] + ';color:' + colors[1];
  }
  function cellHtml(tab, r, c, i, isSel, isActive, needle, isHitOn) {
    var col = tab.index.cols[c], type = col.type, inner = '', cls = 'ts-c';
    cls += S.frozenCls(tab, c); // [structure] frozen columns
    if (type === 'number' && !tab.align[c]) cls += ' is-num';
    else if (type === 'number') cls += ' is-num-t';
    if (tab.align[c]) cls += ' al-' + tab.align[c];
    if (tab.wrap[c] && type !== 'checkbox') cls += ' is-wrap';
    else if (type !== 'tags' && type !== 'checkbox' && col.text[r].indexOf('\n') !== -1) cls += ' is-ml';
    if (type === 'checkbox') cls += ' is-check';
    if (isSel) cls += ' is-sel';
    if (isActive) cls += ' is-active';
    var hitHere = needle && col.lower[r].indexOf(needle) !== -1;
    if (hitHere) cls += ' is-hit';
    if (isHitOn) cls += ' is-hit-on';
    var td = tab.data.rows[r].tds[c];
    if (td && commented.has(td)) cls += ' has-comment';
    // [format] the cell's own format, a merge's span, or a slot it covers
    var fx = FX.cell(tab, r, c, i, type, tab.align[c], col.text[r], tab.widths[c]);
    if (fx && fx.skip) return '';
    if (fx && fx.cov) return fx.cov;
    if (fx) cls += fx.cls;
    if (type === 'tags') {
      var tags = col.tags[r], pal = tab.palettes[c];
      for (var t = 0; t < tags.length; t++) inner += '<span class="ts-tag" style="' + tagStyle(tags[t], pal) + '">' + mark(tags[t], needle) + '</span>';
    } else if (type === 'checkbox') {
      var on = col.num[r] === 1;
      inner = '<span class="ts-check' + (on ? ' is-on' : '') + '" role="img" aria-label="' + (on ? 'Checked' : 'Not checked') + '">' + (on ? '✓' : '') + '</span>';
    } else {
      var text = col.text[r];
      var href = type === 'url' ? M.safeHref(text) : '';
      if (fx && fx.text != null) text = fx.text; // [format] the value in its number format
      inner = href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + mark(text, needle) + '</a>' : '<span class="ts-t">' + mark(text, needle) + '</span>';
    }
    var w = fx ? fx.w : tab.widths[c];
    return '<div class="' + cls + '" role="gridcell" data-c="' + c + '" style="width:' + w + 'px' + S.frozenLeft(tab, c) + (fx ? fx.style : '') + '"' + (isActive ? ' aria-selected="true"' : '') + ' title="' + esc(col.text[r].slice(0, 300)) + '">' + inner + '</div>';
  }
  // ---- flat view: a small sheet in a prose doc, read as a table --------------------
  function renderFlat() {
    var tab = cur(), n = tab.order.length, cols = tab.data.columns, needle = tab.query.search.trim().toLowerCase();
    // [structure] hidden columns are left out; a collapsed group is one summary row.
    var vis = [];
    for (c = 0; c < cols.length; c++) if (S.colShown(tab, c)) vis.push(c);
    var cards = ui.root.clientWidth <= 480 && vis.length > 3;
    var html = '', i, r, c, v;
    var cell = function (r, c) {
      var col = tab.index.cols[c], type = col.type, td = tab.data.rows[r].tds[c], inner = '';
      var fx = FX.flat(tab, r, c, type, col.text[r], cards); // [format]
      if (fx.skip) return fx;
      if (type === 'tags') { for (var t = 0; t < col.tags[r].length; t++) inner += '<span class="ts-tag" style="' + tagStyle(col.tags[r][t], tab.palettes[c]) + '">' + mark(col.tags[r][t], needle) + '</span>'; }
      else if (type === 'checkbox') inner = col.num[r] === 1 ? '✓' : '';
      else { var href = type === 'url' ? M.safeHref(col.text[r]) : ''; inner = href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + mark(col.text[r], needle) + '</a>' : mark(fx.text != null ? fx.text : col.text[r], needle); }
      var cls = (type === 'number' ? ' is-num' : type === 'date' || type === 'checkbox' ? ' is-short' : '') + (needle && col.lower[r].indexOf(needle) !== -1 ? ' is-hit' : '') + (td && commented.has(td) ? ' has-comment' : '') +
        // The grid's line breaks and column alignment read the same here.
        (type !== 'tags' && type !== 'checkbox' && col.text[r].indexOf('\n') !== -1 ? ' is-ml' : '') + (tab.align && tab.align[c] ? ' al-' + tab.align[c] : '') + fx.cls;
      return { cls: cls, inner: inner, span: fx.span };
    };
    if (!n && !S.flatSummary(tab, 0, cards, vis.length)) html = '<p class="ts-flat-empty">' + (tab.index.size ? 'No rows match.' : 'This sheet has no rows yet.') + '</p>';
    else if (cards) {
      for (i = 0; i <= n; i++) {
        html += S.flatSummary(tab, i, true, vis.length);
        if (i === n) break;
        r = tab.order[i];
        var t0 = cell(r, vis[0]);
        html += '<div class="ts-card" role="listitem"><p class="ts-card-t' + t0.cls + '" data-i="' + i + '" data-c="' + vis[0] + '">' + S.flatToggle(tab, i) + (t0.inner || '&nbsp;') + '</p>';
        for (v = 1; v < vis.length; v++) {
          c = vis[v];
          var x = cell(r, c);
          if (x.skip || !x.inner) continue;
          html += '<p class="ts-card-l' + x.cls + '" data-i="' + i + '" data-c="' + c + '"><span class="ts-card-k">' + esc(cols[c].name) + ':</span> ' + x.inner + '</p>';
        }
        html += '</div>';
      }
      html = '<div role="list" aria-label="' + esc(tab.name) + '">' + html + '</div>';
    } else {
      html = '<table><thead><tr>';
      for (v = 0; v < vis.length; v++) {
        c = vis[v];
        var s = tab.query.sort.filter(function (k) { return k.col === c; })[0];
        html += '<th data-c="' + c + '"' + (s ? ' aria-sort="' + (s.dir === 'desc' ? 'descending' : 'ascending') + '"' : '') + '><button type="button" data-sort="' + c + '" title="Sort by ' + esc(cols[c].name) + '">' + esc(cols[c].name) + (s ? ' <span class="ts-sorted">' + (s.dir === 'desc' ? ICON.down : ICON.up) + '</span>' : '') + '</button></th>';
      }
      html += '</tr></thead><tbody>';
      for (i = 0; i <= n; i++) {
        html += S.flatSummary(tab, i, false, vis.length);
        if (i === n) break;
        r = tab.order[i];
        html += '<tr>';
        for (v = 0; v < vis.length; v++) { c = vis[v]; var y = cell(r, c); if (y.skip) continue; html += '<td class="' + y.cls.trim() + '"' + y.span + ' data-i="' + i + '" data-c="' + c + '">' + (v ? '' : S.flatToggle(tab, i)) + y.inner + '</td>'; }
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    // Unchanged: leave the DOM alone (no mutation, no relayout downstream),
    // but the height still follows the width (rows rewrap on a resize).
    if (!(html === ui.flatHtml && cards === ui.flat.classList.contains('is-cards') && ui.flat.firstChild)) {
      ui.flatHtml = html;
      ui.flat.classList.toggle('is-cards', cards);
      ui.flat.innerHTML = html;
    }
    // At most EMBED_ROWS rows (or cards) tall, however tall each one wraps.
    var items = ui.flat.querySelectorAll(cards ? '.ts-card' : 'tbody tr'), last = items[EMBED_ROWS - 1];
    var maxH = items.length > EMBED_ROWS && last ? (last.offsetTop + last.offsetHeight + (cards ? 0 : 1)) + 'px' : '';
    if (ui.flat.style.maxHeight !== maxH) ui.flat.style.maxHeight = maxH;
  }
  // A header sorts; in Comment mode a cell takes a comment; a commented cell
  // opens its thread.
  function flatClick(e) {
    if (S.flatClick(e)) return; // [structure] a group's summary row or toggle
    var b = e.target.closest('[data-sort]');
    if (b) { e.stopPropagation(); setQuery(Q.toggleSort(cur().query, Number(b.getAttribute('data-sort')), e.shiftKey)); return; }
    var el = e.target.closest('[data-i]');
    if (!el || e.target.closest('a')) return;
    var tab = cur(), i = Number(el.getAttribute('data-i')), c = Number(el.getAttribute('data-c')), r = tab.order[i];
    var td = r != null && tab.data.rows[r].tds[c];
    if (!td) return;
    if (commented.has(td) && mode() !== 'edit') { e.stopPropagation(); post({ type: 'tdoc:anchorClick', id: commented.get(td)[0] }); return; }
    if (mode() !== 'comment') return;
    e.stopPropagation();
    sel = { r: i, c: c, r2: i, c2: c, touched: true };
    if (!tab.data.rows[r].id) toast('This row has no id yet, so a comment would not survive edits. Comment on the sheet instead.');
    commentOn(td, el.getBoundingClientRect(), refLabel(tab, r, c) + ' · ' + tab.data.columns[c].name);
  }
  // The page width beside the reading column, for an embedded sheet that
  // needs it: the flat view's columns at up to 240px each, or the grid.
  function pageWidth(tab) {
    var root = ui.root, parent = root.parentElement;
    var on = (expand.fit || expand.wide) && !expand.on && innerWidth > 640 && parent;
    if (on) {
      var need = expand.wide ? Infinity : flatView() ? tab.widths.reduce(function (a, w) { return a + Math.min(w, 240); }, 2) : tab.totalW + 2;
      var cs = getComputedStyle(parent), pr = parent.getBoundingClientRect();
      var colLeft = pr.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
      var col = parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      var page = Math.min(1200, innerWidth - 48);
      on = need > col + 1 && page > col + 1;
      if (on) {
        var w = Math.min(need, page), gap = (innerWidth - page) / 2;
        var left = Math.max(gap, Math.min(colLeft + col / 2 - w / 2, innerWidth - gap - w));
        root.style.setProperty('--ts-wide-w', Math.round(w) + 'px');
        root.style.setProperty('--ts-wide-ml', Math.round(left - colLeft) + 'px');
      }
    }
    root.classList.toggle('is-wide', !!on);
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
    var view = { active: book.tabs.length > 1 ? cur().name : '', tabs: Object.create(null) };
    book.tabs.forEach(function (t) { view.tabs[t.name] = t.query; });
    return view;
  }
  function saveView() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      // A reader's own layout per tab (widths, heights, wrap, alignment by
      // column key and row id), kept by the shell beside the view: at most
      // 2,000 row heights a tab, as many as a load reads back (the shell
      // keeps up to 100,000 characters of it).
      // No prototype: a tab may be called "__proto__".
      var widths = Object.create(null);
      if (useLocal()) book.tabs.forEach(function (t) {
        if (!t.resized) return;
        var h = {}, n = 0;
        Object.keys(t.local.h).forEach(function (id) { if (n < 2000 && t.local.h[id]) { h[id] = t.local.h[id]; n++; } });
        widths[t.name] = { w: t.local.w, h: h, wrap: t.local.wrap, align: t.local.align };
      });
      // [structure] anyone's expanded / collapsed groups and a reader's freeze.
      // Over the shell's budget, group state goes first, never the widths.
      book.tabs.forEach(function (t) { var o = S.viewState(t); if (o) (widths[t.name] = widths[t.name] || {}).o = o; });
      S.fitViewState(widths, 90000);
      post({ type: 'tdoc:sheetView', hash: Q.encodeView(viewObject()), widths: widths });
    }, 250);
  }
  function applyView(hash, widths) {
    var view = Q.decodeView(hash || '');
    // Own keys only: a tab may be called "__proto__".
    var own = function (o, k) { return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; };
    book.tabs.forEach(function (t) {
      var q = own(view.tabs, t.name);
      if (q) {
        // A saved view never names a column that is not there.
        Object.keys(q.filters).forEach(function (k) { if (Number(k) >= t.data.columns.length) delete q.filters[k]; });
        q.sort = q.sort.filter(function (s) { return s.col < t.data.columns.length; });
        Object.keys(q.totals || {}).forEach(function (k) { if (Number(k) >= t.data.columns.length) delete q.totals[k]; });
        t.query = q;
      }
      var w = own(widths, t.name);
      var loc = emptyLocal();
      var size = function (v, lo, hi) { return M.cleanSize(v, lo, hi) || undefined; };
      // Before layouts had keys: a plain array of widths by position.
      if (Array.isArray(w) && w.length === t.data.columns.length) w.forEach(function (x, i) { loc.w[colKey(t, i)] = size(x, M.MIN_WIDTH, M.MAX_WIDTH); });
      else if (w && typeof w === 'object') {
        var each = function (o, fn) { if (o && typeof o === 'object' && !Array.isArray(o)) Object.keys(o).slice(0, 2000).forEach(function (k) { fn(k, o[k]); }); };
        each(w.w, function (k, v) { loc.w[k] = size(v, M.MIN_WIDTH, M.MAX_WIDTH); });
        each(w.h, function (k, v) { var x = size(v, M.MIN_HEIGHT, M.MAX_HEIGHT); if (x) loc.h[k] = x; });
        each(w.wrap, function (k, v) { if (typeof v === 'boolean') loc.wrap[k] = v; });
        each(w.align, function (k, v) { if (M.cleanAlign(v)) loc.align[k] = M.cleanAlign(v); });
      }
      if (w && !(w.o && Object.keys(w).length === 1)) { t.local = loc; t.resized = true; readLayout(t); }
      if (w && w.o) S.applyViewState(t, w.o); // [structure]
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
    // [structure] a match in a collapsed group opens it first.
    S.expandTo(tab, hit.row, hit.col);
    var at = tab.pos[hit.row];
    if (at < 0) return;
    sel.r = sel.r2 = at; sel.c = sel.c2 = hit.col;
    renderBar(); layout(); renderHead(); renderBody(true);
    ensureVisible(at, hit.col);
  }

  // ---- selection & scrolling -------------------------------------------------------
  function ensureVisible(i, c) {
    var tab = cur(), g = ui.grid;
    var top = rowTop(tab, i), hgt = rowH(tab, i), viewH = g.clientHeight - HEAD_H - footH();
    // [structure] frozen rows cover the top of the view, frozen columns its left.
    var frozen = i < S.frozenRows(tab), fh = S.frozenH(tab);
    if (frozen) { /* always in view: no scroll */ }
    else if (top < g.scrollTop + fh) g.scrollTop = top - fh;
    else if (top + hgt > g.scrollTop + viewH) g.scrollTop = Math.min(top - fh, top + hgt - viewH);
    if (c >= S.frozenCount(tab)) {
      var left = tab.colLeft[c] - numW() - S.frozenW(tab), right = tab.colLeft[c] + tab.widths[c];
      if (left < g.scrollLeft) g.scrollLeft = left;
      else if (right > g.scrollLeft + g.clientWidth) g.scrollLeft = right - g.clientWidth;
    }
    if (!renderBody()) paintSelection();
  }
  // The selection drawn on the rows already there. Redrawing the rows under
  // a press would take the pressed cell out of the page, and the browser
  // then sends no click and no double-click.
  function paintSelection() {
    var tab = cur();
    if (!tab.order.length) return;
    var ra = Math.min(sel.r, sel.r2), rb = Math.max(sel.r, sel.r2), ca = Math.min(sel.c, sel.c2), cb = Math.max(sel.c, sel.c2);
    var rows = Array.prototype.slice.call(ui.rows.children).concat(Array.prototype.slice.call(ui.frozen.children)); // [structure]
    for (var k = 0; k < rows.length; k++) {
      var row = rows[k], i = Number(row.getAttribute('data-i'));
      if (!row.classList.contains('ts-row')) continue;
      var rowSel = i >= ra && i <= rb;
      for (var el = row.firstElementChild; el; el = el.nextElementSibling) {
        if (el.classList.contains('ts-n')) { el.classList.toggle('is-sel', rowSel); continue; }
        if (!el.classList.contains('ts-c')) continue;
        var c = Number(el.getAttribute('data-c')), active = i === sel.r && c === sel.c;
        el.classList.toggle('is-sel', rowSel && c >= ca && c <= cb);
        el.classList.toggle('is-active', active);
        if (active) el.setAttribute('aria-selected', 'true'); else el.removeAttribute('aria-selected');
      }
    }
    placePill();
  }
  function select(i, c, extend) {
    var tab = cur(), n = tab.order.length, cols = tab.widths.length;
    if (!n || !cols) return;
    i = Math.max(0, Math.min(n - 1, i)); c = Math.max(0, Math.min(cols - 1, c));
    c = S.shownCol(tab, c, extend ? sel.c2 : sel.c); // [structure] never onto a hidden column
    if (!extend) { var at = FX.snap(tab, i, c); i = at.i; c = at.c; } // [format] a covered slot is its merge's
    if (extend) { sel.r2 = i; sel.c2 = c; } else { sel.r = sel.r2 = i; sel.c = sel.c2 = c; }
    sel.touched = true;
    renderHead();
    if (extend) ensureVisible(i, c); else ensureVisible(sel.r, sel.c);
  }
  function cellAt(i, c) {
    var q = '.ts-row[data-i="' + i + '"] .ts-c[data-c="' + c + '"]';
    return (i < S.frozenRows(cur()) && ui.frozen.querySelector(q)) || ui.rows.querySelector(q); // [structure] frozen rows on top
  }
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
    if (r != null && tab.data.merges && tab.data.merges.length) c = tab.data.rows[r].tds.indexOf(cell); // [format] past merged cells
    return r == null || c < 0 ? { t: t } : { t: t, r: r, c: c };
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
    // A row the search or a filter hides (or a hidden column): the note under the toolbar.
    if (i < 0 || !S.colShown(cur(), at.c)) return !ui.offHidden.hidden ? ui.offHidden : ui.count;
    var where = rowPlace(i);
    // Scrolled out of the grid: the "N comments above / below" marker at
    // that edge, so the pin points the way to scroll.
    if (where < 0) return !ui.offAbove.hidden ? ui.offAbove : ui.grid;
    if (where > 0) return !ui.offBelow.hidden ? ui.offBelow : ui.grid;
    return cellAt(i, at.c) || ui.grid;
  };
  // -1 above the grid's visible rows, 1 below, 0 in view.
  function rowPlace(i) {
    var tab = cur(), top = rowTop(tab, i), view = ui.grid.clientHeight - HEAD_H - footH();
    if (i < S.frozenRows(tab)) return 0; // [structure] a frozen row is always in view
    if (top + rowH(tab, i) <= ui.grid.scrollTop + S.frozenH(tab) + 2) return -1;
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
    if (!tr) return null;
    // [format] past merged cells: the column's cell as the viewer reads it
    var at = book && book.tabs.find(function (x) { return x.table === table; });
    var ri = at ? at.rowOf.get(tr) : null;
    if (ri != null && at.data.merges && at.data.merges.length) return at.data.rows[ri].tds[c] || null;
    return tr.cells[c] || null;
  };
  // Full screen, the sheet spans the frame: its right edge is the column the
  // page's pins sit beside.
  hooks.articleRight = function () {
    if (!book || !expand.on || !ui.grid) return 0;
    return Math.round(ui.grid.getBoundingClientRect().right);
  };
  // Bring a source element into view: its tab, its row, its cell selected.
  hooks.reveal = function (el) {
    var at = locate(el);
    if (!at) return false;
    if (at.t !== book.active) { book.active = at.t; renderAll(); }
    if (at.r == null) { ui.root.scrollIntoView({ block: 'nearest' }); return true; }
    S.expandTo(cur(), at.r, at.c); // [structure] its collapsed group opens (the reader's view)
    if (at.c != null && !S.colShown(cur(), at.c)) { toast('That cell is in a hidden column.'); return false; }
    var i = cur().pos[at.r];
    if (i < 0) { toast(S.hiddenRow(cur(), at.r) ? 'That cell is in a hidden row.' : 'That cell is hidden by the search or a filter on this sheet.'); return false; }
    ui.root.scrollIntoView({ block: 'nearest' });
    select(i, at.c || 0, false);
    return true;
  };
  var commented = new Map();
  document.addEventListener('tdoc:anchors-resolved', function (e) {
    var d = e.detail || {};
    var before = commented;
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
    // Only a change in which cells carry comments needs a new render.
    var same = before.size === commented.size;
    if (same) commented.forEach(function (ids, el) { var was = before.get(el); if (!was || was.join() !== ids.join()) same = false; });
    if (book && !same) { renderBody(true); placeOffscreen(); }
  });
  // Comments on rows that are off-screen or filtered out, counted at the
  // grid's edges; a press goes to the nearest one and opens it.
  function placeOffscreen() {
    if (!book || !ui.offAbove) return;
    if (flatView()) { ui.offAbove.hidden = ui.offBelow.hidden = ui.offHidden.hidden = true; return; }
    var tab = cur(), above = [], below = [], hidden = 0;
    commented.forEach(function (ids, el) {
      var at = locate(el);
      if (!at || at.t !== book.active || at.r == null) return;
      var i = tab.pos[at.r];
      if (i < 0 || (at.c != null && !S.colShown(tab, at.c))) { hidden += ids.length; return; } // [structure] hidden columns too
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
    ui.offHidden.textContent = hidden ? hidden + (hidden === 1 ? ' comment is' : ' comments are') + ' on rows this view hides (a search, a filter, a collapsed group or hidden rows)' : '';
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
      { header: 'Summary row' },
    ].concat(totalItems(c));
    // Wrap and alignment: anyone (a reader's own view; an editor's document).
    var wrapped = !!tab.wrap[c], al = tab.align[c] || (type === 'number' ? 'right' : type === 'checkbox' ? 'center' : 'left');
    if (type !== 'checkbox') {
      items.push({ header: 'Text' });
      items.push({ label: 'Wrap text', checked: wrapped, onSelect: function () { if (!wrapped) setLayout(tab, { cols: colChange(c, { wrap: true }) }); } });
      items.push({ label: 'Clip', checked: !wrapped, onSelect: function () { if (wrapped) setLayout(tab, { cols: colChange(c, { wrap: false }) }); } });
    }
    items.push({ header: 'Align' });
    [['left', 'Left'], ['center', 'Center'], ['right', 'Right']].forEach(function (o) {
      items.push({ label: o[1], checked: al === o[0], onSelect: function () { if (al !== o[0]) setLayout(tab, { cols: colChange(c, { align: o[0] }) }); } });
    });
    items.push({ label: 'Fit width to content', onSelect: function () { setLayout(tab, { cols: colChange(c, { width: fitWidth(tab, c) }) }); } });
    if (mode() === 'comment') items.push({ label: 'Comment on this column', onSelect: function () { commentOn(col.th, anchor.getBoundingClientRect(), 'Column ' + Q.columnLetter(c) + ' · ' + col.name); } });
    if (canEdit()) {
      items.push('sep');
      items.push({ label: 'Rename…', onSelect: function () { renameColumn(c); } });
      items.push({ header: 'Type' });
      Q.TYPES.forEach(function (t) { items.push({ label: TYPE_LABEL[t], checked: t === type, onSelect: function () { if (t !== type) setColumnType(c, t); } }); });
      items.push('sep');
      // [structure] as many columns as are selected (one when this column is not).
      var ca = Math.min(sel.c, sel.c2), cb = Math.max(sel.c, sel.c2), nc = c >= ca && c <= cb ? cb - ca + 1 : 1;
      items.push({ label: nc > 1 ? 'Insert ' + nc + ' columns left' : 'Insert column left', onSelect: function () { insertColumn(nc > 1 ? ca : c, nc); } });
      items.push({ label: nc > 1 ? 'Insert ' + nc + ' columns right' : 'Insert column right', onSelect: function () { insertColumn((nc > 1 ? cb : c) + 1, nc); } });
      items.push({ label: 'Delete column', danger: true, disabled: tab.data.columns.length < 2, onSelect: function () { deleteColumn(c); } });
    }
    items = items.concat(S.columnItems(tab, c)); // [structure] hide, freeze
    openMenu(anchor, items, col.name + ' column');
  }
  function rowMenu(i, anchor) {
    if (!canEdit()) return;
    var ra = Math.min(sel.r, sel.r2), rb = Math.max(sel.r, sel.r2);
    if (i < ra || i > rb) { ra = rb = i; select(i, sel.c, false); }
    var n = rb - ra + 1;
    openMenu(anchor, [
      // [structure] as many rows as are selected
      { label: n > 1 ? 'Insert ' + n + ' rows above' : 'Insert row above', onSelect: function () { insertRows(cur().order[ra], n, true); } },
      { label: n > 1 ? 'Insert ' + n + ' rows below' : 'Insert row below', onSelect: function () { insertRows(cur().order[rb], n, false); } },
      { label: n > 1 ? 'Delete ' + n + ' rows' : 'Delete row', danger: true, onSelect: function () { deleteRows(ra, rb); } },
    ].concat(S.rowItems(cur(), ra, rb)), 'Row menu'); // [structure] hide, group, freeze
  }
  // [structure] move left / right, and a delete the toast can undo:
  // server/sheets-structure.js
  function tabMenu(i, anchor) {
    openMenu(anchor, [
      { label: 'Rename…', onSelect: function () { renameTab(i, anchor); } },
    ].concat(S.tabItems(i, anchor), [
      'sep',
      { label: 'Delete tab', danger: true, disabled: book.tabs.length < 2, onSelect: function () { S.deleteTabWithUndo(i); } },
    ]), 'Tab menu');
  }

  // ---- layout changes -------------------------------------------------------------------
  // change = { cols: { c: { width?, wrap?, align? } }, rows: { r: height } }
  // (a height of 0 is "fit": back to the row's own height).
  function colChange(c, v) { var o = {}; o[c] = v; return o; }
  // A reader's: their view only. An editor's: the document's, in Edit mode
  // (asked for when they are in another; the change lands once it is on, so
  // the editor's baseline is the page before it and Save is offered).
  var pendingLayout = null;
  function setLayout(tab, change) {
    if (!config.canEditDoc) {
      var loc = tab.local;
      Object.keys(change.cols || {}).forEach(function (c) {
        var k = colKey(tab, Number(c)), v = change.cols[c];
        if (v.width !== undefined) loc.w[k] = M.cleanSize(v.width, M.MIN_WIDTH, M.MAX_WIDTH) || undefined;
        if (v.wrap !== undefined) loc.wrap[k] = !!v.wrap;
        if (v.align !== undefined) loc.align[k] = M.cleanAlign(v.align) || undefined;
      });
      Object.keys(change.rows || {}).forEach(function (r) {
        var id = tab.data.rows[r] && tab.data.rows[r].id;
        if (!id) return;
        var hgt = M.cleanSize(change.rows[r], M.MIN_HEIGHT, M.MAX_HEIGHT);
        if (hgt) loc.h[id] = hgt; else delete loc.h[id];
      });
      tab.resized = true;
      relayoutTab(tab);
      saveView();
      return;
    }
    if (mode() !== 'edit') {
      pendingLayout = { tab: tab, change: change };
      post({ type: 'tdoc:requestMode', mode: 'edit' });
      return;
    }
    applyLayout(tab, change);
  }
  function relayoutTab(tab) {
    readLayout(tab);
    if (tab === cur()) { tab.measured = new Map(); runTab(tab); layout(); renderHead(); renderBody(true); relayout(); }
  }
  var LAYOUT_ATTRS = ['data-width', 'data-wrap', 'data-align', 'data-height'];
  function attrsOf(el) { var o = {}; LAYOUT_ATTRS.forEach(function (a) { o[a] = el.getAttribute(a); }); return o; }
  function putAttrs(el, o) { LAYOUT_ATTRS.forEach(function (a) { if (o[a] == null) el.removeAttribute(a); else el.setAttribute(a, o[a]); }); }
  function applyLayout(tab, change) {
    var list = [];
    Object.keys(change.cols || {}).forEach(function (c) {
      var col = tab.data.columns[c];
      if (!col) return;
      var before = attrsOf(col.th);
      M.writeColumnLayout(col.th, change.cols[c]);
      list.push({ el: col.th, before: before, after: attrsOf(col.th) });
    });
    Object.keys(change.rows || {}).forEach(function (r) {
      var row = tab.data.rows[r];
      if (!row) return;
      var before = attrsOf(row.tr);
      M.writeRowHeight(row.tr, change.rows[r]);
      list.push({ el: row.tr, before: before, after: attrsOf(row.tr) });
    });
    if (!list.some(function (x) { return JSON.stringify(x.before) !== JSON.stringify(x.after); })) { relayoutTab(tab); return; }
    record({ tab: tab, undo: function () { list.forEach(function (x) { putAttrs(x.el, x.before); }); }, redo: function () { list.forEach(function (x) { putAttrs(x.el, x.after); }); } });
    // Widths, wrap and heights change what every wrapped row measures.
    tab.measured = new Map();
    afterChange(tab, tab.order[sel.r]);
  }
  // The width that shows a column's longest value (and its header) whole,
  // measured with the grid's own font over up to 5,000 rows.
  var measureCtx = null;
  function textW(text, bold) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = (bold ? '600 ' : '') + '13px system-ui,-apple-system,"Segoe UI",sans-serif';
    return measureCtx.measureText(text).width;
  }
  function fitWidth(tab, c) {
    var col = tab.index.cols[c], type = col.type;
    var w = textW(tab.data.columns[c].name, true) + 96;
    var n = Math.min(tab.index.size, 5000);
    for (var r = 0; r < n; r++) {
      if (type === 'tags') {
        var t = col.tags[r], x = 16;
        for (var k = 0; k < t.length; k++) x += Math.min(160, textW(t[k]) + 16) + 4;
        if (x > w) w = x;
      } else if (type === 'checkbox') { w = Math.max(w, 72); }
      else {
        var text = col.text[r];
        if (!text || text.length * 14 < w) continue;
        var lines = text.split('\n');
        for (var j = 0; j < lines.length; j++) w = Math.max(w, textW(lines[j]) + 20);
      }
    }
    return Math.round(Math.max(M.MIN_WIDTH, Math.min(800, w)));
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
  // Undo / Redo on the editor's bar: the sheet's when its edit was the last
  // one in the page (frame-probe.js asks before the browser's own).
  var lastEditSheet = false;
  document.addEventListener('tdoc:edit-history', function (e) {
    if (!book || !canEdit() || !lastEditSheet) return;
    var redo = e.detail && e.detail.command === 'redo';
    if (!(redo ? redoStack : undoStack).length) return;
    e.preventDefault();
    undo(redo);
  });
  document.addEventListener('input', function (e) { if (!(ui.root && ui.root.contains(e.target))) lastEditSheet = false; }, true);
  function record(op) {
    lastEditSheet = true;
    undoStack.push(op);
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
  }
  function undo(redo) {
    var from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack;
    var op = from.pop();
    if (!op) return;
    // Any change may come back (a width, a wrap, a cell's text): measure again.
    if (op.tab) op.tab.measured = new Map();
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
    } else renderTabs(); // [structure] a tab's undo (order, colour, a copy) shows in the strip
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
    list = list.filter(function (ch) { return !FX.covered(tab, ch.r, ch.c); }); // [format] a merge's covered slots hold nothing
    if (!list.length) return;
    list.forEach(function (ch) {
      var row = tab.data.rows[ch.r];
      tab.measured.delete(row.tr);
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
    tab.measured = new Map();
    FX.wrap(tab, fn); // [format] on the table laid out flat, merged again after
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
    // A text box that holds line breaks: Alt/Option+Enter or Ctrl+Enter puts
    // one in, Enter commits (as in Excel and Google Sheets).
    var multi = type === 'text';
    var input = provider(h(multi ? 'textarea' : 'input', 'ts-editor'));
    if (multi) input.rows = 1; else input.type = 'text';
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
    var minH = cr.height + 2;
    var grow = function () { if (!multi) return; input.style.height = minH + 'px'; input.style.height = Math.min(320, Math.max(minH, input.scrollHeight + 4)) + 'px'; };
    grow();
    input.addEventListener('input', grow);
    editor = { input: input, tab: tab, r: r, c: c, i: i };
    input.focus({ preventScroll: true });
    if (initial == null) input.select(); else input.setSelectionRange(input.value.length, input.value.length);
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && multi && (e.altKey || e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        var a = input.selectionStart, b = input.selectionEnd;
        input.setRangeText('\n', a, b, 'end');
        grow();
      }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commitEdit(); move(e.shiftKey ? -1 : 1, 0); }
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
  var MAX_INSERT = 1000;
  function insertRows(r, count, before) {
    if (!canEdit()) return;
    if (count > MAX_INSERT) { toast('At most ' + fmt(MAX_INSERT) + ' rows at a time: adding ' + fmt(MAX_INSERT) + '.'); count = MAX_INSERT; }
    var tab = cur(), next = rowIds(tab), added, list = [];
    snapshotOp(tab, function () {
      var ref = r == null ? null : tab.data.rows[r].tr;
      for (var k = 0; k < count; k++) {
        var tr = newRow(tab, next());
        if (!ref) bodyOf(tab.table).appendChild(tr);
        else if (before) ref.parentNode.insertBefore(tr, ref);
        else ref.parentNode.insertBefore(tr, ref.nextSibling);
        if (!added) added = tr;
        list.push(tr);
        if (ref && !before) ref = tr;
      }
      S.inheritGroup(list); // [structure] rows added inside a group join it
    });
    readTab(tab.table, tab); runTab(tab);
    var newR = tab.rowOf.get(added);
    afterChange(tab, newR);
    var p = tab.pos[newR];
    if (p >= 0) select(p, r == null ? 0 : sel.c, false);
    else toast('Row added. This view hides it (a search, a filter or a collapsed group).');
  }
  function deleteRows(ra, rb) {
    var tab = cur(), trs = [];
    for (var i = ra; i <= rb; i++) trs.push(tab.data.rows[tab.order[i]].tr);
    snapshotOp(tab, function () {
      S.keepCollapsed(trs); // [structure] a deleted first row hands its group's collapsed default on
      trs.forEach(function (tr) { tr.remove(); });
    });
    trs.forEach(function (tr) { tab.measured.delete(tr); });
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
  function insertColumn(at, count) {
    var tab = cur(), n = Math.max(1, Math.min(MAX_COLUMNS - tab.data.columns.length, count || 1));
    if (n < 1 || tab.data.columns.length >= MAX_COLUMNS) { toast('A sheet has at most ' + MAX_COLUMNS + ' columns.'); return; }
    snapshotOp(tab, function () {
      var hr = headRow(tab);
      ensureKeys(hr);
      for (var k = 0; k < n; k++) {
        var th = newHeader(hr, 'Column ' + (tab.data.columns.length + k + 1));
        hr.insertBefore(th, hr.cells[at + k] || null);
      }
      tab.data.rows.forEach(function (row) {
        var tr = row.tr;
        while (tr.cells.length < at) tr.appendChild(document.createElement('td'));
        for (var j = 0; j < n; j++) tr.insertBefore(document.createElement('td'), tr.cells[at] || null);
      });
    });
    for (var w = 0; w < n; w++) tab.widths.splice(at, 0, 140);
    tab.query = Q.shiftQueryColumns(tab.query, at, n);
    afterChange(tab);
    select(sel.r, at, false);
    if (n === 1) renameColumn(at);
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
    record({ tab: tab, undo: function () { parent.insertBefore(node, nextSib); book.tabs.splice(i, 0, tab); book.active = i; }, redo: function () { node.remove(); book.tabs.splice(book.tabs.indexOf(tab), 1); book.active = Math.max(0, Math.min(book.active, book.tabs.length - 1)); } });
    sel = { r: 0, c: 0, r2: 0, c2: 0 };
    renderAll(); changed(); relayout(); saveView();
  }
  // A range copied from Excel or Google Sheets arrives as tab-separated text.
  // It fills from the active cell, adding rows and columns it needs.
  function pasteText(text) {
    if (!canEdit()) return;
    // Excel and Google Sheets copy tab-separated, a cell with line breaks
    // in quotes ("one\ntwo"): one quoted value is one cell, breaks kept.
    var body = String(text).replace(/\r?\n$/, '');
    var oneQuoted = /^"(?:[^"]|"")*"$/.test(body);
    var grid = M.parseDelimited(body, body.indexOf('\t') !== -1 || oneQuoted ? '\t' : M.detectDelimiter(body));
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
    var out = !extend && FX.past(tab, sel.r, sel.c, dr, dc); // [format] leave a merge from its far edge
    if (out) { r = out.i; c = out.c; }
    if (!extend && dc && (c < 0 || c >= tab.widths.length) && !dr) {
      // Tab past the last column wraps to the next row, like a spreadsheet.
      if (c >= tab.widths.length) { c = 0; r += 1; } else { c = tab.widths.length - 1; r -= 1; }
    }
    select(r, c, extend);
  }
  function onKey(e) {
    if (!book || editor || (pop && pop.el.contains(e.target))) return;
    var sk = S.onKey(e); // [structure] Alt+Shift+→/← group / ungroup rows
    if (sk === 'skip') return;
    if (sk) { e.preventDefault(); e.stopPropagation(); return; }
    var tab = cur(), k = e.key, mod = e.metaKey || e.ctrlKey;
    var page = Math.max(1, rowAtY(tab, ui.grid.scrollTop + ui.grid.clientHeight - HEAD_H) - rowAtY(tab, ui.grid.scrollTop) - 1);
    var last = tab.order.length - 1, lastC = tab.widths.length - 1;
    var handled = true;
    // ⌘/Ctrl+arrow: to the edge of the data, as in a spreadsheet.
    if (k === 'ArrowDown') { if (mod) jump(1, 0, e.shiftKey); else move(1, 0, e.shiftKey); }
    else if (k === 'ArrowUp') { if (mod) jump(-1, 0, e.shiftKey); else move(-1, 0, e.shiftKey); }
    else if (k === 'ArrowRight') { if (mod) jump(0, 1, e.shiftKey); else move(0, 1, e.shiftKey); }
    else if (k === 'ArrowLeft') { if (mod) jump(0, -1, e.shiftKey); else move(0, -1, e.shiftKey); }
    // Shift+Space the row, Ctrl+Space the column.
    else if (k === ' ' && e.shiftKey && !mod) { selectRows(sel.r, sel.r2); }
    else if (k === ' ' && e.ctrlKey && !e.shiftKey) { selectColumns(sel.c, sel.c2); }
    else if (mod && !e.shiftKey && !e.altKey && (k.toLowerCase() === 'd' || k.toLowerCase() === 'r') && canEdit()) fill(k.toLowerCase() === 'd' ? 'down' : 'right');
    else if (k === 'Tab') { move(0, e.shiftKey ? -1 : 1); }
    else if (k === 'Home') { if (mod) select(0, 0, e.shiftKey); else select(e.shiftKey ? sel.r2 : sel.r, 0, e.shiftKey); }
    else if (k === 'End') { if (mod) select(last, lastC, e.shiftKey); else select(e.shiftKey ? sel.r2 : sel.r, lastC, e.shiftKey); }
    else if (k === 'PageDown') move(page, 0, e.shiftKey);
    else if (k === 'PageUp') move(-page, 0, e.shiftKey);
    else if (k === 'Enter' || k === 'F2') { if (canEdit() && !e.shiftKey) startEdit(); else move(e.shiftKey ? -1 : 1, 0); }
    // Full screen, Esc on the grid leaves full screen (the view stays as it is).
    else if (k === 'Escape' && expand.on && !expand.alone) handled = false;
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
  // ⌘/Ctrl+arrow: from a filled cell to the last filled one before a blank
  // (or past blanks to the next filled one), else to the sheet's edge.
  function jump(dr, dc, extend) {
    var tab = cur(), i = extend ? sel.r2 : sel.r, c = extend ? sel.c2 : sel.c;
    var n = tab.order.length, cols = tab.widths.length;
    var filled = function (ii, cc) { return ii >= 0 && ii < n && cc >= 0 && cc < cols && tab.index.cols[cc].text[tab.order[ii]] !== ''; };
    var ni = i + dr, nc = c + dc;
    if (filled(i, c) && filled(ni, nc)) { while (filled(ni + dr, nc + dc)) { ni += dr; nc += dc; } }
    else { while (ni >= 0 && ni < n && nc >= 0 && nc < cols && !filled(ni, nc)) { ni += dr; nc += dc; } }
    ni = Math.max(0, Math.min(n - 1, ni)); nc = Math.max(0, Math.min(cols - 1, nc));
    select(ni, nc, extend);
  }
  function selectRows(a, b) {
    var tab = cur();
    sel.r = Math.min(a, b); sel.r2 = Math.max(a, b); sel.c = 0; sel.c2 = tab.widths.length - 1; sel.touched = true;
    renderHead(); renderBody(true);
  }
  function selectColumns(a, b) {
    var tab = cur();
    sel.c = Math.min(a, b); sel.c2 = Math.max(a, b); sel.r = 0; sel.r2 = Math.max(0, tab.order.length - 1); sel.touched = true;
    renderHead(); renderBody(true);
  }
  // ⌘/Ctrl+D fills the selection's first row down it, ⌘/Ctrl+R its first
  // column right; with one cell selected, from the cell above / to the left.
  function fill(dir) {
    var tab = cur(), ra = Math.min(sel.r, sel.r2), rb = Math.max(sel.r, sel.r2), ca = Math.min(sel.c, sel.c2), cb = Math.max(sel.c, sel.c2);
    var single = ra === rb && ca === cb;
    if (dir === 'down' && single) { if (ra === 0) return; ra -= 1; }
    if (dir === 'right' && single) { if (ca === 0) return; ca -= 1; }
    var list = [];
    for (var i = ra; i <= rb; i++) for (var c = ca; c <= cb; c++) {
      if (dir === 'down' && i === ra) continue;
      if (dir === 'right' && c === ca) continue;
      var from = dir === 'down' ? { i: ra, c: c } : { i: i, c: ca };
      var r = tab.order[i], fr = tab.order[from.i], type = tab.index.cols[c].type, ftype = tab.index.cols[from.c].type;
      var value = ftype === 'tags' ? tab.index.cols[from.c].tags[fr].slice() : tab.index.cols[from.c].text[fr];
      if (type === 'tags' && !Array.isArray(value)) value = Q.splitTags(value);
      if (type !== 'tags' && Array.isArray(value)) value = value.join(', ');
      list.push({ r: r, c: c, value: value });
    }
    if (list.length) setCells(tab, list, tab.order[sel.r]);
  }
  function cellFromEvent(e) {
    var cell = e.target.closest && e.target.closest('.ts-c,.ts-n');
    // A click or double-click whose press redrew the rows lands on the rows'
    // container: the cell is the one under the pointer.
    if ((!cell || !cell.isConnected) && e.clientX != null) {
      var under = document.elementFromPoint(e.clientX, e.clientY);
      cell = under && under.closest && under.closest('.ts-c,.ts-n');
    }
    if (!cell || !(ui.rows.contains(cell) || ui.frozen.contains(cell))) return null; // [structure]
    var row = cell.parentElement;
    var i = Number(row.getAttribute('data-i'));
    var c = cell.classList.contains('ts-n') ? -1 : Number(cell.getAttribute('data-c'));
    return { i: i, c: c, el: cell };
  }
  var drag = null, cellPress = null, rowPress = -1;
  // [structure] the frozen rows (drawn over the body's top) take the same
  // presses, double-clicks and menus as the rows under them.
  function rowsOn(type, fn, capture) { ui.rows.addEventListener(type, fn, capture); ui.frozen.addEventListener(type, fn, capture); }
  function wire() {
    S.wire(); // [structure] group toggles, unhide markers, the corner's view menu
    ui.grid.addEventListener('keydown', onKey);
    ['input', 'beforeinput', 'keyup'].forEach(function (t) { ui.root.addEventListener(t, function (e) { e.stopPropagation(); }); });
    ui.root.addEventListener('keydown', escapeClose);
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
    ui.foot.addEventListener('click', function (e) {
      var b = e.target.closest('.ts-fc');
      if (!b) return;
      e.stopPropagation();
      var c = Number(b.getAttribute('data-c'));
      openMenu(b, totalItems(c), cur().data.columns[c].name + ' summary');
    });
    ui.head.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      var h = b.closest('.ts-h'), c = h ? Number(h.getAttribute('data-c')) : -1, act = b.getAttribute('data-act');
      if (act === 'sort') {
        if (mode() === 'comment' && e.altKey) { commentOn(cur().data.columns[c].th, b.getBoundingClientRect(), 'Column ' + cur().data.columns[c].name); return; }
        // In Edit mode a header selects its column (shift: through it), as
        // in a spreadsheet; sorting is in the column's menu. Elsewhere a
        // header sorts.
        if (canEdit()) { selectColumns(e.shiftKey ? sel.c : c, c); ui.grid.focus({ preventScroll: true }); return; }
        setQuery(Q.toggleSort(cur().query, c, e.shiftKey));
      } else if (act === 'filter') openFilter(c, b);
      else if (act === 'menu') columnMenu(c, b);
      else if (act === 'addcol') insertColumn(cur().widths.length);
    });
    // Column resize: drag the right edge of a header (the frozen first
    // column's too); a double-click there fits the column to its content.
    // The drag is followed on the document, not the grip: the header is
    // drawn again as the width changes, and the grip with it.
    ui.head.addEventListener('pointerdown', function (e) {
      var grip = e.target.closest('.ts-resize');
      if (!grip || e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      var c = Number(grip.parentElement.getAttribute('data-c')), tab = cur(), x0 = e.clientX, w0 = tab.widths[c];
      startSizing(ui.head, e, function (ev) {
        var w = Math.max(M.MIN_WIDTH, Math.min(M.MAX_WIDTH, Math.round(w0 + ev.clientX - x0)));
        if (w === tab.widths[c]) return;
        tab.widths[c] = w; reflow(tab); layout(); widthLive(tab, c);
      }, function () {
        if (tab.widths[c] !== w0) setLayout(tab, { cols: colChange(c, { width: tab.widths[c] }) });
      });
      var g1 = ui.head.querySelector('.ts-h[data-c="' + c + '"] .ts-resize'); if (g1) g1.classList.add('is-on');
    });
    ui.head.addEventListener('dblclick', function (e) {
      var h = e.target.closest('.ts-h');
      if (!h) return;
      var c = Number(h.getAttribute('data-c'));
      if (e.target.closest('.ts-resize')) { e.preventDefault(); e.stopPropagation(); setLayout(cur(), { cols: colChange(c, { width: fitWidth(cur(), c) }) }); return; }
      if (!canEdit()) return;
      renameColumn(c);
    });
    // Row resize: drag the bottom edge of a row number (every selected row
    // when the row is one of them); a double-click there fits the row again.
    rowsOn('pointerdown', function (e) {
      var grip = e.target.closest('.ts-rresize');
      if (!grip || e.button > 0) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      var tab = cur(), i = Number(grip.closest('.ts-row').getAttribute('data-i')), y0 = e.clientY, h0 = rowH(tab, i);
      var ra = Math.min(sel.r, sel.r2), rb = Math.max(sel.r, sel.r2);
      var whole = sel.c === 0 && Math.max(sel.c, sel.c2) === tab.widths.length - 1 || Math.min(sel.c, sel.c2) === 0 && Math.max(sel.c, sel.c2) === tab.widths.length - 1;
      var list = [];
      if (whole && i >= ra && i <= rb && rb > ra) for (var k = ra; k <= rb; k++) list.push(tab.order[k]); else list.push(tab.order[i]);
      var hgt = h0;
      startSizing(ui.rows, e, function (ev) {
        hgt = Math.max(M.MIN_HEIGHT, Math.min(M.MAX_HEIGHT, Math.round(h0 + ev.clientY - y0)));
        if (!tab.heights) tab.heights = new Map();
        list.forEach(function (r) { tab.heights.set(r, hgt); });
        buildTops(tab); layout(); heightLive(tab, list);
      }, function () {
        if (hgt === h0) return;
        var rows = {}; list.forEach(function (r) { rows[r] = hgt; });
        setLayout(tab, { rows: rows });
      });
    }, true);
    rowsOn('dblclick', function (e) {
      var grip = e.target.closest('.ts-rresize');
      if (!grip) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      var tab = cur(), r = tab.order[Number(grip.closest('.ts-row').getAttribute('data-i'))];
      var rows = {}; rows[r] = 0;
      setLayout(tab, { rows: rows });
    }, true);
    rowsOn('pointerdown', function (e) {
      if (e.button !== 0) return;
      var at = cellFromEvent(e);
      if (!at) return;
      if (e.target.closest('a[href]') && !canEdit()) return;
      if (e.target.closest('.tdoc-comment-pill')) return;
      if (editor) commitEdit();
      if (at.c < 0) {
        // The row number selects the whole row; pressed again (a selected
        // row), in Edit mode it opens the row's menu.
        var rowWas = sel.c === 0 && sel.c2 === cur().widths.length - 1 && at.i >= Math.min(sel.r, sel.r2) && at.i <= Math.max(sel.r, sel.r2);
        if (e.shiftKey) { sel.r2 = at.i; } else if (!rowWas) { sel.r = sel.r2 = at.i; }
        sel.c = 0; sel.c2 = cur().widths.length - 1; sel.touched = true;
        rowPress = rowWas && !e.shiftKey ? at.i : -1;
        renderHead(); paintSelection();
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
      cellPress = e.shiftKey ? null : { i: at.i, c: at.c };
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
    rowsOn('mousedown', function (e) {
      if (!e.target.closest('a[href],input,button')) e.preventDefault();
    });
    rowsOn('pointermove', function (e) {
      if (!drag || !(e.buttons & 1)) { drag = null; return; }
      var at = cellFromEvent(e);
      if (at && at.c >= 0 && (at.i !== sel.r2 || at.c !== sel.c2)) select(at.i, at.c, true);
    });
    document.addEventListener('pointerup', function () { drag = null; });
    // Comment mode: a click (a tap) on a cell comments on it, or opens its
    // thread. On the click, the last event of a press, and after the page's
    // own click handling (which closes what was open), so the composer this
    // opens is not closed by the same press.
    rowsOn('click', function (e) {
      var press = cellPress; cellPress = null;
      if (!press || mode() !== 'comment' || e.button > 0) return;
      var at = cellFromEvent(e);
      if (!at || at.i !== press.i || at.c !== press.c || sel.r !== sel.r2 || sel.c !== sel.c2) return;
      if (e.target.closest('a[href],.tdoc-comment-pill')) return;
      setTimeout(function () {
        if (mode() !== 'comment' || sel.r !== at.i || sel.c !== at.c) return;
        var td = srcCell(cur(), at.i, at.c);
        if (td && commented.has(td)) { post({ type: 'tdoc:anchorClick', id: commented.get(td)[0] }); return; }
        commentOnCell();
      }, 0);
    });
    rowsOn('dblclick', function (e) {
      var at = cellFromEvent(e);
      if (!at || at.c < 0) return;
      if (canEdit()) { e.preventDefault(); select(at.i, at.c, false); startEdit(); }
    });
    rowsOn('contextmenu', function (e) {
      var at = cellFromEvent(e);
      if (!at || !canEdit()) return;
      e.preventDefault();
      rowMenu(at.i, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
    });
    rowsOn('click', function (e) {
      var at = cellFromEvent(e);
      var again = rowPress; rowPress = -1;
      if (at && at.c < 0 && canEdit() && again === at.i) rowMenu(at.i, at.el);
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
  // While a drag lasts, the cells already drawn take the new size in place:
  // drawing them again would take the grip being dragged out of the page,
  // and a finger's drag (its pointer captured by the grip) with it.
  function widthLive(tab, c) {
    var w = tab.widths[c] + 'px', total = tab.totalW + 'px';
    var hc = ui.head.querySelector('.ts-h[data-c="' + c + '"]'); if (hc) hc.style.width = w;
    var fc = ui.foot.querySelector('.ts-fc[data-c="' + c + '"]'); if (fc) fc.style.width = w;
    ui.foot.style.width = (tab.totalW + (canEdit() ? 40 : 0)) + 'px';
    var rows = ui.rows.children;
    for (var k = 0; k < rows.length; k++) {
      if (!rows[k].classList.contains('ts-row')) continue;
      rows[k].style.width = total;
      var cell = rows[k].querySelector('.ts-c[data-c="' + c + '"]'); if (cell) cell.style.width = w;
    }
  }
  function heightLive(tab, list) {
    var rows = Array.prototype.slice.call(ui.rows.children).concat(Array.prototype.slice.call(ui.frozen.children)); // [structure]
    for (var k = 0; k < rows.length; k++) {
      var i = Number(rows[k].getAttribute('data-i'));
      if (list.indexOf(tab.order[i]) !== -1) rows[k].style.height = rowH(tab, i) + 'px';
    }
  }
  // One drag (a column's width, a row's height), followed on the document
  // so it keeps going wherever the pointer goes and whatever is redrawn.
  function startSizing(surface, e, onMove, onDone) {
    var frame = 0, last = null;
    surface.classList.add('is-sizing'); ui.root.classList.add('is-sizing');
    var move = function (ev) {
      if (ev.pointerId !== e.pointerId) return;
      ev.preventDefault();
      last = ev;
      if (!frame) frame = requestAnimationFrame(function () { frame = 0; if (last) onMove(last); });
    };
    var up = function (ev) {
      if (ev.pointerId !== e.pointerId) return;
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      if (last) onMove(last);
      surface.classList.remove('is-sizing'); ui.root.classList.remove('is-sizing');
      Array.prototype.forEach.call(ui.root.querySelectorAll('.is-on'), function (x) { if (x.classList.contains('ts-resize') || x.classList.contains('ts-rresize')) x.classList.remove('is-on'); });
      onDone();
    };
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
  }

  // ---- full screen ----------------------------------------------------------------------
  // The grid itself goes full screen (never a copy), so search, filters,
  // sort, selection, scroll and cell comments are the same before and after.
  // Full screen is the doc frame's whole area: the page's top bar (title,
  // history, Ask AI, Comment, Share, ⋯ with Read / Comment / Edit) and, in
  // Edit mode, the editor's bar with Save stay above it, as on every doc.
  function canExpand() { return true; }
  function docTitle() {
    var h1 = document.querySelector('h1:not([data-tdoc-provider] h1)');
    return cleanName((h1 && h1.textContent) || document.title || 'Sheet');
  }
  // A doc whose only content is its sheet (a title and a note at most).
  // The sheet-only rule is shared/doc-type.mjs's, the one My docs labels a
  // doc "Sheet" by: a title and a note at most, around sheet tables.
  function isSheetOnly() {
    var skip = DocType.SHEET_ONLY_SKIP_SELECTOR;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 1) return n.matches(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    if (walker.nextNode()) return false;
    return !Array.prototype.some.call(document.body.querySelectorAll(DocType.SHEET_ONLY_MEDIA_SELECTOR), function (el) { return !el.closest(skip); });
  }
  // A prose doc (as server/block-lint.js reads it): three or more text blocks
  // outside the sheets, the title and the sheet note, or other doc content
  // beside them (a plain table, a figure, an image). Its small sheets are compact.
  function isProseDoc() {
    var skip = SEL + ',[data-tdoc-provider],.sheet-note,caption';
    var keep = function (el) { return !el.closest(skip); };
    var blocks = Array.prototype.filter.call(document.body.querySelectorAll('p,li,blockquote,dd,h2,h3,h4,h5,h6'), function (el) { return keep(el) && el.textContent.trim(); });
    if (blocks.length >= 3) return true;
    return Array.prototype.some.call(document.body.querySelectorAll('table:not(' + SEL + '),figure,details,img,video,iframe'), keep);
  }
  // The sheet's own page: this doc, this version, `?sheet=<tab>`, carrying
  // the view of the moment it is pressed.
  function linkHrefs() {
    if (!book || !expand.path) return;
    var view = Q.encodeView(viewObject());
    var hash = view ? '#sheet=' + encodeURIComponent(view) : '';
    ui.alone.href = expand.path + '?sheet=' + (book.active + 1) + hash;
    ui.back.href = expand.path + hash;
  }
  function setExpanded(on, quiet) {
    if (!book || on === expand.on || (on && !canExpand())) return;
    if (editor) commitEdit();
    closePop(true);
    expand.on = on;
    var root = ui.root;
    if (on) {
      expand.scroll = { x: scrollX, y: scrollY };
      root.classList.add('is-expanded');
      root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
      // The rest of the page is out of reach (pointer, focus, screen readers)
      // under it: hidden by a provider style, never by an attribute on the
      // author's content, which a Save or an export would keep.
      expand.style = provider(document.createElement('style'));
      expand.style.textContent = 'html,body{overflow:hidden!important}'
        + 'body :not([data-tdoc-provider]):not([data-tdoc-provider] *){visibility:hidden!important}'
        + '.tdoc-sheet.is-expanded{visibility:visible!important}';
      document.head.appendChild(expand.style);
    } else {
      root.classList.remove('is-expanded');
      root.setAttribute('role', 'region'); root.removeAttribute('aria-modal');
      if (expand.style) expand.style.remove();
      expand.style = null;
    }
    if (!quiet && !expand.alone) post({ type: 'tdoc:sheetExpand', open: on });
    renderTabs(); renderBar(); layout(); renderHead(); renderBody(true);
    // The frame changes size with the shell's next layout: fit again then.
    requestAnimationFrame(function () {
      if (!book) return;
      layout(); renderBody(true); placeOffscreen(); placePill();
      if (on) { if (sel.touched) ensureVisible(sel.r, sel.c); ui.grid.focus({ preventScroll: true }); }
      else {
        if (expand.scroll) window.scrollTo(expand.scroll.x, expand.scroll.y);
        var r = root.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) root.scrollIntoView({ block: 'start' });
        ui.expand.focus({ preventScroll: true });
      }
    });
    relayout();
  }
  function escapeClose(e) {
    if (e.key !== 'Escape' || !expand.on || expand.alone || e.defaultPrevented || pop || editor) return;
    e.preventDefault();
    setExpanded(false);
  }
  document.addEventListener('keydown', escapeClose);

  // ---- shell bridge ---------------------------------------------------------------------
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !e.data || e.data.source !== 'tdoc-shell' || !book) return;
    var d = e.data;
    if (d.type === 'tdoc:mode') {
      if (editor) commitEdit();
      closePop(true);
      // A layout change that asked for Edit mode lands now (the editor took
      // its baseline from the page before it), or is let go.
      // After this message's other listeners: the editor (frame-probe.js)
      // turns Edit mode on, and takes its baseline, in its own.
      var pending = pendingLayout; pendingLayout = null;
      S.onMode(d.mode); // [structure] a structure change that asked for Edit mode
      // Leaving Edit mode saves or discards the draft: its undo history goes with it.
      if (d.mode !== 'edit') { undoStack = []; redoStack = []; }
      if (pending) setTimeout(function () {
        if (d.mode === 'edit' && mode() === 'edit' && book && book.tabs.indexOf(pending.tab) >= 0) applyLayout(pending.tab, pending.change);
        else relayoutTab(pending.tab);
      }, 0);
      renderTabs(); renderBar(); layout(); renderHead(); renderBody(true);
    } else if (d.type === 'tdoc:sheetConfig') {
      config.editing = d.editing === true;
      var could = config.canEditDoc;
      config.canEditDoc = d.canEdit === true;
      if (could !== config.canEditDoc) book.tabs.forEach(readLayout);
      if (typeof d.path === 'string' && /^\/(?!\/)/.test(d.path)) expand.path = d.path;
      if (!config.received) {
        config.received = true;
        var alone = Math.floor(Number(d.alone) || 0);
        if (alone > 0) expand.alone = Math.min(alone, book.tabs.length);
        applyView(d.hash, d.widths);
        if (expand.alone) { book.active = expand.alone - 1; renderAll(); setExpanded(true, true); }
        else if (d.expanded === true) setExpanded(true, true);
      } else renderAll();
    } else if (d.type === 'tdoc:editRestore') {
      // A draft was restored into the page: read the tables again.
      setTimeout(reload, 0);
    }
  });
  function reload() {
    if (!book) return;
    var tables = Array.prototype.slice.call(document.querySelectorAll(SEL));
    var old = book.tabs;
    book.tabs = S.stripOrder(tables.map(function (t) { var o = old.find(function (x) { return x.name === (t.getAttribute('data-name') || ''); }); return readTab(t, o); })); // [structure]
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
    // [format] apply formats as the toolbar does (tests)
    format: FX.api,
    expanded: function () { return { on: expand.on, alone: expand.alone, sheetOnly: expand.sheetOnly, embed: expand.embed, fit: expand.fit, flat: !!book && flatView() }; },
    // [structure] the active tab's outline, hidden and frozen state, as shown.
    structure: function () { return book ? S.describe(cur()) : null; },
  };
  // Mounted: the tables are hidden by the viewer's own style now, so the
  // frame's 200-row hold (#tdoc-sheets-pending) is no longer needed.
  if (mount()) { window.__tdocSheets.mounted = true; relayout(); }
  var held = document.getElementById('tdoc-sheets-pending');
  if (held) held.remove();
})();
