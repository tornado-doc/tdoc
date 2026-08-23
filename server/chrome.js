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

  // Verbatim port of overlay.js bar assembly (was overlay.js:916-1006). Closure
  // vars (mode/slug/version/versions/isLanding/isCatalog/originalSlug) are now
  // explicit params. Returns the bar's innerHTML; handlers are wired by the
  // consumer (overlay or shell), not here. Markup byte-identical to overlay.
  function buildBar(o) {
    o = o || {};
    var mode = o.mode || 'local';
    var slug = o.slug, version = o.version;
    var isFork = mode === 'fork', isPublished = mode === 'published';
    var versions = (Array.isArray(o.versions) && o.versions.length) ? o.versions.slice() : [{ n: version }];
    versions.sort(function (a, b) { return (a.n || 0) - (b.n || 0); });
    var slugCrumbLabel = isFork ? ('fork of ' + (o.originalSlug || slug)) : slug;
    var isSiteBar = !!(o.isLanding || o.isCatalog);

    var leftHtml = '' +
      '<button class="tdoc-bar-mark" id="tdoc-bar-mark" title="My docs" aria-label="My docs"><img src="/tdoc_logo.svg" alt="" width="24" height="24"></button>' +
      (isSiteBar ? '' :
        '<span class="crumb crumb-slug" title="' + escapeHtml(slugCrumbLabel) + '">' + escapeHtml(slugCrumbLabel) + '</span>' +
        '<span class="crumb-sep crumb-sep-slug" aria-hidden="true">/</span>' +
        '<div class="tdoc-version-wrap">' +
          '<button class="tdoc-version-toggle" id="tdoc-version-toggle" type="button" aria-haspopup="listbox" aria-expanded="false">v' + version + (versions.length > 1 ? ' ▾' : '') + '</button>' +
          (versions.length > 1 ?
            '<div class="tdoc-version-menu" id="tdoc-version-menu" role="listbox">' +
              versions.map(function (v) { return '<button role="option" data-version="' + v.n + '" class="' + (v.n === version ? 'current' : '') + '">v' + v.n + (v.n === version ? ' · current' : '') + '</button>'; }).join('') +
            '</div>' : '') +
        '</div>' +
        '<span class="doc-title" id="tdoc-title">tdoc</span>');

    var copyMenuHtml = '' +
      '<div class="tdoc-menu-wrap">' +
        '<button id="tdoc-copy-md-btn" title="Copy as Markdown" aria-label="Copy as Markdown">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
          '<span>Copy</span>' +
        '</button>' +
        '<div class="tdoc-menu" id="tdoc-copy-md-menu"><button data-mode="doc">Doc only</button><button data-mode="doc-comments">Doc + comments</button></div>' +
      '</div>';

    var primaryCtaHtml = isFork ? '' : (isPublished ?
      '<button id="tdoc-share-btn" class="primary" title="Share" aria-label="Share"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span>Share</span></button>' :
      '<button id="tdoc-publish-btn" class="primary" title="Publish to your Worker" aria-label="Publish"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg><span>Publish</span></button>');

    var downloadMenuHtml = (isPublished || isFork) ?
      '<div class="tdoc-menu-wrap" id="tdoc-download-wrap"><button id="tdoc-download-btn" title="Download" aria-haspopup="menu" aria-expanded="false">Download</button><div class="tdoc-menu" id="tdoc-download-menu" role="menu"><button data-format="html" role="menuitem">Download HTML</button><button data-format="pdf" role="menuitem">Download PDF</button></div></div>' : '';
    var forkBtnHtml = isPublished ? ('<button id="tdoc-duplicate-btn" title="Make a copy in your account">Duplicate</button>' + downloadMenuHtml) : downloadMenuHtml;

    var themeBtnHtml = '<button type="button" id="tdoc-theme-btn" class="tdoc-theme-btn" aria-pressed="false" title="Dark mode" aria-label="Switch to dark mode"><svg class="tdoc-theme-icon-moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/></svg><svg class="tdoc-theme-icon-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg></button>';

    var githubBtnHtml = '<a class="tdoc-github-btn" id="tdoc-github-btn" href="https://github.com/tornado-doc/tdoc" target="_blank" rel="noopener" title="tdoc on GitHub" aria-label="tdoc on GitHub"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></a>';

    var rightHtml = '' +
      (o.isLanding ? githubBtnHtml : '') +
      themeBtnHtml +
      (isSiteBar ? '' : copyMenuHtml) +
      (isSiteBar ? '' : forkBtnHtml) +
      (isSiteBar ? '' : primaryCtaHtml) +
      ((!isSiteBar && (isPublished || isFork)) ?
        '<div class="tdoc-menu-wrap"><button class="tdoc-secondary-toggle" id="tdoc-more-btn" aria-label="More" title="More">⋯</button><div class="tdoc-secondary-menu" id="tdoc-secondary-menu">' +
          (isPublished ? '<button data-action="duplicate">Duplicate</button><button data-action="download">Download HTML</button><button data-action="download-pdf">Download PDF</button>' : '') +
          (isFork ? '<button data-action="saveas">Download HTML</button><button data-action="download-pdf">Download PDF</button>' : '') +
        '</div></div>' : '') +
      '<span id="tdoc-identity-slot"></span>';

    return '<div class="tdoc-bar-left">' + leftHtml + '</div><div class="tdoc-bar-right">' + rightHtml + '</div>';
  }

  var api = { escapeHtml: escapeHtml, buildFooter: buildFooter, buildBar: buildBar };
  if (typeof window !== 'undefined') window.TDOC_CHROME = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
