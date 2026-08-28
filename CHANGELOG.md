# Changelog

All notable changes to tdoc are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow the `VERSION`
file and `.claude-plugin/plugin.json`.

## [Unreleased]

### Changed

- **Relicensed to AGPL v3, with a commercial licence available.** Apache 2.0
  let anyone embed tdoc in a closed product and keep their changes; AGPL's
  section 13 makes running a modified tdoc as a network service count as
  distribution, so those users are entitled to the modified source. That is
  the protection the project wanted. It is also the wrong shape for some
  products, so `COMMERCIAL.md` says how to ask for terms that do not require
  publishing changes — the point is that there is a door, not a wall. Each of
  MIT and Apache 2.0 grants the right to sublicense, which is what makes the
  change possible; both notices stay at the foot of `LICENSE` as those
  licences require. Vendored third-party code is not ours to relicense and is
  excluded by name: `authoring/vendor/no-ai-slop.md` stays MIT under Peter
  Yang's notice.

- **The mark is a tornado, and it carries no background.** The dog is
  replaced by a line-art vortex, traced to vector at `assets/tdoc_logo.svg`
  and kept byte-identical in `worker.js`. The old SVG sat on an opaque white
  rect, which stayed invisible in both themes because the page-level
  `filter: invert(1)` flips the rect and the page background together — but
  only while the mark sits on the page's own background. On a tinted surface,
  a favicon, or somebody else's README the white box showed. Line art in
  `currentColor` needs no field: it follows the text in light mode and inverts
  to white with it in dark. `assets/tdoc_logo_black.png` and
  `tdoc_logo_white.png` are transparent 2500px rasters for use off-page.
  `tdoc_logo.png` keeps a solid field because it is the Open Graph card, and a
  transparent card renders on whatever colour the reader's client picks.
- **Relicensed from MIT to Apache License 2.0.** Agreed by both maintainers.
  MIT grants the right to sublicense, which is what makes the change possible;
  the notice covering every contribution made before 2026-08-27 is retained at
  the foot of `LICENSE` as that licence requires. Third-party code vendored
  under its own terms is untouched — `authoring/vendor/no-ai-slop.md` stays
  MIT under Peter Yang's notice.

### Added

- **Onboarding offers the `CLAUDE.md` routing line, once.** The skill
  description already routes doc requests to tdoc and reaches every session,
  but a line in the user's own instructions reads as a rule rather than a
  catalogue entry. Onboarding now offers to add one, names the file it would
  edit, and takes no for an answer permanently
  (`~/.tdoc/.routing-declined`). It asks at most once ever
  (`~/.tdoc/.routing-prompted`) and a marker comment keeps a reinstall from
  appending a second copy. Installing a tool never edits the config of the
  thing that installed it without being asked. `#263`.
- **Five house styles, a visual-first floor, and a new default.** The default
  is now the stark-sans / OpenAI-index aesthetic (white, black, Inter, an
  oversized tight-tracked headline) with a full technical-diagram vocabulary —
  sharp black container frames, monospace pill labels, solid pastel accents with
  dot- and hatch-textured variants, and stacked-bar composition. Named styles a
  doc can select: `technical` (a theme-following engineering-blog register), `editorial` (a warm
  serif long-read), and `paper` (a warm serif Anthropic-blog aesthetic). Brand
  aesthetics are approximated with open fonts — no proprietary fonts, no logo or
  byline, a look not an identity. `authoring/visuals.md` joins `voice.md` as a
  required-reading floor: be visual-first, use many visuals of varied types, and
  don't default to a flowchart. Every style states it works for ANY diagram type
  and never limits which visuals a doc contains. `#194`.
- **Two more house styles a doc can name.** `authoring/style/technical.md`
  (cold engineering-blog register — mono, neutral greys, one sparing
  red-orange accent; from judgmentlabs.ai) and `authoring/style/editorial.md`
  (long-read essay — warm paper, serif body, electric-blue accent, colored
  inline underlines; from cognition.com). Selected by naming them in a
  `/tdoc new` prompt; `default.md` still applies when nothing is named.
  `editorial.md` is the one style that overrides typography, and only the
  ground color and body font. `#194`.
