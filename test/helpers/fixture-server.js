// Shared test harness for the browser-driven UI suites (#15).
//
// Before: ui/responsive/dimensions tests defaulted to a hardcoded LIVE deploy
// (tdoc-serenatan.serenatan.workers.dev/d/conway-life/v/2). That meant they (a)
// couldn't run offline, (b) tested the SHIPPED bundle instead of the working
// tree — defeating the pre-push gate — and (c) silently no-op'd when offline.
//
// Now: by default they boot the local server (server/server.js) against the
// committed fixture under test/fixtures/tdocs and target THAT — so they exercise
// the working-tree overlay. The live URL stays available via TDOC_TEST_URL.
//
// Playwright is an optional dep. If it's not installed, callers SKIP LOUDLY
// (clear message, exit 0) rather than crash or silently pass.

const path = require('path');
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

// Resolve the target URL + (if local) a started server handle.
// Returns { url, stop } — stop() is a no-op when an external/live URL is used.
async function resolveTarget({ port = 7991, slug = FIXTURE_SLUG, version = 2 } = {}) {
  // Explicit override (live deploy or a custom server) — don't boot anything.
  // (A slug/version override is for the local fixture server only; an explicit
  // TDOC_TEST_URL already points at a specific doc, so it wins.)
  if (process.env.TDOC_TEST_URL) {
    return { url: process.env.TDOC_TEST_URL, stop: async () => {} };
  }
  // Default: boot the local server against the committed fixture.
  const serverPath = path.join(__dirname, '..', '..', 'server', 'server.js');
  const child = spawn('node', [serverPath], {
    env: { ...process.env, TDOC_DIR: FIXTURE_ROOT, TDOC_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitForServer(port);
  return {
    url: `http://127.0.0.1:${port}/d/${slug}/v/${version}`,
    olderUrl: `http://127.0.0.1:${port}/d/${slug}/v/1`,
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
  FIXTURE_ROOT, FIXTURE_SLUG,
};
