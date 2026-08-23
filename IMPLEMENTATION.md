# ARTIFACT-SHELL — INTEGRATED IMPLEMENTATION BLUEPRINT

Produced by a multi-agent design workflow (5 agents, code-grounded to real
line numbers). Branch `feat/artifact-shell-iframe`. Execute steps in order;
each is a single commit with its own verification. Boundary test
(`test/artifact-shell.test.js`) stays green at every step, flipping from
`?shell=1` to plain `/d/` only at Step 6.

## Milestones
- **Milestone 1 (this PR, mergeable): Steps 1–6** — server-side full shell at
  1:1 chrome parity; single-path cut on the local server. Keeps `?shell=1` as
  scaffolding until Step 6, then the doc route is shell-only.
- **Milestone 2: Step 7** — worker.js parity (published path) + bundle/CSP/
  widget reconciliation + existing-doc bake migration rollout.

## Two shared contracts (freeze before writing code)

### Contract 1 — `TDOC_CHROME` global (`server/chrome.js`, Step 1)
Inlined nonced `<script>`, parses before any consumer. Pure strings + pure
functions; no `document`/`fetch`/`window.__TDOC__` at load. Markup byte-identical
to today's overlay output. Handlers are NOT in the module — each consumer wires
its own.
```
TDOC_CHROME = {
  CSS,                         // chrome-only CSS (NO content-side selectors)
  escapeHtml(s), avatarHtml(...),
  buildBar({mode,slug,version,versions,originalSlug,isLanding,isCatalog}),
  buildIdentity({identity,isPublished,canSeeMyDocs,isCatalog,inboxUnreadN,inboxMenuLabel}),
  buildComposer({anchor,needsSignIn}),
  buildCard(comment,...), buildPin(...), buildClusterPop(...),
  buildFooter(), buildOldverStrip({version,latestVersion,latestUrl}), buildReanchorBanner(),
}
```

### Contract 2 — postMessage protocol (probe Step 4, shell Step 5)
Envelope: outbound `{source:'tdoc-frame'}`; inbound validated by
`e.source===window.parent`+`d.source==='tdoc-shell'` (probe) /
`e.source===frameWin()`+`d.source==='tdoc-frame'` (shell). Opaque origin ⇒
identity+shape validation only.

frame→shell: `tdoc:ready{height,metrics}`, `tdoc:selection{kind,text?,context_before,context_after,label?,aid?,fingerprint?,selector?,fallback,rect,placeAbove?}`, `tdoc:cleared`, `tdoc:layout{rows[],metrics,scrollY,height}`, `tdoc:metrics{metrics,height,scrollY}`, `tdoc:scroll{scrollY,height}`, `tdoc:anchorClick{id}`, `tdoc:docMarkdown{markdown,requestId}`.
shell→frame: `tdoc:anchors{comments[]}`, `tdoc:setActive{id,scroll}`, `tdoc:scrollTo{docY}`, `tdoc:composerClosed{}`, `tdoc:copyDoc{includeComments,requestId}`, `tdoc:theme{...}`.
`Row = {id,kind,anchored,docY,elKey?,elTop?,elHeight?}`; `Metrics = {articleTop,articleHeight,articleLeft,articleRight,articleWidth}` (page coords).

---

## Step 1 — Extract the shared chrome module (no visual change)
New `server/chrome.js` (Contract 1), extracted verbatim from overlay.js:
escapeHtml (`909-911`), bar assembly (`926-1006`), identity (`1492-1503`,`1531`),
composer (`3380-3387`), card (`buildCard` `2059+`), footer (`1648-1654`),
oldver strip (`1019`), reanchor banner (`1031-1035`), pin/cluster markup. Closure
vars → explicit params.
- overlay.js: move content-side CSS (`::highlight` `663-673`, `.tdoc-anchor-mark*`
  `674-681`, hover-outline/pill/marquee `682-709`) into the content zone; wrap
  chrome CSS `410-866` in `TDOC_CHROME_CSS_START/END`; replace `const css`
  (`242-868`) with `TDOC_CHROME.CSS + content/reader/catalog CSS`; replace
  bar/identity/composer/card/footer markup with `TDOC_CHROME.*` calls; keep ALL
  handlers (`1046-1260`,`1504-1532`) unchanged.
- server.js: `CHROME_PATH` beside `OVERLAY_PATH` (`15`); inline chrome.js nonced
  before overlay in `injectOverlay` (`432-472`,`445`).
- worker.js: `const CHROME_JS = ` placeholder (`16`); prepend in `injectOverlayCfg`
  (`1070-1080`,`1077`).
- bin/tdoc-bundle: read chrome.js; `__TDOC_CHROME_JS__` replace mirroring
  OVERLAY_JS (`51-58`) fail-closed; fold `chrome_sha` into build/bundleSha.
Verify: browser-bundles-parse (add chrome.js `24`), no-drift, ui.test (/me,/ still
overlay path — unchanged), boundary green. Manual: /me on :7900 identical.

## Step 2 — Shell consumes the module for static chrome (visible 1:1 bar early)
server.js `shellDocument` (`291`): compute real mode/identity/versions like
injectOverlay (not literal `mode:'shell'` `300`); inline chrome.js nonced before
shellScript (`330`); delete hand-rolled `<style>` (`304-324`) → `TDOC_CHROME.CSS`.
`shellScript` (`337`): bar/footer/identity via `TDOC_CHROME.build*`; wire
shell-safe handlers (theme, version nav, copy-menu toggle, share/publish/
duplicate/download, ⋯ menu, sign-in/out/inbox, drawer) copied from overlay
`1046-1260`,`1504-1532`,`1608-1643`. Mode table: local→Publish; published→Share+
Duplicate+Download+⋯; fork→Download+⋯; site→suppressed.
Verify: boundary adds bar-parity asserts (logo/version/Copy) still `?shell=1`.

