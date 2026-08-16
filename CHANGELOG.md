# Changelog

All notable changes to tdoc are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow the `VERSION`
file and `.claude-plugin/plugin.json`.

## [Unreleased]

### Fixed

- **Tables and wide diagrams are no longer clipped in the reader.** Overlay
  table styles used a -14px left margin that cropped the first column inside
  any `overflow-x:auto` wrapper, and `display:block` on `<table>` broke row
  layout on narrow viewports. Tables now keep real table layout and scroll in
  a wrapper; document SVGs keep their viewBox aspect ratio with overflow
  visible.
- **Dark mode no longer recolors reaction emoji.** The page invert was
  turning ❤️ / 👍 into off-hue bitmaps. Color emoji in chips and the
  picker are wrapped and inverted back to native colors. Text reactions
  like LGTM still invert with the page so they stay readable.
- **Opening one notification no longer marks siblings in the same thread.**
  Mark-read matches the exact comment/reply id, not the thread root.
- **Clicking Reply no longer collapses the comment.** A hover-opened card
  used to vanish as soon as you hit Reply (the click never pinned it, then
  the pointer leaving the pin hid the card). Reply now pins the card and
  keeps the thread expanded.
- **Posting a reply no longer folds the thread.** After submit, refresh
  used to rebuild the card with replies collapsed. The thread you just
  replied in stays open.
- **Open comment cards no longer follow the viewport.** An expanded card
  used to clamp itself to the camera on scroll. It now stays next to its
  pin and scrolls away with the page.

### Added

- **In-app inbox (API).** Signed-in users have a per-host notification inbox.
  New top-level comments notify the doc owner; replies notify only the
  direct parent (Reddit); reactions notify the item author. Same-thread
  events collapse to one unread row. `#118`.
- **Notification badge and panel.** The profile chip shows a red unread
  dot; Notifications in the existing profile menu opens the existing modal
  with the last 20 rows (cluster rows, unread highlighted; one-line
  action plus relative time). The
  page polls every 8s so a new comment/reply/reaction
  updates the dot and the doc without a manual refresh. Clicking a row
  (or the comment in the doc) marks it read and opens that comment. `#118`.
- **Dark mode switch in the top bar.** One icon in the menu bar flips light/dark via a page invert (so author colors, artifacts, and replies flip together). After you switch, the choice is stored in `localStorage` on that host and restored on later visits. Default stays light until you switch. `#120`.
- **Nested replies.** You can reply to a reply (and to that reply), the way
  Reddit and Hacker News do. Each node in the thread has its own Reply.
- **Host-runtime logos on agent replies.** Claude / Codex / Grok / Cursor /
  Gemini replies show that product's mark. Claude uses the Claude star, not
  the Anthropic company logo. Anything else (`tdoc-agent`, unknown names)
  uses `tdoc_logo.png` (the tdoc dinosaur), not a lightning bolt. Detection reads the host environment
  (`CLAUDE_SESSION_ID`, `CODEX_HOME`, `GROK_SESSION_ID`, …) so agents do not
  have to remember to pass `agent_login`. `bin/tdoc-agent-reply` stamps
  identity before the request leaves the machine (the published Worker cannot
  see your env).

## [0.9.0] - 2026-07-13

### Added — Vercel as a second publish target

