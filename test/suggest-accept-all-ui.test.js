// "Accept all" in the real shell against the real worker (Julie, 11-16, on a
// live doc: after Accept all, suggestions still showed). Each set was its own
// publish, back to back; with KV a step behind (as Cloudflare's can be for up
// to a minute) the later ones were refused (save_in_progress) and stayed
// pending on the version the page moved to. Now Accept all is one call and
// one version:
//   - four sets from an agent, KV lagging: Accept all lands on /v/2 with every
//     edit in, no bar, no marks, nothing pending, one version made.
//   - the same edit proposed twice (a copy held back behind its twin) is
//     accepted with it, and never comes back.
// Run with: node test/suggest-accept-all-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const pw = requirePlaywrightOrSkip('suggest-accept-all-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const P = ['Alpha sentence of the plan.', 'Beta sentence of the plan.', 'Gamma sentence of the plan.', 'Delta sentence of the plan.'];
const page1 = (ps) => `<!doctype html><html><body><h1>Plan</h1>${ps.map((p, i) => `<p id="p${i}">${p}</p>`).join('')}</body></html>`;
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
  console.log('Accept all: one version, nothing left pending');
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
  // KV a step behind: a read of a doc's record within 5s of a write is the one before it.
  const lag = new Map();
  const get0 = env.META.get.bind(env.META);
  const put0 = env.META.put.bind(env.META);
  env.META.get = async (k) => (k.startsWith('meta:') && lag.has(k) && Date.now() - lag.get(k).at < 5000 ? lag.get(k).old : get0(k));
  env.META.put = async (k, v, o) => {
    if (k.startsWith('meta:') && env.META.map.has(k) && !(lag.has(k) && Date.now() - lag.get(k).at < 5000)) lag.set(k, { old: env.META.map.get(k), at: Date.now() });
    return put0(k, v, o);
  };
  let docN = 0;
  const newDoc = async () => {
    const slug = `accept-all-${++docN}`;
    assert.equal((await api('/api/upload', { method: 'POST', token, body: { slug, version: 1, html: page1(P), meta: { title: 'Plan' } } })).status, 200);
    return slug;
  };
  const propose = async (slug, edits) => {
    const r = await api(`/api/docs/${slug}/suggestions`, { method: 'POST', token, body: { edits, agent_login: 'claude', agent_name: 'Claude' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.suggestion;
  };
  const { server, base } = await startServer(worker, env);
  const browser = await pw.chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/${name}` }); } };
  const open = async (slug, { phone = false } = {}) => {
    const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => { window.__TDOC_FLAGS__ = { ...(window.__TDOC_FLAGS__ || {}), modelessEdit: false }; });
    await ctx.addCookies([{ name: 'tdoc_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
    await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    const page = await ctx.newPage();
    await page.goto(`${base}/d/${slug}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    return { ctx, page, frame: page.frameLocator('iframe') };
  };
  const bar = (v) => v.page.locator('.tdoc-suggest-bar');
  const pendingNow = async (slug) => (await api(`/api/docs/${slug}/suggestions`, { cookie })).body.suggestions.length;

  try {
    for (const phone of [false, true]) {
      await t(`four sets, KV behind, at ${phone ? 390 : 1280}: Accept all lands every edit on /v/2; no bar, no marks, nothing pending`, async () => {
        const slug = await newDoc();
        for (let i = 0; i < 4; i++) await propose(slug, [{ find: P[i], replace: P[i].replace('sentence', 'line') }]);
        const v = await open(slug, { phone });
        await v.frame.locator('ins').nth(3).waitFor({ timeout: 10000 });
        assert.match(await bar(v).innerText(), /1 of 4/);
        await shot(v.page, `accept-all-before-${phone ? 'phone' : 'desktop'}.png`);
        await bar(v).getByRole('button', { name: 'Accept all' }).click();
        await v.page.waitForURL(new RegExp(`/d/${slug}/v/2$`), { timeout: 10000 });
        await v.frame.locator('#p3', { hasText: 'Delta line' }).waitFor({ timeout: 10000 });
        await v.page.waitForTimeout(1500);
        assert.equal(await bar(v).count(), 0, 'the review bar is gone');
        assert.equal(await v.frame.locator('ins, del').count(), 0, 'no suggestion marks');
        for (let i = 0; i < 4; i++) assert.match(await v.frame.locator(`#p${i}`).innerText(), /line of the plan/);
        assert.equal(await pendingNow(slug), 0, 'nothing pending on the server');
        assert.equal(JSON.parse(env.META.map.get(`meta:${slug}`)).versions.length, 2, 'one version for all of them');
        await shot(v.page, `accept-all-after-${phone ? 'phone' : 'desktop'}.png`);
        await v.ctx.close();
      });
    }

    await t('an edit proposed twice: Accept all takes the copy with its twin, and it never comes back', async () => {
      const slug = await newDoc();
      await propose(slug, [{ find: P[0], replace: `${P[0]} More.` }]);
      await propose(slug, [{ find: P[0], replace: `${P[0]} More.` }, { find: P[1], replace: 'Beta line.' }]);
      const v = await open(slug);
      await v.frame.locator('ins').nth(1).waitFor({ timeout: 10000 });
      await bar(v).getByRole('button', { name: 'Accept all' }).click();
      await v.page.waitForURL(new RegExp(`/d/${slug}/v/2$`), { timeout: 10000 });
      await v.frame.locator('#p1', { hasText: 'Beta line.' }).waitFor({ timeout: 10000 });
      await v.page.waitForTimeout(1500);
      assert.equal(await bar(v).count(), 0, 'the copy does not come back for review');
      assert.equal(await v.frame.locator('ins').count(), 0);
      assert.equal(await v.frame.locator('#p0').innerText(), `${P[0]} More.`, 'added once');
      assert.equal(await pendingNow(slug), 0);
      await v.ctx.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
