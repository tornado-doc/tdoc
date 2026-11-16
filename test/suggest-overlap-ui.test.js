// Several pending suggestions on the same list item (Julie, 2026-11-16): the
// same agent proposing one edit again and again, and edits whose finds
// overlap. Each pending suggestion shows once, never inside another one's
// marks; a later one that overlaps an earlier one is left out of the review
// (the frame reports it not shown) instead of striking the same words again.
// Accept and reject still settle each one alone; rejecting one rejects its
// exact copies, and what it held back then shows; accepting publishes.
// Run with: node test/suggest-overlap-ui.test.js

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('suggest-overlap-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const SLUG = 'handover';
const LEAD = '换代码前确认 agent 真的停了。';
const ITEM = '换题的时机：agent 明确交给评审（说做完了、提交了），或一段时间没有动作（比如 20 分钟没有模型调用，没做出来也算）。这时评审那边自动放出下一题，容器不重启。';
const ITEM_NEW = '换题的时机：agent 明确交给评审，或 20 分钟没有模型调用。评审那边随即放出下一题，容器不重启。';
const DOC = `<!doctype html><html><body><h1>Handover</h1><ol><li id="one">First item stays as it is.</li><li id="two"><mark>${LEAD}</mark>${ITEM}</li></ol><p id="after">下一题的起点含上一题的真实答案。</p></body></html>`;

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
  console.log('Suggestions on the same text: each shows once, none inside another');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: 'https://model.invalid/v1', TDOC_DEBUG_ACCOUNTS: 'julie@tdoc.test' });
  const sid = 'b'.repeat(32);
  await env.META.put(`session:${sid}`, JSON.stringify({ login: 'julie', name: 'julie', email: 'julie@tdoc.test', avatar_url: '', created: new Date().toISOString() }));
  const minted = await (await worker.fetch(new Request('https://tdoc.dev/api/hosted/token', { method: 'POST', headers: { cookie: `tdoc_sid=${sid}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'julie' }) }), env, {})).json();
  const up = await worker.fetch(new Request('https://tdoc.dev/api/upload', { method: 'POST', headers: { Authorization: `Bearer ${minted.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: SLUG, version: 1, html: DOC, meta: { title: 'Handover' } }) }), env, {});
  assert.equal(up.status, 200);

  // Writes as the agent's token; reads as the signed-in person (the list is the browser's).
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.method && o.method !== 'GET' ? { Authorization: `Bearer ${minted.token}` } : { cookie: `tdoc_sid=${sid}`, origin: 'https://tdoc.dev' }), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const propose = async (slug, find, replace) => {
    const r = await api(`/api/docs/${slug}/suggestions`, { method: 'POST', body: { edits: [{ find, replace }], agent_login: 'claude', agent_name: 'Claude' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.suggestion;
  };
  let docN = 0;
  const newDoc = async () => {
    const slug = `${SLUG}-${++docN}`;
    assert.equal((await api('/api/upload', { method: 'POST', body: { slug, version: 1, html: DOC, meta: { title: 'Handover' } } })).status, 200);
    return slug;
  };

  const { server, base } = await startServer(worker, env);
  const browser = await pw.chromium.launch({ headless: true });
  const webkit = await pw.webkit.launch({ headless: true }).catch(() => null);
  const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack}`); } };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/${name}` }); } };
  const open = async (phone, which = browser, slug = SLUG) => {
    const ctx = await which.newContext(phone ? PHONE : { viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([{ name: 'tdoc_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
    const page = await ctx.newPage();
    await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    await page.goto(`${base}/d/${slug}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    return { ctx, page, frame: page.frames().find((f) => f !== page.mainFrame()) };
  };
  // What the frame does with the edits, sent as the shell sends them; the
  // frame's answer (tdoc:suggestShown) caught on its way to the shell.
  const show = async (page, items) => {
    await page.evaluate(() => { window.__shown = null; if (!window.__tap) { window.__tap = true; window.addEventListener('message', (e) => { if (e.data && e.data.type === 'tdoc:suggestShown') window.__shown = e.data.results; }); } });
    await page.evaluate((d) => document.querySelector('iframe').contentWindow.postMessage({ source: 'tdoc-shell', type: 'tdoc:suggestShow', items: d }, '*'), items);
    await page.waitForFunction(() => Array.isArray(window.__shown));
    const results = await page.evaluate(() => window.__shown);
    return Object.fromEntries(results.map((r) => [r.id, r.ok]));
  };
  const post = (page, data) => page.evaluate((d) => document.querySelector('iframe').contentWindow.postMessage({ source: 'tdoc-shell', ...d }, '*'), data);
  // Every suggestion element; none may hold another suggestion's, and each
  // id's struck words appear once.
  const marks = (frame) => frame.evaluate(() => {
    const all = [...document.querySelectorAll('[data-tdoc-sugg]')];
    const nested = all.filter((el) => el.parentElement && el.parentElement.closest('[data-tdoc-sugg]') && el.parentElement.closest('[data-tdoc-sugg]').getAttribute('data-tdoc-sugg') !== el.getAttribute('data-tdoc-sugg')).map((el) => el.getAttribute('data-tdoc-sugg'));
    const byId = {};
    for (const el of all) {
      const id = el.getAttribute('data-tdoc-sugg');
      byId[id] = byId[id] || { del: '', ins: '' };
      if (el.tagName === 'DEL') byId[id].del += el.textContent;
      if (el.tagName === 'INS') byId[id].ins += el.textContent;
    }
    return { nested, byId, dels: document.querySelectorAll('del').length, two: document.querySelector('#two').textContent };
  });

  const ITEMS = [
    // The same agent proposing the same rewrite three times.
    { id: 'a:1', find: LEAD + ITEM, replace: ITEM_NEW },
    { id: 'b:1', find: LEAD + ITEM, replace: ITEM_NEW },
    { id: 'c:1', find: LEAD + ITEM, replace: ITEM_NEW },
    // An overlapping find: part of the same item.
    { id: 'd:1', find: '容器不重启', replace: '容器照常运行' },
    // One elsewhere, untouched by the rest.
    { id: 'e:1', find: '真实答案', replace: '正确答案' },
  ];

  const runs = [[browser, false], [browser, true], ...(webkit ? [[webkit, true]] : [])];
  try {
    for (const [which, phone] of runs) {
      const tag = `${which === browser ? 'chromium' : 'webkit'} ${phone ? 390 : 1280}`;
      await t(`${tag}: duplicate and overlapping suggestions each show once, none nested`, async () => {
        const v = await open(phone, which);
        const before = await v.frame.evaluate(() => document.body.innerHTML);
        const ok = await show(v.page, ITEMS);
        await post(v.page, { type: 'tdoc:suggestFocus', id: 'a:1', scroll: true });
        await shot(v.page, `overlap-${tag.replace(' ', '-')}.png`);
        const m = await marks(v.frame);
        assert.deepEqual(m.nested, [], 'no suggestion inside another');
        assert.equal(ok['a:1'], true, 'the first one shows');
        assert.equal(ok['e:1'], true, 'one elsewhere shows');
        assert.equal(ok['b:1'], false, 'a duplicate is not shown again');
        assert.equal(ok['c:1'], false, 'a duplicate is not shown again');
        assert.equal(ok['d:1'], false, 'an overlapping one is not shown over the first');
        assert.equal(m.byId['a:1'].del, LEAD + ITEM, 'struck once, whole');
        assert.equal(m.byId['a:1'].ins, ITEM_NEW);
        assert.equal(Object.keys(m.byId).sort().join(), 'a:1,e:1');
        // Struck once: the item's text holds its old words exactly once.
        assert.equal(m.two.split(ITEM).length - 1, 1, 'the old text appears once');
        // Shown again (the shell re-sends on every list): still the same.
        await show(v.page, ITEMS);
        const again = await marks(v.frame);
        assert.deepEqual(again.nested, []);
        assert.equal(again.two.split(ITEM).length - 1, 1);
        // Clearing puts the page back exactly.
        await post(v.page, { type: 'tdoc:suggestClear' });
        await v.frame.waitForFunction(() => !document.querySelector('[data-tdoc-sugg]'));
        assert.equal(await v.frame.evaluate(() => { document.body.normalize(); return document.body.innerHTML; }), before);
        await v.ctx.close();
      });
    }

    await t('chromium 1280: the overlapping one shows once the first is rejected; accept settles only its own', async () => {
      const v = await open(false);
      let ok = await show(v.page, ITEMS);
      assert.equal(ok['d:1'], false);
      // The shell re-sends what is still pending after a reject.
      await post(v.page, { type: 'tdoc:suggestSettle', id: 'a:1', accepted: false });
      ok = await show(v.page, ITEMS.filter((x) => x.id !== 'a:1'));
      assert.equal(ok['b:1'], true, 'the next duplicate takes its place');
      ok = await show(v.page, ITEMS.filter((x) => !['a:1', 'b:1', 'c:1'].includes(x.id)));
      assert.equal(ok['d:1'], true, 'with the rewrites gone, the small edit shows');
      assert.equal(ok['e:1'], true);
      let m = await marks(v.frame);
      assert.deepEqual(m.nested, []);
      assert.equal(m.byId['d:1'].del, '不重启');
      await post(v.page, { type: 'tdoc:suggestSettle', id: 'd:1', accepted: true });
      await v.frame.waitForFunction(() => !document.querySelector('[data-tdoc-sugg="d:1"]'));
      m = await marks(v.frame);
      assert.ok(m.two.includes('容器照常运行'));
      assert.equal(Object.keys(m.byId).join(), 'e:1', 'the other one is untouched');
      await v.ctx.close();
    });

    // In the real shell, from the server's list: the agent's rewrite sent
    // three times, a small edit inside it, one elsewhere.
    for (const phone of [false, true]) {
      await t(`shell ${phone ? 390 : 1280}: the review shows each once; Reject takes the copies too; the held-back one then shows; Accept publishes`, async () => {
        const slug = await newDoc();
        const small = await propose(slug, '容器不重启', '容器照常运行');
        await propose(slug, '真实答案', '正确答案');
        const copies = [];
        for (let i = 0; i < 3; i++) copies.push(await propose(slug, LEAD + ITEM, ITEM_NEW));
        const v = await open(phone, browser, slug);
        const bar = v.page.locator('.tdoc-suggest-bar');
        await v.frame.waitForSelector('ins.tdoc-diff-block', { timeout: 10000 });
        await v.page.waitForTimeout(400);
        await shot(v.page, `shell-${phone ? 390 : 1280}.png`);
        let m = await marks(v.frame);
        assert.deepEqual(m.nested, [], 'no suggestion inside another');
        assert.equal(Object.keys(m.byId).length, 2, 'the rewrite once and the one elsewhere');
        assert.equal(m.two.split(ITEM).length - 1, 1, 'the old text appears once');
        assert.equal(await v.frame.evaluate(() => document.querySelectorAll('ins.tdoc-diff-block').length), 1, 'one new text');
        await bar.getByText(/1 of 2|1\/2/).first().waitFor({ timeout: 5000 }).catch(() => {});
        // Reject the rewrite: its copies go with it, the small edit shows.
        // The bar is on the rewrite (first in reading order) once the frame
        // has outlined it and Reject is live: wait for that, then press.
        const reject = bar.getByRole('button', { name: 'Reject', exact: true });
        await v.frame.waitForSelector('ins.tdoc-diff-block[data-tdoc-sugg-active]', { timeout: 10000 });
        await v.page.waitForFunction(() => { const b = [...document.querySelectorAll('.tdoc-suggest-bar button')].find((x) => x.textContent === 'Reject'); return b && !b.disabled; });
        await reject.click();
        await v.frame.waitForSelector(`[data-tdoc-sugg="${small.id}:${small.edits[0].id}"]`, { timeout: 10000 });
        // The list holds open sets only: every copy is gone from it.
        const list = (await api(`/api/docs/${slug}/suggestions`)).body.suggestions;
        assert.deepEqual(list.filter((x) => copies.some((c) => c.id === x.id)).map((x) => x.id), [], 'every copy rejected');
        assert.equal(list.length, 2);
        m = await marks(v.frame);
        assert.deepEqual(m.nested, []);
        assert.equal(Object.keys(m.byId).length, 2);
        await shot(v.page, `shell-${phone ? 390 : 1280}-after-reject.png`);
        // Accept the small one: a new version with its words, the other still pending.
        // The bar went on to the next one it could show (elsewhere); the
        // small edit now shows above it: step back to it, once the bar counts both.
        const smallKey = `${small.id}:${small.edits[0].id}`;
        await bar.getByText('2 of 2').waitFor({ timeout: 10000 });
        await bar.getByRole('button', { name: 'Previous suggestion' }).click();
        await v.frame.waitForSelector(`[data-tdoc-sugg="${smallKey}"][data-tdoc-sugg-active]`, { timeout: 10000 });
        await v.page.waitForFunction(() => { const b = document.querySelector('.tdoc-suggest-bar [data-suggest-accept]'); return b && !b.disabled; });
        await bar.getByRole('button', { name: 'Accept', exact: true }).click();
        await v.page.waitForURL(new RegExp(`/d/${slug}/v/2$`), { timeout: 10000 });
        await v.page.frameLocator('iframe').locator('#two', { hasText: '容器照常运行' }).waitFor({ timeout: 10000 });
        await v.page.frameLocator('iframe').locator('ins').first().waitFor({ timeout: 10000 });
        await shot(v.page, `shell-${phone ? 390 : 1280}-after-accept.png`);
        const after = (await api(`/api/docs/${slug}/suggestions`)).body.suggestions;
        assert.equal(after.some((x) => x.id === small.id), false, 'accepted, so no longer open');
        assert.equal(after.length, 1, 'the one elsewhere still waits');
        await v.ctx.close();
      });
    }
  } finally {
    await browser.close();
    if (webkit) await webkit.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
