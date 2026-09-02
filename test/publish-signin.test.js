// GET /api/publish/signin — the side channel that carries the GitHub device
// code from a blocked `tdoc-publish` to the publish modal.
//
// The code is printed to stderr, and the local server buffers a child's output
// until it exits, so during the ~15 minutes the code is actually usable the
// modal can see nothing. The CLI writes it to ~/.tdoc/pending-signin.json
// instead; these tests pin the contract the modal reads, and in particular the
// three ways a file on disk can be lying: expired, orphaned, or another slug's.
//
// HERMETIC: spawns its own server with a throwaway HOME and TDOC_DIR.
// Run with: node test/publish-signin.test.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
let PORT = 0;
const SLUG = 'signin-test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-signin-home-'));
const DOCS = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-signin-docs-'));
const TDOC_CONFIG = path.join(HOME, '.tdoc');
const PENDING = path.join(TDOC_CONFIG, 'pending-signin.json');
fs.mkdirSync(TDOC_CONFIG, { recursive: true });

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, err) { console.log(`  ✗ ${name}\n    ${err}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } }
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

function get(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: HOST, port: PORT, path: p, method: 'GET' }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    r.on('error', reject);
    r.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, HOST, () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function writePending(overrides) {
  fs.writeFileSync(PENDING, JSON.stringify({
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_at: Date.now() + 900000,
    opened: true,
    slug: SLUG,
    pid: process.pid,
    ...overrides,
  }));
}

// A pid that is real but certainly not running. Claim one by spawning a
// trivial process and waiting for it to exit, rather than guessing a number
// that some unrelated process might own.
function deadPid() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', '']);
    p.on('close', () => resolve(p.pid));
  });
}

(async () => {
  PORT = await freePort();
  const serverBin = path.join(__dirname, '..', 'server', 'server.js');
  const proc = spawn('node', [serverBin], {
    // HOME is what steers os.homedir(), and therefore where the server looks
    // for the pending file. Without it this test would read the real ~/.tdoc.
    env: { ...process.env, HOME: HOME, TDOC_PORT: String(PORT), TDOC_HOST: HOST, TDOC_DIR: DOCS },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server start timeout')), 5000);
    proc.stdout.on('data', d => { if (d.toString().includes('tdoc server')) { clearTimeout(to); res(); } });
    proc.stderr.on('data', d => process.stderr.write(d));
  });

  console.log('publish sign-in side channel');

  await t('no pending file → signin is null', async () => {
    fs.rmSync(PENDING, { force: true });
    const r = await get(`/api/publish/signin?slug=${SLUG}`);
    eq(r.status, 200, 'status');
    eq(r.body.signin, null, 'signin');
  });

  await t('live code is handed to the modal', async () => {
    writePending();
    const r = await get(`/api/publish/signin?slug=${SLUG}`);
    eq(r.body.signin && r.body.signin.user_code, 'ABCD-1234', 'user_code');
    eq(r.body.signin.verification_uri, 'https://github.com/login/device', 'verification_uri');
    eq(r.body.signin.opened, true, 'opened');
  });

  await t('expired code is withheld', async () => {
    writePending({ expires_at: Date.now() - 1000 });
    const r = await get(`/api/publish/signin?slug=${SLUG}`);
    eq(r.body.signin, null, 'signin');
  });

  await t('code from a dead publish is withheld', async () => {
    writePending({ pid: await deadPid() });
    const r = await get(`/api/publish/signin?slug=${SLUG}`);
    eq(r.body.signin, null, 'signin');
  });

  await t("another slug's code is withheld", async () => {
    writePending({ slug: 'some-other-doc' });
    const r = await get(`/api/publish/signin?slug=${SLUG}`);
    eq(r.body.signin, null, 'signin');
  });

  await t('a request with no slug is told nothing', async () => {
    // The slug guard is the only thing keeping one doc's code from answering
    // another doc's poll, so a missing param must not be a way around it.
    writePending();
    const r = await get('/api/publish/signin');
    eq(r.body.signin, null, 'signin');
  });

  await t('a malformed slug is told nothing', async () => {
    writePending();
    const r = await get('/api/publish/signin?slug=not%20a%20slug');
    eq(r.body.signin, null, 'signin');
  });

  await t('malformed file does not 500', async () => {
    fs.writeFileSync(PENDING, 'not json at all');
    const r = await get(`/api/publish/signin?slug=${SLUG}`);
    eq(r.status, 200, 'status');
    eq(r.body.signin, null, 'signin');
  });

  await t('device_code is never served to the modal', async () => {
    // The pending file carries device_code so a later CLI run can resume the
    // sign-in. That value can redeem the approval — the endpoint whitelists
    // fields and must keep it out of every response.
    writePending({ device_code: 'super-secret-device-code', base: 'https://tdoc.dev' });
    const r = await get(`/api/publish/signin?slug=${SLUG}`);
    eq(r.body.signin && r.body.signin.user_code, 'ABCD-1234', 'user_code');
    const raw = JSON.stringify(r.body);
    eq(raw.includes('device_code') || raw.includes('super-secret'), false, 'device_code leaked');
  });

  await t('a file missing its code is withheld', async () => {
    writePending({ user_code: '' });
    const r = await get(`/api/publish/signin?slug=${SLUG}`);
    eq(r.body.signin, null, 'signin');
  });

  proc.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(DOCS, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
