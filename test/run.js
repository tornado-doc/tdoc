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
//   node test/run.js --perf     # performance budgets enforced (CI perf job)

const { spawnSync } = require('child_process');
const path = require('path');

const OFFLINE = [
  'feedback-space-no-versions.test.js', // a space takes replies, not versions: tokens and MCP refused; creation, comments, replies, browser saves untouched
  'feedback-frame-anchor.test.js', // a comment inside a tdoc doc (anchor.frame): get_comments shows it on one line, no brackets, short, as author content, only for tdoc's own pages
  'react-source.test.js', // feedback on a React site: component chain + source from fiber / bundler attributes, best effort, never throws, nothing read without React, capped, escaped in Copy for agent and get_comments, rebuilt on save
  'frame-part.test.js', // what the doc frame says it picked is rebuilt: known keys, one line, finite numbers, under the anchor size cap
  'comment-one-behaviour.test.js', // comment surfaces share prefill, drafts, list height and the floating card by source rule; Fix with AI stays gone
  'selection-bundle.test.js',  // the shared selection modules bundle into the doc frame without a bundler; container keys, adapters, the pick gesture
  'copy-for-agent.test.js',    // Copy for agent: thread Markdown (context, missing pieces, escaping, http(s) links) and the C / H key guard (never in fields, menus, with modifiers)
  'comment-query.test.js',     // one comment query on every surface: Open by default, counts, deleted rule, waiting on you, search, sort, groupBy
  'thread-seen-api.test.js',   // server read state: authorized like reading the comments, no cross-doc reads, no thread-id leaks
  'feedback-team-agents.test.js', // the widget's @ lists team agents (answer only) only through tdoc's own-origin token door
  'version-diff.test.js', // bounded block matching and Unicode edits
  'block-ids.test.js', // stable block ids: segmentation, matcher (insert above, light edit, split, merge, duplicates, p -> li, moves), quote location, bounds
  'block-ids-publish.test.js', // stable block ids end to end: every publish path writes the sidecar and never fails over it, lazy backfill, comment re-anchors after an agent republish (dev mode: blocks=1, get_comments block_id)
  'block-anchor-frame.test.js', // the frame finds a comment's block by its path, tag and opening words (selection/anchors/block.js)
  'sheet-formula.test.js',     // sheets: formulas (parser, functions, errors, refs, cycles, incremental recompute, ref shifting, Excel, hostile input, 10k formulas < 200 ms)
  'sheets.test.js',            // sheets: view query (search/filter/sort/URL), CSV parsing + type inference, markup round trip
  'sheet-rules.test.js',       // sheets: find & replace, rule JSON parsing (hostile input dropped), conditional formats, dropdowns, fill series, 10k rows in budget
  'sheet-embed.test.js',      // a sheet embedded in a page by reference: the reference resolves only to /d/<slug>, data is text with the view applied, the SHEET's access for the reader (owner/link/sign-in/private/team/guest/anonymous), no title on refusal, linear on hostile markup
  'sheets-outline.test.js',    // sheets structure: groups (nested, 3 levels), collapsed default vs a reader's view, hidden rows, freeze, moves, query re-key, markup round trip, 10k rows
  'sheets-size.test.js',       // sheets: 8 MB sheet cap on every write path (not for prose or a token sheet), history row-count summary, sheet anchors never lost to the aid reconcile
  'sheet-format.test.js',      // sheets: cell formats are whitelisted attributes (hostile values read as none), number formats, Excel codes, merges read and kept through structural edits
  'reader-what-changed.test.js', // a reader without history rights may see what changed (changesVisible); both compare frames behind the read gate (private doc: none for a stranger); applied replies carry applied_in
  'version-history.test.js', // history rows: same writer within 30 min grouped, paged, what changed cached, access, Restore
  'excalidraw.test.js',       // optional diagram source, round-trip export and write permission
  'tdoc-ai-mark.test.js',      // tdoc AI's face: tdoc_logo.svg's strokes + the Ask AI star on an accent badge; tdoc AI and unnamed agents wear it
  'agent-md.test.js',          // AGENTS.md one-line SoT rule; no ARCHITECTURE.md
  'perf-budget.test.js',       // timing budgets: complexity guards fail everywhere, scaled (never tightened) by the runner; perf budgets fail only where enforced (CI perf job)
  'no-async-wait-for-function.test.js', // browser tests never waitForFunction(async ...): Playwright does not await the predicate's value
  'authoring.test.js',        // authoring/ contract: voice floor wired into both generation paths
  'block-lint.test.js',       // publish-time block check: loose text and non-house wrappers warned, never refused; linear on 8 MB sheets; house blocks baked
  'manifest.test.js',         // plugin.json / marketplace.json schema (#36, #42)
  'marketplaces.test.js',     // repo marketplaces (.claude-plugin, .agents/plugins) parse and point at real plugin folders
  'plugins.test.js',          // plugins/: Claude, Codex/ChatGPT, Cursor, Gemini, VS Code packages for the remote MCP server
  'remote-mcp.test.js',       // /mcp + OAuth 2.1: PKCE, redirect URIs, consent CSRF, token mapping, refresh/revoke, tools and refusals, rate limit
  'feedback-demo.test.js',    // Try it on this page: demo mode only on tdoc's own /feedback, script from that origin; answers stay in the tab
  'feedback.test.js',         // #564 product feedback: token door, space, bookmarklet + one-line entry
  'comments-sites.test.js',   // commentsSitesTabs: /api/me/comments lists own docs' and own/joined sites' comments with their source; a stranger, non-member, feedback or scoped token gets nothing
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
  'page-thumb.test.js',        // a doc card's page picture (thumb.svg): text blocks only, nothing runs or fetches, gated like the doc
  'notify-handoff.test.js',   // outbound handoff: owner-gated, note by default, failure recorded not retried
  'remote-access-route.test.js', // remote access mutation auth + meta-only guard
  'doc-head-redirect.test.js', // bare /d/<slug> → 302 to latest, access-gated
  'write-with-ai.test.js',     // New -> Write it with tdoc AI: session + same-site only, dev/preview gate, sentence cap, rate limit, Ask allowance charged (3 units a draft)/refunded, model output escaped (no script/on*), v1 private to the caller; SSE: delta events then done/error, refund on failure or hang-up, JSON without Accept, preview streams its fixed draft
  'ask-doc.test.js',           // Ask this doc: off without a key, browser readers only, read gate, 5 per account, no address to the model
  'ai-timing.test.js',         // tdoc AI response times: one ai_timing log line per model call (Ask answer, Ask edit, Write with tdoc AI JSON/streamed), marks in ms, no prompt/doc/slug/account/upstream text
  'agent-timing.test.js',      // agent reply metrics: one agent_timing log line per handoff milestone (delivered, picked_up, first_reply, suggested, new_version, outcome), stored times, weekly script; no comment/instruction/slug/agent name/account
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
  'comment-email-checks.test.js', // shown addresses: every one's deletion check read (batched), a failed read hides; long strings cost linear time
  'display-name.test.js',       // Settings -> Name: validation, gates, rate limit; chosen name beats re-login and shows on existing comments, @ list, roster, inbox; agents keep theirs
  'mcp-discovery.test.js',     // MCP findable: llms.txt Connect, markdown connect line, raw Link rel=mcp (bytes unchanged), server card + AI catalog, remoteMcp default on
  'agent-native.test.js',      // doc pages point agents at /raw + skill; /llms.txt; Bearer /raw for team/invited docs
  'me-management.test.js',    // /me remote SoT management UI guard
  'me-docs-experience.test.js', // /me sorting + recents + stars + folders (fake bindings)
  'me-rows.test.js',            // My docs rows: doc/sheet/slides, sharing (own docs only), unread comments + agent replies without per-row reads, Recent/Starred dates, checklist on Docs below 3 docs
  'notifications-newest-first.test.js', // the bell is newest first, read or not: a new comment/reply is the first row even when read on the doc page; pages walk every row once; ?filter=unread (Needs you) is the unread alone
  'notifications-read-check.test.js', // #1086: comment/reply/mention/reaction rows, push and email only for people who can still read the doc (removed collaborator, member who left: none; email-born owner, email-invited GitHub user, team admin of a team-unshared doc, a just-invited mention: yes); author account/GitHub id over the handle, no bare-handle fallback; access requests blank for non-managers; unread poll reads at most 20 docs a call and rotates
  'notifications-followup.test.js', // agent replies are quiet bell rows: one per doc, only for people who can still read it (owner + thread people; removed collaborators and members who left get none), one inbox write per person per request, capped; rows on unreadable docs lose title and words; unread rows older than 30 days do not count; equal times page stably; filter=unread is comment/reply/mention only
  'notification-read-unify.test.js', // One read state: a seen thread reads its bell rows (reactions too), a bell read marks the thread seen, stale rows reconcile when the bell loads (bounded reads)
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
  'wait-for-comments.test.js', // wait_for_comments / GET /api/comments/wait / tdoc-watch: read gate as get_comments, returns on a new comment, timeout cursor, batching, no dupes or misses
  'cli-mcp-parity.test.js',     // AGENTS.md: every MCP tool maps to an HTTP route and a CLI command (or a stated exception)

  'pull-acks-handoff.test.js',  // agent pulling comments marks only ITS handoffs received
  'handoff-timestamps.test.js', // send/deliver/ack/reply/publish clocks on a handoff, resend-safe
  'write-with-agent.test.js',    // New › Write it with your agent: private doc + request comment + handoff to the caller's own push agent only; open to every signed-in account (not dev mode only); session + origin, sentence cap, rate limit
  'agent-progress.test.js',      // progress line: Delivered · Reading the doc · Suggested N edits · Published vN · Working · N min; /api/notify/progress only the addressed agent, this doc, capped, rate-limited
  'local-agent.test.js',        // local CLI agents (tdoc-daemon): queued provider, pending index, KV write budget
  'team-agent.test.js',         // team agents: admin adds, members call, one team's reach, survives the adder, revoke
  'daemon-cli.test.js',         // bin/tdoc-daemon once-mode end to end against a stub worker + fake claude
  'handoff-state.test.js',      // handoff classifier: waiting → stale at 5 min, expired past Raft's expiresAt
  'teams.test.js',              // JUL-71 teams: roles, last admin, team-owned docs keep their author
  'folders-agent.test.js',      // agents file docs into folders (My docs + team) with the hosted Bearer
  'folder-name-dedup.test.js',  // one live folder per name per parent: create answers it (case/space/width variants), rename clash 409, Trash never blocks, races in one isolate make one
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
  'mode-initial-behaviour.test.js', // stored Edit does not reopen Edit; ?edit=1 is one-shot
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
  'modeless-edit-ui.test.js', // modelessEdit: type with no Edit mode, autosave -> version in place, bubble + "/" menu, table cells, commenter unchanged, two-editor conflict notice, newer version swapped in without reload (marked, reduced motion), phone, flag off unchanged
  'sheet-modeless-edit-ui.test.js', // modelessEdit on sheets: an editor edits a cell with no mode switch or Save (click/type/Enter/Tab/double-click), autosave -> version, kept after reload; structure menus; comments via the pill / cell menu / a commented cell; a comment on a just-inserted row publishes the draft first and lands on that row (v2) after reload; pill hidden while typing and back on Esc; conflict toast says to resolve first; a newer version shows the strip without a hidden load; a #sheet= search view kept while editing; commenter unchanged; flag off unchanged; phone
  'version-diff-ui.test.js', // real version frames, table alignment and mobile diff
  'doc-topbar-b-ui.test.js', // docTopbarB: the title opens the document menu (Rename, Mode, Version history / See what changed, Download & copy, Duplicate, Convert to Sheet, Move, Delete); right side exactly Ask AI · Comments · Share · avatar; Switch space in the account menu; phone Share · avatar, no ⋯; slides + sheets; modeless Markdown row; flag off unchanged
  'reader-what-changed-ui.test.js', // a reader without history rights: Edited · See what changed opens the compare since the version they last saw; an applied reply's see changes; phone ⋯; a stranger to a private doc gets no frame
  'version-history-ui.test.js', // Edited opens the history panel: grouped rows, Show changes on/off remembered, Share this version, Restore, phone drawer, dev-mode numbers, suggestions row, flag off, earlier-version comment
  'account-profile-menu-ui.test.js', // viewer profile in every desktop/mobile account menu
  'comment-profile-ui.test.js', // comment/reply avatars navigate; pins keep opening comments
  'profile-picks-ui.test.js', // /@handle owner removes picks: card control + Undo, every pin in the picker, errors shown
  'full-text-search-ui.test.js', // My docs search: text results from /api/search, English + Chinese, marked passages, doc markup shown as text
  'trash-ui.test.js',          // Delete → Trash with Undo, link gone, Trash tab Restore / Delete forever, folders, desktop + phone
  'my-docs-a-ui.test.js',      // My docs layout A (wide screens): sidebar types + folders with counts, Needs you from the bell + agent replies (Mark done), grid default / list remembered, drag a card onto a folder, New folder + rename, Settings page sections from the account menu; phone (390 / 430): rows, Needs you strip, view / type / folder chip rows, ⋯ with Star, Select, Settings section list; flag off (the default outside dev mode) keeps one column at every width; 1440 / 1280 / 390 / 430, light + dark
  'me-rows-ui.test.js',        // My docs rows: type icon + label, sharing, unread badge, Recent/Starred relative dates, ⋯ Share opens the doc's Share dialog, checklist only on Docs below 3 docs; desktop + phone
  'agent-view-ui.test.js', // doc text for agents: no visible space without JS, removed once the app starts
  'layout-preflight.test.js', // development-only Raft geometry audit
  'table-layout.test.js', // provider table protection
  'table-fit-ui.test.js', // standard tables fit the reader: page width beside the column, wrap, held first column, phone cards; author-laid-out tables, print and the stored HTML untouched; data-tdoc-wide
  'table-scroll-ui.test.js', // wide tables draw a scrollbar and scroll sideways in their own box (bar, wheel, swipe), page still scrolls over them, desktop + phone
  'resolved-visibility-ui.test.js', // resolved filter, highlights and pointer behavior
  'comment-filter-menu-ui.test.js', // the doc page's filter is the Comment button's chevron menu: no floating row or Refresh over the cards, counts, named on the button, phone drawer keeps its filter
  'comment-count-caret-ui.test.js', // the doc bar's filter caret sits beside the comment count, never over it: 1/12/123 open, the Resolved dot, doc + sheet + deck, 1512 and 720 wide; no split button on a phone
  'custom-design-theme.test.js', // custom palettes opt out of house styles and theme inversion
  'visual-viewer.test.js', // visual expansion preserves interactive state and reading mode
  'slides-scale.test.js', // slide view scales cards once: cqw type the same in WebKit and Chromium, desktop and phone
  'slides-mode.test.js', // data-tdoc-slide decks present one slide at a time, fitted, and restore on exit
  'landing-hero-rotate-ui.test.js', // homepage hero: four demos rotate every 5 s with a filling tab bar, hover/focus pause, tab click restarts there (even the checked tab), reduced motion stands still, phone swipe, a CTA per demo to a real route, no layout shift
  'landing-sheets-ui.test.js', // the homepage's live sample sheet: viewer fetched only for it; search, tag filter, sort, comment composer on a cell, desktop + phone, nothing written
  'doc-download-ui.test.js', // ⋯ → Download & copy: PDF / Word / Markdown for prose, CSV (this tab) / Excel for sheets, each a file of its type; desktop + phone; flag off unchanged
  'slide-controls-ui.test.js', // Edit-mode slide bar: Add slide (Title / Bullets / Big number), Duplicate, Move up/down, Delete + Undo, image by http(s) link; whole slides only, ids follow their slides, nothing of the bar saved; desktop hover + phone tap
  'create-menu-ui.test.js', // My docs New: type tiles (Doc · Sheet · Slides) then methods pushed in place, New folder in the menu, Blank deck edits + saves slide text, agent lines per type, keyboard, drop import; desktop + phone, sheets flag on/off
  'sheet-comment-anchor-ui.test.js', // a sheet cell comment lands on its cell (row id + key): wide sheet with frozen columns, pin opens and marks it clear of the pin; sorted/filtered/hidden-column sheet doc; embed → sheet; row without id; phone link
  'sheet-embed-ui.test.js', // a sheet embedded in a page: live view (saved view, comment count, Open), no-access state with nothing of the sheet, keyless frames and requests get nothing, flag off is the link, desktop + phone
  'sheets-ui.test.js', // data-tdoc-sheet: grid, search/filter/sort/tags, view in #hash, cell comments, Edit + Save, CSV/XLSX import, CLI, 10k rows, phone
  'sheets-structure-ui.test.js', // group/collapse/expand rows + columns, hide/unhide, drag + Alt-arrow reorder, freeze (menu, grip, reader's own), tab rename/reorder/duplicate/colour/delete+undo, comments keep cells, flat view + phone cards summary rows, 10k rows grouped; desktop + phone
  'sheet-formulas-ui.test.js', // sheet formulas: Read computes and changes nothing, Edit types =…, recompute across tabs, formula bar, Save keeps formula + value, insert/delete/fill/paste/rename move refs, undo, hostile sheet stays usable (#BUSY!), 10k formulas; desktop + phone
  'sheet-edit-ux-ui.test.js', // a sheet in a prose doc in Edit mode: full grid, column menu leads with Insert / Hide / Delete (in view, saved), no "Comment on sheet" button in any mode, no blue frame on the editor or the grid; desktop + phone
  'sheets-basics-ui.test.js', // sheet modes (Read edits nothing, a Comment click comments on a cell, Edit), column/row resize (drag, double-click fit, touch, frozen column) through the editor's Save, a reader's own layout, Wrap/Clip + align, line breaks (Alt/Ctrl+Enter, multi-line paste, <br>), fill down, ⌘-arrow edges, 10k rows wrapped; desktop + phone
  'sheets-format-ui.test.js', // cell formatting: Read draws formats/number formats/merges (grid, flat, phone) with no toolbar; Edit's one-row toolbar (bold, italic, colours, fills, number formats, align, clear, merge/unmerge) through Undo and Save; hostile attributes inert; 10k rows in budget
  'sheets-rules-ui.test.js', // sheets: Find and replace (⌘⇧H, match case, entire cell, every tab, one Undo), conditional formatting + dropdowns side panel (JSON on the table, Save), dropdown chips and marks, the fill handle (number/date series, Ctrl copies, under a sort), Read stays clean, phone bottom sheets, 10k rows with rules
  'sheets-integration-ui.test.js', // release 2026-11-11d: merges x hidden rows/columns, groups and freeze; rule fill wins over a cell's own fill; Find skips hidden columns and opens a group, Replace all reaches hidden cells; fill handle x hidden rows/columns and merges; insert/delete rows x merges x groups x rules; formulas x merges/hidden/collapsed rows/rules, find & replace in the formula, fill handle moves references
  'doc-types-top-bar-ui.test.js', // doc, sheet and deck: the same top bar, ⋯ menu (Read / Comment / Edit) and editor bar; a sheet full screen or on its own page keeps them; desktop + phone
  'sheet-doc-standalone-ui.test.js', // a sheet-only doc is a full page sheet: ?sheet=N and #expand=1 open the tab in place, no way back / Open on its own / close; a prose doc's sheet keeps them, with a "Doc / Tab" breadcrumb whose doc title goes back (closes full screen; opens the doc from its own page); desktop + phone
  'markdown-edit-ui.test.js', // Edit as Markdown (flag markdownEditMode): the switch in Edit mode and beside autosave; edits save, house blocks byte for byte, raw HTML stays text, choice remembered, disabled with a reason, no switch on sheets or flag off; desktop + phone
  'convert-to-sheet-ui.test.js', // ⋯ › Convert to Sheet (flag convertToSheet): offered to an editor of a prose doc holding a sheet only; confirm, v2 is a sheet doc (no Open the doc), title and prose kept in a .sheet-note, cell comments on their cells, v1 intact; the conversion's cases in the browser; desktop + phone
  'slides-reflow.test.js', // phone browse: guide-style decks reflow into a page, others stay scaled; taps open nothing
  'reader-width-ui.test.js', // document width, retired preferences and provider-only serialization
  'reader-layout.test.js', // baked and legacy-served columns, grids and local scrollers
  'style-reader-column-render.test.js', // a house style alone yields the same reading column as a baked doc
  'table-style-render.test.js', // the reader table (header band, ruled rows) survives an author's collapse + cell borders; old bakes get it via the serve-time patch
  'agents-page-ui.test.js', // Agents page + default-agent modal: AppSelect, 34px forms, list above dialogs
  'workspace-access-ui.test.js', // Allow page workspace ticks + Settings > Agents change/remove, checked against the server
  'connect-ai-apps-ui.test.js', // remoteMcp flag: Connect in one click on /start, /setup, Settings (Claude/ChatGPT/Cursor links) + OAuth consent page, desktop + phone
  'team-agent-ui.test.js',     // team settings add/remove, member Send to team agent, the real daemon replying, desktop + phone
  'write-with-ai-ui.test.js', // New -> Doc -> Write it with tdoc AI (flag): one sentence, the draft streams in live (markup stays text), lands on the new doc's v1; Stop and a mid-stream failure stay with nothing charged; desktop + phone; flag off = no row
  'notify-handoff-ui.test.js', // Send to agent dialog: no dead button, reassign, Sending… → named result / Retry
  'write-with-agent-ui.test.js', // New › Write it with your agent (flag writeWithAgent): Send to your agent opens the new doc on the sent request; no agent: why + Connect an agent; flag off: copy line only; agentProgress off: plain Sent line, no progress pill; desktop + phone
  'agent-progress-ui.test.js', // agent progress line on the comment card (flag agentProgress): steps, current step + elapsed always shown, agent status via the poll; desktop + phone; flag off = On it
  'notifications-ui.test.js', // Notifications dialog: rows, unread, mark all read, opt-in desktop alerts
  'bell-newest-first-ui.test.js', // the bell on a doc page: today's activity (read or not) above an old unread backlog; count = unread; desktop + phone
  'bell-followup-ui.test.js', // the bell on a doc page: an agent reply is a row with its mark, grouped per thread; a 40-day-old unread row is listed untinted and not counted; desktop + phone
  'bell-read-unify-ui.test.js', // one read state: a thread seen on the doc page drops that page's bell count at once (no poll); a bell row read marks its thread seen; opening the doc marks nothing
  'workspace-switcher-ui.test.js', // top-bar space switcher: current space, list, New team, phone fold
  'ask-send-switch-ui.test.js', // Ask AI: quiet Ask ▾ / Edit ▾ mode picker in the input row (instruction input, N comments included · Choose, Send to <agent>, instruction-only becomes a whole-document comment handed off, mode remembered), long agent name on a 320/390 phone stays one row, one row per team agent, team agent answers in public; no phone paper-plane
  'comment-selection-ui.test.js', // one selection engine: old cssPath anchors resolve, slide comments follow reordered slides across versions, area boxes on charts, + Comment picks (whole doc on nothing), widget quotes and page comments; desktop + phone
  'comment-parity-ui.test.js', // doc page and widget run the same cases: Open by default with counts (remembered), a polled agent reply appears, read state is the server's (widget ↔ space page, fresh browser), autoReadComments in the widget, the seen endpoint refuses non-readers; desktop + phone
  'react-source-ui.test.js', // feedback widget on a React app (reactSourceCapture): hover tag names the component + file:line as text, anchor.react stored, hostile names never run, no tag without React or with the flag off; desktop + phone
  'copy-for-agent-ui.test.js', // Copy for agent on the doc page, the widget and the space page: thread ⋯ and list ⋯ copy Markdown, toast, C / H keys (never while typing), Esc still closes, on for everyone (a signed-out reader too); desktop + phone
  'send-to-agent-visibility-ui.test.js', // needs npm ci (esbuild, react-dom), so it runs with the browser suites. @agent rendered: hidden only for who may never send (SEND_TO_AGENT_WHO); disabled with its reason for a permitted person (no team daemon, admin only, no team agent, not a writer, Finding your agents…); connect link
  'comment-first-signin-ui.test.js', // comment first, sign in later (doc page, slides, sheets): signed-out Post signs in in a window and the held comment posts by itself, the page stays; the window's word alone posts nothing; blocked window: redirect, words restored ("Your comment is saved — Post"), never posted by themselves; Esc mid sign-in holds nothing
  'dogfood-frictions-ui.test.js', // dogfood 2026-11-20: landing Any web app tab readable on a phone, Feedback for your site (bar / phone ⋯), comment button over no CTA; widget signed out: Post + sign-in line, no @agent, one tdoc window, Esc closes the composer and keeps the words
  'menu-one-press-ui.test.js', // a press on a menu row acts once (mouse, tap, keys, drag from the button, right press) on the widget and the doc page; the widget's Copy / markers / Edit / Delete / Move anchor for real
  'feedback-panel-parity-ui.test.js', // the widget's comment list = the doc page's: same side width, same filter row (one line, options inside the pill, same geometry), on a plain and a hostile host page; desktop + phone
  'comment-one-behaviour-ui.test.js', // doc page, feedback space and widget draw one card: reply prefill rule, one agent-list height, a reply draft per thread, floating card fits the screen, panel drag width
  'ask-edit-feedback-ui.test.js', // Ask/Edit v2 feedback: @agent in a comment or reply asks for suggestions (phone drawer, ⌘⇧Enter), nothing changes outside dev mode, a reply box is not held by delivery, rewrites read as blocks, edits stay text
  'suggest-accept-ui.test.js', // a suggestion's Accept in the real shell: readable refusals, decided rows leave silently, the list stays true without a refresh, Accept lands on /v/N
  'suggest-overlap-ui.test.js', // pending suggestions on the same words (copies, overlapping finds) show once each, never one inside another; Reject takes exact copies; the held-back one then shows; Accept publishes
  'suggest-accept-all-ui.test.js', // Accept all is one call and one version: with KV a step behind, every set lands and nothing stays pending on the version the page moves to; an exact copy is accepted with its twin
  'needs-you-edits-ui.test.js', // Needs you: "Review N edits" for a doc with suggestions waiting on this person, desktop + phone; opens the doc with the review on the first; deciding or Mark done takes it away until new edits
  'ask-edit-v2-gate-ui.test.js', // Ask/Edit v2 is dev-mode only: not on the list (desktop + phone), flag pinned, switch off -> Ask AI and comments exactly as before, no suggestions request; dev mode on is the control
  'reader-agent-ask-ui.test.js', // asking in a comment, real shell: @ list (tdoc AI / own agent first), Only me + Make public, answers in the thread, desktop + phone
  'comment-overflow-ask-dismiss-ui.test.js', // a long markdown reply (inline code, paths, a code block) never scrolls a comment card, its thread or an Ask AI answer sideways; Ask AI closes on a click in the document or Escape and keeps the draft; V1 + V2, desktop + phone
  'phone-ask-ai-scroll-ui.test.js', // WebKit + Chromium phone: a long Ask AI answer scrolls to its end in the drawer, the document scrolls after closing
  'doc-bar-composer-ui.test.js', // the doc bar (title, space chip, Edited, quiet Share, mode switch in the bar, comments filter) and the composer's @agent pill / Ask only (off, or ticked and locked; ticked = a held question) / Only me, desktop + phone, team docs
  'doc-bar-star-ui.test.js', // the star after the title (doc, sheet, slides; desktop + phone): POST /api/star like My docs, optimistic with rollback, signed-in viewers only
  'reply-agent-ui.test.js',    // the reply box's @agent = the composer's: pill at the caret, pill dropdown (Mine / Team / tdoc AI), Ask only (locked where it may not edit), Only me in a reply; the @ list shows every agent
  'phone-top-bar-ui.test.js', // signed in on a phone: ⋯ stays on screen, spaces under ⋯ → Switch space
  'document-move-ui.test.js', // open doc overflow: move to personal/another team, desktop + phone
  'share-access-ui.test.js', // Share panel: specific people / anyone with the link / public, sign-in switch, desktop + phone
  'team-comments-ui.test.js', // team-wide comments: filters, exact deep links, bounded pagination, phone layout
  'comments-sites-ui.test.js', // commentsSitesTabs: one Comments list (docs + sites, From filter), Sites tab (Settings inline, test sites folded), empty discovery block, phone, flag off unchanged
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
  'no-agent-cta-ui.test.js', // signed in, no agent: Ask AI beside tdoc AI and the owner's copy-prompt card link to Settings › Agents; a reader is not asked to connect the owner's; the widget's Set up opens tdoc in a new tab; desktop + phone
  'feedback-own-agent-ui.test.js', // a joiner's @ lists their own agents (answer only) on the space page and the widget on tdoc's own pages; none on a third-party space; desktop + phone
  'feedback-share-ui.test.js', // feedback space Share = the doc Share dialog; owner moves it to a team; site mode offers the team first; desktop + phone
  'feedback-invites-ui.test.js', // share from the widget: copy link + invite by name; landing page; Join / Keep my own; switcher; SDK Join; Reconnect without a popup; desktop + phone
  'app-header-ui.test.js', // every page under one top bar: logo, avatar + account menu (desktop), ⋯ → My account (phone); /feedback bookmark + Copy
  'feedback-try-demo-ui.test.js', // /feedback Try it on this page: the real widget, no account; pick, post in the tab, pin + thread, C copies Markdown, Add to your site; zero comment API calls, no popup; #try starts it; desktop + phone
  'feedback-install-ui.test.js', // /feedback: Bookmark / SDK chooser jumps to its section, SDK as a peer section (site picture, 3 steps), Copy prompt + Copy line, signed-in owner sees their real space id; desktop + phone
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
  'feedback-connect-coop-ui.test.js', // playwright: sign-in through a COOP page cuts the popup off; the claim still connects and the held comment posts; blocked keeps it; the held draft posts only on Post / Connect (not a reload with a token) and expires after 15 min; a lost window reopens from the composer
  'mobile-comment-nav.test.js', // playwright phone: highlight ↔ comment, iOS bare tap
];

