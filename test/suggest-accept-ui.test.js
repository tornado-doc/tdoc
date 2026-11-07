// A suggestion's Accept and the list behind the review bar, in the real shell
// against the real worker (Julie, on a live doc: Accept showed a version conflict
// and "nothing pending", and the page wanted refreshing):
//   - a refused Accept says what happened in words, publishes nothing, the bar
//     stays true, and pressing again only repeats it.
//   - a row already decided or replaced leaves silently; no suggestions left, no bar.
//   - any Accept or Reject re-lists; so do coming back to the page and its quiet
//     sync, so edits nobody here was waiting for appear without a refresh.
//   - Accept lands on /v/N showing the new text, no refresh.
//   - a page overtaken by a newer version offers that version for suggestions it
//     cannot show.
// Run with: node test/suggest-accept-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('suggest-accept-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const page1 = (a, b) => `<!doctype html><html><body><h1>Plan</h1><p id="a">${a}</p><p id="b">${b}</p></body></html>`;

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
  console.log('a suggestion\'s Accept and the list behind the review bar');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: 'https://model.invalid/v1', TDOC_DEBUG_ACCOUNTS: 'julie@tdoc.test' });
  const sid = 'a'.repeat(32);
  await env.META.put(`session:${sid}`, JSON.stringify({ login: 'julie', name: 'julie', email: 'julie@tdoc.test', avatar_url: '', created: new Date().toISOString() }));
  const cookie = `tdoc_sid=${sid}`;
  const minted = await (await worker.fetch(new Request('https://tdoc.dev/api/hosted/token', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'julie' }) }), env, {})).json();
  const token = minted.token;
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  let docN = 0;
  const A = 'Alpha sentence of the plan.';
  const B = 'Beta sentence of the plan.';
  const newDoc = async () => {
    const slug = `accept-ui-${++docN}`;
    assert.equal((await api('/api/upload', { method: 'POST', token, body: { slug, version: 1, html: page1(A, B), meta: { title: 'Plan' } } })).status, 200);
    return slug;
  };
  const publish = (slug, n, a, b) => api('/api/upload', { method: 'POST', token, body: { slug, version: n, html: page1(a, b), meta: { title: 'Plan', versions: [{ n, created: new Date().toISOString() }] } } });
  const propose = async (slug, find, replace) => {
    const r = await api(`/api/docs/${slug}/suggestions`, { method: 'POST', token, body: { edits: [{ find, replace }], agent_login: 'claude', agent_name: 'Claude' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.suggestion;
  };
  const decide = (slug, set, what) => api(`/api/docs/${slug}/suggestions/${set.id}/${what}`, { method: 'POST', cookie, body: {} });

  const { server, base } = await startServer(worker, env);
  const browser = await pw.chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/${name}` }); } };

  const open = async (slug, { phone = false } = {}) => {
    const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([{ name: 'tdoc_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
    await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    const page = await ctx.newPage();
    const lists = [];
    page.on('request', (r) => { if (r.method() === 'GET' && new RegExp(`/api/docs/${slug}/suggestions$`).test(new URL(r.url()).pathname)) lists.push(Date.now()); });
    await page.goto(`${base}/d/${slug}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    return { ctx, page, lists, frame: page.frameLocator('iframe') };
  };
  const bar = (v) => v.page.locator('.tdoc-suggest-bar');
  const toast = (v) => v.page.locator('[role=status], [role=alert], .tdoc-toast');
  // As a browser reports coming back; 2s apart at most counts once.
  const comeBack = async (v) => { await v.page.waitForTimeout(2100); await v.page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
  const accept = (v) => bar(v).getByRole('button', { name: 'Accept', exact: true }).click();

  try {
    for (const [code, words] of [['version_conflict', /document just changed, so nothing was published/], ['save_in_progress', /Another save is finishing, so nothing was published/]]) {
      await t(`${code}: words, not the code; nothing published; the list is read again; pressing again only repeats it`, async () => {
        const slug = await newDoc();
        await propose(slug, A, 'Alpha accepted.');
        const v = await open(slug);
        await bar(v).waitFor({ timeout: 10000 });
        await v.page.route(/\/suggestions\/[^/]+\/accept$/, (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: code, latestVersion: 1 }) }));
        for (let press = 0; press < 2; press++) {
          const before = v.lists.length;
          await accept(v);
          await v.page.getByText(words).first().waitFor({ timeout: 5000 });
          await v.page.waitForFunction(() => !document.querySelector('.tdoc-suggest-bar button[disabled][data-suggest-accept]'));
          for (let i = 0; i < 20 && v.lists.length === before; i++) await v.page.waitForTimeout(100);
          assert.ok(v.lists.length > before, 're-listed after the failure');
        }
        assert.equal(await v.page.getByText(code).count(), 0, 'the raw code is not shown');
        await bar(v).waitFor();
        assert.match(v.page.url(), new RegExp(`/d/${slug}$`));
        const meta = JSON.parse(env.META.map.get(`meta:${slug}`));
        assert.equal(meta.versions.length, 1, 'nothing published');
        await v.ctx.close();
      });
    }

    await t('nothing_pending: the decided row leaves without a word, and the bar goes when none remain', async () => {
      const slug = await newDoc();
      const set = await propose(slug, A, 'Alpha accepted.');
      const v = await open(slug);
      await bar(v).waitFor({ timeout: 10000 });
      assert.equal((await decide(slug, set, 'reject')).status, 200);
      await accept(v);
      await bar(v).waitFor({ state: 'detached', timeout: 5000 });
      await v.frame.locator('ins').waitFor({ state: 'detached', timeout: 5000 });
      assert.equal(await v.page.getByText(/nothing_pending|nothing pending/i).count(), 0);
      assert.equal(await toast(v).filter({ hasText: /could not|try again/i }).count(), 0, 'nothing to say');
      assert.equal(JSON.parse(env.META.map.get(`meta:${slug}`)).versions.length, 1);
      await v.ctx.close();
    });

    await t('one set decided elsewhere: its row goes, the live one stays', async () => {
      const slug = await newDoc();
      const stale = await propose(slug, A, 'Alpha alphaword.');
      await propose(slug, B, 'Beta betaword.');
      const v = await open(slug);
      await v.frame.locator('ins').nth(1).waitFor({ timeout: 10000 });
      await v.frame.locator('ins', { hasText: 'alphaword' }).waitFor();
      assert.equal((await decide(slug, stale, 'reject')).status, 200);
      await comeBack(v);
      await v.frame.locator('ins', { hasText: 'alphaword' }).waitFor({ state: 'detached', timeout: 5000 });
      await v.frame.locator('ins', { hasText: 'betaword' }).waitFor();
      await bar(v).waitFor();
      await v.ctx.close();
    });

    await t('a re-list that adds a set keeps the highlight on the suggestion under review', async () => {
      const slug = await newDoc();
      await propose(slug, A, 'Alpha alphaword.');
      const v = await open(slug);
      await v.frame.locator('[data-tdoc-sugg-active]').first().waitFor({ timeout: 10000 });
      await propose(slug, B, 'Beta betaword.');
      await comeBack(v);
      await v.frame.locator('ins', { hasText: 'betaword' }).waitFor({ timeout: 5000 });
      await v.frame.locator('[data-tdoc-sugg-active]').first().waitFor({ timeout: 3000 });
      assert.match(await v.frame.locator('[data-tdoc-sugg-active]').first().innerText(), /Alpha|alphaword/);
      await v.ctx.close();
    });

    await t('coming back to the page shows edits nobody here was waiting for, without a refresh', async () => {
      const slug = await newDoc();
      const v = await open(slug);
      assert.equal(await bar(v).count(), 0);
      await propose(slug, A, 'Alpha from an agent.');
      await comeBack(v);
      await bar(v).waitFor({ timeout: 5000 });
      await v.frame.locator('ins', { hasText: 'agent' }).waitFor();
      await v.ctx.close();
    });

    await t('the quiet sync brings them too, with the page left alone', async () => {
      const slug = await newDoc();
      const v = await open(slug);
      await propose(slug, A, 'Alpha from an agent.');
      await bar(v).waitFor({ timeout: 30000 });
      await v.ctx.close();
    });

    await t('Accept lands on /v/N with the new text and no refresh, and other sets are read again there', async () => {
      const slug = await newDoc();
      await propose(slug, A, 'Alpha accepted.');
      await propose(slug, B, 'Beta waits.');
      const v = await open(slug);
      await v.frame.locator('ins').nth(1).waitFor({ timeout: 10000 });
      const before = v.lists.length;
      await accept(v);
      await v.page.waitForURL(new RegExp(`/d/${slug}/v/2$`), { timeout: 8000 });
      assert.ok(v.lists.length > before, 're-listed');
      await v.page.frameLocator('iframe').locator('#a', { hasText: 'accepted' }).first().waitFor({ timeout: 10000 });
      await bar(v).waitFor({ timeout: 10000 });
      await v.ctx.close();
    });

    for (const phone of [false, true]) {
      await t(`overtaken at ${phone ? 390 : 1280}: suggestions for a newer version offer it; the page's own text is untouched`, async () => {
        const slug = await newDoc();
        const v = await open(slug, { phone });
        assert.equal((await publish(slug, 2, A, 'Beta rewritten by v2.')).status, 200);
        await propose(slug, 'Beta rewritten by v2.', 'Beta accepted.');
        await comeBack(v);
        const offer = bar(v).getByRole('button', { name: 'Open v2' });
        await offer.waitFor({ timeout: 5000 });
        assert.match(await bar(v).innerText(), /1 suggestion is on v2/);
        assert.equal(await v.frame.locator('ins').count(), 0);
        const overflow = await v.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `overflows by ${overflow}`);
        await shot(v.page, `suggest-overtaken-${phone ? 'phone' : 'desktop'}.png`);
        await offer.click();
        await v.page.waitForURL(new RegExp(`/d/${slug}/v/2$`), { timeout: 8000 });
        await v.page.frameLocator('iframe').locator('ins', { hasText: 'accepted' }).waitFor({ timeout: 10000 });
        await bar(v).getByRole('button', { name: 'Accept', exact: true }).waitFor();
        await shot(v.page, `suggest-review-${phone ? 'phone' : 'desktop'}.png`);
        await v.ctx.close();
      });
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
