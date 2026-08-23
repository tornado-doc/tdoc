// tdoc shared chrome module (Contract 1 of the artifact-shell migration).
// Single source of truth for the overlay CHROME (bar, footer, composer, cards,
// pins, drawer) as pure strings + pure functions — NO document/fetch/window
// access at load. Inlined as a nonced <script> that parses BEFORE overlay.js
// and before the shell script, so both consumers read `window.TDOC_CHROME`.
//
// Markup returned here must stay byte-identical to overlay.js's own output so
// the single-origin overlay and the cross-origin shell render 1:1. Handlers are
// NOT here — each consumer wires its own against this markup. See
// IMPLEMENTATION.md Step 1 for the extraction plan; helpers are moved over here
// one commit at a time, with overlay.js switched to consume them as we go.
(function () {
  'use strict';

  // Verbatim from overlay.js escapeHtml (was overlay.js:909-911).
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // Verbatim from overlay.js footer construction (was overlay.js:1648-1654).
  function buildFooter() {
    return '<div class="tdoc-footer-row">' +
      '<a href="https://github.com/tornado-doc/tdoc" target="_blank" rel="noopener">github.com/tornado-doc/tdoc</a>' +
      '<span class="sep">·</span>' +
      '<span>built with <a href="https://github.com/tornado-doc/tdoc" target="_blank" rel="noopener">tdoc</a></span>' +
      '<span class="sep">·</span>' +
    '</div>';
  }

  var api = { escapeHtml: escapeHtml, buildFooter: buildFooter };
  if (typeof window !== 'undefined') window.TDOC_CHROME = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
