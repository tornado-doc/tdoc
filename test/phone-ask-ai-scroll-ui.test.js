// Phone Ask AI: a long answer can be read to its end, and the document scrolls
// again once the drawer closes. Owner report (2026-10-27): "can't scroll in
// mobile after Ask AI". The comments drawer popup is 100dvh tall and moved down
// by the snap offset (30% at the 0.7 snap), so its scroll area ran past the
// bottom of the screen: the end of a long answer and its Keep / Post buttons
// could never be scrolled into view. Runs in WebKit (iPhone 13) and Chromium
// (Pixel 7, real CDP touch drags) at 390x844.
// Run with: node test/phone-ask-ai-scroll-ui.test.js
const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, issue } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium, webkit, devices } = requirePlaywrightOrSkip('phone-ask-ai-scroll-ui.test.js');
const MODEL = 'https://model.invalid/v1';
const LONG_ANSWER = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}: billing goes first because invoices block two renewals and search can follow.`).join('\n\n');
const DOC = (t) => `<!doctype html><html><body><h1>${t}</h1>${Array.from({ length: 60 }, (_, i) => `<p>Line ${i}: Billing ships first, on March 14, because invoices block two renewals.</p>`).join('')}</body></html>`;
async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((a) => [a.path, a]));
  const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) { res.setHeader('content-type', asset.type); return res.end(fs.readFileSync(asset.file)); }
    let body = ''; req.on('data', (d) => { body += d; }); await new Promise((r) => req.on('end', r));
    const headers = { ...req.headers, host: 'tdoc.dev', ...(req.headers.origin ? { origin: 'https://tdoc.dev' } : {}) };
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let out = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) out = Buffer.from(out.toString('utf8').replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path).replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    response.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'content-security-policy'].includes(k)) res.setHeader(k, v); });
    res.statusCode = response.status; res.end(out);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
(async () => {
  console.log('Phone Ask AI scroll (real shell)');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (!String(u).startsWith(MODEL)) return realFetch(input, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: LONG_ANSWER } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: MODEL });
  const julie = await issue(worker, env, 'julie');
  const reader = await issue(worker, env, 'reader');
  await env.META.delete(`account-terminal:${reader.account_id}`);
  await worker.fetch(new Request('https://tdoc.dev/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${julie.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'long-plan', version: 1, html: DOC('Long plan'), meta: { title: 'Long plan' } }) }), env, {});
  const { server, base } = await startServer(worker, env);
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };
  const touchDrag = async (cdp, page, x, y0, y1) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 12 }] }); await page.waitForTimeout(16); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(700);
  };
  const runs = [['WebKit iPhone', webkit, devices['iPhone 13']], ['Chromium phone', chromium, devices['Pixel 7']]];
  try {
    for (const [label, type, device] of runs) {
      await t(`${label}: a long Ask AI answer scrolls to its end; the document scrolls after closing`, async () => {
        const browser = await type.launch();
        try {
          const touch = type === chromium;
          const context = await browser.newContext({ ...device, viewport: { width: 390, height: 844 }, defaultBrowserType: undefined });
          await context.addCookies([{ name: 'tdoc_sid', value: reader.cookie.split('=')[1], domain: '127.0.0.1', path: '/' }]);
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(`${base}/d/long-plan`);
          await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
          await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
          await page.locator('.tdoc-fab').click();
          await page.getByRole('radio', { name: /Ask AI/ }).click();
          const ask = page.locator('.tdoc-drawer-ask');
          await ask.locator('textarea').fill('Why billing first?');
          await ask.getByRole('button', { name: 'Send question' }).click();
          await ask.getByText('Paragraph 30:').waitFor({ timeout: 15000 });
          await page.waitForTimeout(400);
          const fits = () => page.evaluate(() => {
            const el = document.querySelector('.tdoc-drawer-ask');
            el.scrollTop = el.scrollHeight;
            const post = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Post as comment');
            const r = post.getBoundingClientRect();
            return { scrolls: el.scrollHeight > el.clientHeight, areaBottom: el.getBoundingClientRect().bottom, postBottom: r.bottom, vh: innerHeight, hit: document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 1)) === post };
          });
          const half = await fits();
          if (!half.scrolls) throw new Error('the long answer does not need scrolling; the test lost its point');
          if (half.areaBottom > half.vh + 1 || half.postBottom > half.vh || !half.hit) throw new Error(`end of the answer is below the screen at the first snap: ${JSON.stringify(half)}`);
          if (touch) {
            const cdp = await context.newCDPSession(page);
            await ask.evaluate((el) => { el.scrollTop = 0; });
            await touchDrag(cdp, page, 200, 760, 420);
            const scrolled = await ask.evaluate((el) => el.scrollTop);
            if (scrolled < 100) throw new Error(`a touch drag did not scroll the answer: scrollTop ${scrolled}`);
            // Full screen: drag the handle up; the answer still ends on screen.
            const handle = await page.locator('.tdoc-drawer-handle').boundingBox();
            await touchDrag(cdp, page, 195, handle.y + 2, 20);
            const top = await page.locator('#tdoc-comment-layer').evaluate((el) => el.getBoundingClientRect().top);
            if (top > 40) throw new Error(`drawer did not go full screen: top ${top}`);
            const full = await fits();
            if (full.areaBottom > full.vh + 1 || !full.hit) throw new Error(`end of the answer is below the screen at full height: ${JSON.stringify(full)}`);
          }
          await page.locator('.tdoc-drawer-handle').tap();
          await page.locator('#tdoc-comment-layer').waitFor({ state: 'detached' });
          const lock = await page.evaluate(() => [document.documentElement, document.body].map((el) => getComputedStyle(el).overflow).join(' '));
          if (lock.includes('hidden')) throw new Error(`scroll lock kept after closing: ${lock}`);
          const frame = page.frames().find((f) => f !== page.mainFrame());
          if (touch) {
            const cdp = await context.newCDPSession(page);
            const before = await frame.evaluate(() => scrollY);
            await touchDrag(cdp, page, 200, 650, 300);
            const after = await frame.evaluate(() => scrollY);
            if (after - before < 100) throw new Error(`a touch drag did not scroll the document after closing: ${before} -> ${after}`);
          } else {
            const after = await frame.evaluate(() => { scrollTo(0, 400); return scrollY; });
            if (after < 300) throw new Error(`document does not scroll after closing: ${after}`);
          }
          if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
        } finally { await browser.close(); }
      });
    }
  } finally { server.close(); }
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
