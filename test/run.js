#!/usr/bin/env node
// tdoc test aggregator. Runs every offline test file in sequence and reports a
// single pass/fail. This is what `npm test` and CI invoke, so "run the tests"
// is one command instead of N hand-run files (finding: no-test-runner-or-ci).
//
// Offline suite = no network, no live Cloudflare, no playwright. These run in
// CI with zero secrets. Tests that need a live deploy or playwright are listed
// under NETWORK/BROWSER and skipped here (run them with their own env).
//
// Usage:
//   node test/run.js            # offline suite (default; CI uses this)
//   node test/run.js --all      # also attempt network/browser suites

const { spawnSync } = require('child_process');
const path = require('path');

const OFFLINE = [
  'agent-md.test.js',          // AGENTS.md one-line SoT rule; no ARCHITECTURE.md
  'manifest.test.js',         // plugin.json / marketplace.json schema (#36, #42)
  'comment-history.test.js',  // event-log fold + cross-version pull
  'event-convergence.test.js',// eid dedup convergence + fold ordering
  'reconcile.test.js',        // anchor reconcile branches + compaction
  'security.test.js',         // injection / authz / CSRF / path-traversal
  'access.test.js',           // JUL-31 access policy (public/unlisted/private)
  'remote-access-route.test.js', // remote access mutation auth + meta-only guard
  'me-management.test.js',    // /me remote SoT management UI guard
  'jul36-owner-manage.test.js', // JUL-36 owner manage UX: server-gated data, token-only mutations, no native confirm()
  'runtime-provenance.test.js', // release provenance + content-hash redeploy
  'oldver-strip.test.js',     // old-version banner predicate
  'dark-mode.test.js',        // #120 top-bar dark mode switch + localStorage
  'cli.test.js',              // CLI resilience (drives bash hermetically)
  'no-drift.test.js',         // duplicated-helper drift guard
  'coverage.test.js',         // migration, bundle inlining, pull-merge, rich fold
  'overlay-pure.test.js',     // overlay pure helpers (escape/normalize/prefix)
  'agent-runtime.test.js',    // host-runtime detect + agent logos
  'pins-layout.test.js',      // v0.8.0 pins clustering/spread/overflow-fold core
  'comment-upload.test.js',   // local→worker comment merge (non-destructive)
  'comment-ops.test.js',      // #34 DO-serialized mutation ops
  'notifications.test.js',    // inbox aggregation + Reddit recipients
  'p3-hardening.test.js',     // #33 safeParseList + escapeHtml
  'csp-headers.test.js',      // CSP header + nonce plumbing (hermetic, no browser)
  'stampaids.test.js',        // aid-stamp regex hardening (equivalence + edges)
  'vercel-shim.test.js',      // vercel storage shims (KV/R2 contract, rewrite URL)
  'api.test.js',              // hermetic: spawns its own server in a temp dir
];

// Require network (live Cloudflare) or a browser (playwright). Not run in the
// default offline suite. Listed so it's explicit what coverage is gated.
const GATED = [
  'onboarding.test.js',  // doctor flow
  'publish.test.js',     // dry-publish + (gated) real publish
  'responsive.test.js',  // playwright
  'ui.test.js',          // playwright
  'csp-xss.test.js',     // playwright: author <script>/onclick blocked, overlay still works
];

const runAll = process.argv.includes('--all');
const files = runAll ? [...OFFLINE, ...GATED] : OFFLINE;

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
if (!runAll) console.log(`(gated suites not run: ${GATED.join(', ')} — use --all with a server/playwright)`);
