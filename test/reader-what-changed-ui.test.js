// See what changed, in the real shell against the real worker, for the
// person who left the comment and may not list the doc's history
// (history_visibility: owner, the default):
//   - they read v1 and comment; an agent publishes v2 and replies "applied
//     in v2". Back on the doc, "Edited … · See what changed" (desktop) opens
//     the compare of v2 against v1, the version they last saw.
//   - the agent's reply has "see changes", which opens the same compare.
//   - a phone: ⋯ → See what changed.
//   - a stranger to a private doc gets neither frame of the compare.
// Screenshots with TDOC_UI_SHOTS=<dir>.
// Run with: node test/reader-what-changed-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('reader-what-changed-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const page = (trial) => `<!doctype html><html><head><title>Dogfood plan</title></head><body><h1>Dogfood plan</h1><h2>Plan</h2><p>The launch date is Friday. The pricing page says the trial lasts ${trial}.</p><p>Second paragraph of filler text so there is something to comment on.</p></body></html>`;

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
  console.log('reader: see what changed');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const session = async (sid, login) => {
    await env.META.put(`session:${sid}`, JSON.stringify({ login, name: login, email: `${login}@tdoc.test`, avatar_url: '', created: new Date().toISOString() }));
    return `tdoc_sid=${sid}`;
  };
  const ownerSid = 'b'.repeat(32), readerSid = 'c'.repeat(32), strangerSid = 'd'.repeat(32);
  const ownerCookie = await session(ownerSid, 'julie');
  await session(readerSid, 'reader');
  await session(strangerSid, 'stranger');
  const token = (await (await worker.fetch(new Request('https://tdoc.dev/api/hosted/token', { method: 'POST', headers: { cookie: ownerCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'julie' }) }), env, {})).json()).token;
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const upload = (slug, n, trial, access) => api('/api/upload', { method: 'POST', token, body: { slug, version: n, html: page(trial), meta: { title: 'Dogfood plan', ...(access ? { access } : {}) } } });

  const { server, base } = await startServer(worker, env);
  const browser = await pw.chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); } };
  const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.waitForTimeout(600); await p.screenshot({ path: `${SHOTS}/${name}` }); } };
  const context = async ({ phone = false, as = readerSid } = {}) => {
    const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1440, height: 900 } });
    if (as) await ctx.addCookies([{ name: 'tdoc_sid', value: as, domain: '127.0.0.1', path: '/' }]);
    await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    return ctx;
  };
  const goto = async (p, path) => {
    await p.goto(`${base}${path}`);
    await p.waitForFunction(() => document.body.dataset.tdocReady === '1', null, { timeout: 15000 });
  };
  const comparePane = async (p, name) => {
    const view = p.getByRole('main', { name: 'Version changes' });
    const locator = view.locator(`iframe[aria-label="${name}"]`);
    await locator.waitFor({ state: 'attached' });
    for (let i = 0; i < 100; i++) { const h = await locator.elementHandle(); const f = h && await h.contentFrame(); if (f) return f; await p.waitForTimeout(50); }
    throw new Error(`no ${name} frame`);
  };
  const changed = async (p) => {
    const after = await comparePane(p, 'New version');
    await after.waitForFunction(() => document.querySelector('[data-tdoc-change], .tdoc-diff-ins'), null, { timeout: 15000 });
    return after.evaluate(() => [...document.querySelectorAll('.tdoc-diff-ins')].map((el) => el.textContent).join(' '));
  };

  try {
    const slug = 'dogfood-what-changed';
    let commentId = '';
    await t('setup: the reader reads v1 and comments; an agent publishes v2 and replies "applied in v2"', async () => {
      assert.equal((await upload(slug, 1, '7 days')).status, 200);
      const ctx = await context();
      const p = await ctx.newPage();
      await goto(p, `/d/${slug}`);
      // v1 alone: nothing to compare, so the words are only the time.
      const edited = p.locator('.tdoc-bar .tdoc-edited');
      await edited.waitFor();
      assert.equal(await p.locator('.tdoc-edited-changes').count(), 0);
      const c = await api('/api/comments', { method: 'POST', cookie: `tdoc_sid=${readerSid}`, body: { slug, version: 1, text: 'Make the trial 14 days', anchor: { kind: 'text', text: 'the trial lasts 7 days' } } });
      assert.equal(c.status, 200, JSON.stringify(c.body));
      commentId = c.body.id;
      await ctx.close();
      assert.equal((await upload(slug, 2, '14 days')).status, 200);
      const r = await api('/api/agent/reply', { method: 'POST', token, body: { slug, parent_id: commentId, text: 'Changed the trial to 14 days.', status: 'applied', applied_in: 2 } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    });

    await t('desktop: back on the doc, "Edited … · See what changed" opens v2 against v1, the version they last saw', async () => {
      const ctx = await context();
      const p = await ctx.newPage();
      // This browser last saw v1 (leaving the page records the version on
      // screen), then comes back to the doc.
      await goto(p, `/d/${slug}/v/1`);
      await goto(p, `/d/${slug}`);
      const edited = p.locator('.tdoc-bar .tdoc-edited');
      await edited.waitFor();
      assert.match((await edited.textContent()).replace(/\s+/g, ' '), /^Edited just now · See what changed$/);
      assert.equal(await edited.getAttribute('aria-expanded'), null, 'not the history');
      await shot(p, 'desktop-1-edited-see-what-changed.png');
      await edited.click();
      const view = p.getByRole('main', { name: 'Version changes' });
      await view.waitFor();
      assert.equal(await view.locator('.tdoc-diff-heading strong').innerText(), 'v2 · Changes from v1');
      assert.match(await changed(p), /14/);
      assert.equal(await p.locator('.tdoc-history-panel').count(), 0, 'no history panel');
      await shot(p, 'desktop-2-what-changed.png');
      await view.getByRole('button', { name: 'Back to document' }).click();
      await p.locator('.tdoc-bar .tdoc-edited').waitFor();
      assert.equal(await p.locator('.tdoc-edited-changes').count(), 0, 'seen: the label is the time again');
      await ctx.close();
    });

    await t('desktop: the agent\'s applied reply has "see changes", which opens that version\'s changes', async () => {
      const ctx = await context();
      const p = await ctx.newPage();
      await goto(p, `/d/${slug}?comment=${encodeURIComponent(commentId)}`);
      const card = p.locator(`.tdoc-margin-comment[data-comment-id="${commentId}"], [data-comment-id="${commentId}"]`).first();
      if (!(await p.locator('.tdoc-reply-changes').first().isVisible().catch(() => false))) {
        await card.waitFor({ timeout: 10000 });
        await card.click();
        const toggle = card.locator('.tdoc-replies-toggle');
        if (await toggle.count() && !(await card.locator('.tdoc-replies.open').count())) await toggle.first().click();
      }
      const link = p.locator('.tdoc-reply-changes').first();
      await link.waitFor({ timeout: 10000 });
      assert.equal(await link.innerText(), 'see changes');
      await shot(p, 'desktop-3-reply-see-changes.png');
      await link.click();
      const view = p.getByRole('main', { name: 'Version changes' });
      await view.waitFor();
      assert.equal(await view.locator('.tdoc-diff-heading strong').innerText(), 'v2 · Changes from v1');
      assert.match(p.url(), /compare=1&to=2/);
      assert.match(await changed(p), /14/);
      await ctx.close();
    });

    await t('phone: ⋯ → See what changed opens the same compare', async () => {
      const ctx = await context({ phone: true });
      const p = await ctx.newPage();
      await goto(p, `/d/${slug}`);
      await p.locator('.tdoc-bar [aria-label="More actions"], .tdoc-bar [aria-label="More"], .tdoc-bar .tdoc-more-trigger').first().click();
      const item = p.getByRole('menuitem', { name: 'See what changed', exact: true });
      await item.waitFor();
      assert.equal(await p.getByRole('menuitem', { name: 'Version history', exact: true }).count(), 0);
      await shot(p, 'phone-1-menu-see-what-changed.png');
      await item.click();
      const view = p.getByRole('main', { name: 'Version changes' });
      await view.waitFor();
      assert.equal(await view.locator('.tdoc-diff-heading strong').innerText(), 'v2 · Changes from v1');
      assert.match(await changed(p), /14/);
      await shot(p, 'phone-2-what-changed.png');
      await ctx.close();
    });

    await t('phone: the reply\'s "see changes"', async () => {
      const ctx = await context({ phone: true });
      const p = await ctx.newPage();
      await goto(p, `/d/${slug}?comment=${encodeURIComponent(commentId)}`);
      const link = p.locator('.tdoc-reply-changes:visible').first();
      // The ?comment= link opens the phone's comment drawer on the thread.
      const fab = p.locator('.tdoc-fab[aria-label="Open comments"]');
      if (await fab.count() && await fab.getAttribute('aria-expanded') !== 'true') await fab.click();
      const card = p.locator(`.tdoc-drawer-list [data-comment-id="${commentId}"]`).first();
      await card.waitFor({ timeout: 10000 });
      if (!(await link.isVisible().catch(() => false))) {
        await card.locator('.tdoc-cc-body').first().click();
        await p.waitForTimeout(300);
      }
      if (!(await link.isVisible().catch(() => false))) {
        const toggle = card.locator('.tdoc-replies-toggle');
        if (await toggle.count()) await toggle.first().click();
      }
      await link.waitFor({ timeout: 10000 });
      await shot(p, 'phone-3-reply-see-changes.png');
      await link.click();
      await p.getByRole('main', { name: 'Version changes' }).waitFor();
      assert.match(p.url(), /to=2/);
      await ctx.close();
    });

    await t('a private doc: a stranger gets neither of the compare\'s frames; the invited reader gets both', async () => {
      const priv = 'dogfood-what-changed-private';
      const access = { visibility: 'private', history_visibility: 'owner', commenting: 'invited', allowed_users: ['reader'] };
      assert.equal((await upload(priv, 1, '7 days', access)).status, 200);
      assert.equal((await upload(priv, 2, '14 days', access)).status, 200);
      for (const [as, ok] of [[strangerSid, false], [null, false], [readerSid, true]]) {
        const ctx = await context({ as });
        const p = await ctx.newPage();
        await p.goto(`${base}/d/${priv}?compare=1`);
        await p.waitForTimeout(300);
        for (const n of [1, 2]) {
          const r = await p.evaluate(async (u) => {
            const res = await fetch(u, { headers: {} });
            return { status: res.status, text: await res.text() };
          }, `${base}/d/${priv}/v/${n}/frame?tdoc_compare=1`);
          // A top-level fetch is not a frame load: refused for everyone.
          assert.notEqual(r.status, 200);
          const framed = await ctx.request.get(`${base}/d/${priv}/v/${n}/frame?tdoc_compare=1`, { headers: { 'Sec-Fetch-Dest': 'iframe' } });
          const body = await framed.text();
          if (ok) {
            assert.equal(framed.status(), 200, `reader frame v${n}`);
            assert.match(body, n === 1 ? /7 days/ : /14 days/);
          } else {
            assert.notEqual(framed.status(), 200, `stranger frame v${n} ${framed.status()}`);
            assert.doesNotMatch(body, /7 days|14 days/);
          }
        }
        if (!ok) assert.equal(await p.getByRole('main', { name: 'Version changes' }).count(), 0, 'no compare page for a non-reader');
        await ctx.close();
      }
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
