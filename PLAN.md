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

## CORRECTION (reuse the core UI/UX 1:1 — NOT the exact implementation)

What must be 1:1 is the **UI/UX**: the same top bar (sign-in/Copy/Share/version/
theme/avatar), footer, comment composer, comment cards, pins, and mobile drawer —
same look and same behavior on laptop and mobile. It does NOT have to be the same
*implementation*: the shell may reimplement the wiring async-side. So the goal is
NOT "run overlay.js across the boundary via a doc-port" (that was over-engineered);
it's "make the shell chrome look and behave identically by REUSING overlay.js's
CSS + markup structure, fed by the probe over postMessage."

P1–P3a's chrome was wrong not because it was a reimplementation but because it was
minimal/ugly and didn't match. Fix: pull the REAL chrome CSS + bar/footer/card/pin/
drawer markup from overlay.js into the shell so it's pixel-identical; wire it shell-
side with probe data (selection→composer, comments→pins, drawer). The overlay's
synchronous anchoring internals stay in the frame (probe); nothing "hard" about it.

FULL MIGRATION — single path, no dual-mode, no flag. This is a draft PR on a
feature branch, so main is untouched until merge; we do NOT need the flag or a
dual doc-port to keep main shippable mid-build. The branch is all-or-nothing:
reach 1:1 parity + migrate existing docs, then merge. No dual-mode tech debt.

Correct architecture:
- The doc route ALWAYS returns the shell; author content ALWAYS renders in the
  iframe; there is no `?shell=1` flag and no single-origin fallback.
- The shell renders the chrome by REUSING overlay.js's CSS + markup (bar,
  footer, comment cards, pins, drawer, composer) so it is pixel- and
  behavior-identical — but the shell wires it async-side from probe data. We do
  NOT run overlay.js verbatim in the shell.
- The frame probe owns the content-DOM work (selection capture, anchor resolve,
  geometry, CSS.highlights, hit-testing, scrollIntoView) and pushes results
  (selection events, per-comment pin coordinates, article geometry) to the
  shell over postMessage; the shell reads that local mirror synchronously and
  re-renders reactively (as overlay already does on refresh/resize).
- DELETE the old inline-overlay path (`injectOverlay`/`injectOverlayCfg` into
  the author HTML) in BOTH server.js and worker.js.
- Existing docs migrate to self-contained (model B bake) since there is no old
  path to fall back on.

Definition of 1:1 done: the (only) shell path shows the same top bar (incl.
sign-in), footer, composer, pins/cards, and mobile drawer — same look and
behavior on laptop and mobile — by reusing overlay.js's CSS + markup.

## Styling model: B — self-contained docs (Claude Artifacts model)

DECIDED: the reader-template CSS is **not injected at render time**. The author
document is fully self-contained (its own styling), rendered as-is in the frame —
exactly what Claude Artifacts does. Rationale: injecting our template into the
isolated frame would re-introduce a cascade collision (our CSS vs the author's)
*inside* the frame, defeating the point of isolation. So:

- `/frame` serves author HTML + the probe only. No template injection.
- The current reader template becomes a **reference template in the skill**
  (`SKILL.md`), so agents generate self-contained, well-styled HTML.
- Existing docs (which rely on runtime injection) get a **one-time migration**
  that bakes the template into their HTML, so they stay good-looking and become
  self-contained. Reuse the template source by slicing overlay.js between the
  `TDOC_READER_CSS_START/END` markers.

Trade-off accepted: no central restyle of existing docs after migration; each
doc is independent. This is the Claude model and the price of true isolation.

## Rollout: full migration on the branch (no flag)

No flag, no dual-mode. On this feature branch the doc route serves ONLY the
shell; the old inline-overlay path is deleted. main is unaffected until the PR
merges, and the PR merges only once the shell is at 1:1 parity and existing docs
are migrated. (The `?shell=1` flag from P1–P3a is being removed as part of this
correction.)

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
- **P3 — chrome parity + comments render:** port the REAL top bar (title,
  version picker, Copy/Share/Duplicate, sign-in, theme, avatar) and the footer
  into the shell; render submitted/existing comments as pins + highlights by
  round-tripping anchors to the probe (probe resolves anchor→range, applies
  CSS.highlights, reports pin Y; shell draws pins/cards in the outer gutter);
  narrow/drawer mode (toggle `tdoc-narrow` <700px — flips boundary test #3);
  scroll/resize coordinate sync. What the user flagged as "missing" (top bar
  login, footer, pins) lands here.
- **P4 — styling model B + bundle + CSP + tests:** add the reference template to
  `SKILL.md`; write the one-time existing-doc bake migration; `bin/tdoc-bundle`
  emits shell + probe; `cspHeader` gains `frame-src`, frame gains `frame-ancestors`;
  worker.js parity; update `csp-headers`, `widget-island`, `browser-bundles-parse`,
  `ui`, `csp-xss`.
- **P5 — unify:** flip shell to the default, DELETE the `?shell=1` flag and the
  old single-origin inline-overlay path. (Only after P3+P4 parity + doc migration
  so main stays shippable throughout.)

## Key files (from recon)

- Local serve/inject: `server/server.js` doc route `577-590`, `injectOverlay` `277-317`, `cspHeader` `240`, widget route `555-575`, `forceWidgetSandbox` `257-275`, `widgetCspHeader` `251`.
- Worker serve/inject: `worker/worker.js` `serveDocVersion` `1168-1213`, `injectOverlayCfg` `1070-1080`, `cspHeader` `1022`, widget `3190-3213`.
- Anchoring (must split across boundary): `server/overlay.js` — capture `maybeOpenSelectionPopup 3912`, `getContext 3496`, `collectTextNodes 1668`, `selectionEndRect 3960`; resolve `findTextRange 1764`, `findElement 1853`, `firstVisibleClientRect 211`, `refreshComments 2766`; render `rebuildSharedHighlights 891`, `getArticleMetrics 2299`, `gutterGeometry 2331`, `renderPins 2469`, `positionFloatingCard 2563`, `evaluateLayout 2924`, `findCommentAtPoint 2908`.
- Bundle: `bin/tdoc-bundle` (OVERLAY_JS placeholder `51-54`). Tests: `test/run.js`.
