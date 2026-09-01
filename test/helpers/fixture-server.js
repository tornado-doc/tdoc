// Shared test harness for the browser-driven UI suites (#15).
//
// Before: ui/responsive/dimensions tests defaulted to a hardcoded LIVE deploy
// (a live personal workers.dev deployment/d/conway-life/v/2). That meant they (a)
// couldn't run offline, (b) tested the SHIPPED bundle instead of the working
// tree — defeating the pre-push gate — and (c) silently no-op'd when offline.
//
// Now: by default they boot the local server (server/server.js) against the
// committed fixture under test/fixtures/tdocs and target THAT — so they exercise
// the working-tree overlay. The live URL stays available via TDOC_TEST_URL.
//
// Playwright is an optional dep. If it's not installed, callers SKIP LOUDLY
// (clear message, exit 0) rather than crash or silently pass.
//
// This file also owns port allocation for every test that boots a server, so
// that no suite has to guess a free port. See startStub() below for why.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const http = require('http');

const FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'tdocs');
const FIXTURE_SLUG = 'sample-doc';

function tryRequirePlaywright() {
  try { return require('playwright'); }
  catch { return null; }
}

function waitForServer(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function ping() {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume(); resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('local fixture server did not start'));
        else setTimeout(ping, 100);
      });
    })();
  });
}

// ---- ports ------------------------------------------------------------------
//
// Tests used to draw a port out of a fixed range (`8700 + rand(300)`) and
// assume the server they spawned got it. Nothing checked the bind, and the
// readiness poll only asked "does anything answer here?" — so when an
// unrelated process on the machine already held the drawn port, the CLI under
// test talked to that stranger and read its answer as the product's. On one
// machine a permanently occupied 8787 turned `tdoc-agent-reply posts to .base
// on a hosted config` into an HTTP 401 that looked like a product bug and
// behaved like flake, because whether it fired depended on the draw.
//
// So: never guess a port. Either let the OS assign one (startStub, and the
// default for resolveTarget), or assert an explicit one is free before
// spawning — and say so loudly when it is not.

// Ask the OS for a port nobody is listening on, and hand it over. There is a
// window between the close here and the spawn that follows, so this is only
// for servers that cannot report their own port; prefer startStub otherwise.
function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Refuse to spawn onto a port someone else holds. The point is the message: a
// collision has to name itself here rather than surface as a product failure.
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', (e) => reject(new Error(
      e.code === 'EADDRINUSE'
        ? `port ${port} is already held by another process on this machine, so ` +
          `the test server never bound it and anything the test received would ` +
          `have come from that stranger. Free it (lsof -nP -iTCP:${port} ` +
          `-sTCP:LISTEN) or let the helper assign the port.`
        : `could not probe port ${port}: ${e.message}`)));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
}

