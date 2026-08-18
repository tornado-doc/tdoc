// CSP live-browser proof: author <script>/onclick never execute, overlay does.
//
// test/csp-headers.test.js checks the wire contract (header + nonce
// placement) hermetically. This file is the "gold standard" check the
// header-only test can't do: actually load the doc in a real browser and
// observe that window.__XSS__ stays undefined while the overlay (loaded via
// the SAME injection path, just nonced) fully boots and works.
//
// Gated: needs playwright. Skips loudly (exit 0) if it's not installed —
// never a silent pass. Run with: node test/csp-xss.test.js
// (or `node test/run.js --all`).

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('csp-xss.test.js');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, err) { console.log(`  ✗ ${name}\n    ${err}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function waitReady(port, ms = 5000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function probe() {
      const r = http.get({ host: '127.0.0.1', port, path: '/api/ping' }, (res) => { res.resume(); resolve(); });
      r.on('error', () => { if (Date.now() > deadline) reject(new Error('server not ready')); else setTimeout(probe, 100); });
    })();
  });
}

(async () => {
  const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-csp-xss-'));
  const PORT = await freePort();
  const serverPath = path.join(__dirname, '..', 'server', 'server.js');
  const srv = spawn(process.execPath, [serverPath], {
    env: { ...process.env, TDOC_DIR: TMP_DIR, TDOC_PORT: String(PORT), TDOC_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  let browser;
  const shutdown = () => {
    try { srv.kill('SIGKILL'); } catch {}
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', shutdown);
  await waitReady(PORT);

  const SLUG = 'xss-fixture';
  const docDir = path.join(TMP_DIR, SLUG);
  fs.mkdirSync(path.join(docDir, 'v1'), { recursive: true });
  // A realistic-shaped doc: normal commentable content PLUS an author
  // <script> and an inline onclick=, exactly the injection the CSP exists to
  // stop. If either runs, window.__XSS__ flips from undefined.
  fs.writeFileSync(path.join(docDir, 'v1', 'index.html'), `<!doctype html>
<html><head><title>XSS fixture</title></head><body>
  <div class="wrap">
    <h1>XSS fixture</h1>
    <script>window.__XSS__ = 1;</script>
    <p>Some prose above the target block.</p>
    <pre id="target">a commentable code block</pre>
    <button id="xss-btn" onclick="window.__XSS__ = 2">click me</button>
  </div>
</body></html>`);
  fs.writeFileSync(path.join(docDir, 'meta.json'), JSON.stringify({ title: 'XSS fixture', versions: [{ n: 1 }] }));
  fs.writeFileSync(path.join(docDir, 'comments.json'), '[]');

  console.log(`csp-xss (live browser, TDOC_DIR=${TMP_DIR}, port=${PORT})\n`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push(m.text()));

  await page.goto(`http://127.0.0.1:${PORT}/d/${SLUG}/v/1`, { waitUntil: 'networkidle' });

  await t('author <script> tag never executes — window.__XSS__ stays undefined after load', async () => {
    const v = await page.evaluate(() => window.__XSS__);
    if (v !== undefined) throw new Error(`window.__XSS__ = ${v} — author <script> ran, CSP failed to block it`);
  });

  await t('CSP violation was actually reported for the blocked script (proves the browser enforced it, not luck)', async () => {
    const reported = consoleMsgs.some((m) => /content security policy|csp/i.test(m));
    if (!reported) throw new Error(`no CSP violation logged; console had: ${JSON.stringify(consoleMsgs.slice(0, 10))}`);
  });

  await t('author inline onclick= never fires — clicking the button leaves window.__XSS__ undefined', async () => {
    await page.click('#xss-btn');
    await page.waitForTimeout(150);
    const v = await page.evaluate(() => window.__XSS__);
    if (v !== undefined) throw new Error(`window.__XSS__ = ${v} — inline onclick ran, CSP failed to block it`);
  });

  await t('the nonced overlay script DID execute — the tdoc bar renders', async () => {
    await page.waitForSelector('.tdoc-bar', { timeout: 2000 });
    const markSrc = await page.$eval('.tdoc-bar-mark img', (el) => el.getAttribute('src'));
    if (markSrc !== '/tdoc_logo.png') throw new Error('tdoc bar mark is missing the logo — overlay may not have booted');
  });

  await t('commenting still works end-to-end under the CSP (drag INTO the element opens the popup, submit persists)', async () => {
    // Mirrors ui.test.js's canvas drag-to-comment gesture: drag from outside
    // the artifact into it so the mouseup handler resolves an element anchor.
    const pre = await page.$('#target');
    const box = await pre.boundingBox();
    const startX = Math.max(20, box.x - 30);
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForSelector('.tdoc-popup', { timeout: 2000 });
    await page.fill('.tdoc-popup textarea', 'csp smoke comment');
    await page.click('.tdoc-popup .submit');
    await page.waitForSelector('.tdoc-margin-comment', { timeout: 2000 });
  });

  // --- nonce hardening (小cc PR review): a CSP nonce only protects if it is
  // freshly random PER RESPONSE. If it were constant or derived from
  // slug/version, an author could embed that exact nonce on their own <script>
  // and it would run — CSP defeated. The XSS tests above use un-nonced author
  // scripts (trivially blocked); these two test the real threat model: a nonce
  // an attacker HAS. ---
  function fetchCSP(p) {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
        res.resume();
        resolve(res.headers['content-security-policy'] || '');
      }).on('error', reject);
    });
  }
  const nonceOf = (csp) => { const m = csp.match(/'nonce-([^']+)'/); return m && m[1]; };

  let capturedNonce = null;
  await t('nonce is freshly random per response — two requests to the same doc get different nonces', async () => {
    const a = nonceOf(await fetchCSP(`/d/${SLUG}/v/1`));
    const b = nonceOf(await fetchCSP(`/d/${SLUG}/v/1`));
    if (!a || !b) throw new Error(`missing nonce in CSP: a=${a} b=${b}`);
    if (a === b) throw new Error(`nonce reused across responses (${a}) — an author could embed it and bypass CSP`);
    capturedNonce = a;
  });

  await t('author <script> carrying a REAL captured nonce is STILL blocked (per-response-random, non-replayable)', async () => {
    // The insidious case: an author embeds a nonce lifted from a prior response.
    // With a constant/predictable nonce this <script> would EXECUTE. It must not.
    const slug2 = 'xss-nonce-replay';
    const d2 = path.join(TMP_DIR, slug2, 'v1');
    fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d2, 'index.html'), `<!doctype html><html><head><title>replay</title></head><body>
  <div class="wrap"><h1>replay</h1>
  <script nonce="${capturedNonce}">window.__XSS_REPLAY__ = 1;</script>
  <pre id="target">block</pre></div></body></html>`);
    fs.writeFileSync(path.join(TMP_DIR, slug2, 'meta.json'), JSON.stringify({ title: 'replay', versions: [{ n: 1 }] }));
    fs.writeFileSync(path.join(TMP_DIR, slug2, 'comments.json'), '[]');
    const p2 = await browser.newPage();
    await p2.goto(`http://127.0.0.1:${PORT}/d/${slug2}/v/1`, { waitUntil: 'networkidle' });
    const v = await p2.evaluate(() => window.__XSS_REPLAY__);
    await p2.close();
    if (v !== undefined) throw new Error(`window.__XSS_REPLAY__ = ${v} — author reused a captured nonce and the script RAN; nonce is not per-response-random`);
  });

  await browser.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  shutdown();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
