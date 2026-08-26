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

    // Copy / Duplicate / Download all live inside the ⋯ menu now (matches the
    // overlay's redesigned right cluster) — no standalone Copy button.
    var secVersionsHtml = versions.length > 1
      ? '<div class="tdoc-sec-versions" role="group" aria-label="Version"><div class="tdoc-sec-label">Version</div>' +
        versions.map(function (v) { return '<button role="option" data-version="' + v.n + '" class="tdoc-sec-version' + (v.n === version ? ' current' : '') + '">v' + v.n + (v.n === version ? ' · current' : '') + '</button>'; }).join('') +
        '<div class="tdoc-sec-sep"></div></div>'
      : '';
    var secondaryMenuHtml = '<div class="tdoc-menu-wrap">' +
      '<button class="tdoc-secondary-toggle" id="tdoc-more-btn" aria-label="More" title="More">⋯</button>' +
      '<div class="tdoc-secondary-menu" id="tdoc-secondary-menu">' +
        secVersionsHtml +
        '<button data-action="copy">Copy as Markdown</button>' +
        (isPublished ? '<button data-action="duplicate">Duplicate</button><button data-action="download">Download HTML</button><button data-action="download-pdf">Download PDF</button>' : '') +
        (isFork ? '<button data-action="saveas">Download HTML</button><button data-action="download-pdf">Download PDF</button>' : '') +
        (o.ownerManage ? '<div class="tdoc-sec-sep"></div><button data-action="delete" class="tdoc-sec-danger">Delete doc…</button>' : '') +
      '</div></div>';

    var primaryCtaHtml = isFork ? '' : (isPublished ?
      '<button id="tdoc-share-btn" class="primary" title="Share" aria-label="Share"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span>Share</span></button>' :
      '<button id="tdoc-publish-btn" class="primary" title="Publish to your Worker" aria-label="Publish"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg><span>Publish</span></button>');

    var downloadMenuHtml = (isPublished || isFork) ?
      '<div class="tdoc-menu-wrap" id="tdoc-download-wrap"><button id="tdoc-download-btn" title="Download" aria-haspopup="menu" aria-expanded="false">Download</button><div class="tdoc-menu" id="tdoc-download-menu" role="menu"><button data-format="html" role="menuitem">Download HTML</button><button data-format="pdf" role="menuitem">Download PDF</button></div></div>' : '';
    var forkBtnHtml = isPublished ? ('<button id="tdoc-duplicate-btn" title="Make a copy in your account">Duplicate</button>' + downloadMenuHtml) : downloadMenuHtml;

    var themeBtnHtml = '<button type="button" id="tdoc-theme-btn" class="tdoc-theme-btn" aria-pressed="false" title="Dark mode" aria-label="Switch to dark mode"><svg class="tdoc-theme-icon-moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/></svg><svg class="tdoc-theme-icon-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg></button>';

    // GitHub button carries the live star count when provided (landing bar).
    var ghStars = (typeof o.stars === 'number' && o.stars >= 0) ? o.stars : null;
    var ghStarText = ghStars === null ? '' : (ghStars >= 1000 ? (ghStars / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(ghStars));
    var githubBtnHtml = '<a class="tdoc-github-btn" id="tdoc-github-btn" href="https://github.com/tornado-doc/tdoc" target="_blank" rel="noopener" title="' + (ghStars === null ? 'tdoc on GitHub' : ghStars + ' stars on GitHub') + '" aria-label="tdoc on GitHub"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>' + (ghStarText ? '<span class="tdoc-gh-stars"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>' + ghStarText + '</span>' : '') + '</a>';

    var rightHtml = '' +
      (o.isLanding ? githubBtnHtml : '') +
      themeBtnHtml +
      (isSiteBar ? '' : forkBtnHtml) +
      (isSiteBar ? '' : primaryCtaHtml) +
      (isSiteBar ? '' : secondaryMenuHtml) +
      '<span id="tdoc-identity-slot"></span>';

    return '<div class="tdoc-bar-left">' + leftHtml + '</div><div class="tdoc-bar-right">' + rightHtml + '</div>';
  }

  // Agent logo mapping (port of overlay.js agentLogoUrl): map grok/claude/codex/
  // gemini/cursor logins to their product marks; never the Anthropic company PNG.
  function tdocLogoUrl() { return '/tdoc_logo.svg'; }
  function isAnthropicCompanyMark(url) { return typeof url === 'string' && /(?:^|\/\/)(?:www\.)?github\.com\/anthropics(?:\.png)?(?:[/?#]|$)/i.test(url); }
  function agentLogoUrl(author) {
    var stored = (author && typeof author.avatar_url === 'string' && /^https:\/\//i.test(author.avatar_url)) ? author.avatar_url : null;
    var key = String((author && (author.login || author.name)) || '').toLowerCase();
    if (key.indexOf('claude') >= 0 || key.indexOf('anthropic') >= 0 || isAnthropicCompanyMark(stored)) return 'https://cdn.simpleicons.org/claude/d97757';
    if (stored) return stored;
    if (key.indexOf('grok') >= 0 || key.indexOf('xai') >= 0) return 'https://github.com/xai-org.png';
    if (key.indexOf('codex') >= 0 || key.indexOf('openai') >= 0 || key.indexOf('chatgpt') >= 0 || key === 'gpt' || key.indexOf('gpt-') === 0) return 'https://github.com/openai.png';
    if (key.indexOf('gemini') >= 0 || key.indexOf('bard') >= 0) return 'https://cdn.simpleicons.org/googlegemini/8e75b2';
    if (key.indexOf('cursor') >= 0 || key.indexOf('composer') >= 0) return 'https://cdn.simpleicons.org/cursor/000000';
    return tdocLogoUrl();
  }
  // Avatar markup (was overlay.js:2498-2507): agent → product logo, else avatar_url,
  // else anon placeholder.
  function avatarHtml(author, anonClass) {
    var url = (author && author.kind === 'agent') ? agentLogoUrl(author) : (author && author.avatar_url);
    return url
      ? '<img src="' + escapeHtml(url) + '" alt="" data-tdoc-fallback-anon="' + anonClass + '">'
      : '<span class="' + anonClass + '"></span>';
  }

  // Composer inner HTML (was overlay.js:3382-3389 popup.innerHTML). Consumer
  // creates a .tdoc-popup element and sets innerHTML to this.
  function buildComposer(o) {
    o = o || {};
    var anchor = o.anchor || {}, needsSignIn = !!o.needsSignIn;
    var t = anchor.text || '';
    var preview = anchor.kind === 'text'
      ? '"' + escapeHtml(t.slice(0, 80)) + (t.length > 80 ? '…' : '') + '"'
      : '📎 ' + escapeHtml(anchor.label || '');
    return '<div class="head"><span class="h">' + preview + '</span><span class="x">×</span></div>' +
      (needsSignIn ? '<div class="signin-needed">Sign in with GitHub to comment.</div>' : '') +
      '<textarea placeholder="What should change?" ' + (needsSignIn ? 'disabled' : '') + '></textarea>' +
      '<div class="foot"><span class="hint">' + (needsSignIn ? '' : '⌘+Enter to submit') + '</span>' +
      '<button class="submit">' + (needsSignIn ? 'Sign in' : 'Comment') + '</button></div>';
  }

  // Author row (was overlay.js:1986-1997). Agent-logo mapping deferred; agents
  // fall back to avatar_url/anon.
  function renderAuthor(author) {
    if (!author) return '<div class="author"><span class="anon">anonymous</span></div>';
    if (author.kind === 'agent') {
      var label = author.name || author.login || 'tdoc-agent';
      return '<div class="author tdoc-agent-author"><img src="' + escapeHtml(agentLogoUrl(author)) + '" alt="" data-tdoc-fallback-anon="tdoc-agent-badge"><span class="login">' + escapeHtml(label) + '</span></div>';
    }
    var avatar = author.avatar_url ? '<img src="' + escapeHtml(author.avatar_url) + '" alt="">' : '';
    return '<div class="author">' + avatar + '<span class="login">' + escapeHtml(author.login || 'anonymous') + '</span></div>';
  }

  // Floating comment card inner HTML (subset of overlay.js buildCard 2061+):
  // author + text + meta. Replies/reactions/actions/re-anchor are deferred.
  // Consumer creates a .tdoc-margin-comment element and sets innerHTML to this.
  function buildCard(comment, me) {
    comment = comment || {};
    var id = escapeHtml(comment.id || '');
    var when = '';
    try { when = new Date(comment.created).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) {}
    var replies = Array.isArray(comment.replies) ? comment.replies : [];
    var repliesBlock = replies.length
      ? '<div class="tdoc-replies-toggle" data-id="' + id + '"><svg class="chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' + replies.length + ' ' + (replies.length === 1 ? 'reply' : 'replies') + '</div>' +
        '<div class="tdoc-replies">' + replies.map(function (r) { return '<div class="tdoc-reply" data-comment-id="' + escapeHtml(r.id || '') + '">' + renderAuthor(r.author) + '<div class="text">' + escapeHtml(r.text || '') + '</div></div>'; }).join('') + '</div>'
      : '';
    var hr = hasReactions(comment);
    var isResolved = comment.status === 'applied';
    var verdict = comment._agentVerdict || 'applied';
    var resolvedBy = comment._agentActor || comment.agent_actor || 'tdoc-agent';
    var resolvedChip = isResolved
      ? '<span class="tdoc-resolved-chip" title="Resolved by ' + escapeHtml(resolvedBy) + (comment.applied_in ? ' in v' + escapeHtml(String(comment.applied_in)) : '') + '">✓ ' + (verdict === 'partial' ? 'partially fixed' : verdict === 'question' ? 'needs input' : 'fixed') + (comment.applied_in ? ' · v' + escapeHtml(String(comment.applied_in)) : '') + '</span>'
      : '';
    var anchorActions = '<div class="tdoc-anchor-actions"><button class="tdoc-reanchor-btn" type="button" data-id="' + id + '"><span class="tdoc-reanchor-unanchored">unanchored — click to re-anchor</span><span class="tdoc-reanchor-anchored">↻ move anchor</span></button></div>';
    return anchorActions + resolvedChip + renderAuthor(comment.author) +
      '<div class="text">' + escapeHtml(comment.text || '') + '</div>' +
      (hr ? renderReactionsRow(comment, me) : '') +
      '<div class="meta"><span>v' + (comment.version || 1) + (when ? ' · ' + escapeHtml(when) : '') + '</span>' +
      '<span class="actions">' + (hr ? '' : reactAddInline(comment)) +
      '<span class="tdoc-reply-toggle" data-id="' + id + '">Reply</span>' +
      '<span class="del" data-id="' + id + '">delete</span></span></div>' +
      repliesBlock +
      '<div class="tdoc-reply-form" data-parent-id="' + id + '"><textarea placeholder="Reply…"></textarea>' +
      '<div class="tdoc-reply-form-foot"><span class="hint"></span><button class="tdoc-reply-submit">Reply</button></div></div>';
  }

  // --- reactions (ports overlay.js QUICK_EMOJIS/renderReactionsRow/glyph/picker) ---
  var QUICK_EMOJIS = ['👍', '❤️', '🔥', '🎉', '😂', '🤔', '👀', '🚀', '✅', '❌', '❓', '❗'];
  var QUICK_TEXT_REACTIONS = ['LGTM'];
  var REACT_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/><line x1="19" y1="6" x2="19" y2="10"/><line x1="19" y1="6" x2="19" y2="10"/><line x1="21" y1="8" x2="17" y2="8"/></svg>';
  function reactionGlyph(s) { var safe = escapeHtml(s); return QUICK_TEXT_REACTIONS.indexOf(s) >= 0 ? safe : '<span class="tdoc-emoji">' + safe + '</span>'; }
  function hasReactions(comment) { var r = comment && comment.reactions; return !!(r && Object.keys(r).some(function (k) { return r[k] && r[k].length; })); }
  function renderReactionsRow(comment, me) {
    var reactions = (comment && comment.reactions) || {}; me = me || 'anon';
    var emojis = Object.keys(reactions).filter(function (k) { return reactions[k] && reactions[k].length; });
    if (!emojis.length) return '';
    var chips = emojis.map(function (emoji) {
      var users = reactions[emoji], mine = users.indexOf(me) >= 0;
      var isAgent = users.some(function (u) { return u === 'tdoc-agent' || /agent|codex|claude/i.test(u); });
      var cls = ['tdoc-react-chip', mine ? 'mine' : '', isAgent ? 'agent' : ''].filter(Boolean).join(' ');
      return '<span class="' + cls + '" data-emoji="' + escapeHtml(emoji) + '" data-target-id="' + escapeHtml(comment.id) + '">' + reactionGlyph(emoji) + ' ' + users.length + '</span>';
    }).join('');
    return '<div class="tdoc-reactions" data-target-id="' + escapeHtml(comment.id) + '">' + chips + '<button class="tdoc-react-add" data-target-id="' + escapeHtml(comment.id) + '" title="Add reaction" aria-label="Add reaction">' + REACT_ICON_SVG + '</button></div>';
  }
  function reactAddInline(comment) { return '<button class="tdoc-react-add inline" data-target-id="' + escapeHtml(comment.id) + '" title="Add reaction" aria-label="Add reaction">' + REACT_ICON_SVG + '</button>'; }
  function buildEmojiPicker() {
    return QUICK_EMOJIS.map(function (e) { return '<button data-emoji="' + e + '">' + reactionGlyph(e) + '</button>'; }).join('') +
      QUICK_TEXT_REACTIONS.map(function (t) { return '<button class="tdoc-emoji-text" data-emoji="' + t + '">' + t + '</button>'; }).join('');
  }

  // Pure pin-layout core — verbatim port of overlay.js layoutPins (2409-2469),
  // shared so the single-origin overlay and the cross-origin shell cluster pins
  // identically. Takes Y-positioned rows [{y, c, el?, elTop?, elHeight?}], the
  // gutter geometry {articleTop, articleHeight}, and spacing consts; returns the
  // placed clusters [{y, items:[row,...]}]. MUTATES row.y. In the shell rows have
  // no `el` (text anchors), so the element-spread step is a no-op there.
  function layoutPins(rows, geo, consts) {
    var PIN_SIZE = consts.PIN_SIZE, PIN_MIN_GAP = consts.PIN_MIN_GAP, SAME_LINE_GAP = consts.SAME_LINE_GAP;
    // 0) Spread comments sharing the SAME element anchor down that element.
    var byEl = new Map();
    for (var a = 0; a < rows.length; a++) { var r0 = rows[a]; if (!r0.el) continue; if (!byEl.has(r0.el)) byEl.set(r0.el, []); byEl.get(r0.el).push(r0); }
    byEl.forEach(function (group) {
      if (group.length < 2) return;
      var top = group[0].elTop, h = group[0].elHeight || 0, usable = Math.max(0, h - PIN_SIZE);
      if (usable < PIN_MIN_GAP) return;
      var step = Math.max(PIN_MIN_GAP, usable / (group.length - 1));
      group.forEach(function (r, i) { r.y = top + i * step; });
    });
    rows.sort(function (x, y) { return x.y - y.y; });
    // 1) Merge only genuinely same-line comments into clusters (tight gap).
    var clusters = [];
    for (var b = 0; b < rows.length; b++) {
      var row = rows[b], last = clusters[clusters.length - 1];
      if (last && row.y - last.maxY <= SAME_LINE_GAP) { last.items.push(row); last.maxY = row.y; last.y = (last.items[0].y + row.y) / 2; }
      else clusters.push({ y: row.y, maxY: row.y, items: [row] });
    }
    // 2) Spread to prevent overlap; fold the overflow tail past the article bottom.
    var bottomLimit = geo.articleTop + geo.articleHeight, placed = [], prevY = -Infinity;
    for (var d = 0; d < clusters.length; d++) {
      var cl = clusters[d], y = Math.max(cl.y, prevY + PIN_MIN_GAP);
      if (y > bottomLimit && placed.length) { var tail = placed[placed.length - 1]; tail.items.push.apply(tail.items, cl.items); continue; }
      cl.y = y; placed.push(cl); prevY = y;
    }
    return placed;
  }

  var api = { escapeHtml: escapeHtml, buildFooter: buildFooter, buildBar: buildBar, avatarHtml: avatarHtml, buildComposer: buildComposer, renderAuthor: renderAuthor, buildCard: buildCard, hasReactions: hasReactions, renderReactionsRow: renderReactionsRow, buildEmojiPicker: buildEmojiPicker, layoutPins: layoutPins };
  if (typeof window !== 'undefined') window.TDOC_CHROME = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  // The Cloudflare worker inlines this file as code (Workers ban eval) and reads
  // the API off globalThis — window/module don't exist there.
  if (typeof globalThis !== 'undefined') globalThis.TDOC_CHROME = api;
})();
