// CLI resilience tests (Batch D). Drives the real bash scripts in a hermetic
// temp TDOC_DIR. Node test runner so it joins the same `npm test` suite.
//
// Covers:
//   - tdoc-new-force-destroys-before-validate (P2): --force must NOT destroy an
//     existing doc when the replacement HTML is invalid (stage-validate-swap)
//   - cli-curl-no-timeout (P2): every curl carries --max-time (static check)
//   - cli-cf-api-no-http-status-check (P2): cf_api helper exists + gates status
//   - published.json validation, partial-version abort, ping-loop (static)
//
// Run with: node test/cli.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const BIN = path.join(__dirname, '..', 'bin');
const readBin = (f) => fs.readFileSync(path.join(BIN, f), 'utf8');

console.log('cli (Batch D resilience)');

// ---- static checks across all CLIs ----
t('every curl call carries --max-time (no unbounded hang)', () => {
  for (const f of ['tdoc-publish', 'tdoc-pull', 'tdoc-doctor']) {
    const src = readBin(f);
    const curls = src.split('\n').filter(l => /\bcurl\b/.test(l) && !l.trim().startsWith('#'));
    for (const line of curls) {
      assert(/--max-time/.test(line), `${f}: curl without --max-time:\n      ${line.trim()}`);
    }
  }
});

