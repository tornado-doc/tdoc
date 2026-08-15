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
  for (const f of ['tdoc-publish', 'tdoc-pull', 'tdoc-doctor', 'tdoc-agent-reply']) {
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

t('tdoc-new fails loudly if the local server never comes up', () => {
  const src = readBin('tdoc-new');
  assert(/SERVER_UP/.test(src) && /failed to start/.test(src),
    'ping-loop success is not checked');
});

// ---- live behavior: --force must not destroy an existing doc on bad input ----
t('tdoc-new --force preserves the existing doc when new HTML is INVALID [the bug]', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-cli-'));
  try {
    const env = { ...process.env, TDOC_DIR: dir, TDOC_PORT: '0', TDOC_SKIP_UPDATE_CHECK: '1' };
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
  const env = { ...process.env, TDOC_DIR: '/tmp/tdoc-slugtest-nonexistent', HOME: '/tmp/tdoc-slugtest-home', TDOC_SKIP_UPDATE_CHECK: '1' };
  const bad = ['../private', 'a/../b', 'UPPER', 'has space', 'trailing-', '-leading', 'with/slash'];
  for (const cli of ['tdoc-publish', 'tdoc-pull', 'tdoc-unpublish']) {
    for (const slug of bad) {
      const r = spawnSync(path.join(BIN, cli), [slug], { env, encoding: 'utf8', timeout: 15000 });
      assert(r.status !== 0, `${cli} accepted bad slug '${slug}' (exit 0)`);
      assert(/invalid slug/i.test(r.stderr || ''), `${cli} '${slug}': expected 'invalid slug' rejection, got stderr: ${r.stderr}`);
    }
  }
});

t('tdoc-agent-reply --print-identity detects host runtime from env', () => {
  const bin = path.join(BIN, 'tdoc-agent-reply');
  const base = { ...process.env, HOME: '/tmp/tdoc-no-home-' + Date.now() };
  for (const k of Object.keys(base)) {
    if (/^(GROK_|CLAUDE_|CLAUDECODE$|CODEX_|CURSOR_|COMPOSER_|GEMINI_|XAI_|TDOC_AGENT_)/.test(k)) delete base[k];
  }
  const run = (extra) => spawnSync(bin, ['--print-identity'], {
    env: { ...base, ...extra }, encoding: 'utf8', timeout: 10000,
  });
  const grok = run({ GROK_SESSION_ID: 'sess' });
  assert(grok.status === 0, `grok exit ${grok.status} ${grok.stderr}`);
  assert(/"login":"grok"/.test(grok.stdout) && /"name":"Grok"/.test(grok.stdout), grok.stdout);

  const claude = run({ CLAUDE_SESSION_ID: 'sess' });
  assert(/"login":"claude"/.test(claude.stdout), claude.stdout);

  const codex = run({ CODEX_CLI: '1' });
  assert(/"login":"codex"/.test(codex.stdout), codex.stdout);

  const empty = run({});
  assert(/"login":"tdoc-agent"/.test(empty.stdout), empty.stdout);

  const override = spawnSync(bin, ['--print-identity', '--login', 'claude'], {
    env: { ...base, GROK_SESSION_ID: 'sess' }, encoding: 'utf8', timeout: 10000,
  });
  assert(/"login":"claude"/.test(override.stdout), `explicit --login should win: ${override.stdout}`);
});

t('publish accepts a valid kebab-case slug (passes validation, fails later on missing doc)', () => {
  const env = { ...process.env, TDOC_DIR: '/tmp/tdoc-slugtest-nonexistent', TDOC_SKIP_UPDATE_CHECK: '1' };
  const r = spawnSync(path.join(BIN, 'tdoc-publish'), ['valid-slug-123'], { env, encoding: 'utf8', timeout: 15000 });
  // It should get PAST slug validation (no 'invalid slug') and fail on the
  // missing doc instead — proving valid slugs aren't over-rejected.
  assert(!/invalid slug/i.test(r.stderr || ''), `valid slug was wrongly rejected: ${r.stderr}`);
});

t('user-facing CLIs invoke tdoc-update-nag', () => {
  for (const f of ['tdoc-publish', 'tdoc-pull', 'tdoc-unpublish', 'tdoc-new', 'tdoc-doctor']) {
    const src = readBin(f);
    assert(/tdoc-update-nag/.test(src), `${f} must call tdoc-update-nag so BYOK users see origin/main drift`);
  }
  assert(!/tdoc-update-nag/.test(readBin('tdoc-update')),
    'tdoc-update must not nag (it IS the update)');
});

t('tdoc-update-nag is silent when skipped or current (mock: skip)', () => {
  const nag = path.join(BIN, 'tdoc-update-nag');
  const r = spawnSync(nag, [], { env: { ...process.env, TDOC_SKIP_UPDATE_CHECK: '1' }, encoding: 'utf8' });
  assert(r.status === 0, `skip path must exit 0, got ${r.status}`);
  assert(!r.stdout, `skip path must be silent on stdout, got: ${r.stdout}`);
  assert(!r.stderr, `skip path must be silent on stderr, got: ${r.stderr}`);
});

t('tdoc-update-nag prints TDOC_UPDATE_AVAILABLE when behind (mock)', () => {
  const nag = path.join(BIN, 'tdoc-update-nag');
  const r = spawnSync(nag, [], { env: { ...process.env, TDOC_MOCK_UPDATE_BEHIND: '3' }, encoding: 'utf8' });
  assert(r.status === 0, `behind path must exit 0, got ${r.status}`);
  assert(/TDOC_UPDATE_AVAILABLE: 3/.test(r.stdout), `stdout machine line missing: ${r.stdout}`);
  assert(/tdoc-update --yes/.test(r.stderr), `stderr must encourage tdoc-update --yes, got: ${r.stderr}`);
  assert(/3 newer commit/.test(r.stderr), `stderr must mention commit count, got: ${r.stderr}`);
});

t('tdoc-update-nag --json is parseable and used by doctor', () => {
  const nag = path.join(BIN, 'tdoc-update-nag');
  const r = spawnSync(nag, ['--json'], { env: { ...process.env, TDOC_MOCK_UPDATE_BEHIND: '2' }, encoding: 'utf8' });
  assert(r.status === 0, `json path must exit 0, got ${r.status}`);
  const j = JSON.parse(r.stdout);
  assert(j.ok === false && j.behind === 2 && j.checked === true, `json body: ${r.stdout}`);
  assert(/tdoc-update --yes/.test(j.cmd), `cmd should be tdoc-update --yes: ${j.cmd}`);
});

t('tdoc-update-nag diverged mock does not tell the user to --yes', () => {
  const nag = path.join(BIN, 'tdoc-update-nag');
  const r = spawnSync(nag, [], { env: { ...process.env, TDOC_MOCK_UPDATE_DIVERGED: '1' }, encoding: 'utf8' });
  assert(r.status === 0);
  assert(/TDOC_UPDATE_DIVERGED/.test(r.stdout), `stdout: ${r.stdout}`);
  assert(/cannot fast-forward/.test(r.stderr), `stderr: ${r.stderr}`);
  assert(!/--yes/.test(r.stderr), 'diverged nag must not recommend --yes');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
