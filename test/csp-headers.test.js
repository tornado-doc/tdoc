// CSP header + nonce plumbing — hermetic, no browser needed.
//
// 2026-08-13: browser owner mutations (DELETE /api/doc, PATCH /api/doc/access)
// now authorize off the owner's session cookie alone (authorizeOwnerMutation,
// see jul36-owner-manage.test.js). That's only safe because every doc-serving
// response carries a CSP that blocks author <script>/onclick content — a doc
// can't ride the cookie into those routes anymore. This file checks the wire
// contract: the header is present with a nonce, and the overlay's OWN
// injected <script> tags carry that exact nonce (so they — and only they —
// are allowed to run). The actual "does the browser really block it" check
// (needs a real DOM) lives in test/csp-xss.test.js (gated: playwright).
//
// Covers the local server (server/server.js). worker.js runs the identical
// cspHeader()/injectOverlayCfg() logic — see server/overlay.js's nonce
// plumbing comment; no live Cloudflare deploy needed to trust the shared code
// path, but see csp-xss.test.js's fixture-server boot for the local proof.

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

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
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    }).on('error', reject);
  });
}

(async () => {
  const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-csp-'));
  const PORT = await freePort();
  const serverPath = path.join(__dirname, '..', 'server', 'server.js');
  const srv = spawn(process.execPath, [serverPath], {
    env: { ...process.env, TDOC_DIR: TMP_DIR, TDOC_PORT: String(PORT), TDOC_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  const shutdown = () => { try { srv.kill('SIGKILL'); } catch {} try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {} };
  process.on('exit', shutdown);
  await waitReady(PORT);
  console.log(`csp headers (hermetic, TDOC_DIR=${TMP_DIR})\n`);

  const SLUG = 'csp-fixture';
  const docDir = path.join(TMP_DIR, SLUG);
  fs.mkdirSync(path.join(docDir, 'v1'), { recursive: true });
  // The doc under test embeds an author <script> and an inline onclick= — the
  // exact shape the CSP must neutralize. This file only checks headers/markup
  // (no JS execution); csp-xss.test.js drives this same shape in a real
  // browser and asserts the payload never runs.
  fs.writeFileSync(path.join(docDir, 'v1', 'index.html'),
    '<!doctype html><html><head><title>CSP fixture</title></head><body>' +
    '<script>window.__XSS__=1;</script>' +
    '<button id="xss-btn" onclick="window.__XSS__=2">click</button>' +
    '<p>hello</p></body></html>');
  fs.writeFileSync(path.join(docDir, 'meta.json'), JSON.stringify({ title: 'CSP fixture', versions: [{ n: 1 }] }));
  fs.writeFileSync(path.join(docDir, 'comments.json'), '[]');

  let res;
  await t('doc response carries a Content-Security-Policy header', async () => {
    res = await get(PORT, `/d/${SLUG}/v/1`);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const csp = res.headers['content-security-policy'];
    if (!csp) throw new Error('no Content-Security-Policy header');
  });

  let nonce;
  await t('CSP blocks author scripts (no unsafe-inline) and locks down object-src/base-uri', async () => {
    const csp = res.headers['content-security-policy'];
    const m = /script-src 'nonce-([a-f0-9]+)' 'strict-dynamic'/.exec(csp);
    if (!m) throw new Error(`CSP script-src missing/malformed nonce directive: ${csp}`);
    nonce = m[1];
    if (nonce.length < 16) throw new Error(`nonce looks too short/predictable: ${nonce}`);
    if (csp.includes('unsafe-inline')) throw new Error("CSP must not include 'unsafe-inline' (would re-allow inline scripts/handlers)");
    if (!csp.includes("object-src 'none'")) throw new Error("CSP must set object-src 'none'");
    if (!csp.includes("base-uri 'none'")) throw new Error("CSP must set base-uri 'none'");
  });

  await t('a fresh nonce is generated per response (not reused across requests)', async () => {
    const res2 = await get(PORT, `/d/${SLUG}/v/1`);
    const m2 = /script-src 'nonce-([a-f0-9]+)'/.exec(res2.headers['content-security-policy']);
    if (!m2) throw new Error('second response missing nonce');
    if (m2[1] === nonce) throw new Error('nonce was reused across two separate responses — must be per-request random');
  });

  await t('both overlay-injected <script> tags carry the CSP nonce', async () => {
    const scriptTags = [...res.body.matchAll(/<script([^>]*)>/g)];
    // Expect: window.__TDOC__ boot script + the overlay bundle script — both
    // injected by injectOverlay()/injectOverlayCfg(), both nonced.
    const nonced = scriptTags.filter(m => m[1].includes(`nonce="${nonce}"`));
    if (nonced.length < 2) {
      throw new Error(`expected >=2 nonced <script> tags (boot cfg + overlay bundle), found ${nonced.length} of ${scriptTags.length} total`);
    }
  });

  await t('the author <script> in the doc body does NOT carry the nonce (stays inert under the CSP)', async () => {
    const idx = res.body.indexOf('window.__XSS__=1');
    if (idx < 0) throw new Error('fixture author script not found in response body — test setup broken');
    const tagStart = res.body.lastIndexOf('<script', idx);
    const tagOpenEnd = res.body.indexOf('>', tagStart);
    const openTag = res.body.slice(tagStart, tagOpenEnd + 1);
    if (openTag.includes('nonce=')) throw new Error(`author <script> must not carry a nonce: ${openTag}`);
  });

  await t('the author onclick= attribute is left as plain markup (CSP blocks it at execution time, not by stripping)', async () => {
    if (!res.body.includes('onclick="window.__XSS__=2"')) {
      throw new Error('fixture onclick handler not found — test setup broken, or something is now stripping it (unexpected either way)');
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  shutdown();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
