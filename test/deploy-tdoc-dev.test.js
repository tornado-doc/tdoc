// tdoc.dev hosted-runtime CD guards.
//
// Product split: merge to main may deploy the ONE Worker we operate (tdoc.dev).
// It must never look like a rollout to BYOK publishers, must not run on pull
// requests (forks), and must not rotate TDOC_UPLOAD_TOKEN.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const wf = fs.readFileSync(path.join(root, '.github/workflows/deploy-tdoc-dev.yml'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'bin/tdoc-bundle'), 'utf8');
const publish = fs.readFileSync(path.join(root, 'bin/tdoc-publish'), 'utf8');

console.log('tdoc.dev CD');

t('workflow is main-push + manual only — never pull_request', () => {
  assert(/branches:\s*\[main\]/.test(wf), 'must deploy from main');
  assert(wf.includes('workflow_dispatch:'), 'must allow a manual re-run');
  assert(!/^\s*pull_request:/m.test(wf), 'must not deploy on pull_request');
});

t('workflow is scoped to tornado-doc/tdoc, not forks or BYOK workers', () => {
  assert(wf.includes("github.repository == 'tornado-doc/tdoc'"),
    'must refuse to run on a fork of the repo');
  assert(wf.includes('tdoc.dev'), 'comments/name must make the hosted target explicit');
  assert(!wf.includes('workers.dev'), 'must not target a generic workers.dev hostname');
});

t('wrangler-action is pinned to a commit SHA, not a mutable tag', () => {
  assert(wf.includes('cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0'),
    'wrangler-action must be SHA-pinned (same policy as test.yml)');
  assert(!/wrangler-action@v\d/.test(wf), 'must not use a floating wrangler-action tag');
});

t('credentials come from GitHub secrets, not the repo or published.json', () => {
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'TDOC_DEV_KV_ID', 'TDOC_DEV_OWNER']) {
    assert(wf.includes('${{ secrets.' + name + ' }}'), `must read ${name} from secrets`);
  }
  assert(!wf.includes('.upload_token'), 'must not read ~/.tdoc/published.json upload_token');
  assert(!/wrangler secret put/.test(wf), 'must not rotate TDOC_UPLOAD_TOKEN on CD');
  assert(!/^\s*secrets:/m.test(wf.split('uses: cloudflare/wrangler-action')[1] || ''),
    'wrangler-action must not bind Worker secrets on every deploy');
});

t('CD bundles overlay via bin/tdoc-bundle with hosted provenance', () => {
  assert(wf.includes('node bin/tdoc-bundle'), 'workflow must call bin/tdoc-bundle');
  assert(wf.includes('TDOC_GENERATED_BY: tdoc-cd'), 'hosted deploys must label generated_by=tdoc-cd');
  assert(bundle.includes('JSON.stringify(overlay)'), 'tdoc-bundle must inline overlay.js');
  assert(bundle.includes('generated_by'), 'tdoc-bundle must stamp provenance');
});

t('tdoc-publish reuses tdoc-bundle (no second copy of the inliner)', () => {
  assert(publish.includes('bin/tdoc-bundle'), 'publish must call bin/tdoc-bundle');
  assert(!publish.includes('JSON.stringify(overlay)'),
    'the overlay inliner must not remain copy-pasted inside tdoc-publish');
});

t('CD Node matches the pinned wrangler engine (>=22)', () => {
  const node = wf.match(/node-version:\s*'(\d+)'/);
  assert(node, 'workflow must pin a Node major');
  assert(Number(node[1]) >= 22,
    `wrangler 4.90.1 requires Node >= 22; first CD run died on Node ${node[1]}`);
  assert(/wranglerVersion:\s*'4\.90\.1'/.test(wf),
    'keep wranglerVersion and the Node pin in lockstep');
});

t('placeholder guard matches active declarations, not leftover comments', () => {
  assert(wf.includes('const OVERLAY_JS = `__TDOC_OVERLAY_JS__`;'),
    'overlay guard must match the live declaration, not any comment mention');
  assert(wf.includes('const TDOC_BUILD_INFO = "__TDOC_BUILD_INFO__";'),
    'build-info guard must match the live declaration, not any comment mention');
  assert(wf.includes('test -f worker/_worker.bundled.js'),
    'guard must fail if the bundle file is missing');
});

t('tdoc-bundle replaces the live placeholders', () => {
  const { spawnSync } = require('child_process');
  const outDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tdoc-bundle-'));
  const r = spawnSync(process.execPath, [path.join(root, 'bin/tdoc-bundle')], {
    env: { ...process.env, SKILL_DIR: root, OUT_DIR: outDir, TDOC_GENERATED_BY: 'test' },
    encoding: 'utf8',
  });
  assert(r.status === 0, `tdoc-bundle failed: ${r.stderr || r.stdout}`);
  const bundled = fs.readFileSync(path.join(outDir, '_worker.bundled.js'), 'utf8');
  assert(!bundled.includes('const OVERLAY_JS = `__TDOC_OVERLAY_JS__`;'),
    'bundled worker still has the overlay placeholder declaration');
  assert(!bundled.includes('const TDOC_BUILD_INFO = "__TDOC_BUILD_INFO__";'),
    'bundled worker still has the build-info placeholder declaration');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