- **Every generated doc goes through a voice contract.** New `authoring/`
  directory, read at generation time. `authoring/voice.md` applies to
  `/tdoc new` and every `/tdoc edit` regeneration — a floor, not a
  user-selectable template, because nobody picks "make it sound like AI."
  It adapts the vendored `no-ai-slop` rule set (Peter Yang, MIT) to
  generation rather than editing, names the user's prompt as the voice
  anchor, and fences off the spans prose rules must never rewrite: code,
  identifiers, quoted material, and data. `authoring/style/` and
  `authoring/structure/` ship as empty reserved mount points. `#194`.
- **PR preview Worker (`tdoc-preview`).** Pull requests on tornado-doc/tdoc
  get a unique `pr-<N>` preview URL and a sticky comment pointing at
  `/d/conway-life/v/2` on that host — published chrome, not Local Studio,
  not tdoc.dev, not a personal Worker. Own R2 + KV, no Durable Object
  (Cloudflare will not mint preview URLs for a DO Worker). `#148`.
- **Hosted tdoc.dev is multi-tenant.** GitHub sign-in mints a recoverable
  account-scoped upload token (`POST /api/hosted/token`). `/me` lists that
  user's slugs (`meta.hosted.github_login`), not the Worker operator's dump.
  Per-account doc quota (default 50) and upload-size cap (default 2 MB).
  tdoc.dev enables signup by hostname; BYOK Workers stay single-owner unless
  `TDOC_HOSTED_REGISTRATION` is set. `#131` `#154`.
- **Duplicate vs Download on published docs.** The published bar no longer
  uses **Fork** (which only downloaded a file). **Duplicate** makes a
  content-only account copy for the signed-in GitHub user on tdoc.dev
  (self-host: worker owner only). **Download** is one control with **Download
  HTML** (`slug-vN.html`, reader CSS inlined) and **Download PDF**
  (browser print of that reading column — Save as PDF, real text). No comments,
  history, or widget islands in v1.

- **Sandboxed interactive widgets.** Author JS still does not run in the host
  document. Computation lives in `/d/:slug/v/:n/widget/:name`, loaded only as
  `Sec-Fetch-Dest: iframe`, with `sandbox="allow-scripts"` on the iframe and
  `Content-Security-Policy: sandbox allow-scripts` on the widget response
  (unique origin even if the host iframe rewrite misses). Overlay comments
  on the iframe as one artifact.

### Changed

- **The first doc is the reader's own portrait.** `FIRST-DOC.md` no longer
  builds a Conway's Game of Life lesson. It builds *What does AI know about
  you?* — a page assembled from the traces every AI assistant on the machine
  has already left, with the reader's name in the title. Every section opens
  with a trait and proves it with a chart, the page is visuals rather than
  prose, and it ends by handing over tdoc itself. The scan is announced before
  it runs, reads timestamps and paths only, never quotes a transcript, and the
  finished page is shown before it is published rather than after. It degrades
  for a reader who writes no code, and for a machine with no history at all.
  Onboarding Step 5 now reads that file instead of scaffolding a placeholder.
  `#161`.
- **The template validator checks the whole style contract.** It compared the
  body background and stopped, so a document could pass `--style default` while
  contradicting the style's own CSS, clipping a legend outside its `viewBox`,
  or using none of the diagram vocabulary. It now diffs every declaration the
  style file makes against the document (contradictions only, so an abbreviated
  font stack is still fine), measures every figure's contents against its
  `viewBox`, and fails a page of charts that uses no accent at all.
- **tdoc logo in the top bar goes to My docs (`/me`).** On tdoc.dev that is
  https://tdoc.dev/me. It used to go to `/` (the marketing homepage).
  Local studio 302s `/me` to `/` because there is no hosted catalog.
  `#191`.
- **Project mark is SVG.** Overlay bar, unmatched agent avatars, and
  `/tdoc_logo.svg` serve a vector Tornado Dog (`currentColor`, no embedded
  bitmap). `/tdoc_logo.png` stays for Open Graph. `#161`.
