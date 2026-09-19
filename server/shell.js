// tdoc shared shell builder — a pure function that renders the cross-origin
// shell document, with all environment-specific inputs
// (file contents, identity, config) injected by the caller. The local server
// (server/server.js) requires this; the worker inlines it as code (Cloudflare
// Workers ban eval/new Function, so it exposes itself on globalThis instead of
// being eval'd from a string). Keep it dependency-free (no fs/path/window).
(function () {
  'use strict';
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); }

  // Plain-text excerpt from author HTML for Open Graph / meta description.
  // Crawlers and share cards never run the sandboxed frame, so the shell has
  // to carry a short summary itself.
  function excerptFromHtml(html, maxLen) {
    const limit = Math.max(40, Math.min(300, Number(maxLen) || 180));
    if (typeof html !== 'string' || !html) return '';
    const text = html
      // Close tags may carry whitespace before `>` — match that so a filter
      // cannot be skipped with `</script >`.
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      // Drop entities entirely (to a space) rather than decoding to `&`, which
      // CodeQL flags as a double-unescape hazard when the string later goes
      // through HTML escaping for meta attributes.
      .replace(/&(?:#x?[0-9a-f]+|[a-z]+);/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    if (text.length <= limit) return text;
    const cut = text.slice(0, limit - 1);
    const softer = cut.replace(/\s+\S*$/, '');
    return (softer.length >= 40 ? softer : cut) + '\u2026';
  }

  function seoHeadHtml(d) {
    const seo = d && d.seo;
    if (!seo || typeof seo !== 'object') return '';
    const title = esc(seo.title || d.title || '');
    const description = esc(seo.description || '');
    const url = esc(seo.url || '');
    const image = esc(seo.image || '');
    const type = esc(seo.type || 'article');
    const robots = esc(seo.robots || '');
    let out = '';
    if (robots) out += '<meta name="robots" content="' + robots + '">\n';
    if (url) out += '<link rel="canonical" href="' + url + '">\n';
    if (description) out += '<meta name="description" content="' + description + '">\n';
    out += '<meta property="og:type" content="' + type + '">\n';
    out += '<meta property="og:site_name" content="tdoc">\n';
    if (url) out += '<meta property="og:url" content="' + url + '">\n';
    if (title) out += '<meta property="og:title" content="' + title + '">\n';
    if (description) out += '<meta property="og:description" content="' + description + '">\n';
    if (image) out += '<meta property="og:image" content="' + image + '">\n';
    // Logo is square; summary (not summary_large_image) matches it.
    out += '<meta name="twitter:card" content="summary">\n';
    if (title) out += '<meta name="twitter:title" content="' + title + '">\n';
    if (description) out += '<meta name="twitter:description" content="' + description + '">\n';
    if (image) out += '<meta name="twitter:image" content="' + image + '">\n';
    return out;
  }

  // Noscript + crawlable summary: share bots use the meta tags above; search
  // engines that skip JS still get a title and a short plain-text lead without
  // pulling author HTML out of the sandbox.
  function seoBodyHtml(d) {
    const seo = d && d.seo;
    if (!seo || typeof seo !== 'object') return '';
    const title = esc(seo.title || d.title || '');
    const description = esc(seo.description || '');
    if (!title && !description) return '';
    let out = '<noscript>\n';
    if (title) out += '<h1>' + title + '</h1>\n';
    if (description) out += '<p>' + description + '</p>\n';
    if (seo.url) out += '<p><a href="' + esc(seo.url) + '">Open on tdoc</a></p>\n';
    out += '</noscript>\n';
    return out;
  }

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
seoHeadHtml(d) +
'<link rel="stylesheet" href="' + esc(d.runtimeCssPath) + '">\n' +
'</head><body>\n' +
seoBodyHtml(d) +
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

  var api = { shellHtml: shellHtml, appHtml: appHtml, excerptFromHtml: excerptFromHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.TDOC_SHELL_BUILDER = api;
})();
