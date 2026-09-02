// Resumable sign-in: an approval granted while no tdoc process was alive
// still lands.
//
// Observed in Codex cloud: the agent harness killed tdoc-publish mid-poll,
// the human approved the device code into the void, and the next run minted a
// fresh code — wasting the approval and confusing everyone. Now the pending
// file carries the device_code, and a new run resumes polling it instead of
// starting over.
//
// Runs the real bin/tdoc-publish (--signin-only) against a local stand-in for
// the hosted worker, with an isolated HOME. Also pins the two guards around
// the mechanism: a stale or foreign pending file is cleared and the flow
// starts fresh, and the local server never serves device_code to the modal.
//
// Run with: node test/resume-signin.test.js

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PUBLISH = path.join(__dirname, '..', 'bin', 'tdoc-publish');
let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, err) { console.log(`  ✗ ${name}\n    ${err}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } }
function assert(condition, message) { if (!condition) throw new Error(message); }

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

// Hosted-worker stand-in that records which auth endpoints were hit. The poll
// succeeds immediately, so a resumed run completes on its first tick.
function startHostedStub(port) {
  const hits = { start: 0, poll: 0, token: 0 };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/auth/device/start') {
      hits.start++;
      return res.end(JSON.stringify({
        user_code: 'FRSH-0000',
        device_code: 'fresh-device-code',
        verification_uri: 'https://github.com/login/device',
        interval: 5,
        expires_in: 900,
      }));
    }
    if (req.url === '/api/auth/device/poll') {
      hits.poll++;
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        hits.lastPolledCode = (() => { try { return JSON.parse(body).device_code; } catch { return null; } })();
        res.setHeader('set-cookie', 'tdoc_sid=stub-session; Path=/; HttpOnly');
        res.end(JSON.stringify({ ok: true, identity: { login: 'resume-tester' } }));
      });
      return;
    }
    if (req.url === '/api/hosted/token') {
      hits.token++;
      return res.end(JSON.stringify({
        ok: true, token: 'tdoc_stub_token', account_id: 'acct_stub',
        github_login: 'resume-tester', base: `http://127.0.0.1:${port}`,
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, hits }));
    server.on('error', reject);
  });
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-resume-'));
  fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
  fs.mkdirSync(path.join(home, 'tdocs'), { recursive: true });
  return home;
}

function writePending(home, base, overrides = {}) {
  fs.writeFileSync(path.join(home, '.tdoc', 'pending-signin.json'), JSON.stringify({
    user_code: 'RSME-4321',
    verification_uri: 'https://github.com/login/device',
    expires_at: Date.now() + 600000,
    opened: false,
    slug: 'signin',
    pid: 999999,           // the dead previous process
    device_code: 'resumable-device-code',
    base,
    ...overrides,
  }), { mode: 0o600 });
}

function runSigninOnly(home, port) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn('bash', [PUBLISH, '--signin-only'], {
      env: {
        ...process.env,
        HOME: home,
        TDOC_DIR: path.join(home, 'tdocs'),
        TDOC_HOSTED_BASE: `http://127.0.0.1:${port}`,
        TDOC_NO_BROWSER: '1',
        TDOC_SKIP_UPDATE_CHECK: '1',
        TDOC_PLATFORM: '',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    // First poll fires after the 5s interval floor; 20s covers slow CI.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`sign-in did not finish; stderr:\n${stderr}`));
    }, 20000);
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

(async () => {
  console.log('resumable sign-in');
  const port = await freePort();
  const { server, hits } = await startHostedStub(port);
  const base = `http://127.0.0.1:${port}`;

  await t('a valid pending device_code is resumed, not re-minted', async () => {
    const home = fixture();
    writePending(home, base);
    const { code, stderr } = await runSigninOnly(home, port);
    try {
      assert(code === 0, `expected exit 0, got ${code}:\n${stderr}`);
      assert(stderr.includes('Resuming the GitHub sign-in'), `no resume message:\n${stderr}`);
      // The reader of this stderr is usually an agent. It must be told, in
      // words, not to complete the approval in its own browser — a ChatGPT
      // session was watched doing exactly that off the old wording.
      assert(stderr.includes('do not open it yourself'),
        `resume message lost its agent instruction:\n${stderr}`);
      assert(stderr.includes('RSME-4321'), `resumed code not shown again:\n${stderr}`);
      assert(hits.start === 0, `device/start was called ${hits.start}x on resume`);
      assert(hits.lastPolledCode === 'resumable-device-code',
        `polled "${hits.lastPolledCode}", not the stored device_code`);
      assert(fs.existsSync(path.join(home, '.tdoc', 'published.json')),
        'published.json was not written after a resumed sign-in');
      assert(!fs.existsSync(path.join(home, '.tdoc', 'pending-signin.json')),
        'pending-signin.json survived a successful resume');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await t('an expired pending file is cleared and the flow starts fresh', async () => {
    const home = fixture();
    writePending(home, base, { expires_at: Date.now() - 1000 });
    hits.start = 0; hits.lastPolledCode = null;
    const { code, stderr } = await runSigninOnly(home, port);
    try {
      assert(code === 0, `expected exit 0, got ${code}:\n${stderr}`);
      assert(!stderr.includes('Resuming'), `resumed an expired code:\n${stderr}`);
      assert(hits.start === 1, `device/start called ${hits.start}x, expected 1`);
      assert(hits.lastPolledCode === 'fresh-device-code', 'did not poll the fresh code');
      // Fresh-code path, no auto-open (TDOC_NO_BROWSER=1): the exact branch a
      // cloud agent reads. The agent line and whose-browser-counts line must
      // both be there.
      assert(stderr.includes('Agent: relay the URL and code'),
        `fresh sign-in lost its agent-first instruction:\n${stderr}`);
      assert(stderr.includes('THEIR browser'),
        `fresh sign-in no longer says whose browser counts:\n${stderr}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await t("a pending file for a different base is not resumed", async () => {
    const home = fixture();
    writePending(home, 'https://tdoc.dev');
    hits.start = 0;
    const { code, stderr } = await runSigninOnly(home, port);
    try {
      assert(code === 0, `expected exit 0, got ${code}:\n${stderr}`);
      assert(!stderr.includes('Resuming'), `resumed a foreign-base code:\n${stderr}`);
      assert(hits.start === 1, `device/start called ${hits.start}x, expected 1`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await t('a pre-resume-era file (no device_code) is cleared, not resumed', async () => {
    const home = fixture();
    writePending(home, base, { device_code: undefined });
    hits.start = 0;
    const { code, stderr } = await runSigninOnly(home, port);
    try {
      assert(code === 0, `expected exit 0, got ${code}:\n${stderr}`);
      assert(!stderr.includes('Resuming'), `resumed without a device_code:\n${stderr}`);
      assert(hits.start === 1, `device/start called ${hits.start}x, expected 1`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
