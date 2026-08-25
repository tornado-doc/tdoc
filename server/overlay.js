// tdoc overlay — single-file design.
// Sections are demarcated with `// ========== Name ==========` headers so the
// file reads like several concatenated modules. Each section depends only on
// the ones above it (and on `state`). No section reaches sideways.
//
// External contract preserved verbatim:
//   - Endpoints: /api/comments, /api/reactions, /api/auth/device/start,
//     /api/auth/device/poll, /api/auth/logout, /api/notifications,
//     /api/notifications/unread, /api/notifications/read,
//     /d/<slug>/v/<n>/export, POST /api/doc/duplicate
//   - Globals: window.__tdocCopyDocMd(includeComments), window.__tdocCopyCommentMd(id, btn)
//   - Body classes: tdoc-has-comments, tdoc-narrow
//   - Keyboard: ⌘/Ctrl-Enter submits, Esc cancels.
//
// Highlight rendering: CSS Custom Highlight API (CSS.highlights). One named
// highlight `tdoc-pending` for the in-flight selection, and one
// `tdoc-anchor-<id>` per saved comment. This replaces the legacy
// surroundContents/extractContents path that produced empty yellow bars when
// the selection crossed block boundaries. A minimal single-textnode <span>
// fallback runs on browsers without `CSS.highlights`.