// Block without spinning the event loop. The CLI suite's `t()` runs its test
// bodies synchronously, so the stub has to be listening before the next line.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Boot a throwaway HTTP stub for a bash CLI to talk to — synchronously.
//
// `handlerSrc` is the SOURCE of a node request handler, `(q,s)=>{...}`, run in
// a child process. The child binds port 0, so the OS picks a port nobody holds,
// then reports back the port it actually got. Callers read that port off the
// return value: there is nothing to guess, and no readiness poll to get wrong,
// because the port is only published from inside the listen callback.
//
// A refused bind throws here, naming the reason. A child that dies before
// listening throws too, and its stderr is inherited so the cause is visible.
//
// Returns { port, base, stop } — call stop() in a finally.
function startStub(handlerSrc, { timeoutMs = 15000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-stub-'));
  const portFile = path.join(dir, 'port');
  const tmpFile = `${portFile}.tmp`;
  const q = JSON.stringify;
  // Write-then-rename, so the parent can never read a half-written line.
  const src =
    `const fs=require('fs'),http=require('http');` +
    `const report=(t)=>{fs.writeFileSync(${q(tmpFile)},t);fs.renameSync(${q(tmpFile)},${q(portFile)});};` +
    `const srv=http.createServer(${handlerSrc});` +
    `srv.on('error',(e)=>{report('ERROR '+(e.code||'')+' '+e.message);process.exit(1);});` +
    `srv.listen(0,'127.0.0.1',()=>report('PORT '+srv.address().port));`;
  const child = spawn(process.execPath, ['-e', src], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const stop = () => {
    try { child.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let line = '';
    try { line = fs.readFileSync(portFile, 'utf8'); } catch {}
    if (line.startsWith('PORT ')) {
      const port = Number(line.slice(5));
      return { port, base: `http://127.0.0.1:${port}`, stop };
    }
    if (line) {
      stop();
      throw new Error(`stub server failed to listen: ${line.replace(/^ERROR /, '')}`);
    }
    if (Date.now() > deadline) {
      stop();
      throw new Error(`stub server never reported a port within ${timeoutMs}ms — it ` +
        `died before listening; its stderr is above this line`);
    }
    sleepSync(20);
  }
}

// Resolve the target URL + (if local) a started server handle.
// Returns { url, stop } — stop() is a no-op when an external/live URL is used.
//
// `e2eUser` boots the local server with an identity instead of anonymously, so
// author-only chrome (edit, delete, re-anchor) renders at all. The local server
// treats that same login as the doc owner unless TDOC_E2E_OWNER says otherwise,
// which is what makes "the owner still gets no edit on someone else's comment"
// testable against it.
async function resolveTarget({ port, e2eUser } = {}) {
  // Explicit override (live deploy or a custom server) — don't boot anything.
  if (process.env.TDOC_TEST_URL) {
    return { url: process.env.TDOC_TEST_URL, stop: async () => {} };
  }
  // server.js takes its port from TDOC_PORT and cannot report one back, so it
  // gets a reserved port instead of a hardcoded one. A caller-supplied port is
  // checked instead: an occupied one has to fail here, loudly, rather than send
  // the whole browser suite at somebody else's server.
  if (port === undefined) port = await reservePort();
  else await assertPortFree(port);
  // Default: boot the local server against the committed fixture.
  const serverPath = path.join(__dirname, '..', '..', 'server', 'server.js');
  const child = spawn('node', [serverPath], {
    env: {
      ...process.env,
      TDOC_DIR: FIXTURE_ROOT,
      TDOC_PORT: String(port),
      ...(e2eUser ? { TDOC_E2E_USER: e2eUser } : {}),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitForServer(port);
  return {
    url: `http://127.0.0.1:${port}/d/${FIXTURE_SLUG}/v/2`,
    olderUrl: `http://127.0.0.1:${port}/d/${FIXTURE_SLUG}/v/1`,
    stop: async () => { try { child.kill('SIGTERM'); } catch {} },
  };
}

// Standard guard for UI suites: returns playwright or exits 0 with a loud skip.
function requirePlaywrightOrSkip(suiteName) {
  const pw = tryRequirePlaywright();
  if (!pw) {
    console.log(`SKIP (${suiteName}): playwright not installed — run \`npm i -D playwright && npx playwright install chromium\` to enable. This is a LOUD skip, not a silent pass.`);
    process.exit(0);
  }
  return pw;
}

// True when we're testing a real published worker (TDOC_TEST_URL set), false
// when running against the local anonymous fixture server. Published-only UI
// (Share, fork, GitHub sign-in, auth-gated reactions) only exists in worker
// `mode:'published'`, so those assertions must be gated on this.
function isPublishedTarget() {
  return !!process.env.TDOC_TEST_URL;
}

module.exports = {
  resolveTarget, requirePlaywrightOrSkip, isPublishedTarget,
  startStub, reservePort, assertPortFree,
  FIXTURE_ROOT, FIXTURE_SLUG,
};
