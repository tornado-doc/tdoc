// Signed in, no agent connected (owner feedback on #tdoc-send-agent-btn,
// 2026-11-15: "make sure for ALL cases there is a CTA to set up"). Each
// surface that offers the agent says where to connect one, and the widget's
// link opens tdoc in a new tab instead of navigating the app it sits on:
//   - doc page Ask AI, with tdoc AI answering (production): the connect line;
//   - the owner's "Let your agent fix it" card: connect your agent;
//   - the composer's @agent: the inline connect panel;
//   - a non-owner is not pushed to connect the owner's agent;
//   - widget (SDK script) composer: Set up an agent, in a new tab.
// Real worker routes behind a local server, built runtimes, Chromium at
// 1280 and 390. TDOC_UI_SHOTS=<dir> saves screenshots.
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('no-agent-cta-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TDOC = 'https://tdoc.dev';
const SETTINGS = '/me?view=settings#agents';
const DOC = '<!doctype html><html><body><h1>Launch plan</h1><p id="a">Alpha line one to comment on, with a few more words.</p><p id="b">Bravo line two to comment on.</p></body></html>';
const WIDGET_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>page</title></head>
<body><main><h1>App</h1><p id="x">Something to comment on.</p><p id="y">Something else.</p></main>
<script src="/feedback.js" data-tdoc-open="1"></script></body></html>`;

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((a) => [a.path, a]));
  const server = http.createServer(async (request, res) => {
    const pathname = request.url.split('?')[0];
    if (pathname === '/__page') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(WIDGET_PAGE); }
    if (pathname === '/feedback.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'server/runtime/feedback.js')));
    }
    const asset = byPath.get(pathname);
    if (asset) { res.setHeader('content-type', asset.type); return res.end(fs.readFileSync(asset.file)); }
    const chunks = [];
    try { for await (const chunk of request) chunks.push(chunk); } catch { return; }
    const headers = { ...request.headers, host: 'tdoc.dev' };
    if (headers.origin) headers.origin = TDOC;
    delete headers.referer;
    const response = await worker.fetch(new Request(`${TDOC}${request.url}`, {
      method: request.method, headers, redirect: 'manual',
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks),
    }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let body = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) {
      body = Buffer.from(body.toString('utf8')
        .replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path)
        .replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    }
    response.headers.forEach((value, key) => {
      if (['content-length', 'content-encoding', 'content-security-policy'].includes(key)) return;
      res.setHeader(key, key === 'location' ? value.replace(TDOC, '') : value);
    });
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  console.log('No agent connected: a way to connect one on every surface');
  const mod = await loadWorker();
  const worker = mod.default;
  // tdoc AI answers here, as in production: Ask AI is not empty without an agent.
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'test-key' });
  const call = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`${TDOC}${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: TDOC } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const person = async (login, ch) => {
    const sid = ch.repeat(32);
    await env.META.put(`session:${sid}`, JSON.stringify({ login, name: login, email: `${login}@tdoc.test`, avatar_url: '', created: new Date().toISOString() }));
    const cookie = `tdoc_sid=${sid}`;
    const minted = await call('/api/hosted/token', { method: 'POST', cookie, body: { label: login } });
    assert.equal(minted.status, 200, JSON.stringify(minted.body));
    return { login, sid, cookie, token: minted.body.token };
  };
  const julie = await person('julie', 'a');
  const eve = await person('eve', 'e');
  const slug = 'no-agent-plan';
  assert.equal((await call('/api/upload', { method: 'POST', token: julie.token, body: { slug, version: 1, html: DOC, meta: { title: slug } } })).status, 200);
  await call(`/api/docs/${slug}/access`, { method: 'PATCH', cookie: julie.cookie, body: { visibility: 'unlisted', commenting: 'signed_in' } });
  const c = await call('/api/comments', { method: 'POST', cookie: julie.cookie, body: { slug, version: 1, text: 'Tighten this paragraph, please.', anchor: { kind: 'text', text: 'Alpha line one' } } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const { server, base } = await startServer(worker, env);
  const space = (await call('/api/feedback/connect', { method: 'POST', cookie: julie.cookie, body: { origin: base } })).body;
  assert.ok(space.slug && space.token, JSON.stringify(space));
  const fb = await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: 'Why is the list empty?', anchor: { kind: 'product', url: `${base}/__page`, selector: '#x', tag: 'p', text: 'Something to comment on.' } } });
  assert.equal(fb.status, 200, JSON.stringify(fb.body));

  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${String(error.message).split('\n').slice(0, 8).join('\n    ')}`); } };
  const browser = await pw.chromium.launch({ headless: true });

  for (const width of [1280, 390]) {
    const phone = width < 700;
    const tag = `chromium-${width}`;
    const contextFor = async (who) => {
      const ctx = await browser.newContext(phone ? { viewport: { width, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width, height: 820 } });
      if (who) await ctx.addCookies([{ name: 'tdoc_sid', value: who.sid, url: base }]);
      await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
      return ctx;
    };
    const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, `${tag}-${name}.png`) }); } };
    const openDoc = async (ctx) => {
      const page = await ctx.newPage();
      page.errors = [];
      page.on('pageerror', (e) => page.errors.push(e.message));
      await page.goto(`${base}/d/${slug}`);
      await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
      await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
      return page;
    };
    const openAskAi = async (page) => {
      if (phone) {
        await page.locator('.tdoc-fab').click();
        await page.getByRole('radiogroup', { name: 'Comments or Ask AI' }).getByRole('radio', { name: /Ask AI/ }).click();
        return page.locator('#tdoc-comment-layer .tdoc-ask-panel');
      }
      await page.locator('#tdoc-send-agent-btn').click();
      return page.locator('.tdoc-handoff-popover .tdoc-ask-panel');
    };

    await t(`${tag}: owner, Ask AI beside tdoc AI says no agent is connected and links to Settings › Agents`, async () => {
      const ctx = await contextFor(julie);
      const page = await openDoc(ctx);
      const panel = await openAskAi(page);
      await panel.locator('.tdoc-ask-form-pills', { hasText: 'tdoc AI' }).waitFor({ timeout: 10000 });
      const notice = panel.locator('.tdoc-ask-connect-notice');
      await notice.waitFor({ timeout: 10000 });
      assert.match(await notice.innerText(), /No agent connected yet/);
      const link = notice.getByRole('link', { name: 'Connect your agent' });
      assert.equal(await link.getAttribute('href'), SETTINGS);
      assert.equal(await link.getAttribute('target'), null, 'a tdoc page opens its own settings in a new tab');
      await shot(page, 'owner-ask-ai');
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t(`${tag}: owner, the "Let your agent fix it" card offers to connect the agent`, async () => {
      const ctx = await contextFor(julie);
      const page = await openDoc(ctx);
      let card;
      if (phone) {
        await page.locator('.tdoc-fab').click();
        card = page.locator('#tdoc-comment-layer');
      } else {
        await page.locator('.tdoc-pin').first().click({ force: true });
        card = page.locator('.tdoc-margin-comment').first();
      }
      const line = card.locator('.tdoc-handoff-connect');
      await line.waitFor({ timeout: 10000 });
      assert.equal(await line.getByRole('link', { name: 'connect your agent' }).getAttribute('href'), SETTINGS);
      await shot(page, 'owner-card');
      await ctx.close();
    });

    if (!phone) await t(`${tag}: a named agent (its pill) hides the @agent button; the pill's menu turns it off`, async () => {
      const ctx = await contextFor(julie);
      const page = await openDoc(ctx);
      const frameBox = await page.locator('iframe').first().boundingBox();
      const r = await page.frameLocator('iframe').locator('#b').evaluate((el) => { const b = el.getBoundingClientRect(); return { x1: b.left + 2, x2: b.left + 200, y: b.top + 8 }; });
      await page.mouse.move(frameBox.x + r.x1, frameBox.y + r.y);
      await page.mouse.down();
      await page.mouse.move(frameBox.x + r.x2, frameBox.y + r.y, { steps: 6 });
      await page.mouse.up();
      const pop = page.locator('.tdoc-popup');
      await pop.waitFor();
      const box = pop.locator('textarea');
      await box.fill('What does this mean? ');
      await box.press('End');
      await box.type('@');
      await page.locator('.tdoc-mention-menu .tdoc-mention-agent', { hasText: 'tdoc AI' }).first().click();
      await pop.locator('.tdoc-agent-pill').waitFor();
      assert.equal(await pop.locator('.tdoc-send-agent-toggle').count(), 0, 'the @agent button shows beside the pill');
      await shot(page, 'pill-no-agent-button');
      await pop.locator('.tdoc-agent-pill').click();
      await page.locator('.tdoc-agent-menu-off').click();
      await pop.locator('.tdoc-agent-pill').waitFor({ state: 'detached' });
      assert.equal(await box.inputValue(), 'What does this mean? ');
      await pop.locator('.tdoc-send-agent-toggle').waitFor();
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t(`${tag}: a reader with no agent is not sent to connect the owner's`, async () => {
      const ctx = await contextFor(eve);
      const page = await openDoc(ctx);
      const panel = await openAskAi(page);
      await panel.locator('.tdoc-ask-form-pills', { hasText: 'tdoc AI' }).waitFor({ timeout: 10000 });
      await page.waitForTimeout(500);
      assert.equal(await panel.locator('.tdoc-ask-connect-notice').count(), 0);
      assert.equal(await page.locator('.tdoc-handoff-connect').count(), 0);
      await ctx.close();
    });
  }

  await t('widget: the composer\'s @agent opens Set up an agent, and it opens tdoc in a new tab', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${base}`, JSON.stringify(space)]);
    await page.goto(`${base}/__page`);
    const root = page.locator('#tdoc-feedback-root');
    // Loaded: the bookmark opens the list on its thread; then pick a spot.
    await root.locator(`[data-comment-id="${fb.body.id}"]`).first().waitFor({ timeout: 15000 });
    await root.locator('.tdoc-feedback-dock button.primary').click();
    await root.locator('.tdoc-feedback-dock button.primary.on').waitFor({ timeout: 8000 });
    const y = await page.locator('#y').boundingBox();
    await page.mouse.move(y.x + 20, y.y + y.height / 2, { steps: 4 });
    await page.mouse.click(y.x + 20, y.y + y.height / 2);
    await root.locator('textarea').first().fill('Please fix');
    await root.locator('.tdoc-send-agent-toggle').first().click();
    const cta = root.locator('.tdoc-connect-agent-cta');
    await cta.waitFor({ timeout: 10000 });
    assert.equal(await cta.getAttribute('target'), '_blank');
    assert.match(await cta.getAttribute('href'), /\/me\/agents\?tab=send$/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'widget-composer.png') });
    assert.equal(new URL(page.url()).pathname, '/__page');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
