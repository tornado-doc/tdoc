// The homepage's live sheet (landing/tornado-doc, #sheets), as a signed-out
// visitor sees it, desktop and phone: the reader draws the sample
// <table data-tdoc-sheet> as a grid, fetching the sheets viewer only
// because the page holds a sheet; search, a tag filter, sort and the comment
// composer on a cell all work; nothing is written, and the visitor's view is
// kept neither in localStorage nor in the URL. Screenshots:
// TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('landing-sheets-ui.test.js');

const TOKEN = 'landing-upload-token';
const SLUG = 'tornado-doc';
const root = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_TEST_SCREENSHOTS || '';

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) { res.setHeader('content-type', asset.type); return res.end(fs.readFileSync(asset.file)); }
    let body = '';
    req.on('data', (d) => { body += d; });
    await new Promise((resolve) => req.on('end', resolve));
    const headers = { ...req.headers, host: 'tdoc.dev', ...(req.headers.origin ? { origin: 'https://tdoc.dev' } : {}) };
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let out = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) {
      out = Buffer.from(out.toString('utf8')
        .replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path)
        .replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    }
    response.headers.forEach((value, key) => {
      if (!['content-length', 'content-encoding', 'content-security-policy'].includes(key)) res.setHeader(key, value);
    });
    res.statusCode = response.status;
    res.end(out);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  console.log('homepage: the live sample sheet');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = String(typeof input === 'string' ? input : input.url);
    if (u.startsWith('https://api.github.com/')) return new Response('{}', { status: 404 });
    return realFetch(input, init);
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_UPLOAD_TOKEN: TOKEN });
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'landing', SLUG, 'meta.json'), 'utf8'));
  const latest = meta.versions[meta.versions.length - 1].n;
  const html = fs.readFileSync(path.join(root, 'landing', SLUG, `v${latest}`, 'index.html'), 'utf8');
  const up = await worker.fetch(new Request('https://tdoc.dev/api/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, version: 1, html, meta: {
      slug: SLUG, title: meta.title, created: meta.created, versions: [{ n: 1, created: meta.created }],
      access: { visibility: 'public', history_visibility: 'owner', commenting: 'signed_in', allowed_users: [] },
    } }),
  }), env, {});
  if (up.status !== 200) throw new Error(`landing upload: ${up.status} ${await up.text()}`);
  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); } };
  const assert = (c, m) => { if (!c) throw new Error(m); };

  for (const [label, opts] of [['desktop', { viewport: { width: 1280, height: 860 } }], ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
    await t(`${label}: search, tag filter, sort and the comment composer on a cell; nothing written`, async () => {
      const context = await browser.newContext(opts);
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (r) => { const u = new URL(r.url()); requests.push({ method: r.method(), path: u.pathname }); });
      await page.goto(`${base}/`);
      const f = page.frameLocator('iframe');
      await f.locator('h1').first().waitFor({ timeout: 15000 });
      const frame = page.frames().find((x) => x.url().includes('/frame'));
      await f.locator('#sheets .tdoc-sheet .ts-row').first().waitFor({ timeout: 15000 });
      assert(requests.filter((r) => r.path === '/sheets-viewer.js').length === 1, 'the viewer is fetched once, for this page\'s sheet');
      await frame.evaluate(() => document.querySelector('#sheets').scrollIntoView({ block: 'start' }));
      const count = () => frame.evaluate(() => document.querySelector('#sheets .ts-count').textContent);
      assert(await count() === '24 rows', await count());
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOTS, `landing-sheet-${label}.png`) }); }
      // Search.
      await f.getByRole('searchbox', { name: 'Search this sheet' }).fill('billing');
      await frame.waitForFunction(() => /of 24 rows/.test(document.querySelector('#sheets .ts-count').textContent));
      await f.getByRole('searchbox', { name: 'Search this sheet' }).fill('');
      await frame.waitForFunction(() => document.querySelector('#sheets .ts-count').textContent === '24 rows');
      // A tag filter from the column menu.
      await f.getByRole('button', { name: 'Status column menu' }).click();
      await f.getByRole('menuitem', { name: 'Filter…' }).click();
      await f.locator('.ts-pop .ts-val', { hasText: 'Blocked' }).locator('input').check();
      await frame.waitForFunction(() => document.querySelector('#sheets .ts-count').textContent === '3 of 24 rows');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `landing-sheet-filter-${label}.png`) });
      await f.locator('.ts-pop').getByRole('button', { name: 'Clear' }).click();
      // Sort by Points, descending.
      await f.getByRole('button', { name: 'Points column menu' }).click();
      await f.getByRole('menuitem', { name: 'Sort descending' }).click();
      const pts = await frame.evaluate(() => Array.from(document.querySelectorAll('#sheets .ts-row')).map((r) => Number(r.querySelector('[data-c="5"]').textContent)));
      assert(pts.every((v, i) => !i || v <= pts[i - 1]), `sorted: ${pts}`);
      // A signed-out visitor's view is not kept: no storage, no #sheet= hash.
      await page.waitForTimeout(400);
      const kept = await page.evaluate(() => ({ hash: location.hash, keys: Object.keys(localStorage).filter((k) => k.startsWith('tdoc-sheet-view')) }));
      assert(!/sheet=/.test(kept.hash) && !kept.keys.length, `the homepage kept a view: ${JSON.stringify(kept)}`);
      // Comment preview: a cell, its pill, the composer.
      await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'comment');
      await f.locator('#sheets .ts-row[data-i="1"] .ts-c[data-c="0"]').click();
      await f.locator('#sheets .ts-c .tdoc-comment-pill').click();
      await page.locator('.tdoc-popup').waitFor({ timeout: 5000 });
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `landing-sheet-comment-${label}.png`) });
      const writes = requests.filter((r) => !['GET', 'HEAD'].includes(r.method));
      assert(!writes.length, `the homepage wrote: ${JSON.stringify(writes)}`);
      assert(!errors.length, errors.join(' | '));
      await context.close();
    });
  }

  await browser.close();
  server.close();
  globalThis.fetch = realFetch;
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