t('tdoc-publish has a cf_api helper that checks HTTP status', () => {
  const src = readBin('tdoc-publish');
  assert(/cf_api\(\)/.test(src), 'cf_api helper missing');
  assert(/http_code/.test(src) && /grep -qE '\^2/.test(src), 'cf_api does not gate on 2xx HTTP status');
});

t('tdoc-publish validates published.json fields (no null host/token)', () => {
  const src = readBin('tdoc-publish');
  assert(/= "null"/.test(src) && /Delete it and re-run/.test(src),
    'published.json null-field validation missing');
});

t('tdoc-publish does not let an older-version failure abort the latest', () => {
  const src = readBin('tdoc-publish');
  assert(/OLDER_FAILED/.test(src), 'older-version best-effort handling missing');
  assert(/FATAL: latest version/.test(src), 'latest-version hard-fail missing');
});

t('tdoc-publish exposes hosted as a no-user-deploy platform', () => {
  const src = readBin('tdoc-publish');
  assert(/cloudflare\|vercel\|hosted/.test(src), 'usage does not include hosted platform');
  assert(/first_time_setup_hosted\(\)/.test(src), 'hosted setup function missing');
  assert(/\/api\/hosted\/token/.test(src), 'hosted setup does not request a provider-issued token');
  assert(!/TDOC_HOSTED_UPLOAD_TOKEN/.test(src), 'hosted setup must not require an out-of-band upload token');
  assert(/TDOC_HOSTED_BASE:-https:\/\/tdoc\.dev/.test(src), 'hosted setup does not default to tdoc.dev');
  assert(/platform": "hosted"/.test(src), 'hosted setup does not persist hosted platform');
  assert(/"account_id": "\$account_id"/.test(src), 'hosted setup does not persist account_id');
  assert(/if \[ "\$PLATFORM" = "hosted" \]/.test(src), 'hosted platform branch missing');
  assert(/UPLOAD_BASE="\$BASE"/.test(src), 'hosted branch should upload to configured base');
  assert(/PUBLIC_BASE="\$BASE"/.test(src), 'hosted branch should emit configured hosted base links');
  assert(/hosted_registration_disabled/.test(src),
    'hosted setup should explain disabled provider registration');
});

t('pull/unpublish read hosted base from published.json', () => {
  for (const f of ['tdoc-pull', 'tdoc-unpublish']) {
    const src = readBin(f);
    assert(/PLATFORM="\$\(jq -r '\.platform \/\/ "cloudflare"'/.test(src), `${f}: platform detection missing`);
    assert(/"\$PLATFORM" = "hosted"/.test(src), `${f}: hosted platform branch missing`);
    assert(/BASE="\$\(jq -r '\.base \/\/ empty'/.test(src), `${f}: hosted/vercel branch should read .base`);
  }
});

t('tdoc-new fails loudly if the local server never comes up', () => {
  const src = readBin('tdoc-new');
  assert(/SERVER_UP/.test(src) && /failed to start/.test(src),
    'ping-loop success is not checked');
});

// ---- live behavior: --force must not destroy an existing doc on bad input ----
t('tdoc-new --force preserves the existing doc when new HTML is INVALID [the bug]', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-cli-'));
  try {
    const env = { ...process.env, TDOC_DIR: dir, TDOC_PORT: '0' };
    // seed an existing doc with a real comment we must not lose
    const docDir = path.join(dir, 'mydoc');
    fs.mkdirSync(path.join(docDir, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(docDir, 'v1', 'index.html'), '<!doctype html><body>ORIGINAL</body>');
    fs.writeFileSync(path.join(docDir, 'meta.json'), JSON.stringify({ slug: 'mydoc', versions: [{ n: 1 }] }));
    fs.writeFileSync(path.join(docDir, 'comments.json'), JSON.stringify([{ id: 'c1', text: 'precious' }]));

    // run --force with MARKDOWN (no <body>) on stdin → must be rejected
    const r = spawnSync(path.join(BIN, 'tdoc-new'),
      ['--slug', 'mydoc', '--title', 'x', '--html-stdin', '--force'],
      { input: '# just markdown, no body tag', env, encoding: 'utf8', timeout: 20000 });

    assert(r.status !== 0, 'tdoc-new should have FAILED on markdown input');
    // the original doc + comment must still be intact
    const html = fs.readFileSync(path.join(docDir, 'v1', 'index.html'), 'utf8');
    assert(/ORIGINAL/.test(html), 'original HTML was destroyed by --force on invalid input!');
    const comments = JSON.parse(fs.readFileSync(path.join(docDir, 'comments.json'), 'utf8'));
    assert(comments[0] && comments[0].text === 'precious', 'comments were destroyed!');
    // and no stray stage dirs left behind
    const stray = fs.readdirSync(dir).filter(n => n.startsWith('.stage-'));
    assert(stray.length === 0, `stage dir not cleaned up: ${stray}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- slug validation (audit: path traversal via unvalidated slug) ----
// tdoc-publish/pull/unpublish used $SLUG in filesystem paths and curl URLs
// without validation, so a `..` slug escaped TDOC_DIR. Each must now reject a
// non-kebab-case slug BEFORE any side effect.
t('publish/pull/unpublish reject traversal + non-kebab slugs', () => {
  const env = { ...process.env, TDOC_DIR: '/tmp/tdoc-slugtest-nonexistent', HOME: '/tmp/tdoc-slugtest-home' };
  const bad = ['../private', 'a/../b', 'UPPER', 'has space', 'trailing-', '-leading', 'with/slash'];
  for (const cli of ['tdoc-publish', 'tdoc-pull', 'tdoc-unpublish']) {
    for (const slug of bad) {
      const r = spawnSync(path.join(BIN, cli), [slug], { env, encoding: 'utf8', timeout: 15000 });
      assert(r.status !== 0, `${cli} accepted bad slug '${slug}' (exit 0)`);
      assert(/invalid slug/i.test(r.stderr || ''), `${cli} '${slug}': expected 'invalid slug' rejection, got stderr: ${r.stderr}`);
    }
  }
});

t('publish accepts a valid kebab-case slug (passes validation, fails later on missing doc)', () => {
  const env = { ...process.env, TDOC_DIR: '/tmp/tdoc-slugtest-nonexistent' };
  const r = spawnSync(path.join(BIN, 'tdoc-publish'), ['valid-slug-123'], { env, encoding: 'utf8', timeout: 15000 });
  // It should get PAST slug validation (no 'invalid slug') and fail on the
  // missing doc instead — proving valid slugs aren't over-rejected.
  assert(!/invalid slug/i.test(r.stderr || ''), `valid slug was wrongly rejected: ${r.stderr}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
