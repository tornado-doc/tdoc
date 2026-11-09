// Sheets loader: the only part of the sheets viewer every frame carries.
// When the document holds a `<table data-tdoc-sheet>`, fetch the viewer
// (server/sheets-viewer.js at /sheets-viewer.js). The frame of a sheet doc
// arrives with a provider style (#tdoc-sheets-pending) that lays out only a
// sheet's first 200 rows until the viewer replaces the tables; it comes off
// here in compare mode (no viewer there) and when the viewer fails to load
// or to mount, so no row is ever lost to it.
// The frame's CSP is nonce + 'strict-dynamic': a script this nonced script
// inserts may run.
(function () {
  'use strict';
  var clear = function () { var held = document.getElementById('tdoc-sheets-pending'); if (held) held.remove(); };
  // Opened on its own (not in the reader's frame): no viewer, so no hold.
  if (window === window.parent) { clear(); return; }
  if (new URLSearchParams(location.search).get('tdoc_compare') === '1' || !document.querySelector('table[data-tdoc-sheet]')) { clear(); return; }
  var s = document.createElement('script');
  s.src = '/sheets-viewer.js?v=__TDOC_SHEETS_VERSION__';
  s.setAttribute('data-tdoc-provider', '');
  s.onerror = clear;
  s.onload = function () { if (!window.__tdocSheets || !window.__tdocSheets.mounted) clear(); };
  (document.head || document.documentElement).appendChild(s);
})();
