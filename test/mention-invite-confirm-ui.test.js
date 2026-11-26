// Ask before a mention adds someone to a private doc (flag
// confirmMentionInvite), in the real shell against the real worker, at 1440
// and 390: the doc's owner posts a comment or a reply naming someone the doc
// does not let in; the box asks "Add @x to this doc? They can read it." with
// Add & post / Post without adding, and the doc's sharing list changes only
// with Add & post. "@john, @gmail。com" (a typo for an address) asks about
// both. Flag off: the mention invites at once, as before.
// Screenshots: TDOC_UI_SHOTS=<dir>.
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('mention-invite-confirm-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const SLUG = 'plan';
const DOC = '<!doctype html><html><body><h1>Plan</h1><p id="small">Billing ships first, on March 14, because invoices block two renewals.</p><p>Second paragraph for the page.</p></body></html>';

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
  console.log('mention invites: the owner is asked first');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const sid = 'b'.repeat(32);
  await env.META.put(`session:${sid}`, JSON.stringify({ login: 'olga', name: 'olga', email: 'olga@tdoc.test', avatar_url: '', created: new Date().toISOString() }));
  const cookie = `tdoc_sid=${sid}`;
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const token = (await api('/api/hosted/token', { method: 'POST', cookie, body: { label: 'olga' } })).body.token;
  assert.equal((await api('/api/upload', { method: 'POST', token, body: { slug: SLUG, version: 1, html: DOC, meta: { title: 'Plan' } } })).status, 200);
  const setAllowed = (list) => {
    const meta = JSON.parse(env.META.map.get(`meta:${SLUG}`));
    meta.access = { ...(meta.access || {}), visibility: 'private', commenting: 'signed_in', allowed_users: list };
    env.META.map.set(`meta:${SLUG}`, JSON.stringify(meta));
  };
  const allowed = () => JSON.parse(env.META.map.get(`meta:${SLUG}`)).access.allowed_users.join();
  setAllowed(['lee']);
  const thread = async () => (await api('/api/comments', { method: 'POST', cookie, body: { slug: SLUG, version: 1, text: 'A thread to answer', anchor: null } })).body.id;
  const count = async () => (await api(`/api/comments?slug=${SLUG}&version=1`, { cookie })).body.reduce((n, c) => n + 1 + (c.replies || []).length, 0);

  const { server, base } = await startServer(worker, env);
  const browser = await pw.chromium.launch({ headless: true });
  const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}` }); } };
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };

  const open = async ({ phone = false, flag = true } = {}) => {
    const ctx = await browser.newContext(phone ? PHONE : { viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((on) => { window.__TDOC_FLAGS__ = { ...(window.__TDOC_FLAGS__ || {}), confirmMentionInvite: on, modelessEdit: false }; }, flag);
    await ctx.addCookies([{ name: 'tdoc_sid', value: sid, domain: '127.0.0.1', path: '/' }]);
    await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/d/${SLUG}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    return { ctx, page, errors, frame: page.frames().find((f) => f !== page.mainFrame()) };
  };
  const selectWords = async (page, frame) => {
    const box = await page.locator('iframe').first().boundingBox();
    const r = await frame.evaluate(() => { const b = document.getElementById('small').getBoundingClientRect(); return { x1: b.left + 2, x2: b.left + 200, y: b.top + 8 }; });
    await page.mouse.move(box.x + r.x1, box.y + r.y);
    await page.mouse.down();
    await page.mouse.move(box.x + r.x2, box.y + r.y, { steps: 6 });
    await page.mouse.up();
  };
  // Typed as a person types it; the @ menu closes on the words after it.
  const typeInto = async (page, box, text, phone) => {
    if (phone) await box.tap(); else await box.click();
    await page.keyboard.type(text);
    await page.keyboard.type(' please');
    await page.locator('#tdoc-mention-menu').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  };
  const confirmRow = (page) => page.locator('.tdoc-invite-confirm');
  const replyBox = async (page, id, phone) => {
    if (phone) await page.locator('.tdoc-fab').tap();
    else if (!(await page.locator('.tdoc-cpanel').isVisible().catch(() => false))) await page.locator('.tdoc-comments-toggle').click();
    const card = page.locator(`[data-comment-id="${id}"]`).first();
    await card.waitFor();
    const reply = card.getByRole('button', { name: 'Reply', exact: true }).first();
    if (await reply.isVisible().catch(() => false)) { if (phone) await reply.tap(); else await reply.click(); } else if (phone) await card.tap(); else await card.click();
    const box = card.locator('.tdoc-reply-form textarea').first();
    await box.waitFor();
    return { card, box };
  };

  try {
    await t('1440, composer: "@john, @gmail。com" asks about both; Post without adding posts and adds nobody', async () => {
      setAllowed(['lee']);
      const v = await open();
      const before = await count();
      await selectWords(v.page, v.frame);
      const box = v.page.locator('.tdoc-popup textarea').first();
      await box.waitFor({ timeout: 5000 });
      await typeInto(v.page, box, 'cc @john, @gmail。com', false);
      await v.page.locator('.tdoc-popup .submit').click();
      await confirmRow(v.page).waitFor({ timeout: 5000 });
      assert.equal(await confirmRow(v.page).locator('.tdoc-invite-confirm-text').innerText(), 'Add @john and @gmail to this doc? They can read it.');
      assert.equal(await count(), before, 'posted before the answer');
      await shot(v.page, 'mention-invite-confirm-1440.png');
      await confirmRow(v.page).getByRole('button', { name: 'Post without adding' }).click();
      await v.page.locator('.tdoc-popup').waitFor({ state: 'detached', timeout: 5000 });
      assert.equal(await count(), before + 1);
      assert.equal(allowed(), 'lee', 'invited without Add & post');
      assert.deepEqual(v.errors, []);
      await v.ctx.close();
    });

    await t('1440, reply box: Add & post adds exactly who it named', async () => {
      setAllowed(['lee']);
      const id = await thread();
      const v = await open();
      const { box } = await replyBox(v.page, id, false);
      await typeInto(v.page, box, 'see this @bob', false);
      await v.page.locator(`[data-comment-id="${id}"] .tdoc-reply-submit.ui-btn-primary`).first().click();
      const row = v.page.locator(`[data-comment-id="${id}"] .tdoc-invite-confirm`);
      await row.waitFor({ timeout: 5000 });
      assert.equal(await row.locator('.tdoc-invite-confirm-text').innerText(), 'Add @bob to this doc? They can read it.');
      await shot(v.page, 'mention-invite-confirm-reply-1440.png');
      await row.getByRole('button', { name: 'Add & post' }).click();
      await row.waitFor({ state: 'detached', timeout: 5000 });
      await v.page.waitForFunction(() => true);
      for (let k = 0; k < 50 && allowed() !== 'lee,bob'; k++) await v.page.waitForTimeout(100);
      assert.equal(allowed(), 'lee,bob');
      assert.deepEqual(v.errors, []);
      await v.ctx.close();
    });

    await t('390, reply in the drawer: asked, Add & post', async () => {
      setAllowed(['lee']);
      const id = await thread();
      const v = await open({ phone: true });
      const { box } = await replyBox(v.page, id, true);
      await typeInto(v.page, box, 'cc @carol', true);
      await v.page.locator(`[data-comment-id="${id}"] .tdoc-reply-submit.ui-btn-primary`).first().tap();
      const row = v.page.locator(`[data-comment-id="${id}"] .tdoc-invite-confirm`);
      await row.waitFor({ timeout: 5000 });
      assert.equal(await row.locator('.tdoc-invite-confirm-text').innerText(), 'Add @carol to this doc? They can read it.');
      const fits = await row.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; });
      assert.ok(fits, 'the line fits the phone');
      await shot(v.page, 'mention-invite-confirm-390.png');
      await row.getByRole('button', { name: 'Add & post' }).tap();
      await row.waitFor({ state: 'detached', timeout: 5000 });
      for (let k = 0; k < 50 && allowed() !== 'lee,carol'; k++) await v.page.waitForTimeout(100);
      assert.equal(allowed(), 'lee,carol');
      assert.deepEqual(v.errors, []);
      await v.ctx.close();
    });

    await t('flag off: no question, the mention invites at once, as before', async () => {
      setAllowed(['lee']);
      const id = await thread();
      const v = await open({ flag: false });
      const { box } = await replyBox(v.page, id, false);
      await typeInto(v.page, box, 'cc @dave', false);
      await v.page.locator(`[data-comment-id="${id}"] .tdoc-reply-submit.ui-btn-primary`).first().click();
      await box.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      for (let k = 0; k < 50 && allowed() !== 'lee,dave'; k++) await v.page.waitForTimeout(100);
      assert.equal(allowed(), 'lee,dave');
      assert.equal(await confirmRow(v.page).count(), 0);
      await v.ctx.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  if (failed) process.exitCode = 1;
})();