- **Overlay top bar sits in document flow** instead of `position: fixed`.
  Page HTML no longer scrolls underneath a floating strip; the bar (and the
  old-version strip) occupy the top of the layout.
- **Site chrome on `/` and `/me` is no longer a document toolbar.** The
  bar title is gone (those pages already have an h1). `/` keeps the
  tdoc logo, a GitHub icon, appearance, and sign-in. The mark is the same
  logo as the favicon, not a text pill.
- **Doc title sits in the left cluster**, after the logo and version, not
  in a fake-centered middle slot. Left and right chrome are different
  widths, so a flex "center" never looked viewport-centered. Google Docs
  and Notion keep the title on the left.

- **Default `/tdoc publish` target is hosted tdoc.dev** (Cloudflare/Vercel via
  `--platform`). First hosted publish runs GitHub Device Flow, then mints a
  token bound to that login. Closed signup on a host that left registration
  unset still fails clearly and points at self-host flags.
- **`--platform` after first setup switches for real.** A conflicting flag
  rewrites `~/.tdoc/published.json` via full re-setup (previous config kept as
  `published.json.bak.switch` and restored if setup fails). Cloudflare setup
  now persists `platform:"cloudflare"`. Same Worker custom domain vs
  `*.workers.dev` remains two hostnames, not a platform switch.

### Fixed

- **The first doc's slug is per-person, so onboarding stops colliding.** Hosted
  slugs are one flat global namespace and the recipe derived the slug from the
  document title, which handed every user the same one. The second person to
  run onboarding was rejected — `slug_taken` (409) or `not_doc_owner` (403) —
  on the first publish they ever attempted. The slug now carries the reader's
  name, falls back to their GitHub login, and a collision is retried with a
  suffix rather than surfaced as a failure. `#244`.
- **The skill actually keeps itself current now.** `#248` added an automatic
  fast-forward to `origin/main` on every tdoc invocation, guarded on a
  `TDOC_DIR` that a placeholder token was supposed to fill in at install time.
  Nothing ever filled it in — the install script it named does not exist — so
  every install carried the literal token, the guard `[ -x "$TDOC_DIR/bin/tdoc-update" ]`
  was false, and the update silently never ran on any machine. The skill
  directory is now resolved at runtime the same way the setup check resolves
  it, `~/.agents/skills/tdoc` is included in the candidates, and the two
  meanings of `TDOC_DIR` in one file are no longer the same variable.
- **The first doc goes to tdoc.dev, privately, instead of ending at
  localhost.** The recipe told the agent to build the page, open it locally and
  ask before publishing — which recreated exactly the failure the localhost
  rule exists to prevent, one commit after that rule landed. A first doc that
  lives only on the machine has not shown anyone what tdoc is. It now publishes
  with `--visibility private`, so the reader gets a real link on their own
  account that nobody else can open, and opening it up is a decision they make
  while looking at the page rather than before it exists. `#161`.
- **Publishing from the modal works when node is version-managed.** The local
  server passed its own `PATH` straight to the CLIs it spawns. A server started
  by absolute path — launchd, an editor, `nohup` from a shell that only loads
  nvm interactively — has the bare system `PATH`, so `tdoc-publish` could not
  find a node installed by nvm, fnm, asdf or volta and reported `node 18+ is
  not installed` on a machine running Node 22. The server now puts its own
  interpreter's directory in front of the child's `PATH`, and the CLI names the
  `PATH` it searched when the check does fail, so the message stops pointing at
  the wrong problem. `#259`.
- **The project mark keeps a white field in both themes, and its hover
  highlight is centred.** The SVG that replaced the raster was fully
  transparent, so the dinosaur read as a see-through outline. The mark is now
  ink on an opaque white field, the same look as the landing hero. Because it
  carries its own field it is restored like a photograph in dark mode instead
  of inverting with the page — inverting turned the field black, which is the
  bar's own colour, so the drawing still read as see-through. Separately, the
  bar mark's 24px logo sat flush left in its 32px button, so the hover
  highlight landed 8px off to the right of the drawing; the button now centres
  its content. The worker's inlined copy of the asset was re-synced. `#161`.
