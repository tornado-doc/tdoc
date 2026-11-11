#!/usr/bin/env node
// tdoc test aggregator. Runs every offline test file in sequence and reports a
// single pass/fail. This is what `npm test` and CI invoke, so "run the tests"
// is one command instead of N hand-run files (finding: no-test-runner-or-ci).
//
// Offline suite = no network, live provider or browser. Browser regressions run
// separately with --browser; --all also includes provider integration suites.
//
// Usage:
//   node test/run.js            # offline suite (default; CI uses this)
//   node test/run.js --browser  # required local layout regressions
//   node test/run.js --all      # also attempt network/browser suites

const { spawnSync } = require('child_process');
const path = require('path');

const OFFLINE = [
  'feedback-space-no-versions.test.js', // a space takes replies, not versions: tokens and MCP refused; creation, comments, replies, browser saves untouched
  'feedback-frame-anchor.test.js', // a comment inside a tdoc doc (anchor.frame): get_comments shows it on one line, no brackets, short, as author content, only for tdoc's own pages
  'frame-part.test.js', // what the doc frame says it picked is rebuilt: known keys, one line, finite numbers, under the anchor size cap
  'comment-one-behaviour.test.js', // comment surfaces share prefill, drafts, list height and the floating card by source rule; Fix with AI stays gone
  'selection-bundle.test.js',  // the shared selection modules bundle into the doc frame without a bundler; container keys, adapters, the pick gesture
  'comment-query.test.js',     // one comment query on every surface: Open by default, counts, deleted rule, waiting on you, search, sort, groupBy
  'thread-seen-api.test.js',   // server read state: authorized like reading the comments, no cross-doc reads, no thread-id leaks
  'feedback-team-agents.test.js', // the widget's @ lists team agents (answer only) only through tdoc's own-origin token door
  'version-diff.test.js', // bounded block matching and Unicode edits
  'sheets.test.js',            // sheets: view query (search/filter/sort/URL), CSV parsing + type inference, markup round trip
  'sheets-size.test.js',       // sheets: 8 MB sheet cap on every write path (not for prose or a token sheet), history row-count summary, sheet anchors never lost to the aid reconcile
  'version-history.test.js', // history rows: same writer within 30 min grouped, paged, what changed cached, access, Restore
  'excalidraw.test.js',       // optional diagram source, round-trip export and write permission
  'agent-md.test.js',          // AGENTS.md one-line SoT rule; no ARCHITECTURE.md
  'no-async-wait-for-function.test.js', // browser tests never waitForFunction(async ...): Playwright does not await the predicate's value
  'authoring.test.js',        // authoring/ contract: voice floor wired into both generation paths
  'block-lint.test.js',       // publish-time block check: loose text and non-house wrappers warned, never refused; linear on 8 MB sheets; house blocks baked
  'manifest.test.js',         // plugin.json / marketplace.json schema (#36, #42)
  'marketplaces.test.js',     // repo marketplaces (.claude-plugin, .agents/plugins) parse and point at real plugin folders
  'plugins.test.js',          // plugins/: Claude, Codex/ChatGPT, Cursor, Gemini, VS Code packages for the remote MCP server
  'remote-mcp.test.js',       // /mcp + OAuth 2.1: PKCE, redirect URIs, consent CSRF, token mapping, refresh/revoke, tools and refusals, rate limit
  'feedback.test.js',         // #564 product feedback: token door, space, bookmarklet + one-line entry
  'feedback-invites.test.js', // share from the widget: signed expiring invites, owner-only, email pending, revoke, Join / Keep my own, switcher, landing page
  'comment-history.test.js',  // event-log fold + cross-version pull
  'comment-dedupe.test.js',   // the same words twice within seconds is one comment
  'comment-notification-failure.test.js', // inbox KV trouble never turns a saved comment into HTTP 500
  'comment-post-critical-path.test.js', // POST /api/comments answers once the comment is saved; inbox, contacts, onboarding, index run after (waitUntil), still every time
  'posted-comment.test.js',   // the POST's answer merged into a surface's list (new thread, reply, duplicate), before the re-read
  'event-convergence.test.js',// eid dedup convergence + fold ordering
  'reconcile.test.js',        // anchor reconcile branches + compaction
  'agent-status-emoji.test.js',// agent verdict folds without synthetic reactions
  'security.test.js',         // injection / authz / CSRF / path-traversal
  'access.test.js',           // JUL-31 access policy (public/unlisted/private)
  'link-sharing.test.js',     // anyone with the link: noindex everywhere, unlisted by default, require sign-in, public->link migration
  'seo.test.js',              // sitemap + robots Sitemap line, /@handle SSR, description dedupe, JSON-LD: Public docs only, escaped
  'resolution-actor.test.js', // who resolved: human vs agent, kept as a fact
  'token-inventory.test.js',  // /me/tokens: list + revoke one terminal credential, browser-only
  'connectors.test.js',       // webhook connector, test send, disconnect, boundaries
  'ui-primitives.test.js',    // product UI uses shell/src/ui primitives; no native <select>
  'app-header.test.js',       // every app page renders the shared TopBar; no second account chip, no worker-drawn header
  'notifications-merge.test.js', // the bell reads every linked actor key (handle + email)
  'email-notifications.test.js', // #772 mention/reply/comment emails: cooldown, cap, opt-out, switch
  'push-sw.test.js',           // #771 the shipped service worker: show, click opens the comment, no fetch handler
  'web-push.test.js',          // #771 a comment pushes to subscribed browsers (RFC 8291/8292, decrypted)
  'access-request-actions.test.js', // access requests answered from the notification: approve / ignore
  'notify-handoff.test.js',   // outbound handoff: owner-gated, note by default, failure recorded not retried
  'remote-access-route.test.js', // remote access mutation auth + meta-only guard
  'doc-head-redirect.test.js', // bare /d/<slug> → 302 to latest, access-gated
  'ask-doc.test.js',           // Ask this doc: off without a key, browser readers only, read gate, 5 per account, no address to the model
  'reader-agent-ask.test.js',  // Send to my agent: a reader's own agents only, never anyone else's; the answer is the asker's alone
  'suggest-edits.test.js',     // Ask/Edit v2: tdoc AI suggests text edits; editors accept (publish) or reject; text only, no markup
  'suggest-handoff-lock.test.js', // Ask/Edit v2: a reply_as "suggestions" handoff refuses its agent's publish until it is dealt with or an hour passes; browser, other agents, non-dev and team docs untouched
  'ask-in-thread.test.js',     // Ask AI in a comment: tdoc AI or the commenter's own agent answers as a reply in the thread, seen by all
  'ask-only-lock.test.js',     // Ask only: the hand-off is answer only and the server holds it (Raft, webhook, local, owner's own agent included); tdoc AI never edits
  'hand-off.test.js',          // one door: Ask only decides edit (authorship) or answer (own / team agent / tdoc AI), never another's agent
  'doc-move-agents.test.js',   // a doc that changes workspace: nobody left behind is offered, the default, or sent to; history stays
  'handoff-privacy.test.js',   // handoff details: commenter, sender and owner only; a member hands off threads they began or replied in
  'agent-authorship.test.js',  // authorship at write time (upload, agent replies that mark applied) and answer-only locks from send to answer, per question, failing closed
  'comment-wipe-authorship.test.js', // the comment wipe and team move follow agent authorship; a successful wipe answers 200
  'comment-email-privacy.test.js', // email commenters: aliases for other readers, own/invited/team keep the address
  'display-name.test.js',       // Settings -> Name: validation, gates, rate limit; chosen name beats re-login and shows on existing comments, @ list, roster, inbox; agents keep theirs
  'mcp-discovery.test.js',     // MCP findable: llms.txt Connect, markdown connect line, raw Link rel=mcp (bytes unchanged), server card + AI catalog, remoteMcp default on
  'agent-native.test.js',      // doc pages point agents at /raw + skill; /llms.txt; Bearer /raw for team/invited docs
  'me-management.test.js',    // /me remote SoT management UI guard
  'me-docs-experience.test.js', // /me sorting + recents + stars + folders (fake bindings)
  'me-rows.test.js',            // My docs rows: doc/sheet/slides, sharing (own docs only), unread comments + agent replies without per-row reads, Recent/Starred dates, checklist on Docs below 3 docs
  'shell-scan-cap.test.js',     // big docs: the page scans only the head (Cloudflare 1102)
  'inline-media.test.js',       // base64 video/audio refused at publish: link it instead
  'catalog-index.test.js',      // My docs costs what the viewer owns, not the platform (1102)
  'doc-index.test.js',          // per-owner/team doc index, invite index, one-pass frame bake + per-version cache (1102)
  'scan-backfill-race.test.js', // index scans never write back a record they read: an owner's private/withdraw survives a racing scan
  'trash.test.js',              // Delete moves to Trash: gone on every path, restore, 30-day purge, folders, permissions
  'account-delete.test.js',     // Settings -> Delete account: blockers, browser-only, sessions/tokens end, fresh re-signup, 30-day purge, operator restore
  'trash-hardening.test.js',    // #815 review: resumable purge, restore quota, batched folder delete, bounded reads, write race, old CLIs, --forever
  'mention-directory.test.js',  // @ offers doc people, teammates, recent contacts first
  'publish-attribution.test.js', // author name + per-version publisher come from the credential
  'operator-fallback.test.js',  // TDOC_OWNER owns only ownerless docs, not email accounts' docs
  'version-catch-up.test.js',   // an orphaned version no longer wedges later publishes
  'site-space.test.js',         // SDK: a site's own comment space, origins + invited/public
  'feedback-space-mcp.test.js', // create_feedback_space: agent-made site space, team-admin rule, dedupe; site binding vs Share race
  'avatar-route.test.js',      // /avatar: widget faces from the tdoc origin; allowlist, no open proxy, 404 fallback, CORP; widget URLs
  'cli-mcp-parity.test.js',     // AGENTS.md: every MCP tool maps to an HTTP route and a CLI command (or a stated exception)

  'pull-acks-handoff.test.js',  // agent pulling comments marks the handoff received
  'local-agent.test.js',        // local CLI agents (tdoc-daemon): queued provider, pending index, KV write budget
  'team-agent.test.js',         // team agents: admin adds, members call, one team's reach, survives the adder, revoke
  'daemon-cli.test.js',         // bin/tdoc-daemon once-mode end to end against a stub worker + fake claude
  'handoff-state.test.js',      // handoff classifier: waiting → stale at 5 min, expired past Raft's expiresAt
  'teams.test.js',              // JUL-71 teams: roles, last admin, team-owned docs keep their author
  'folders-agent.test.js',      // agents file docs into folders (My docs + team) with the hosted Bearer
  'docs-hub-unified.test.js',   // My docs + team use one toolbar/list and cached previews
  'catalog-search.test.js',      // all-folder document search + field prefixes + nested paths
  'full-text-search.test.js',    // body + comment search: CJK, ranking, snippets as text, only docs the viewer's hub lists
  'folder-move-to-team.test.js', // a whole My docs folder into a team: batches, re-runs, stale reads
  'team-backup.test.js',         // customer-owned S3/R2 mirror: encryption, queue, retries, tombstones
  'backup-cli.test.js',          // open-format portability copy download + checksum verification
  'profile.test.js',            // /@handle public profiles
  'jul36-owner-manage.test.js', // JUL-36 owner manage UX: server-gated data, token-only mutations, no native confirm()
  'runtime-provenance.test.js', // release provenance + content-hash redeploy
  'hosted-oob.test.js',       // hosted token bootstrap + scoped writes
  'hosted-oob-behavior.test.js', // hosted token ownership behavior with fake bindings
  'account-email-groundwork.test.js', // phase-1 identity: email merge key, no mint-on-signin, field-preserving rewrite
  'pairing-flow.test.js',     // phase-2: tdoc-owned pair codes — strikes, single redemption, origin/session gates
  'provider-observability.test.js', // privacy-minimized hosted onboarding funnel in Worker logs (#397)
  'pair-signin-cli.test.js',  // phase-2 CLI: pairing-first, 404 fallback, probe-first resume
  'oidc-provider-seat.test.js', // phase-3: OIDC seat — verified-email sessions, email-born accounts, sub never a key
  'preview-oidc-login.test.js', // fixed Clerk callback returns a one-time session ticket to the originating PR alias
  'oidc-provider-registry.test.js', // provider registry: raft seat, agent-only stateless callback
  'email-identity-surface.test.js', // phase-4: actor keys — email identities comment, are invited, own their words
  'identity-recycling.test.js', // renamed handles and recycled addresses must not inherit an account
  'duplicate-download.test.js', // #146 Duplicate vs Download chrome + route contract
  'doc-download.test.js',      // Download as Markdown (/export.md, same gate as reading), Word (.docx from the doc HTML), CSV / Excel for sheets
  'deploy-tdoc-dev.test.js',  // tdoc.dev hosted CD: main-only, not BYOK
  'oldver-strip.test.js',     // old-version banner predicate
  'dark-mode.test.js',        // #120 top-bar dark mode switch + localStorage
  'mode-persistence.test.js', // mode preference persistence in localStorage
  'bar-overflow-trigger.test.js', // the ⋯ trigger is hidden where its menu would be empty
  'editor-save-hover.test.js', // #382 a button must never paint its background its own text colour
  'create-from-scratch.test.js', // #356 blank doc: slug derivation, both create routes, edit-on-arrival
  'draft-store.test.js',       // #369 per-doc draft cache + fingerprint restore
  'edit-markdown.test.js',     // #374 markdown input rules (no schema parser)
  'title-and-save-flow.test.js', // #367 hosted title plumbing, save's leave-site prompt, save notice
  'first-save-replaces-scaffold.test.js', // #380 the first save becomes v1 instead of appending v2
  'document-owner.test.js',   // #395 the bar and the lists name the document's owner
  'rename-from-the-bar.test.js', // #383 renaming is metadata; only blank docs follow their heading
  'resolve-a-thread.test.js',
  'onboarding-journey.test.js',
  'send-to-app.test.js', // homepage quick send: allowlisted app deep links, site pages only
  'feature-flags.test.js', // flag registry: dev-mode-only until default flips; unknown names off
  'dev-mode.test.js', // Dev mode switch (allow-list only, per account) + onboarding never returns on re-login
  'setup-gate.test.js', // the journey: two doors, three server-driven bridges, no daemon // #357 a person can resolve; resolved threads leave the margin
  'tornado-doc-landing.test.js',
  'landing-republish.test.js', // #458 the homepage is one v1, re-shipped in place with `replace`
  'browser-bundles-parse.test.js', // syntax-check what we inject into pages
  'tdoc-start.test.js',
  'tdoc-privacy.test.js', // public /privacy page is served from its landing doc
  'tdoc-pricing.test.js', // public /pricing page matches the limits the worker enforces
  'landing-real-doc.test.js', // the homepage hero: a screenshot of a real doc
  'signin-github-tab.test.js', // #179: GitHub opens in a new tab, never this one // #142 onboarding: /start page + the modal served with it
  'web-oauth.test.js',        // web redirect flow: sanitizeReturn open-redirect guard + flow wiring + device fallback
  'browser-free-cli.test.js', // clean skill install, write/edit/preview/publish without browser dependencies
  'cli.test.js',              // CLI resilience (drives bash hermetically)
  'no-drift.test.js',         // duplicated-helper drift guard
  'coverage.test.js',         // migration, bundle inlining, pull-merge, rich fold
  'overlay-pure.test.js',     // overlay pure helpers (escape/normalize/prefix)
  'reader-overflow.test.js',  // tables/diagrams must not clip in the reader
  'agent-runtime.test.js',    // host-runtime detect + agent logos
  'pins-layout.test.js',      // v0.8.0 pins clustering/spread/overflow-fold core
  'worker-shell.test.js',     // step7 worker shell parity: /frame route, CSP, bundled builders
  'upload-linear-time.test.js', // malformed 1.5 MB HTML must stay fast through the real upload route
  'bake-reader.test.js',      // tdoc-new bakes the reader template → self-contained docs (shell)
  'style-reader-column.test.js', // house styles carry reader.css's column values; baking them stays idempotent
  'dark-invert-parity.test.js', // the shell's dark invert and the frame's copy must not drift
  'write-invariants.test.js',  // every server write path bakes, stamps aids, records sha
  'comment-upload.test.js',   // local→worker comment merge (non-destructive)
  'comment-ops.test.js',      // #34 DO-serialized mutation ops
  'agent-reply-once.test.js', // #349 the agent answers once per human turn
  'kv-write-budget.test.js', // repeat actions spend no extra KV writes (daily quota)
  'team-billing.test.js', // #48 Team plan: Stripe checkout, portal, signed webhook, seat sync
  'team-scoped-token.test.js', // #65 a token narrowed to one team cannot read, list or write outside it
  'team-publish-personal-quota.test.js', // --team lands a new doc in the team, so a full My docs does not refuse it
  'workspace-scoped-token.test.js', // agent connections reach only the workspaces ticked for them; change and remove take effect at once
  'appsumo-licensing.test.js', // #61 AppSumo lifetime licenses: signed webhook, OAuth claim, seat cap, refund
  'logout-provider.test.js', // #58 logout also ends the Clerk session
  'github-account-switch.test.js', // #58 GitHub account mapping per door, select_account, sign-out-of-github notice
  'reply-activity.test.js', // old versions see live reply status without rewriting their snapshot
  'notifications.test.js',    // inbox aggregation + Reddit recipients
  'mentions.test.js',         // @mentions: parsing, who is mentionable, mention-beats-position
  'agent-choices.test.js',    // @ offers the Send to agent list: same order, top 2, typed search, tag is no @login
  'agent-used-here.test.js',  // @ order: used on this doc first, most recent on top; order only; no other person's use leaks
  'ai-answerer.test.js',      // composer @ list: edit agents first, then ask-only own/team; tdoc AI last resort; @AI never a login
  'rich-text.test.js',        // comment markdown subset (bold/code/list/link)
  'overlay-inbox.test.js',    // #180 inbox click → /d/slug?comment= deep-link
  'p3-hardening.test.js',     // #33 safeParseList + escapeHtml
  'preview-worker.test.js',   // #148 isolated preview Worker (no DO, 14d TTL)
  'preview-cards.test.js',    // versioned OG cards, PNG rendering and access gate
  'preview-screenshot.test.js', // page screenshot as the card: PNG checks, write access, precedence
  'preview-card-refresh.test.js', // old-template automatic cards redrawn: lazy fill, backfill, failed render keeps the card
  'preview-workflow.test.js', // #148 PR preview GitHub Action contract
  'ci-workflow.test.js',      // browser CI image matches locked playwright; suites sharded
  'csp-headers.test.js',      // CSP header + nonce plumbing (hermetic, no browser)
  'widget-island.test.js',    // #138 sandboxed widget route + host iframe rewrite
  'stampaids.test.js',        // aid-stamp regex hardening (equivalence + edges)
  'vercel-shim.test.js',      // vercel storage shims (KV/R2 contract, rewrite URL)
  'api.test.js',              // hermetic: spawns its own server in a temp dir
  'publish-signin.test.js',   // device code reaches the publish modal (expiry/pid/slug guards)
  'resume-signin.test.js',    // dead process ≠ dead sign-in: device_code resumes on re-run
  'onboarding-terminal-recovery.test.js', // provider retry flags + honest SIGINT recovery
  'composer-position.test.js', // where the card goes when a keyboard is up
  'reader-patch-drift.test.js', // the phone table rule reaches both runtimes
  'dismiss-rule.test.js',     // the dismiss-first rule keeps its three exceptions
  'resolved-anchors.test.js', // resolved visibility and anchor fallbacks
];

