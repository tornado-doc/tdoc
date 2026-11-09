// Sheets loader: the only part of the sheets viewer every frame carries. When
// the document holds a `<table data-tdoc-sheet>`, fetch the viewer
// (server/sheets-viewer.js, served at /sheets-viewer.js). The frame's CSP is
// nonce + 'strict-dynamic', so a script this nonced script inserts may run.
(function () {
  'use strict';
  if (window === window.parent) return;
  if (new URLSearchParams(location.search).get('tdoc_compare') === '1') return;
  if (!document.querySelector('table[data-tdoc-sheet]')) return;
  var s = document.createElement('script');
  s.src = '/sheets-viewer.js?v=__TDOC_SHEETS_VERSION__';
  s.setAttribute('data-tdoc-provider', '');
  (document.head || document.documentElement).appendChild(s);
})();