## Step 3 — Model-B bake tooling + fixtures + SKILL (independent)
New `bin/tdoc-bake`: slice reader template `overlay.js:276-408`, inject after
`<head>` as `<style id="tdoc-reader-baked" data-tdoc-bake="v1">`, idempotent,
`--root/--dry-run/--force`, viewport ensure, non-zero exit on unparseable. Bake +
commit `test/fixtures/tdocs`. SKILL.md: supersede "trust injected template"
(`284-285`,`754-777`,`831`,`842`,`848-849`); add `<style>` reference block from
the marker slice. New `test/skill-template-sync.test.js` (byte-match). Bake
idempotency test.

## Step 4 — Probe: port the real content-DOM engine (Contract 2 frame side)
frame-probe.js: replace union `selectionRect` (`32-42`) with
`selectionEndRect`+`endRectOnLine`+`clientRectNearPoint`+`firstVisibleClientRect`
(overlay `3960/232/223/211`) — fixes "歪". Replace `context` (`43-49`) with
`getContext`/`collectTextNodes` (`3496-3511`); add `captureFallbackPosition`
(`3472`); pending highlight (`3338`). Resolve+highlight: port `findTextRange`
(+`rangeFromNormalizedOffsets`,`normalizeNeedle`), `matchByAid`/`findElement`,
`rebuildSharedHighlights` (`891`); emit `tdoc:layout{rows,metrics}` via
`commentY`(`2354`)+`getArticleMetrics`(`2299`)+`gutterGeometry`(`2331-2350`);
stamp elKey. Hit-test `findCommentAtPoint`(`2908`) → `tdoc:anchorClick`. Commands
in: setActive/composerClosed/theme/copyDoc(`htmlToMarkdown` `4174`). rAF-throttle
resize `tdoc:layout`.

## Step 5 — Shell wiring parity (Contract 2 shell side)
shellScript: `shell.state` mirror; measure BAR from `offsetHeight` (not 48);
port `layoutPins`(`2407` pure)/renderPins/positionFloatingCard/buildCard/
openClusterPopover/evaluateLayout/repositionCards/setActiveComment with edits
(document→shell doc; Y=`BAR+docY−frameScrollY` fixed; rects→rowById; setActive→
`tdoc:setActive`). Composer submit POSTs; close→composerClosed. Copy→copyDoc→
append comments→clipboard(execCommand fallback). Theme paints shell + posts
`tdoc:theme`. Re-anchor via next `tdoc:selection`. scroll→cheap replace;
layout→full evaluateLayout.
Verify: ui.test comment gestures (frame gesture + shell chrome), pins-layout green.

## Step 6 — Single-path cut (server) + flip tests
server.js: delete `?shell=1` gate (`778-783`) → doc route always `shellDocument`;
delete `injectOverlay` (`432-472`) + call (`785`); keep `/frame` (`735-766`).
`cspHeader` (`241-243`): add `frame-src 'self'`. Flip tests to plain `/d/`+`/frame`:
artifact-shell (`33`→plain), csp-headers (`frame-src`, author-inertness→/frame),
csp-xss (author inertness inside child frame; comment E2E drag-in-frame),
widget-island (`148` /frame), ui.test (content→`frame.evaluate`).

## Step 7 — Worker parity + bundle/CSP/widget (Milestone 2)
bin/tdoc-bundle: add FRAME_PROBE_JS read+placeholder (fail-closed); fold probe_sha.
worker.js: `FRAME_PROBE_JS` placeholder (`16`); `frameCspHeader` after
widgetCspHeader (`1035`); `/frame` route before doc route (`~3215`) mirroring
server `735-766` PLUS `enforceDocAccess` gate (private-doc leak); rewrite
`serveDocVersion` tail (`1206-1212`) → `shellDocument(...)` with published cfg;
carry SIGNIN_JS+ONBOARD_JS nonced; copy shellDocument/shellScript verbatim
(matches existing cspHeader duplication model); add `frame-src 'self'` to
`cspHeader` (`1022-1024`). Delete `injectOverlay` (`1103-1138`); rework 3 callers
(/me catalog inline-content shell variant; fork drop-overlay-boot [recommended]
or fork-only rename; keep readerCss for /export). **Widget CSP fix (highest
impact):** drop `frame-ancestors 'self'` from `widgetCspHeader` (`1033-1035`) —
widget is now grandchild of an opaque-origin frame so `'self'` never matches and
silently breaks ALL islands; rely on Sec-Fetch-Dest + `sandbox allow-scripts`.
Tests: csp-headers source-scan (`146-167`), browser-bundles-parse (add
frame-probe.js `24`), widget-island (`219-225`).

## Top risks (see workflow output for the full table)
Coordinate translation (measure real BAR; Y=BAR+docY−frameScrollY, shell body
never scrolls) · selection "歪" (port selectionEndRect) · sign-in across origin
(shellDocument computes real cfg; ship SIGNIN_JS nonced) · Copy-needs-doc-text
(probe owns htmlToMarkdown) · highlight color drift (one shared ::highlight
constant) · CSP frame-src (both files) · **widget frame-ancestors silent breakage**
(drop it) · dark mode (paint shell + post tdoc:theme) · /frame private-doc leak
(worker enforceDocAccess) · three-way template drift (skill-template-sync test) ·
bundle silent no-op (fail-closed guards + bundleSha).
