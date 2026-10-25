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
  'version-diff.test.js', // bounded block matching and Unicode edits
  'excalidraw.test.js',       // optional diagram source, round-trip export and write permission
  'agent-md.test.js',          // AGENTS.md one-line SoT rule; no ARCHITECTURE.md
  'authoring.test.js',        // authoring/ contract: voice floor wired into both generation paths
  'manifest.test.js',         // plugin.json / marketplace.json schema (#36, #42)
  'feedback.test.js',         // #564 product feedback: token door, space, bookmarklet + one-line entry
  'comment-history.test.js',  // event-log fold + cross-version pull
  'comment-dedupe.test.js',   // the same words twice within seconds is one comment
  'comment-notification-failure.test.js', // inbox KV trouble never turns a saved comment into HTTP 500
  'event-convergence.test.js',// eid dedup convergence + fold ordering
  'reconcile.test.js',        // anchor reconcile branches + compaction
  'agent-status-emoji.test.js',// agent verdict folds without synthetic reactions
  'security.test.js',         // injection / authz / CSRF / path-traversal
  'access.test.js',           // JUL-31 access policy (public/unlisted/private)
  'link-sharing.test.js',     // anyone with the link: noindex everywhere, unlisted by default, require sign-in, public->link migration
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
  'ask-in-thread.test.js',     // Ask AI in a comment: tdoc AI or the commenter's own agent answers as a reply in the thread, seen by all
  'hand-off.test.js',          // one door: Ask only decides edit (authorship) or answer (own / team agent / tdoc AI), never another's agent
  'handoff-privacy.test.js',   // handoff details: commenter, sender and owner only; a member hands off threads they began or replied in
  'agent-authorship.test.js',  // authorship at write time (upload, agent replies that mark applied) and answer-only locks from send to answer, per question, failing closed
  'comment-wipe-authorship.test.js', // the comment wipe and team move follow agent authorship; a successful wipe answers 200
  'comment-email-privacy.test.js', // email commenters: aliases for other readers, own/invited/team keep the address
  'agent-native.test.js',      // doc pages point agents at /raw + skill; /llms.txt; Bearer /raw for team/invited docs
  'me-management.test.js',    // /me remote SoT management UI guard
  'me-docs-experience.test.js', // /me sorting + recents + stars + folders (fake bindings)
  'shell-scan-cap.test.js',     // big docs: the page scans only the head (Cloudflare 1102)
  'inline-media.test.js',       // base64 video/audio refused at publish: link it instead
  'catalog-index.test.js',      // My docs costs what the viewer owns, not the platform (1102)
  'doc-index.test.js',          // per-owner/team doc index, invite index, one-pass frame bake + per-version cache (1102)
  'trash.test.js',              // Delete moves to Trash: gone on every path, restore, 30-day purge, folders, permissions
  'trash-hardening.test.js',    // #815 review: resumable purge, restore quota, batched folder delete, bounded reads, write race, old CLIs, --forever
  'mention-directory.test.js',  // @ offers doc people, teammates, recent contacts first
  'publish-attribution.test.js', // author name + per-version publisher come from the credential
  'operator-fallback.test.js',  // TDOC_OWNER owns only ownerless docs, not email accounts' docs
  'version-catch-up.test.js',   // an orphaned version no longer wedges later publishes
  'site-space.test.js',         // SDK: a site's own comment space, origins + invited/public
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
  'oidc-provider-registry.test.js', // provider registry: raft seat, agent-only stateless callback
  'email-identity-surface.test.js', // phase-4: actor keys — email identities comment, are invited, own their words
  'identity-recycling.test.js', // renamed handles and recycled addresses must not inherit an account
  'duplicate-download.test.js', // #146 Duplicate vs Download chrome + route contract
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
  'feature-flags.test.js', // flag registry: dev-mode-only until default flips; unknown names off
  'dev-mode.test.js', // Dev mode switch (allow-list only, per account) + onboarding never returns on re-login
  'setup-gate.test.js', // the journey: two doors, three server-driven bridges, no daemon // #357 a person can resolve; resolved threads leave the margin
  'tornado-doc-landing.test.js',
  'landing-republish.test.js', // #458 the homepage is one v1, re-shipped in place with `replace`
  'browser-bundles-parse.test.js', // syntax-check what we inject into pages
  'tdoc-start.test.js',
  'tdoc-pricing.test.js', // public /pricing page matches the limits the worker enforces
  'landing-demo-tabs.test.js', // the homepage demo: four stages, one reader
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
  'dark-invert-parity.test.js', // the shell's dark invert and the frame's copy must not drift
  'write-invariants.test.js',  // every server write path bakes, stamps aids, records sha
  'comment-upload.test.js',   // local→worker comment merge (non-destructive)
  'comment-ops.test.js',      // #34 DO-serialized mutation ops
  'agent-reply-once.test.js', // #349 the agent answers once per human turn
  'kv-write-budget.test.js', // repeat actions spend no extra KV writes (daily quota)
  'team-billing.test.js', // #48 Team plan: Stripe checkout, portal, signed webhook, seat sync
  'team-scoped-token.test.js', // #65 a token narrowed to one team cannot read, list or write outside it
  'workspace-scoped-token.test.js', // agent connections reach only the workspaces ticked for them; change and remove take effect at once
  'appsumo-licensing.test.js', // #61 AppSumo lifetime licenses: signed webhook, OAuth claim, seat cap, refund
  'logout-provider.test.js', // #58 logout also ends the Clerk session
  'github-account-switch.test.js', // #58 GitHub account mapping per door, select_account, sign-out-of-github notice
  'reply-activity.test.js', // old versions see live reply status without rewriting their snapshot
  'notifications.test.js',    // inbox aggregation + Reddit recipients
  'mentions.test.js',         // @mentions: parsing, who is mentionable, mention-beats-position
  'agent-choices.test.js',    // @ offers the Send to agent list: same order, top 2, typed search, tag is no @login
  'ai-answerer.test.js',      // composer @ list: edit agents first, then ask-only own/team; tdoc AI last resort; @AI never a login
  'rich-text.test.js',        // comment markdown subset (bold/code/list/link)
  'overlay-inbox.test.js',    // #180 inbox click → /d/slug?comment= deep-link
  'p3-hardening.test.js',     // #33 safeParseList + escapeHtml
  'preview-worker.test.js',   // #148 isolated preview Worker (no DO, 14d TTL)
  'preview-cards.test.js',    // versioned OG cards, PNG rendering and access gate
  'preview-screenshot.test.js', // page screenshot as the card: PNG checks, write access, precedence
  'preview-workflow.test.js', // #148 PR preview GitHub Action contract
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
  'account-profile-menu-ui.test.js', // viewer profile in every desktop/mobile account menu
  'comment-profile-ui.test.js', // comment/reply avatars navigate; pins keep opening comments
  'profile-picks-ui.test.js', // /@handle owner removes picks: card control + Undo, every pin in the picker, errors shown
  'full-text-search-ui.test.js', // My docs search: text results from /api/search, English + Chinese, marked passages, doc markup shown as text
  'trash-ui.test.js',          // Delete → Trash with Undo, link gone, Trash tab Restore / Delete forever, folders, desktop + phone
  'agent-view-ui.test.js', // doc text for agents: no visible space without JS, removed once the app starts
  'layout-preflight.test.js', // development-only Raft geometry audit
  'table-layout.test.js', // provider table protection
  'resolved-visibility-ui.test.js', // resolved filter, highlights and pointer behavior
  'custom-design-theme.test.js', // custom palettes opt out of house styles and theme inversion
  'visual-viewer.test.js', // visual expansion preserves interactive state and reading mode
  'slides-scale.test.js', // slide view scales cards once: cqw type the same in WebKit and Chromium, desktop and phone
  'slides-mode.test.js', // data-tdoc-slide decks present one slide at a time, fitted, and restore on exit
  'slides-reflow.test.js', // phone browse: guide-style decks reflow into a page, others stay scaled; taps open nothing
  'reader-width-ui.test.js', // document width, retired preferences and provider-only serialization
  'reader-layout.test.js', // baked and legacy-served columns, grids and local scrollers
  'agents-page-ui.test.js', // Agents page + default-agent modal: AppSelect, 34px forms, list above dialogs
  'workspace-access-ui.test.js', // Allow page workspace ticks + Settings > Agents change/remove, checked against the server
  'team-agent-ui.test.js',     // team settings add/remove, member Send to team agent, the real daemon replying, desktop + phone
  'notify-handoff-ui.test.js', // Send to agent dialog: no dead button, reassign, Sending… → named result / Retry
  'notifications-ui.test.js', // Notifications dialog: rows, unread, mark all read, opt-in desktop alerts
  'workspace-switcher-ui.test.js', // top-bar space switcher: current space, list, New team, phone fold
  'reader-agent-ask-ui.test.js', // asking in a comment, real shell: @ list (tdoc AI / own agent first), Only me + Make public, answers in the thread, desktop + phone
  'doc-bar-composer-ui.test.js', // the doc bar (title, space chip, Edited, quiet Share, modes in ⋯, comments filter) and the composer's @agent pill / Answers only / Only me, desktop + phone, team docs
  'reply-agent-ui.test.js',    // the reply box's @agent = the composer's: pill at the caret, pill dropdown (Mine / Team / tdoc AI), Answers only where it may not edit, Only me in a reply; the @ list shows every agent
  'phone-top-bar-ui.test.js', // signed in on a phone: ⋯ stays on screen, spaces under ⋯ → Switch space
  'document-move-ui.test.js', // open doc overflow: move to personal/another team, desktop + phone
  'share-access-ui.test.js', // Share panel: specific people / anyone with the link / public, sign-in switch, desktop + phone
  'team-comments-ui.test.js', // team-wide comments: filters, exact deep links, bounded pagination, phone layout
  'team-backup-ui.test.js', // customer-owned backup setup, health, resync/off, phone layout
  'team-billing-ui.test.js', // #48 Team plan card: free seats, upgrade, paid summary, portal, phone
  'agent-mention-ui.test.js', // @ lists real agents above people; picking one hands the comment to it
  'nav-menu-links-ui.test.js', // My docs / Agents / logo are real links that show progress at once (landing, doc, /me)
  'dev-mode-ui.test.js', // account menu Dev mode on/off and nested onboarding controls; two-press exit/replay, refused off the list, re-login skips the gate; desktop + phone
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
  'mobile-comment-nav.test.js', // playwright phone: highlight ↔ comment, iOS bare tap
];

const INTEGRATION = ['onboarding.test.js', 'publish.test.js'];
const RUNTIME = ['preview-workerd.test.js']; // needs npm ci; real workerd WASM and font modules
const runAll = process.argv.includes('--all');
const runBrowser = process.argv.includes('--browser');
const files = runAll ? [...OFFLINE, ...RUNTIME, ...BROWSER, ...EXTENDED_BROWSER, ...INTEGRATION] : runBrowser ? BROWSER : OFFLINE;
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