(function () {
  // ========== Config & DOM setup ==========
  const cfg = window.__TDOC__ || {};
  const { slug, version } = cfg;
  const mode = cfg.mode || 'local';
  const isPublished = mode === 'published';
  const isFork = mode === 'fork';
  const isLocal = mode === 'local';
  // Fork mode renders the doc read-only with comments mirrored from the
  // embedded #tdoc-fork-comments JSON. No /api calls, no auth, no publish.
  // The original published slug is in cfg.originalSlug so we can label it.
  let identity = cfg.identity || null;
  let isOwner = !!cfg.isOwner; // true when this session owns THIS doc
  // Worker sends this explicitly. Do not infer from isOwner — on hosted
  // tdoc.dev a signed-in reader may not own the current doc and still has /me.
  let canSeeMyDocs = !!cfg.canSeeMyDocs;
  // /me catalog reuses this overlay for the bar (mark, theme, identity) and
  // hides Share / Duplicate / Copy. No slug — it is not a document.
  const isCatalog = !!cfg.isCatalog;
  if (!slug && !isCatalog) return;
  if (isCatalog) document.body.classList.add('tdoc-catalog');

  const HIGHLIGHT_API = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  // Broken-avatar fallback, delegated (CSP-safe). Doc responses now carry a
  // nonce-based script-src CSP (see worker.js cspHeader()) with no
  // 'unsafe-inline', so an inline `onerror="..."` attribute — which this used
  // to be — can never run. `error` events on <img> don't bubble, so this must
  // be a CAPTURE-phase listener on document, not a delegated bubble listener.
  // avatarHTML() below marks fallback-eligible images with
  // data-tdoc-fallback-anon instead of an inline handler.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.dataset || !img.dataset.tdocFallbackAnon) return;
    const span = document.createElement('span');
    span.className = img.dataset.tdocFallbackAnon;
    img.replaceWith(span);
  }, true);

  // Phones need this or they render at a virtual ~980px viewport.
  if (!document.querySelector('meta[name="viewport"]')) {
    const m = document.createElement('meta');
    m.name = 'viewport';
    m.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    document.head.appendChild(m);
  }

  // Theme: light until the user flips the bar switch. After a switch, persist
  // on this origin via localStorage and restore on later visits. No OS follow.
  const THEME_KEY = 'tdoc-theme';
  function readStoredTheme() {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'dark' || stored === 'light') return stored;
    } catch (e) { /* private mode */ }
    // No saved choice yet — honor a doc that declares its default look
    // (data-tdoc-default-theme="dark", e.g. a dark-first engineering style),
    // otherwise light. The bar button still overrides and persists.
    const declared = document.documentElement.getAttribute('data-tdoc-default-theme');
    return declared === 'dark' ? 'dark' : 'light';
  }
  function currentTheme() {
    return document.documentElement.getAttribute('data-tdoc-theme') === 'dark' ? 'dark' : 'light';
  }
  function persistTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode */ }
  }
  function paintTheme(theme) {
    document.documentElement.setAttribute('data-tdoc-theme', theme);
    document.documentElement.style.colorScheme = theme;
    const btn = document.getElementById('tdoc-theme-btn');
    if (!btn) return;
    const dark = theme === 'dark';
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.title = dark ? 'Light mode' : 'Dark mode';
  }
  paintTheme(readStoredTheme());

  // ========== Copy-to-clipboard primitive (author opt-in) ==========
  // A doc runs under a nonce CSP, so the doc's OWN <script> can never wire a
  // copy button. The overlay (nonced, trusted) provides one instead: any
  // element carrying data-tdoc-copy becomes a working "click to copy" trigger.
  //   <button data-tdoc-copy="literal text …">Copy</button>   copies the literal
  //   <button data-tdoc-copy="#promptId">Copy the prompt</button>
  //                                     copies #promptId's text (trimmed)
  // On success the trigger briefly shows data-tdoc-copy-done (default "Copied ✓")
  // and gets a .tdoc-copied class the doc can style. Delegated + capture-phase
  // so it fires before (and suppresses) the doc's artifact/comment handlers,
  // and is a no-op for every click that is not on a copy trigger.
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch (e) { return false; }
  }
  function flashCopyTrigger(trigger) {
    const done = trigger.getAttribute('data-tdoc-copy-done') || 'Copied ✓';
    if (trigger.getAttribute('data-tdoc-copy-label') == null) {
      trigger.setAttribute('data-tdoc-copy-label', trigger.textContent);
    }
    trigger.textContent = done;
    trigger.classList.add('tdoc-copied');
    clearTimeout(trigger._tdocCopyTimer);
    trigger._tdocCopyTimer = setTimeout(() => {
      const orig = trigger.getAttribute('data-tdoc-copy-label');
      if (orig != null) trigger.textContent = orig;
      trigger.classList.remove('tdoc-copied');
    }, 1600);
  }
  function wireCopyTriggers() {
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest && e.target.closest('[data-tdoc-copy]');
      if (!trigger) return;                       // not a copy click — leave alone
      e.preventDefault();
      e.stopPropagation();
      const raw = trigger.getAttribute('data-tdoc-copy') || '';
      let text = raw;
      if (raw.charAt(0) === '#') {
        const src = document.getElementById(raw.slice(1));
        if (src) text = (src.innerText || src.textContent || '').replace(/\u00a0/g, ' ').trim();
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => flashCopyTrigger(trigger),
          () => { if (fallbackCopy(text)) flashCopyTrigger(trigger); }
        );
      } else if (fallbackCopy(text)) {
        flashCopyTrigger(trigger);
      }
    }, true);
  }

  // ========== UI selector registry ==========
  // One source of truth for "is this part of the tdoc overlay UI?".
  //   UI_CONTAINERS — top-level overlay regions: bar, popups, comment column,
  //                   margin cards, modals, footer. Use these when finding the
  //                   doc's article element or stripping the overlay from a
  //                   clone for export.
  //   UI_ALL        — UI_CONTAINERS plus per-element decorations (anchor marks,
  //                   outlines, hover affordances, menus). Use this for event
  //                   delegation guards ("did the user click *our* chrome?").
  // NOTE: #tdoc-pin-layer and .tdoc-cluster-pop are tdoc's OWN comment-pins UI.
  // They MUST be in UI_CONTAINERS so artifact detection / the hover comment-pill
  // never treats a pin avatar <img> (or a cluster row) as a commentable artifact.
  const UI_CONTAINERS = '.tdoc-bar, .tdoc-oldver-strip, .tdoc-popup, .tdoc-margin-comment, .tdoc-modal-bg, .tdo-bg, .tds-bg, #tdoc-comment-layer, #tdoc-pin-layer, .tdoc-cluster-pop, .tdoc-footer';
  const UI_ALL = UI_CONTAINERS + ', .tdoc-anchor-mark, .tdoc-element-outline, .tdoc-hover-outline, .tdoc-comment-pill, .tdoc-emoji-picker, .tdoc-secondary-menu';

  // ========== Geometry helpers ==========
  // Position `box` as an absolutely-positioned overlay around `el`, inflated
  // by `inset` pixels on each side (default 3 → a 3px-wide outline ring).
  function positionOutlineAround(box, el, inset = 3) {
    const r = el.getBoundingClientRect();
    box.style.top = (window.scrollY + r.top - inset) + 'px';
    box.style.left = (window.scrollX + r.left - inset) + 'px';
    box.style.width = (r.width + inset * 2) + 'px';
    box.style.height = (r.height + inset * 2) + 'px';
  }

  // Range.getBoundingClientRect() is the UNION of every line box. A wrapped
  // selection is therefore a tall rectangle whose bottom-left is nowhere near
  // the caret; WebKit also sometimes returns a 0×0 rect when the range
  // crosses a block. The new-comment popup and pin Y used that union, so the
  // card "sometimes" sat off the highlight. Prefer the live line box.
  function isVisibleClientRect(r) {
    return !!r && (r.width > 0 || r.height > 0);
  }
  function nearestClientRect(rects, x, y) {
    let best = null, bestD = Infinity;
    const list = rects && rects.length != null ? rects : [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!isVisibleClientRect(r)) continue;
      const dx = x - Math.max(r.left, Math.min(x, r.right));
      const dy = y - Math.max(r.top, Math.min(y, r.bottom));
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }
  function firstVisibleClientRect(target) {
    if (!target) return null;
    if (target.getClientRects) {
      const rects = target.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        if (isVisibleClientRect(rects[i])) return rects[i];
      }
    }
    if (!target.getBoundingClientRect) return null;
    const r = target.getBoundingClientRect();
    return isVisibleClientRect(r) ? r : null;
  }
  function clientRectNearPoint(target, x, y) {
    if (!target) return null;
    if (target.getClientRects && Number.isFinite(x) && Number.isFinite(y)) {
      const near = nearestClientRect(target.getClientRects(), x, y);
      if (near) return near;
    }
    return firstVisibleClientRect(target);
  }
  // A zero-width box on `line` at x — the caret / mouse-up, not the line origin.
  function endRectOnLine(line, x) {
    if (!line) return null;
    const left = Number.isFinite(x) ? x : line.right;
    const height = line.height || (line.bottom - line.top) || 0;
    return { left, right: left, top: line.top, bottom: line.bottom, width: 0, height };
  }

  // ========== Styles ==========
  // Each logical group is one comment block; rules within a group are tightly
  // packed. The narrow visual mode lives at the bottom and overrides base.
  const css = `
  /* Layout */
  /* Default: text is selectable everywhere in the document body, so users
     can highlight prose inside any container (including custom-div-wrapped
     artifacts like transcript panes). UI chrome opts out explicitly via
     .tdoc-* selectors below. Media artifacts (img/svg/canvas/video) are
     non-selectable by their nature so they don't need an exception. */
  body { margin: 0; padding-bottom: 24px; -webkit-user-select: text; user-select: text; }
  body .tdoc-bar, body .tdoc-bar *, body #tdoc-comment-layer, body #tdoc-comment-layer *, body #tdoc-pin-layer, body #tdoc-pin-layer *, body .tdoc-cluster-pop, body .tdoc-cluster-pop *, body .tdoc-hover-outline, body .tdoc-comment-pill, body .tdoc-emoji-picker, body .tdoc-secondary-menu, body .tdoc-anchor-mark.tdoc-anchor-mark-element, body .tdoc-drag-marquee, body .tdoc-modal, body .tdoc-modal * { -webkit-user-select: none !important; user-select: none !important; }
  body .tdoc-modal .code, body .tdoc-modal textarea, body .tdoc-modal input { -webkit-user-select: text !important; user-select: text !important; }
  /* Comment pins/cards are provider chrome, not document layout. Keep the
     document centered in the viewport; if the comment UI cannot fit beside it,
     narrow mode switches comments into the drawer. */
  body.tdoc-pins:not(.tdoc-narrow) { padding-right: 0 !important; padding-left: 0 !important; }
  body.tdoc-narrow { padding-right: 0 !important; padding-left: 0 !important; }
  /* Center the article container in the reading column. :where() so any
     doc-defined margin wins. Applies only on wide layouts; narrow mode
     uses the full body width via the drawer. */
  body:not(.tdoc-narrow) :where(body > .wrap, body > main, body > article, body > .content, body > .container) {
    margin-left: auto !important;
    margin-right: auto !important;
  }
  /* The article stays centered in the viewport. As the window shrinks, narrow
     mode takes over and the drawer kicks in before comment chrome overlaps it. */
  /* ========== Default doc template (single typography template) ==========
     One canonical look for every tdoc doc: same font stack, sizes, spacing,
     headings, lists, code, tables, quotes. Wrapped in :where() so a doc that
     truly needs a different aesthetic can override per element. Future
     templates would live alongside this block, switched by a body class. */
  /* ===== Theme tokens (JUL-21 v2). Every themable color in the doc template
     AND the overlay UI goes through these variables — no stray literals, so a
     single place to change a colour instead of hunting literals. These are the
     Classic values — the look is unchanged. Alternate palettes and any picker
     UI are deliberately out of scope for this CSS block. ===== */
  /* TDOC_READER_CSS_START */
  :root {
    --td-accent: #1652f0;
    --td-accent-hover: #1245d0;
    --td-accent-ring: rgba(22,82,240,0.35);
    --td-accent-ring-soft: rgba(22,82,240,0.18);
    --td-accent-wash: rgba(22,82,240,0.06);
    --td-accent-tint: #e8eeff;
    --td-danger: #b42318;
    --td-danger-hover: #931c14;
    --td-danger-tint: #fdeceb;
    --td-ground: #fff;
    --td-ink: #1a1a1a;
    --td-heading: #1a1a1a;
    --td-muted: #6b6a66;
    --td-line: #e8e7e3;
    --td-surface: #f0f0ee;
    --td-surface-2: #f7f7f5;
    --td-pre-ink: #1a1a1a;
    --td-th-bg: #f0f0ee;
    --td-th-ink: #1a1a1a;
    --td-check: #1a1a1a;
    --td-font-display: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --td-h2-rule: transparent;
    --td-selection: #cfe0ff;
    --td-quote: #d9d8d3;
  }
  /* Default template ("Classic" = original tdoc look), all colors via tokens. */
  :where(body) {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 17px;
    line-height: 1.6;
    color: var(--td-ink);
    background: var(--td-ground);
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
  }
  :where(body h1) { font-family: var(--td-font-display); font-size: 38px; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 20px; color: var(--td-heading); }
  :where(body h2) { font-family: var(--td-font-display); font-size: 27px; line-height: 1.25; font-weight: 700; letter-spacing: -0.01em; margin: 44px 0 14px; color: var(--td-heading); padding-bottom: 6px; border-bottom: 1px solid var(--td-h2-rule); }
  :where(body h3) { font-family: var(--td-font-display); font-size: 21px; line-height: 1.35; font-weight: 700; margin: 32px 0 10px; color: var(--td-heading); }
  :where(body h4) { font-size: 17px; font-weight: 700; margin: 22px 0 6px; color: var(--td-heading); }
  :where(body h5, body h6) { font-size: 14px; font-weight: 600; margin: 16px 0 4px; color: var(--td-heading); text-transform: uppercase; letter-spacing: 0.06em; }
  :where(body p) { margin: 0 0 16px; }
  :where(body a) { color: var(--td-accent); text-decoration: underline; text-underline-offset: 2px; }
  :where(body a:hover) { text-decoration-thickness: 2px; }
  :where(body ul, body ol) { margin: 0 0 18px; padding-left: 26px; }
  :where(body li) { margin: 8px 0; }
  :where(body blockquote) { margin: 20px 0; padding: 2px 0 2px 20px; border-left: 3px solid var(--td-quote); color: var(--td-muted); }
  :where(body code) { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.88em; background: var(--td-surface); padding: 2px 6px; border-radius: 6px; }
  :where(body pre) { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 14.5px; line-height: 1.6; background: var(--td-surface-2); color: var(--td-pre-ink); border: 1px solid var(--td-line); border-radius: 10px; padding: 16px 18px; margin: 20px 0; overflow-x: auto; }
  :where(body pre code) { background: transparent; color: inherit; padding: 0; border-radius: 0; }
  :where(body hr) { border: 0; border-top: 1px solid var(--td-line); margin: 36px 0; }
  /* Tables: one bordered card, ruled inside, nothing filled. Every cell used to
     be a rounded tinted chip with a 3px gutter, which read as a pile of grey
     blocks rather than a grid — the gutters cut the columns apart so the eye
     had nothing to scan down, and four rounded corners per cell multiplied into
     noise on any real table. A hairline under each row does that work, and an
     outer border makes the table one object instead of a loose stack.
     border-spacing:0 with separate collapse, because border-radius on the table
     needs separate to round and overflow:hidden to clip.
     This is also what survives dark mode: that is a whole-page invert, and a
     filled cell inverts into a slab where a hairline just changes colour.
     No negative horizontal margin: that clips the first column inside any
     overflow-x:auto wrapper (author skill tells agents to wrap tables). */
  :where(body table) { border-collapse: separate; border-spacing: 0; width: 100%; margin: 6px 0 24px; font-size: 15.5px; font-variant-numeric: tabular-nums; border: 1px solid var(--td-line); border-radius: 12px; overflow: hidden; }
  :where(body th, body td) { padding: 14px 18px; background: none; border: 0; border-bottom: 1px solid var(--td-line); border-radius: 0; text-align: left; vertical-align: middle; line-height: 1.5; }
  :where(body th) { font-weight: 500; color: var(--td-muted); }
  :where(body tbody tr:last-child td) { border-bottom: 0; }
  :where(body figcaption) { font-size: 13px; color: var(--td-muted); margin-top: 6px; text-align: center; }
  :where(body) ::selection { background: var(--td-selection); }
  /* Task lists: circle checkboxes, Claude Code style. Works for raw
     <input type=checkbox> in lists and markdown-converted .task-list-item. */
  :where(body li:has(> input[type="checkbox"]), body li.task-list-item) { list-style: none; margin-left: -26px; }
  :where(body input[type="checkbox"]) {
    appearance: none; -webkit-appearance: none;
    width: 17px; height: 17px;
    border: 1.5px solid #c9c8c3; border-radius: 50%;
    vertical-align: -3px; margin: 0 8px 0 0;
    background: var(--td-ground); cursor: default;
  }
  :where(body input[type="checkbox"]:checked) {
    background: var(--td-check) center / 11px no-repeat url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M3 8.5l3.5 3.5L13 5" stroke="white" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    border-color: var(--td-check);
  }
  /* Doc imagery only — exclude overlay UI so icons inside the bar / chips /
     buttons / cards keep their inline layout instead of stacking to 16px tall. */
  :where(body img, body svg, body canvas, body video):not(.tdoc-bar *):not(.tdoc-margin-comment *):not(.tdoc-popup *):not(.tdoc-modal-bg *):not(.tdoc-chip *):not(.tdoc-fab *):not(.tdo *):not(.tds *):not(#tdoc-comment-layer *):not(#tdoc-pin-layer *):not(.tdoc-cluster-pop *):not(.tdoc-footer *) { display: block; margin: 16px auto; border-radius: 6px; overflow: visible; }
  /* Reading column INVARIANT (JUL-21): doc content is always a centered 720px
     column, wrapper or not. Two halves: (a) recognized wrappers get max-width
     AND margin:auto (previously margin was missing, so wrapped docs without
     their own margin rule sat left-aligned); (b) docs with no wrapper at all
     get the same column applied to body itself via :has(). :where() keeps both
     at zero specificity so a doc that truly wants full-bleed can override. */
  :where(body > .wrap, body > main, body > article, body > .content, body > .container) {
    max-width: 720px;
    margin-left: auto;
    margin-right: auto;
    padding: 56px 24px 80px;
    box-sizing: border-box;
  }
  :where(body:not(:has(> .wrap, > main, > article, > .content, > .container))) {
    max-width: 720px;
    margin-left: auto;
    margin-right: auto;
    padding: 56px 24px 80px;
    box-sizing: border-box;
  }
  /* End default template. ====================================================== */

  /* Defensive responsive defaults for artifacts. Docs sometimes hardcode pixel
     widths (e.g. <canvas width="640">) that overflow on phones. These rules
     constrain every artifact to its container width without changing its
     aspect ratio. Wrapped in :where() so the doc's own CSS wins if specified. */
  :where(body img, body video, body iframe, body svg, body canvas) {
    max-width: 100% !important;
    height: auto;
    box-sizing: border-box;
  }
  /* Canvas needs special handling: scaling its CSS size doesn't change its
     drawing-buffer size, but at least the box won't overflow. */
  :where(body canvas) { display: block; }
  /* Wide tables: keep TRUE table layout always — display:block on a table
     discards real table layout for anonymous-box fixup (uneven row heights).
     Scroll a wrapper instead of the table element. NOTE: no backticks in
     comments here — this CSS lives inside a JS template literal. */
  :where(body table) { max-width: 100%; }
  .tdoc-table-scroll { max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .tdoc-table-scroll > table { max-width: none; }
  /* Pre/code blocks scroll horizontally instead of breaking the layout. */
  :where(body pre) { max-width: 100%; overflow-x: auto; }
  @media print {
    .tdoc-bar, .tdoc-fab, .tdoc-footer, .tdoc-oldver-strip,
    #tdoc-comment-layer, #tdoc-pin-layer, .tdoc-cluster-pop,
    .tdoc-popup, .tdoc-modal-bg, .tdoc-hover-outline,
    .tdoc-comment-pill, .tdoc-drag-marquee, .tdoc-emoji-picker,
    .tdoc-reanchor-banner { display: none !important; }
    body { padding-top: 0 !important; padding-right: 0 !important; padding-left: 0 !important; }
    :where(body > .wrap, body > main, body > article, body > .content, body > .container) {
      padding-top: 24px;
    }
    @page { margin: 14mm; }
  }
  /* TDOC_READER_CSS_END */

  /* ========== Top bar ==========
     Two groups, Google Docs / Notion style: left (logo + crumb + title)
     and right (identity, primary CTA, more). The title is NOT viewport-
     centered — left and right chrome are different widths, so a flex
     "center" slot always looks off. Title truncates in the left group.
     No borders on individual buttons — hover background instead. */
  /* In document flow, not position:fixed: the bar occupies the top of the
     layout so page HTML cannot scroll underneath a floating strip. */
  .tdoc-bar { position: relative; width: 100%; height: 48px; box-sizing: border-box; background: #fff; color: #1a1a1a; display: flex; align-items: center; padding: 0 12px; font: 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; z-index: 999999; gap: 8px; border-bottom: 1px solid #e5e5e7; box-shadow: 0 1px 2px rgba(0,0,0,0.02); }
  .tdoc-bar-left { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1 1 auto; }
  .tdoc-bar-right { display: flex; align-items: center; gap: 4px; flex-shrink: 0; margin-left: auto; }

  /* Site mark — the tdoc logo (same asset as the favicon), not a text pill. */
  /* justify-content is required: the generic .tdoc-bar button rule supplies
     display:inline-flex + align-items:center but no horizontal centring, so a
     24px mark in a 32px padding-0 box sits flush left and the hover highlight
     lands 8px off to the right of the drawing. */
  .tdoc-bar button.tdoc-bar-mark { width: 32px; height: 32px; padding: 0; border-radius: 8px; background: transparent; justify-content: center; }
  .tdoc-bar-mark img { width: 24px; height: 24px; display: block; }
  .tdoc-bar .tdoc-github-btn { display: inline-flex; align-items: center; gap: 5px; height: 32px; padding: 0 9px; border-radius: 8px; color: #555; font: 600 12.5px/1 -apple-system, system-ui, sans-serif; }
  .tdoc-bar .tdoc-github-btn:hover { background: #f0f1f4; color: #1a1a1a; }
  .tdoc-bar .tdoc-github-btn svg { display: block; }
  .tdoc-bar .tdoc-gh-stars { display: inline-flex; align-items: center; gap: 3px; color: #444; }
  .tdoc-bar .tdoc-gh-stars svg { display: block; }

  /* Breadcrumb: workspace · slug · v3 — separated by " / ". */
  .tdoc-bar .crumb { color: #555; font-weight: 500; padding: 4px 6px; border-radius: 6px; max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tdoc-bar .crumb-sep { color: #c0c0c4; user-select: none; padding: 0 1px; }
  .tdoc-bar .doc-title { color: #1a1a1a; font-weight: 600; font-size: 14px; min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Default action button — icon and/or label, no border, hover bg only. */
  .tdoc-bar button { background: transparent; border: none; color: #555; padding: 6px 8px; border-radius: 6px; font: inherit; cursor: pointer; transition: background .12s, color .12s; display: inline-flex; align-items: center; gap: 6px; }
  .tdoc-bar button:hover { background: #f0f1f4; color: #1a1a1a; }
  .tdoc-bar button:disabled { opacity: 0.5; cursor: not-allowed; }
  .tdoc-bar button svg { flex-shrink: 0; }

  /* Primary CTA (Share / Publish) — filled blue button at the right. */
  .tdoc-bar button.primary { background: var(--td-accent); color: #fff; padding: 7px 14px; font-weight: 600; }
  .tdoc-bar button.primary:hover { background: var(--td-accent-hover); color: #fff; }

  /* Version picker chip — pill in the left breadcrumb. */
  .tdoc-version-wrap { position: relative; display: inline-block; flex-shrink: 0; }
  .tdoc-version-toggle { background: #f0f1f4 !important; color: #1a1a1a !important; padding: 3px 10px !important; border-radius: 999px !important; font: 12px ui-monospace, "SF Mono", Menlo, monospace !important; }
  .tdoc-version-toggle:hover { background: #e5e6ea !important; }

  /* Dropdown menus — light surface to match the bar. */
  .tdoc-menu, .tdoc-secondary-menu, .tdoc-version-menu { display: none; position: absolute; background: #fff; border: 1px solid #e5e5e7; border-radius: 8px; padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,0.12); z-index: 1000000; min-width: 160px; }
  .tdoc-version-menu { top: calc(100% + 6px); left: 0; max-height: 60vh; overflow-y: auto; }
  .tdoc-menu { top: calc(100% + 6px); right: 0; min-width: 180px; }
  .tdoc-secondary-menu { top: calc(100% + 6px); right: 0; }
  .tdoc-menu.open, .tdoc-secondary-menu.open, .tdoc-version-menu.open { display: block; }
  .tdoc-menu button, .tdoc-secondary-menu button, .tdoc-version-menu button { display: block; width: 100%; text-align: left; padding: 7px 10px; border-radius: 4px; color: #1a1a1a; font: 13px system-ui, sans-serif; }
  .tdoc-version-menu button { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .tdoc-menu button:hover, .tdoc-secondary-menu button:hover, .tdoc-version-menu button:hover { background: #f0f1f4; }
  .tdoc-secondary-menu button.tdoc-sec-danger { color: var(--td-danger); }
  .tdoc-secondary-menu button.tdoc-sec-danger:hover { background: var(--td-danger); color: #fff; }
  .tdoc-version-menu button.current { color: var(--td-accent); font-weight: 600; }

  /* Version switcher folded into the ⋯ overflow menu. The inline version chip
     is hidden at <700px (phones), so surface the same list here — otherwise
     there is no way to switch versions on a phone. Shown only at that width;
     wider layouts keep the inline chip. */
  .tdoc-secondary-menu .tdoc-sec-versions { display: none; }
  @media (max-width: 700px) { .tdoc-secondary-menu .tdoc-sec-versions { display: block; } }
  .tdoc-secondary-menu .tdoc-sec-label { padding: 6px 10px 2px; font: 600 11px system-ui, sans-serif; color: #8a8a8a; text-transform: uppercase; letter-spacing: .04em; }
  .tdoc-secondary-menu .tdoc-sec-version { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .tdoc-secondary-menu .tdoc-sec-version.current { color: var(--td-accent); font-weight: 600; }
  .tdoc-secondary-menu .tdoc-sec-sep { border-top: 1px solid #eee; margin: 4px 6px; }

  .tdoc-menu-wrap { position: relative; display: inline-block; }
  /* ⋯ overflow is the single home for secondary actions (Copy / Duplicate /
     Download) at every width. Their inline bar buttons stay in the DOM for the
     #146 chrome contract but never render — the ⋯ menu drives them. */
  .tdoc-bar .tdoc-secondary-toggle { display: inline-flex; padding: 6px 10px; }
  .tdoc-bar #tdoc-duplicate-btn, .tdoc-bar #tdoc-download-wrap, .tdoc-bar #tdoc-saveas-btn { display: none; }
  /* Identity chip — avatar + name (name hides on narrow). */
  .tdoc-chip { display: inline-flex; align-items: center; gap: 8px; padding: 3px 12px 3px 3px; background: #f0f1f4; border-radius: 999px; cursor: pointer; color: #1a1a1a; font: inherit; border: none; position: relative; }
  .tdoc-chip:hover { background: #e5e6ea; }
  .tdoc-chip img { width: 26px; height: 26px; border-radius: 50%; }
  .tdoc-chip .name { font-size: 13px; font-weight: 500; }
  .tdoc-chip.signin { padding: 7px 14px; background: var(--td-accent); color: #fff; font-weight: 600; }
  .tdoc-chip.signin:hover { background: var(--td-accent-hover); }
  /* Only new inbox chrome: a red dot on the existing identity chip. */
  .tdoc-unread-dot { position: absolute; top: 1px; right: 1px; width: 8px; height: 8px; border-radius: 50%; background: #e11d48; border: 1.5px solid #fff; pointer-events: none; }
  /* Inbox rows reuse cluster-row: action + preview stacked, relative time on the right. */
  #tdoc-inbox-list .tdoc-cluster-row > .muted { flex-shrink: 0; white-space: nowrap; font-size: 12px; }

  /* Comment cards */
  #tdoc-comment-layer { position: absolute; top: 0; left: 0; width: 100%; pointer-events: none; z-index: 999996; }
  .tdoc-margin-comment { position: absolute; width: 280px; background: #fff; border: 1px solid #e5e5e5; border-radius: 10px; padding: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); font: 13px system-ui, sans-serif; transition: box-shadow .15s, transform .15s; z-index: 999996; pointer-events: auto; }
  .tdoc-margin-comment.active { box-shadow: 0 4px 16px var(--td-accent-ring-soft); border-color: var(--td-accent); }
  .tdoc-margin-comment.tdoc-unanchored { border-style: dashed; }
  /* A resolved (agent-applied) comment whose anchor text was rewritten is the
     EXPECTED outcome, not an error — don't alarm with the dashed "lost" look or
     push the re-anchor affordance. Keep it solid and quiet. */
  .tdoc-margin-comment.tdoc-resolved.tdoc-unanchored { border-style: solid; }
  .tdoc-margin-comment.tdoc-resolved.tdoc-unanchored .tdoc-reanchor-btn { display: none; }
  /* Parent-level resolved chip (distinct from the per-reply status chip). */
  .tdoc-resolved-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; margin: 0 0 8px; background: #e8f5ed; color: #1a7340; }
  .tdoc-reanchor-btn { display: none; font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 6px; cursor: pointer; background: none; border: none; padding: 0; text-align: left; }
  .tdoc-margin-comment.tdoc-unanchored .tdoc-reanchor-btn { display: block; }
  /* Anchored cards also expose a "move anchor" action when they're active. */
  .tdoc-margin-comment.active .tdoc-reanchor-btn { display: block; }
  .tdoc-reanchor-btn:hover { color: var(--td-accent); }
  /* Label swap: "unanchored" wording on unanchored cards, "move anchor" on
     active anchored cards. */
  .tdoc-reanchor-btn .tdoc-reanchor-unanchored,
  .tdoc-reanchor-btn .tdoc-reanchor-anchored { display: none; }
  .tdoc-margin-comment.tdoc-unanchored .tdoc-reanchor-btn .tdoc-reanchor-unanchored { display: inline; }
  .tdoc-margin-comment:not(.tdoc-unanchored).active .tdoc-reanchor-btn .tdoc-reanchor-anchored { display: inline; }
  /* Container for the anchor action buttons. */
  .tdoc-anchor-actions { display: flex; gap: 12px; align-items: center; margin: 0 0 6px; }
  /* While re-anchor mode is active, dim the rest of the UI and prompt the
     user to select. */
  /* Re-anchor banner: pinned below the bar with three actions. Visible
     only while body.tdoc-reanchoring is set. */
  .tdoc-reanchor-banner { display: none; position: fixed; top: 56px; left: 50%; transform: translateX(-50%); background: var(--td-accent); color: #fff; padding: 6px 10px 6px 14px; border-radius: 999px; font: 12px system-ui; z-index: 999999; align-items: center; gap: 6px; box-shadow: 0 4px 16px var(--td-accent-ring); }
  body.tdoc-reanchoring .tdoc-reanchor-banner { display: inline-flex; }
  .tdoc-reanchor-banner .label { padding: 0 4px; }
  .tdoc-reanchor-banner button { background: rgba(255,255,255,0.15); border: none; color: #fff; padding: 4px 10px; border-radius: 999px; font: 12px system-ui; cursor: pointer; }
  .tdoc-reanchor-banner button:hover { background: rgba(255,255,255,0.28); }
  .tdoc-reanchor-banner button.danger { background: rgba(255,255,255,0.15); }
  .tdoc-reanchor-banner button.danger:hover { background: #c33; }
  /* Old-version strip — a thin, quiet bar just under the top bar shown when
     the viewer is on a non-latest version. Single-direction nudge: it only
     points forward to the latest version. Hidden by default; the bar-setup
     code reveals it only when version < latest. In flow under the top bar. */
  .tdoc-oldver-strip { display: none; position: relative; width: 100%; height: 28px; box-sizing: border-box; background: #fbf6e9; color: #6b5e3a; border-bottom: 1px solid #efe6cd; font: 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; align-items: center; justify-content: center; gap: 6px; z-index: 999998; padding: 0 12px; }
  body.tdoc-has-oldver-strip .tdoc-oldver-strip { display: flex; }
  .tdoc-oldver-strip a { color: #8a6d1f; font-weight: 600; text-decoration: none; border-bottom: 1px solid currentColor; }
  .tdoc-oldver-strip a:hover { color: #6b5413; }
  /* Ghost marker — a faint horizontal line at the unanchored comment's
     original Y position, so the user can see where the deleted text used
     to be. Stays in document coordinates. */
  .tdoc-ghost-marker { position: absolute; left: 0; right: 320px; height: 0; border-top: 1px dashed #d4d4d4; pointer-events: none; z-index: 999990; }
  body.tdoc-narrow .tdoc-ghost-marker { display: none; }
  .tdoc-margin-comment .author { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .tdoc-margin-comment .author img { width: 24px; height: 24px; border-radius: 50%; }
  .tdoc-margin-comment .author .login { font-weight: 600; color: #111; font-size: 13px; }
  .tdoc-margin-comment .author .anon { color: #888; font-style: italic; }
  /* Agent identity — runtime logo when we know the host (Grok / Claude /
     Codex / …), otherwise the tdoc project mark. Status chips still carry
     applied / partial / question. */
  .tdoc-agent-badge { display: inline-flex; width: 24px; height: 24px; border-radius: 50%; background: #f2f2f2; flex-shrink: 0; }
  .tdoc-agent-author img { width: 24px; height: 24px; border-radius: 50%; object-fit: contain; background: #fff; flex-shrink: 0; }
  .tdoc-agent-reply { background: #fafafb; border-left: 3px solid #111; padding-left: 8px; }
  .tdoc-agent-status { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px; margin: 0 0 6px; font-weight: 600; }
  .tdoc-agent-status-applied { background: #e8f5ed; color: #1a7340; }
  .tdoc-agent-status-partial { background: #fff4dc; color: #8a5a00; }
  .tdoc-agent-status-question { background: #ffe7e7; color: #a52323; }
  .tdoc-margin-comment .text { color: #111; line-height: 1.45; word-wrap: break-word; }
  .tdoc-margin-comment .meta { font-size: 11px; color: #888; margin-top: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .tdoc-margin-comment .meta > span:first-child { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tdoc-margin-comment .del { cursor: pointer; color: #c33; }
  .tdoc-margin-comment .del:hover { text-decoration: underline; }
  .tdoc-margin-comment .actions { display: inline-flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .tdoc-margin-comment .copy-md { cursor: pointer; color: #888; display: inline-flex; align-items: center; }
  .tdoc-margin-comment .copy-md:hover { color: var(--td-accent); }
  .tdoc-margin-comment .copy-md svg { width: 14px; height: 14px; display: block; }
  .tdoc-margin-comment .tdoc-reply-toggle { cursor: pointer; color: var(--td-accent); }
  .tdoc-margin-comment .tdoc-reply-toggle:hover { text-decoration: underline; }

  /* ===== Pins model (wide mode only) =====
     In wide mode the right gutter shows one PIN per comment (or a count badge
     for a cluster of same-Y pins) instead of a stack of full cards. The full
     card floats open on hover and stays open ("pinned") on click. This makes
     the margin overflow-proof: it only ever holds markers, never a tall column
     of cards. Narrow mode is untouched (cards flow in the bottom drawer). */
  #tdoc-pin-layer { position: absolute; top: 0; left: 0; width: 100%; height: 0; pointer-events: none; z-index: 999996; }
  body.tdoc-narrow #tdoc-pin-layer { display: none; }
  /* When the pins model is active, hide every card by default; only the
     hovered/pinned card is shown (it gets .tdoc-floating-open). */
  body.tdoc-pins:not(.tdoc-narrow) .tdoc-margin-comment { display: none; }
  body.tdoc-pins:not(.tdoc-narrow) .tdoc-margin-comment.tdoc-floating-open { display: block; }

  .tdoc-pin { position: absolute; pointer-events: auto; cursor: pointer; width: 28px; height: 28px; border-radius: 50%; background: #fff; border: 2px solid #cdd3dc; box-shadow: 0 1px 3px rgba(0,0,0,0.12); display: flex; align-items: center; justify-content: center; transition: transform .12s, border-color .12s, box-shadow .12s; box-sizing: border-box; }
  .tdoc-pin:hover, .tdoc-pin.tdoc-pin-active { transform: scale(1.12); border-color: var(--td-accent); box-shadow: 0 2px 8px var(--td-accent-ring-soft); z-index: 1; }
  .tdoc-pin img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }
  .tdoc-pin .tdoc-pin-anon { width: 100%; height: 100%; border-radius: 50%; background: #8a93a2; }
  /* Resolved pins get a green ring + a small ✓ overlay badge. */
  .tdoc-pin.tdoc-pin-resolved { border-color: #1a7340; }
  .tdoc-pin.tdoc-pin-resolved::after { content: "✓"; position: absolute; right: -3px; bottom: -3px; width: 14px; height: 14px; border-radius: 50%; background: #1a7340; color: #fff; font-size: 9px; line-height: 14px; text-align: center; font-weight: 700; }
  /* Cluster badge — N comments at the same Y collapsed into one marker. */
  .tdoc-pin.tdoc-pin-cluster { background: var(--td-accent); border-color: var(--td-accent); color: #fff; font: 600 12px system-ui; }
  .tdoc-pin.tdoc-pin-cluster.tdoc-cluster-allresolved { background: #1a7340; border-color: #1a7340; }
  .tdoc-pin.tdoc-pin-cluster::after { content: none; }

  /* Floating card: when open via a pin, it sits to the left of the gutter and
     is allowed to scroll internally so even a long thread can't overflow. */
  body.tdoc-pins:not(.tdoc-narrow) .tdoc-margin-comment.tdoc-floating-open { max-height: 70vh; overflow-y: auto; box-shadow: 0 6px 24px rgba(0,0,0,0.16); }

  /* Cluster popover: a compact list of the comments under a badge. Click one
     to open its full card. */
  .tdoc-cluster-pop { position: absolute; pointer-events: auto; width: 260px; max-height: 60vh; overflow-y: auto; background: #fff; border: 1px solid #e5e5e5; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,0.16); padding: 6px; z-index: 999997; font: 13px system-ui; display: none; }
  .tdoc-cluster-row.tdoc-cluster-current { background: #eef2ff; }
  .tdoc-cluster-pop.open { display: block; }
  .tdoc-cluster-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
  .tdoc-cluster-row:hover { background: #f5f6f8; }
  .tdoc-cluster-row img { width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0; }
  .tdoc-cluster-row .tdoc-cluster-anon { width: 20px; height: 20px; border-radius: 50%; background: #8a93a2; flex-shrink: 0; }
  .tdoc-cluster-row .tdoc-cluster-snip { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #333; }
  .tdoc-cluster-row .tdoc-cluster-done { color: #1a7340; font-size: 11px; flex-shrink: 0; }

  /* Reactions + emoji picker */
  .tdoc-reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; align-items: center; }
  .tdoc-react-chip { position: relative; display: inline-flex; align-items: center; gap: 4px; font: 12px system-ui; background: #f5f6f8; border: 1px solid #e5e5e5; border-radius: 999px; padding: 2px 8px; cursor: pointer; color: #333; transition: background .12s, border-color .12s; }
  .tdoc-react-chip:hover { background: #eef0f3; }
  .tdoc-react-chip.mine { background: var(--td-accent-tint); border-color: var(--td-accent); color: var(--td-accent); }
  /* Agent reactions get a tinted background so users can scan a long doc
     and spot which comments the agent has already responded to. */
  .tdoc-react-chip.agent { background: #f3eaff; border-color: #c3a8f0; color: #5a2da8; }
  .tdoc-react-chip.agent.mine { background: #f3eaff; border-color: #c3a8f0; color: #5a2da8; }
  /* Reactors tooltip — shows the GitHub logins (or agent labels) of everyone
     who used this emoji. Rendered as a BODY-LEVEL element (not a ::after on the
     chip) so it escapes the floating card's overflow:auto clip and can be
     clamped to the viewport — a ::after centered on a chip near the card's left
     edge was truncated. Positioned by JS on hover. */
  #tdoc-reactors-tip {
    position: absolute;
    display: none;
    background: #111;
    color: #fff;
    padding: 4px 8px;
    border-radius: 6px;
    font: 11px/1.4 system-ui;
    white-space: pre;
    max-width: 260px;
    pointer-events: none;
    z-index: 1000000;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
  }
  #tdoc-reactors-tip.open { display: block; }
  .tdoc-react-add { background: transparent; border: none; color: #aaa; padding: 0; cursor: pointer; line-height: 1; transition: color .12s, opacity .12s; display: inline-flex; align-items: center; }
  .tdoc-react-add svg { width: 16px; height: 16px; display: block; }
  .tdoc-reactions .tdoc-react-add { opacity: 0; padding: 2px 4px; }
  .tdoc-margin-comment:hover .tdoc-reactions .tdoc-react-add, .tdoc-reply:hover .tdoc-reactions .tdoc-react-add, .tdoc-reactions:has(.tdoc-react-chip) .tdoc-react-add { opacity: 1; }
  .tdoc-react-add.inline svg { width: 14px; height: 14px; }
  .tdoc-react-add.inline { opacity: 0.55; vertical-align: middle; }
  .tdoc-react-add:hover { color: var(--td-accent); opacity: 1; }
  .tdoc-emoji-picker { position: absolute; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 6px; display: grid; grid-template-columns: repeat(6, 32px); gap: 2px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); z-index: 1000001; }
  .tdoc-emoji-picker button { background: transparent; border: none; padding: 0; cursor: pointer; border-radius: 4px; width: 32px; height: 32px; font-size: 18px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
  .tdoc-emoji-picker button:hover { background: #f5f6f8; }
  .tdoc-emoji-picker button.tdoc-emoji-text { grid-column: span 6; height: auto; padding: 6px 8px; font-size: 12px; font-weight: 600; color: var(--td-accent); }
  .tdoc-emoji-picker button.tdoc-emoji-text:hover { background: var(--td-accent-tint); }

  /* Replies + reply form */
  .tdoc-replies-toggle { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #eee; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font-size: 12px; color: var(--td-accent); user-select: none; }
  .tdoc-replies-toggle:hover { text-decoration: underline; }
  .tdoc-replies-toggle .chev { transition: transform .15s; }
  .tdoc-replies-toggle.open .chev { transform: rotate(90deg); }
  .tdoc-replies { display: none; flex-direction: column; gap: 10px; margin-top: 10px; }
  .tdoc-replies.open { display: flex; }
  .tdoc-reply { padding-left: 12px; border-left: 2px solid #e5e5e5; }
  .tdoc-reply-kids { margin: 8px 0 0 10px; display: flex; flex-direction: column; gap: 10px; }
  .tdoc-reply .tdoc-reply-toggle { cursor: pointer; color: var(--td-accent); font-size: 11px; }
  .tdoc-reply .tdoc-reply-toggle:hover { text-decoration: underline; }
  .tdoc-reply-to { color: #888; font-weight: 500; font-size: 11px; margin: 0 0 4px; }
  .tdoc-reply .author { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .tdoc-reply .author img { width: 18px; height: 18px; border-radius: 50%; }
  .tdoc-reply .author .login { font-weight: 600; font-size: 12px; color: #111; }
  .tdoc-reply .author .anon { color: #888; font-style: italic; font-size: 12px; }
  .tdoc-reply .text { color: #222; font-size: 13px; line-height: 1.4; word-wrap: break-word; }
  .tdoc-reply .meta { font-size: 11px; color: #888; margin-top: 4px; display: flex; justify-content: space-between; }
  .tdoc-reply .del { cursor: pointer; color: #c33; }
  .tdoc-reply .del:hover { text-decoration: underline; }
  .tdoc-reply-form { display: none; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #eee; }
  .tdoc-reply-form.open { display: block; }
  .tdoc-reply-form textarea { width: 100%; min-height: 48px; box-sizing: border-box; padding: 6px 8px; font: 13px system-ui; border: 1px solid #ccc; border-radius: 6px; resize: vertical; outline: none; }
  .tdoc-reply-form textarea:focus { border-color: var(--td-accent); }
  .tdoc-reply-form-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
  .tdoc-reply-form-foot .hint { color: #888; font-size: 11px; }
  .tdoc-reply-form-foot .tdoc-reply-submit { background: var(--td-accent); color: #fff; border: none; border-radius: 6px; padding: 5px 12px; font: 12px system-ui; cursor: pointer; }
  .tdoc-reply-form-foot .tdoc-reply-submit:hover { background: var(--td-accent-hover); }

  /* Anchor highlights (Custom Highlight API + fallback span) */
  ::highlight(tdoc-pending) { background-color: #fff3a8; }
  ::highlight(tdoc-anchor) { background-color: #fff7d0; }
  /* Active = clicked. Visibly different from resting: vivid yellow + thick
     gold underline. (The CSS Highlight API only supports background-color,
     color, and text-decoration — so we stack those.) */
  ::highlight(tdoc-anchor-active) {
    background-color: #ffd84d;
    text-decoration: underline solid #b8860b;
    text-decoration-thickness: 3px;
    text-underline-offset: 2px;
  }
  .tdoc-anchor-mark { background: #fff7d0; cursor: pointer; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  .tdoc-anchor-mark:hover { background: #fdedb0; }
  .tdoc-anchor-mark.active { background: #ffd84d; box-shadow: 0 -3px 0 -1px #b8860b inset; }

  /* Element outlines + hover affordance */
  .tdoc-element-outline { position: absolute; pointer-events: none; border: 1.5px solid var(--td-accent-ring); border-radius: 4px; box-sizing: border-box; z-index: 999995; transition: border-color .15s, box-shadow .15s, border-width .15s; }
  .tdoc-element-outline.pending { border-color: #f0d000; border-width: 2px; background: transparent; }
  .tdoc-element-outline.active { border-color: var(--td-accent); border-width: 2px; box-shadow: 0 0 0 4px var(--td-accent-ring-soft); }
  .tdoc-hover-outline { position: absolute; pointer-events: none; z-index: 999995; border: 2px dashed var(--td-accent); border-radius: 4px; background: var(--td-accent-wash); box-sizing: border-box; transition: opacity .12s; }
  /* Icon-only button that appears on commentable artifacts (img/canvas/svg/video/pre).
     Positioned just outside the artifact's right edge so it can't obscure
     content. Uses !important on the visible colors to defend against doc-side
     button:hover rules that would otherwise repaint our background. */
  .tdoc-comment-pill {
    position: absolute !important; z-index: 999998 !important;
    width: 30px !important; height: 30px !important; padding: 0 !important;
    background: rgba(255,255,255,0.96) !important; color: var(--td-accent) !important;
    border: 1px solid #dedee3 !important; border-radius: 999px !important;
    cursor: pointer !important;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 3px 10px rgba(0,0,0,0.08) !important;
    display: inline-flex !important; align-items: center !important; justify-content: center !important;
    transition: transform .12s, background-color .12s, border-color .12s, color .12s, box-shadow .12s !important;
    line-height: 1 !important;
    text-decoration: none !important;
    visibility: visible !important;
  }
  .tdoc-comment-pill:hover {
    background: var(--td-accent) !important; color: #fff !important;
    border-color: var(--td-accent) !important;
    transform: translateY(-1px) !important;
    box-shadow: 0 2px 4px rgba(0,0,0,0.08), 0 8px 22px var(--td-accent-ring-soft) !important;
  }
  .tdoc-comment-pill:active { background: var(--td-accent-hover) !important; transform: translateY(0) !important; }
  .tdoc-comment-pill svg { width: 14px !important; height: 14px !important; flex-shrink: 0 !important; stroke: currentColor !important; margin: 0 !important; }
  .tdoc-comment-pill:hover svg { stroke: #fff !important; }
  .tdoc-drag-marquee { position: absolute; pointer-events: none; z-index: 999997; border: 1.5px solid var(--td-accent); background: var(--td-accent-wash); box-sizing: border-box; }

  /* Popup (new-comment) */
  .tdoc-popup { position: absolute; background: #0a0a0a; color: #fff; border-radius: 10px; padding: 14px; width: 320px; box-shadow: 0 12px 40px rgba(0,0,0,0.4); z-index: 999998; font: 13px system-ui, sans-serif; }
  .tdoc-popup .head { display: flex; justify-content: space-between; margin-bottom: 8px; }
  .tdoc-popup .head .h { color: #aaa; }
  .tdoc-popup .head .x { cursor: pointer; color: #888; }
  .tdoc-popup textarea { width: 100%; min-height: 64px; background: transparent; color: #fff; border: 1px solid var(--td-accent); border-radius: 6px; padding: 8px; font: inherit; resize: vertical; box-sizing: border-box; outline: none; }
  .tdoc-popup .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
  .tdoc-popup .hint { color: #888; font-size: 11px; }
  .tdoc-popup .submit { background: var(--td-accent); border: none; color: #fff; padding: 6px 14px; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 500; }
  .tdoc-popup .submit:hover { background: var(--td-accent-hover); }
  .tdoc-popup .signin-needed { color: #f5a623; font-size: 12px; padding: 8px 0; }

  /* Modal (sign-in) */
  .tdoc-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 1000000; display: flex; align-items: center; justify-content: center; font: 14px system-ui, sans-serif; }
  .tdoc-modal { background: #fff; color: #111; border-radius: 12px; padding: 28px; width: min(460px, calc(100vw - 48px)); box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
  .tdoc-modal h3 { margin: 0 0 8px; font-size: 20px; }
  .tdoc-modal p { margin: 0 0 14px; color: #444; line-height: 1.5; }
  .tdoc-modal .code { background: #0a0a0a; color: #fff; padding: 18px; border-radius: 8px; font: 24px ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.15em; text-align: center; margin: 0 0 14px; user-select: all; cursor: copy; }
  .tdoc-modal .step { display: flex; gap: 10px; margin-bottom: 8px; color: #444; }
  .tdoc-modal .step .n { width: 22px; height: 22px; border-radius: 50%; background: var(--td-accent); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; flex-shrink: 0; }
  .tdoc-modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .tdoc-modal button { padding: 8px 16px; border-radius: 6px; font: inherit; cursor: pointer; border: 1px solid #ccc; background: #fff; }
  .tdoc-modal button.primary { background: var(--td-accent); border-color: var(--td-accent); color: #fff; }
  .tdoc-modal button.primary:hover { background: var(--td-accent-hover); }
  .tdoc-modal .status { color: #888; font-size: 13px; }
  /* Modal helper classes used by Publish/Share so dark-mode can override. */
  .tdoc-modal .muted { color: #666; font-size: 13px; }
  .tdoc-modal .divider { border-top: 1px solid #eee; padding-top: 12px; margin-top: 12px; }
  .tdoc-modal .danger { color: #c33; font-size: 13px; }
  .tdoc-modal code { background: #f5f6f8; padding: 1px 5px; border-radius: 3px; }

  /* Share panel (copy link for everyone; owners also get visibility/history/
     commenting/allowed_users + Delete/Unpublish — session-authorized). */
  .tdoc-modal .manage-section { margin: 16px 0; }
  .tdoc-modal .manage-section:first-of-type { margin-top: 4px; }
  .tdoc-modal label.field { display: block; font-size: 12px; color: #666; margin: 0 0 4px; font-weight: 600; }
  .tdoc-modal input[type="password"], .tdoc-modal input[type="text"] { width: 100%; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; padding: 8px 10px; font: inherit; }
  .tdoc-modal input[type="password"]:focus, .tdoc-modal input[type="text"]:focus { outline: none; border-color: var(--td-accent); }
  .tdoc-seg { display: inline-flex; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; flex-wrap: wrap; }
  .tdoc-seg button { border: none; border-radius: 0; padding: 7px 14px; background: #fff; color: #444; }
  .tdoc-seg button + button { border-left: 1px solid #ddd; }
  .tdoc-seg button.active { background: var(--td-accent); color: #fff; }
  .tdoc-modal .manage-hint { font-size: 12px; color: #888; margin: 6px 0 0; }
  .tdoc-modal .manage-action { width: 100%; text-align: left; }
  .tdoc-modal .manage-action.danger-btn { color: var(--td-danger); border-color: #f1b8b2; }
  .tdoc-modal .manage-action.danger-btn:hover { background: var(--td-danger); color: #fff; border-color: var(--td-danger); }
  .tdoc-modal button.danger { background: var(--td-danger); border-color: var(--td-danger); color: #fff; }
  .tdoc-modal button.danger:hover { background: var(--td-danger-hover); border-color: var(--td-danger-hover); }
  /* Allowed-users token field: chips (avatar + login + remove) plus a live
     GitHub handle autocomplete. Candidate search and avatar validation hit
     GitHub straight from the owner's browser (their IP, their ~10 req/min
     budget) — no server proxy, no API key. The doc CSP (worker cspHeader)
     restricts only script/object/base-uri, so these fetches + <img>s pass. */
  .tdoc-token-field { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; border: 1px solid #ccc; border-radius: 6px; padding: 6px; box-sizing: border-box; cursor: text; }
  .tdoc-token-field.focus { border-color: var(--td-accent); }
  .tdoc-token-field input[type="text"] { flex: 1 1 120px; min-width: 90px; width: auto; border: none; padding: 3px 4px; }
  .tdoc-token-field input[type="text"]:focus { border: none; outline: none; }
  .tdoc-token { display: inline-flex; align-items: center; gap: 6px; background: #f2f4f7; border: 1px solid #e2e6ea; border-radius: 999px; padding: 2px 4px 2px 2px; font-size: 13px; line-height: 1.4; }
  .tdoc-token.invalid { background: #fdeceb; border-color: #f1b8b2; color: var(--td-danger); }
  .tdoc-token img, .tdoc-token .mark { width: 18px; height: 18px; border-radius: 50%; object-fit: cover; background: #ddd; flex: none; }
  .tdoc-token .mark { display: inline-flex; align-items: center; justify-content: center; font-size: 11px; background: #f1b8b2; color: #fff; }
  .tdoc-token .rm { cursor: pointer; color: #999; font-size: 15px; padding: 0 3px; }
  .tdoc-token .rm:hover { color: var(--td-danger); }
  .tdoc-ac { position: relative; }
  .tdoc-ac-list { position: absolute; left: 0; right: 0; top: 2px; z-index: 10; background: #fff; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.12); max-height: 240px; overflow-y: auto; }
  .tdoc-ac-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; }
  .tdoc-ac-item:hover, .tdoc-ac-item.active { background: #f2f4f7; }
  .tdoc-ac-item img { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; background: #ddd; flex: none; }
  .tdoc-ac-item .login { font-size: 13px; font-weight: 600; color: #222; }
  /* Simplified Share panel: one plain-language access dropdown, an Advanced
     disclosure for the secondary axes, and a de-emphasised danger row. */
  .tdoc-modal .tdoc-select { width: 100%; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; padding: 8px 32px 8px 10px; font: inherit; color: inherit; cursor: pointer; appearance: none; -webkit-appearance: none; -moz-appearance: none; background-color: #fff; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5L6 8l3.5-3.5' fill='none' stroke='%23666' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 11px center; background-size: 12px; }
  .tdoc-modal .tdoc-select:focus { outline: none; border-color: var(--td-accent); }
  .tdoc-modal .tdoc-adv { margin: 16px 0 0; border-top: 1px solid #eee; padding-top: 6px; }
  .tdoc-modal .tdoc-adv > summary { cursor: pointer; font-size: 13px; font-weight: 600; color: #555; padding: 6px 0; }
  .tdoc-modal .tdoc-adv > summary:hover { color: #222; }

  /* Bar collapse breakpoints — tied to viewport width, not layout class.
     The bar progressively hides elements as the viewport tightens, so it
     stays elegant at every size.
       ≥1100px: logo · slug · v · title ……………… identity · share · ⋯
       <1100px: logo ·      · v · title ……………… identity · share · ⋯  (slug hides)
       < 900px: logo ·      · v · title ……………… avatar   · share · ⋯  (name hides)
       < 700px: logo ·          title ………………            share · ⋯  (version+identity into ⋯) */
  @media (max-width: 1100px) {
    .tdoc-bar .crumb-slug, .tdoc-bar .crumb-sep-slug { display: none; }
  }
  @media (max-width: 900px) {
    .tdoc-chip .name { display: none; }
    .tdoc-chip { padding: 3px; }
  }
  @media (max-width: 700px) {
    .tdoc-bar { padding: 0 8px; gap: 4px; }
    .tdoc-version-wrap { display: none; }
    .tdoc-bar .doc-title { font-size: 13px; }
    /* Small screens: the primary CTA collapses to just its icon (label is kept
       in title/aria-label). Keeps the phone bar to a compact icon + ⋯. */
    .tdoc-bar #tdoc-publish-btn span, .tdoc-bar #tdoc-share-btn span { display: none; }
    .tdoc-bar #tdoc-publish-btn, .tdoc-bar #tdoc-share-btn { padding: 7px 9px; }
  }

  /* Narrow mode (drawer + FAB) — still driven by the layout evaluator so
     it can also kick in when the comment column would crowd the article. */
  body.tdoc-narrow #tdoc-comment-layer { position: fixed; top: auto; left: 0; right: 0; bottom: 0; max-height: 70vh; width: 100%; pointer-events: auto; background: #fff; border-top: 1px solid #e5e5e5; box-shadow: 0 -4px 24px rgba(0,0,0,0.08); transform: translateY(100%); transition: transform .2s; overflow-y: auto; padding: 12px 12px 24px; box-sizing: border-box; z-index: 999998; }
  body.tdoc-narrow #tdoc-comment-layer.open { transform: translateY(0); }
  /* Backdrop scrim behind the mobile drawer. A dedicated element is what makes
     tap-to-dismiss reliable: iOS Safari won't synthesize a click for a tap on
     plain body text, so the document-level "close on outside click" never fires
     there — but a real element with its own listener does. It also dims the doc
     so the "tap anywhere out here to close" affordance is visible without a drag.
     Sibling combinator keeps visibility purely CSS-driven off the drawer's
     .open class, so every open/close path (fab, handle, drag, resize) stays in
     sync with no extra JS. */
  #tdoc-drawer-scrim { display: none; }
  body.tdoc-narrow #tdoc-comment-layer.open ~ #tdoc-drawer-scrim { display: block; position: fixed; inset: 0; z-index: 999997; background: rgba(0,0,0,0.28); -webkit-tap-highlight-color: transparent; }
  body.tdoc-narrow #tdoc-comment-layer .tdoc-drawer-handle { display: block; width: 36px; height: 4px; background: #ccc; border-radius: 2px; margin: 0 auto 12px; cursor: grab; touch-action: none; user-select: none; }
  body.tdoc-narrow #tdoc-comment-layer .tdoc-drawer-handle:active { cursor: grabbing; }
  body.tdoc-narrow .tdoc-margin-comment { position: static !important; width: auto !important; left: auto !important; top: auto !important; margin-bottom: 10px; transform: none !important; }
  body.tdoc-narrow .tdoc-fab { position: fixed; bottom: 16px; right: 16px; z-index: 999997; background: var(--td-accent); color: #fff; border: none; border-radius: 999px; padding: 10px 16px; font: 13px system-ui; font-weight: 600; box-shadow: 0 4px 16px var(--td-accent-ring); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  body.tdoc-narrow .tdoc-fab:active { transform: scale(0.96); }
  body.tdoc-narrow .tdoc-popup { width: calc(100vw - 24px); max-width: 320px; left: 12px !important; }
  body.tdoc-narrow .tdoc-modal { padding: 20px; }
  body.tdoc-narrow .tdoc-modal .code { font-size: 20px; }
  body.tdoc-narrow .tdoc-hover-outline, body.tdoc-narrow .tdoc-comment-pill, body.tdoc-narrow .tdoc-drag-marquee { display: none; }
  body.tdoc-narrow .tdoc-emoji-picker { grid-template-columns: repeat(6, 36px); }
  body.tdoc-narrow .tdoc-emoji-picker button { width: 36px; height: 36px; font-size: 20px; }
  @media (max-width: 480px) {
    .tdoc-bar { padding: 0 10px; gap: 8px; }
    .tdoc-bar button, .tdoc-bar .tdoc-menu-wrap > button { padding: 4px 8px; font-size: 12px; }
    .tdoc-icon-btn span { display: none; }
    .tdoc-emoji-picker { grid-template-columns: repeat(5, 40px); padding: 8px; }
    .tdoc-emoji-picker button { width: 40px; height: 40px; font-size: 22px; }
    .tdoc-emoji-picker button.tdoc-emoji-text { grid-column: span 5; }
  }

  /* Theme toggle — icon-only, lives in the bar's right cluster. */
  .tdoc-theme-btn { flex-shrink: 0; }
  .tdoc-theme-icon-sun { display: none; }
  html[data-tdoc-theme="dark"] .tdoc-theme-icon-moon { display: none; }
  html[data-tdoc-theme="dark"] .tdoc-theme-icon-sun { display: block; }

  /* Dark mode: invert the painted page (Dark Reader / "filter" style).
     One transform hits author CSS, artifacts, replies, and chrome — no
     per-color list. hue-rotate keeps blues roughly blue. Photos / video /
     canvas / iframes are inverted back so they don't look like negatives. */
  html[data-tdoc-theme="dark"] {
    color-scheme: dark;
    background: #fff;
    filter: invert(1) hue-rotate(180deg);
  }
  /* Native buttons/inputs follow color-scheme. Dark UA styles paint light
     text onto an author light fill; invert then makes the label vanish
     (e.g. "Differences only" on a white chip). Keep form controls in the
     light scheme so invert can flip their author colors as a unit. */
  html[data-tdoc-theme="dark"] button,
  html[data-tdoc-theme="dark"] input,
  html[data-tdoc-theme="dark"] select,
  html[data-tdoc-theme="dark"] textarea {
    color-scheme: light;
  }
  html[data-tdoc-theme="dark"] img:not([data-tdoc-dark="invert"]),
  html[data-tdoc-theme="dark"] video:not([data-tdoc-dark="invert"]),
  html[data-tdoc-theme="dark"] canvas:not([data-tdoc-dark="invert"]),
  html[data-tdoc-theme="dark"] iframe:not([data-tdoc-dark="invert"]),
  html[data-tdoc-theme="dark"] .tdoc-emoji {
    filter: invert(1) hue-rotate(180deg);
  }
  /* Opt out via data-tdoc-dark="invert": this is a drawing, not a
     photograph. Photos and video have to come back to their true colours or
     they look like negatives, but a chart or a simulation drawn in ink on a
     white field should go dark with everything else — otherwise it sits in a
     dark page as a glowing white slab. */
  /* The site mark keeps its white field in dark mode. It is ink on an opaque
     white field, so it is restored like a photograph by the rule above rather
     than inverted with the page: inverting turned the field black, which is the
     bar's own dark colour, and the drawing read as a see-through outline. */
  /* Color emoji are OS bitmaps. The page invert turns ❤️ purple; wrap
     them in .tdoc-emoji so they get the same restore as photos. */
  .tdoc-emoji { display: inline-block; line-height: 1; }

  /* /me catalog: overlay reader template would otherwise restyle the list. */
  body.tdoc-catalog :where(body) { font-size: 15px; line-height: 1.5; }
  body.tdoc-catalog :where(body h1) { font-size: 28px; line-height: 1.2; color: var(--td-accent); margin: 0 0 24px; letter-spacing: -0.01em; }
  body.tdoc-catalog :where(body a) { text-decoration: none; }
  body.tdoc-catalog :where(body a):hover { text-decoration: underline; }

  /* Footer */
  .tdoc-footer { margin-top: 80px; padding: 20px 16px 28px; font: 12px system-ui, sans-serif; color: #888; text-align: center; border-top: 1px solid #eee; box-sizing: border-box; max-width: 100%; }
  .tdoc-footer .tdoc-footer-row { display: inline-flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center; row-gap: 4px; }
  .tdoc-footer a { color: #666; text-decoration: none; }
  .tdoc-footer a:hover { color: var(--td-accent); text-decoration: underline; }
  .tdoc-footer .sep { color: #ccc; }
  @media (max-width: 700px) { .tdoc-footer .tdoc-footer-row { flex-direction: column; gap: 4px; } .tdoc-footer .sep { display: none; } }

  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ========== State ==========
  const state = {
    activeComments: [],            // last-fetched open comments
    cardEls: new Map(),            // id -> card element
    anchorMarks: new Map(),        // id -> { kind, el? (fallback span or outline), ranges? (Highlight API), targetEl? }
    activeId: null,
    narrow: false,
    reanchoringId: null,           // comment id awaiting a new selection for re-anchoring
    pinnedId: null,                // comment whose floating card is click-pinned open (wide mode)
    hoverId: null,                 // comment whose card is open via hover (wide mode)
    openReplyThreads: new Set(),   // top-level comment ids whose reply lists stay expanded
  };

  // Highlight API: one shared registry for pending, one per saved comment.
  const pendingHighlight = HIGHLIGHT_API ? new Highlight() : null;
  if (HIGHLIGHT_API) {
    CSS.highlights.set('tdoc-pending', pendingHighlight);
  }
  function rebuildSharedHighlights() {
    if (!HIGHLIGHT_API) return;
    const idle = new Highlight();
    const active = new Highlight();
    for (const [id, mark] of state.anchorMarks) {
      if (!mark.ranges) continue;
      const target = (id === state.activeId) ? active : idle;
      for (const r of mark.ranges) target.add(r);
    }
    CSS.highlights.set('tdoc-anchor', idle);
    CSS.highlights.set('tdoc-anchor-active', active);
  }
  function clearAllCommentHighlights() {
    if (!HIGHLIGHT_API) return;
    CSS.highlights.delete('tdoc-anchor');
    CSS.highlights.delete('tdoc-anchor-active');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ========== Top bar (left title + right actions) ==========
  const bar = document.createElement('div');
  bar.className = 'tdoc-bar';

  const versions = Array.isArray(cfg.versions) && cfg.versions.length ? cfg.versions : [{ n: version }];
  versions.sort((a, b) => (a.n || 0) - (b.n || 0));
  const slugCrumbLabel = isFork ? `fork of ${cfg.originalSlug || slug}` : slug;

  // Left group: site mark + slug crumb + version picker + title.
  // Title lives here (not a fake viewport-center) because left and right
  // chrome are different widths. `/` and `/me` drop crumb/picker/title —
  // those pages already name themselves in the document.
  const isSiteBar = !!(cfg.isLanding || isCatalog);
  const leftHtml = `
    <button class="tdoc-bar-mark" id="tdoc-bar-mark" title="My docs" aria-label="My docs"><img src="/tdoc_logo.svg" alt="" width="24" height="24"></button>
    ${isSiteBar ? '' : `
    <span class="crumb crumb-slug" title="${escapeHtml(slugCrumbLabel)}">${escapeHtml(slugCrumbLabel)}</span>
    <span class="crumb-sep crumb-sep-slug" aria-hidden="true">/</span>
    <div class="tdoc-version-wrap">
      <button class="tdoc-version-toggle" id="tdoc-version-toggle" type="button" aria-haspopup="listbox" aria-expanded="false">v${version}${versions.length > 1 ? ' ▾' : ''}</button>
      ${versions.length > 1 ? `
        <div class="tdoc-version-menu" id="tdoc-version-menu" role="listbox">
          ${versions.map(v => `<button role="option" data-version="${v.n}" class="${v.n === version ? 'current' : ''}">v${v.n}${v.n === version ? ' · current' : ''}</button>`).join('')}
        </div>
      ` : ''}
    </div>
    <span class="doc-title" id="tdoc-title">tdoc</span>`}`;

  // Right: primary CTA (Share or Publish) + ⋯ overflow + identity. Copy /
  // Duplicate / Download all live inside the ⋯ menu now — see rightHtml.
  const primaryCtaHtml = isFork ? '' : (isPublished
    ? `<button id="tdoc-share-btn" class="primary" title="Share" aria-label="Share">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
         <span>Share</span>
       </button>`
    : `<button id="tdoc-publish-btn" class="primary" title="Publish to your Worker" aria-label="Publish">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>
         <span>Publish</span>
       </button>`);

  // Duplicate + Download live in the ⋯ menu on narrow viewports.
  const downloadMenuHtml = (isPublished || isFork) ? `
    <div class="tdoc-menu-wrap" id="tdoc-download-wrap">
      <button id="tdoc-download-btn" title="Download" aria-haspopup="menu" aria-expanded="false">Download</button>
      <div class="tdoc-menu" id="tdoc-download-menu" role="menu">
        <button data-format="html" role="menuitem">Download HTML</button>
        <button data-format="pdf" role="menuitem">Download PDF</button>
      </div>
    </div>` : '';
  const forkBtnHtml = isPublished
    ? '<button id="tdoc-duplicate-btn" title="Make a copy in your account">Duplicate</button>' + downloadMenuHtml
    : downloadMenuHtml;

  const themeBtnHtml = `
    <button type="button" id="tdoc-theme-btn" class="tdoc-theme-btn" aria-pressed="false" title="Dark mode" aria-label="Switch to dark mode">
      <svg class="tdoc-theme-icon-moon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/></svg>
      <svg class="tdoc-theme-icon-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
    </button>`;

  const ghStars = (typeof cfg.stars === 'number' && cfg.stars >= 0) ? cfg.stars : null;
  const ghStarText = ghStars === null ? '' : (ghStars >= 1000 ? (ghStars / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(ghStars));
  const githubBtnHtml = `
    <a class="tdoc-github-btn" id="tdoc-github-btn" href="https://github.com/tornado-doc/tdoc" target="_blank" rel="noopener" title="${ghStars === null ? 'tdoc on GitHub' : ghStars + ' stars on GitHub'}" aria-label="tdoc on GitHub">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>${ghStarText ? `<span class="tdoc-gh-stars"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>${ghStarText}</span>` : ''}
    </a>`;

  const rightHtml = `
    ${cfg.isLanding ? githubBtnHtml : ''}
    ${themeBtnHtml}
    ${isSiteBar ? '' : forkBtnHtml}
    ${isSiteBar ? '' : primaryCtaHtml}
    ${!isSiteBar ? `<div class="tdoc-menu-wrap">
      <button class="tdoc-secondary-toggle" id="tdoc-more-btn" aria-label="More" title="More">⋯</button>
      <div class="tdoc-secondary-menu" id="tdoc-secondary-menu">
        ${versions.length > 1 ? `<div class="tdoc-sec-versions" role="group" aria-label="Version">
          <div class="tdoc-sec-label">Version</div>
          ${versions.map(v => `<button role="option" data-version="${v.n}" class="tdoc-sec-version${v.n === version ? ' current' : ''}">v${v.n}${v.n === version ? ' · current' : ''}</button>`).join('')}
          <div class="tdoc-sec-sep"></div>
        </div>` : ''}
        <button data-action="copy">Copy as Markdown</button>
        ${isPublished ? '<button data-action="duplicate">Duplicate</button><button data-action="download">Download HTML</button><button data-action="download-pdf">Download PDF</button>' : ''}
        ${isFork ? '<button data-action="saveas">Download HTML</button><button data-action="download-pdf">Download PDF</button>' : ''}
        ${cfg.ownerManage ? '<div class="tdoc-sec-sep"></div><button data-action="delete" class="tdoc-sec-danger">Delete doc…</button>' : ''}
      </div>
    </div>` : ''}
    <span id="tdoc-identity-slot"></span>`;

  bar.innerHTML = `
    <div class="tdoc-bar-left">${leftHtml}</div>
    <div class="tdoc-bar-right">${rightHtml}</div>
  `;
  document.body.insertBefore(bar, document.body.firstChild);

  // Old-version strip — a quiet, single-direction nudge shown only when a
  // published viewer is looking at a non-latest version. `versions` is already
  // sorted ascending above, so the last entry is the latest. Fork/local modes
  // and the latest version itself get nothing.
  if (isPublished && versions.length > 1) {
    const latestVersion = versions[versions.length - 1].n;
    if (typeof version === 'number' && version < latestVersion) {
      const strip = document.createElement('div');
      strip.className = 'tdoc-oldver-strip';
      const latestUrl = `/d/${encodeURIComponent(slug)}/v/${latestVersion}`;
      strip.innerHTML = `<span>You're viewing v${version} — the latest is <a href="${latestUrl}">v${latestVersion}</a></span>`;
      bar.insertAdjacentElement('afterend', strip);
      document.body.classList.add('tdoc-has-oldver-strip');
    }
  }

  // Re-anchor banner — shown while a re-anchor action is in flight. Three
  // explicit actions to avoid the gesture conflict (clicking empty space
  // would otherwise be ambiguous with "deselect").
  if (!isCatalog) {
    const reanchorBanner = document.createElement('div');
    reanchorBanner.className = 'tdoc-reanchor-banner';
    reanchorBanner.innerHTML = `
    <span class="label">Select text to move anchor</span>
    <button type="button" id="tdoc-reanchor-remove">Remove anchor</button>
    <button type="button" id="tdoc-reanchor-cancel" class="danger">Cancel</button>
  `;
    document.body.appendChild(reanchorBanner);
  }

  const titleEl = document.querySelector('title');
  const barTitle = document.getElementById('tdoc-title');
  if (barTitle && titleEl && titleEl.textContent) barTitle.textContent = titleEl.textContent;

  // Site mark → hub. On tdoc.dev that is /me. Local studio has no /me
  // catalog, so the local server 302s /me → /. GitHub lives in its own
  // icon on `/`.
  document.getElementById('tdoc-bar-mark').onclick = () => { location.href = '/me'; };

  paintTheme(currentTheme());
  document.getElementById('tdoc-theme-btn').onclick = () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    persistTheme(next);
    paintTheme(next);
  };

  wireCopyTriggers();

  // Duplicate = hosted account copy. Download HTML = /export file.
  // Download PDF = print the export (browser Save as PDF), not a JPEG wrap.
  let pendingDuplicate = false;
  function downloadExport() {
    const a = document.createElement('a');
    a.href = `/d/${encodeURIComponent(slug)}/v/${version}/export?download=1`;
    a.download = `${slug}-v${version}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  async function downloadPdf() {
    const src = `/d/${encodeURIComponent(slug)}/v/${version}/export?download=0`;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('title', 'Print');
    iframe.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:100vh;border:0;opacity:0;pointer-events:none;';
    document.body.appendChild(iframe);
    const drop = () => { if (iframe.parentNode) iframe.remove(); };
    try {
      await new Promise((resolve, reject) => {
        iframe.onload = resolve;
        iframe.onerror = () => reject(new Error('could not load export'));
        iframe.src = src;
        setTimeout(() => reject(new Error('pdf export timed out')), 20000);
      });
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win || !doc.body) throw new Error('empty export');
      doc.title = `${slug}-v${version}`;
      await Promise.all([...doc.images].map((img) => img.decode ? img.decode().catch(() => {}) : Promise.resolve()));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      win.addEventListener('afterprint', drop, { once: true });
      setTimeout(drop, 120000);
      win.focus();
      win.print();
    } catch (e) {
      drop();
      throw e;
    }
  }
  async function startDownload(format) {
    if (format === 'pdf') {
      try { await downloadPdf(); }
      catch (e) {
        showAccountCopyModal({
          title: 'Could not download PDF',
          body: e.message || 'PDF export failed. Try Download HTML.',
          offerDownload: true,
        });
      }
      return;
    }
    downloadExport();
  }
  function showAccountCopyModal({ title, body, offerDownload }) {
    closeAuxModal();
    const bg = document.createElement('div');
    bg.className = 'tdoc-modal-bg';
    bg.id = 'tdoc-aux-modal';
    bg.innerHTML = `
      <div class="tdoc-modal">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(body)}</p>
        <div class="actions">
          ${offerDownload ? '<button class="primary" id="tdoc-dup-dl">Download HTML</button>' : ''}
          <button id="tdoc-dup-close">Close</button>
        </div>
      </div>`;
    document.body.appendChild(bg);
    document.getElementById('tdoc-dup-close').onclick = closeAuxModal;
    const dl = document.getElementById('tdoc-dup-dl');
    if (dl) dl.onclick = () => { downloadExport(); closeAuxModal(); };
  }
  async function duplicateDoc() {
    if (!isPublished) return;
    if (!identity) {
      pendingDuplicate = true;
      startDeviceFlow();
      return;
    }
    try {
      const r = await fetch('/api/doc/duplicate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, version }),
      });
      let data = {};
      try { data = await r.json(); } catch {}
      if (r.status === 401 || data.error === 'sign_in_required') {
        pendingDuplicate = true;
        startDeviceFlow();
        return;
      }
      if (data.error === 'account_copy_unavailable') {
        showAccountCopyModal({
          title: 'Account copy is not available here',
          body: data.message || 'This host only lets the worker owner make an account copy. Download the HTML to take the doc offline.',
          offerDownload: true,
        });
        return;
      }
      if (data.error === 'islands_not_supported') {
        showAccountCopyModal({
          title: 'This doc has interactive widgets',
          body: data.message || 'Widget islands cannot be duplicated in v1. Download the host HTML instead.',
          offerDownload: true,
        });
        return;
      }
      if (!r.ok || !data.ok || !data.url) {
        showAccountCopyModal({
          title: 'Could not duplicate',
          body: data.message || data.error || (`HTTP ${r.status}`),
          offerDownload: true,
        });
        return;
      }
      location.href = data.url;
    } catch (e) {
      showAccountCopyModal({
        title: 'Could not duplicate',
        body: e.message || 'network error',
        offerDownload: true,
      });
    }
  }
  if (isPublished) {
    const dup = document.getElementById('tdoc-duplicate-btn');
    if (dup) dup.onclick = (e) => { e.stopPropagation(); duplicateDoc(); };
    const sb = document.getElementById('tdoc-share-btn');
    if (sb) sb.onclick = (e) => { e.stopPropagation(); showShareModal(); };
  }
  if (isLocal) {
    const pb = document.getElementById('tdoc-publish-btn');
    if (pb) pb.onclick = (e) => { e.stopPropagation(); showPublishModal(); };
  }

  const dlBtn = document.getElementById('tdoc-download-btn');
  const dlMenu = document.getElementById('tdoc-download-menu');
  if (dlBtn && dlMenu) {
    dlBtn.onclick = (e) => {
      e.stopPropagation();
      const open = dlMenu.classList.toggle('open');
      dlBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    dlMenu.querySelectorAll('button').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        dlMenu.classList.remove('open');
        dlBtn.setAttribute('aria-expanded', 'false');
        startDownload(b.dataset.format);
      };
    });
  }

  // Version picker — clicking a row navigates to /d/<slug>/v/<n>. The
  // worker handles version routing; we let the browser do the navigation
  // instead of any in-page swap so the user can hit Back to return.
  const versionToggle = document.getElementById('tdoc-version-toggle');
  const versionMenu = document.getElementById('tdoc-version-menu');
  if (versionToggle && versionMenu) {
    versionToggle.onclick = (e) => {
      e.stopPropagation();
      const open = versionMenu.classList.toggle('open');
      versionToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    versionMenu.querySelectorAll('button').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        versionMenu.classList.remove('open');
        const n = Number(b.dataset.version);
        if (!Number.isFinite(n) || n === version) return;
        location.href = `/d/${encodeURIComponent(slug)}/v/${n}`;
      };
    });
  }

  const moreBtn = document.getElementById('tdoc-more-btn');
  const secMenu = document.getElementById('tdoc-secondary-menu');
  if (moreBtn && secMenu) {
    moreBtn.onclick = (e) => { e.stopPropagation(); secMenu.classList.toggle('open'); };
    secMenu.querySelectorAll('button').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        secMenu.classList.remove('open');
        // Version rows (folded in from the inline chip on phones) navigate.
        if (b.dataset.version != null) {
          const vn = Number(b.dataset.version);
          if (Number.isFinite(vn) && vn !== version) location.href = `/d/${encodeURIComponent(slug)}/v/${vn}`;
          return;
        }
        if (b.dataset.action === 'copy') window.__tdocCopyDocMd(false);
        if (b.dataset.action === 'duplicate') duplicateDoc();
        if (b.dataset.action === 'download' || b.dataset.action === 'saveas') downloadExport();
        if (b.dataset.action === 'download-pdf') startDownload('pdf');
        if (b.dataset.action === 'delete') confirmDeleteDoc();
      };
    });
  }


  let inboxUnreadN = 0;
  let inboxSig = '';
  let inboxPollTimer = null;
  const INBOX_POLL_MS = 8000;
  function inboxBadgeText(n) {
    if (!n) return '';
    return n > 99 ? '99+' : String(n);
  }
  function inboxMenuLabel(n) {
    const txt = inboxBadgeText(n);
    return txt ? `Notifications (${txt})` : 'Notifications';
  }
  function formatRelativeTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const sec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (sec < 60) return 'now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h';
    if (sec < 86400 * 7) return Math.floor(sec / 86400) + 'd';
    return d.toLocaleString([], { month: 'short', day: 'numeric' });
  }
  function inboxRowLabel(row) {
    const n = row.count || 1;
    const who = (row.actor && (row.actor.login || row.actor.name)) || 'someone';
    const title = row.title || row.slug || 'a doc';
    if (row.kind === 'comment') return n > 1 ? `${n} new comments on ${title}` : `${who} commented on ${title}`;
    if (row.kind === 'reply') return n > 1 ? `${n} new replies to your comment` : `${who} replied to your comment`;
    if (row.kind === 'reaction') return n > 1 ? `${n} people reacted to your comment` : `${who} reacted to your comment`;
    return 'Notification';
  }
  // Canonical inbox destination. Never returns /d/undefined — empty slug is ''.
  function inboxTargetUrl(row, current) {
    row = row || {};
    current = current || {};
    const destSlug = row.slug || current.slug || '';
    if (!destSlug) return '';
    const rawVer = row.version != null && row.version !== '' ? row.version : current.version;
    const destVer = Number(rawVer);
    const ver = Number.isFinite(destVer) && destVer > 0 ? destVer : 1;
    const target = row.comment_id || row.thread_id || '';
    let href = '/d/' + encodeURIComponent(destSlug) + '/v/' + ver;
    if (target) href += '?comment=' + encodeURIComponent(target);
    return href;
  }
  // Map a comment or reply id to the top-level card that holds it.
  function findCommentRoot(list, want) {
    if (!want) return null;
    const comments = Array.isArray(list) ? list : [];
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      if (!c) continue;
      if (c.id === want) return c.id;
      const replies = c.replies || [];
      for (let j = 0; j < replies.length; j++) {
        if (replies[j] && replies[j].id === want) return c.id;
      }
    }
    return want;
  }
  function inboxFingerprint(body) {
    const items = (body && Array.isArray(body.items)) ? body.items : [];
    return `${body && body.unread}|${items.map(i => [i.id, i.count, i.at, i.read].join(':')).join(',')}`;
  }
  function paintInboxChrome() {
    const dot = document.getElementById('tdoc-inbox-dot');
    if (dot) dot.hidden = !inboxUnreadN;
    const menu = document.getElementById('tdoc-inbox-open');
    if (menu) menu.textContent = inboxMenuLabel(inboxUnreadN);
  }
  function writeInboxRows(listEl, items, append) {
    if (!listEl) return;
    if (!items.length && !append) {
      listEl.innerHTML = '<p class="muted">No notifications yet.</p>';
      return;
    }
    const html = items.map(row => {
      const when = formatRelativeTime(row.at);
      const whenFull = row.at ? new Date(row.at).toLocaleString() : '';
      const cur = row.read ? '' : ' tdoc-cluster-current';
      return `<div class="tdoc-cluster-row${cur}" role="button" tabindex="0" data-id="${escapeHtml(row.id)}">
        ${avatarHTML(row.actor, 'tdoc-cluster-anon')}
        <span class="tdoc-cluster-snip">${escapeHtml(inboxRowLabel(row))}</span>
        ${when ? `<span class="muted" title="${escapeHtml(whenFull)}">${escapeHtml(when)}</span>` : ''}
      </div>`;
    }).join('');
    if (!append) listEl.innerHTML = html;
    else listEl.insertAdjacentHTML('beforeend', html);
    items.forEach(row => {
      const btn = listEl.querySelector(`.tdoc-cluster-row[data-id="${CSS.escape(row.id)}"]`);
      if (!btn) return;
      btn.dataset.slug = row.slug || '';
      btn.dataset.version = String(row.version || 1);
      btn.dataset.comment = row.comment_id || '';
      btn.dataset.thread = row.thread_id || '';
      if (btn._bound) return;
      btn._bound = true;
      const go = (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        openInboxTarget({
          slug: btn.dataset.slug, version: btn.dataset.version,
          comment_id: btn.dataset.comment, thread_id: btn.dataset.thread,
        });
        closeAuxModal();
      };
      btn.onclick = go;
      btn.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } };
    });
  }
  async function refreshInboxBadge() {
    if (!identity) return;
    try {
      const r = await fetch('/api/notifications/unread', { credentials: 'same-origin' });
      if (!r.ok) return;
      const body = await r.json();
      inboxUnreadN = Number(body.unread) || 0;
    } catch { return; }
    paintInboxChrome();
  }
  async function tickInbox() {
    if (!identity || document.hidden) return;
    if (document.querySelector('.tdoc-reply-form.open, .tdoc-popup, textarea:focus')) return;
    try {
      const r = await fetch('/api/notifications?offset=0', { credentials: 'same-origin' });
      if (!r.ok) return;
      const body = await r.json();
      const sig = inboxFingerprint(body);
      const first = !inboxSig;
      const changed = sig !== inboxSig;
      if (typeof body.unread === 'number') inboxUnreadN = body.unread;
      inboxSig = sig;
      paintInboxChrome();
      if (!first && changed) refreshComments({ deepLink: false });
      const listEl = document.getElementById('tdoc-inbox-list');
      if (listEl && changed) {
        const more = document.getElementById('tdoc-inbox-more');
        if (more) { more.dataset.offset = '0'; more.hidden = !body.has_more; }
        writeInboxRows(listEl, Array.isArray(body.items) ? body.items : [], false);
      }
    } catch {}
  }
  function startInboxPoll() {
    if (inboxPollTimer) return;
    inboxPollTimer = setInterval(tickInbox, INBOX_POLL_MS);
  }
  function stopInboxPoll() {
    if (inboxPollTimer) { clearInterval(inboxPollTimer); inboxPollTimer = null; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tickInbox(); });
  async function markInboxSeen(commentId) {
    if (!identity || !commentId) return;
    try {
      await fetch('/api/notifications/read', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment_id: commentId }),
      });
    } catch {}
    refreshInboxBadge();
  }
  function openInboxTarget(row) {
    const href = inboxTargetUrl(row, { slug, version });
    if (!href) return;
    const q = href.indexOf('?');
    const destPath = q >= 0 ? href.slice(0, q) : href;
    const destSearch = q >= 0 ? href.slice(q) : '';
    const herePath = (typeof location !== 'undefined' && location.pathname) || '';
    // /me and `/` always assign /d/<slug>/v/<n>?comment=. Same-doc stays
    // in place and only replaceState-s the query.
    if (!isCatalog && herePath === destPath) {
      const want = (row && (row.comment_id || row.thread_id)) || '';
      applyCommentDeepLink(want);
      try {
        if (destSearch && location.search !== destSearch) history.replaceState(null, '', href);
      } catch {}
      return;
    }
    location.assign(href);
  }
  async function showInboxPanel() {
    closeAuxModal();
    const bg = document.createElement('div');
    bg.className = 'tdoc-modal-bg';
    bg.id = 'tdoc-aux-modal';
    bg.innerHTML = `
      <div class="tdoc-modal">
        <h3>Notifications</h3>
        <div id="tdoc-inbox-list"><p class="muted">Loading…</p></div>
        <div class="actions"><button type="button" id="tdoc-inbox-more" hidden>Load more</button><button type="button" id="tdoc-inbox-close">Close</button></div>
      </div>`;
    document.body.appendChild(bg);
    document.getElementById('tdoc-inbox-close').onclick = closeAuxModal;
    const more = document.getElementById('tdoc-inbox-more');
    more.dataset.offset = '0';
    const paint = async () => {
      const listEl = document.getElementById('tdoc-inbox-list');
      const offset = Number(more.dataset.offset) || 0;
      try {
        const r = await fetch(`/api/notifications?offset=${offset}`, { credentials: 'same-origin' });
        if (!r.ok) { listEl.innerHTML = '<p class="muted">Could not load notifications.</p>'; return; }
        const body = await r.json();
        const items = Array.isArray(body.items) ? body.items : [];
        writeInboxRows(listEl, items, offset > 0);
        more.hidden = !body.has_more;
        more.onclick = () => { more.dataset.offset = String(offset + items.length); paint(); };
        if (typeof body.unread === 'number') {
          inboxUnreadN = body.unread;
          inboxSig = inboxFingerprint(body);
          paintInboxChrome();
        }
      } catch {
        listEl.innerHTML = '<p class="muted">Could not load notifications.</p>';
      }
    };
    paint();
  }
  function renderIdentity() {
    const slot = document.getElementById('tdoc-identity-slot');
    if (!slot) return;
    if (!isPublished && !identity) { slot.innerHTML = ''; return; }
    if (identity) {
      slot.innerHTML =
        `<div class="tdoc-menu-wrap">
          <button class="tdoc-chip" id="tdoc-me" aria-haspopup="menu" aria-expanded="false">
            <img src="${escapeHtml(identity.avatar_url || '')}" alt=""><span class="name">${escapeHtml(identity.login)}</span>
            <span class="tdoc-unread-dot" id="tdoc-inbox-dot" ${inboxUnreadN ? '' : 'hidden'}></span>
          </button>
          <div class="tdoc-menu" id="tdoc-me-menu" role="menu">
            <button id="tdoc-inbox-open" role="menuitem">${escapeHtml(inboxMenuLabel(inboxUnreadN))}</button>
            ${canSeeMyDocs && !isCatalog ? `<button id="tdoc-my-docs" role="menuitem">My docs</button>` : ''}
            <button id="tdoc-signout" role="menuitem">Sign out</button>
          </div>
        </div>`;
      const meBtn = document.getElementById('tdoc-me');
      const meMenu = document.getElementById('tdoc-me-menu');
      meBtn.onclick = (e) => {
        e.stopPropagation();
        const open = meMenu.classList.toggle('open');
        meBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
      document.getElementById('tdoc-inbox-open').onclick = () => { meMenu.classList.remove('open'); showInboxPanel(); };
      if (canSeeMyDocs && !isCatalog) {
        document.getElementById('tdoc-my-docs').onclick = () => {
          window.open('/me', '_blank', 'noopener');
        };
      }
      document.getElementById('tdoc-signout').onclick = async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        identity = null;
        isOwner = false;
        canSeeMyDocs = false;
        inboxUnreadN = 0;
        inboxSig = '';
        stopInboxPoll();
        renderIdentity();
        if (!isCatalog) refreshComments();
      };
      tickInbox();
      startInboxPoll();
    } else if (isPublished) {
      slot.innerHTML = `<button class="tdoc-chip signin" id="tdoc-signin">Sign in with GitHub</button>`;
      document.getElementById('tdoc-signin').onclick = startDeviceFlow;
    } else {
      slot.innerHTML = '';
    }
  }
  renderIdentity();

  // Catalog (/me): bar + identity only. Comment pins, FAB, and selection
  // are document chrome and would fetch /api/comments for a fake slug.
  if (isCatalog) {
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || t.nodeType !== 1) return;
      if (!t.closest('#tdoc-me') && !t.closest('#tdoc-me-menu')) {
        const mm = document.getElementById('tdoc-me-menu');
        const mb = document.getElementById('tdoc-me');
        if (mm) mm.classList.remove('open');
        if (mb) mb.setAttribute('aria-expanded', 'false');
      }
    });
    return;
  }

  // ========== Comment layer + FAB ==========
  const commentLayer = document.createElement('div');
  commentLayer.id = 'tdoc-comment-layer';
  const drawerHandle = document.createElement('div');
  drawerHandle.className = 'tdoc-drawer-handle';
  drawerHandle.setAttribute('aria-label', 'Drag down to close comments');
  commentLayer.appendChild(drawerHandle);
  document.body.appendChild(commentLayer);

  // Pin layer (wide mode): holds the avatar pins / cluster badges. Cards still
  // live in commentLayer but are hidden until a pin opens one.
  const pinLayer = document.createElement('div');
  pinLayer.id = 'tdoc-pin-layer';
  document.body.appendChild(pinLayer);
  // One reusable cluster popover.
  const clusterPop = document.createElement('div');
  clusterPop.className = 'tdoc-cluster-pop';
  document.body.appendChild(clusterPop);

  // One reusable body-level reactors tooltip (escapes card overflow clipping).
  const reactorsTip = document.createElement('div');
  reactorsTip.id = 'tdoc-reactors-tip';
  document.body.appendChild(reactorsTip);
  function showReactorsTip(chip) {
    const users = chip.getAttribute('data-users');
    if (!users) return;
    reactorsTip.textContent = users;
    reactorsTip.classList.add('open');           // measurable
    const r = chip.getBoundingClientRect();
    const tw = reactorsTip.offsetWidth, th = reactorsTip.offsetHeight;
    // Centered above the chip, then clamped to the viewport on both axes so the
    // full name is always visible (never truncated off the left/right edge).
    let left = r.left + window.scrollX + r.width / 2 - tw / 2;
    left = Math.max(window.scrollX + 6, Math.min(left, window.scrollX + window.innerWidth - tw - 6));
    let top = r.top + window.scrollY - th - 6;
    if (top < window.scrollY + 6) top = r.bottom + window.scrollY + 6; // flip below if no room above
    reactorsTip.style.left = left + 'px';
    reactorsTip.style.top = top + 'px';
  }
  function hideReactorsTip() { reactorsTip.classList.remove('open'); }
  // Delegated hover — works for chips inside floating cards / replies / drawer.
  document.addEventListener('mouseover', (e) => {
    const chip = e.target.closest?.('.tdoc-react-chip[data-users]');
    if (chip) showReactorsTip(chip);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest?.('.tdoc-react-chip[data-users]')) hideReactorsTip();
  });

  const fab = document.createElement('button');
  fab.className = 'tdoc-fab';
  fab.style.display = 'none';
  fab.innerHTML = '💬 <span id="tdoc-fab-count">0</span>';
  fab.onclick = (e) => { e.stopPropagation(); commentLayer.classList.toggle('open'); };
  document.body.appendChild(fab);

  // Backdrop scrim for the mobile drawer: tap it to dismiss. Appended after the
  // comment layer so the CSS sibling combinator above can show/hide it purely
  // off the drawer's .open class. touchstart closes immediately (and blocks the
  // synthesized click/scroll); a click handler covers desktop-narrow pointers.
  const drawerScrim = document.createElement('div');
  drawerScrim.id = 'tdoc-drawer-scrim';
  const closeDrawer = () => commentLayer.classList.remove('open');
  drawerScrim.addEventListener('click', closeDrawer);
  drawerScrim.addEventListener('touchstart', (e) => { e.preventDefault(); closeDrawer(); }, { passive: false });
  document.body.appendChild(drawerScrim);

  // Drawer drag-to-close
  drawerHandle.onclick = (e) => { e.stopPropagation(); commentLayer.classList.remove('open'); };
  let drag = null;
  function dragStart(e) {
    e.preventDefault();
    drag = { y0: e.touches ? e.touches[0].clientY : e.clientY, dy: 0 };
    commentLayer.style.transition = 'none';
  }
  function dragMove(e) {
    if (!drag) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    drag.dy = Math.max(0, y - drag.y0);
    commentLayer.style.transform = `translateY(${drag.dy}px)`;
  }
  function dragEnd() {
    if (!drag) return;
    commentLayer.style.transition = '';
    commentLayer.style.transform = '';
    if (drag.dy > 40) commentLayer.classList.remove('open');
    drag = null;
  }
  drawerHandle.addEventListener('touchstart', dragStart, { passive: false });
  drawerHandle.addEventListener('touchmove', dragMove, { passive: true });
  drawerHandle.addEventListener('touchend', dragEnd);
  drawerHandle.addEventListener('mousedown', (e) => {
    dragStart(e);
    document.addEventListener('mousemove', dragMove);
    document.addEventListener('mouseup', function onUp() {
      dragEnd();
      document.removeEventListener('mousemove', dragMove);
      document.removeEventListener('mouseup', onUp);
    });
  });

  // ========== Footer ==========
  const footer = document.createElement('footer');
  footer.className = 'tdoc-footer';
  footer.innerHTML =
    '<div class="tdoc-footer-row">' +
      '<a href="https://github.com/tornado-doc/tdoc" target="_blank" rel="noopener">github.com/tornado-doc/tdoc</a>' +
      '<span class="sep">·</span>' +
      '<span>built with <a href="https://github.com/tornado-doc/tdoc" target="_blank" rel="noopener">tdoc</a></span>' +
      '<span class="sep">·</span>' +
    '</div>';
  document.body.appendChild(footer);

  // ========== Anchor matching (text → Range, element → Element) ==========
  // Flatten the document's commentable text into one string, plus a parallel
  // (node, offsetInString) map. Selections often span multiple text nodes
  // (e.g. across <b>, <a>, <em>), so a per-node indexOf would miss them.
  // Searching the flattened string handles that uniformly.
  // Build a flat view of the document's commentable text plus a per-text-node
  // offset map. We also build a *normalized* projection where every run of
  // whitespace collapses to a single space. Multi-paragraph selections — which
  // `Selection.toString()` returns with embedded "\n\n" — match against the
  // normalized projection; the projection→raw map lets us recover the exact
  // text-node/offset pair for the Range.
  function collectTextNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.parentElement) return NodeFilter.FILTER_REJECT;
        if (n.parentElement.closest(UI_CONTAINERS)) return NodeFilter.FILTER_REJECT;
        // Skip script/style/template etc — their .textContent is irrelevant.
        const tag = n.parentElement.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let total = '';
    // norm[i] = raw-string offset corresponding to normalized-string offset i.
    let norm = '';
    const normToRaw = [];
    let prevWasSpace = false;
    while (walker.nextNode()) {
      const n = walker.currentNode;
      const start = total.length;
      const v = n.nodeValue;
      nodes.push({ node: n, start, end: start + v.length });
      total += v;
      // If the previous block ended on non-space content and the next text
      // node lives under a different block-level parent, treat the boundary
      // as a single space in the normalized projection. This is what makes
      // "para1\n\npara2" (from Selection.toString) collapse to "para1 para2".
      for (let i = 0; i < v.length; i++) {
        const ch = v.charCodeAt(i);
        const isWs = ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0xa0;
        if (isWs) {
          if (!prevWasSpace && norm.length) {
            norm += ' ';
            normToRaw.push(start + i);
            prevWasSpace = true;
          }
        } else {
          norm += v[i];
          normToRaw.push(start + i);
          prevWasSpace = false;
        }
      }
    }
    // Sentinel: normToRaw.length === norm.length, plus one trailing entry so
    // end offsets at the very end of the doc still translate.
    normToRaw.push(total.length);
    return { nodes, total, norm, normToRaw };
  }
  // Collapse runs of whitespace into a single space so saved anchor text
  // and the doc's normalized projection agree on inter-block boundaries.
  // Two flavors:
  //   normalizeNeedle: also trims edges. The user's selection often has
  //     a stray leading/trailing newline that's not present in the doc
  //     text we want to match against.
  //   normalizeContext: preserves leading/trailing whitespace. Boundary
  //     whitespace is what makes context disambiguation work — the doc's
  //     normalized projection has a single space between block elements
  //     before the needle, so trimming context tails would strand them at
  //     punctuation and break commonSuffixLen.
  function normalizeNeedle(s) {
    return s ? s.replace(/\s+/g, ' ').trim() : '';
  }
  function normalizeContext(s) {
    return s ? s.replace(/\s+/g, ' ') : '';
  }
  // Back-compat alias for older callers (getContext etc.) — they handle
  // their own normalization where needed.
  function normalizeQuery(s) { return normalizeNeedle(s); }
  // Locate (node, offset) in the per-node map from a raw-string offset.
  function locateAt(nodes, rawOffset) {
    let lo = 0, hi = nodes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = nodes[mid];
      if (rawOffset < n.start) hi = mid - 1;
      else if (rawOffset > n.end) lo = mid + 1;
      else return { node: n.node, offset: rawOffset - n.start };
    }
    return null;
  }
  // Anchor matching protocol (architectural):
  //
  //   Invariant: a text anchor resolves only when the saved context_before /
  //   context_after agrees with the candidate location. The same `text` may
  //   appear N times in the doc; context is the disambiguator that picks
  //   THIS occurrence — moving the anchor (re-anchor) rewrites the context
  //   to the new neighbors, so the matcher MUST refuse to fall back to the
  //   first hit when context fails to match. Without this guard, re-anchor
  //   silently re-resolves to the old location whenever the old text still
  //   exists in the doc (the "stale highlight" bug).
  //
  //   We compare longer context windows (60 chars by default, scaled down
  //   to what was saved) for stronger disambiguation, and require at least
  //   one side to match to accept the hit. If no candidate clears the bar,
  //   return null and let the caller fall back to the saved position ratio.
  const CTX_MATCH_LEN = 60;
  function findTextRange(anchor, cache) {
    if (!anchor || !anchor.text || anchor.text.length < 2) return null;
    const view = cache || collectTextNodes();
    if (!view.norm) return null;

    const needleN = normalizeNeedle(anchor.text);
    if (needleN.length < 2) return null;
    const beforeN = normalizeContext(anchor.context_before);
    const afterN = normalizeContext(anchor.context_after);

    const hits = [];
    for (let i = 0; (i = view.norm.indexOf(needleN, i)) !== -1; i += Math.max(1, needleN.length)) {
      hits.push(i);
      if (hits.length > 64) break;
    }
    if (!hits.length) return null;

    // Single hit and no saved context → unambiguous, accept.
    // Multiple hits with no context → ambiguous, refuse.
    const hasContext = beforeN.length > 0 || afterN.length > 0;
    if (hits.length === 1 && !hasContext) {
      return rangeFromNormalizedOffsets(view, hits[0], needleN.length);
    }
    if (!hasContext) return null;

    // Score each hit by how many context chars match on each side. Require
    // a *meaningful* match — at least MIN_CTX_MATCH chars — so we don't
    // accept hits that only agree on trailing punctuation/spaces ("." or
    // ": "). That guard is what makes re-anchor robust: when the user
    // moves the anchor, the new context_before/after refer to the new
    // neighbors; the old location's punctuation overlap shouldn't be
    // enough to keep the highlight there.
    const MIN_CTX_MATCH = 4;
    const ctxLen = CTX_MATCH_LEN;
    const bTail = beforeN.slice(-Math.min(ctxLen, beforeN.length));
    const aHead = afterN.slice(0, Math.min(ctxLen, afterN.length));
    let bestIdx = -1, bestScore = 0;
    for (const h of hits) {
      const beforeSlice = view.norm.slice(Math.max(0, h - ctxLen), h);
      const afterSlice = view.norm.slice(h + needleN.length, h + needleN.length + ctxLen);
      const bScore = commonSuffixLen(beforeSlice, bTail);
      const aScore = commonPrefixLen(afterSlice, aHead);
      // A side counts only if it cleared the meaningful-match bar.
      const score = (bScore >= MIN_CTX_MATCH ? bScore : 0) + (aScore >= MIN_CTX_MATCH ? aScore : 0);
      if (score > bestScore) { bestScore = score; bestIdx = h; }
    }
    // Reject if no candidate cleared the meaningful-match bar. Caller will
    // use the saved fallback ratio rather than highlight the wrong spot.
    if (bestIdx === -1 || bestScore === 0) return null;

    return rangeFromNormalizedOffsets(view, bestIdx, needleN.length);
  }
  function rangeFromNormalizedOffsets(view, normIdx, normLen) {
    const rawStart = view.normToRaw[normIdx];
    const rawEnd = view.normToRaw[normIdx + normLen] ?? view.total.length;
    const startLoc = locateAt(view.nodes, rawStart);
    const endLoc = locateAt(view.nodes, rawEnd);
    if (!startLoc || !endLoc) return null;
    const range = document.createRange();
    try {
      range.setStart(startLoc.node, startLoc.offset);
      range.setEnd(endLoc.node, endLoc.offset);
    } catch { return null; }
    return range;
  }
  function commonSuffixLen(a, b) {
    let i = 0;
    const min = Math.min(a.length, b.length);
    while (i < min && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }
  function commonPrefixLen(a, b) {
    let i = 0;
    const min = Math.min(a.length, b.length);
    while (i < min && a[i] === b[i]) i++;
    return i;
  }
  // Find the element whose data-tdoc-aid EQUALS `aid`, without ever putting the
  // (untrusted, commenter-supplied) aid into a selector string. Returns the
  // first match or null.
  function matchByAid(aid) {
    if (aid == null) return null;
    const target = String(aid);
    const all = document.querySelectorAll('[data-tdoc-aid]');
    for (let i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-tdoc-aid') === target) return all[i];
    }
    return null;
  }
  function findElement(anchor) {
    if (!anchor) return null;
    // Server-side reconciliation may have marked the anchor as lost — the
    // artifact is gone in this version. Render unanchored, never guess.
    if (anchor.kind === 'lost') return null;

    // 1. IDENTITY-FIRST: anchor.aid is the artifact's content-derived id
    //    stamped by the worker. Same artifact across versions = same aid
    //    iff its content didn't change. When content DID change between
    //    versions, the worker mints a new aid in the new version AND
    //    keeps the old aid in `anchor.aid_history` (newest first) so that
    //    viewers of OLDER versions still resolve to the same comment.
    const aidCandidates = [];
    if (anchor.aid) aidCandidates.push(anchor.aid);
    if (Array.isArray(anchor.aid_history)) {
      for (const x of anchor.aid_history) if (x && !aidCandidates.includes(x)) aidCandidates.push(x);
    }
    const fromSelector = anchor.selector && (/\[data-tdoc-aid="([^"]+)"\]/.exec(anchor.selector) || [])[1];
    if (fromSelector && !aidCandidates.includes(fromSelector)) aidCandidates.push(fromSelector);
    if (aidCandidates.length) {
      for (const aid of aidCandidates) {
        // Match by attribute EQUALITY, never by interpolating the aid into a
        // selector string. `aid` is server-stored anchor data a commenter can
        // craft; building `[data-tdoc-aid="${aid}"]` lets a value like
        // `x"], body, [...` break out of the attribute selector (anchor onto
        // the wrong element) or throw an uncaught SyntaxError that aborts
        // refreshComments for every viewer. Equality match can do neither.
        const byAid = matchByAid(aid);
        if (byAid) return byAid;
      }
      // Recorded aid(s), none present in this DOM → unanchored, never fallback.
      return null;
    }

    // 2. LEGACY PATH (pre-aid comments): try the stored selector, but
    //    NEVER trust the result without fingerprint validation. A bare
    //    positional selector can silently point at a different artifact.
    let bySelector = null;
    if (anchor.selector) {
      try { bySelector = document.querySelector(anchor.selector); } catch { bySelector = null; }
    }
    const fp = anchor.fingerprint;

    // 2a. Has fingerprint: trust selector ONLY if it matches the fp,
    //     otherwise scan all candidates.
    if (fp) {
      if (bySelector && fingerprintScore(fp, elementFingerprint(bySelector)) >= 0.6) {
        return bySelector;
      }
      let best = null, bestScore = 0;
      const tag = fp.tag || '*';
      let cands;
      try { cands = document.querySelectorAll(tag); } catch { cands = []; }
      cands.forEach(el => {
        if (el.closest && el.closest(UI_ALL)) return;
        const sc = fingerprintScore(fp, elementFingerprint(el));
        if (sc > bestScore) { bestScore = sc; best = el; }
      });
      if (best && bestScore >= 0.6) return best;
      // No confident match → unanchored, never the wrong artifact.
      return null;
    }

    // 2b. No fingerprint AND no aid (truly legacy). Validate the selector
    //     match against the stored `label` (the artifact's tag). If the
    //     tag matches, accept it — but this path is fragile and the
    //     server-side reconciliation should convert these to aid anchors
    //     on the next upload, after which we never hit this branch again.
    if (bySelector && (!anchor.label || bySelector.tagName.toLowerCase() === anchor.label.toLowerCase())) {
      return bySelector;
    }
    return null;
  }

  // Fallback span path — only used when CSS.highlights is unavailable AND the
  // range is single-text-node (no cross-element risk → no empty bars).
  function fallbackWrapAsSpan(comment, range) {
    if (range.startContainer !== range.endContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const mark = document.createElement('span');
    mark.className = 'tdoc-anchor-mark';
    mark.dataset.commentId = comment.id;
    try { range.surroundContents(mark); return mark; } catch { return null; }
  }
  function unwrapFallbackSpans() {
    document.querySelectorAll('.tdoc-anchor-mark').forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize?.();
    });
  }

  // ========== Reactions + comment cards ==========
  const QUICK_EMOJIS = ['👍', '❤️', '🔥', '🎉', '😂', '🤔', '👀', '🚀', '✅', '❌', '❓', '❗'];
  const QUICK_TEXT_REACTIONS = ['LGTM'];
  // Text reactions (LGTM) must invert with the page so they stay readable.
  // Color emoji are bitmaps — wrap them so dark mode can restore native colors.
  function renderReactionGlyph(s) {
    const safe = escapeHtml(s);
    if (QUICK_TEXT_REACTIONS.includes(s)) return safe;
    return `<span class="tdoc-emoji">${safe}</span>`;
  }
  const REACT_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/><line x1="19" y1="6" x2="19" y2="10"/><line x1="21" y1="8" x2="17" y2="8"/></svg>`;

  // Known coding-agent runtimes → brand mark. Honor an explicit avatar_url
  // first; otherwise map login/name. Unmatched names use the tdoc project
  // mark (not a lightning bolt). Never show github.com/anthropics.png —
  // that is Anthropic's "AI" wordmark, not Claude's product star.
  function isAnthropicCompanyMark(url) {
    return typeof url === 'string' && /(?:^|\/\/)(?:www\.)?github\.com\/anthropics(?:\.png)?(?:[/?#]|$)/i.test(url);
  }
  function tdocLogoUrl() {
    return '/tdoc_logo.svg';
  }
  function agentLogoUrl(author) {
    const stored = (author && typeof author.avatar_url === 'string' && /^https:\/\//i.test(author.avatar_url))
      ? author.avatar_url : null;
    const key = String((author && (author.login || author.name)) || '').toLowerCase();
    if (key.includes('claude') || key.includes('anthropic') || isAnthropicCompanyMark(stored)) {
      return 'https://cdn.simpleicons.org/claude/d97757';
    }
    if (stored) return stored;
    if (key.includes('grok') || key.includes('xai')) return 'https://github.com/xai-org.png';
    if (key.includes('codex') || key.includes('openai') || key.includes('chatgpt') || key === 'gpt' || key.startsWith('gpt-')) {
      return 'https://github.com/openai.png';
    }
    if (key.includes('gemini') || key.includes('bard')) return 'https://cdn.simpleicons.org/googlegemini/8e75b2';
    if (key.includes('cursor') || key.includes('composer')) return 'https://cdn.simpleicons.org/cursor/000000';
    return tdocLogoUrl();
  }
  function renderAuthor(author) {
    if (!author) return `<div class="author"><span class="anon">anonymous</span></div>`;
    if (author.kind === 'agent') {
      const label = author.name || author.login || 'tdoc-agent';
      const title = author.login && author.name && author.login !== author.name ? author.login : label;
      const logo = agentLogoUrl(author);
      const mark = `<img src="${escapeHtml(logo)}" alt="" data-tdoc-fallback-anon="tdoc-agent-badge">`;
      return `<div class="author tdoc-agent-author" title="${escapeHtml(title)}">${mark}<span class="login">${escapeHtml(label)}</span></div>`;
    }
    const avatar = author.avatar_url ? `<img src="${escapeHtml(author.avatar_url)}" alt="">` : '';
    return `<div class="author">${avatar}<span class="login">${escapeHtml(author.login || 'anonymous')}</span></div>`;
  }
  function renderReactionsRow(target) {
    const reactions = target.reactions || {};
    const me = identity?.login || 'anon';
    const entries = Object.entries(reactions).filter(([, u]) => u && u.length > 0);
    if (!entries.length) return '';
    const chips = entries.map(([emoji, users]) => {
      const mine = users.includes(me);
      const hasAgent = users.some(u => u === 'tdoc-agent' || /agent|codex|claude/i.test(u));
      const cls = [`tdoc-react-chip`, mine ? 'mine' : '', hasAgent ? 'agent' : ''].filter(Boolean).join(' ');
      return `<span class="${cls}" data-emoji="${escapeHtml(emoji)}" data-target-id="${escapeHtml(target.id)}" data-users="${users.map(escapeHtml).join('\n')}">${renderReactionGlyph(emoji)} ${users.length}</span>`;
    }).join('');
    return `<div class="tdoc-reactions" data-target-id="${escapeHtml(target.id)}">${chips}<button class="tdoc-react-add" data-target-id="${escapeHtml(target.id)}" title="Add reaction" aria-label="Add reaction">${REACT_ICON_SVG}</button></div>`;
  }
  function renderReactInline(target) {
    return `<button class="tdoc-react-add inline" data-target-id="${escapeHtml(target.id)}" title="Add reaction" aria-label="Add reaction">${REACT_ICON_SVG}</button>`;
  }
  function childrenOf(replies, parentId, rootId) {
    return (replies || []).filter(r => (r.parent_id || rootId) === parentId);
  }
  function replyFormHTML(parentId, hint) {
    if (isFork) return '';
    return `<div class="tdoc-reply-form" data-parent-id="${escapeHtml(parentId)}">
      ${hint ? `<div class="tdoc-reply-to">${escapeHtml(hint)}</div>` : ''}
      <textarea placeholder="Reply…"></textarea>
      <div class="tdoc-reply-form-foot">
        <span class="hint">⌘+Enter to submit · Esc to cancel</span>
        <button class="tdoc-reply-submit">Reply</button>
      </div>
    </div>`;
  }
  function renderReply(reply, allReplies, rootId, depth) {
    const canDelete = !isFork && (!isPublished || (identity && reply.author && identity.login === reply.author.login));
    const hasReactions = reply.reactions && Object.values(reply.reactions).some(u => u && u.length > 0);
    const isAgent = reply.author?.kind === 'agent';
    // Whitelist the status (it drives a CSS class) instead of interpolating raw.
    const safeStatus = ['applied', 'partial', 'question'].includes(reply.agent_status) ? reply.agent_status : null;
    const statusChip = safeStatus
      ? `<span class="tdoc-agent-status tdoc-agent-status-${safeStatus}">${
          safeStatus === 'applied' ? '✓ applied' :
          safeStatus === 'partial' ? '◐ partial' :
          '? question'
        }</span>`
      : '';
    const kids = childrenOf(allReplies, reply.id, rootId);
    const who = reply.author?.login || reply.author?.name || 'this reply';
    const hint = reply.id !== rootId ? `Replying to @${who}` : '';
    return `<div class="tdoc-reply${isAgent ? ' tdoc-agent-reply' : ''}" data-comment-id="${escapeHtml(reply.id)}" data-depth="${depth}">
      ${renderAuthor(reply.author)}
      ${statusChip}
      <div class="text">${escapeHtml(reply.text)}</div>
      ${hasReactions ? renderReactionsRow(reply) : ''}
      <div class="meta">
        <span>${new Date(reply.created).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        <span class="actions">
          ${!hasReactions && !isFork ? renderReactInline(reply) : ''}
          ${isFork ? '' : `<span class="tdoc-reply-toggle" data-id="${escapeHtml(reply.id)}">Reply</span>`}
          ${canDelete ? `<span class="del" data-id="${escapeHtml(reply.id)}">delete</span>` : ''}
        </span>
      </div>
      ${replyFormHTML(reply.id, hint)}
      ${kids.length ? `<div class="tdoc-reply-kids">${kids.map(k => renderReply(k, allReplies, rootId, depth + 1)).join('')}</div>` : ''}
    </div>`;
  }
  function buildCard(comment) {
    const card = document.createElement('div');
    card.className = 'tdoc-margin-comment';
    card.dataset.commentId = comment.id;
    const canDelete = !isFork && (!isPublished || (identity && comment.author && identity.login === comment.author.login));
    const replies = Array.isArray(comment.replies) ? comment.replies : [];
    const hasReactions = comment.reactions && Object.values(comment.reactions).some(u => u && u.length > 0);
    // A comment the agent has marked applied is "resolved". Surface it on the
    // parent card (status === 'applied' set by the worker's marked_applied event),
    // and expand its replies so the agent's resolution is visible, not buried.
    const isResolved = comment.status === 'applied';
    const verdict = comment._agentVerdict || 'applied';
    const resolvedBy = comment._agentActor || comment.agent_actor || 'tdoc-agent';
    const resolvedChip = isResolved
      ? `<span class="tdoc-resolved-chip" title="Resolved by ${escapeHtml(resolvedBy)}${comment.applied_in ? ' in v' + escapeHtml(String(comment.applied_in)) : ''}">✓ ${
          verdict === 'partial' ? 'partially fixed' : verdict === 'question' ? 'needs input' : 'fixed'
        }${comment.applied_in ? ' · v' + escapeHtml(String(comment.applied_in)) : ''}</span>`
      : '';
    if (isResolved) card.classList.add('tdoc-resolved');
    card.innerHTML = `
      ${isFork ? '' : `<div class="tdoc-anchor-actions">
        <button class="tdoc-reanchor-btn" type="button" data-id="${escapeHtml(comment.id)}"><span class="tdoc-reanchor-unanchored">unanchored — click to re-anchor</span><span class="tdoc-reanchor-anchored">↻ move anchor</span></button>
      </div>`}
      ${resolvedChip}
      ${renderAuthor(comment.author)}
      <div class="text">${escapeHtml(comment.text)}</div>
      ${hasReactions ? renderReactionsRow(comment) : ''}
      <div class="meta">
        <span>v${comment.version} · ${new Date(comment.created).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        <span class="actions">
          ${!hasReactions && !isFork ? renderReactInline(comment) : ''}
          ${isFork ? '' : `<span class="tdoc-reply-toggle" data-id="${escapeHtml(comment.id)}">Reply</span>`}
          <span class="copy-md" data-id="${escapeHtml(comment.id)}" title="Copy as Markdown" aria-label="Copy as Markdown"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span>
          ${canDelete ? `<span class="del" data-id="${escapeHtml(comment.id)}">delete</span>` : ''}
        </span>
      </div>
      ${replies.length ? (() => {
        // Replies are COLLAPSED by default — including agent replies and
        // resolved threads. The parent already carries a "✓ fixed · vN" chip,
        // so the resolution is visible at a glance; the full agent reply stays
        // folded under "N reply" until the reader expands it. Keeps the margin
        // column quiet instead of stacking long bot replies inline.
        const autoOpen = state.openReplyThreads.has(comment.id);
        const tops = childrenOf(replies, comment.id, comment.id);
        // Orphans (parent reply deleted) still show under the thread root.
        const ids = new Set(replies.map(r => r.id).concat([comment.id]));
        const orphans = replies.filter(r => r.parent_id && !ids.has(r.parent_id));
        const roots = tops.concat(orphans.filter(o => !tops.includes(o)));
        return `
        <div class="tdoc-replies-toggle${autoOpen ? ' open' : ''}" data-id="${escapeHtml(comment.id)}">
          <svg class="chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}
        </div>
        <div class="tdoc-replies${autoOpen ? ' open' : ''}">${roots.map(r => renderReply(r, replies, comment.id, 1)).join('')}</div>
      `; })() : ''}
      ${replyFormHTML(comment.id, '')}
    `;

    const repliesToggle = card.querySelector('.tdoc-replies-toggle');
    const repliesEl = card.querySelector('.tdoc-replies');
    if (repliesToggle && repliesEl) {
      repliesToggle.onclick = (e) => {
        e.stopPropagation();
        const open = repliesEl.classList.toggle('open');
        repliesToggle.classList.toggle('open', open);
        if (open) state.openReplyThreads.add(comment.id);
        else state.openReplyThreads.delete(comment.id);
        requestAnimationFrame(repositionCards);
      };
    }

    const copyMdBtn = card.querySelector('.copy-md');
    if (copyMdBtn) copyMdBtn.onclick = (e) => { e.stopPropagation(); window.__tdocCopyCommentMd(comment.id, copyMdBtn); };

    const reBtn = card.querySelector('.tdoc-reanchor-btn');
    if (reBtn) reBtn.onclick = (e) => { e.stopPropagation(); startReanchor(comment.id); };

    card.querySelectorAll('.del').forEach(del => {
      del.onclick = async (e) => {
        e.stopPropagation();
        const r = await fetch(`/api/comments?slug=${encodeURIComponent(slug)}&id=${del.dataset.id}&version=${version}`, { method: 'DELETE' });
        if (!r.ok) {
          // Surface the failure instead of silently re-rendering the comment.
          const err = await r.json().catch(() => ({}));
          alert('Could not delete: ' + (err.error || err.message || `HTTP ${r.status}`));
          return;
        }
        // Belt + suspenders: drop the active highlight before refresh in case
        // the deleted comment was the active one (which would leave a stale
        // ::highlight(tdoc-anchor-active) ring until refresh completes).
        setActiveComment(null);
        await refreshComments();
      };
    });

    const wireReplyForm = (replyForm) => {
      const parentId = replyForm.dataset.parentId;
      const toggle = card.querySelector(`.tdoc-reply-toggle[data-id="${CSS.escape(parentId)}"]`);
      if (toggle) {
        toggle.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isPublished && !identity) { startDeviceFlow(); return; }
          // Pin so a hover-opened card does not collapse when the pointer
          // leaves the pin or the form opening shifts layout.
          pinOpenCard(comment.id);
          state.openReplyThreads.add(comment.id);
          const repliesEl = card.querySelector('.tdoc-replies');
          const repliesToggle = card.querySelector('.tdoc-replies-toggle');
          if (repliesEl && repliesEl.childElementCount) {
            repliesEl.classList.add('open');
            repliesToggle?.classList.add('open');
          }
          card.querySelectorAll('.tdoc-reply-form.open').forEach(f => { if (f !== replyForm) f.classList.remove('open'); });
          replyForm.classList.toggle('open');
          if (replyForm.classList.contains('open')) {
            replyForm.querySelector('textarea').focus();
            requestAnimationFrame(() => positionFloatingCard(comment.id));
          }
        };
      }
      const replyTa = replyForm.querySelector('textarea');
      const submitReply = async () => {
        const text = replyTa.value.trim();
        if (!text) return;
        let r;
        try {
          r = await fetch('/api/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug, parent_id: parentId, text, version })
          });
        } catch (e) {
          alert('Could not post reply: network error'); // keep the text — don't clear
          return;
        }
        if (r.status === 401) { startDeviceFlow(); return; }
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          alert('Could not post reply: ' + (err.error || err.message || `HTTP ${r.status}`));
          return; // preserve the typed reply so it isn't silently lost
        }
        replyTa.value = '';
        replyForm.classList.remove('open');
        // Keep this thread expanded after refresh — posting a reply must
        // not fold the list the user was just looking at.
        state.openReplyThreads.add(comment.id);
        pinOpenCard(comment.id);
        await refreshComments();
      };
      replyForm.querySelector('.tdoc-reply-submit').onclick = (e) => { e.stopPropagation(); submitReply(); };
      replyTa.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitReply(); }
        if (e.key === 'Escape') { replyForm.classList.remove('open'); requestAnimationFrame(repositionCards); }
      });
    };
    card.querySelectorAll('.tdoc-reply-form').forEach(wireReplyForm);

    card.querySelectorAll('.tdoc-react-chip').forEach(chip => {
      chip.onclick = async (e) => {
        e.stopPropagation();
        if (isFork) return; // read-only mode
        if (isPublished && !identity) { startDeviceFlow(); return; }
        if (await postReaction(chip.dataset.targetId, chip.dataset.emoji)) await refreshComments();
      };
    });
    card.querySelectorAll('.tdoc-react-add').forEach(addBtn => {
      addBtn.onclick = (e) => {
        e.stopPropagation();
        if (isPublished && !identity) { startDeviceFlow(); return; }
        openEmojiPicker(addBtn, addBtn.dataset.targetId);
      };
    });

    card.addEventListener('click', (e) => { e.stopPropagation(); setActiveComment(comment.id); });
    return card;
  }

  // Submit a reaction toggle. Centralizes error handling the two call sites
  // (react chip + emoji picker) were missing: on an expired session the server
  // returns 401 — re-auth instead of silently dropping the click; on network
  // failure, swallow rather than leaving an unhandled promise rejection.
  // Returns true if the caller should refresh.
  async function postReaction(targetId, emoji) {
    try {
      const r = await fetch('/api/reactions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, comment_id: targetId, emoji, version }),
      });
      if (r.status === 401) { if (isPublished) startDeviceFlow(); return false; }
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert('Could not react: ' + (err.error || err.message || `HTTP ${r.status}`));
        return false;
      }
      return true;
    } catch (e) {
      alert('Could not react: network error');
      return false;
    }
  }

  // ========== Emoji picker ==========
  let emojiPicker = null;
  function closeEmojiPicker() { if (emojiPicker) { emojiPicker.remove(); emojiPicker = null; } }
  function openEmojiPicker(anchorBtn, targetId) {
    closeEmojiPicker();
    emojiPicker = document.createElement('div');
    emojiPicker.className = 'tdoc-emoji-picker';
    emojiPicker.innerHTML =
      QUICK_EMOJIS.map(e => `<button data-emoji="${e}">${renderReactionGlyph(e)}</button>`).join('') +
      QUICK_TEXT_REACTIONS.map(t => `<button class="tdoc-emoji-text" data-emoji="${t}">${t}</button>`).join('');
    document.body.appendChild(emojiPicker);
    const r = anchorBtn.getBoundingClientRect();
    emojiPicker.style.visibility = 'hidden';
    emojiPicker.style.top = '0'; emojiPicker.style.left = '0';
    const pw = emojiPicker.offsetWidth, ph = emojiPicker.offsetHeight;
    let left = window.scrollX + r.left;
    let top = window.scrollY + r.bottom + 6;
    const vpRight = window.scrollX + window.innerWidth - 8;
    if (left + pw > vpRight) left = Math.max(8, (window.scrollX + r.right) - pw);
    const vpBottom = window.scrollY + window.innerHeight - 8;
    if (top + ph > vpBottom) top = window.scrollY + r.top - ph - 6;
    emojiPicker.style.top = top + 'px'; emojiPicker.style.left = left + 'px';
    emojiPicker.style.visibility = '';
    emojiPicker.querySelectorAll('button').forEach(b => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const emoji = b.dataset.emoji;
        closeEmojiPicker();
        if (await postReaction(targetId, emoji)) await refreshComments();
      };
    });
  }

  // ========== Card positioning + active state ==========
  // Single source of truth for "where does the article column live?".
  // Returns viewport-coord metrics for the widest non-UI container element.
  // Caller can add window.scrollX to `right`/`left` for page coords.
  const ARTICLE_EXCLUDE = UI_CONTAINERS;
  function getArticleMetrics() {
    const candidates = document.querySelectorAll('main, article, .wrap, .content, .container');
    let best = null, bestRect = null, bestW = 0;
    for (const el of candidates) {
      if (el.closest(ARTICLE_EXCLUDE)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > bestW && r.width > 200 && r.width < window.innerWidth) {
        best = el; bestRect = r; bestW = r.width;
      }
    }
    if (best) {
      return { el: best, width: bestRect.width, right: bestRect.right, left: bestRect.left };
    }
    // Fallback: pick the widest prose-ish element so margin cards have somewhere
    // to anchor on pages with no wrapping container.
    let fbRight = 0, fbLeft = 0, fbW = 0;
    for (const el of document.querySelectorAll('p, h1, h2, h3')) {
      if (el.closest(ARTICLE_EXCLUDE)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > fbW && r.width > 300 && r.width < window.innerWidth) {
        fbW = r.width; fbRight = r.right; fbLeft = r.left;
      }
    }
    if (fbW > 0) {
      return { el: document.body, width: fbW, right: fbRight, left: fbLeft };
    }
    return { el: document.body, width: Infinity, right: 0, left: 0 };
  }

  // The X position of the gutter (where pins sit) and where a floating card
  // opens (just left of the gutter). Computed from the article metrics.
  const PIN_SIZE = 28;
  function gutterGeometry() {
    const cardWidth = 280, pinGap = 12;
    const metrics = getArticleMetrics();
    const rightEdge = metrics.width > 0 && metrics.right > 0
      ? metrics.right + window.scrollX
      : window.innerWidth - 360;
    // Pins live in a thin column hugging the article edge. The floating card
    // opens to the RIGHT of the pins so the two never collide.
    let pinLeft = rightEdge + pinGap;
    let cardLeft = pinLeft + PIN_SIZE + pinGap;   // card clears the pin column
    const maxLeft = window.scrollX + window.innerWidth - cardWidth - 12;
    if (cardLeft > maxLeft) {
      cardLeft = maxLeft;
      pinLeft = Math.max(rightEdge + pinGap, cardLeft - PIN_SIZE - pinGap);
    }
    const articleEl = metrics.el || document.body;
    const articleTop = articleEl.getBoundingClientRect().top + window.scrollY;
    const articleHeight = Math.max(1, articleEl.scrollHeight);
    return { cardWidth, cardLeft, pinLeft, articleTop, articleHeight, articleEl };
  }

  // Resolve each comment's vertical page position from its anchor (live range/
  // element) or saved fallback ratio. Returns {c, y, anchored} or null.
  function commentY(c, geo) {
    const mark = state.anchorMarks.get(c.id);
    if (mark && (mark.ranges?.[0] || mark.el)) {
      const target = mark.ranges?.[0] || mark.el;
      const r = firstVisibleClientRect(target) || target.getBoundingClientRect();
      // For element anchors expose the element + its rect so renderPins can
      // spread multiple comments DOWN a tall element instead of stacking them
      // all at its top edge. (targetEl is the live element; el may be the outline.)
      const el = mark.kind === 'element' ? (mark.targetEl || mark.el) : null;
      return { c, y: r.top + window.scrollY, anchored: true, el, elTop: r.top + window.scrollY, elHeight: r.height };
    }
    if (c.anchor?.fallback && typeof c.anchor.fallback.ratio === 'number') {
      return { c, y: geo.articleTop + c.anchor.fallback.ratio * geo.articleHeight, anchored: false };
    }
    return null;
  }

  function repositionCards() {
    // Always reposition element outlines first — they should track their
    // anchor element on every layout change regardless of narrow/wide mode.
    document.querySelectorAll('.tdoc-element-outline:not(.pending)').forEach(o => o._reposition?.());
    if (state.narrow) {
      // Narrow mode is unchanged: cards flow in the bottom drawer, no pins.
      for (const card of state.cardEls.values()) { card.style.top = ''; card.style.left = ''; }
      return;
    }
    // Wide mode: render PINS, not a card stack. Each comment becomes a pin at
    // its Y; pins within SAME_LINE_GAP px merge into one count badge. The floating
    // card (hover/click) is positioned separately by openFloatingCard().
    renderPins();
    // Re-place an open card next to its pin. Do not lock it to the viewport —
    // the card is document-absolute and should scroll away with the page.
    if (state.pinnedId) positionFloatingCard(state.pinnedId);
    else if (state.hoverId) positionFloatingCard(state.hoverId);
  }

  // Clustering and overlap-prevention are SEPARATE concerns:
  //  - SAME_LINE_GAP: only comments truly on the same line (centers within this)
  //    merge into a count badge. Tight, so a roomy doc shows individual pins.
  //  - PIN_MIN_GAP: minimum center-to-center spacing. Pins that would otherwise
  //    overlap are pushed DOWN (spread), NOT clustered — as long as there's room.
  //  - When pushing down would run past the article bottom (genuinely no room),
  //    the overflowing tail merges into one badge so the column can't overflow.
  const SAME_LINE_GAP = 12;          // px: true co-location threshold
  const PIN_MIN_GAP = PIN_SIZE + 4;  // 32px: min spacing between spread pins

  // PURE layout core (steps 0-2), extracted so it's unit-testable without a DOM
  // (see test/pins-layout.test.js). Takes Y-positioned rows [{y, el, elTop,
  // elHeight, c}], the gutter geometry {articleTop, articleHeight}, and the
  // spacing constants; returns the placed clusters [{y, items:[row,...]}].
  // MUTATES row.y (same-element spread) — callers pass rows they own.
  // Invariant: no placed cluster's y exceeds articleTop+articleHeight once at
  // least one cluster is placed (the overflow tail folds into the last pin).
  function layoutPins(rows, geo, consts) {
    const { PIN_SIZE, PIN_MIN_GAP, SAME_LINE_GAP } = consts;

    // 0) Spread comments that share the SAME element anchor down that element's
    //    height. Element anchors all resolve to the element's TOP edge, so N
    //    comments on one tall canvas/SVG/image would otherwise stack at one Y
    //    and merge into a single "N" badge — even with plenty of room. Distribute
    //    them evenly along the element (capped to PIN_MIN_GAP spacing) so they
    //    show as individual pins; comments on a SHORT element still cluster.
    const byEl = new Map();
    for (const r of rows) {
      if (!r.el) continue;
      if (!byEl.has(r.el)) byEl.set(r.el, []);
      byEl.get(r.el).push(r);
    }
    for (const [, group] of byEl) {
      if (group.length < 2) continue;
      const top = group[0].elTop, h = group[0].elHeight || 0;
      const usable = Math.max(0, h - PIN_SIZE);
      if (usable < PIN_MIN_GAP) continue; // element too short to spread → let them cluster
      // Even spacing down the element, but never tighter than PIN_MIN_GAP (a
      // short-ish element with many comments still spreads as far as it can,
      // then the overflow logic later folds any tail into a badge).
      const step = Math.max(PIN_MIN_GAP, usable / (group.length - 1));
      group.forEach((r, i) => { r.y = top + i * step; });
    }
    rows.sort((a, b) => a.y - b.y);

    // 1) Merge ONLY genuinely same-line comments into clusters (tight gap).
    const clusters = [];
    for (const row of rows) {
      const last = clusters[clusters.length - 1];
      if (last && row.y - last.maxY <= SAME_LINE_GAP) {
        last.items.push(row);
        last.maxY = row.y;
        last.y = (last.items[0].y + row.y) / 2;
      } else {
        clusters.push({ y: row.y, maxY: row.y, items: [row] });
      }
    }

    // 2) Spread to prevent overlap. Push each pin to >= prev + PIN_MIN_GAP. If a
    //    pin would land below the article bottom (no vertical room left), fold it
    //    and everything after into the previous cluster as an overflow badge.
    const bottomLimit = geo.articleTop + geo.articleHeight; // page space we may use
    const placed = [];
    let prevY = -Infinity;
    for (const cl of clusters) {
      const y = Math.max(cl.y, prevY + PIN_MIN_GAP);
      if (y > bottomLimit && placed.length) {
        // No room: merge this cluster's items into the last placed pin (overflow).
        const tail = placed[placed.length - 1];
        tail.items.push(...cl.items);
        continue;
      }
      cl.y = y;
      placed.push(cl);
      prevY = y;
    }
    return placed;
  }

  function renderPins() {
    const geo = gutterGeometry();
    // Y-sorted list of placeable comments.
    const rows = state.activeComments.map(c => commentY(c, geo)).filter(Boolean);
    const placed = layoutPins(rows, geo, { PIN_SIZE, PIN_MIN_GAP, SAME_LINE_GAP });

    // 3) Reconcile pin elements: stable pin per cluster keyed by member ids.
    const seen = new Set();
    for (const cl of placed) {
      const key = cl.items.map(r => r.c.id).sort().join('|');
      seen.add(key);
      let pin = pinLayer.querySelector(`.tdoc-pin[data-key="${CSS.escape(key)}"]`);
      if (!pin) {
        pin = buildPin(cl);
        pin.dataset.key = key;
        pinLayer.appendChild(pin);
      }
      pin.style.top = (cl.y - PIN_SIZE / 2) + 'px';
      pin.style.left = geo.pinLeft + 'px';   // pins in their own gutter, left of cards
    }
    // Remove stale pins (cluster membership changed).
    pinLayer.querySelectorAll('.tdoc-pin').forEach(p => { if (!seen.has(p.dataset.key)) p.remove(); });

    // No ghost dashes in pins mode — the pin itself is the marker.
    document.querySelectorAll('.tdoc-ghost-marker').forEach(el => el.remove());
  }

  function avatarHTML(author, anonClass) {
    const url = (author && author.kind === 'agent') ? agentLogoUrl(author) : author?.avatar_url;
    // If the avatar 404s / is CORS-blocked, the document-level capture-phase
    // 'error' listener installed at boot swaps the broken <img> for the anon
    // placeholder (data-tdoc-fallback-anon carries which class to use) — no
    // inline onerror= attribute, which a nonce-based CSP would block anyway.
    return url
      ? `<img src="${escapeHtml(url)}" alt="" data-tdoc-fallback-anon="${anonClass}">`
      : `<span class="${anonClass}"></span>`;
  }

  function buildPin(cluster) {
    const pin = document.createElement('div');
    pin.className = 'tdoc-pin';
    pin.setAttribute('role', 'button');
    pin.setAttribute('tabindex', '0');
    if (cluster.items.length === 1) {
      const c = cluster.items[0].c;
      const resolved = c.status === 'applied';
      pin.classList.toggle('tdoc-pin-resolved', resolved);
      pin.innerHTML = avatarHTML(c.author, 'tdoc-pin-anon');
      // a11y label only — NOT the native `title` (which renders an ugly dark
      // tooltip box that overlaps the floating card). The card itself is the
      // preview on hover, so no extra tooltip is needed.
      pin.setAttribute('aria-label', `Comment by ${c.author?.login || 'anonymous'}`);
      pin.addEventListener('mouseenter', () => hoverOpen(c.id));
      pin.addEventListener('mouseleave', () => hoverClose(c.id));
      pin.addEventListener('click', (e) => { e.stopPropagation(); togglePin(c.id); });
      pin.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePin(c.id); } });
    } else {
      const allResolved = cluster.items.every(r => r.c.status === 'applied');
      pin.classList.add('tdoc-pin-cluster');
      pin.classList.toggle('tdoc-cluster-allresolved', allResolved);
      pin.textContent = String(cluster.items.length);
      pin.setAttribute('aria-label', `${cluster.items.length} comments here`);
      pin.addEventListener('click', (e) => { e.stopPropagation(); openClusterPopover(cluster, pin); });
      pin.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openClusterPopover(cluster, pin); } });
    }
    return pin;
  }

  // ---- Floating card open/close ----
  function showCard(id) {
    const card = state.cardEls.get(id);
    if (!card) return;
    // Only one floating card at a time.
    document.querySelectorAll('.tdoc-margin-comment.tdoc-floating-open').forEach(el => {
      if (el !== card) el.classList.remove('tdoc-floating-open');
    });
    card.classList.add('tdoc-floating-open');
    positionFloatingCard(id);
  }
  function hideCardIfIdle(id) {
    if (state.pinnedId === id || state.hoverId === id) return;
    const card = state.cardEls.get(id);
    // A Reply form in progress must keep the card up — clicking Reply used
    // to close a hover-opened card as soon as the cursor left the pin.
    if (card && card.querySelector('.tdoc-reply-form.open')) return;
    if (card) card.classList.remove('tdoc-floating-open');
  }
  function pinOpenCard(id) {
    if (state.narrow || !id) return;
    state.pinnedId = id;
    state.hoverId = id;
    showCard(id);
    markPinActive(id, true);
  }
  function positionFloatingCard(id) {
    const card = state.cardEls.get(id);
    if (!card) return;
    const geo = gutterGeometry();
    const row = commentY(state.activeComments.find(c => c.id === id), geo);
    const y = row ? row.y : geo.articleTop;
    card.style.left = geo.cardLeft + 'px';
    // Park at the pin's document Y. Do not clamp to the viewport — that made
    // an expanded card stick to the camera as the user scrolled.
    card.style.top = y + 'px';
  }
  function hoverOpen(id) {
    state.hoverId = id;
    showCard(id);
    markPinActive(id, true);
  }
  function hoverClose(id) {
    if (state.hoverId === id) state.hoverId = null;
    // Small delay so moving the cursor from pin into the card doesn't close it.
    setTimeout(() => { if (state.hoverId !== id) { hideCardIfIdle(id); markPinActive(id, state.pinnedId === id); } }, 120);
  }
  function togglePin(id) {
    if (state.pinnedId === id) { state.pinnedId = null; hideCardIfIdle(id); markPinActive(id, false); setActiveComment(null); return; }
    state.pinnedId = id;
    showCard(id);
    markPinActive(id, true);
    setActiveComment(id);
  }
  function markPinActive(id, on) {
    const c = state.activeComments.find(x => x.id === id);
    if (!c) return;
    pinLayer.querySelectorAll('.tdoc-pin').forEach(p => {
      if ((p.dataset.key || '').split('|').includes(id)) p.classList.toggle('tdoc-pin-active', !!on);
    });
  }

  // ---- Cluster popover ----
  function openClusterPopover(cluster, pin) {
    if (clusterPop.classList.contains('open') && clusterPop._key === pin.dataset.key) { closeClusterPopover(); return; }
    clusterPop._key = pin.dataset.key;
    clusterPop.innerHTML = cluster.items.map(r => {
      const c = r.c;
      const done = c.status === 'applied' ? '<span class="tdoc-cluster-done">✓</span>' : '';
      const cur = c.id === state.pinnedId ? ' tdoc-cluster-current' : '';
      return `<div class="tdoc-cluster-row${cur}" role="button" tabindex="0" data-id="${escapeHtml(c.id)}">
        ${avatarHTML(c.author, 'tdoc-cluster-anon')}
        <span class="tdoc-cluster-snip">${escapeHtml((c.text || '').slice(0, 60))}</span>${done}
      </div>`;
    }).join('');
    const pickRow = (rowEl) => { closeClusterPopover(); togglePin(rowEl.dataset.id); };
    clusterPop.querySelectorAll('.tdoc-cluster-row').forEach(rowEl => {
      rowEl.onclick = (e) => { e.stopPropagation(); pickRow(rowEl); };
      rowEl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); pickRow(rowEl); } };
    });
    // Position the popover to the LEFT of the pin, then clamp to the viewport
    // on both axes so a tall (many-row) or edge-of-screen popover never spills
    // off-screen. Height is capped by CSS (max-height:60vh + scroll).
    clusterPop.classList.add('open');           // make it measurable
    const popW = clusterPop.offsetWidth || 260;
    const popH = clusterPop.offsetHeight || 200;
    const pinRect = pin.getBoundingClientRect();
    let left = pinRect.left + window.scrollX - popW - 8;
    if (left < window.scrollX + 8) left = pinRect.right + window.scrollX + 8; // flip right if no room left
    let top = pinRect.top + window.scrollY;
    const maxTop = window.scrollY + window.innerHeight - popH - 8;
    if (top > maxTop) top = Math.max(window.scrollY + 56, maxTop);
    clusterPop.style.left = left + 'px';
    clusterPop.style.top = top + 'px';
  }
  function closeClusterPopover() { clusterPop.classList.remove('open'); clusterPop._key = null; }
  document.addEventListener('click', (e) => {
    // Click anywhere outside an open new-comment sheet cancels it (and clears
    // the pending highlight). Skip the same click cycle that opened it — the
    // data-tdoc-select path opens on click, which would otherwise self-close.
    if (popup && !popup.contains(e.target) && performance.now() - popupOpenedAt > 250) closePopup();
    if (!clusterPop.contains(e.target) && !e.target.closest?.('.tdoc-pin-cluster')) closeClusterPopover();
    // Inbox / Share / profile chrome is overlay UI. A click there must not
    // count as "outside the card" or opening a notification would pin the
    // comment and the same click would immediately unpin it.
    if (isInUI(e.target)) return;
    // Click outside an open pinned card (and not on a pin) unpins it.
    if (state.pinnedId && !e.target.closest?.('.tdoc-margin-comment') && !e.target.closest?.('.tdoc-pin')) {
      const id = state.pinnedId; state.pinnedId = null; hideCardIfIdle(id); markPinActive(id, false);
    }
  });
  // Keep a hover-opened card alive while the cursor is over the card itself.
  commentLayer.addEventListener('mouseenter', (e) => {
    const card = e.target.closest?.('.tdoc-margin-comment.tdoc-floating-open');
    if (card) { const id = [...state.cardEls.entries()].find(([, el]) => el === card)?.[0]; if (id) state.hoverId = id; }
  }, true);
  commentLayer.addEventListener('mouseleave', (e) => {
    const card = e.target.closest?.('.tdoc-margin-comment.tdoc-floating-open');
    if (!card) return;
    // Capture-phase mouseleave fires for every child. Ignore moves that stay
    // inside the same card (Reply → textarea, layout shift, etc.).
    if (e.relatedTarget && card.contains(e.relatedTarget)) return;
    const id = [...state.cardEls.entries()].find(([, el]) => el === card)?.[0];
    if (id) hoverClose(id);
  }, true);

  function renderGhostMarker(commentId, pageY) {
    let g = document.querySelector(`.tdoc-ghost-marker[data-comment-id="${CSS.escape(commentId)}"]`);
    if (!g) {
      g = document.createElement('div');
      g.className = 'tdoc-ghost-marker';
      g.dataset.commentId = commentId;
      document.body.appendChild(g);
    }
    g.style.top = pageY + 'px';
  }
  function removeGhostMarker(commentId) {
    const g = document.querySelector(`.tdoc-ghost-marker[data-comment-id="${CSS.escape(commentId)}"]`);
    if (g) g.remove();
  }

  function setActiveComment(id) {
    state.activeId = id || null;
    document.querySelectorAll('.tdoc-anchor-mark.active, .tdoc-margin-comment.active, .tdoc-element-outline.active')
      .forEach(el => el.classList.remove('active'));
    if (!id) {
      // Deselect: in pins mode also close any open floating card.
      if (!state.narrow && state.pinnedId) { const prev = state.pinnedId; state.pinnedId = null; hideCardIfIdle(prev); markPinActive(prev, false); }
      rebuildSharedHighlights();
      return;
    }
    const mark = state.anchorMarks.get(id);
    if (mark?.el?.classList) mark.el.classList.add('active');
    const card = state.cardEls.get(id);
    card?.classList.add('active');
    // Pins mode: cards are hidden by default, so selecting a comment (e.g. by
    // CLICKING ITS HIGHLIGHTED ANCHOR TEXT) must also open + pin its floating
    // card — otherwise the click just highlights with no visible card. This
    // makes anchor-click symmetric with pin-click.
    if (!state.narrow && state.pinnedId !== id) {
      if (state.pinnedId) markPinActive(state.pinnedId, false);
      state.pinnedId = id;
      showCard(id);
      markPinActive(id, true);
    }
    rebuildSharedHighlights();
    // Do NOT reposition cards on click — only the .active highlight should
    // change. Reordering cards every click is disorienting; users expect
    // stable positions and just the visual cue swap. Cards keep whatever
    // layout repositionCards() established at refresh/resize time.
    scrollAnchorIntoView(id);
    markInboxSeen(id);
  }

  function scrollAnchorIntoView(id) {
    const mark = state.anchorMarks.get(id);
    if (!mark) return;
    let anchorRect = null;
    // Prefer the underlying TARGET ELEMENT (canvas/img/video etc) over the
    // overlay outline div — same rect, but more semantically correct.
    if (mark.ranges?.[0]) anchorRect = firstVisibleClientRect(mark.ranges[0]);
    else if (mark.targetEl) anchorRect = firstVisibleClientRect(mark.targetEl);
    else if (mark.el) anchorRect = firstVisibleClientRect(mark.el);
    if (!anchorRect) return;

    // We consider the anchor "comfortably visible" if its top is between the
    // bar (44px) and 60% of the viewport. Otherwise smooth-scroll so it lands
    // in the upper third — readable, with room for the card next to it.
    const barH = 44;
    const top = anchorRect.top;
    const vpH = window.innerHeight;
    const comfortableMin = barH + 80;
    const comfortableMax = vpH * 0.6;
    if (top >= comfortableMin && top <= comfortableMax) return;
    const targetTop = vpH * 0.25;          // land at 25% of viewport
    const delta = top - targetTop;
    window.scrollBy({ top: delta, behavior: 'smooth' });
  }

  // ========== Element outlines (saved + pending) ==========
  function outlineElement(comment) {
    const el = findElement(comment.anchor);
    if (!el) return null;
    const outline = document.createElement('div');
    outline.className = 'tdoc-element-outline';
    outline.dataset.commentId = comment.id;
    document.body.appendChild(outline);
    const repos = () => positionOutlineAround(outline, el);
    repos();
    outline._reposition = repos;
    outline.style.pointerEvents = 'none';
    return { el: outline, targetEl: el };
  }

  // Tear down every per-comment artifact before a refresh: highlights, fallback
  // spans, outlines (preserving the in-flight 'pending' one), margin cards, and
  // both lookup maps. Anchored state must be reconstructed from the fresh list.
  function resetAnchors() {
    clearAllCommentHighlights();
    unwrapFallbackSpans();
    document.querySelectorAll('.tdoc-element-outline:not(.pending)').forEach(el => el.remove());
    document.querySelectorAll('.tdoc-ghost-marker').forEach(el => el.remove());
    for (const card of commentLayer.querySelectorAll('.tdoc-margin-comment')) card.remove();
    // Pins model teardown: drop pins + any open floating card / popover so the
    // next render starts from a clean slate (cluster keys may have changed).
    if (typeof pinLayer !== 'undefined') pinLayer.querySelectorAll('.tdoc-pin').forEach(p => p.remove());
    if (typeof clusterPop !== 'undefined') { clusterPop.classList.remove('open'); clusterPop._key = null; }
    state.pinnedId = null; state.hoverId = null;
    state.anchorMarks.clear();
    state.cardEls.clear();
  }

  // ========== refreshComments ==========
  async function refreshComments(opts) {
    const allowDeepLink = !opts || opts.deepLink !== false;
    // Preserve which comment had its floating card pinned open (wide mode) so a
    // reply/react/re-anchor that triggers a refresh doesn't make the card the
    // user is interacting with vanish. resetAnchors() nulls state.pinnedId, so
    // capture it first and restore after the rebuild — but only if the comment
    // still exists in the fresh list (a deleted comment correctly stays gone).
    const keepPinnedId = state.pinnedId;
    resetAnchors();

    let list = [];
    if (isFork) {
      // Read-only: parse the embedded JSON. No /api calls.
      const block = document.getElementById('tdoc-fork-comments');
      if (block) {
        try { list = (JSON.parse(block.textContent || '{}').comments) || []; } catch { list = []; }
      }
    } else {
      try {
        const r = await fetch(`/api/comments?slug=${encodeURIComponent(slug)}&version=${version}`);
        // The endpoint returns an array on success but an error ENVELOPE
        // ({error:...}) on 4xx/5xx. Guard the shape so a non-array body can't
        // throw on .filter() below and abort all comment rendering.
        const body = r.ok ? await r.json() : null;
        list = Array.isArray(body) ? body : [];
      } catch { list = []; }
    }
    state.activeComments = (Array.isArray(list) ? list : []).filter(c => c && c.status !== 'resolved');
    document.body.classList.toggle('tdoc-has-comments', state.activeComments.length > 0);
    document.body.dataset.tdocReady = '1';

    const fabCount = document.getElementById('tdoc-fab-count');
    if (fabCount) fabCount.textContent = state.activeComments.length;

    const want = allowDeepLink
      ? (() => { try { return new URLSearchParams(location.search).get('comment'); } catch { return null; } })()
      : null;
    const deepRoot = findCommentRoot(state.activeComments, want);
    // Expand the thread before buildCard so a reply deep-link is not born collapsed.
    if (deepRoot) state.openReplyThreads.add(deepRoot);

    let textCache = state.activeComments.some(c => (c.anchor?.kind || (c.anchor?.text ? 'text' : null)) === 'text')
      ? collectTextNodes() : null;
    for (const comment of state.activeComments) {
      // Resolved comments (agent marked them applied) keep their margin card
      // and "✓ fixed" chip, but we do NOT draw their in-text anchor: no gold
      // highlight and no dashed ghost marker. Once a comment is addressed the
      // dash just sits at the old spot as visual noise. Skipping the anchor
      // mark here means rebuildSharedHighlights() and repositionCards() never
      // see a mark for it, so no highlight/ghost is produced; the card falls
      // through to fallback-ratio (or tail) placement.
      const isResolvedComment = comment.status === 'applied';
      const kind = comment.anchor?.kind || (comment.anchor?.text ? 'text' : null);
      if (isResolvedComment) {
        // no-op: intentionally leave anchorMarks empty for this comment
      } else if (kind === 'text') {
        const range = findTextRange(comment.anchor, textCache);
        if (range) {
          if (HIGHLIGHT_API) {
            state.anchorMarks.set(comment.id, { kind: 'text', ranges: [range] });
          } else {
            const span = fallbackWrapAsSpan(comment, range);
            if (span) {
              span.addEventListener('click', (e) => { e.stopPropagation(); setActiveComment(comment.id); });
              span.style.cursor = 'pointer';
              state.anchorMarks.set(comment.id, { kind: 'text', el: span });
              // surroundContents() split the text node, invalidating the cached
              // node list — recompute so later text comments don't anchor
              // against stale nodes. (HIGHLIGHT_API path doesn't mutate the DOM,
              // so it can keep sharing one cache.)
              textCache = collectTextNodes();
            }
          }
        }
      } else if (kind === 'element') {
        const out = outlineElement(comment);
        if (out) {
          // Bind the click handler ONCE per target element. targetEl is a stable
          // live artifact (matched by data-tdoc-aid), so re-adding an anonymous
          // listener every refresh leaked handlers and made one click fire
          // setActiveComment N times. Store the current comment id on the element
          // and let a single bound handler read it.
          out.targetEl.dataset.tdocAnchorComment = comment.id;
          if (!out.targetEl._tdocAnchorClickBound) {
            out.targetEl._tdocAnchorClickBound = true;
            out.targetEl.addEventListener('click', (e) => {
              const cid = e.currentTarget.dataset.tdocAnchorComment;
              if (cid) { e.stopPropagation(); setActiveComment(cid); }
            });
          }
          if (out.targetEl.style) out.targetEl.style.cursor = 'pointer';
          state.anchorMarks.set(comment.id, { kind: 'element', el: out.el, targetEl: out.targetEl });
        }
      }
      const card = buildCard(comment);
      commentLayer.appendChild(card);
      state.cardEls.set(comment.id, card);
    }
    rebuildSharedHighlights();
    evaluateLayout();
    requestAnimationFrame(() => {
      repositionCards();
      if (want) {
        applyCommentDeepLink(want);
      } else if (keepPinnedId && !state.narrow && state.cardEls.has(keepPinnedId)) {
        // Restore the pinned floating card if its comment survived the refresh.
        // Use setActiveComment (not the manual pin/show/mark trio) so the
        // card's .active class, anchor highlight, activeId, AND the pin state
        // are all re-established together. The manual version desynced activeId
        // and lost the card's .active state (+ the "move anchor" affordance).
        setActiveComment(keepPinnedId);
      }
    });
  }

  function applyCommentDeepLink(want) {
    if (!want) return;
    const root = findCommentRoot(state.activeComments, want);
    if (root) {
      state.openReplyThreads.add(root);
      // Same-doc inbox clicks run after cards already exist. The set is
      // only consulted at buildCard — collapsed threads stay display:none
      // until .tdoc-replies.open is on the live card.
      const card = state.cardEls.get(root);
      if (card) {
        card.querySelector('.tdoc-replies')?.classList.add('open');
        card.querySelector('.tdoc-replies-toggle')?.classList.add('open');
      }
    }
    if (state.narrow) commentLayer.classList.add('open');
    // Opening a reply must not activate the root — that would mark the
    // root's own notifications (e.g. a reaction) as read.
    if (want === root && state.cardEls.has(root)) setActiveComment(root);
    else if (root && state.cardEls.has(root)) pinOpenCard(root);
    const el = document.querySelector(`[data-comment-id="${CSS.escape(want)}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    if (root) requestAnimationFrame(repositionCards);
    markInboxSeen(want);
  }

  // Click on a Highlight-API range → activate. Highlight API has no per-range
  // event so we delegate from a root click handler by hit-testing ranges.
  function findCommentAtPoint(x, y) {
    if (!HIGHLIGHT_API) return null;
    for (const [id, mark] of state.anchorMarks) {
      if (!mark.ranges) continue;
      for (const r of mark.ranges) {
        const rects = r.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          const rect = rects[i];
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return id;
        }
      }
    }
    return null;
  }

  // ========== Narrow mode (single source of truth) ==========
  function evaluateLayout() {
    const MIN_ARTICLE_WIDTH = 400;
    const MIN_COLUMN_WIDTH = 300;
    const isPhone = window.innerWidth < 700;
    const metrics = getArticleMetrics();
    const articleWidth = metrics.el === document.body ? Infinity : metrics.width;
    const articleRight = metrics.el === document.body ? 0 : metrics.right;
    const columnRoom = window.innerWidth - articleRight;
    const narrow = isPhone || articleWidth < MIN_ARTICLE_WIDTH || columnRoom < MIN_COLUMN_WIDTH;
    state.narrow = narrow;
    document.body.classList.toggle('tdoc-narrow', narrow);
    // Pins model is active in wide mode whenever there are comments. Toggling
    // this class hides the card stack (CSS) and lets renderPins() take over.
    document.body.classList.toggle('tdoc-pins', !narrow && state.activeComments.length > 0);
    fab.style.display = (narrow && state.activeComments.length > 0) ? 'inline-flex' : 'none';
    if (!narrow) commentLayer.classList.remove('open');
    if (narrow) {
      // Leaving wide mode: tear down any open floating card + pins state.
      state.pinnedId = null; state.hoverId = null;
      document.querySelectorAll('.tdoc-margin-comment.tdoc-floating-open').forEach(el => el.classList.remove('tdoc-floating-open'));
      closeClusterPopover();
    }
  }

  window.addEventListener('resize', () => requestAnimationFrame(() => { evaluateLayout(); repositionCards(); }));
  // Esc cancels re-anchor mode, then closes any open cluster popover / pinned
  // floating card (most-transient-first so one Esc peels one layer).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // A new-comment sheet is the most modal thing on screen; Escape cancels it
    // first — and closePopup() clears the pending highlight, so the yellow does
    // not linger after cancel. (Only the × used to do this.)
    if (popup) { closePopup(); return; }
    if (state.reanchoringId) { exitReanchor(); return; }
    if (clusterPop.classList.contains('open')) { closeClusterPopover(); return; }
    if (state.pinnedId) { const id = state.pinnedId; state.pinnedId = null; hideCardIfIdle(id); markPinActive(id, false); setActiveComment(null); }
  });
  window.addEventListener('scroll', () => requestAnimationFrame(repositionCards), { passive: true });
  if (window.ResizeObserver) new ResizeObserver(() => repositionCards()).observe(document.body);

  // ========== Auth (Device Flow) ==========
  // GitHub returns "slow_down" if we poll faster than its current interval —
  // and once it does, we must bump our interval by ≥5s or it will keep
  // refusing forever. Use a chained setTimeout so each tick can adjust the
  // delay before scheduling the next.
  // Whoever ran the shared flow — this bar, or the onboarding dialog — the
  // page has to stop showing a signed-out state. signin.js announces success
  // once; this is the overlay's half of that.
  document.addEventListener('tdoc:signedin', function (e) {
    if (!e.detail) return;
    identity = e.detail;
    // Deliberately not refreshing isOwner here: since #162 it means "owns THIS
    // doc" and the worker sends it explicitly, so inferring it from
    // /api/auth/me would put the worker-owner sense back on a per-doc field.
    // canSeeMyDocs is the flag that governs the My docs entry.
    if (e.detail.canSeeMyDocs != null) canSeeMyDocs = !!e.detail.canSeeMyDocs;
    renderIdentity();
    refreshComments();
  });

  // Sign-in lives in server/signin.js, shared with the neutral landing page so
  // the protocol, the backoff and the copy exist once. This wrapper only says
  // what the overlay does afterwards.
  async function startDeviceFlow() {
    if (!isPublished) return;
    if (!window.__tdocSignIn) return;
    let ident;
    try {
      ident = await window.__tdocSignIn();
    } catch (e) {
      return;  // cancelled
    }
    identity = ident;
    renderIdentity();
    refreshComments();
    if (pendingDuplicate) {
      pendingDuplicate = false;
      duplicateDoc();
    }
  }

  // ========== Publish / Share modals ==========
  function closeAuxModal() {
    const m = document.getElementById('tdoc-aux-modal');
    if (m) m.remove();
  }
  function showPublishModal() {
    closeAuxModal();
    const bg = document.createElement('div');
    bg.className = 'tdoc-modal-bg';
    bg.id = 'tdoc-aux-modal';
    bg.innerHTML = `
      <div class="tdoc-modal" data-state="idle">
        <h3>Publish this doc</h3>
        <p>We'll deploy this to your Cloudflare Worker so anyone with the link can read it. GitHub sign-in is required for commenting.</p>
        <div class="step"><span class="n">·</span><span>Slug: <code id="tdoc-pub-slug">${escapeHtml(slug)}</code></span></div>
        <div class="status" id="tdoc-pub-status" style="margin-top:10px;display:none;"></div>
        <div id="tdoc-pub-result" style="margin-top:10px;display:none;">
          <div class="code" style="font-size:14px;letter-spacing:0;text-align:left;" id="tdoc-pub-url"></div>
          <div class="actions" style="justify-content:flex-start;gap:8px;">
            <button class="primary" id="tdoc-pub-copy">Copy link</button>
            <button id="tdoc-pub-open">View live →</button>
          </div>
        </div>
        <div class="actions">
          <button id="tdoc-pub-cancel">Cancel</button>
          <button class="primary" id="tdoc-pub-go">Publish</button>
        </div>
      </div>`;
    document.body.appendChild(bg);
    document.getElementById('tdoc-pub-cancel').onclick = closeAuxModal;
    document.getElementById('tdoc-pub-go').onclick = async () => {
      const status = document.getElementById('tdoc-pub-status');
      const go = document.getElementById('tdoc-pub-go');
      status.style.display = 'block';
      status.textContent = 'Publishing — this can take 20–60s on first run…';
      go.disabled = true;
      try {
        const r = await fetch('/api/publish', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug })
        });
        const data = await r.json();
        if (!r.ok || data.error) {
          status.textContent = 'Failed: ' + (data.error || data.message || 'unknown');
          go.disabled = false;
          return;
        }
        const url = data.url;
        status.style.display = 'none';
        const result = document.getElementById('tdoc-pub-result');
        result.style.display = 'block';
        document.getElementById('tdoc-pub-url').textContent = url;
        document.getElementById('tdoc-pub-copy').onclick = () => navigator.clipboard?.writeText(url);
        document.getElementById('tdoc-pub-open').onclick = () => window.open(url, '_blank');
        document.getElementById('tdoc-pub-go').style.display = 'none';
        document.getElementById('tdoc-pub-cancel').textContent = 'Done';
      } catch (e) {
        status.textContent = 'Failed: ' + e.message;
        go.disabled = false;
      }
    };
  }
  function publicShareUrl() {
    // `/` is the site. Copying the storage path tells a visitor they are
    // looking at somebody's document, which is the same leak the bar crumb
    // was. /d/ keeps the versioned URL.
    return cfg.isLanding
      ? `${location.origin}/`
      : `${location.origin}/d/${encodeURIComponent(slug)}/v/${version}`;
  }
  function showShareModal() {
    // One Share button: owners get copy-link + access settings in the same
    // panel; everyone else gets copy-link only. No separate "Share settings".
    if (cfg.ownerManage) { showManageModal(); return; }
    closeAuxModal();
    const url = publicShareUrl();
    const bg = document.createElement('div');
    bg.className = 'tdoc-modal-bg';
    bg.id = 'tdoc-aux-modal';
    bg.innerHTML = `
      <div class="tdoc-modal">
        <h3>Share</h3>
        <div class="code" id="tdoc-share-url" style="font-size:14px;letter-spacing:0;text-align:left;cursor:copy;">${escapeHtml(url)}</div>
        <div class="actions" style="justify-content:flex-start;gap:8px;margin-top:0;margin-bottom:10px;">
          <button class="primary" id="tdoc-share-copy">Copy link</button>
        </div>
        <p class="muted">Anyone with this link can read. To comment, they sign in with GitHub.</p>
        <div class="actions"><button id="tdoc-share-close">Close</button></div>
      </div>`;
    document.body.appendChild(bg);
    document.getElementById('tdoc-share-close').onclick = closeAuxModal;
    document.getElementById('tdoc-share-copy').onclick = () => navigator.clipboard?.writeText(url);
    document.getElementById('tdoc-share-url').onclick = () => navigator.clipboard?.writeText(url);
  }
  // ========== Owner manage / Share panel (Delete / Unpublish / access) =====
  // JUL-36, reworked 2026-08-13 (julie: browser owner management should work
  // off the GitHub login, like Google Docs — no pasted token). Opened from
  // the single Share button (showShareModal dispatches here when
  // cfg.ownerManage is set). Gated on cfg.ownerManage, which the worker only
  // populates in the per-request boot config when THIS request's session
  // passed isDocOwnerSession() server-side (worker.js's /d/ route). A
  // non-owner's config carries cfg.ownerManage === null — every function
  // below bails before creating any DOM, so there is no hidden button, just
  // nothing rendered for them.
  //
  // A published doc is arbitrary HTML the owner authored, so this being
  // session-authorized (no token) is safe ONLY because the worker now sends
  // a CSP (see worker.js cspHeader()) on every doc response that blocks
  // author <script>/onclick content outright — a doc can't ride the owner's
  // session cookie into these routes anymore. ownerFetch() below relies on
  // the browser's default same-origin credential behavior (cookie sent
  // automatically); `credentials: 'same-origin'` is passed explicitly for
  // clarity, not because it changes behavior here.
  function closeManageModal() {
    const m = document.getElementById('tdoc-manage-modal');
    if (m) m.remove();
  }
  function closeManageConfirm() {
    const m = document.getElementById('tdoc-manage-confirm');
    if (m) m.remove();
  }
  function showManageConfirm({ title, body, confirmLabel, danger, onConfirm }) {
    closeManageConfirm();
    const bg = document.createElement('div');
    bg.className = 'tdoc-modal-bg';
    bg.id = 'tdoc-manage-confirm';
    bg.innerHTML = `
      <div class="tdoc-modal">
        <h3>${escapeHtml(title)}</h3>
        <p>${body}</p>
        <div class="status" id="tdoc-manage-confirm-status" style="display:none;"></div>
        <div class="actions">
          <button type="button" id="tdoc-manage-confirm-cancel">Cancel</button>
          <button type="button" id="tdoc-manage-confirm-go" class="${danger ? 'danger' : 'primary'}">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(bg);
    document.getElementById('tdoc-manage-confirm-cancel').onclick = closeManageConfirm;
    bg.addEventListener('click', (e) => { if (e.target === bg) closeManageConfirm(); });
    document.getElementById('tdoc-manage-confirm-go').onclick = async () => {
      const status = document.getElementById('tdoc-manage-confirm-status');
      const go = document.getElementById('tdoc-manage-confirm-go');
      go.disabled = true;
      status.style.display = 'block';
      status.textContent = 'Working…';
      try {
        await onConfirm(status);
      } catch (e) {
        status.textContent = 'Failed: ' + e.message;
        go.disabled = false;
      }
    };
  }
  // No Authorization header, no token — the owner's session cookie is sent
  // automatically on this same-origin request (see doc comment above).
  async function ownerFetch(url, opts) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const r = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || err.message || ('HTTP ' + r.status));
    }
    return r.json().catch(() => ({}));
  }
  // Delete is a lifecycle action, not a sharing setting, so it lives in the ⋯
  // overflow menu (owner-only), not the Share panel. Same session-authorized
  // DELETE + confirm the Share panel used to run.
  function confirmDeleteDoc() {
    const om = cfg.ownerManage;
    if (!om) return; // owner-only; the ⋯ item is gated on cfg.ownerManage too
    const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
    showManageConfirm({
      title: 'Delete this doc?',
      body: `This permanently removes <b>${escapeHtml(slug)}</b> — all <b>${plural(om.versionCount, 'version')}</b> and <b>${plural(om.commentCount, 'comment')}</b> are deleted. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async (status) => {
        await ownerFetch(`/api/doc?slug=${encodeURIComponent(slug)}`, { method: 'DELETE' });
        status.textContent = 'Deleted. Redirecting…';
        setTimeout(() => { window.location.href = '/'; }, 900);
      },
    });
  }
  const HISTORY_OPTIONS = [['owner', 'Owner only'], ['invited', 'Invited'], ['public', 'Everyone']];
  const COMMENTING_OPTIONS = [['signed_in', 'Signed in'], ['invited', 'Invited'], ['owner', 'Owner only'], ['off', 'Off']];
  function renderSeg(id, current) {
    const seg = document.getElementById(id);
    if (!seg) return;
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === current));
  }
  function showManageModal() {
    if (!cfg.ownerManage) return; // no owner data for this request → nothing to render
    closeAuxModal();
    const om = cfg.ownerManage;
    const url = publicShareUrl();
    const access = {
      visibility: 'unlisted', history_visibility: 'owner', commenting: 'signed_in', allowed_users: [],
      ...(om.access || {}),
    };
    const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
    const bg = document.createElement('div');
    bg.className = 'tdoc-modal-bg';
    bg.id = 'tdoc-manage-modal';
    bg.innerHTML = `
      <div class="tdoc-modal">
        <h3>Share</h3>
        <div class="code" id="tdoc-share-url" style="font-size:14px;letter-spacing:0;text-align:left;cursor:copy;">${escapeHtml(url)}</div>
        <div class="actions" style="justify-content:flex-start;gap:8px;margin-top:0;margin-bottom:4px;">
          <button type="button" class="primary" id="tdoc-share-copy">Copy link</button>
        </div>
        <p class="muted">${escapeHtml(slug)} · ${plural(om.versionCount, 'version')} · ${plural(om.commentCount, 'comment')}</p>
        <div class="manage-section">
          <label class="field" for="tdoc-access-sel">Who has access</label>
          <select id="tdoc-access-sel" class="tdoc-select">
            <option value="private">Only people I invite</option>
            <option value="unlisted">Anyone with the link</option>
          </select>
          <p class="manage-hint" id="tdoc-access-explain">&nbsp;</p>
          <div id="tdoc-invited-wrap" style="display:none;margin-top:10px;">
            <label class="field" for="tdoc-mgmt-allowed">Invite by GitHub username</label>
            <div class="tdoc-token-field" id="tdoc-allowed-field">
              <input type="text" id="tdoc-mgmt-allowed" autocomplete="off" spellcheck="false" placeholder="Add a GitHub username…">
            </div>
            <div class="tdoc-ac" id="tdoc-allowed-ac"></div>
            <p class="manage-hint" id="tdoc-allowed-status">&nbsp;</p>
          </div>
        </div>
        <details class="tdoc-adv"${(access.commenting !== 'signed_in' || access.history_visibility !== 'owner') ? ' open' : ''}>
          <summary>Advanced</summary>
          <div class="manage-section">
            <label class="field">Who can comment</label>
            <div class="tdoc-seg" id="tdoc-comment-seg">
              ${COMMENTING_OPTIONS.map(([v, l]) => `<button type="button" data-value="${v}">${l}</button>`).join('')}
            </div>
          </div>
          <div class="manage-section">
            <label class="field">Who can see version history</label>
            <div class="tdoc-seg" id="tdoc-hist-seg">
              ${HISTORY_OPTIONS.map(([v, l]) => `<button type="button" data-value="${v}">${l}</button>`).join('')}
            </div>
          </div>
          <p class="manage-hint" id="tdoc-vis-status">&nbsp;</p>
        </details>
        <div class="actions"><button type="button" id="tdoc-share-close">Close</button></div>
      </div>`;
    document.body.appendChild(bg);
    renderSeg('tdoc-hist-seg', access.history_visibility);
    renderSeg('tdoc-comment-seg', access.commenting);
    // --- General access: one plain-language dropdown replaces the old
    // Visibility segmented control AND the separate Unpublish button (Unpublish
    // was identical to switching visibility to Private, so it's gone). The
    // invite field only appears when "invited" semantics are actually in play. ---
    const accessSel = document.getElementById('tdoc-access-sel');
    const accessExplainEl = document.getElementById('tdoc-access-explain');
    const invitedWrap = document.getElementById('tdoc-invited-wrap');
    // `public` and `unlisted` are functionally identical today — `public` only
    // reserves a not-yet-built discovery listing (see worker canReadDoc), so
    // the dropdown offers two options and a legacy public doc maps onto
    // "Anyone with the link".
    accessSel.value = access.visibility === 'private' ? 'private' : 'unlisted';
    const invitedRelevant = () => access.visibility === 'private'
      || access.commenting === 'invited' || access.history_visibility === 'invited';
    function updateInvited() { invitedWrap.style.display = invitedRelevant() ? 'block' : 'none'; }
    function updateAccessExplain() {
      const n = (access.allowed_users || []).length;
      accessExplainEl.textContent =
        access.visibility !== 'private' ? 'Anyone with the link can read it.'
        : n ? `Only you and ${n === 1 ? '1 invited person' : n + ' invited people'} can open it.`
        : 'Only you can open it — add people below to invite them.';
    }
    accessSel.onchange = async () => {
      const value = accessSel.value;
      if (value === access.visibility) return;
      // patchAccess only mutates `access` on success; on failure it leaves the
      // error text in accessExplainEl, so only refresh on a confirmed change.
      await patchAccess({ visibility: value }, accessExplainEl, '');
      if (access.visibility === value) { updateAccessExplain(); updateInvited(); }
      else { accessSel.value = access.visibility; }
    };
    updateAccessExplain();
    updateInvited();
    document.getElementById('tdoc-share-close').onclick = closeManageModal;
    document.getElementById('tdoc-share-copy').onclick = () => navigator.clipboard?.writeText(url);
    document.getElementById('tdoc-share-url').onclick = () => navigator.clipboard?.writeText(url);
    bg.addEventListener('click', (e) => { if (e.target === bg) closeManageModal(); });

    // Shared PATCH /api/doc/access helper — merges `patch` into the local
    // `access` mirror on success so re-renders (renderSeg) reflect it.
    async function patchAccess(patch, statusEl, successMsg) {
      statusEl.textContent = 'Saving…';
      try {
        await ownerFetch('/api/doc/access', {
          method: 'PATCH',
          body: JSON.stringify({ slug, access: patch }),
        });
        Object.assign(access, patch);
        statusEl.textContent = successMsg;
      } catch (e) {
        statusEl.textContent = 'Failed: ' + e.message;
      }
    }

    document.getElementById('tdoc-hist-seg').querySelectorAll('button').forEach(b => {
      b.onclick = async () => {
        const value = b.dataset.value;
        if (value === access.history_visibility) return;
        await patchAccess({ history_visibility: value }, document.getElementById('tdoc-vis-status'), 'Saved.');
        renderSeg('tdoc-hist-seg', access.history_visibility);
        updateInvited(); // "Invited" history reveals the invite field
      };
    });

    document.getElementById('tdoc-comment-seg').querySelectorAll('button').forEach(b => {
      b.onclick = async () => {
        const value = b.dataset.value;
        if (value === access.commenting) return;
        await patchAccess({ commenting: value }, document.getElementById('tdoc-vis-status'), 'Saved.');
        renderSeg('tdoc-comment-seg', access.commenting);
        updateInvited(); // "Invited" commenting reveals the invite field
      };
    });

    // ----- Allowed users: chip field + live GitHub handle autocomplete -----
    // All client-side. Candidate lookup and avatar existence checks go straight
    // to GitHub from the owner's browser (their IP → their own ~10 req/min
    // anonymous budget), so there is no worker proxy and no API key. See the
    // CSS block for why the doc CSP permits these requests.
    (function setupAllowedUsers() {
      const field = document.getElementById('tdoc-allowed-field');
      const input = document.getElementById('tdoc-mgmt-allowed');
      const acWrap = document.getElementById('tdoc-allowed-ac');
      const status = document.getElementById('tdoc-allowed-status');
      const list = Array.isArray(access.allowed_users) ? access.allowed_users.slice() : [];
      // Accept a bare login, an @handle, or a pasted github.com/<login> URL.
      const norm = (s) => s.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '');
      const avatarUrl = (login) => `https://github.com/${encodeURIComponent(login)}.png?size=48`;

      function renderChips() {
        field.querySelectorAll('.tdoc-token').forEach(c => c.remove());
        list.forEach((login) => {
          const chip = document.createElement('span');
          chip.className = 'tdoc-token';
          const img = document.createElement('img');
          img.src = avatarUrl(login); img.alt = '';
          // A 404 from the avatar endpoint means no such GitHub user — flag it
          // so the owner sees a bad handle instead of silently locking someone
          // out. (github.com/<login>.png needs no API call and no rate budget.)
          img.onerror = () => {
            chip.classList.add('invalid');
            const mark = document.createElement('span');
            mark.className = 'mark'; mark.textContent = '!';
            mark.title = 'No GitHub user with this username';
            img.replaceWith(mark);
          };
          const name = document.createElement('span'); name.textContent = login;
          const rm = document.createElement('span');
          rm.className = 'rm'; rm.textContent = '×'; rm.title = 'Remove';
          rm.onclick = () => remove(login);
          chip.append(img, name, rm);
          field.insertBefore(chip, input);
        });
      }
      const commit = async () => {
        await patchAccess({ allowed_users: list.slice() }, status, 'Saved.');
        updateAccessExplain(); // keep the "Only you and N invited people" line in sync
      };
      function add(raw) {
        const l = norm(raw);
        if (l && !list.some(x => x.toLowerCase() === l.toLowerCase())) {
          list.push(l); renderChips(); commit();
        }
        input.value = ''; closeAc();
      }
      function remove(login) {
        const i = list.findIndex(x => x.toLowerCase() === login.toLowerCase());
        if (i >= 0) { list.splice(i, 1); renderChips(); commit(); }
      }

      // ---- autocomplete dropdown ----
      let acItems = [], acActive = -1, acSeq = 0, debounceTimer = 0;
      function closeAc() { acWrap.innerHTML = ''; acItems = []; acActive = -1; }
      function renderAc(users) {
        acItems = users; acActive = -1;
        if (!users.length) return closeAc();
        const box = document.createElement('div');
        box.className = 'tdoc-ac-list';
        users.forEach((u) => {
          const it = document.createElement('div');
          it.className = 'tdoc-ac-item';
          const img = document.createElement('img');
          img.src = u.avatar_url || avatarUrl(u.login); img.alt = '';
          const login = document.createElement('span');
          login.className = 'login'; login.textContent = u.login;
          it.append(img, login);
          // mousedown (not click) so it fires before the input's blur handler.
          it.addEventListener('mousedown', (e) => { e.preventDefault(); add(u.login); });
          box.appendChild(it);
        });
        acWrap.innerHTML = ''; acWrap.appendChild(box);
      }
      async function search(q) {
        const seq = ++acSeq;
        try {
          const r = await fetch(
            `https://api.github.com/search/users?q=${encodeURIComponent(q)}+in:login&per_page=6`,
            { headers: { 'Accept': 'application/vnd.github+json' } });
          if (seq !== acSeq) return; // superseded by a newer keystroke
          if (!r.ok) return closeAc(); // rate-limited / error → no suggestions; typing still works
          const data = await r.json();
          if (seq !== acSeq) return;
          renderAc((data.items || []).filter(u => u.type === 'User').slice(0, 6));
        } catch { if (seq === acSeq) closeAc(); }
      }
      function moveAc(dir) {
        const items = acWrap.querySelectorAll('.tdoc-ac-item');
        if (!items.length) return;
        acActive = (acActive + dir + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('active', i === acActive));
      }

      input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        const q = norm(input.value);
        if (q.length < 2) return closeAc();
        // Generous debounce: GitHub's anonymous search budget is ~10/min per IP.
        debounceTimer = setTimeout(() => search(q), 450);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' && acItems.length) { e.preventDefault(); return moveAc(1); }
        if (e.key === 'ArrowUp' && acItems.length) { e.preventDefault(); return moveAc(-1); }
        if (e.key === 'Escape') return closeAc();
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          if (acActive >= 0 && acItems[acActive]) add(acItems[acActive].login);
          else if (input.value.trim()) add(input.value);
          return;
        }
        if (e.key === 'Backspace' && !input.value && list.length) remove(list[list.length - 1]);
      });
      input.addEventListener('focus', () => field.classList.add('focus'));
      input.addEventListener('blur', () => {
        field.classList.remove('focus');
        // Defer so a candidate click (mousedown) resolves first; then commit any
        // half-typed handle left in the box.
        setTimeout(() => { if (input.value.trim()) add(input.value); closeAc(); }, 150);
      });
      field.addEventListener('click', () => input.focus());

      renderChips();
    })();

  }


  // ========== Popup (new-comment): text + element anchors ==========
  let popup = null;
  let popupOpenedAt = 0;   // guards the opening click from self-closing the sheet
  let pendingElementOutline = null;

  function setPendingTextHighlight(range) {
    if (!HIGHLIGHT_API || !range) return;
    pendingHighlight.clear();
    pendingHighlight.add(range);
  }
  function clearPendingTextHighlight() {
    if (HIGHLIGHT_API) pendingHighlight.clear();
  }
  function setPendingElementOutline(el) {
    clearPendingElementOutline();
    pendingElementOutline = document.createElement('div');
    pendingElementOutline.className = 'tdoc-element-outline pending';
    positionOutlineAround(pendingElementOutline, el);
    document.body.appendChild(pendingElementOutline);
  }
  function clearPendingElementOutline() {
    if (pendingElementOutline) { pendingElementOutline.remove(); pendingElementOutline = null; }
  }
  function closePopup() {
    if (popup) { popup.remove(); popup = null; }
    clearPendingTextHighlight();
    clearPendingElementOutline();
    // Drop the native browser text selection left over from a drag-select.
    // Without this, after submitting (or cancelling) a comment on selected
    // text — especially across table cells — the OS selection lingers and
    // looks like "everything after the line is still selected" until you
    // click blank space. The tdoc anchor highlight is correct; this clears
    // the stray native selection on top of it.
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount > 0) sel.removeAllRanges();
  }

  function openPopup(anchor, rect) {
    if (isFork) return; // read-only fork view: no new comments
    closePopup();
    hideHoverUI();
    popup = document.createElement('div');
    popup.className = 'tdoc-popup';
    popupOpenedAt = performance.now();
    const needsSignIn = isPublished && !identity;
    const preview = anchor.kind === 'text'
      ? `"${escapeHtml(anchor.text.slice(0, 80))}${anchor.text.length > 80 ? '…' : ''}"`
      : `📎 ${escapeHtml(anchor.label)}`;
    popup.innerHTML = `
      <div class="head"><span class="h">${preview}</span><span class="x">×</span></div>
      ${needsSignIn ? '<div class="signin-needed">Sign in with GitHub to comment.</div>' : ''}
      <textarea placeholder="What should change?" ${needsSignIn ? 'disabled' : ''}></textarea>
      <div class="foot">
        <span class="hint">${needsSignIn ? '' : '⌘+Enter to submit'}</span>
        <button class="submit">${needsSignIn ? 'Sign in' : 'Comment'}</button>
      </div>`;
    // Default: open below `rect` (used for text-selection popups so it follows
    // the cursor). For element anchors invoked via the Comment pill, we want
    // the popup to open ABOVE the pill so it doesn't dive into the artifact
    // body. The caller signals this by setting anchor._placeAbove = true.
    document.body.appendChild(popup);   // append first so offsetHeight is known
    const popupH = popup.offsetHeight || 140;
    const popupW = popup.offsetWidth || 320;
    const above = window.scrollY + rect.top - popupH - 8;
    const below = window.scrollY + rect.bottom + 8;
    // Prefer above when the element pill asked for it and there is room; else
    // open below the selection so the sheet follows the cursor.
    let top = (anchor._placeAbove && rect.top - 8 - popupH >= 8) ? above : below;
    // Clamp vertically to the viewport — the horizontal clamp below always
    // kept the sheet on screen sideways, but `top` used to be set blind, so a
    // comment on a selection (or artifact) low in the viewport opened below
    // the fold and the textarea + Comment button were cut off. Mirror the
    // emoji-picker / margin-card behavior: if the sheet would spill past the
    // bottom, flip it above the anchor; if it still doesn't fit (tall sheet /
    // short viewport), pin it to the bottom edge so its controls stay reachable.
    const vpTop = window.scrollY + 8;
    const vpBottom = window.scrollY + window.innerHeight - 8;
    if (top + popupH > vpBottom) top = (above >= vpTop) ? above : Math.max(vpTop, vpBottom - popupH);
    popup.style.top = top + 'px';
    // `rect.left` is the caret / mouse-up X for text selections (not the
    // line-box origin). Clamp in document coords so a caret near the right
    // edge still keeps the 320px sheet on screen.
    const maxLeft = window.scrollX + window.innerWidth - popupW - 8;
    const left = Math.min(Math.max(window.scrollX + 8, window.scrollX + rect.left), maxLeft);
    popup.style.left = left + 'px';

    if (anchor.kind === 'text' && anchor._range) {
      setPendingTextHighlight(anchor._range);
      window.getSelection()?.removeAllRanges();
    } else if (anchor.kind === 'element' && anchor._el) {
      setPendingElementOutline(anchor._el);
    }

    const textarea = popup.querySelector('textarea');
    // Defer focus past the click cycle that follows mouseup — otherwise the
    // root click handler can steal focus back and the user has to click the
    // popup before they can type.
    if (!needsSignIn) requestAnimationFrame(() => textarea.focus());
    popup.querySelector('.x').onclick = closePopup;

    const submit = async () => {
      if (needsSignIn) { closePopup(); startDeviceFlow(); return; }
      const text = textarea.value.trim();
      if (!text) return;
      // Capture a fallback position so the card can stay roughly in place
      // even when the anchor text is later rewritten. articleY is the
      // anchor's vertical center, measured as a fraction of the article's
      // height — stable across viewport widths. nearestHeading is the id
      // (or text) of the closest preceding h1/h2/h3, used as a structural
      // landmark if the text-anchor fails entirely.
      const fallback = captureFallbackPosition(anchor);
      const sendAnchor = anchor.kind === 'text'
        ? { kind: 'text', text: anchor.text, context_before: anchor.context_before, context_after: anchor.context_after, fallback }
        : { kind: 'element', selector: anchor.selector, label: anchor.label,
            // IDENTITY-FIRST: persist the worker-stamped artifact id so
            // future resolution is by content identity, not DOM position.
            // Same artifact in any future version = same aid.
            aid: anchor._el ? elementAid(anchor._el) : null,
            // Fingerprint is the legacy fallback for any pre-aid docs.
            fingerprint: anchor._el ? elementFingerprint(anchor._el) : null,
            fallback };
      let r;
      try {
        r = await fetch('/api/comments', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, version, anchor: sendAnchor, text })
        });
      } catch (e) {
        alert('Could not post comment: network error'); // keep popup + text
        return;
      }
      if (r.status === 401) { closePopup(); startDeviceFlow(); return; }
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert('Could not post comment: ' + (err.error || err.message || `HTTP ${r.status}`));
        return; // leave the popup + typed text so the comment isn't lost
      }
      await r.json().catch(() => null);
      closePopup();
      await refreshComments();
    };
    popup.querySelector('.submit').onclick = submit;
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
      if (e.key === 'Escape') closePopup();
    });
  }

  // Capture position metadata at create time. Used when the saved text
  // anchor no longer resolves (the doc was rewritten) — the card still
  // lands near the original location instead of falling to the bottom.
  function captureFallbackPosition(anchor) {
    const metrics = getArticleMetrics();
    const articleEl = metrics.el || document.body;
    const articleTop = articleEl.getBoundingClientRect().top + window.scrollY;
    const articleHeight = Math.max(1, articleEl.scrollHeight);
    let rect = null;
    if (anchor.kind === 'text' && anchor._range) rect = firstVisibleClientRect(anchor._range);
    else if (anchor.kind === 'element' && anchor._el) rect = firstVisibleClientRect(anchor._el) || anchor._el.getBoundingClientRect();
    if (!rect) return null;
    const centerY = rect.top + rect.height / 2 + window.scrollY;
    const ratio = Math.max(0, Math.min(1, (centerY - articleTop) / articleHeight));
    // Find the nearest preceding heading for a structural landmark.
    let nearestHeading = null;
    const headings = document.querySelectorAll('h1, h2, h3');
    for (const h of headings) {
      if (h.closest(UI_CONTAINERS)) continue;
      const hr = h.getBoundingClientRect();
      if (hr.top + window.scrollY <= centerY) {
        nearestHeading = { id: h.id || null, text: h.textContent.trim().slice(0, 80) };
      } else break;
    }
    return { ratio, nearestHeading };
  }

  function getContext(range, chars) {
    // Use the same flattened-text view that findTextRange searches, so saved
    // context can disambiguate hits across element boundaries.
    try {
      const { nodes, total } = collectTextNodes();
      const startLoc = nodes.find(n => n.node === range.startContainer);
      const endLoc = nodes.find(n => n.node === range.endContainer);
      if (!startLoc || !endLoc) return { before: '', after: '' };
      const startG = startLoc.start + range.startOffset;
      const endG = endLoc.start + range.endOffset;
      return {
        before: total.slice(Math.max(0, startG - chars), startG),
        after: total.slice(endG, endG + chars),
      };
    } catch { return { before: '', after: '' }; }
  }

  // ========== Drag-to-comment on artifacts ==========
  // Commentable artifacts: leaf media + semantic blocks the author signaled
  // are "a unit" (section/article/aside/blockquote/table/details — note
  // `figure` and `pre` already included as media) + any element the author
  // explicitly opted in via `data-tdoc-artifact` or a class containing
  // `tdoc-artifact`. Author-composed cards (a transcript panel built from
  // <div>s, a custom widget) become commentable as a unit when tagged —
  // instead of being invisible to the artifact system.
  // NB: `article` is excluded — it's a doc content-root pattern; making it
  // commentable would let the whole doc become one big artifact. Use
  // `section` or `data-tdoc-artifact` to mark sub-blocks instead.
  const COMMENTABLE =
    'img, svg, canvas, video, pre, figure, iframe[src], ' +
    'section, aside, blockquote, table, details, ' +
    '[data-tdoc-artifact], [class*="tdoc-artifact"]';
  // The doc content root (per SKILL.md every doc wraps content in one of
  // these). resolveArtifact must never climb into/past it.
  const ARTICLE_ROOT_SEL = 'main, article, .wrap, .content, .container';
  const DRAG_THRESHOLD = 5;
  let dragState = null;

  function isInUI(el) {
    return el && el.closest && el.closest(UI_ALL);
  }

  // Resolve the *meaningful* artifact boundary for a hovered/hit leaf.
  //
  // COMMENTABLE only lists leaf media (img/svg/canvas/video/pre/figure/
  // iframe). Docs frequently compose ONE visual artifact out of <div>s
  // wrapping a nested media element — e.g. a phone mockup
  // <div class="phone"> … <svg> progress ring </svg> … </div>.
  // `closest(COMMENTABLE)` resolves to the inner <svg> (the ring), so the
  // outline/anchor hugs a tiny inner region instead of the whole mockup.
  //
  // The robust signal for "this is the artifact the author designed as one
  // unit" is NOT an id or an area ratio — it's a *visual container box*:
  // an ancestor the author gave its own visual boundary (background,
  // border, border-radius, box-shadow, or a fixed/aspect-ratio size).
  // The phone mockup has background+border-radius+box-shadow+aspect-ratio;
  // the inner `.screen`/`.ring-wrap` are pure layout flexers with none.
  //
  // Algorithm: climb from the media leaf to the OUTERMOST visual-box
  // ancestor that is still tighter than the content column. <figure> is a
  // definitive unit. Stop at the doc content root / UI / <body>. This is
  // resilient to viewport width (no innerWidth break that truncates the
  // climb before reaching the real artifact) and needs no id.
  let _csCache = null, _csCacheEl = null;
  function cs(el) {
    if (_csCacheEl === el && _csCache) return _csCache;
    try { _csCache = getComputedStyle(el); } catch (e) { _csCache = null; }
    _csCacheEl = el;
    return _csCache;
  }
  // Does this element have an author-given visual boundary (i.e. it reads
  // as a self-contained "card/frame/mockup", not a transparent layout div)?
  function isVisualBox(el) {
    if (!el || el.nodeType !== 1 || el === document.body) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'figure' || tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'video') return true;
    const s = cs(el);
    if (!s) return false;
    const hasBg =
      (s.backgroundImage && s.backgroundImage !== 'none') ||
      (s.backgroundColor &&
        s.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
        s.backgroundColor !== 'transparent');
    const hasBorder =
      (s.borderTopWidth && parseFloat(s.borderTopWidth) > 0) ||
      (s.borderBottomWidth && parseFloat(s.borderBottomWidth) > 0) ||
      (s.borderLeftWidth && parseFloat(s.borderLeftWidth) > 0) ||
      (s.borderRightWidth && parseFloat(s.borderRightWidth) > 0);
    const hasRadius = s.borderRadius && s.borderRadius !== '0px' && parseFloat(s.borderRadius) > 0;
    const hasShadow = s.boxShadow && s.boxShadow !== 'none';
    const hasAspect = s.aspectRatio && s.aspectRatio !== 'auto';
    return !!(hasBg || hasBorder || hasRadius || hasShadow || hasAspect);
  }
  function isFullWidthBand(el) {
    const r = el.getBoundingClientRect();
    if (!r.width) return true;
    // Compare against the article column, not the viewport: a full-bleed
    // showcase wrapper spans the column; the artifact inside it does not.
    const root = articleRootEl();
    const colW = root ? root.getBoundingClientRect().width : window.innerWidth;
    return r.width >= Math.max(1, colW) * 0.92;
  }
  function articleRootEl() {
    try {
      const c = document.querySelector(ARTICLE_ROOT_SEL);
      if (c && !(c.closest && (c.closest(UI_ALL)))) return c;
    } catch (e) {}
    return null;
  }
  // True if `node` sits within (or is) a resolved artifact — including the
  // wrapper region around a nested media leaf. Used to keep text-marquee
  // drags from starting on composite artifacts (e.g. the phone mockup's
  // padding, which is a <div>, not a COMMENTABLE leaf).
  function isWithinArtifact(node) {
    if (!node || node.nodeType !== 1) return false;
    const direct = node.matches(COMMENTABLE) ? node : node.closest(COMMENTABLE);
    if (direct) return true;
    // Climb: is any ancestor a resolved-artifact wrapper that contains a
    // COMMENTABLE descendant? (cheap walk, capped)
    let el = node, guard = 0;
    while (el && el !== document.body && guard++ < 14) {
      if (
        el.querySelector &&
        el.querySelector(COMMENTABLE) &&
        resolveArtifact(el.querySelector(COMMENTABLE)) === el
      ) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }
  function resolveArtifact(leaf) {
    if (!leaf || leaf.nodeType !== 1) return leaf;
    // If the leaf is already inside a comment-anchored element, keep that
    // exact element so existing anchors don't shift.
    if (leaf.closest && leaf.closest('[data-tdoc-anchored]')) {
      return leaf.closest('[data-tdoc-anchored]');
    }
    // Climb the full ancestor chain up to the content root, recording the
    // OUTERMOST visual-box ancestor that is still tighter than the content
    // column. Crucially we DO NOT break early on a non-visual layout div
    // (the inner `.screen`/`.ring-wrap` flexers): we climb THROUGH them so
    // a transparent wrapper between the media and the real mockup box can
    // never truncate the search before reaching the artifact.
    let el = leaf;
    let best = leaf;
    let guard = 0;
    while (el.parentElement && guard++ < 24) {
      const parent = el.parentElement;
      if (parent === document.body || parent.nodeType !== 1) break;
      if (parent.closest && (parent.closest(UI_ALL) || isInUI(parent))) break;
      // The doc's content root is a hard boundary — never the artifact.
      if (parent.matches && parent.matches(ARTICLE_ROOT_SEL)) break;
      if (parent.tagName && parent.tagName.toLowerCase() === 'figure') {
        return parent; // semantic artifact unit — definitive
      }
      // A visual box that still fits inside the column is a candidate
      // artifact boundary. Keep the OUTERMOST such box (so the whole phone
      // mockup wins over an inner card), but never a full-bleed band.
      if (isVisualBox(parent) && !isFullWidthBand(parent)) {
        best = parent;
      }
      el = parent;
    }
    return best;
  }

  // Given ANY node the cursor is over (the ring, a button, a label, the
  // empty padding — anything), return the artifact SECTION it belongs to,
  // or null if it isn't inside one. An artifact section is the OUTERMOST
  // ancestor (still inside the content column, never the content root) that
  // contains a media element (img/svg/canvas/video) — i.e. the whole
  // self-contained block the author composed. The entire section is one
  // unit: hovering anywhere inside it targets the same section, so the
  // Comment affordance never jumps as the cursor moves within it.
  // Resolves the COMMENTABLE artifact a hovered node belongs to.
  //
  // Old version was hard-coded around "must contain a media leaf
  // (img/svg/canvas/video)". That excluded the v0.1.54 cases — semantic
  // blocks (<section>, <table>, etc.) and author opt-in (data-tdoc-artifact)
  // can be commentable WITHOUT containing any media. This rewrite mirrors
  // the COMMENTABLE selector exactly: an artifact is anything COMMENTABLE
  // (either as the hovered element itself, an ancestor of it, or a
  // commentable wrapper around a media leaf that IS the hovered element).
  function artifactSectionOf(node) {
    if (!node || node.nodeType !== 1) return null;
    if (isInUI(node) || (node.closest && node.closest(UI_ALL))) return null;
    // Existing anchored element wins (keep anchors stable).
    if (node.closest) {
      const anchored = node.closest('[data-tdoc-anchored]');
      if (anchored) return anchored;
    }
    // 1. Direct hit: the hovered node IS a commentable artifact, OR it's
    //    inside one. closest() finds the NEAREST commentable ancestor.
    const direct = node.matches && node.matches(COMMENTABLE)
      ? node
      : (node.closest && node.closest(COMMENTABLE));
    if (direct && !isInUI(direct) && !(direct.matches && direct.matches(ARTICLE_ROOT_SEL))) {
      // Prefer the OUTERMOST commentable wrapper to handle the nesting case
      // (e.g. a card containing a media SVG — comment on the card, not the
      // svg, when the user hovers anywhere in the card). Climb past inner
      // commentables only when they're enclosed in another commentable
      // that's still inside the content column.
      let best = direct;
      let cur = direct.parentElement;
      let guard = 0;
      while (cur && cur !== document.body && guard++ < 20) {
        if (cur.matches && cur.matches(ARTICLE_ROOT_SEL)) break;
        if (cur.closest && (cur.closest(UI_ALL) || isInUI(cur))) break;
        if (cur.matches && cur.matches(COMMENTABLE) && !isFullWidthBand(cur)) {
          best = cur;
        }
        cur = cur.parentElement;
      }
      // resolveArtifact does final refinement (visual-box detection inside
      // the chosen section); honor it but only if it stays inside `best`.
      const refined = resolveArtifact(best);
      return (refined && best.contains && best.contains(refined)) ? refined : best;
    }
    // 2. Nothing commentable in this hover path. Don't show a pill.
    return null;
  }
  function rectsOverlap(a, b) { return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom); }
  function findArtifactIntersecting(dragRect) {
    const sx = window.scrollX, sy = window.scrollY;
    for (const el of document.querySelectorAll(COMMENTABLE)) {
      if (isInUI(el)) continue;
      const resolved = resolveArtifact(el);
      const r = resolved.getBoundingClientRect();
      const pageRect = { left: r.left + sx, top: r.top + sy, right: r.right + sx, bottom: r.bottom + sy };
      if (rectsOverlap(pageRect, dragRect)) return resolved;
    }
    return null;
  }
  function elementSelector(el) {
    // IDENTITY FIRST: prefer the worker-stamped artifact id (immune to
    // DOM restructuring — same artifact in a different version has the
    // same aid).
    const aid = el.getAttribute && el.getAttribute('data-tdoc-aid');
    if (aid) return `[data-tdoc-aid="${aid}"]`;
    if (el.id) return `#${CSS.escape(el.id)}`;
    // Last-resort positional path (used only for previews before the doc
    // is published — after publish, every artifact has an aid).
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }
  function elementAid(el) {
    return (el && el.getAttribute && el.getAttribute('data-tdoc-aid')) || null;
  }
  function elementLabel(el) {
    return el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || el.tagName.toLowerCase();
  }

  // ── Anchor stability for ELEMENT (artifact) comments ──────────────────
  // Positional selectors like `div > svg:nth-of-type(1)` silently drift to
  // a DIFFERENT artifact when /tdoc edit restructures the DOM (e.g. wraps
  // an svg in a <figure>, or adds a sibling). To make element anchors
  // survive regeneration we capture a CONTENT FINGERPRINT at comment time
  // and validate it at resolve time — if the selector lands on something
  // that isn't the same artifact, we treat the comment as unanchored
  // instead of pointing it at the wrong thing.
  function elementFingerprint(el) {
    if (!el || el.nodeType !== 1) return null;
    // Normalized, length-capped text content (collapses whitespace).
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    // Structural signature: ordered child tag names (one level) + svg/img
    // intrinsics, so two same-tag artifacts with different innards differ.
    const kids = Array.from(el.children).map(c => c.tagName.toLowerCase()).join(',');
    const dims = [
      el.getAttribute('viewBox') || '',
      el.getAttribute('src') || '',
      el.getAttribute('alt') || el.getAttribute('aria-label') || '',
    ].join('|');
    return {
      tag: el.tagName.toLowerCase(),
      text: txt,
      kids,
      meta: dims,
      // cheap stable hash so we can compare without storing huge strings
      h: cyrb53(el.tagName + '' + txt + '' + kids + '' + dims),
    };
  }
  // Small, fast 53-bit string hash (public-domain cyrb53).
  function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  // How well do two fingerprints match? 1 = identical artifact, 0 = no
  // relation. Tag mismatch is disqualifying. Otherwise weight exact-hash,
  // then text similarity, then structural (kids) similarity.
  function fingerprintScore(a, b) {
    if (!a || !b || a.tag !== b.tag) return 0;
    if (a.h === b.h) return 1;
    let s = 0;
    if (a.meta && a.meta === b.meta) s += 0.45;       // same viewBox/src/label
    if (a.kids && a.kids === b.kids) s += 0.25;        // same child structure
    if (a.text && b.text) {
      // token Jaccard on the normalized text
      const A = new Set(a.text.split(' ')), B = new Set(b.text.split(' '));
      let inter = 0; A.forEach(t => { if (B.has(t)) inter++; });
      const uni = A.size + B.size - inter;
      if (uni) s += 0.30 * (inter / uni);
    }
    return s;
  }

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (!t || t.nodeType !== 1 || isInUI(t)) return;
    if (t.closest('button, a, input, select, textarea, [contenteditable], [role="button"]')) return;
    if (isWithinArtifact(t)) return;
    dragState = { x0: e.pageX, y0: e.pageY, marquee: null, dragged: false };
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const dx = e.pageX - dragState.x0, dy = e.pageY - dragState.y0;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragState.dragged = true;
    const dragRect = {
      left: Math.min(dragState.x0, e.pageX), top: Math.min(dragState.y0, e.pageY),
      right: Math.max(dragState.x0, e.pageX), bottom: Math.max(dragState.y0, e.pageY),
    };
    const hit = findArtifactIntersecting(dragRect);
    if (hit) {
      if (!dragState.marquee) {
        dragState.marquee = document.createElement('div');
        dragState.marquee.className = 'tdoc-drag-marquee';
        document.body.appendChild(dragState.marquee);
      }
      dragState.marquee.style.left = Math.min(dragState.x0, e.pageX) + 'px';
      dragState.marquee.style.top = Math.min(dragState.y0, e.pageY) + 'px';
      dragState.marquee.style.width = Math.abs(dx) + 'px';
      dragState.marquee.style.height = Math.abs(dy) + 'px';
    } else if (dragState.marquee) {
      dragState.marquee.remove(); dragState.marquee = null;
    }
  }, true);

  document.addEventListener('mouseup', (e) => {
    // Unified mouseup: drag-to-comment branch first, otherwise fall through to
    // text-selection-popup behavior. Single capture-phase listener avoids the
    // race where drag-end outside an artifact would still trigger the bubble-
    // phase selection-popup handler.
    const ds = dragState;
    if (ds) {
      const { x0, y0, dragged, marquee } = ds;
      dragState = null;
      if (marquee) marquee.remove();
      if (dragged) {
        const dragRect = {
          left: Math.min(x0, e.pageX), top: Math.min(y0, e.pageY),
          right: Math.max(x0, e.pageX), bottom: Math.max(y0, e.pageY),
        };
        const el = findArtifactIntersecting(dragRect);
        if (el) {
          e.preventDefault(); e.stopPropagation();
          hideHoverUI();
          openPopup({ kind: 'element', selector: elementSelector(el), label: elementLabel(el), _el: el }, el.getBoundingClientRect());
          return;
        }
        // Dragged but no artifact hit — likely a text selection. Fall through.
      }
    }
    maybeOpenSelectionPopup(e.target, e);
  }, true);

  // Mouse and touch both surface here. On iOS Safari long-press text-selection
  // does NOT fire mouseup, so we also listen for touchend. selectionchange
  // would seem cleaner but fires continuously during a drag — touchend gives
  // us a single "selection finished" signal.
  document.addEventListener('touchend', (e) => {
    const t = e.target || (e.changedTouches?.[0] && document.elementFromPoint(e.changedTouches[0].clientX, e.changedTouches[0].clientY));
    // Touchend fires before the OS finalizes selection — defer one tick.
    const touch = e.changedTouches && e.changedTouches[0];
    setTimeout(() => maybeOpenSelectionPopup(t, touch || e), 0);
  }, true);

  // An author can mark a phrase as an invitation: `data-tdoc-select`. Clicking
  // it selects that phrase and hands off to the same popup a drag-select
  // opens, so the page teaches the gesture without shipping a second
  // composer that could drift from this one. A click costs less than a drag,
  // and a reader who will not drag will still tap.
  document.addEventListener('click', (e) => {
    const invite = e.target?.closest?.('[data-tdoc-select]');
    if (!invite || isInUI(invite)) return;
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(invite);
    sel.removeAllRanges();
    sel.addRange(range);
    maybeOpenSelectionPopup(invite);
  }, true);

  // A text selection should stay inside one "artifact context": bare prose, or
  // the inside of a single commentable artifact. A drag that starts in prose and
  // overshoots into a table used to paint the whole table (the pending highlight
  // spans every text node the range crosses) and fold table text into a prose
  // comment. Clamp the range to the start's context so the selection is what the
  // reader actually meant. Selecting *within* one artifact (both ends inside the
  // same table) is untouched — that is a legitimate comment on that text.
  function artifactContextOf(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el ? el.closest(COMMENTABLE) : null;   // null = the bare prose column
  }
  function clampRangeToArtifactContext(range) {
    const startCtx = artifactContextOf(range.startContainer);
    const endCtx = artifactContextOf(range.endContainer);
    if (startCtx === endCtx) return range;        // same context — nothing to clamp
    try {
      if (endCtx && !endCtx.contains(range.startContainer)) {
        range.setEndBefore(endCtx);               // bled forward into an artifact — stop before it
      } else if (startCtx && !startCtx.contains(range.endContainer)) {
        range.setStartAfter(startCtx);            // started inside an artifact, ran out — start after it
      }
    } catch (e) { /* setEnd/StartBefore can throw on detached / cross-root nodes */ }
    return range;
  }

  function maybeOpenSelectionPopup(target, event) {
    // Selected text wins over "comment whole artifact." If there's a real text
    // selection, open the text-selection popup regardless of whether the
    // selection lives inside a commentable artifact. The hover pill remains
    // the path for "comment on the whole artifact" — they don't compete
    // because they're driven by different gestures (hover vs. drag-select).
    if (target && target.nodeType === 1 && isInUI(target)) return;
    const sel = window.getSelection();
    let text = sel && sel.toString().trim();
    if (!text || text.length < 2 || !sel.rangeCount) return;
    const anchorNode = sel.anchorNode;
    const anchorEl = anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement;
    if (anchorEl && isInUI(anchorEl)) return;
    const range = clampRangeToArtifactContext(sel.getRangeAt(0).cloneRange());
    // The clamp may have trimmed a bled-into artifact; re-derive from the range
    // so text, highlight, and the committed anchor all agree.
    text = range.toString().trim();
    if (!text || text.length < 2) return;
    const ctx = getContext(range, 60);
    // Re-anchor mode: rebind an existing unanchored comment to this selection
    // instead of creating a new one. Captured fallback position is refreshed
    // too so the comment "moves" to where the user just selected.
    if (state.reanchoringId) {
      const id = state.reanchoringId;
      exitReanchor();
      const newAnchor = {
        kind: 'text', text, context_before: ctx.before, context_after: ctx.after,
        fallback: captureFallbackPosition({ kind: 'text', _range: range }),
      };
      // Optimistic UI: drop the old anchor's highlight immediately so the
      // user never sees stale yellow on the previous location while the
      // PATCH is in flight. refreshComments() will repaint with the new
      // anchor once the server confirms.
      state.anchorMarks.delete(id);
      rebuildSharedHighlights();
      window.getSelection()?.removeAllRanges();
      fetch('/api/comments', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, id, anchor: newAnchor, version }),
      }).then(r => {
        if (r.status === 401) startDeviceFlow();
        return r.ok ? refreshComments() : null;
      });
      return;
    }
    const rect = selectionEndRect(sel, range, event);
    if (!rect) return;
    openPopup({ kind: 'text', text, context_before: ctx.before, context_after: ctx.after, _range: range }, rect);
  }

  // Where the user *finished* the selection — mouse-up / caret — not the
  // left edge of the line box. That's what the popup must sit under.
  function selectionEndRect(sel, range, event) {
    const pointerX = event && Number.isFinite(event.clientX) ? event.clientX : NaN;
    const pointerY = event && Number.isFinite(event.clientY) ? event.clientY : NaN;
    if (Number.isFinite(pointerX) && Number.isFinite(pointerY)) {
      const line = clientRectNearPoint(range, pointerX, pointerY);
      const onLine = endRectOnLine(line, pointerX);
      if (onLine) return onLine;
    }
    if (sel && sel.focusNode != null) {
      try {
        const caret = document.createRange();
        caret.setStart(sel.focusNode, sel.focusOffset);
        caret.collapse(true);
        const cr = caret.getBoundingClientRect();
        if (cr && (cr.height > 0 || cr.width > 0 || cr.left !== 0 || cr.top !== 0)) {
          const line = clientRectNearPoint(range, cr.left, cr.top + cr.height / 2)
            || { top: cr.top, bottom: cr.bottom || cr.top + 16, height: cr.height || 16, right: cr.left };
          return endRectOnLine(line, cr.left);
        }
      } catch { /* focus not in a text node */ }
    }
    const rects = range.getClientRects ? range.getClientRects() : [];
    let last = null;
    for (let i = 0; i < rects.length; i++) {
      if (isVisibleClientRect(rects[i])) last = rects[i];
    }
    if (last) return endRectOnLine(last, last.right);
    return firstVisibleClientRect(range);
  }

  // Begin the re-anchor flow: future text selection on the doc will rebind
  // this comment instead of creating a new one. Toggle off if clicked again.
  function startReanchor(id) {
    if (state.reanchoringId === id) { exitReanchor(); return; }
    state.reanchoringId = id;
    document.body.classList.add('tdoc-reanchoring');
  }
  function exitReanchor() {
    state.reanchoringId = null;
    document.body.classList.remove('tdoc-reanchoring');
  }
  // Capture a fallback position for an existing comment by reading the
  // current anchor's location, so an unanchored card stays where it was.
  function fallbackFromExistingAnchor(commentId) {
    const mark = state.anchorMarks.get(commentId);
    if (!mark) return null;
    const metrics = getArticleMetrics();
    const articleEl = metrics.el || document.body;
    const articleTop = articleEl.getBoundingClientRect().top + window.scrollY;
    const articleHeight = Math.max(1, articleEl.scrollHeight);
    let rect = null;
    if (mark.ranges?.[0]) rect = firstVisibleClientRect(mark.ranges[0]);
    else if (mark.el) rect = firstVisibleClientRect(mark.el) || mark.el.getBoundingClientRect();
    else if (mark.targetEl) rect = firstVisibleClientRect(mark.targetEl) || mark.targetEl.getBoundingClientRect();
    if (!rect) return null;
    const centerY = rect.top + rect.height / 2 + window.scrollY;
    return { ratio: Math.max(0, Math.min(1, (centerY - articleTop) / articleHeight)), nearestHeading: null };
  }
  // Wire banner buttons (created once near the bar). The banner is the
  // only place we expose "remove anchor" — keeps cards uncluttered and
  // resolves the gesture conflict you'd hit with "click empty space".
  document.getElementById('tdoc-reanchor-cancel').onclick = (e) => { e.stopPropagation(); exitReanchor(); };
  document.getElementById('tdoc-reanchor-remove').onclick = async (e) => {
    e.stopPropagation();
    const id = state.reanchoringId;
    if (!id) return;
    const fallback = fallbackFromExistingAnchor(id);
    exitReanchor();
    // Optimistic: clear the old highlight before the network call. If the
    // PATCH fails we'll just re-fetch and the anchor will return — no
    // worse than the pre-click state.
    state.anchorMarks.delete(id);
    rebuildSharedHighlights();
    const r = await fetch('/api/comments', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, id, anchor: { kind: 'none', fallback }, version }),
    });
    if (r.status === 401) { startDeviceFlow(); return; }
    if (!r.ok) { const err = await r.json().catch(() => ({})); alert('Could not remove anchor: ' + (err.error || `HTTP ${r.status}`)); return; }
    await refreshComments();
  };

  // ========== Hover affordance ==========
  // ========== Artifact hover affordance ==========
  // Hovering an unanchored commentable element (img/canvas/svg/video/pre)
  // shows: (1) a dashed blue outline around it, (2) a clickable "Comment" pill
  // in its top-right corner. Click the pill → opens the comment popup anchored
  // to that element. This is the discoverable path; drag-from-outside also
  // works for users who prefer that gesture.
  // The artifact section is ONE unit. Hovering anywhere inside it shows a
  // single Comment button anchored to the section's top-right corner — no
  // full outline. While the cursor stays anywhere within the same section
  // the button does not move or flicker.
  let commentPill = null, pillTargetEl = null;
  function showHoverUI(el) {
    if (isFork) return; // read-only: no new-comment affordances
    if (pillTargetEl === el && commentPill) return; // same section — keep as-is
    hideHoverUI();
    const r = el.getBoundingClientRect();

    commentPill = document.createElement('button');
    commentPill.className = 'tdoc-comment-pill';
    commentPill.type = 'button';
    commentPill.setAttribute('aria-label', 'Comment on this section');
    commentPill.title = 'Comment on this section';
    commentPill.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    // Top-right corner of the SECTION, so it visually belongs to the whole
    // artifact regardless of where inside it the cursor is.
    const pillW = 30;
    commentPill.style.top = (window.scrollY + r.top + 8) + 'px';
    commentPill.style.left = (window.scrollX + Math.max(r.left + 8, r.right - pillW - 8)) + 'px';
    commentPill.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      const target = pillTargetEl;
      const pillRect = commentPill.getBoundingClientRect();
      hideHoverUI();
      if (!target) return;
      openPopup({
        kind: 'element',
        selector: elementSelector(target),
        label: elementLabel(target),
        _el: target,
        _placeAbove: true,
      }, pillRect);
    };
    pillTargetEl = el;
    document.body.appendChild(commentPill);
  }
  function hideHoverUI() {
    if (commentPill) { commentPill.remove(); commentPill = null; }
    pillTargetEl = null;
  }

  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    // The pill itself is in `body` — don't hide UI when the cursor enters it.
    if (t.closest('.tdoc-comment-pill')) return;
    if (isInUI(t)) { hideHoverUI(); return; }
    // ANY element under the cursor → the artifact section it belongs to
    // (the ring, a button, a label, empty padding — all map to the SAME
    // section). Hovering anywhere inside one artifact targets the whole
    // artifact as one unit.
    const section = artifactSectionOf(t);
    if (!section || isInUI(section)) { hideHoverUI(); return; }
    showHoverUI(section);
  });
  document.addEventListener('mouseout', (e) => {
    const next = e.relatedTarget;
    if (!next) { hideHoverUI(); return; }
    // Stay shown if cursor moves into the Comment button.
    if (next.closest && next.closest('.tdoc-comment-pill')) return;
    // Stay shown while the cursor remains anywhere inside the SAME section.
    if (pillTargetEl && pillTargetEl.contains && pillTargetEl.contains(next)) return;
    if (pillTargetEl && artifactSectionOf(next) === pillTargetEl) return;
    if (isInUI(next)) hideHoverUI();
  });

  // ========== Selection → popup ==========
  // (See unified mouseup handler above — selection-popup branch lives in the
  // capture-phase handler so drag and selection cannot race.)

  // ========== Root click handler (delegated): menus, drawer, deselect, anchor click ==========
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || t.nodeType !== 1) return;

    // Close menus that aren't under the cursor
    if (secMenu && !t.closest('#tdoc-more-btn') && !t.closest('#tdoc-secondary-menu')) secMenu.classList.remove('open');
    if (!t.closest('.tdoc-menu-wrap')) {
      if (dlMenu) dlMenu.classList.remove('open');
      if (dlBtn) dlBtn.setAttribute('aria-expanded', 'false');
    }
    // Close the profile menu on any click outside its wrapper.
    if (!t.closest('#tdoc-me') && !t.closest('#tdoc-me-menu')) {
      const mm = document.getElementById('tdoc-me-menu');
      const mb = document.getElementById('tdoc-me');
      if (mm) mm.classList.remove('open');
      if (mb) mb.setAttribute('aria-expanded', 'false');
    }
    if (!t.closest('.tdoc-version-wrap')) {
      const vm = document.getElementById('tdoc-version-menu');
      const vt = document.getElementById('tdoc-version-toggle');
      if (vm) vm.classList.remove('open');
      if (vt) vt.setAttribute('aria-expanded', 'false');
    }
    if (!t.closest('.tdoc-emoji-picker') && !t.closest('.tdoc-react-add')) closeEmojiPicker();

    // Close drawer on outside click (narrow only)
    if (commentLayer.classList.contains('open') &&
        !t.closest('#tdoc-comment-layer, .tdoc-fab, .tdoc-popup, .tdoc-modal-bg, .tdoc-emoji-picker')) {
      commentLayer.classList.remove('open');
    }

    // Custom-Highlight API: hit-test anchor ranges to detect anchor click.
    if (HIGHLIGHT_API && !isInUI(t)) {
      const hitId = findCommentAtPoint(e.clientX, e.clientY);
      if (hitId) { setActiveComment(hitId); return; }
    }

    // Deselect when clicking truly-outside the UI + outside any anchor/artifact.
    if (isInUI(t)) return;
    for (const mark of state.anchorMarks.values()) {
      const target = mark.targetEl || mark.el;
      if (target && (target === t || (target.contains && target.contains(t)))) return;
    }
    setActiveComment(null);
    const sel = window.getSelection();
    if (sel && sel.toString().trim() === '' && sel.rangeCount > 0) sel.removeAllRanges();
  });

  // ========== Copy as Markdown ==========
  function htmlToMarkdown(root) {
    function walk(node, ctx) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.nodeValue;
        if (ctx.inPre) return t;
        return t.replace(/\s+/g, ' ');
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      if (node.classList && (
        node.classList.contains('tdoc-bar') ||
        node.classList.contains('tdoc-popup') ||
        node.classList.contains('tdoc-margin-comment') ||
        node.classList.contains('tdoc-modal-bg') ||
        node.classList.contains('tdoc-element-outline') ||
        node.classList.contains('tdoc-hover-outline') ||
        node.id === 'tdoc-comment-layer'
      )) return '';
      const tag = node.tagName.toLowerCase();
      const kids = () => Array.from(node.childNodes).map(c => walk(c, ctx)).join('');
      switch (tag) {
        case 'h1': return '\n\n# ' + kids().trim() + '\n\n';
        case 'h2': return '\n\n## ' + kids().trim() + '\n\n';
        case 'h3': return '\n\n### ' + kids().trim() + '\n\n';
        case 'h4': return '\n\n#### ' + kids().trim() + '\n\n';
        case 'h5': return '\n\n##### ' + kids().trim() + '\n\n';
        case 'h6': return '\n\n###### ' + kids().trim() + '\n\n';
        case 'p': return '\n\n' + kids().trim() + '\n\n';
        case 'br': return '  \n';
        case 'hr': return '\n\n---\n\n';
        case 'strong': case 'b': return '**' + kids() + '**';
        case 'em': case 'i': return '*' + kids() + '*';
        case 'code': return ctx.inPre ? kids() : '`' + kids() + '`';
        case 'pre': {
          const c = { ...ctx, inPre: true };
          const lang = node.querySelector('code')?.className?.match(/language-([\w-]+)/)?.[1] || '';
          const inner = Array.from(node.childNodes).map(n => walk(n, c)).join('');
          return '\n\n```' + lang + '\n' + inner.replace(/\n$/, '') + '\n```\n\n';
        }
        case 'blockquote':
          return '\n\n' + kids().trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
        case 'ul': {
          const items = Array.from(node.children).filter(c => c.tagName === 'LI');
          return '\n\n' + items.map(li => '- ' + walk(li, ctx).trim()).join('\n') + '\n\n';
        }
        case 'ol': {
          const items = Array.from(node.children).filter(c => c.tagName === 'LI');
          return '\n\n' + items.map((li, i) => (i + 1) + '. ' + walk(li, ctx).trim()).join('\n') + '\n\n';
        }
        case 'li': return kids();
        case 'a': {
          const href = node.getAttribute('href') || '';
          const text = kids().trim();
          return href ? `[${text}](${href})` : text;
        }
        case 'img': {
          const src = node.getAttribute('src') || '';
          const alt = node.getAttribute('alt') || '';
          return `![${alt}](${src})`;
        }
        case 'svg': case 'canvas': case 'video': case 'iframe':
          return `\n\n[${tag} embed]\n\n`;
        case 'figure': return '\n\n' + kids().trim() + '\n\n';
        case 'figcaption': return '\n\n*' + kids().trim() + '*\n\n';
        case 'table': {
          const rows = Array.from(node.querySelectorAll('tr'));
          if (!rows.length) return '';
          const cells = (r) => Array.from(r.children).map(c => walk(c, ctx).trim().replace(/\|/g, '\\|'));
          const head = cells(rows[0]);
          const body = rows.slice(1).map(cells);
          return '\n\n| ' + head.join(' | ') + ' |\n| ' + head.map(() => '---').join(' | ') + ' |\n' +
                 body.map(r => '| ' + r.join(' | ') + ' |').join('\n') + '\n\n';
        }
        case 'th': case 'td': case 'tr': return kids();
        default: return kids();
      }
    }
    return walk(root, { inPre: false }).replace(/\n{3,}/g, '\n\n').trim();
  }

  async function copyText(s) {
    try { await navigator.clipboard.writeText(s); return true; }
    catch {
      const ta = document.createElement('textarea');
      ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }
  function flashToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:18px;right:18px;background:#0a0a0a;color:#fff;padding:8px 14px;border-radius:6px;font:12px system-ui;z-index:1000001;opacity:0;transition:opacity 0.15s;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,0.2);';
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '0.95'; });
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 200); }, 1400);
  }
  function reactionsToMd(reactions) {
    if (!reactions) return '';
    const parts = Object.entries(reactions).filter(([, u]) => u && u.length > 0).map(([e, u]) => `${e} ${u.length}`);
    return parts.length ? `_reactions: ${parts.join(' · ')}_\n` : '';
  }
  function commentToMd(c) {
    const who = c.author ? `**@${c.author.login}**` : '*anonymous*';
    const when = new Date(c.created).toLocaleString();
    let anchorLine = '';
    if (c.anchor) {
      if (c.anchor.kind === 'element' || c.anchor.selector) anchorLine = `> _on ${c.anchor.label || c.anchor.selector}_\n`;
      else if (c.anchor.text) anchorLine = `> "${c.anchor.text.replace(/\n/g, ' ').slice(0, 200)}"\n`;
    }
    let md = `${who} — _${when}_\n${anchorLine}\n${c.text}\n${reactionsToMd(c.reactions)}`;
    if (Array.isArray(c.replies) && c.replies.length) {
      for (const r of c.replies) {
        const rwho = r.author ? `**@${r.author.login}**` : '*anonymous*';
        const rwhen = new Date(r.created).toLocaleString();
        md += `  ↳ ${rwho} — _${rwhen}_\n    ${r.text}\n    ${reactionsToMd(r.reactions)}`;
      }
    }
    return md;
  }

  window.__tdocCopyDocMd = async function (includeComments) {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll(UI_ALL + ', script, style, noscript').forEach(n => n.remove());
    let md = htmlToMarkdown(clone);
    if (includeComments && state.activeComments.length) {
      md += '\n\n---\n\n## Comments\n\n' + state.activeComments.map(commentToMd).join('\n---\n\n');
    }
    const ok = await copyText(md);
    // Copy now lives in the ⋯ menu, which closes on click, so there's no bar
    // button to flash — confirm with a toast instead.
    flashToast(ok ? 'Copied as Markdown' : 'Copy failed');
  };
  window.__tdocCopyCommentMd = async function (commentId, srcBtn) {
    const c = state.activeComments.find(x => x.id === commentId);
    if (!c) return;
    const ok = await copyText(commentToMd(c));
    if (ok && srcBtn) {
      const origHTML = srcBtn.innerHTML, origColor = srcBtn.style.color;
      srcBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      srcBtn.style.color = '#3ecf8e';
      setTimeout(() => { srcBtn.innerHTML = origHTML; srcBtn.style.color = origColor; }, 1200);
    } else if (!ok) flashToast('Copy failed');
  };

  // Document tables/SVGs must stay fully visible in the 720px reading column.
  // Negative-margin table styles used to clip the first column inside author
  // overflow-x:auto wrappers; display:block on <table> broke row layout.
  // Wrap remaining tables so wide ones scroll instead of overflowing or clipping.
  function wrapScrollableTables() {
    document.querySelectorAll('body table').forEach(table => {
      if (table.closest(UI_CONTAINERS)) return;
      if (table.parentElement && table.parentElement.closest('table')) return;
      const parent = table.parentElement;
      if (!parent) return;
      if (parent.classList.contains('tdoc-table-scroll')) return;
      const ox = getComputedStyle(parent).overflowX;
      if (ox === 'auto' || ox === 'scroll') return;
      const wrap = document.createElement('div');
      wrap.className = 'tdoc-table-scroll';
      parent.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
  }
  function preserveSvgAspect() {
    document.querySelectorAll('body svg[viewBox]').forEach(svg => {
      if (svg.closest(UI_CONTAINERS)) return;
      const parts = String(svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/);
      if (parts.length !== 4) return;
      const w = parseFloat(parts[2]), h = parseFloat(parts[3]);
      if (!(w > 0 && h > 0)) return;
      if (!svg.style.aspectRatio) svg.style.aspectRatio = w + ' / ' + h;
    });
  }

  // ========== Wire it up ==========
  wrapScrollableTables();
  preserveSvgAspect();
  refreshComments();
})();
