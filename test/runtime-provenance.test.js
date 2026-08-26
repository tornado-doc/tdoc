// Runtime provenance and release redeploy guards.
//
// A published page must be able to identify the runtime bundle that served it,
// and publish must decide redeploy by source content hash, not mtimes.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
const publish = fs.readFileSync(path.join(root, 'bin', 'tdoc-publish'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'bin', 'tdoc-bundle'), 'utf8');
const RUNTIME_PUBLIC_KEYS = [
  'service',
  'mode',
  'source_sha',
  'source_dirty',
  'worker_sha',
  'bundle_sha',
  'built_at',
  'generated_by',
];

function runtimeInfoPublicKeys() {
  const start = worker.indexOf('function runtimeInfo()');
  const end = worker.indexOf('\nfunction parseCookie', start);
  assert(start !== -1 && end !== -1, 'runtimeInfo function must be parseable');
  const block = worker.slice(start, end);
  const m = block.match(/return\s*\{([\s\S]*?)\n\s*\};/);
  assert(m, 'runtimeInfo must return an object literal');
  assert(!/^\s*\.\.\./m.test(m[1]), 'runtimeInfo must not spread arbitrary build/env objects');
  return Array.from(m[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm), (hit) => hit[1]);
}

console.log('runtime provenance');

t('Worker has a bundled build-info placeholder and runtime endpoint', () => {
  assert(worker.includes('const TDOC_BUILD_INFO = "__TDOC_BUILD_INFO__";'),
    'worker must expose a build-info placeholder for bundling');
  assert(worker.includes("if (p === '/api/runtime') return json({ ok: true, runtime: runtimeInfo() });"),
    'worker must expose /api/runtime');
  assert(worker.includes("runtime: cfg.runtime || runtimeInfo()"),
    'published boot config must include runtime provenance');
});

t('/api/ping stays backward-compatible and minimal', () => {
  assert(worker.includes("if (p === '/api/ping') return json({ ok: true, service: 'tdoc' });"),
    '/api/ping should remain a simple health check');
});

t('/api/runtime exposes only the intended public provenance fields', () => {
  const actual = runtimeInfoPublicKeys();
  assert(JSON.stringify(actual) === JSON.stringify(RUNTIME_PUBLIC_KEYS),
    `/api/runtime field set changed: ${JSON.stringify(actual)}`);
  assert(!worker.includes('leaked_token'), '/api/runtime test must catch accidental secret-looking fields');
});

t('publish bundles deterministic provenance fields', () => {
  for (const field of ['source_sha', 'source_dirty', 'worker_sha', 'bundle_sha', 'generated_by']) {
    assert(bundle.includes(field), `bundle build info missing ${field} in tdoc-bundle`);
  }
  assert(bundle.includes('const TDOC_BUILD_INFO = "__TDOC_BUILD_INFO__";'),
    'tdoc-bundle must replace the TDOC_BUILD_INFO declaration');
  assert(publish.includes('bin/tdoc-bundle'), 'tdoc-publish must call tdoc-bundle');
});

t('publish redeploys by stored content hash, not mtimes', () => {
  assert(publish.includes('worker_bundle_sha256'), 'cloudflare publish must persist worker_bundle_sha256');
  assert(publish.includes('vercel_bundle_sha256'), 'vercel publish must persist vercel_bundle_sha256');
  assert(publish.includes('worker_bundle_sha()'), 'cloudflare publish must compute desired content hash');
  assert(publish.includes('vercel_bundle_sha()'), 'vercel publish must compute desired content hash');
  assert(publish.includes('DESIRED_BUNDLE_SHA') && publish.includes('DEPLOYED_BUNDLE_SHA'),
    'publish must compare desired hash to deployed hash');
  assert(!publish.includes('server/overlay.js" -nt "$BUNDLED"'),
    'mtime-based overlay redeploy check must not come back');
  assert(!publish.includes('worker/worker.js" -nt "$BUNDLED"'),
    'mtime-based worker redeploy check must not come back');
  assert(!publish.includes('find "$SKILL_DIR/vercel" -type f -newer "$BUNDLED"'),
    'mtime-based Vercel template redeploy check must not come back');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
