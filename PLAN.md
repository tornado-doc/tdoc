# Cross-origin iframe "shell" architecture

Goal: kill the whole class of "author CSS/DOM collides with overlay chrome"
bugs (the "歪" bug, the #96 padding bug, and every future one) by rendering the
author document in an **isolated iframe** with the overlay chrome living in an
**outer shell** document, bridged by **postMessage**. Same shape as Claude
Artifacts.

Decision doc: https://tdoc.dev/d/reader-layout-decision/v/4 (§8)

## Isolation mechanism

Use a **CSP `sandbox` iframe with an opaque origin** (extend the existing widget
island pattern — `forceWidgetSandbox` + `widgetCspHeader`, `server.js:257-275`,
`worker.js:1039-1057`). An opaque origin is a distinct, inaccessible origin, so
the shell cannot reach the doc DOM and vice-versa — communication is
postMessage-only. This is "cross-origin" for our purposes **without** needing a
`*.frame.*` subdomain or wildcard routing, works on localhost, and reuses code
we already ship. (A real subdomain is only needed if we later let authors run
persistent JS with storage, like Artifacts' `allow-same-origin` frames.)

## Rollout: behind a flag

Everything ships behind an opt-in (`?shell=1` initially, later a doc/config
default). The current single-origin inline-overlay path stays the default and
untouched until the shell reaches parity. This makes each PR independently
mergeable and non-disruptive.

## Test boundary (definition of done for the architecture)

`test/artifact-shell.test.js` (Playwright). Against a fixture doc that sets
**hostile CSS on `body`** (`max-width`, `margin`, `padding`, `background:#000`,
`display:flex`, `transform:scale`, `:root{--td-accent}`):

1. **Isolation** — the shell top bar spans the full viewport width and its
   colors/layout are unaffected by the author's body CSS.
2. **Comments across the boundary** — selecting text inside the iframe opens the
   composer in the shell; submitting places a pin at the correct Y; scroll/resize
   keeps the pin aligned; clicking the pin scrolls the content. Text anchors
   (text+context) and element anchors (aid) both work.
3. **Mobile** — narrow viewport: iframe fills width, comments in the drawer.
4. **No regression** — existing `.wrap` docs, the offline suite, and the key
   `ui.test.js` cases stay green (default path unchanged).

The test fails on `main` (no shell) and passes when the architecture lands.

## Phases

- **P0 — scaffold (this PR skeleton):** PLAN.md + failing acceptance test +
  draft PR. ✅ when the test exists and fails for the right reason.
- **P1 — shell + isolated doc iframe (no comments yet):** doc route, when
  `?shell=1`, returns a *shell* document (top bar + footer + empty comment
  layer) that embeds the author HTML in a sandboxed iframe served from a new
  `/d/<slug>/v/<n>/frame` route (gated on `Sec-Fetch-Dest: iframe`, CSP
  `sandbox`). Author HTML no longer gets the overlay inlined in shell mode.
  Boundary test #1 (isolation) passes.
- **P2 — postMessage bridge + probe:** split `overlay.js` into (a) a thin
  **probe** injected into the iframe doc (selection capture, anchor build/resolve,
  geometry, CSS.highlights) and (b) the **shell** chrome (composer, pins, cards,
  layout) that consumes geometry via messages. Define the message protocol
  (`tdoc:selection`, `tdoc:anchors`, `tdoc:geometry`, `tdoc:scroll`,
  `tdoc:highlight`, `tdoc:scrollTo`). Boundary test #2 (comments) passes.
- **P3 — mobile/drawer + coordinate translation + resize/scroll sync.** Test #3.
- **P4 — bundle split + CSP directives + update existing tests.** `bin/tdoc-bundle`
  emits shell + probe; `cspHeader` gains `frame-src`/doc gains `frame-ancestors`.
  `csp-headers`, `widget-island`, `browser-bundles-parse`, `ui`, `csp-xss` updated.
- **P5 — flip default (later PR, out of scope here).**

## Key files (from recon)

- Local serve/inject: `server/server.js` doc route `577-590`, `injectOverlay` `277-317`, `cspHeader` `240`, widget route `555-575`, `forceWidgetSandbox` `257-275`, `widgetCspHeader` `251`.
- Worker serve/inject: `worker/worker.js` `serveDocVersion` `1168-1213`, `injectOverlayCfg` `1070-1080`, `cspHeader` `1022`, widget `3190-3213`.
- Anchoring (must split across boundary): `server/overlay.js` — capture `maybeOpenSelectionPopup 3912`, `getContext 3496`, `collectTextNodes 1668`, `selectionEndRect 3960`; resolve `findTextRange 1764`, `findElement 1853`, `firstVisibleClientRect 211`, `refreshComments 2766`; render `rebuildSharedHighlights 891`, `getArticleMetrics 2299`, `gutterGeometry 2331`, `renderPins 2469`, `positionFloatingCard 2563`, `evaluateLayout 2924`, `findCommentAtPoint 2908`.
- Bundle: `bin/tdoc-bundle` (OVERLAY_JS placeholder `51-54`). Tests: `test/run.js`.
