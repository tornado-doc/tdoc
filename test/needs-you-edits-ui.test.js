// Needs you: "Review N edits" (Julie, 11-14: items say what to do; there was
// "Review N agent replies" but nothing for suggested edits). A doc holding
// suggestions waiting on this person is one item on My docs, desktop and phone
// alike: "Review 2 edits", the Sparkles mark the doc's review bar carries,
// linking to the doc as it is now with the review open (/d/<slug>?suggestions=1:
// the first suggestion scrolled to, the address cleaned). Deciding them takes
// the item away; Mark done does too, until new edits arrive. Dev mode only, as
// suggestions are. Real worker (in-process harness), real built shell, Chromium.
// Run with: node test/needs-you-edits-ui.test.js   (TDOC_UI_SHOTS=<dir> for screenshots)
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('needs-you-edits-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const filler = Array.from({ length: 30 }, (_, i) => `<p>Filler paragraph ${i} that pushes the plan down the page.</p>`).join('');
const page1 = `<!doctype html><html><body><h1>Plan</h1>${filler}<p id="a">Alpha sentence of the plan.</p><p id="b">Beta sentence of the plan.</p></body></html>`;

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((a) => [a.path, a]));
  const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) { res.setHeader('content-type', asset.type); return res.end(fs.readFileSync(asset.file)); }
    const chunks = [];
    try { for await (const chunk of req) chunks.push(chunk); } catch { return; }
    const headers = { ...req.headers, host: 'tdoc.dev', ...(req.headers.origin ? { origin: 'https://tdoc.dev' } : {}) };
    delete headers.referer;
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: 'manual' }), env, { waitUntil() {} });
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
  console.log('Needs you: Review N edits');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: 'https://model.invalid/v1', TDOC_DEBUG_ACCOUNTS: 'julie@tdoc.test' });
  const sid = 'b'.repeat(32);
  await env.META.put(`session:${sid}`, JSON.stringify({ login: 'julie', name: 'Julie', email: 'julie@tdoc.test', avatar_url: '', created: new Date().toISOString() }));
  const cookie = `tdoc_sid=${sid}`;
  const minted = await (await worker.fetch(new Request('https://tdoc.dev/api/hosted/token', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'julie' }) }), env, {})).json();
  const token = minted.token;
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const newDoc = async (slug, title) => assert.equal((await api('/api/upload', { method: 'POST', token, body: { slug, version: 1, html: page1, meta: { title } } })).status, 200);
  const propose = async (slug, edits) => {
    const r = await api(`/api/docs/${slug}/suggestions`, { method: 'POST', token, body: { edits, agent_login: 'claude', agent_name: 'Claude' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.suggestion;
  };
  await newDoc('edits-plan', 'Edits plan');
  await newDoc('quiet-doc', 'Quiet doc');
  await propose('edits-plan', [{ find: 'Alpha sentence of the plan.', replace: 'Alpha line of the plan.' }, { find: 'Beta sentence of the plan.', replace: 'Beta line of the plan.' }]);

  const { server, base } = await startServer(worker, env);
  const browser = await pw.chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/${name}` }); } };
  const open = async (phone = false) => {
    const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
    await ctx.addCookies([{ name: 'tdoc_sid', value: sid, url: base }]);
    await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { ctx, page, errors };
  };
  const item = (page, slug) => page.locator(`.mda-needs .mda-need[data-slug="${slug}"]`).first();

  try {
    for (const phone of [false, true]) {
      await t(`${phone ? 'phone 390' : '1440'}: "Review 2 edits" in the doc, the review bar's mark, linking to the doc with the review open`, async () => {
        const { ctx, page, errors } = await open(phone);
        await page.goto(`${base}/me`);
        const it = item(page, 'edits-plan');
        await it.waitFor({ timeout: 15000 });
        assert.equal(await it.getAttribute('data-kind'), 'edits');
        assert.equal(await it.locator('.mda-need-action').textContent(), 'Review 2 edits');
        assert.equal(await it.locator('.mda-need-title').textContent(), 'Edits plan');
        assert.equal(await it.locator('.mda-need-link').getAttribute('href'), '/d/edits-plan?suggestions=1');
        assert.equal(await it.locator('.mda-need-avatar.is-mark svg').count(), 1);
        assert.equal(await it.locator('.mda-need-more').count(), 0, 'the count is in the words, not "+1 more"');
        assert.equal(await item(page, 'quiet-doc').count(), 0);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `overflows by ${overflow}`);
        await shot(page, `needs-you-edits-${phone ? 'phone' : 'desktop'}.png`);
        await it.locator('.mda-need-link').click();
        await page.waitForURL(/\/d\/edits-plan/, { timeout: 10000 });
        const bar = page.locator('.tdoc-suggest-bar');
        await bar.waitFor({ timeout: 15000 });
        assert.match(await bar.innerText(), /1 of 2/);
        // Scrolled to the first one, far down the page (the frame scrolls itself).
        const frame = page.frames().find((f) => f !== page.mainFrame());
        await frame.waitForFunction(() => {
          const el = document.querySelector('[data-tdoc-sugg-active]');
          if (!el) return false;
          const top = el.getBoundingClientRect().top;
          return window.scrollY > 0 && top >= 0 && top < window.innerHeight;
        }, null, { timeout: 8000 });
        assert.doesNotMatch(page.url(), /suggestions=1/, 'the address keeps no trace');
        await shot(page, `needs-you-edits-opened-${phone ? 'phone' : 'desktop'}.png`);
        assert.deepEqual(errors, []);
        await ctx.close();
      });
    }

    await t('deciding them takes the item away', async () => {
      const { ctx, page } = await open(false);
      await page.goto(`${base}/d/edits-plan?suggestions=1`);
      const bar = page.locator('.tdoc-suggest-bar');
      await bar.waitFor({ timeout: 15000 });
      await bar.getByRole('button', { name: 'Accept all' }).click();
      await page.waitForURL(/\/d\/edits-plan\/v\/2$/, { timeout: 10000 });
      await page.goto(`${base}/me`);
      await page.locator('.mda').first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(800);
      assert.equal(await item(page, 'edits-plan').count(), 0);
      await ctx.close();
    });

    await t('Mark done takes it away until new edits arrive', async () => {
      await propose('quiet-doc', [{ find: 'Alpha sentence of the plan.', replace: 'Alpha, edited.' }]);
      const { ctx, page } = await open(false);
      await page.goto(`${base}/me`);
      const it = item(page, 'quiet-doc');
      await it.waitFor({ timeout: 15000 });
      assert.equal(await it.locator('.mda-need-action').textContent(), 'Review 1 edit');
      await it.locator('.mda-need-done').click();
      await it.waitFor({ state: 'detached', timeout: 5000 });
      await page.waitForTimeout(500);
      await page.reload();
      await page.locator('.mda').first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(800);
      assert.equal(await item(page, 'quiet-doc').count(), 0, 'stays done');
      await propose('quiet-doc', [{ find: 'Beta sentence of the plan.', replace: 'Beta, edited.' }]);
      await page.reload();
      await item(page, 'quiet-doc').waitFor({ timeout: 15000 });
      assert.equal(await item(page, 'quiet-doc').locator('.mda-need-action').textContent(), 'Review 2 edits');
      await ctx.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