- **`tdoc-agent-reply` fails loudly.** A rejected reply used to exit 0, so a
  comment that was never answered looked answered. `curl -sS` exits 0 on HTTP
  4xx/5xx, and the server also reports rejections as a 200 body with an
  `error` key, so a `post_reply` helper now gates on both and both transports
  propagate its failure. Accepted replies still exit 0 and still print the
  server body. `#141`.
- **Notification clicks open the target doc and comment.** Inbox rows
  go to `/d/<slug>/v/<n>?comment=<id>` (including from `/me` and `/`).
  Same-doc clicks no longer pin the card and then immediately unpin it
  because the click bubbled as an outside click. `?comment=` expands the
  thread before the card is built, pins it, and on a phone opens the
  comment drawer. Same-doc clicks also add `.open` on the live replies
  list, so a collapsed thread actually shows the target reply. `#180`.
- **Download PDF uses the browser print engine.** The JPEG-page wrap was
  ~100 DPI and looked mushy. PDF now prints `/export` (reader CSS, no bar)
  so Save as PDF keeps vector text.
- **tdoc.dev homepage publish no longer dies on a present-but-unwritten token.**
  `#129` merged and deployed the Worker, then `publish-landing.yml` got
  `401 unauthorized` because `TDOC_DEV_UPLOAD_TOKEN` existed in GitHub
  Actions and had never been `wrangler secret put` onto the Worker.
  Re-running that workflow with `sync_upload_token` writes the secret
  once. Automatic publishes still do not rotate it.
- **Homepage verify no longer fails a live landing page.** `set -o pipefail`
  plus `echo "$body" | grep -q` SIGPIPEs on the 300kB homepage, so a
  successful ship looked like the fallback. The check now uses bash
  `[[ ]]`.
- **`DELETE /api/doc` fails closed when hosted `release_owner` fails** and the
  Durable Object binding is present, so a 200 cannot leave the slug parked.
  Vercel (no `COMMENTS`) still returns 200 — there was never a reservation.
- **Tables and wide diagrams are no longer clipped in the reader.** Overlay
  table styles used a -14px left margin that cropped the first column inside
  any `overflow-x:auto` wrapper, and `display:block` on `<table>` broke row
  layout on narrow viewports. Tables now keep real table layout and scroll in
  a wrapper; document SVGs keep their viewBox aspect ratio with overflow
  visible.
- **Dark mode no longer erases document button labels.** `color-scheme: dark`
  plus page invert made unselected chips like "Differences only" paint
  light-on-light, so the text vanished. Form controls stay in the light
  scheme and invert with the rest of the page.
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

- **Search and batch delete on My docs (`/me`).** Filter the owner catalog by
  title or slug, multi-select rows, and delete the selection in one confirm.
  Still client-side over the KV title list (no extra R2/comment work at render);
  access policy stays on the doc Share panel. Feedback is a tiny inline
  top-right toast (`Deleted`) — no third-party toast library on the owner
  session surface.
- **BYOK update nag.** User-facing CLIs and the skill preamble compare this
  checkout to `origin/main` and point at `/tdoc update --yes` when main is
  ahead. Ahead-only feature branches stay silent; a true diverge does not
  print a destroy/re-clone command. `tdoc-doctor` reports the same state as
  `.update` (not a `missing_step`).
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
- **tdoc.dev's homepage is itself a tdoc.** `/` renders the `tornado-doc`
  landing doc (`landing/tornado-doc`) at its latest version instead of a
  hardcoded page, so the homepage is authored, reviewed, and versioned through
  tdoc — and publishing v2 changes what it says without changing the URL that
  inbound links and search engines point at. The page carries a full SEO head
  (title, description, canonical, Open Graph, Twitter card) and doubles as the
  artifact demo: its diagram and install block are commentable like any other
  tdoc. `/` falls back to the previous neutral page when the landing doc is
  unpublished or access-gated, so self-hosted workers are unaffected. `#127`.
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
