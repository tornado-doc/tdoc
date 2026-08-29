// tdoc shared shell builder — a pure function that renders the cross-origin
// shell document, with all environment-specific inputs
// (file contents, identity, config) injected by the caller. The local server
// (server/server.js) requires this; the worker inlines it as code (Cloudflare
// Workers ban eval/new Function, so it exposes itself on globalThis instead of
// being eval'd from a string). Keep it dependency-free (no fs/path/window).
(function () {
  'use strict';
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); }

  function shellHtml(d) {
    return '<!doctype html><html lang="en"><head>\n' +
'<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n' +
/* One declaration for every shell page. The icon file carries its own fills
   rather than currentColor: a tab strip is browser chrome, so there is no
   surrounding text to inherit from and no tdoc theme toggle reaching it. See
   assets/favicon.svg for how it handles a dark strip. */
'<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n' +
/* Add to Home Screen never reads the SVG favicon: iOS takes apple-touch-icon,
   Android takes the manifest's PNGs. Both sit on the reader's wallpaper, so
   unlike the mark itself they carry a field — the same reason tdoc_logo.png
   keeps one for Open Graph. */
'<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n' +
'<link rel="manifest" href="/site.webmanifest">\n' +
'<title>' + esc(d.title) + '</title>\n' +
'<link rel="stylesheet" href="' + esc(d.runtimeCssPath) + '">\n' +
'</head><body>\n' +
'  <div id="tdoc-shell-root"></div>\n' +
'  <script' + d.nonceAttr + '>window.__TDOC_SHELL__ = ' + d.cfgJson + ';</scr' + 'ipt>\n' +
'  <script' + d.nonceAttr + '>window.__TDOC_SHELL_BOOT__ = ' + d.bootJson + ';</scr' + 'ipt>\n' +
'  <script type="module" src="' + esc(d.runtimeJsPath) + '"' + d.nonceAttr + '></scr' + 'ipt>\n' +
'</body></html>';
  }

  function appHtml(d) {
    return '<!doctype html><html lang="en"><head>\n' +
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n' +
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n' +
      '<link rel="manifest" href="/site.webmanifest">\n' +
      '<title>' + esc(d.title) + '</title>\n' +
      '<link rel="stylesheet" href="' + esc(d.runtimeCssPath) + '">\n' +
      '</head><body><div id="tdoc-app-root"></div>\n' +
      '<script' + d.nonceAttr + '>window.__TDOC_APP_BOOT__ = ' + d.bootJson + ';</scr' + 'ipt>\n' +
      '<script type="module" src="' + esc(d.runtimeJsPath) + '"' + d.nonceAttr + '></scr' + 'ipt>\n' +
      '</body></html>';
  }

  var api = { shellHtml: shellHtml, appHtml: appHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.TDOC_SHELL_BUILDER = api;
})();
