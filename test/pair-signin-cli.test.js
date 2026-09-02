// The CLI side of pairing: bin/tdoc-publish against a stub hosted worker.
//
// Pins the negotiation the rollout depends on: a pairing-capable worker gets
// the pairing flow (one round trip, token straight from the poll, GitHub
// endpoints never touched); a pre-pairing worker 404s the start call and the
// CLI falls back to the device flow untouched. Plus the recovery story: a
// pair sign-in killed mid-poll resumes on re-run, and the pair_secret rides
// the pending file without ever being served to the publish modal.
//
// Run with: node test/pair-signin-cli.test.js

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PUBLISH = path.join(__dirname, '..', 'bin', 'tdoc-publish');
let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

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

// Stub worker. `pairing: true` serves the pair routes; false 404s them and
// serves the device flow instead, imitating a pre-pairing deploy.
function startStub(port, { pairing }) {
  const hits = { pairStart: 0, pairPoll: 0, deviceStart: 0, devicePoll: 0, lastPairSecret: null };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const parsed = (() => { try { return JSON.parse(body || '{}'); } catch { return {}; } })();
      if (req.url === '/api/cli/pair/start') {
        if (!pairing) { res.statusCode = 404; return res.end('{}'); }
        hits.pairStart++;
        return res.end(JSON.stringify({
          user_code: 'PAIR-2345',
          pair_secret: 'pairsec_stub',
          verification_uri: `http://127.0.0.1:${port}/activate`,
          verification_uri_complete: `http://127.0.0.1:${port}/activate?code=PAIR-2345`,
          expires_in: 600, interval: 5,
        }));
      }
      if (req.url === '/api/cli/pair/poll') {
        if (!pairing) { res.statusCode = 404; return res.end('{}'); }
        hits.pairPoll++;
        hits.lastPairSecret = parsed.pair_secret || null;
        return res.end(JSON.stringify({
          ok: true, token: 'tdoc_pair_token', account_id: 'acct_pair',
          github_login: 'pair-user', base: `http://127.0.0.1:${port}`,
          identity: { login: 'pair-user' },
        }));
      }
      if (req.url === '/api/auth/device/start') {
        hits.deviceStart++;
        return res.end(JSON.stringify({
          user_code: 'DEVC-6789', device_code: 'device-stub',
          verification_uri: 'https://github.com/login/device',
          interval: 5, expires_in: 900,
        }));
      }
      if (req.url === '/api/auth/device/poll') {
        hits.devicePoll++;
        res.setHeader('set-cookie', 'tdoc_sid=stub; Path=/');
        return res.end(JSON.stringify({ ok: true, identity: { login: 'device-user' } }));
      }
      if (req.url === '/api/hosted/token') {
        return res.end(JSON.stringify({
          ok: true, token: 'tdoc_device_token', account_id: 'acct_device', github_login: 'device-user',
        }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, hits }));
    server.on('error', reject);
  });
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-pair-cli-'));
  fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
  fs.mkdirSync(path.join(home, 'tdocs'), { recursive: true });
  return home;
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
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`sign-in did not finish; stderr:\n${stderr}`));
    }, 25000);
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