// These run against local fixtures and require the development browser.
const BROWSER = [
  'diagram-controls-ui.test.js', // authored map SVG sizing cannot stretch provider controls
  'reply-activity-ui.test.js', // v2 receives v3 reply status without navigation or pulsing
  'version-diff-ui.test.js', // real version frames, table alignment and mobile diff
  'version-history-ui.test.js', // Edited opens the history panel: grouped rows, Show changes on/off remembered, Share this version, Restore, phone drawer, dev-mode numbers, suggestions row, flag off, earlier-version comment
  'account-profile-menu-ui.test.js', // viewer profile in every desktop/mobile account menu
  'comment-profile-ui.test.js', // comment/reply avatars navigate; pins keep opening comments
  'profile-picks-ui.test.js', // /@handle owner removes picks: card control + Undo, every pin in the picker, errors shown
  'full-text-search-ui.test.js', // My docs search: text results from /api/search, English + Chinese, marked passages, doc markup shown as text
  'trash-ui.test.js',          // Delete → Trash with Undo, link gone, Trash tab Restore / Delete forever, folders, desktop + phone
  'me-rows-ui.test.js',        // My docs rows: type icon + label, sharing, unread badge, Recent/Starred relative dates, ⋯ Share opens the doc's Share dialog, checklist only on Docs below 3 docs; desktop + phone
  'agent-view-ui.test.js', // doc text for agents: no visible space without JS, removed once the app starts
  'layout-preflight.test.js', // development-only Raft geometry audit
  'table-layout.test.js', // provider table protection
  'table-scroll-ui.test.js', // wide tables draw a scrollbar and scroll sideways in their own box (bar, wheel, swipe), page still scrolls over them, desktop + phone
  'resolved-visibility-ui.test.js', // resolved filter, highlights and pointer behavior
  'custom-design-theme.test.js', // custom palettes opt out of house styles and theme inversion
  'visual-viewer.test.js', // visual expansion preserves interactive state and reading mode
  'slides-scale.test.js', // slide view scales cards once: cqw type the same in WebKit and Chromium, desktop and phone
  'slides-mode.test.js', // data-tdoc-slide decks present one slide at a time, fitted, and restore on exit
  'landing-hero-rotate-ui.test.js', // homepage hero: four demos rotate every 5 s with a filling tab bar, hover/focus pause, tab click restarts there (even the checked tab), reduced motion stands still, phone swipe, a CTA per demo to a real route, no layout shift
  'landing-sheets-ui.test.js', // the homepage's live sample sheet: viewer fetched only for it; search, tag filter, sort, comment composer on a cell, desktop + phone, nothing written
  'doc-download-ui.test.js', // ⋯ → Download & copy: PDF / Word / Markdown for prose, CSV (this tab) / Excel for sheets, each a file of its type; desktop + phone; flag off unchanged
  'create-menu-ui.test.js', // My docs New: type tiles (Doc · Sheet · Slides) then methods pushed in place, New folder in the menu, Blank deck edits + saves slide text, agent lines per type, keyboard, drop import; desktop + phone, sheets flag on/off
  'sheets-ui.test.js', // data-tdoc-sheet: grid, search/filter/sort/tags, view in #hash, cell comments, Edit + Save, CSV/XLSX import, CLI, 10k rows, phone
  'slides-reflow.test.js', // phone browse: guide-style decks reflow into a page, others stay scaled; taps open nothing
  'reader-width-ui.test.js', // document width, retired preferences and provider-only serialization
  'reader-layout.test.js', // baked and legacy-served columns, grids and local scrollers
  'style-reader-column-render.test.js', // a house style alone yields the same reading column as a baked doc
  'agents-page-ui.test.js', // Agents page + default-agent modal: AppSelect, 34px forms, list above dialogs
  'workspace-access-ui.test.js', // Allow page workspace ticks + Settings > Agents change/remove, checked against the server
  'connect-ai-apps-ui.test.js', // remoteMcp flag: Connect in one click on /start, /setup, Settings (Claude/ChatGPT/Cursor links) + OAuth consent page, desktop + phone
  'team-agent-ui.test.js',     // team settings add/remove, member Send to team agent, the real daemon replying, desktop + phone
  'notify-handoff-ui.test.js', // Send to agent dialog: no dead button, reassign, Sending… → named result / Retry
  'notifications-ui.test.js', // Notifications dialog: rows, unread, mark all read, opt-in desktop alerts
  'workspace-switcher-ui.test.js', // top-bar space switcher: current space, list, New team, phone fold
  'ask-send-switch-ui.test.js', // Ask AI: quiet Ask ▾ / Edit ▾ mode picker in the input row (instruction input, N comments included · Choose, Send to <agent>, instruction-only becomes a whole-document comment handed off, mode remembered), long agent name on a 320/390 phone stays one row, one row per team agent, team agent answers in public; no phone paper-plane
  'comment-selection-ui.test.js', // one selection engine: old cssPath anchors resolve, slide comments follow reordered slides across versions, area boxes on charts, + Comment picks (whole doc on nothing), widget quotes and page comments; desktop + phone
  'comment-parity-ui.test.js', // doc page and widget run the same cases: Open by default with counts (remembered), a polled agent reply appears, read state is the server's (widget ↔ space page, fresh browser), autoReadComments in the widget, the seen endpoint refuses non-readers; desktop + phone
  'comment-one-behaviour-ui.test.js', // doc page, feedback space and widget draw one card: reply prefill rule, one agent-list height, a reply draft per thread, floating card fits the screen, panel drag width
  'ask-edit-feedback-ui.test.js', // Ask/Edit v2 feedback: @agent in a comment or reply asks for suggestions (phone drawer, ⌘⇧Enter), nothing changes outside dev mode, a reply box is not held by delivery, rewrites read as blocks, edits stay text
  'suggest-accept-ui.test.js', // a suggestion's Accept in the real shell: readable refusals, decided rows leave silently, the list stays true without a refresh, Accept lands on /v/N
  'ask-edit-v2-gate-ui.test.js', // Ask/Edit v2 is dev-mode only: not on the list (desktop + phone), flag pinned, switch off -> Ask AI and comments exactly as before, no suggestions request; dev mode on is the control
  'reader-agent-ask-ui.test.js', // asking in a comment, real shell: @ list (tdoc AI / own agent first), Only me + Make public, answers in the thread, desktop + phone
  'comment-overflow-ask-dismiss-ui.test.js', // a long markdown reply (inline code, paths, a code block) never scrolls a comment card, its thread or an Ask AI answer sideways; Ask AI closes on a click in the document or Escape and keeps the draft; V1 + V2, desktop + phone
  'phone-ask-ai-scroll-ui.test.js', // WebKit + Chromium phone: a long Ask AI answer scrolls to its end in the drawer, the document scrolls after closing
  'doc-bar-composer-ui.test.js', // the doc bar (title, space chip, Edited, quiet Share, mode switch in the bar, comments filter) and the composer's @agent pill / Ask only (off, or ticked and locked; ticked = a held question) / Only me, desktop + phone, team docs
  'reply-agent-ui.test.js',    // the reply box's @agent = the composer's: pill at the caret, pill dropdown (Mine / Team / tdoc AI), Ask only (locked where it may not edit), Only me in a reply; the @ list shows every agent
  'phone-top-bar-ui.test.js', // signed in on a phone: ⋯ stays on screen, spaces under ⋯ → Switch space
  'document-move-ui.test.js', // open doc overflow: move to personal/another team, desktop + phone
  'share-access-ui.test.js', // Share panel: specific people / anyone with the link / public, sign-in switch, desktop + phone
  'team-comments-ui.test.js', // team-wide comments: filters, exact deep links, bounded pagination, phone layout
  'team-backup-ui.test.js', // customer-owned backup setup, health, resync/off, phone layout
  'delete-account-ui.test.js', // Settings → Delete account: danger card, type-to-confirm, blockers with links, server refusal in place, desktop + phone
  'display-name-ui.test.js', // Settings → Profile → Name: field, Save gating, menu follows, refusal in place, empty goes back to the sign-in name, desktop + phone
  'team-billing-ui.test.js', // #48 Team plan card: free seats, upgrade, paid summary, portal, phone
  'landing-demo-agents-ui.test.js', // homepage demo: @agent → Claude (demo) handoff line to a reply, Ask AI demo answer, Send to agent; no write requests; desktop + phone
  'agent-mention-ui.test.js', // @ lists real agents above people; picking one hands the comment to it
  'author-face-ui.test.js', // a comment face a host CSP blocks shows the initial, card and pin
  'nav-menu-links-ui.test.js', // My docs / Agents / logo are real links that show progress at once (landing, doc, /me)
  'dev-mode-ui.test.js', // account menu Dev mode on/off and nested onboarding controls; two-press exit/replay, refused off the list, re-login skips the gate; desktop + phone
  'ui-fonts-ui.test.js', // no serif in product controls: doc page (bar, card, composer, menus, drawer, Ask AI, Agent activity), /me, account + team settings, /feedback; settings hints muted, /me views fit a phone; desktop + phone
  'comment-post-no-hang-ui.test.js', // "Posting…" ends at the POST on the widget, space page and doc page while later reads hang; Send to agent opens on the list already loaded
  'feedback-own-agent-ui.test.js', // a joiner's @ lists their own agents (answer only) on the space page and the widget on tdoc's own pages; none on a third-party space; desktop + phone
  'feedback-share-ui.test.js', // feedback space Share = the doc Share dialog; owner moves it to a team; site mode offers the team first; desktop + phone
  'feedback-invites-ui.test.js', // share from the widget: copy link + invite by name; landing page; Join / Keep my own; switcher; SDK Join; Reconnect without a popup; desktop + phone
  'app-header-ui.test.js', // every page under one top bar: logo, avatar + account menu (desktop), ⋯ → My account (phone); /feedback bookmark + Copy
];

