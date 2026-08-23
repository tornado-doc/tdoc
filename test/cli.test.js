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
const { execFileSync, spawn, spawnSync } = require('child_process');

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
    // Actual invocations only: `curl` followed by a flag, a quote or a $var.
    // A bare substring match also hit `curl_ok`, `command -v curl`, and the
    // literal "brew install curl" inside a missing_steps entry — none of which
    // issue a request, so none of which can hang.
    const curls = src.split('\n').filter(l => /\bcurl\s+(-|["'$])/.test(l)
      && !l.trim().startsWith('#'));
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

t('tdoc-publish defaults to hosted and treats Cloudflare/Vercel as self-host flags', () => {
  const src = readBin('tdoc-publish');
  assert(/hosted\|cloudflare\|vercel/.test(src), 'usage does not include hosted platform');
  assert(/PLATFORM_FLAG:-hosted/.test(src), 'first publish must default to hosted');
  assert(/first_time_setup_hosted\(\)/.test(src), 'hosted setup function missing');
  assert(/\/api\/hosted\/token/.test(src), 'hosted setup does not request a provider-issued token');
  assert(/\/api\/auth\/device\/start/.test(src), 'hosted setup must GitHub-device-flow before minting a token');
  assert(/sign_in_required/.test(src), 'hosted setup must handle a missing GitHub session');
  assert(!/TDOC_HOSTED_UPLOAD_TOKEN/.test(src), 'hosted setup must not require an out-of-band upload token');
  assert(/TDOC_HOSTED_BASE:-https:\/\/tdoc\.dev/.test(src), 'hosted setup does not default to tdoc.dev');
  assert(/platform: "hosted"/.test(src), 'hosted setup does not persist hosted platform');
  assert(/github_login: gh/.test(src), 'hosted setup does not persist github_login');
  assert(/account_id: acct/.test(src), 'hosted setup does not persist account_id');
  assert(/if \[ "\$PLATFORM" = "hosted" \]/.test(src), 'hosted platform branch missing');
  assert(/UPLOAD_BASE="\$BASE"/.test(src), 'hosted branch should upload to configured base');
  assert(/PUBLIC_BASE="\$BASE"/.test(src), 'hosted branch should emit configured hosted base links');
  assert(/hosted_registration_disabled/.test(src),
    'hosted setup should detect closed provider registration');
  assert(/--platform cloudflare/.test(src) && /--platform vercel/.test(src),
    'closed hosted signup must point at --platform cloudflare|vercel');
  assert(!/enable TDOC_HOSTED_REGISTRATION/.test(src),
    'CLI must not tell users to flip TDOC_HOSTED_REGISTRATION on tdoc.dev');
  assert(/platform:"cloudflare"/.test(src),
    'cloudflare setup must persist platform:"cloudflare"');
  assert(/switching publish platform/.test(src),
    'conflicting --platform must switch (rewrite config), not ignore');
  assert(!/ignoring '--platform/.test(src),
    'must not swallow a conflicting --platform flag');
  assert(/published\.json\.bak\.switch/.test(src),
    'platform switch must keep a previous-config backup');
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

t('chat-driven new and edit flows require host validation', () => {
  const rootSkill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const packagedSkill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'tdoc', 'SKILL.md'), 'utf8');
  assert(rootSkill === packagedSkill, 'root and packaged SKILL.md copies must stay identical');
  assert(/mandatory[\s\S]*tdoc-validate-template[\s\S]*do not open,\s*publish, or report/.test(rootSkill),
    '/tdoc new must validate before completion');
  assert(/Validate `v<n\+1>\/index\.html`[\s\S]*tdoc-validate-template[\s\S]*never publish or report a broken version/.test(rootSkill),
    '/tdoc edit must validate every generated version');
});

t('tdoc default-template validator accepts scoped widget CSS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-template-'));
  try {
    const html = path.join(dir, 'valid.html');
    fs.writeFileSync(html, `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background: #fff; } .cost-widget { display:grid } .cost-widget p { color:#333 }</style>
      </head><body><div class="wrap"><h1>Title</h1><div class="cost-widget"><p>x</p></div></div></body></html>`);
    const r = spawnSync(path.join(BIN, 'tdoc-validate-template'), [html], { encoding: 'utf8' });
    assert(r.status === 0, `valid default-template HTML rejected: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('tdoc default-template validator rejects global restyling by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-template-'));
  try {
    const html = path.join(dir, 'custom.html');
    fs.writeFileSync(html, `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background: #fff; } h1 { font-size:72px } .wrap { max-width:1200px }</style>
      </head><body><div class="wrap"><h1>Title</h1></div></body></html>`);
    const rejected = spawnSync(path.join(BIN, 'tdoc-validate-template'), [html], { encoding: 'utf8' });
    assert(rejected.status !== 0, 'global h1/.wrap restyling should be rejected');
    assert(/default template/i.test(rejected.stderr), rejected.stderr);
    const explicit = spawnSync(path.join(BIN, 'tdoc-validate-template'), [html, '--custom-template'], { encoding: 'utf8' });
    assert(explicit.status === 0, `explicit custom template should pass: ${explicit.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('tdoc host validator rejects inert JavaScript even for a custom template', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-host-js-'));
  try {
    const html = path.join(dir, 'broken.html');
    fs.writeFileSync(html, `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background:#fff }</style></head>
      <body><div class="wrap"><button onclick="go()">Run</button>
      <a href="javascript:go()">again</a><canvas></canvas><script>go()</script></div></body></html>`);
    const r = spawnSync(path.join(BIN, 'tdoc-validate-template'),
      [html, '--custom-template'], { encoding: 'utf8' });
    assert(r.status !== 0, 'custom-template must not make host JavaScript executable');
    assert(/host <script> is inert/.test(r.stderr), r.stderr);
    assert(/event handlers are inert/.test(r.stderr), r.stderr);
    assert(/javascript: URLs are inert/.test(r.stderr), r.stderr);
    assert(/host <canvas> cannot render/.test(r.stderr), r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('tdoc host validator accepts the named editorial house-style background', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-style-'));
  try {
    const html = path.join(dir, 'editorial.html');
    fs.writeFileSync(html, `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background:#f7f6f5 } .wrap { font-family:Georgia,serif; color:#000 }</style>
      </head><body><div class="wrap"><h1>Title</h1></div></body></html>`);
    const wrong = spawnSync(path.join(BIN, 'tdoc-validate-template'), [html], { encoding: 'utf8' });
    assert(wrong.status !== 0, 'editorial background should not pass as default');
    const right = spawnSync(path.join(BIN, 'tdoc-validate-template'),
      [html, '--style', 'editorial'], { encoding: 'utf8' });
    assert(right.status === 0, right.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('tdoc-new copies sandboxed widget files while keeping host HTML script-free', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-widget-new-'));
  try {
    const fakeBin = path.join(dir, 'fake-bin');
    const widgets = path.join(dir, 'widgets');
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(widgets);
    const fakeCurl = path.join(fakeBin, 'curl');
    fs.writeFileSync(fakeCurl, '#!/bin/sh\nprintf \'{"service":"tdoc"}\'\n');
    fs.chmodSync(fakeCurl, 0o755);
    fs.writeFileSync(path.join(widgets, 'calculator.html'),
      '<!doctype html><html><body><output id="x"></output><script>document.querySelector("#x").textContent="ok"</script></body></html>');
    const host = `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background:#fff }</style></head><body><div class="wrap">
      <h1>Calculator</h1><iframe sandbox="allow-scripts" src="/d/widget-doc/v/1/widget/calculator"></iframe>
      </div></body></html>`;
    const env = { ...process.env, HOME: dir, TDOC_DIR: path.join(dir, 'tdocs'),
      PATH: `${fakeBin}:${process.env.PATH}` };
    const r = spawnSync(path.join(BIN, 'tdoc-new'),
      ['--slug', 'widget-doc', '--title', 'Widget', '--html-stdin', '--widgets-dir', widgets, '--quiet'],
      { input: host, env, encoding: 'utf8', timeout: 20000 });
    assert(r.status === 0, `tdoc-new widget handoff failed (exit ${r.status})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const copied = fs.readFileSync(path.join(dir, 'tdocs', 'widget-doc', 'v1', 'widgets', 'calculator.html'), 'utf8');
    assert(copied.includes('<script>'), 'widget JavaScript was not preserved in the island file');
    const savedHost = fs.readFileSync(path.join(dir, 'tdocs', 'widget-doc', 'v1', 'index.html'), 'utf8');
    assert(!savedHost.includes('<script>'), 'host unexpectedly gained JavaScript');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('tdoc-new validates the default template before replacing an existing doc', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-cli-'));
  try {
    const env = { ...process.env, TDOC_DIR: dir, TDOC_PORT: '0' };
    const docDir = path.join(dir, 'mydoc');
    fs.mkdirSync(path.join(docDir, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(docDir, 'v1', 'index.html'), '<!doctype html><body>ORIGINAL</body>');
    fs.writeFileSync(path.join(docDir, 'meta.json'), JSON.stringify({ slug: 'mydoc', versions: [{ n: 1 }] }));
    fs.writeFileSync(path.join(docDir, 'comments.json'), JSON.stringify([{ id: 'c1', text: 'precious' }]));
    const custom = `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background:#fff } h1 { font-size:72px }</style>
      </head><body><div class="wrap"><h1>Custom</h1></div></body></html>`;
    const r = spawnSync(path.join(BIN, 'tdoc-new'),
      ['--slug', 'mydoc', '--title', 'x', '--html-stdin', '--force'],
      { input: custom, env, encoding: 'utf8', timeout: 20000 });
    assert(r.status !== 0 && /default-template validation failed/i.test(r.stderr), r.stderr);
    assert(/ORIGINAL/.test(fs.readFileSync(path.join(docDir, 'v1', 'index.html'), 'utf8')),
      'existing doc was replaced before template validation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

t('tdoc-update-nag --json is parseable', () => {
  const nag = path.join(BIN, 'tdoc-update-nag');
  const r = spawnSync(nag, ['--json'], { env: { ...process.env, TDOC_MOCK_UPDATE_BEHIND: '2' }, encoding: 'utf8' });
  assert(r.status === 0, `json path must exit 0, got ${r.status}`);
  const j = JSON.parse(r.stdout);
  assert(j.ok === false && j.behind === 2 && j.checked === true, `json body: ${r.stdout}`);
  assert(/tdoc-update --yes/.test(j.cmd), `cmd should be tdoc-update --yes: ${j.cmd}`);
});

t('tdoc-doctor surfaces .update from nag --json (stdout stays parseable)', () => {
  const doctor = path.join(BIN, 'tdoc-doctor');
  const r = spawnSync(doctor, [], {
    env: {
      ...process.env,
      TDOC_MOCK_UPDATE_BEHIND: '2',
      TDOC_MOCK_NO_WRANGLER: '1',
      TDOC_MOCK_NO_GH: '1',
      TDOC_MOCK_NOT_PUBLISHED: '1',
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert(r.status === 0, `doctor must exit 0, got ${r.status}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert(j.update && j.update.ok === false && j.update.behind === 2, `update: ${JSON.stringify(j.update)}`);
  assert(Array.isArray(j.missing_steps), 'rest of doctor JSON must still be valid');
  assert(!j.missing_steps.some((s) => s.id === 'update'), '.update is not a missing_step');
});

t('tdoc-update-nag diverged mock does not tell the user to --yes', () => {
  const nag = path.join(BIN, 'tdoc-update-nag');
  const r = spawnSync(nag, [], { env: { ...process.env, TDOC_MOCK_UPDATE_DIVERGED: '1' }, encoding: 'utf8' });
  assert(r.status === 0);
  assert(/TDOC_UPDATE_DIVERGED/.test(r.stdout), `stdout: ${r.stdout}`);
  assert(/cannot fast-forward/.test(r.stderr), `stderr: ${r.stderr}`);
  assert(/re-clone from scratch/.test(r.stderr), `stderr: ${r.stderr}`);
  assert(!/--yes/.test(r.stderr), 'diverged nag must not recommend --yes');
  assert(!/rm -rf/.test(r.stderr + r.stdout), 'diverged nag must not print a destroy/re-clone command');
});

t('tdoc-new --help/--quiet stay silent; otherwise nag stays off stdout', () => {
  const bin = path.join(BIN, 'tdoc-new');
  const env = { ...process.env, TDOC_MOCK_UPDATE_BEHIND: '3' };
  const help = spawnSync(bin, ['--help'], { env, encoding: 'utf8' });
  assert(help.status === 0);
  assert(!/TDOC_UPDATE|newer commit/.test(help.stdout + help.stderr), `help leaked nag: ${help.stdout}${help.stderr}`);
  const quiet = spawnSync(bin, ['--quiet'], { env, encoding: 'utf8' });
  assert(!/TDOC_UPDATE|newer commit/.test(quiet.stdout + quiet.stderr), `quiet leaked nag: ${quiet.stdout}${quiet.stderr}`);
  const noisy = spawnSync(bin, [], { env, encoding: 'utf8' });
  assert(/newer commit/.test(noisy.stderr), `stderr must nag: ${noisy.stderr}`);
  assert(!/TDOC_UPDATE_AVAILABLE/.test(noisy.stdout), `stdout must stay URL-only, got: ${noisy.stdout}`);
});

function gitIn(cwd, args) {
  return execFileSync('git', [
    '-c', 'commit.gpgsign=false',
    '-c', 'user.name=tdoc-test',
    '-c', 'user.email=tdoc-test@example.com',
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function commitFile(cwd, name, contents, msg) {
  fs.writeFileSync(path.join(cwd, name), contents);
  gitIn(cwd, ['add', name]);
  gitIn(cwd, ['commit', '-m', msg]);
}

// Real git graph (not TDOC_MOCK_*): copy nag into a throwaway checkout so
// `dirname $0/..` is the fixture, then fetch against a local bare origin.
function makeNagRepo(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-nag-'));
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fs.mkdirSync(work);
  gitIn(work, ['init', '-b', 'main']);
  commitFile(work, 'README', 'base\n', 'base');
  gitIn(work, ['remote', 'add', 'origin', bare]);
  gitIn(work, ['push', '-u', 'origin', 'main']);
  if (kind === 'ahead' || kind === 'diverged') {
    commitFile(work, 'feat', 'ahead\n', 'ahead');
  }
  if (kind === 'behind' || kind === 'diverged') {
    const other = path.join(root, 'other');
    gitIn(root, ['clone', bare, other]);
    commitFile(other, 'mainline', 'on main\n', 'on main');
    gitIn(other, ['push', 'origin', 'main']);
  }
  const binDir = path.join(work, 'bin');
  fs.mkdirSync(binDir);
  const nag = path.join(binDir, 'tdoc-update-nag');
  fs.copyFileSync(path.join(BIN, 'tdoc-update-nag'), nag);
  fs.chmodSync(nag, 0o755);
  return { root, nag };
}

t('tdoc-update-nag real git: ahead-only is silent, behind nags, both diverge', () => {
  const cases = [
    { kind: 'ahead', want: 'silent' },
    { kind: 'behind', want: 'available' },
    { kind: 'diverged', want: 'diverged' },
  ];
  for (const { kind, want } of cases) {
    const { root, nag } = makeNagRepo(kind);
    try {
      const r = spawnSync(nag, [], { encoding: 'utf8', timeout: 15000 });
      assert(r.status === 0, `${kind}: exit ${r.status} stderr=${r.stderr}`);
      if (want === 'silent') {
        assert(!r.stdout, `${kind} stdout: ${r.stdout}`);
        assert(!r.stderr, `${kind} stderr: ${r.stderr}`);
      } else if (want === 'available') {
        assert(/TDOC_UPDATE_AVAILABLE/.test(r.stdout), `${kind} stdout: ${r.stdout}`);
        assert(/tdoc-update --yes/.test(r.stderr), `${kind} stderr: ${r.stderr}`);
        assert(!/DIVERGED/.test(r.stdout));
      } else {
        assert(/TDOC_UPDATE_DIVERGED/.test(r.stdout), `${kind} stdout: ${r.stdout}`);
        assert(/cannot fast-forward/.test(r.stderr), `${kind} stderr: ${r.stderr}`);
        assert(!/--yes/.test(r.stderr));
        assert(!/rm -rf/.test(r.stderr + r.stdout));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

// ---- tdoc-agent-reply must not report success on a rejected reply (#141) ----

t('tdoc-agent-reply gates on HTTP status and on 200-with-error bodies', () => {
  const src = readBin('tdoc-agent-reply');
  assert(/post_reply\(\)/.test(src), 'post_reply helper missing');
  assert(/http_code/.test(src) && /grep -qE '\^2/.test(src),
    'post_reply does not gate on 2xx HTTP status');
  assert(/has\("error"\)/.test(src),
    'post_reply does not reject a 200 body carrying an "error" key');
  // Both transports must go through the helper and propagate its failure.
  const calls = src.split('\n').filter(l => /^\s*post_reply /.test(l));
  assert(calls.length === 2, `expected 2 post_reply call sites, got ${calls.length}`);
  for (const c of calls) assert(/\|\| exit 1/.test(c), `call site swallows failure: ${c.trim()}`);
  // No raw curl POST to the reply endpoint left outside the helper.
  const raw = src.split('\n').filter(l =>
    /\bcurl\b/.test(l) && /api\/agent\/reply/.test(l) && !l.trim().startsWith('#'));
  assert(raw.length === 0, `raw curl to /api/agent/reply outside post_reply:\n      ${raw.join('\n      ')}`);
});

t('tdoc-agent-reply exits non-zero when the server rejects the reply', () => {
  const bin = path.join(BIN, 'tdoc-agent-reply');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-reply-home-'));
  const port = 7900 + Math.floor(Math.random() * 300);
  // Stub the reply endpoint: 200 with an error body, exactly what the server
  // returns for an unknown parent. That is the case the bug reported.
  const stub = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>{` +
    `s.writeHead(200,{'content-type':'application/json'});` +
    `s.end(JSON.stringify({error:'parent_not_found'}));` +
    `}).listen(${port},'127.0.0.1');`], { stdio: 'ignore' });
  try {
    const up = spawnSync('bash', ['-c',
      `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 ` +
      `-X POST http://127.0.0.1:${port}/ping && exit 0; sleep 0.05; done; exit 1`],
      { encoding: 'utf8', timeout: 15000 });
    assert(up.status === 0, 'stub server never came up');

    const r = spawnSync(bin, ['--slug', 'tornado-doc', '--parent', 'c_missing',
      '--text', 'applied', '--status', 'applied'], {
      env: { ...process.env, HOME: home, TDOC_PORT: String(port) },
      encoding: 'utf8', timeout: 20000,
    });
    assert(r.status !== 0,
      `rejected reply still exited ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/parent_not_found/.test(r.stdout + r.stderr),
      `server error not surfaced: ${r.stdout} ${r.stderr}`);
    assert(/NOT posted/.test(r.stderr), `no failure line on stderr: ${r.stderr}`);
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('tdoc-agent-reply still exits 0 when the reply is accepted', () => {
  const bin = path.join(BIN, 'tdoc-agent-reply');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-reply-home-'));
  const port = 8300 + Math.floor(Math.random() * 300);
  const stub = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>{` +
    `s.writeHead(200,{'content-type':'application/json'});` +
    `s.end(JSON.stringify({id:'c_1',replies:[],reactions:{}}));` +
    `}).listen(${port},'127.0.0.1');`], { stdio: 'ignore' });
  try {
    const up = spawnSync('bash', ['-c',
      `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 ` +
      `-X POST http://127.0.0.1:${port}/ping && exit 0; sleep 0.05; done; exit 1`],
      { encoding: 'utf8', timeout: 15000 });
    assert(up.status === 0, 'stub server never came up');

    const r = spawnSync(bin, ['--slug', 'tornado-doc', '--parent', 'c_1', '--text', 'ok'], {
      env: { ...process.env, HOME: home, TDOC_PORT: String(port) },
      encoding: 'utf8', timeout: 20000,
    });
    assert(r.status === 0, `accepted reply exited ${r.status}; stderr=${r.stderr}`);
    assert(/"id":"c_1"/.test(r.stdout), `server body not passed through: ${r.stdout}`);
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});


// ---- tdoc-agent-reply must resolve the hosted base from .base (#226) ----
// Before the fix, `platform: "hosted"` fell into the cloudflare branch and read
// absent .subdomain/.worker, producing https://null.null.workers.dev -> 404.

t('tdoc-agent-reply posts to .base on a hosted config', () => {
  const bin = path.join(BIN, 'tdoc-agent-reply');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-reply-hosted-'));
  const port = 8700 + Math.floor(Math.random() * 300);
  fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
  // A real hosted config: .base and .upload_token, and deliberately NO
  // .subdomain / .worker — that absence is what the bug tripped over.
  fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({
    platform: 'hosted',
    base: `http://127.0.0.1:${port}`,
    public_host: '127.0.0.1',
    upload_token: 'tok_test',
  }));
  // Record the path the reply actually arrives on, so a request that never
  // leaves for the right host cannot pass.
  const stub = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>{` +
    `s.writeHead(200,{'content-type':'application/json'});` +
    `s.end(JSON.stringify({id:'c_hosted',path:q.url,replies:[],reactions:{}}));` +
    `}).listen(${port},'127.0.0.1');`], { stdio: 'ignore' });
  try {
    const up = spawnSync('bash', ['-c',
      `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 ` +
      `-X POST http://127.0.0.1:${port}/ping && exit 0; sleep 0.05; done; exit 1`],
      { encoding: 'utf8', timeout: 15000 });
    assert(up.status === 0, 'stub server never came up');

    const r = spawnSync(bin, ['--slug', 'tornado-doc', '--parent', 'c_1', '--text', 'ok'], {
      env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000,
    });
    assert(r.status === 0, `hosted reply exited ${r.status}; stderr=${r.stderr}`);
    assert(/"id":"c_hosted"/.test(r.stdout),
      `reply did not reach the hosted base: stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/"path":"\/api\/agent\/reply"/.test(r.stdout),
      `reply hit the wrong path: ${r.stdout}`);
    assert(!/workers\.dev/.test(r.stdout + r.stderr),
      `hosted config still derived a workers.dev host: ${r.stderr}`);
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('tdoc-agent-reply base resolution matches tdoc-pull across platforms', () => {
  const src = readBin('tdoc-agent-reply');
  // hosted and vercel both read .base; cloudflare/legacy still derive workers.dev.
  assert(/\[ "\$PLATFORM" = "hosted" \] \|\| \[ "\$PLATFORM" = "vercel" \]/.test(src),
    'hosted is not on the .base side of the platform branch');
  assert(/BASE="https:\/\/\$\{WORKER\}\.\$\{SUBDOMAIN\}\.workers\.dev"/.test(src),
    'cloudflare no longer derives the workers.dev base');
  assert(/\.platform \/\/ "cloudflare"/.test(src),
    'legacy configs without .platform no longer default to cloudflare');
  // A missing field must not become the literal string "null" in a hostname.
  assert(/'\.subdomain \/\/ empty'/.test(src) && /'\.worker \/\/ empty'/.test(src),
    'subdomain/worker are read without an // empty guard, so jq can yield "null"');
});


// ---- publish-first flow (S4): sign-in ahead of generation, no stray localhost ----

t('tdoc-publish --signin-only needs no slug and no-ops when already signed in', () => {
  const bin = path.join(BIN, 'tdoc-publish');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-signin-'));
  try {
    fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({
      platform: 'hosted', base: 'https://tdoc.dev', upload_token: 'tok',
    }));
    const r = spawnSync(bin, ['--signin-only'], {
      env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000,
    });
    assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert(/already signed in/.test(r.stderr), `expected a no-op message, got: ${r.stderr}`);
    // It must not have printed usage — --signin-only takes no slug.
    assert(!/usage:/i.test(r.stdout + r.stderr), 'usage printed for --signin-only');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('a normal publish still requires a slug', () => {
  const r = spawnSync(path.join(BIN, 'tdoc-publish'), [], { encoding: 'utf8', timeout: 20000 });
  assert(r.status !== 0, 'publish with no slug must not succeed');
});

t('the GitHub sign-in opens the browser and is NOT gated on a tty', () => {
  const src = readBin('tdoc-publish');
  assert(/should_open_browser\(\)/.test(src), 'no browser-open helper');
  // An agent runs this with stderr piped. A tty check would mean the auto-open
  // never fires in the exact situation it exists for.
  const helper = src.slice(src.indexOf('should_open_browser()'), src.indexOf('Waiting for GitHub approval'));
  assert(!/-t\s+2|-t\s+1/.test(helper), 'browser-open must not be gated on a tty');
  for (const guard of ['TDOC_NO_BROWSER', 'CI', 'SSH_CONNECTION']) {
    assert(helper.includes(guard), `browser-open should respect ${guard}`);
  }
  // Only ever hand a github.com URL to the opener.
  assert(/case "\$uri" in\s*\n\s*https:\/\/github\.com\/\*\)/.test(src),
    'the opener must be restricted to github.com URLs');
});

t('bin/tdoc-new still defaults to NOT publishing', () => {
  // /document-release, /retro, /investigate, /cso and /qa-only all call this.
  // If the publish-by-default flip leaked here, every security audit and retro
  // would auto-upload to tdoc.dev.
  const src = readBin('tdoc-new');
  assert(/^PUBLISH=0$/m.test(src), 'tdoc-new must default PUBLISH=0');
  assert(/--publish\)\s*PUBLISH=1/.test(src), '--publish must remain the opt-in');
});

t('the handoff line does not claim a plain publish is unlisted', () => {
  // A publish with no flags stores no access block and takes the legacy
  // policy (public + full history). Telling the user "unlisted" would
  // understate what a recipient can see. Keeping the default as-is is a
  // product decision (#245/#246 closed); the copy has to match it.
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const step = skill.slice(skill.indexOf('*Hosted (the default).*'), skill.indexOf('*Self-host.*'));
  assert(!/live and \*\*unlisted\*\*/.test(step), 'handoff still calls a plain publish unlisted');
  // The blockquote wraps, so match across the "> " continuation.
  assert(/page back[\s>]+through earlier versions/.test(step),
    'handoff should say earlier versions are reachable');
  assert(/--history owner/.test(step), 'handoff should point at the way to change it');
});

t('SKILL.md states the localhost rule and no longer promises localhost by default', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  assert(/never hand over a `localhost` URL unless the user asked/i.test(skill),
    'the localhost rule is not stated');
  // The delivery step must not open localhost unconditionally any more.
  assert(!/^7\. Open `http:\/\/localhost/m.test(skill),
    '/tdoc new still opens localhost as its delivery step');
  // Front matter must not advertise the abandoned default.
  const front = skill.slice(0, skill.indexOf('---', 4));
  assert(!/serve it at localhost/.test(front), 'description still says "serve it at localhost"');
  assert(!/own Cloudflare\s*\n?\s*Worker/.test(front), 'description still sells BYOK Cloudflare as the default');
  assert(/tdoc\.dev/.test(front), 'description should name the hosted destination');
});

t('SKILL.md and skills/tdoc/SKILL.md stay identical', () => {
  const root = path.join(__dirname, '..');
  const a = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const b = fs.readFileSync(path.join(root, 'skills', 'tdoc', 'SKILL.md'), 'utf8');
  assert(a === b, 'SKILL.md and its plugin-mode copy have drifted');
});


// ---- tdoc-update --auto: keep current without ever destroying work ----

t('tdoc-update --auto never stashes and never redeploys', () => {
  const src = readBin('tdoc-update');
  assert(/--auto\)\s*AUTO=1/.test(src), '--auto flag missing');
  // The stash path is the one that can lose someone's edits.
  const stashIdx = src.indexOf('git stash push');
  const guardIdx = src.lastIndexOf('AUTO" = "1"', stashIdx);
  assert(guardIdx !== -1 && guardIdx < stashIdx,
    '--auto must bail out before the stash push');
  // Redeploy pushes to the user's own infrastructure.
  const redeployIdx = src.indexOf('bin/tdoc-publish');
  const exitIdx = src.lastIndexOf('AUTO" = "1"', redeployIdx);
  assert(exitIdx !== -1 && exitIdx < redeployIdx,
    '--auto must exit before the redeploy offer');
});

t('tdoc-update --auto declines on a diverged checkout', () => {
  const src = readBin('tdoc-update');
  assert(/LOCAL" != "\$BASE" \] && \[ "\$AUTO" = "1"/.test(src),
    '--auto must skip rather than fail on a diverged checkout');
});

t('SKILL.md probes for --auto before calling it', () => {
  // tdoc-update's arg loop has no catch-all: a version predating --auto would
  // ignore the flag and run the FULL interactive update, stashing local edits
  // on every skill run. The probe is what stops that.
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const call = skill.indexOf('bin/tdoc-update" --auto');
  assert(call !== -1, 'Step 0 should keep the skill current');
  const probe = skill.lastIndexOf("grep -q -- '--auto)'", call);
  assert(probe !== -1 && probe < call, 'the --auto call must be capability-probed');
  assert(skill.lastIndexOf('TDOC_SKIP_UPDATE_CHECK', call) !== -1,
    'there must be an off switch');
});

t('tdoc-update arg loop still has no catch-all (why the probe exists)', () => {
  // If this ever gains a `*)` that errors on unknown flags, the probe in
  // SKILL.md can be simplified — but until then it is load-bearing.
  const src = readBin('tdoc-update');
  const loop = src.slice(src.indexOf('for arg in "$@"'), src.indexOf('done', src.indexOf('for arg in "$@"')));
  assert(!/\*\)/.test(loop), 'arg loop gained a catch-all — revisit the SKILL.md probe');
});


// ---- hosted publish must not need jq (#256) ----

t('the hosted path uses no jq at all', () => {
  const src = readBin('tdoc-publish');
  // Everything hosted-reachable: the device flow, the token mint, the config
  // write and read, the upload payload, and the response parse.
  const hostedFns = [
    src.slice(src.indexOf('hosted_github_signin()'), src.indexOf('first_time_setup_hosted()')),
    src.slice(src.indexOf('first_time_setup_hosted()'), src.indexOf('require_jq_for_selfhost')),
    src.slice(src.indexOf('build_payload()'), src.indexOf('PLATFORM_FLAG=')),
  ].join('\n');
  const calls = hostedFns.split('\n').filter((l) => /\bjq\s+(-|["'$])/.test(l) && !l.trim().startsWith('#'));
  assert(calls.length === 0, `hosted path still shells out to jq:\n      ${calls.join('\n      ')}`);
});

t('jq is required for self-hosting, and only there', () => {
  const src = readBin('tdoc-publish');
  // No top-level hard fail any more — that turned a zero-setup path into an
  // install step on a machine that ships no jq.
  assert(!/^if ! command -v jq >\/dev\/null 2>&1; then$/m.test(src),
    'the global jq gate is back');
  assert(/require_jq_for_selfhost\(\)/.test(src), 'the self-host jq gate is missing');
  for (const fn of ['first_time_setup()', 'first_time_setup_vercel()']) {
    const i = src.indexOf(fn);
    assert(i !== -1, `${fn} not found`);
    const head = src.slice(i, i + 200);
    assert(/require_jq_for_selfhost/.test(head), `${fn} does not check for jq`);
  }
  // And the message must not send a hosted user to install anything.
  const msg = src.slice(src.indexOf('Self-hosting needs jq'), src.indexOf('Self-hosting needs jq') + 320);
  assert(/does not need it/.test(msg), 'the jq message should say hosted publishing is unaffected');
});

t('build_payload embeds the document without a shell round trip', () => {
  const src = readBin('tdoc-publish');
  const fn = src.slice(src.indexOf('build_payload()'), src.indexOf('PLATFORM_FLAG='));
  assert(/readFileSync\(htmlPath/.test(fn), 'the HTML must be read by node, not passed as an argument');
  assert(/JSON\.stringify\(out\)/.test(fn), 'the payload must be JSON-encoded by node');
  // Widgets and comments stay optional, the way the jq version had them.
  assert(/if \(commentsPath\)/.test(fn), 'comments must stay optional');
  assert(/Object\.keys\(widgets\)\.length/.test(fn), 'widgets must stay optional');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
