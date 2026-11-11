// Sheet embeds loader: the only part of the embed viewer every frame
// carries. When the page holds a `<figure data-tdoc-embed="sheet">`, fetch
// the viewer (server/sheet-embed-viewer.js at /sheet-embed.js). Not in the
// version compare (the reference is what changed, not the sheet's rows) and
// not in a frame opened on its own (no shell to ask): there the figure is
// its link. The frame's CSP is nonce + 'strict-dynamic': a script this
// nonced script inserts may run.
(function () {
  'use strict';
  if (window === window.parent) return;
  if (new URLSearchParams(location.search).get('tdoc_compare') === '1') return;
  if (!document.querySelector('[data-tdoc-embed="sheet"]')) return;
  var s = document.createElement('script');
  s.src = '/sheet-embed.js?v=__TDOC_SHEET_EMBED_VERSION__';
  s.setAttribute('data-tdoc-provider', '');
  (document.head || document.documentElement).appendChild(s);
})();