// Existing opt-in UI suites; --all retains their broader coverage.
const EXTENDED_BROWSER = [
  'responsive.test.js',  // playwright
  'ui.test.js',          // playwright
  'csp-xss.test.js',     // playwright: author <script>/onclick blocked, overlay still works
  'artifact-shell.test.js', // playwright: cross-origin iframe shell boundary (RED until the re-arch lands; see PLAN.md)
  'anchor-scenarios.test.js', // #387 everything selectable can carry a comment
  'browser-editing.test.js', // playwright: Read/Comment/Edit + explicit snapshot save/conflict
  'feedback-browser.test.js', // playwright: #564 bookmarklet on a localhost app → connect popup → pin → doc
  'feedback-doc-frame-ui.test.js', // the widget on tdoc's own doc page picks inside the doc frame (element, quote, pins follow its scroll); a phone tap never opens the doc composer too
  'feedback-connect-coop-ui.test.js', // playwright: sign-in through a COOP page cuts the popup off; the claim still connects and the held comment posts; blocked / cancelled keep it
  'mobile-comment-nav.test.js', // playwright phone: highlight ↔ comment, iOS bare tap
];

const INTEGRATION = ['onboarding.test.js', 'publish.test.js'];
const RUNTIME = [
  'preview-workerd.test.js', // needs npm ci; real workerd WASM and font modules
  'doc-download-deps.test.js', // needs npm ci; download output read back with marked and SheetJS (CI: shell runtime job)
];
const runAll = process.argv.includes('--all');
const runBrowser = process.argv.includes('--browser');
const allFiles = runAll ? [...OFFLINE, ...RUNTIME, ...BROWSER, ...EXTENDED_BROWSER, ...INTEGRATION] : runBrowser ? BROWSER : OFFLINE;
// --shard i/n runs every n-th suite starting at i, so CI can split the
// browser regressions across parallel jobs (each suite starts its own server).
const shardArg = process.argv.find((a) => a.startsWith('--shard='));
const [shardIndex, shardCount] = shardArg ? shardArg.slice(8).split('/').map(Number) : [1, 1];
if (!(shardCount >= 1 && shardIndex >= 1 && shardIndex <= shardCount)) throw new Error(`bad --shard ${shardArg}`);
const files = allFiles.filter((_, i) => i % shardCount === shardIndex - 1);
if (runAll || runBrowser) {
  // A requested browser suite must never report success by skipping every test.
  const probe = spawnSync(process.execPath, ['-e',
    "require('playwright').chromium.launch({headless:true}).then(b=>b.close()).catch(e=>{console.error(e.message);process.exitCode=1})"
  ], { stdio: 'inherit' });
  if (probe.status !== 0) process.exit(1);
  process.env.TDOC_REQUIRE_BROWSER_TESTS = '1';
}

let failed = [];
for (const f of files) {
  const p = path.join(__dirname, f);
  process.stdout.write(`\n=== ${f} ===\n`);
  const r = spawnSync(process.execPath, [p], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}

console.log('\n────────────────────────────────────────');
if (failed.length) {
  console.log(`FAIL — ${failed.length}/${files.length} suite(s) failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`PASS — all ${files.length} suite(s) green`);
if (!runAll && !runBrowser) console.log('(browser suites: npm run test:browser; provider integration: npm run test:all)');
