// Interactive islands (#138): host CSP stays strict; computation is a
// separately served widget HTML resource that must be framed.
//
// Hermetic: boots the local server. Worker wiring is checked from source
// (same pattern as csp-headers.test.js) because the offline suite cannot
// boot Cloudflare.

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
function request(port, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    req.end();
  });
}
function get(port, p, headers = {}) {
  return request(port, p, { headers });
}

(async () => {
  const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-widget-'));
  const PORT = await freePort();
  const serverPath = path.join(__dirname, '..', 'server', 'server.js');
  const srv = spawn(process.execPath, [serverPath], {
    env: { ...process.env, TDOC_DIR: TMP_DIR, TDOC_PORT: String(PORT), TDOC_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  const shutdown = () => {
    try { srv.kill('SIGKILL'); } catch {}
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', shutdown);
  await waitReady(PORT);
  console.log(`widget-island (hermetic, TDOC_DIR=${TMP_DIR})\n`);

  const SLUG = 'island-fixture';
  const docDir = path.join(TMP_DIR, SLUG);
  fs.mkdirSync(path.join(docDir, 'v1', 'widgets'), { recursive: true });
  fs.writeFileSync(path.join(docDir, 'v1', 'index.html'),
    '<!doctype html><html><head><title>Island fixture</title></head><body>' +
    '<p>Host copy.</p>' +
    '<iframe src="/d/island-fixture/v/1/widget/compound-interest" sandbox="allow-scripts allow-same-origin"></iframe>' +
    '<iframe id="widget-hash" src="/d/island-fixture/v/1/widget/compound-interest#frag" sandbox="allow-scripts allow-same-origin"></iframe>' +
    '<iframe id="widget-trail" src="/d/island-fixture/v/1/widget/compound-interest " sandbox="allow-scripts allow-same-origin"></iframe>' +
    '<iframe id="third-party-chart" src="https://example.com/chart" sandbox="allow-scripts"></iframe>' +
    '<iframe id="foreign-widget-path" src="https://cdn.invalid/widget/compound-interest" sandbox="allow-scripts allow-same-origin"></iframe>' +
    '<iframe id="cross-origin-widget-path" src="https://cdn.invalid/d/island-fixture/v/1/widget/compound-interest" sandbox="allow-scripts allow-same-origin"></iframe>' +
    '</body></html>');
  fs.writeFileSync(path.join(docDir, 'v1', 'widgets', 'compound-interest.html'),
    '<!doctype html><html><body><script>window.__WIDGET__=1;</script><p>widget</p></body></html>');
  fs.writeFileSync(path.join(docDir, 'meta.json'), JSON.stringify({ title: 'Island fixture', versions: [{ n: 1 }] }));
  fs.writeFileSync(path.join(docDir, 'comments.json'), '[]');

  const widgetPath = `/d/${SLUG}/v/1/widget/compound-interest`;

  await t('top-level widget GET is 403 (no Sec-Fetch-Dest)', async () => {
    const res = await get(PORT, widgetPath);
    if (res.status !== 403) throw new Error(`status ${res.status}, expected 403`);
  });

  await t('top-level widget GET with Dest=document is 403', async () => {
    const res = await get(PORT, widgetPath, { 'Sec-Fetch-Dest': 'document' });
    if (res.status !== 403) throw new Error(`status ${res.status}, expected 403`);
  });

  await t('widget GET with Dest=embed is 403', async () => {
    const res = await get(PORT, widgetPath, { 'Sec-Fetch-Dest': 'embed' });
    if (res.status !== 403) throw new Error(`status ${res.status}, expected 403`);
  });

  await t('widget GET with Dest=frame is 403', async () => {
    const res = await get(PORT, widgetPath, { 'Sec-Fetch-Dest': 'frame' });
    if (res.status !== 403) throw new Error(`status ${res.status}, expected 403`);
  });

  let framed;
  await t('framed widget GET returns the author HTML (no overlay)', async () => {
    framed = await get(PORT, widgetPath, { 'Sec-Fetch-Dest': 'iframe' });
    if (framed.status !== 200) throw new Error(`status ${framed.status}`);
    if (!framed.body.includes('window.__WIDGET__=1')) throw new Error('widget script missing');
    if (framed.body.includes('window.__TDOC__') || framed.body.includes('tdoc-bar')) {
      throw new Error('overlay leaked into widget response');
    }
  });

  await t('framed widget CSP allows inline script and forbids framing by others', async () => {
    const csp = framed.headers['content-security-policy'] || '';
    if (!csp.includes("script-src 'unsafe-inline'")) throw new Error(`missing script-src unsafe-inline: ${csp}`);
    if (!csp.includes("default-src 'none'")) throw new Error(`missing default-src none: ${csp}`);
    if (!csp.includes("frame-ancestors 'self'")) throw new Error(`missing frame-ancestors: ${csp}`);
    if (!csp.includes("worker-src 'none'")) throw new Error(`missing worker-src none: ${csp}`);
    if (!csp.includes('sandbox allow-scripts')) throw new Error(`missing CSP sandbox allow-scripts: ${csp}`);
    if (/sandbox[^;]*allow-same-origin/.test(csp)) throw new Error(`CSP sandbox must not allow-same-origin: ${csp}`);
    if (csp.includes('strict-dynamic') || csp.includes('nonce-')) {
      throw new Error(`widget must not use the host nonce CSP: ${csp}`);
    }
  });

  await t('framed widget is not stored and varies on Sec-Fetch-Dest', async () => {
    const cc = framed.headers['cache-control'] || '';
    if (!/\bno-store\b/.test(cc)) throw new Error(`Cache-Control missing no-store: ${cc}`);
    const vary = framed.headers['vary'] || '';
    if (!/Sec-Fetch-Dest/i.test(vary)) throw new Error(`Vary missing Sec-Fetch-Dest: ${vary}`);
  });

  await t('host doc CSP is still the nonce policy (no unsafe-inline)', async () => {
    const res = await get(PORT, `/d/${SLUG}/v/1`);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const csp = res.headers['content-security-policy'] || '';
    if (!/script-src 'nonce-[a-f0-9]+' 'strict-dynamic'/.test(csp)) {
      throw new Error(`host CSP lost nonce policy: ${csp}`);
    }
    if (csp.includes('unsafe-inline')) throw new Error(`host CSP gained unsafe-inline: ${csp}`);
  });

  await t('host doc rewrites widget iframe sandbox to allow-scripts only', async () => {
    const res = await get(PORT, `/d/${SLUG}/v/1`);
    const iframes = [...res.body.matchAll(/<iframe\b([^>]*)>/gi)].map(m => m[0]);
    const widgetIframe = iframes.find(t => t.includes('/d/island-fixture/v/1/widget/'));
    if (!widgetIframe) throw new Error(`widget iframe missing from host doc: ${iframes.join(' | ')}`);
    if (!/sandbox="allow-scripts"/.test(widgetIframe)) throw new Error(`sandbox not forced: ${widgetIframe}`);
    if (/allow-same-origin/.test(widgetIframe)) throw new Error(`allow-same-origin survived: ${widgetIframe}`);
    const other = iframes.find(t => t.includes('id="third-party-chart"'));
    if (!other) throw new Error('non-widget iframe missing');
    if (other.includes('/d/island-fixture/')) throw new Error('confused widget with third-party iframe');
    const foreign = iframes.find(t => t.includes('id="foreign-widget-path"'));
    if (!foreign) throw new Error('foreign /widget/ iframe missing');
    if (!/allow-same-origin/.test(foreign)) throw new Error(`foreign iframe sandbox was rewritten: ${foreign}`);
    const hashed = iframes.find(t => t.includes('id="widget-hash"'));
    if (!hashed) throw new Error('hash widget iframe missing');
    if (!/sandbox="allow-scripts"/.test(hashed)) throw new Error(`hash src sandbox not forced: ${hashed}`);
    if (/allow-same-origin/.test(hashed)) throw new Error(`hash src allow-same-origin survived: ${hashed}`);
    const trailed = iframes.find(t => t.includes('id="widget-trail"'));
    if (!trailed) throw new Error('trailing-space widget iframe missing');
    if (/allow-same-origin/.test(trailed)) throw new Error(`trailing-space src allow-same-origin survived: ${trailed}`);
    const cross = iframes.find(t => t.includes('id="cross-origin-widget-path"'));
    if (!cross) throw new Error('cross-origin widget-path iframe missing');
    if (!/allow-same-origin/.test(cross)) throw new Error(`cross-origin iframe sandbox was rewritten: ${cross}`);
  });

  await t('widget POST is 405; HEAD is framed-only with empty body', async () => {
    const post = await request(PORT, widgetPath, { method: 'POST', headers: { 'Sec-Fetch-Dest': 'iframe' } });
    if (post.status !== 405) throw new Error(`POST status ${post.status}, expected 405`);
    const headBare = await request(PORT, widgetPath, { method: 'HEAD' });
    if (headBare.status !== 403) throw new Error(`HEAD without dest ${headBare.status}, expected 403`);
    const head = await request(PORT, widgetPath, { method: 'HEAD', headers: { 'Sec-Fetch-Dest': 'iframe' } });
    if (head.status !== 200) throw new Error(`HEAD status ${head.status}`);
    if (head.body) throw new Error('HEAD must not send a body');
  });

  await t('invalid widget name is 400', async () => {
    const res = await get(PORT, `/d/${SLUG}/v/1/widget/not_ok`, { 'Sec-Fetch-Dest': 'iframe' });
    if (res.status !== 400) throw new Error(`status ${res.status}, expected 400`);
  });

  const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');

  await t('worker widget route uses widgetCspHeader and does not inject overlay', async () => {
    const s = workerSrc.indexOf('// ---- interactive island');
    if (s < 0) throw new Error('worker widget route comment missing');
    const e = workerSrc.indexOf('// ---- doc view ----', s);
    const body = workerSrc.slice(s, e > s ? e : s + 2500);
    if (!body.includes('widgetCspHeader()')) throw new Error('widget route must set widgetCspHeader()');
    if (body.includes('injectOverlay')) throw new Error('widget route must not inject overlay');
    if (!body.includes('isWidgetFrameRequest')) throw new Error('widget route must reject non-frame Dest');
    if (!body.includes('enforceDocAccess')) throw new Error('widget route must use enforceDocAccess');
    if (!body.includes("'Cache-Control': 'no-store'")) throw new Error('widget route must set Cache-Control no-store');
    if (!body.includes("'Vary': 'Sec-Fetch-Dest'")) throw new Error('widget route must Vary on Sec-Fetch-Dest');
  });

  await t('worker widgetCspHeader unique-origins the widget document', async () => {
    const s = workerSrc.indexOf('function widgetCspHeader');
    if (s < 0) throw new Error('widgetCspHeader missing');
    const body = workerSrc.slice(s, s + 400);
    if (!body.includes('sandbox allow-scripts')) throw new Error('widgetCspHeader must include sandbox allow-scripts');
    if (/sandbox[^"]*allow-same-origin/.test(body)) throw new Error('widget CSP sandbox must not allow-same-origin');
  });

  await t('worker upload writes docs/<slug>/v<n>/widgets/<name>.html', async () => {
    const s = workerSrc.indexOf('const widgets = body.widgets');
    if (s < 0) throw new Error('upload widgets handling missing');
    const body = workerSrc.slice(s, s + 1200);
    if (!body.includes('widgets/${wname}.html') && !body.includes('widgets/${wname}.html')) {
      if (!body.includes('/widgets/')) throw new Error(`upload does not put widget R2 keys: ${body.slice(0, 400)}`);
    }
  });

  await t('worker injectOverlayCfg runs forceWidgetSandbox', async () => {
    const s = workerSrc.indexOf('function injectOverlayCfg');
    const body = workerSrc.slice(s, s + 400);
    if (!body.includes('forceWidgetSandbox(rawHtml)')) {
      throw new Error('injectOverlayCfg must rewrite widget iframes');
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  shutdown();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