(async () => {
  console.log('pairing CLI');

  await t('a pairing-capable worker gets the pairing flow, not GitHub', async () => {
    const port = await freePort();
    const { server, hits } = await startStub(port, { pairing: true });
    const home = fixture();
    try {
      const { code, stderr } = await runSigninOnly(home, port);
      assert(code === 0, `exit ${code}:\n${stderr}`);
      assert(hits.pairStart === 1 && hits.pairPoll >= 1, `pair hits: ${JSON.stringify(hits)}`);
      assert(hits.deviceStart === 0, 'device flow was touched despite pairing');
      assert(hits.lastPairSecret === 'pairsec_stub', 'poll did not carry the secret');
      assert(stderr.includes('PAIR-2345'), `code not shown:\n${stderr}`);
      assert(stderr.includes('/activate'), 'activate URL not shown');
      assert(!stderr.includes('github.com'), 'GitHub leaked into the pairing UX');
      const cfg = JSON.parse(fs.readFileSync(path.join(home, '.tdoc', 'published.json'), 'utf8'));
      assert(cfg.upload_token === 'tdoc_pair_token' && cfg.account_id === 'acct_pair',
        `config wrong: ${JSON.stringify(cfg)}`);
      assert(!fs.existsSync(path.join(home, '.tdoc', 'pending-signin.json')), 'pending file survived success');
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await t('a pre-pairing worker falls back to the device flow untouched', async () => {
    const port = await freePort();
    const { server, hits } = await startStub(port, { pairing: false });
    const home = fixture();
    try {
      const { code, stderr } = await runSigninOnly(home, port);
      assert(code === 0, `exit ${code}:\n${stderr}`);
      assert(hits.deviceStart === 1 && hits.devicePoll >= 1, `device hits: ${JSON.stringify(hits)}`);
      assert(stderr.includes('DEVC-6789'), 'device code not shown on fallback');
      const cfg = JSON.parse(fs.readFileSync(path.join(home, '.tdoc', 'published.json'), 'utf8'));
      assert(cfg.upload_token === 'tdoc_device_token', `config wrong: ${JSON.stringify(cfg)}`);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await t('a killed pair sign-in resumes on re-run without re-minting', async () => {
    const port = await freePort();
    const { server, hits } = await startStub(port, { pairing: true });
    const home = fixture();
    try {
      fs.writeFileSync(path.join(home, '.tdoc', 'pending-signin.json'), JSON.stringify({
        user_code: 'RSUM-2345',
        verification_uri: `http://127.0.0.1:${port}/activate?code=RSUM-2345`,
        expires_at: Date.now() + 500000,
        opened: false, slug: 'signin', pid: 999999,
        device_code: 'pair:pairsec_resumed',
        base: `http://127.0.0.1:${port}`,
      }), { mode: 0o600 });
      const { code, stderr } = await runSigninOnly(home, port);
      assert(code === 0, `exit ${code}:\n${stderr}`);
      assert(hits.pairStart === 0, `re-minted instead of resuming: ${JSON.stringify(hits)}`);
      assert(hits.lastPairSecret === 'pairsec_resumed', 'resume did not poll the stored secret');
      // The stub approves instantly, so the probe completes the sign-in on
      // the spot — the ideal resume: no code re-shown, just the outcome. The
      // still-pending variant (probe → wait loop → resume message) is the
      // same loop the pairing-capable test already drives.
      assert(stderr.includes('approved while no tdoc was running'), `no probe-success message:\n${stderr}`);
      assert(!stderr.includes('RSUM-2345'), 'an already-approved resume should not re-show the code');
      const cfg = JSON.parse(fs.readFileSync(path.join(home, '.tdoc', 'published.json'), 'utf8'));
      assert(cfg.upload_token === 'tdoc_pair_token', `config wrong: ${JSON.stringify(cfg)}`);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await t('a leftover pair record does not confuse the device-flow fallback', async () => {
    // Worker lost pairing (rolled back / different BYOK host): the pair-kind
    // pending record cannot be redeemed there — expect a clean fresh device
    // flow, not a resume against endpoints that cannot answer it.
    const port = await freePort();
    const { server, hits } = await startStub(port, { pairing: false });
    const home = fixture();
    try {
      fs.writeFileSync(path.join(home, '.tdoc', 'pending-signin.json'), JSON.stringify({
        user_code: 'GONE-2345',
        verification_uri: `http://127.0.0.1:${port}/activate`,
        expires_at: Date.now() + 500000,
        opened: false, slug: 'signin', pid: 999999,
        device_code: 'pair:pairsec_orphaned',
        base: `http://127.0.0.1:${port}`,
      }), { mode: 0o600 });
      const { code, stderr } = await runSigninOnly(home, port);
      assert(code === 0, `exit ${code}:\n${stderr}`);
      assert(hits.deviceStart === 1, 'fallback did not start fresh');
      assert(!stderr.includes('GONE-2345'), 'orphaned pair code was shown as resumable');
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