`/tdoc publish --platform vercel <slug>` deploys the same worker to a Vercel
Function instead of a Cloudflare Worker. The bundled worker runs unmodified;
only the storage bindings are swapped (`vercel/lib/`): docs go to Vercel Blob,
metadata + comments go to Upstash Redis (Vercel Marketplace). `tdoc-pull` and
`tdoc-unpublish` resolve the API base from the configured platform. The
platform is chosen once, on the first publish, and persisted in
`~/.tdoc/published.json`; existing Cloudflare users are unaffected (default
unchanged). Known differences on Vercel — no per-doc comment-write
serialization (the worker's documented KV fallback is used instead of a
Durable Object) and a ~4.5 MB per-doc upload cap — are documented in
`vercel/README.md`. Shims are covered by a new offline suite
(`test/vercel-shim.test.js`). Contributed by @julies-claw (#76).

### Fixed

- **Vercel sessions now expire.** The Upstash KV shim dropped the worker's
  `expirationTtl`, so on Vercel login sessions (`session:*`) never expired —
  unbounded key growth and no server-side session expiry. The shim now forwards
  the TTL as `SET … EX`, matching Cloudflare KV (#77).

## [0.8.1] - 2026-07-07

Fable code audit of the v0.8.0 pins release (fresh engine, every finding
adversarially verified; 16 confirmed).

### Fixed

- **Comments/replies could be lost silently.** Posting a comment or reply that
  the server rejected (any non-401 error, or a network failure) cleared your
  text as if it had succeeded. It now surfaces the error and keeps your text.
- **Reactions leaked across versions (local server).** Viewing an older version
  of a doc showed the agent's resolved emoji (✅/🟡/❓) even where the comment
  was still open, and replies appeared on versions before they were written.
  The per-version fold now scopes both correctly, matching the hosted worker.
- **Anchor-click could fire many times.** Clicking a comment's anchored image /
  chart could trigger its card repeatedly (a listener stacked up on every
  refresh). Fixed — one handler, one action.
- **Pinned card lost its selected state after a refresh** (its highlight and
  "move anchor" affordance disappeared). Restored.

### Internal

- The v0.8.0 pin layout (clustering, spreading, overflow-fold) now has unit
  tests guarding its correctness against future regressions.
- Small performance and dead-code cleanups in the overlay and worker.

## [0.8.0] - 2026-06-30

Comment margin redesign: **pins instead of a card stack**, so the right gutter
can no longer overflow ("拍不下") no matter how many comments a doc has. Built
behind a full scenario audit (88 scenarios, every gap adversarially verified)
and confirmed in a real browser.

### Added — pins in the margin (wide mode)

- The right gutter now shows **one avatar pin per comment** (green ✓ ring when
  resolved) instead of a column of full cards. The full card **floats open on
  hover** and stays open (**pinned**) on click; click-outside, a second click,
  or **Esc** closes it. Floating cards cap at 70vh with internal scroll so even
  a long thread can't overflow.
- **Same-line comments merge into a count badge** that opens a list popover;
  pick a row (mouse or keyboard) to open that comment. Clustering only fires for
  genuinely co-located comments — otherwise pins **spread apart** and show
  individually as long as there's vertical room; a dense page folds the
  overflowing tail into one badge so the column still can't overflow.
- Narrow/mobile is unchanged: comments still flow in the bottom drawer.

### Fixed

- **Resolved comments no longer leave an in-text anchor.** An addressed comment
  kept its gold highlight + dashed marker sitting at the old spot; resolved
  comments now drop the in-text anchor while keeping their margin card and
  "✓ fixed · vN" chip. Replies are collapsed by default.
- **A reply/react/re-anchor no longer makes the open card vanish.** Those
  actions refresh the comment list, which used to tear down the pinned card
  mid-action; the refresh now preserves and restores the open card.
- **Pin avatars are no longer treated as commentable artifacts** — hovering a
  pin used to pop the "comment on this image" pill over tdoc's own UI. The pin
  layer + cluster popover are now excluded from artifact detection.
- Cluster popover is clamped to the viewport (flips/lifts at the edges) and is
  keyboard-navigable; broken avatar images fall back to a placeholder; a
  flipped-up card clears the old-version strip.

## [0.7.11] - 2026-06-29

Dual-engine code audit (Codex + Claude subagents, every finding adversarially
verified). Both engines independently flagged the same top cluster.

### Fixed — data loss

- **Reactions silently disappeared on a normal toggle.** A reaction's event id
  included the add-vs-remove kind, so `add → remove → add` folded to a stale
  "removed" — the reaction vanished even though the user's last action was to
  add it. The id also omitted the version, so the same reaction on different
  document versions clobbered each other (snapshots are supposed to be
  immutable). Both are fixed by one version-scoped id shared by add and remove;
  reactions stored before this release are migrated automatically.

### Fixed — security

- **Comment anchor could hijack rendering** (verified in a real browser). A
  stored anchor id was interpolated into a CSS selector, so a crafted id from a
  signed-in commenter could anchor a comment onto `<body>` or throw an error
  that aborted comment rendering for every viewer. Anchors now match by
  attribute equality — no selector string is ever built from stored data.
- **CLI slug path traversal.** `tdoc publish` / `pull` / `unpublish` used the
  slug in filesystem paths and API URLs without validation; a `..` slug escaped
  the tdoc directory. They now enforce the same kebab-case rule as `tdoc new`.
- **Hardening:** upload/comment/reaction endpoints validate the slug (and
  version) before it becomes a storage key; reactions reject reserved object
  keys as emoji; the upload-token check is constant-time; the sign-in modal
  escapes its values and only opens https github.com URLs; `published.json`
  (which holds the upload token) is created `0600` from the start.

### Fixed — robustness

- Comment refresh no longer breaks when the API returns an error body instead
  of a list; reaction clicks now re-auth on an expired session and surface
  failures instead of silently dropping; the sign-in flow handles network/edge
  errors; text highlights re-anchor correctly on browsers without the CSS
  Custom Highlight API. `tdoc update --check` reports the real commit count.

## [0.7.10] - 2026-06-28

Four user-facing fixes that landed on `main` after 0.7.9 — most relevant to
**plugin-marketplace** installs, which are pinned to the manifest version and
were stuck on the buggy 0.7.9 until this bump.

### Fixed

- **Plugin manifest `repository` rejected at startup** (#42) — `plugin.json`
  used the npm `{type, url}` object form; Claude Code's schema requires a
  string URL, so it threw a validation error on every launch. Flattened to the
  string form.
- **`/plugin marketplace add` failed schema validation** (#36) — `marketplace.json`
  was missing the required top-level `owner` object. Added it; also dropped a
  stale per-plugin version pin that silently froze marketplace users on an old
  version.
- **`publish` aborted on modern macOS wrangler** (#37) — the CLI hardcoded the
  legacy `~/.wrangler` token path; wrangler 4.x stores it under
  `~/Library/Preferences/.wrangler` (xdg-app-paths). Now resolves the token in
  wrangler's own precedence (legacy-if-exists first, else xdg), honors
  `CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN`, and `doctor` reports
  `publish_token_ok` so it no longer says "logged in" while the token read
  silently fails.
- **Dead Cloudflare onboarding link (404)** (#38) — the `…/workers/onboarding`
  URL Cloudflare retired now points to `?to=/:account/workers-and-pages` at all
  three places it was emitted (doctor, publish, ONBOARDING.md).

### Engineering / CI (no behavior change)

- Manifest schema test pins `plugin.json` + `marketplace.json` to the Claude
  Code schema, plus a version-drift guard requiring `VERSION`, `plugin.json`,
  and any marketplace version to agree — this is the class of bug (#36, #42)
  that shipped to users four times.
- CI supply-chain hardening: GitHub Actions pinned to commit SHAs,
  `permissions: contents: read`, and ShellCheck on the credential-handling CLIs.
- Added `SECURITY.md`, `CODEOWNERS`, issue/PR templates, a CodeQL workflow
  (JS), and Dependabot for GitHub Actions.

## [0.7.9] - 2026-06-26

### Fixed

- **Lingering selection highlight when commenting on text** — selecting one
  line and commenting left that line (and everything below, worst across table
  cells) visually highlighted until you clicked elsewhere. Root cause was the
  browser's native selection, not the comment anchor: `closePopup()` cleared
  the pending tdoc highlight but never called `getSelection().removeAllRanges()`.
  Now cleared on submit / cancel / Esc / click-away.

[0.7.10]: https://github.com/tornado-doc/tdoc/releases/tag/v0.7.10
[0.7.9]: https://github.com/tornado-doc/tdoc/releases/tag/v0.7.9
