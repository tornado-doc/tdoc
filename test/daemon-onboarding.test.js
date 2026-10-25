// New account, old token, verified daemon, private practice doc, real handoff.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_HOSTED_ACCOUNTS: '1' });
  const owner = await issue(worker, env, 'onboard-owner');
  const other = await issue(worker, env, 'onboard-other');
  const call = async (p, opts = {}) => { const r = await worker.fetch(req(p, opts), env, {}); return { status: r.status, body: await r.json() }; };
  const origin = { Origin: 'https://tdoc.dev' };
  const register = (ready_clis) => call('/api/notify/local/register', { method: 'POST', token: owner.token, body: { device: 'my-mac', clis: ['codex'], ready_clis } });
  const practice = (cookie = owner.cookie, headers = origin) => call('/api/onboarding/practice', { method: 'POST', cookie, headers, body: { device: 'my-mac', cli: 'codex' } });
  await test('a paired account cannot be confused with a running daemon', async () => {
    const r = await call('/api/onboarding?daemon=1', { cookie: owner.cookie });
    assert.equal(r.status, 200); assert.deepEqual(r.body.local_agents, []);
    assert.equal((await practice()).status, 409);
  });
  await test('finding a CLI is not enough; a successful AI check is required', async () => {
    await register([]);
    const r = await call('/api/onboarding?daemon=1', { cookie: owner.cookie });
    assert.equal(r.body.local_agents[0].ready, false);
    assert.equal((await practice()).status, 409);
    await register(['codex']);
    const ready = await call('/api/onboarding?daemon=1', { cookie: owner.cookie });
    assert.equal(ready.body.local_agents[0].ready, true);
    assert.equal(ready.body.local_agents[0].status, 'active');
  });
  await test('runtime inventory reports an empty computer and stays private to its account', async () => {
    const runtimes = [{ cli: 'claude', state: 'not_installed' }, { cli: 'codex', state: 'not_installed' }];
    const report = await call('/api/notify/local/register', { method: 'POST', token: owner.token, body: { device: 'empty-mac', clis: [], ready_clis: ['codex'], runtimes } });
    assert.equal(report.status, 200);
    const own = (await call('/api/onboarding?daemon=1', { cookie: owner.cookie })).body;
    assert.deepEqual(own.local_computers.find((c) => c.device === 'empty-mac').runtimes, runtimes);
    assert.equal(own.local_computers[0].status, 'active');
    assert.deepEqual((await call('/api/onboarding?daemon=1', { cookie: other.cookie })).body.local_computers, []);
    const attempt = await call('/api/onboarding/practice', { method: 'POST', cookie: owner.cookie, headers: origin, body: { device: 'empty-mac', cli: 'codex' } });
    assert.equal(attempt.status, 409);
    const invalid = await call('/api/notify/local/register', { method: 'POST', token: owner.token, body: { device: 'empty-mac', clis: [], runtimes: [] } });
    assert.equal(invalid.status, 400);
  });
  await test('inventory strips local details and expires with the computer heartbeat', async () => {
    const runtimes = [{ cli: 'claude', state: 'not_installed', path: '/private/path' }, { cli: 'codex', state: 'ready', version: '1.2.3', token: 'private-value' }];
    const report = await call('/api/notify/local/register', { method: 'POST', token: owner.token, body: { device: 'inventory-mac', clis: ['codex'], ready_clis: [], runtimes } });
    assert.equal(report.status, 200);
    const inventory = (await call('/api/onboarding?daemon=1', { cookie: owner.cookie })).body.local_computers.find((c) => c.device === 'inventory-mac');
    assert.deepEqual(inventory.runtimes, [{ cli: 'claude', state: 'not_installed' }, { cli: 'codex', state: 'needs_check', version: '1.2.3' }]);
    const seenKey = `local-agents-seen:${report.body.account_id}`;
    const seen = JSON.parse(await env.META.get(seenKey));
    await env.META.put(seenKey, JSON.stringify({ ...seen, 'inventory-mac': '2000-01-01T00:00:00Z' }));
    assert.equal((await call('/api/onboarding?daemon=1', { cookie: owner.cookie })).body.local_computers.find((c) => c.device === 'inventory-mac').status, 'inactive');
  });
  let slug;
  await test('practice creates one private, owned doc and resumes it on retry', async () => {
    const made = await practice();
    assert.equal(made.status, 200, JSON.stringify(made.body)); slug = made.body.slug;
    assert.equal((await practice()).body.slug, slug);
    const meta = JSON.parse(await env.META.get(`meta:${slug}`));
    assert.equal(meta.access.visibility, 'private');
    const record = (await call('/api/onboarding', { cookie: owner.cookie })).body.record;
    assert.equal(record.first_doc, slug); assert.equal(record.revised, undefined);
    const targets = await call(`/api/notify/targets?slug=${slug}`, { cookie: owner.cookie });
    assert.equal(targets.body.default.provider, 'local'); assert.equal(targets.body.default.cli, 'codex');
    const denied = await worker.fetch(req(`/d/${slug}/raw`), env, {});
    assert.notEqual(denied.status, 200);
  });
  await test('another account and cross-origin callers cannot use the computer', async () => {
    assert.equal((await practice(other.cookie)).status, 409);
    assert.equal((await practice(owner.cookie, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await practice('')).status, 401);
  });
  await test('the practice comment reaches the daemon and v2 closes the loop', async () => {
    const post = await call('/api/comments', { method: 'POST', cookie: owner.cookie, body: { slug, version: 1, text: 'Make this shorter.', anchor: { kind: 'text', text: 'A good project update' } } });
    assert.equal(post.status, 200, JSON.stringify(post.body));
    const sent = await call('/api/notify/handoff', { method: 'POST', cookie: owner.cookie, body: { slug, comment_ids: [post.body.id] } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const pending = await call('/api/notify/local/pending?device=my-mac', { token: owner.token });
    assert.equal(pending.body.pending[0].slug, slug);
    const up = await call('/api/upload', { method: 'POST', token: owner.token, body: { slug, version: 2, html: '<h1>Your first tdoc</h1><p>A good update explains progress, next steps, and blockers.</p>' } });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.ok((await call('/api/onboarding', { cookie: owner.cookie })).body.record.revised);
  });
  await test('sleeping or disconnected computers cannot start the practice flow', async () => {
    const accountId = (await register(['codex'])).body.account_id;
    await env.META.put(`local-agents-seen:${accountId}`, JSON.stringify({ 'my-mac': '2000-01-01T00:00:00Z' }));
    assert.equal((await practice()).body.error, 'computer_not_ready');
  });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-setup-check-'));
  process.env.TDOC_DAEMON_DIR = temp;
  const { setup, readSetup } = require('../bin/lib/daemon-setup');
  await test('local inspection detects versions and revokes readiness after removal or upgrade', async () => {
    const { inspectLocalRuntimes } = require('../bin/lib/local-runtimes');
    const fakeBin = path.join(temp, 'runtime-bin'); fs.mkdirSync(fakeBin);
    const binary = path.join(fakeBin, 'codex');
    fs.writeFileSync(binary, '#!/bin/sh\necho "codex-cli 1.2.3"\n', { mode: 0o755 });
    const envVars = { ...process.env, PATH: fakeBin };
    const receipt = { clis: ['codex'], runtimes: [{ cli: 'codex', version: '1.2.3' }] };
    assert.deepEqual(inspectLocalRuntimes(receipt, envVars), [{ cli: 'claude', state: 'not_installed' }, { cli: 'codex', state: 'ready', version: '1.2.3' }]);
    fs.writeFileSync(binary, '#!/bin/sh\necho "codex-cli 2.0.0"\n');
    assert.equal(inspectLocalRuntimes(receipt, envVars)[1].state, 'needs_check');
    fs.writeFileSync(binary, '#!/bin/sh\necho "private arbitrary output"\nexit 1\n');
    assert.deepEqual(inspectLocalRuntimes(receipt, envVars)[1], { cli: 'codex', state: 'needs_check' });
    fs.unlinkSync(binary);
    assert.equal(inspectLocalRuntimes(receipt, envVars)[1].state, 'not_installed');
  });
  await test('managed helper reports inventory but never runs an unverified runtime', async () => {
    const { spawnSync } = require('child_process');
    const { startStub } = require('./helpers/fixture-server');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-inventory-daemon-'));
    const fakeBin = path.join(sandbox, 'bin'); fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi\necho UNEXPECTED_EXECUTION >&2\nexit 1\n', { mode: 0o755 });
    const stub = startStub(`(() => { const calls=[]; return (q,s) => { let body=''; q.on('data',d=>body+=d); q.on('end',()=>{ s.setHeader('Content-Type','application/json'); if(q.url==='/log') return s.end(JSON.stringify(calls)); calls.push({url:q.url,body:body?JSON.parse(body):null}); s.end(JSON.stringify(q.url.includes('/pending')?{account_ids:['owner'],pending:[{by:'owner',recipient:{cli:'codex'},handoff_id:'never-run',slug:'test'}]}:{ok:true})); }); }; })()`);
    try {
      const config = path.join(sandbox, 'config.json');
      fs.writeFileSync(config, JSON.stringify({ platform: 'hosted', base: stub.base, upload_token: 'test-only' }));
      const envVars = { ...process.env, HOME: sandbox, PATH: fakeBin, TDOC_CONFIG: config, TDOC_DAEMON_DIR: path.join(sandbox, 'daemon') };
      for (const empty of [false, true]) {
        if (empty) fs.unlinkSync(path.join(fakeBin, 'codex'));
        const r = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/lib/daemon.js'), 'once', '--managed', '--device', 'testbox'], { env: envVars, encoding: 'utf8', timeout: 15000 });
        assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stderr + r.stdout, /UNEXPECTED_EXECUTION/);
      }
      const calls = await (await fetch(stub.base + '/log')).json();
      assert.equal(calls.length, 4, JSON.stringify(calls));
      assert.deepEqual(calls[0].body.ready_clis, []); assert.deepEqual(calls[0].body.clis, ['codex']);
      assert.deepEqual(calls[2].body.clis, []);
      assert.equal(calls[2].body.runtimes.every((r) => r.state === 'not_installed'), true);
    } finally { stub.stop(); fs.rmSync(sandbox, { recursive: true }); }
  });
  await test('a connected helper can report failed or absent AI without advertising readiness', async () => {
    let installed = false;
    const inspect = () => [{ cli: 'claude', state: 'not_installed' }, { cli: 'codex', state: 'needs_check' }];
    await setup({}, { signIn() {}, detect: () => ['codex'], inspect, probe: async () => ({ ok: false, tail: '' }), install: () => { installed = true; } });
    assert.equal(installed, true); assert.deepEqual(readSetup().clis, []);
    await setup({}, { signIn() {}, detect: () => [], inspect, probe: async () => { throw new Error('must not invoke absent AI'); }, install() {} });
    assert.deepEqual(readSetup().clis, []);
    fs.unlinkSync(path.join(temp, 'setup.json'));
  });
  await test('verified AI is persisted before starting the service; failure rolls back', async () => {
    const deps = { signIn() {}, detect: () => ['codex'], inspect: () => [{ cli: 'codex', state: 'ready', version: '1.2.3' }], probe: async () => ({ ok: true, tail: 'TDOC_READY' }) };
    await assert.rejects(setup({}, { ...deps, install() { assert.deepEqual(readSetup().clis, ['codex']); throw new Error('service unavailable'); } }), /service unavailable/);
    assert.equal(readSetup(), null);
    await setup({}, { ...deps, install(clis) { assert.deepEqual(clis, ['codex']); } });
    assert.deepEqual(readSetup().clis, ['codex']);
  });
  await test('managed user service uses the verified runtime and uninstall preserves user data', async () => {
    if (!['darwin', 'linux'].includes(process.platform)) return;
    const { spawnSync } = require('child_process');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-service-'));
    const fakeBin = path.join(sandbox, 'bin'); fs.mkdirSync(fakeBin);
    const calls = path.join(sandbox, 'calls');
    fs.writeFileSync(path.join(fakeBin, process.platform === 'darwin' ? 'launchctl' : 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TDOC_TEST_CALLS"\n', { mode: 0o755 });
    const modulePath = path.resolve(__dirname, '../bin/lib/daemon-setup.js');
    const envVars = { ...process.env, HOME: sandbox, TDOC_DAEMON_DIR: path.join(sandbox, '.tdoc/daemon'), TDOC_SKILL_DIR: path.resolve(__dirname, '..'), TDOC_TEST_CALLS: calls, PATH: fakeBin + path.delimiter + process.env.PATH };
    const run = (code) => { const r = spawnSync(process.execPath, ['-e', code], { env: envVars, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
    run(`require(${JSON.stringify(modulePath)}).installService(['codex'])`);
    const plist = process.platform === 'darwin' ? path.join(sandbox, 'Library/LaunchAgents/dev.tdoc.daemon.plist') : path.join(sandbox, '.config/systemd/user/tdoc-daemon.service');
    const contents = fs.readFileSync(plist, 'utf8');
    assert.ok(contents.includes(process.execPath));
    if (process.platform === 'darwin') {
      assert.ok(contents.includes('<string>--managed</string>')); assert.ok(contents.includes('<key>KeepAlive</key><true/>'));
      assert.match(fs.readFileSync(calls, 'utf8'), /bootout[\s\S]*bootstrap/);
    } else {
      assert.ok(contents.includes('\"--managed\"')); assert.ok(contents.includes('Restart=on-failure'));
      assert.match(fs.readFileSync(calls, 'utf8'), /stop[\s\S]*daemon-reload[\s\S]*enable --now/);
    }
    const data = path.join(sandbox, '.tdoc/daemon/keep.txt'); fs.writeFileSync(data, 'preserve');
    run(`require(${JSON.stringify(modulePath)}).uninstall()`);
    assert.equal(fs.existsSync(plist), false); assert.equal(fs.readFileSync(data, 'utf8'), 'preserve');
    fs.rmSync(sandbox, { recursive: true });
  });
  await test('bootstrap preserves an existing skill and leaves a resumable launcher after setup failure', async () => {
    const { spawnSync, execFileSync } = require('child_process');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-bootstrap-'));
    const release = path.join(sandbox, 'release'); fs.mkdirSync(path.join(release, 'bin/lib'), { recursive: true });
    fs.writeFileSync(path.join(release, 'bin/lib/daemon-setup.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(release, 'bin/lib/daemon.js'), 'console.error("AI is signed out"); process.exit(1);');
    const archive = path.join(sandbox, 'release.tar.gz'); execFileSync('tar', ['-czf', archive, '-C', sandbox, 'release']);
    const fakeBin = path.join(sandbox, 'fake-bin'); fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then cp "$TDOC_TEST_ARCHIVE" "$2"; exit; fi; shift; done\nexit 1\n', { mode: 0o755 });
    const userHome = path.join(sandbox, 'home with space');
    const existing = path.join(userHome, '.claude/skills/tdoc'); fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'keep.txt'), 'keep');
    const r = spawnSync('bash', [path.resolve(__dirname, '../bin/tdoc-install')], { env: { ...process.env, HOME: userHome, TDOC_INSTALL_HOME: path.join(userHome, '.tdoc'), TDOC_TEST_ARCHIVE: archive, PATH: fakeBin + path.delimiter + process.env.PATH }, encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /resume with/);
    assert.equal(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
    const launcher = path.join(userHome, '.local/bin/tdoc'); assert.ok(fs.existsSync(launcher));
    const retry = spawnSync(launcher, ['setup'], { encoding: 'utf8' });
    assert.equal(retry.status, 1); assert.match(retry.stderr, /AI is signed out/);
    assert.ok(fs.lstatSync(path.join(userHome, '.agents/skills/tdoc')).isSymbolicLink());
    const installed = spawnSync('bash', [path.resolve(__dirname, '../bin/tdoc-install'), '--install-only'], { env: { ...process.env, HOME: userHome, TDOC_INSTALL_HOME: path.join(userHome, '.tdoc'), TDOC_TEST_ARCHIVE: archive, PATH: fakeBin + path.delimiter + process.env.PATH }, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /Installed.*Connect this computer/s);
    assert.doesNotMatch(installed.stderr, /AI is signed out/, 'install-only must not run setup or start a service');
    const connect = spawnSync(launcher, ['setup'], { encoding: 'utf8' });
    assert.equal(connect.status, 1); assert.match(connect.stderr, /AI is signed out/);
    fs.rmSync(sandbox, { recursive: true });
  });
  console.log(`${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