const INTEGRATION = ['onboarding.test.js', 'publish.test.js'];

// --perf: the pure performance budgets (test/helpers/perf-budget.js budget())
// enforced, for the CI `perf` job, which does not block a merge. Elsewhere
// TDOC_PERF=report turns an overrun into a warning; complexity guards
// (guard()) fail everywhere. [suite, TDOC_TEST_FILTER]
const PERF = [
  ['sheets-ui.test.js', '10,000 rows'],
  ['sheets-rules-ui.test.js', '10,000 rows'],
];
const RUNTIME = [
  'preview-workerd.test.js', // needs npm ci; real workerd WASM and font modules
  'doc-download-deps.test.js', // needs npm ci; download output read back with marked and SheetJS (CI: shell runtime job)
  'markdown-source.test.js', // needs npm ci (marked); Edit as Markdown (flag markdownEditMode): plain docs round-trip, untouched blocks byte for byte, unshowable blocks kept behind placeholders, nothing typed becomes markup outside the allow-list (CI: shell runtime job)
];
const runAll = process.argv.includes('--all');
const runPerf = process.argv.includes('--perf');
const runBrowser = process.argv.includes('--browser') || runPerf;
const allFiles = runPerf ? PERF.map(([f]) => f) : runAll ? [...OFFLINE, ...RUNTIME, ...BROWSER, ...EXTENDED_BROWSER, ...INTEGRATION] : runBrowser ? BROWSER : OFFLINE;
const perfFilter = new Map(runPerf ? PERF : []);
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
  const env = perfFilter.has(f) ? { ...process.env, TDOC_PERF: 'enforce', TDOC_TEST_FILTER: perfFilter.get(f) } : process.env;
  const r = spawnSync(process.execPath, [p], { stdio: 'inherit', env });
  if (r.status !== 0) failed.push(f);
}

console.log('\n────────────────────────────────────────');
if (failed.length) {
  console.log(`FAIL — ${failed.length}/${files.length} suite(s) failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`PASS — all ${files.length} suite(s) green`);
if (!runAll && !runBrowser) console.log('(browser suites: npm run test:browser; provider integration: npm run test:all)');
