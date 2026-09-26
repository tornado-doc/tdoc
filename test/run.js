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
  'excalidraw.test.js',       // optional diagram source, round-trip export and write permission
  'agent-md.test.js',          // AGENTS.md one-line SoT rule; no ARCHITECTURE.md
  'authoring.test.js',        // authoring/ contract: voice floor wired into both generation paths
  'manifest.test.js',         // plugin.json / marketplace.json schema (#36, #42)
  'comment-history.test.js',  // event-log fold + cross-version pull
  'comment-dedupe.test.js',   // the same words twice within seconds is one comment
  'event-convergence.test.js',// eid dedup convergence + fold ordering
  'reconcile.test.js',        // anchor reconcile branches + compaction
  'agent-status-emoji.test.js',// agent verdict emoji constant must exist (v>=2 folds)
  'security.test.js',         // injection / authz / CSRF / path-traversal
  'access.test.js',           // JUL-31 access policy (public/unlisted/private)
  'resolution-actor.test.js', // who resolved: human vs agent, kept as a fact
  'notify-handoff.test.js',   // outbound handoff: owner-gated, note by default, failure recorded not retried
  'remote-access-route.test.js', // remote access mutation auth + meta-only guard
  'doc-head-redirect.test.js', // bare /d/<slug> → 302 to latest, access-gated
  'me-management.test.js',    // /me remote SoT management UI guard
  'me-docs-experience.test.js', // /me sorting + recents + stars + folders (fake bindings)
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
  'setup-gate.test.js', // the journey: two doors, three server-driven bridges, no daemon // #357 a person can resolve; resolved threads leave the margin
  'tornado-doc-landing.test.js',
  'landing-republish.test.js', // #458 the homepage is one v1, re-shipped in place with `replace`
  'browser-bundles-parse.test.js', // syntax-check what we inject into pages
  'tdoc-start.test.js',
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
  'bake-reader.test.js',      // tdoc-new bakes the reader template → self-contained docs (shell)
  'dark-invert-parity.test.js', // the shell's dark invert and the frame's copy must not drift
  'write-invariants.test.js',  // every server write path bakes, stamps aids, records sha
  'comment-upload.test.js',   // local→worker comment merge (non-destructive)
  'comment-ops.test.js',      // #34 DO-serialized mutation ops
  'agent-reply-once.test.js', // #349 the agent answers once per human turn
  'notifications.test.js',    // inbox aggregation + Reddit recipients
  'mentions.test.js',         // @mentions: parsing, who is mentionable, mention-beats-position
  'overlay-inbox.test.js',    // #180 inbox click → /d/slug?comment= deep-link
  'p3-hardening.test.js',     // #33 safeParseList + escapeHtml
  'preview-worker.test.js',   // #148 isolated preview Worker (no DO, 14d TTL)
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
  'layout-preflight.test.js', // development-only Raft geometry audit
  'table-layout.test.js', // provider table protection
  'resolved-visibility-ui.test.js', // resolved filter, highlights and pointer behavior
  'reader-width-ui.test.js', // document width, retired preferences and provider-only serialization
  'reader-layout.test.js', // baked and legacy-served columns, grids and local scrollers
];

// Existing opt-in UI suites; --all retains their broader coverage.
const EXTENDED_BROWSER = [
  'responsive.test.js',  // playwright
  'ui.test.js',          // playwright
  'csp-xss.test.js',     // playwright: author <script>/onclick blocked, overlay still works
  'artifact-shell.test.js', // playwright: cross-origin iframe shell boundary (RED until the re-arch lands; see PLAN.md)
  'anchor-scenarios.test.js', // #387 everything selectable can carry a comment
  'browser-editing.test.js', // playwright: Read/Comment/Edit + explicit snapshot save/conflict
];

const INTEGRATION = ['onboarding.test.js', 'publish.test.js'];
const runAll = process.argv.includes('--all');
const runBrowser = process.argv.includes('--browser');
const files = runAll ? [...OFFLINE, ...BROWSER, ...EXTENDED_BROWSER, ...INTEGRATION] : runBrowser ? BROWSER : OFFLINE;
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
