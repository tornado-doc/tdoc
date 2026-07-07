// tdoc overlay — single-file design.
// Sections are demarcated with `// ========== Name ==========` headers so the
// file reads like several concatenated modules. Each section depends only on
// the ones above it (and on `state`). No section reaches sideways.
//
// External contract preserved verbatim:
//   - Endpoints: /api/comments, /api/reactions, /api/auth/device/start,
//     /api/auth/device/poll, /api/auth/logout, /d/<slug>/v/<n>/export
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
  let isOwner = !!cfg.isOwner; // true only for the configured TDOC_OWNER
  if (!slug) return;

  const HIGHLIGHT_API = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  // Phones need this or they render at a virtual ~980px viewport.
  if (!document.querySelector('meta[name="viewport"]')) {
    const m = document.createElement('meta');
    m.name = 'viewport';
    m.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    document.head.appendChild(m);
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
  const UI_CONTAINERS = '.tdoc-bar, .tdoc-oldver-strip, .tdoc-popup, .tdoc-margin-comment, .tdoc-modal-bg, #tdoc-comment-layer, #tdoc-pin-layer, .tdoc-cluster-pop, .tdoc-footer';
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
  body { padding-top: 44px !important; padding-bottom: 24px; -webkit-user-select: text; user-select: text; }
  body .tdoc-bar, body .tdoc-bar *, body #tdoc-comment-layer, body #tdoc-comment-layer *, body #tdoc-pin-layer, body #tdoc-pin-layer *, body .tdoc-cluster-pop, body .tdoc-cluster-pop *, body .tdoc-hover-outline, body .tdoc-comment-pill, body .tdoc-emoji-picker, body .tdoc-secondary-menu, body .tdoc-anchor-mark.tdoc-anchor-mark-element, body .tdoc-drag-marquee, body .tdoc-modal, body .tdoc-modal * { -webkit-user-select: none !important; user-select: none !important; }
  body .tdoc-modal .code, body .tdoc-modal textarea, body .tdoc-modal input { -webkit-user-select: text !important; user-select: text !important; }
  /* Reserve the 320px comment column on the right. The article centers
     itself inside the remaining (viewport - 320px) space via margin auto
     (applied below in :where()). Adding a left padding keeps it from
     hugging the screen edge on wide windows. */
  body.tdoc-has-comments:not(.tdoc-narrow) { padding-right: 360px !important; padding-left: 80px !important; }
  body.tdoc-narrow { padding-right: 0 !important; }
  /* Center the article container in the reading column. :where() so any
     doc-defined margin wins. Applies only on wide layouts; narrow mode
     uses the full body width via the drawer. */
  body:not(.tdoc-narrow) :where(body > .wrap, body > main, body > article, body > .content, body > .container) {
    margin-left: auto !important;
    margin-right: auto !important;
  }
  /* The body right-padding reserves space for the comment column. The
     article centers itself naturally inside the remaining (viewport minus
     320px) space via its own margin auto. As the window shrinks, the symmetric
     margins shrink with it; once they hit the article's min width, narrow-mode
     takes over and the drawer kicks in. */
  /* ========== Default doc template (single typography template) ==========
     One canonical look for every tdoc doc: same font stack, sizes, spacing,
     headings, lists, code, tables, quotes. Wrapped in :where() so a doc that
     truly needs a different aesthetic can override per element. Future
     templates would live alongside this block, switched by a body class. */
  /* Default template, modeled after Claude Code's markdown rendering.
     Readable, system-fonts, rounded-cell tables, circle task checkboxes. */
  :where(body) {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 17px;
    line-height: 1.6;
    color: #1a1a1a;
    background: #fff;
    text-rendering: optimizeLegibility;
    -webkit-font-smoothing: antialiased;
  }
  :where(body h1) { font-size: 38px; line-height: 1.15; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 20px; color: #1a1a1a; }
  :where(body h2) { font-size: 27px; line-height: 1.25; font-weight: 700; letter-spacing: -0.01em; margin: 44px 0 14px; color: #1a1a1a; }
  :where(body h3) { font-size: 21px; line-height: 1.35; font-weight: 700; margin: 32px 0 10px; color: #1a1a1a; }
  :where(body h4) { font-size: 17px; font-weight: 700; margin: 22px 0 6px; color: #1a1a1a; }
  :where(body h5, body h6) { font-size: 14px; font-weight: 600; margin: 16px 0 4px; color: #1a1a1a; text-transform: uppercase; letter-spacing: 0.06em; }
  :where(body p) { margin: 0 0 16px; }
  :where(body a) { color: #1652f0; text-decoration: underline; text-underline-offset: 2px; }
  :where(body a:hover) { text-decoration-thickness: 2px; }
  :where(body ul, body ol) { margin: 0 0 18px; padding-left: 26px; }
  :where(body li) { margin: 8px 0; }
  :where(body blockquote) { margin: 20px 0; padding: 2px 0 2px 20px; border-left: 3px solid #d9d8d3; color: #6b6a66; }
  :where(body code) { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.88em; background: #f0f0ee; padding: 2px 6px; border-radius: 6px; }
  :where(body pre) { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 14.5px; line-height: 1.6; background: #f7f7f5; border: 1px solid #e8e7e3; border-radius: 10px; padding: 16px 18px; margin: 20px 0; overflow-x: auto; }
  :where(body pre code) { background: transparent; padding: 0; border-radius: 0; }
  :where(body hr) { border: 0; border-top: 1px solid #e8e7e3; margin: 36px 0; }
  /* Tables: Claude-style rounded cells with white gutters — no rules/borders.
     NOTE: no negative left margin here. A negative margin pulls the table's
     left edge outside its containing block, and any table inside an
     overflow:auto/scroll wrapper (which our own authoring guidance in SKILL.md
     recommends, and which the @media rule below also creates) then CLIPS that
     overhang — the first column gets cut off and is unreachable by scroll.
     Tables sit flush in their container instead; first-cell text is indented
     by the cell padding, exactly like GitHub/Claude markdown tables. */
  :where(body table) { border-collapse: separate; border-spacing: 3px; margin: 0 0 18px; font-size: 16px; }
  :where(body th, body td) { padding: 10px 14px; background: #f0f0ee; border-radius: 8px; border: 0; text-align: left; }
  :where(body th) { font-weight: 600; color: #1a1a1a; }
  :where(body figcaption) { font-size: 13px; color: #6b6a66; margin-top: 6px; text-align: center; }
  /* Task lists: circle checkboxes, Claude Code style. Works for raw
     <input type=checkbox> in lists and markdown-converted .task-list-item. */
  :where(body li:has(> input[type="checkbox"]), body li.task-list-item) { list-style: none; margin-left: -26px; }
  :where(body input[type="checkbox"]) {
    appearance: none; -webkit-appearance: none;
    width: 17px; height: 17px;
    border: 1.5px solid #c9c8c3; border-radius: 50%;
    vertical-align: -3px; margin: 0 8px 0 0;
    background: #fff; cursor: default;
  }
  :where(body input[type="checkbox"]:checked) {
    background: #1a1a1a center / 11px no-repeat url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M3 8.5l3.5 3.5L13 5" stroke="white" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    border-color: #1a1a1a;
  }
  /* Doc imagery only — exclude overlay UI so icons inside the bar / chips /
     buttons / cards keep their inline layout instead of stacking to 16px tall. */
  :where(body img, body svg, body canvas, body video):not(.tdoc-bar *):not(.tdoc-margin-comment *):not(.tdoc-popup *):not(.tdoc-modal-bg *):not(.tdoc-chip *):not(.tdoc-fab *):not(#tdoc-comment-layer *):not(#tdoc-pin-layer *):not(.tdoc-cluster-pop *):not(.tdoc-footer *) { display: block; margin: 16px auto; border-radius: 6px; }
  /* Reading column for the doc container. :where() so a doc's own rule wins. */
  :where(body > .wrap, body > main, body > article, body > .content, body > .container) {
    max-width: 720px;
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
  /* Wide tables: keep TRUE table layout on desktop — display:block on a
     table element discards real table layout for anonymous-box fixup, which
     some engines render with uneven row heights and gaps (seen on published
     docs). Only degrade to a scrollable block on narrow viewports, where
     horizontal overflow is the bigger evil. NOTE: no backticks in comments
     here — this CSS lives inside a JS template literal. */
  :where(body table) { max-width: 100%; }
  @media (max-width: 760px) {
    :where(body table) { display: block; overflow-x: auto; }
  }
  /* Pre/code blocks scroll horizontally instead of breaking the layout. */
  :where(body pre) { max-width: 100%; overflow-x: auto; }

  /* ========== Top bar (HackMD-inspired rhythm) ==========
     Three groups: left breadcrumb (workspace + slug + version), center
     doc title (truncates), right cluster (identity, primary CTA, more).
     No borders on individual buttons — uses hover background instead, so
     the bar reads as a clean strip rather than a row of chiclets.
     Light theme to match the doc body. */
  .tdoc-bar { position: fixed; top: 0; left: 0; right: 0; height: 48px; background: #fff; color: #1a1a1a; display: flex; align-items: center; padding: 0 12px; font: 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; z-index: 999999; gap: 8px; border-bottom: 1px solid #e5e5e7; box-shadow: 0 1px 2px rgba(0,0,0,0.02); }
  .tdoc-bar-left { display: flex; align-items: center; gap: 6px; min-width: 0; flex-shrink: 1; }
  .tdoc-bar-center { flex: 1 1 auto; display: flex; justify-content: center; min-width: 0; padding: 0 8px; }
  .tdoc-bar-right { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

  /* Workspace mark — circular dot like HackMD's logo. Clicks → /. */
  .tdoc-bar-mark { display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 12px; border-radius: 999px; background: #1652f0; color: #fff; font-weight: 700; font-size: 13px; letter-spacing: -0.01em; cursor: pointer; flex-shrink: 0; border: none; }
  .tdoc-bar-mark:hover { background: #1245d0; }

  /* Breadcrumb: workspace · slug · v3 — separated by " / ". */
  .tdoc-bar .crumb { color: #555; font-weight: 500; padding: 4px 6px; border-radius: 6px; max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tdoc-bar .crumb-sep { color: #c0c0c4; user-select: none; padding: 0 1px; }
  .tdoc-bar .doc-title { color: #1a1a1a; font-weight: 600; font-size: 14px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Default action button — icon and/or label, no border, hover bg only. */
  .tdoc-bar button { background: transparent; border: none; color: #555; padding: 6px 8px; border-radius: 6px; font: inherit; cursor: pointer; transition: background .12s, color .12s; display: inline-flex; align-items: center; gap: 6px; }
  .tdoc-bar button:hover { background: #f0f1f4; color: #1a1a1a; }
  .tdoc-bar button:disabled { opacity: 0.5; cursor: not-allowed; }
  .tdoc-bar button svg { flex-shrink: 0; }

  /* Primary CTA (Share / Publish) — filled blue button at the right. */
  .tdoc-bar button.primary { background: #1652f0; color: #fff; padding: 7px 14px; font-weight: 600; }
  .tdoc-bar button.primary:hover { background: #1245d0; color: #fff; }

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
  .tdoc-version-menu button.current { color: #1652f0; font-weight: 600; }

  .tdoc-menu-wrap { position: relative; display: inline-block; }
  /* Overflow ⋯ button shows on narrow viewports. */
  .tdoc-bar .tdoc-secondary-toggle { display: none; padding: 6px 10px; }

  /* Identity chip — avatar + name (name hides on narrow). */
  .tdoc-chip { display: inline-flex; align-items: center; gap: 8px; padding: 3px 12px 3px 3px; background: #f0f1f4; border-radius: 999px; cursor: pointer; color: #1a1a1a; font: inherit; border: none; }
  .tdoc-chip:hover { background: #e5e6ea; }
  .tdoc-chip img { width: 26px; height: 26px; border-radius: 50%; }
  .tdoc-chip .name { font-size: 13px; font-weight: 500; }
  .tdoc-chip.signin { padding: 7px 14px; background: #1652f0; color: #fff; font-weight: 600; }
  .tdoc-chip.signin:hover { background: #1245d0; }

  /* Comment cards */
  #tdoc-comment-layer { position: absolute; top: 0; left: 0; width: 100%; pointer-events: none; z-index: 999996; }
  .tdoc-margin-comment { position: absolute; width: 280px; background: #fff; border: 1px solid #e5e5e5; border-radius: 10px; padding: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); font: 13px system-ui, sans-serif; transition: box-shadow .15s, transform .15s; z-index: 999996; pointer-events: auto; }
  .tdoc-margin-comment.active { box-shadow: 0 4px 16px rgba(22,82,240,0.18); border-color: #1652f0; }
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
  .tdoc-reanchor-btn:hover { color: #1652f0; }
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
  .tdoc-reanchor-banner { display: none; position: fixed; top: 56px; left: 50%; transform: translateX(-50%); background: #1652f0; color: #fff; padding: 6px 10px 6px 14px; border-radius: 999px; font: 12px system-ui; z-index: 999999; align-items: center; gap: 6px; box-shadow: 0 4px 16px rgba(22,82,240,0.35); }
  body.tdoc-reanchoring .tdoc-reanchor-banner { display: inline-flex; }
  .tdoc-reanchor-banner .label { padding: 0 4px; }
  .tdoc-reanchor-banner button { background: rgba(255,255,255,0.15); border: none; color: #fff; padding: 4px 10px; border-radius: 999px; font: 12px system-ui; cursor: pointer; }
  .tdoc-reanchor-banner button:hover { background: rgba(255,255,255,0.28); }
  .tdoc-reanchor-banner button.danger { background: rgba(255,255,255,0.15); }
  .tdoc-reanchor-banner button.danger:hover { background: #c33; }
  /* Old-version strip — a thin, quiet bar just under the top bar shown when
     the viewer is on a non-latest version. Single-direction nudge: it only
     points forward to the latest version. Hidden by default; the bar-setup
     code reveals it (and adds the body padding) only when version < latest. */
  .tdoc-oldver-strip { display: none; position: fixed; top: 44px; left: 0; right: 0; height: 28px; background: #fbf6e9; color: #6b5e3a; border-bottom: 1px solid #efe6cd; font: 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; align-items: center; justify-content: center; gap: 6px; z-index: 999998; padding: 0 12px; }
  body.tdoc-has-oldver-strip .tdoc-oldver-strip { display: flex; }
  body.tdoc-has-oldver-strip { padding-top: 72px !important; }
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
  /* Agent identity — a simple "⚡ tdoc-agent" badge in place of an avatar.
     The status chip on agent replies (applied / partial / question) lets
     the user tell at a glance whether their comment was addressed. */
  .tdoc-agent-badge { display: inline-flex; width: 24px; height: 24px; border-radius: 50%; background: #111; color: #fff; align-items: center; justify-content: center; font-size: 13px; }
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
  .tdoc-margin-comment .copy-md:hover { color: #1652f0; }
  .tdoc-margin-comment .copy-md svg { width: 14px; height: 14px; display: block; }
  .tdoc-margin-comment .tdoc-reply-toggle { cursor: pointer; color: #1652f0; }
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
  .tdoc-pin:hover, .tdoc-pin.tdoc-pin-active { transform: scale(1.12); border-color: #1652f0; box-shadow: 0 2px 8px rgba(22,82,240,0.25); z-index: 1; }
  .tdoc-pin img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }
  .tdoc-pin .tdoc-pin-anon { width: 100%; height: 100%; border-radius: 50%; background: #8a93a2; }
  /* Resolved pins get a green ring + a small ✓ overlay badge. */
  .tdoc-pin.tdoc-pin-resolved { border-color: #1a7340; }
  .tdoc-pin.tdoc-pin-resolved::after { content: "✓"; position: absolute; right: -3px; bottom: -3px; width: 14px; height: 14px; border-radius: 50%; background: #1a7340; color: #fff; font-size: 9px; line-height: 14px; text-align: center; font-weight: 700; }
  /* Cluster badge — N comments at the same Y collapsed into one marker. */
  .tdoc-pin.tdoc-pin-cluster { background: #1652f0; border-color: #1652f0; color: #fff; font: 600 12px system-ui; }
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
  .tdoc-react-chip.mine { background: #e8eeff; border-color: #1652f0; color: #1652f0; }
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
  .tdoc-react-add:hover { color: #1652f0; opacity: 1; }
  .tdoc-emoji-picker { position: absolute; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 6px; display: grid; grid-template-columns: repeat(6, 32px); gap: 2px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); z-index: 1000001; }
  .tdoc-emoji-picker button { background: transparent; border: none; padding: 0; cursor: pointer; border-radius: 4px; width: 32px; height: 32px; font-size: 18px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
  .tdoc-emoji-picker button:hover { background: #f5f6f8; }
  .tdoc-emoji-picker button.tdoc-emoji-text { grid-column: span 6; height: auto; padding: 6px 8px; font-size: 12px; font-weight: 600; color: #1652f0; }
  .tdoc-emoji-picker button.tdoc-emoji-text:hover { background: #e8eeff; }

  /* Replies + reply form */
  .tdoc-replies-toggle { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #eee; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font-size: 12px; color: #1652f0; user-select: none; }
  .tdoc-replies-toggle:hover { text-decoration: underline; }
  .tdoc-replies-toggle .chev { transition: transform .15s; }
  .tdoc-replies-toggle.open .chev { transform: rotate(90deg); }
  .tdoc-replies { display: none; flex-direction: column; gap: 10px; margin-top: 10px; }
  .tdoc-replies.open { display: flex; }
  .tdoc-reply { padding-left: 12px; border-left: 2px solid #e5e5e5; }
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
  .tdoc-reply-form textarea:focus { border-color: #1652f0; }
  .tdoc-reply-form-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
  .tdoc-reply-form-foot .hint { color: #888; font-size: 11px; }
  .tdoc-reply-form-foot .tdoc-reply-submit { background: #1652f0; color: #fff; border: none; border-radius: 6px; padding: 5px 12px; font: 12px system-ui; cursor: pointer; }
  .tdoc-reply-form-foot .tdoc-reply-submit:hover { background: #1245d0; }

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
  .tdoc-element-outline { position: absolute; pointer-events: none; border: 1.5px solid rgba(22,82,240,0.35); border-radius: 4px; box-sizing: border-box; z-index: 999995; transition: border-color .15s, box-shadow .15s, border-width .15s; }
  .tdoc-element-outline.pending { border-color: #f0d000; border-width: 2px; background: transparent; }
  .tdoc-element-outline.active { border-color: #1652f0; border-width: 2px; box-shadow: 0 0 0 4px rgba(22,82,240,0.18); }
  .tdoc-hover-outline { position: absolute; pointer-events: none; z-index: 999995; border: 2px dashed #1652f0; border-radius: 4px; background: rgba(22,82,240,0.06); box-sizing: border-box; transition: opacity .12s; }
  /* Clickable pill that appears NEXT TO commentable artifacts (img/canvas/svg/video/pre).
     Positioned just outside the artifact's right edge so it can't obscure
     content. Uses !important on the visible colors to defend against doc-side
     button:hover rules that would otherwise repaint our background. */
  .tdoc-comment-pill {
    position: absolute !important; z-index: 999998 !important;
    background: #1652f0 !important; color: #fff !important;
    font: 600 11px system-ui !important;
    padding: 4px 10px !important;
    border: none !important; border-radius: 999px !important;
    cursor: pointer !important;
    box-shadow: 0 2px 8px rgba(22,82,240,0.38) !important;
    display: inline-flex !important; align-items: center !important; gap: 4px !important;
    transition: transform .12s, background-color .12s, box-shadow .12s, opacity .12s !important;
    line-height: 1 !important;
    text-decoration: none !important;
    opacity: 0.92 !important; visibility: visible !important;
  }
  .tdoc-comment-pill:hover {
    background: #1245d0 !important; color: #fff !important;
    opacity: 1 !important;
    transform: translateY(-1px) !important;
    box-shadow: 0 4px 12px rgba(22,82,240,0.50) !important;
  }
  .tdoc-comment-pill:active { background: #0f3bb0 !important; transform: translateY(0) !important; }
  .tdoc-comment-pill svg { width: 12px !important; height: 12px !important; flex-shrink: 0 !important; stroke: #fff !important; }
  .tdoc-drag-marquee { position: absolute; pointer-events: none; z-index: 999997; border: 1.5px solid #1652f0; background: rgba(22,82,240,0.1); box-sizing: border-box; }

  /* Popup (new-comment) */
  .tdoc-popup { position: absolute; background: #0a0a0a; color: #fff; border-radius: 10px; padding: 14px; width: 320px; box-shadow: 0 12px 40px rgba(0,0,0,0.4); z-index: 999998; font: 13px system-ui, sans-serif; }
  .tdoc-popup .head { display: flex; justify-content: space-between; margin-bottom: 8px; }
  .tdoc-popup .head .h { color: #aaa; }
  .tdoc-popup .head .x { cursor: pointer; color: #888; }
  .tdoc-popup textarea { width: 100%; min-height: 64px; background: transparent; color: #fff; border: 1px solid #1652f0; border-radius: 6px; padding: 8px; font: inherit; resize: vertical; box-sizing: border-box; outline: none; }
  .tdoc-popup .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
  .tdoc-popup .hint { color: #888; font-size: 11px; }
  .tdoc-popup .submit { background: #1652f0; border: none; color: #fff; padding: 6px 14px; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 500; }
  .tdoc-popup .submit:hover { background: #1245d0; }
  .tdoc-popup .signin-needed { color: #f5a623; font-size: 12px; padding: 8px 0; }

  /* Modal (sign-in) */
  .tdoc-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 1000000; display: flex; align-items: center; justify-content: center; font: 14px system-ui, sans-serif; }
  .tdoc-modal { background: #fff; color: #111; border-radius: 12px; padding: 28px; width: 460px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
  .tdoc-modal h3 { margin: 0 0 8px; font-size: 20px; }
  .tdoc-modal p { margin: 0 0 14px; color: #444; line-height: 1.5; }
  .tdoc-modal .code { background: #0a0a0a; color: #fff; padding: 18px; border-radius: 8px; font: 24px ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.15em; text-align: center; margin: 0 0 14px; user-select: all; cursor: copy; }
  .tdoc-modal .step { display: flex; gap: 10px; margin-bottom: 8px; color: #444; }
  .tdoc-modal .step .n { width: 22px; height: 22px; border-radius: 50%; background: #1652f0; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; flex-shrink: 0; }
  .tdoc-modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .tdoc-modal button { padding: 8px 16px; border-radius: 6px; font: inherit; cursor: pointer; border: 1px solid #ccc; background: #fff; }
  .tdoc-modal button.primary { background: #1652f0; border-color: #1652f0; color: #fff; }
  .tdoc-modal button.primary:hover { background: #1245d0; }
  .tdoc-modal .status { color: #888; font-size: 13px; }
  /* Modal helper classes used by Publish/Share so dark-mode can override. */
  .tdoc-modal .muted { color: #666; font-size: 13px; }
  .tdoc-modal .divider { border-top: 1px solid #eee; padding-top: 12px; margin-top: 12px; }
  .tdoc-modal .danger { color: #c33; font-size: 13px; }
  .tdoc-modal code { background: #f5f6f8; padding: 1px 5px; border-radius: 3px; }

  /* Bar collapse breakpoints — tied to viewport width, not layout class.
     The bar progressively hides elements as the viewport tightens, so it
     stays elegant at every size.
       ≥1100px: workspace · slug · v · | title | identity · share · ⋯
       <1100px: workspace ·          v · | title | identity · share · ⋯  (slug hides)
       < 900px: workspace ·          v · | title | avatar   · share · ⋯  (name hides)
       < 700px: workspace             · | title |            share · ⋯  (version+identity into ⋯) */
  @media (max-width: 1100px) {
    .tdoc-bar .crumb-slug, .tdoc-bar .crumb-sep-slug { display: none; }
  }
  @media (max-width: 900px) {
    .tdoc-chip .name { display: none; }
    .tdoc-chip { padding: 3px; }
    .tdoc-bar #tdoc-fork-btn, .tdoc-bar #tdoc-saveas-btn { display: none; }
    .tdoc-bar .tdoc-secondary-toggle { display: inline-flex; }
  }
  @media (max-width: 700px) {
    .tdoc-bar { padding: 0 8px; gap: 4px; }
    .tdoc-version-wrap { display: none; }
    .tdoc-bar .doc-title { font-size: 13px; }
    .tdoc-bar #tdoc-copy-md-btn span { display: none; }
    .tdoc-bar #tdoc-publish-btn span, .tdoc-bar #tdoc-share-btn span { display: inline; }
  }

  /* Narrow mode (drawer + FAB) — still driven by the layout evaluator so
     it can also kick in when the comment column would crowd the article. */
  body.tdoc-narrow #tdoc-comment-layer { position: fixed; top: auto; left: 0; right: 0; bottom: 0; max-height: 70vh; width: 100%; pointer-events: auto; background: #fff; border-top: 1px solid #e5e5e5; box-shadow: 0 -4px 24px rgba(0,0,0,0.08); transform: translateY(100%); transition: transform .2s; overflow-y: auto; padding: 12px 12px 24px; box-sizing: border-box; z-index: 999998; }
  body.tdoc-narrow #tdoc-comment-layer.open { transform: translateY(0); }
  body.tdoc-narrow #tdoc-comment-layer .tdoc-drawer-handle { display: block; width: 36px; height: 4px; background: #ccc; border-radius: 2px; margin: 0 auto 12px; cursor: grab; touch-action: none; user-select: none; }
  body.tdoc-narrow #tdoc-comment-layer .tdoc-drawer-handle:active { cursor: grabbing; }
  body.tdoc-narrow .tdoc-margin-comment { position: static !important; width: auto !important; left: auto !important; top: auto !important; margin-bottom: 10px; transform: none !important; }
  body.tdoc-narrow .tdoc-fab { position: fixed; bottom: 16px; right: 16px; z-index: 999997; background: #1652f0; color: #fff; border: none; border-radius: 999px; padding: 10px 16px; font: 13px system-ui; font-weight: 600; box-shadow: 0 4px 16px rgba(22,82,240,0.35); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  body.tdoc-narrow .tdoc-fab:active { transform: scale(0.96); }
  body.tdoc-narrow .tdoc-popup { width: calc(100vw - 24px); max-width: 320px; left: 12px !important; }
  body.tdoc-narrow .tdoc-modal { width: calc(100vw - 32px); padding: 20px; }
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

  /* Footer */
  .tdoc-footer { margin-top: 80px; padding: 20px 16px 28px; font: 12px system-ui, sans-serif; color: #888; text-align: center; border-top: 1px solid #eee; box-sizing: border-box; max-width: 100%; }
  .tdoc-footer .tdoc-footer-row { display: inline-flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center; row-gap: 4px; }
  .tdoc-footer a { color: #666; text-decoration: none; }
  .tdoc-footer a:hover { color: #1652f0; text-decoration: underline; }
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

  // ========== Top bar (HackMD-style three-group layout) ==========
  const bar = document.createElement('div');
  bar.className = 'tdoc-bar';

  const versions = Array.isArray(cfg.versions) && cfg.versions.length ? cfg.versions : [{ n: version }];
  versions.sort((a, b) => (a.n || 0) - (b.n || 0));
  const slugCrumbLabel = isFork ? `fork of ${cfg.originalSlug || slug}` : slug;

  // Left group: workspace mark + slug crumb + version picker.
  const leftHtml = `
    <button class="tdoc-bar-mark" id="tdoc-bar-mark" title="tdoc on GitHub" aria-label="tdoc on GitHub">tdoc</button>
    <span class="crumb crumb-slug" title="${escapeHtml(slugCrumbLabel)}">${escapeHtml(slugCrumbLabel)}</span>
    <span class="crumb-sep crumb-sep-slug" aria-hidden="true">/</span>
    <div class="tdoc-version-wrap">
      <button class="tdoc-version-toggle" id="tdoc-version-toggle" type="button" aria-haspopup="listbox" aria-expanded="false">v${version}${versions.length > 1 ? ' ▾' : ''}</button>
      ${versions.length > 1 ? `
        <div class="tdoc-version-menu" id="tdoc-version-menu" role="listbox">
          ${versions.map(v => `<button role="option" data-version="${v.n}" class="${v.n === version ? 'current' : ''}">v${v.n}${v.n === version ? ' · current' : ''}</button>`).join('')}
        </div>
      ` : ''}
    </div>`;

  // Center: doc title (pulled from <title>). Hidden on very narrow.
  const centerHtml = `<span class="doc-title" id="tdoc-title">tdoc</span>`;

  // Right: copy menu + primary CTA (Share or Publish) + ⋯ overflow + identity.
  const copyMenuHtml = `
    <div class="tdoc-menu-wrap">
      <button id="tdoc-copy-md-btn" title="Copy as Markdown" aria-label="Copy as Markdown">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        <span>Copy</span>
      </button>
      <div class="tdoc-menu" id="tdoc-copy-md-menu">
        <button data-mode="doc">Doc only</button>
        <button data-mode="doc-comments">Doc + comments</button>
      </div>
    </div>`;

  const primaryCtaHtml = isFork ? '' : (isPublished
    ? `<button id="tdoc-share-btn" class="primary" title="Share link" aria-label="Share">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
         <span>Share</span>
       </button>`
    : `<button id="tdoc-publish-btn" class="primary" title="Publish to your Worker" aria-label="Publish">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>
         <span>Publish</span>
       </button>`);

  // Fork / Save-as live in the ⋯ menu on narrow viewports.
  const forkBtnHtml = isPublished
    ? '<button id="tdoc-fork-btn">Fork</button>'
    : (isFork ? '<button id="tdoc-saveas-btn">Save As New Local Doc</button>' : '');

  const rightHtml = `
    ${copyMenuHtml}
    ${forkBtnHtml}
    ${primaryCtaHtml}
    <div class="tdoc-menu-wrap">
      <button class="tdoc-secondary-toggle" id="tdoc-more-btn" aria-label="More" title="More">⋯</button>
      <div class="tdoc-secondary-menu" id="tdoc-secondary-menu">
        ${isPublished ? '<button data-action="share">Share</button><button data-action="fork">Fork</button>' : ''}
        ${isLocal ? '<button data-action="publish">Publish</button>' : ''}
        ${isFork ? '<button data-action="saveas">Save copy</button>' : ''}
        <button data-action="repo">tdoc on GitHub</button>
      </div>
    </div>
    <span id="tdoc-identity-slot"></span>`;

  bar.innerHTML = `
    <div class="tdoc-bar-left">${leftHtml}</div>
    <div class="tdoc-bar-center">${centerHtml}</div>
    <div class="tdoc-bar-right">${rightHtml}</div>
  `;
  document.body.appendChild(bar);

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
      document.body.appendChild(strip);
      document.body.classList.add('tdoc-has-oldver-strip');
    }
  }

  // Re-anchor banner — shown while a re-anchor action is in flight. Three
  // explicit actions to avoid the gesture conflict (clicking empty space
  // would otherwise be ambiguous with "deselect").
  const reanchorBanner = document.createElement('div');
  reanchorBanner.className = 'tdoc-reanchor-banner';
  reanchorBanner.innerHTML = `
    <span class="label">Select text to move anchor</span>
    <button type="button" id="tdoc-reanchor-remove">Remove anchor</button>
    <button type="button" id="tdoc-reanchor-cancel" class="danger">Cancel</button>
  `;
  document.body.appendChild(reanchorBanner);

  const titleEl = document.querySelector('title');
  if (titleEl && titleEl.textContent) document.getElementById('tdoc-title').textContent = titleEl.textContent;

  // Workspace mark in the bar's left → the open-source project. There is
  // no public catalog; the owner reaches their doc list via the profile
  // chip menu instead.
  document.getElementById('tdoc-bar-mark').onclick = () =>
    window.open('https://github.com/serenakeyitan/tdoc', '_blank', 'noopener');

  // Fork: opens the renderable /fork view in a new tab AND triggers a download
  // (one click, both happen). We use a hidden iframe to fire the download so
  // the user keeps focus on the new fork tab.
  async function forkAndDownload() {
    // Fetch the fork HTML once, then both download AND open it via a blob URL.
    // This way the new tab shows exactly the SAME bytes the user has on disk —
    // a real local copy, not the worker-hosted /fork page. Self-contained:
    // closing the tab doesn't lose the file, and the tab has no worker
    // dependency (uses blob: not https:).
    const base = `/d/${encodeURIComponent(slug)}/v/${version}`;
    let bodyText;
    try {
      const resp = await fetch(`${base}/fork`);
      if (!resp.ok) throw new Error(`fork fetch failed: ${resp.status}`);
      bodyText = await resp.text();
    } catch (e) {
      // Fallback: old behavior (let the worker route handle download)
      window.location.href = `${base}/export?download=1`;
      return;
    }
    const blob = new Blob([bodyText], { type: 'text/html;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);

    // 1. Trigger the file download via <a download>.
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `${slug}-v${version}-fork.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    // 2. Open the same blob in a new tab so the user sees their fork rendered.
    //    Small delay so the download starts before the new tab steals focus.
    setTimeout(() => {
      window.open(blobUrl, '_blank');
      // Revoke after a generous interval — the new tab may still be parsing.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }, 250);
  }
  if (isPublished) {
    const fb = document.getElementById('tdoc-fork-btn');
    if (fb) fb.onclick = forkAndDownload;
    const sb = document.getElementById('tdoc-share-btn');
    if (sb) sb.onclick = (e) => { e.stopPropagation(); showShareModal(); };
  }
  if (isLocal) {
    const pb = document.getElementById('tdoc-publish-btn');
    if (pb) pb.onclick = (e) => { e.stopPropagation(); showPublishModal(); };
  }
  function triggerForkDownload(slug, version) {
    const a = document.createElement('a');
    a.href = `/d/${encodeURIComponent(slug)}/v/${version}/export?download=1`;
    a.download = `${slug}-v${version}-fork.html`;
    document.body.appendChild(a); a.click(); a.remove();
  }
  if (isFork) {
    // Save As: same download as Fork, but from within fork mode (no /fork open
    // since we ARE the fork tab already).
    const sa = document.getElementById('tdoc-saveas-btn');
    if (sa) sa.onclick = () => triggerForkDownload(slug, version);
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

  const copyBtn = document.getElementById('tdoc-copy-md-btn');
  const copyMenu = document.getElementById('tdoc-copy-md-menu');
  copyBtn.onclick = (e) => { e.stopPropagation(); copyMenu.classList.toggle('open'); };
  copyMenu.querySelectorAll('button').forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      copyMenu.classList.remove('open');
      await window.__tdocCopyDocMd(b.dataset.mode === 'doc-comments');
    };
  });

  const moreBtn = document.getElementById('tdoc-more-btn');
  const secMenu = document.getElementById('tdoc-secondary-menu');
  moreBtn.onclick = (e) => { e.stopPropagation(); secMenu.classList.toggle('open'); };
  secMenu.querySelectorAll('button').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      secMenu.classList.remove('open');
      if (b.dataset.action === 'repo') window.open('https://github.com/serenakeyitan/tdoc', '_blank', 'noopener');
      if (b.dataset.action === 'fork') forkAndDownload();
      if (b.dataset.action === 'share') showShareModal();
      if (b.dataset.action === 'publish') showPublishModal();
      if (b.dataset.action === 'saveas') triggerForkDownload(slug, version);
    };
  });

  function renderIdentity() {
    const slot = document.getElementById('tdoc-identity-slot');
    if (!isPublished) { slot.innerHTML = ''; return; }
    if (identity) {
      // Profile chip → dropdown. "My docs" is owner-only (the configured
      // TDOC_OWNER); everyone signed in still gets Sign out.
      slot.innerHTML =
        `<div class="tdoc-menu-wrap">
          <button class="tdoc-chip" id="tdoc-me" aria-haspopup="menu" aria-expanded="false">
            <img src="${escapeHtml(identity.avatar_url || '')}" alt=""><span class="name">${escapeHtml(identity.login)}</span>
          </button>
          <div class="tdoc-menu" id="tdoc-me-menu" role="menu">
            ${isOwner ? `<button id="tdoc-my-docs" role="menuitem">My docs</button>` : ''}
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
      if (isOwner) {
        document.getElementById('tdoc-my-docs').onclick = () => {
          window.open('/me', '_blank', 'noopener');
        };
      }
      document.getElementById('tdoc-signout').onclick = async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        identity = null;
        isOwner = false;
        renderIdentity();
        refreshComments();
      };
    } else {
      slot.innerHTML = `<button class="tdoc-chip signin" id="tdoc-signin">Sign in with GitHub</button>`;
      document.getElementById('tdoc-signin').onclick = startDeviceFlow;
    }
  }
  renderIdentity();

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
      '<a href="https://github.com/serenakeyitan/tdoc" target="_blank" rel="noopener">github.com/serenakeyitan/tdoc</a>' +
      '<span class="sep">·</span>' +
      '<span>built with <a href="https://github.com/serenakeyitan/tdoc" target="_blank" rel="noopener">tdoc</a></span>' +
      '<span class="sep">·</span>' +
      '<span>inspired by <a href="https://x.com/jessepollak/status/2054313757543964857" target="_blank" rel="noopener">bdocs by @jessepollak</a></span>' +
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
  const REACT_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/><line x1="19" y1="6" x2="19" y2="10"/><line x1="21" y1="8" x2="17" y2="8"/></svg>`;

  function renderAuthor(author) {
    if (!author) return `<div class="author"><span class="anon">anonymous</span></div>`;
    if (author.kind === 'agent') {
      // Agent identity (currently always 'tdoc-agent'). No avatar URL — use
      // a generic icon-circle to differentiate from human commenters.
      return `<div class="author tdoc-agent-author"><span class="tdoc-agent-badge">⚡</span><span class="login">${escapeHtml(author.login || 'tdoc-agent')}</span></div>`;
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
      const hasAgent = users.includes('tdoc-agent');
      const cls = [`tdoc-react-chip`, mine ? 'mine' : '', hasAgent ? 'agent' : ''].filter(Boolean).join(' ');
      return `<span class="${cls}" data-emoji="${escapeHtml(emoji)}" data-target-id="${escapeHtml(target.id)}" data-users="${users.map(escapeHtml).join('\n')}">${escapeHtml(emoji)} ${users.length}</span>`;
    }).join('');
    return `<div class="tdoc-reactions" data-target-id="${escapeHtml(target.id)}">${chips}<button class="tdoc-react-add" data-target-id="${escapeHtml(target.id)}" title="Add reaction" aria-label="Add reaction">${REACT_ICON_SVG}</button></div>`;
  }
  function renderReactInline(target) {
    return `<button class="tdoc-react-add inline" data-target-id="${escapeHtml(target.id)}" title="Add reaction" aria-label="Add reaction">${REACT_ICON_SVG}</button>`;
  }
  function renderReply(reply) {
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
    return `<div class="tdoc-reply${isAgent ? ' tdoc-agent-reply' : ''}" data-comment-id="${escapeHtml(reply.id)}">
      ${renderAuthor(reply.author)}
      ${statusChip}
      <div class="text">${escapeHtml(reply.text)}</div>
      ${hasReactions ? renderReactionsRow(reply) : ''}
      <div class="meta">
        <span>${new Date(reply.created).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        <span class="actions">
          ${!hasReactions && !isFork ? renderReactInline(reply) : ''}
          ${canDelete ? `<span class="del" data-id="${escapeHtml(reply.id)}">delete</span>` : ''}
        </span>
      </div>
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
    const resolvedChip = isResolved
      ? `<span class="tdoc-resolved-chip" title="Resolved by tdoc-agent${comment.applied_in ? ' in v' + escapeHtml(String(comment.applied_in)) : ''}">✓ ${
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
        const autoOpen = false;
        return `
        <div class="tdoc-replies-toggle${autoOpen ? ' open' : ''}" data-id="${escapeHtml(comment.id)}">
          <svg class="chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}
        </div>
        <div class="tdoc-replies${autoOpen ? ' open' : ''}">${replies.map(r => renderReply(r)).join('')}</div>
      `; })() : ''}
      ${isFork ? '' : `<div class="tdoc-reply-form" data-parent-id="${escapeHtml(comment.id)}">
        <textarea placeholder="Reply…"></textarea>
        <div class="tdoc-reply-form-foot">
          <span class="hint">⌘+Enter to submit · Esc to cancel</span>
          <button class="tdoc-reply-submit">Reply</button>
        </div>
      </div>`}
    `;

    const repliesToggle = card.querySelector('.tdoc-replies-toggle');
    const repliesEl = card.querySelector('.tdoc-replies');
    if (repliesToggle && repliesEl) {
      repliesToggle.onclick = (e) => {
        e.stopPropagation();
        const open = repliesEl.classList.toggle('open');
        repliesToggle.classList.toggle('open', open);
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

    const replyToggle = card.querySelector('.tdoc-reply-toggle');
    const replyForm = card.querySelector('.tdoc-reply-form');
    if (replyToggle && replyForm) {
      replyToggle.onclick = (e) => {
        e.stopPropagation();
        if (isPublished && !identity) { startDeviceFlow(); return; }
        replyForm.classList.toggle('open');
        if (replyForm.classList.contains('open')) {
          replyForm.querySelector('textarea').focus();
          requestAnimationFrame(repositionCards);
        }
      };
      const replyTa = replyForm.querySelector('textarea');
      const submitReply = async () => {
        const text = replyTa.value.trim();
        if (!text) return;
        let r;
        try {
          r = await fetch('/api/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug, parent_id: comment.id, text, version })
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
        await refreshComments();
      };
      replyForm.querySelector('.tdoc-reply-submit').onclick = (e) => { e.stopPropagation(); submitReply(); };
      replyTa.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitReply(); }
        if (e.key === 'Escape') { replyForm.classList.remove('open'); requestAnimationFrame(repositionCards); }
      });
    }

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
      QUICK_EMOJIS.map(e => `<button data-emoji="${e}">${e}</button>`).join('') +
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
      const r = target.getBoundingClientRect();
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
    // Keep any currently-open floating card glued to its pin on scroll/resize.
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
    const url = author?.avatar_url;
    // onerror: if the avatar 404s / is CORS-blocked, swap the broken <img> for
    // the anon placeholder so the pin/row never shows a broken-image glyph.
    return url
      ? `<img src="${escapeHtml(url)}" alt="" onerror="this.outerHTML='&lt;span class=&quot;${anonClass}&quot;&gt;&lt;/span&gt;'">`
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
    if (card) card.classList.remove('tdoc-floating-open');
  }
  function positionFloatingCard(id) {
    const card = state.cardEls.get(id);
    if (!card) return;
    const geo = gutterGeometry();
    const row = commentY(state.activeComments.find(c => c.id === id), geo);
    let y = row ? row.y : geo.articleTop;
    card.style.left = geo.cardLeft + 'px';
    // Flip up if the card would run past the bottom of the viewport.
    card.style.top = y + 'px';
    requestAnimationFrame(() => {
      const h = card.offsetHeight;
      const vpBottom = window.scrollY + window.innerHeight - 12;
      // Top floor must clear the fixed bar (and the old-version strip when shown)
      // so a flipped-up card isn't occluded by them.
      const topFloor = window.scrollY + (document.body.classList.contains('tdoc-has-oldver-strip') ? 84 : 56);
      if (y + h > vpBottom) card.style.top = Math.max(topFloor, vpBottom - h) + 'px';
    });
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
    if (!clusterPop.contains(e.target) && !e.target.closest?.('.tdoc-pin-cluster')) closeClusterPopover();
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
    if (card) { const id = [...state.cardEls.entries()].find(([, el]) => el === card)?.[0]; if (id) hoverClose(id); }
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
  }

  function scrollAnchorIntoView(id) {
    const mark = state.anchorMarks.get(id);
    if (!mark) return;
    let anchorRect = null;
    // Prefer the underlying TARGET ELEMENT (canvas/img/video etc) over the
    // overlay outline div — same rect, but more semantically correct.
    if (mark.ranges?.[0]) anchorRect = mark.ranges[0].getBoundingClientRect();
    else if (mark.targetEl?.getBoundingClientRect) anchorRect = mark.targetEl.getBoundingClientRect();
    else if (mark.el?.getBoundingClientRect) anchorRect = mark.el.getBoundingClientRect();
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
  async function refreshComments() {
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
      // Restore the pinned floating card if its comment survived the refresh
      // and we're in wide (pins) mode. Runs after repositionCards so the pin
      // elements exist to mark active.
      if (keepPinnedId && !state.narrow && state.cardEls.has(keepPinnedId)) {
        // Use setActiveComment (not the manual pin/show/mark trio) so the
        // card's .active class, anchor highlight, activeId, AND the pin state
        // are all re-established together. The manual version desynced activeId
        // and lost the card's .active state (+ the "move anchor" affordance).
        setActiveComment(keepPinnedId);
      }
    });
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
  let pollTimer = null;
  let pollInterval = 5;
  async function startDeviceFlow() {
    if (!isPublished) return;
    let data;
    try {
      const r = await fetch('/api/auth/device/start', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch (e) {
      // Network failure or a non-JSON edge error (e.g. an HTML 502) must not
      // leave an unhandled promise rejection with no feedback.
      alert('Sign-in error: could not reach the sign-in service. Please try again.');
      return;
    }
    if (!data || data.error || !data.user_code || !data.verification_uri) {
      alert('Sign-in error: ' + ((data && (data.message || data.error)) || 'unexpected response'));
      return;
    }
    showDeviceModal(data);
    // Only open the verification URL if it's an https GitHub URL — never window.open an
    // arbitrary string from the response.
    if (isGithubHttpsUrl(data.verification_uri)) window.open(data.verification_uri, '_blank');
    pollInterval = Math.max(5, data.interval || 5);
    schedulePoll(data.device_code);
  }
  function isGithubHttpsUrl(u) {
    try {
      const url = new URL(String(u));
      return url.protocol === 'https:' && /(^|\.)github\.com$/.test(url.hostname);
    } catch { return false; }
  }
  function schedulePoll(device_code) {
    pollTimer = setTimeout(() => pollDevice(device_code), pollInterval * 1000);
  }
  function showDeviceModal(data) {
    const bg = document.createElement('div');
    bg.className = 'tdoc-modal-bg';
    bg.id = 'tdoc-device-modal';
    bg.innerHTML = `
      <div class="tdoc-modal">
        <h3>Sign in with GitHub</h3>
        <div class="step"><span class="n">1</span><span>Copy this code:</span></div>
        <div class="code" id="tdoc-user-code">${escapeHtml(data.user_code)}</div>
        <div class="step"><span class="n">2</span><span>Paste it at <b>${escapeHtml(data.verification_uri)}</b> (opened in a new tab) and approve.</span></div>
        <div class="step"><span class="n">3</span><span class="status" id="tdoc-poll-status">Waiting for you to approve…</span></div>
        <div class="actions"><button id="tdoc-modal-cancel">Cancel</button></div>
      </div>`;
    document.body.appendChild(bg);
    document.getElementById('tdoc-user-code').onclick = () => navigator.clipboard?.writeText(data.user_code);
    document.getElementById('tdoc-modal-cancel').onclick = closeDeviceModal;
  }
  function closeDeviceModal() {
    const m = document.getElementById('tdoc-device-modal');
    if (m) m.remove();
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
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
  function showShareModal() {
    closeAuxModal();
    const url = `${location.origin}/d/${encodeURIComponent(slug)}/v/${version}`;
    const bg = document.createElement('div');
    bg.className = 'tdoc-modal-bg';
    bg.id = 'tdoc-aux-modal';
    bg.innerHTML = `
      <div class="tdoc-modal">
        <h3>Share this doc</h3>
        <div class="code" id="tdoc-share-url" style="font-size:14px;letter-spacing:0;text-align:left;cursor:copy;">${escapeHtml(url)}</div>
        <div class="actions" style="justify-content:flex-start;gap:8px;margin-top:0;margin-bottom:10px;">
          <button class="primary" id="tdoc-share-copy">Copy link</button>
        </div>
        <p class="muted">Anyone with this link can read. To comment, they sign in with GitHub.</p>
        <div class="divider">
          <p class="danger" style="margin:0 0 6px;"><b>Unpublish</b></p>
          <p class="muted" style="margin:0 0 6px;font-size:12px;">Unpublish requires the upload token, which only lives on your laptop. Run this locally:</p>
          <div class="code" style="font-size:13px;letter-spacing:0;text-align:left;cursor:copy;" id="tdoc-share-unpub">/tdoc unpublish ${escapeHtml(slug)}</div>
        </div>
        <div class="actions"><button id="tdoc-share-close">Close</button></div>
      </div>`;
    document.body.appendChild(bg);
    document.getElementById('tdoc-share-close').onclick = closeAuxModal;
    document.getElementById('tdoc-share-copy').onclick = () => navigator.clipboard?.writeText(url);
    document.getElementById('tdoc-share-url').onclick = () => navigator.clipboard?.writeText(url);
    document.getElementById('tdoc-share-unpub').onclick = (e) => {
      navigator.clipboard?.writeText(e.currentTarget.textContent);
    };
  }
  async function pollDevice(device_code) {
    const status = document.getElementById('tdoc-poll-status');
    pollTimer = null;
    try {
      const r = await fetch('/api/auth/device/poll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code })
      });
      const data = await r.json();
      if (data.ok && data.identity) {
        identity = data.identity;
        closeDeviceModal();
        renderIdentity();
        refreshComments();
        return;
      }
      // slow_down: GitHub explicitly told us to back off. Bump interval by 5s
      // (per RFC 8628 §3.5) before scheduling the next poll, otherwise GitHub
      // will keep rejecting at the same cadence forever.
      if (data.error === 'slow_down') {
        // GitHub may suggest a new interval; otherwise add 5s.
        pollInterval = Math.max(pollInterval + 5, Number(data.interval) || 0);
        schedulePoll(device_code);
        return;
      }
      if (data.error === 'authorization_pending' || (data.pending && !data.error)) {
        schedulePoll(device_code);
        return;
      }
      if (data.error === 'expired_token' || data.error === 'access_denied') {
        if (status) status.textContent = 'Code expired or denied. Try again.';
        return;
      }
      // Any other error (no_user, github_unreachable, 500) — show it and stop.
      if (data.error || !r.ok) {
        if (status) status.textContent = 'Sign-in failed: ' + (data.message || data.error || `HTTP ${r.status}`) + '. Try again.';
        return;
      }
      // Fallback: unknown shape, keep polling at current interval.
      schedulePoll(device_code);
    } catch (e) {
      if (status) status.textContent = 'Network error: ' + e.message + ' — retrying…';
      schedulePoll(device_code);
    }
  }

  // ========== Popup (new-comment): text + element anchors ==========
  let popup = null;
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
    if (anchor._placeAbove && rect.top - 8 - popupH >= 8) {
      popup.style.top = (window.scrollY + rect.top - popupH - 8) + 'px';
    } else {
      popup.style.top = (window.scrollY + rect.bottom + 8) + 'px';
    }
    const left = Math.min(rect.left + window.scrollX, window.innerWidth - 340);
    popup.style.left = Math.max(8, left) + 'px';

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
    if (anchor.kind === 'text' && anchor._range) rect = anchor._range.getBoundingClientRect();
    else if (anchor.kind === 'element' && anchor._el) rect = anchor._el.getBoundingClientRect();
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
    maybeOpenSelectionPopup(e.target);
  }, true);

  // Mouse and touch both surface here. On iOS Safari long-press text-selection
  // does NOT fire mouseup, so we also listen for touchend. selectionchange
  // would seem cleaner but fires continuously during a drag — touchend gives
  // us a single "selection finished" signal.
  document.addEventListener('touchend', (e) => {
    const t = e.target || (e.changedTouches?.[0] && document.elementFromPoint(e.changedTouches[0].clientX, e.changedTouches[0].clientY));
    // Touchend fires before the OS finalizes selection — defer one tick.
    setTimeout(() => maybeOpenSelectionPopup(t), 0);
  }, true);

  function maybeOpenSelectionPopup(target) {
    // Selected text wins over "comment whole artifact." If there's a real text
    // selection, open the text-selection popup regardless of whether the
    // selection lives inside a commentable artifact. The hover pill remains
    // the path for "comment on the whole artifact" — they don't compete
    // because they're driven by different gestures (hover vs. drag-select).
    if (target && target.nodeType === 1 && isInUI(target)) return;
    const sel = window.getSelection();
    const text = sel && sel.toString().trim();
    if (!text || text.length < 2 || !sel.rangeCount) return;
    const anchorNode = sel.anchorNode;
    const anchorEl = anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement;
    if (anchorEl && isInUI(anchorEl)) return;
    const range = sel.getRangeAt(0).cloneRange();
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
    const rect = range.getBoundingClientRect();
    openPopup({ kind: 'text', text, context_before: ctx.before, context_after: ctx.after, _range: range }, rect);
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
    if (mark.ranges?.[0]) rect = mark.ranges[0].getBoundingClientRect();
    else if (mark.el) rect = mark.el.getBoundingClientRect();
    else if (mark.targetEl) rect = mark.targetEl.getBoundingClientRect();
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
    commentPill.setAttribute('aria-label', 'Comment on this');
    commentPill.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Comment`;
    // Top-right corner of the SECTION, so it visually belongs to the whole
    // artifact regardless of where inside it the cursor is.
    const pillW = 110;
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
    if (!t.closest('#tdoc-more-btn') && !t.closest('#tdoc-secondary-menu')) secMenu.classList.remove('open');
    if (!t.closest('.tdoc-menu-wrap')) copyMenu.classList.remove('open');
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
  function flashCopied(btn) {
    if (!btn || btn.dataset.flashing === '1') return;
    btn.dataset.flashing = '1';
    const orig = btn.innerHTML;
    const oc = btn.style.color, ob = btn.style.borderColor;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>Copied</span>`;
    btn.style.color = '#3ecf8e'; btn.style.borderColor = '#3ecf8e';
    setTimeout(() => {
      btn.innerHTML = orig; btn.style.color = oc; btn.style.borderColor = ob;
      btn.dataset.flashing = '0';
    }, 1200);
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
    if (ok) flashCopied(document.getElementById('tdoc-copy-md-btn'));
    else flashToast('Copy failed');
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

  // ========== Wire it up ==========
  refreshComments();
})();
