// The doc page, the feedback space page and the feedback widget draw one
// CommentCard, and it behaves one way (Julie, 2026-11-06: "very hard to
// maintain"). What a surface gets by default, and cannot forget:
//   - answering an agent in dev mode, the reply box starts with its tag; an
//     agent whose edits would skip review gets none, and outside dev mode
//     nobody gets one.
//   - every agent list stops at one height and scrolls, inside the screen.
//   - a reply being typed is a draft per thread: it outlives a tab change, an
//     agent's reply moving the thread, closing and reopening, an outside tap,
//     a refresh and a failed post; a good post clears it; another account in
//     the same tab does not see it.
//   - a floating card taller than the screen fits it and scrolls inside, with
//     the reply box in reach at its foot, keyboard included.
//   - the feedback panel's width follows a drag of its left edge or the
//     keyboard, on this device, and what the widget draws follows it.
// Real worker routes behind a local server, the built runtimes, a browser, at
// 1280 and 390 (chromium) and 390 (webkit). TDOC_UI_SHOTS=<dir> saves shots.
// Run with: node test/comment-one-behaviour-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('comment-one-behaviour-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TDOC = 'https://tdoc.dev';
const SLUG = 'plan';
const DOC = '<!doctype html><html><body><h1>Plan</h1><p id="x">Billing ships first, on March 14, because invoices block two renewals.</p></body></html>';
const LIST_MAX = 240;
const WIDGET_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>page</title></head>
<body><main><h1>My docs</h1><p id="x">Something to comment on.</p><div style="height:3000px"></div></main>
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
    for await (const chunk of request) chunks.push(chunk);
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
  console.log('One comment card: prefill, agent lists and reply drafts on every surface');
  const mod = await loadWorker();
  const worker = mod.default;
  const DEV = 'julie@tdoc.test,rita@tdoc.test';
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_DEBUG_ACCOUNTS: DEV, ASK_API_KEY: 'k', ASK_API_BASE: 'https://model.invalid/v1' });
  const call = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`${TDOC}${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: TDOC } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const person = async (login, sidChar) => {
    const sid = sidChar.repeat(32);
    await env.META.put(`session:${sid}`, JSON.stringify({ login, name: login, email: `${login}@tdoc.test`, avatar_url: '', created: new Date().toISOString() }));
    const cookie = `tdoc_sid=${sid}`;
    const minted = await call('/api/hosted/token', { method: 'POST', cookie, body: { label: login } });
    assert.equal(minted.status, 200, JSON.stringify(minted.body));
    return { login, sid, cookie, token: minted.body.token, account_id: minted.body.account_id };
  };
  const julie = await person('julie', 'a');
  const rita = await person('rita', 'b');
  for (const who of [julie, rita]) assert.equal((await call('/api/me/dev-mode', { method: 'POST', cookie: who.cookie, body: { on: true } })).status, 200);
  const sam = await person('sam', 'c');

  // Julie's doc and space; her own CLIs may edit both.
  assert.equal((await call('/api/upload', { method: 'POST', token: julie.token, body: { slug: SLUG, version: 1, html: DOC, meta: { title: 'Plan' } } })).status, 200);
  assert.equal((await call('/api/notify/local/register', { method: 'POST', token: julie.token, body: { device: 'mac-mini', clis: ['claude', 'codex'] } })).status, 200);
  const space = (await call('/api/feedback/connect', { method: 'POST', cookie: julie.cookie, body: { origin: TDOC } })).body;
  assert.ok(space.slug, JSON.stringify(space));
  // Rita joined it; her own CLI may only answer there.
  const meta = JSON.parse(await env.META.get(`meta:${space.slug}`));
  await env.META.put(`meta:${space.slug}`, JSON.stringify({ ...meta, access: { ...meta.access, allowed_users: ['rita', 'sam'] } }));
  for (const who of [rita, sam]) assert.equal((await call('/api/feedback/join', { method: 'POST', cookie: who.cookie, body: { slug: space.slug } })).status, 200);
  assert.equal((await call('/api/notify/local/register', { method: 'POST', token: rita.token, body: { device: 'ritabox', clis: ['claude'] } })).status, 200);
  const ritaSpace = (await call('/api/feedback/connect', { method: 'POST', cookie: rita.cookie, body: { origin: TDOC } })).body;
  assert.equal(ritaSpace.slug, space.slug);

  const anchor = { kind: 'product', url: `${TDOC}/me`, selector: '#x', tag: 'p', text: 'Something to comment on.' };
  let n = 0;
  // A thread of Rita's in the space, with a question out to her own agent.
  const ritaThread = async ({ ask = true } = {}) => {
    const c = await call('/api/comments', { method: 'POST', token: ritaSpace.token, body: { slug: space.slug, version: 1, text: `Why empty ${++n}?`, anchor } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    if (!ask) return { id: c.body.id };
    const asked = await call(`/api/docs/${space.slug}/my-agent`, { method: 'POST', cookie: rita.cookie, body: { question: 'Why?', comment_id: c.body.id, recipient: { provider: 'local', device: 'ritabox', cli: 'claude' } } });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    return { id: c.body.id, ask: asked.body.ask.ask_id };
  };
  const ritaAgentAnswers = async (thread) => {
    const a = await call('/api/agent/ask-reply', { method: 'POST', token: rita.token, body: { slug: space.slug, ask_id: thread.ask, text: 'Because.', agent_login: 'claude', agent_name: 'Claude' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
  };
  const docThread = async () => {
    const c = await call('/api/comments', { method: 'POST', cookie: julie.cookie, body: { slug: SLUG, version: 1, text: `Thread ${++n}`, anchor: { kind: 'text', text: 'Billing ships first' } } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    return c.body.id;
  };
  const julieAgentAnswers = async (slug, id) => {
    const h = await call('/api/notify/handoff', { method: 'POST', cookie: julie.cookie, body: { slug, comment_ids: [id], recipient: { provider: 'local', server_id: 'mac-mini', agent_sub: 'mac-mini_claude' } } });
    assert.equal(h.status, 200, JSON.stringify(h.body));
    const a = await call('/api/agent/reply', { method: 'POST', token: julie.token, body: { slug, parent_id: id, text: 'Done, take a look.', status: 'answered', agent_login: 'claude', agent_name: 'claude' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
  };

  const { server, base } = await startServer(worker, env);
  let failed = 0;
  const only = process.env.TDOC_TEST_ONLY ? new RegExp(process.env.TDOC_TEST_ONLY) : null;
  const t = async (name, fn) => { if (only && !only.test(name)) return; try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${String(error.message).split('\n').slice(0, 6).join('\n    ')}`); } };
  const webkit = await pw.webkit.launch({ headless: true }).catch(() => null);
  const chromium = await pw.chromium.launch({ headless: true });
  const matrix = [['chromium-1280', chromium, 1280], ['chromium-390', chromium, 390], ...(webkit ? [['webkit-390', webkit, 390]] : [])];

  for (const [tag, browser, width] of matrix) {
    const phone = width < 700;
    const contextFor = async (who) => {
      const ctx = await browser.newContext(phone ? { viewport: { width, height: 844 }, hasTouch: true } : { viewport: { width, height: 800 } });
      if (who) await ctx.addCookies([{ name: 'tdoc_sid', value: who.sid, url: base }]);
      await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
      return ctx;
    };
    const tracked = async (ctx) => {
      const page = await ctx.newPage();
      page.errors = [];
      page.on('pageerror', (e) => page.errors.push(e.message));
      return page;
    };
    const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, `${tag}-${name}.png`) }); } };
    // Each surface: how to reach a card, how to reload it, how to move tabs.
    const surfaces = {
      space: {
        open: async (page) => { await page.goto(`${base}/d/${space.slug}`); },
        root: (page) => page,
        tab: async (page, name) => page.getByRole('radiogroup', { name: 'Show' }).getByRole('radio', { name }).click(),
        reveal: async () => {},
      },
      widget: {
        open: async (page) => {
          await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${base}`, JSON.stringify(ritaSpace)]);
          await page.goto(`${base}/__page`);
        },
        root: (page) => page.locator('#tdoc-feedback-root'),
        tab: async (page, name) => page.locator('#tdoc-feedback-root .tdoc-fb-filter button', { hasText: name }).click(),
        reveal: async () => {},
      },
      doc: {
        open: async (page) => {
          await page.goto(`${base}/d/${SLUG}`);
          await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
          await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
        },
        root: (page) => page,
        reveal: async (page, id) => {
          const card = page.locator(`[data-comment-id="${id}"]`).first();
          if (await card.isVisible().catch(() => false)) return;
          if (phone) await page.locator('.tdoc-fab').click();
          else await page.locator(`.tdoc-pin[data-id="${id}"], .tdoc-pin`).first().click({ force: true });
          await card.waitFor({ timeout: 8000 });
        },
      },
    };
    const cardOf = async (surface, page, id) => {
      await surface.reveal(page, id);
      const card = surface.root(page).locator(`[data-comment-id="${id}"]`).first();
      await card.waitFor({ timeout: 10000 });
      return card;
    };
    const openBox = async (surface, page, id) => {
      const card = await cardOf(surface, page, id);
      await card.getByRole('button', { name: 'Reply', exact: true }).first().click();
      const box = card.locator('.tdoc-reply-form textarea').first();
      await box.waitFor();
      return { card, box };
    };
    const noSideways = async (page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the page scrolls sideways');

    // ── 1. Reply prefill ────────────────────────────────────────────────
    await t(`${tag}: dev mode, doc page: replying to my agent starts with its tag`, async () => {
      const id = await docThread();
      await julieAgentAnswers(SLUG, id);
      const ctx = await contextFor(julie);
      const page = await tracked(ctx);
      await surfaces.doc.open(page);
      const { box } = await openBox(surfaces.doc, page, id);
      await page.waitForFunction((cid) => /Claude Code/.test(document.querySelector(`[data-comment-id="${cid}"] .tdoc-reply-form textarea`)?.value || ''), id, { timeout: 8000 });
      assert.match(await box.inputValue(), /Claude Code/);
      await ctx.close();
    });
    for (const name of ['space', 'widget']) {
      await t(`${tag}: dev mode, ${name}: replying to my own answer-only agent starts with its tag; the tag alone sends nothing`, async () => {
        const thread = await ritaThread();
        await ritaAgentAnswers(thread);
        const ctx = await contextFor(rita);
        const page = await tracked(ctx);
        // The widget lives on other people's sites, where nothing says who is
        // in dev mode: this page pins the flag, as a tdoc page's boot would.
        if (name === 'widget') await page.addInitScript(() => { window.__TDOC_FLAGS__ = { askEditV2: true }; });
        await surfaces[name].open(page);
        await surfaces[name].tab(page, 'Replied').catch(() => {});
        const { card, box } = await openBox(surfaces[name], page, thread.id);
        await card.locator('.tdoc-agent-pill').waitFor({ timeout: 8000 });
        assert.match(await box.inputValue(), /Claude/);
        await shot(page, `${name}-prefilled`);
        const posts = [];
        page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/comments/.test(r.url())) posts.push(r.url()); });
        await card.locator('.tdoc-reply-submit.ui-btn-primary').click();
        await page.waitForTimeout(400);
        assert.deepEqual(posts, [], 'posted on the tag alone');
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    }
    await t(`${tag}: dev mode, space: no tag for the owner's editing agent, because no suggestion path exists there`, async () => {
      const c = await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: `Owner ${++n}`, anchor } });
      assert.equal(c.status, 200, JSON.stringify(c.body));
      await julieAgentAnswers(space.slug, c.body.id);
      const ctx = await contextFor(julie);
      const page = await tracked(ctx);
      await surfaces.space.open(page);
      await surfaces.space.tab(page, 'Replied');
      const { box } = await openBox(surfaces.space, page, c.body.id);
      await page.waitForTimeout(1200);
      assert.equal(await box.inputValue(), '');
      await ctx.close();
    });
    await t(`${tag}: outside dev mode no surface starts with a tag`, async () => {
      env.TDOC_DEBUG_ACCOUNTS = '';
      try {
        const thread = await ritaThread();
        await ritaAgentAnswers(thread);
        for (const name of ['space', 'widget']) {
          const ctx = await contextFor(rita);
          const page = await tracked(ctx);
          await surfaces[name].open(page);
          await surfaces[name].tab(page, 'Replied');
          const { box } = await openBox(surfaces[name], page, thread.id);
          await page.waitForTimeout(1200);
          assert.equal(await box.inputValue(), '', `${name} started with a tag`);
          await ctx.close();
        }
        const id = await docThread();
        await julieAgentAnswers(SLUG, id);
        const ctx = await contextFor(julie);
        const page = await tracked(ctx);
        await surfaces.doc.open(page);
        const { box } = await openBox(surfaces.doc, page, id);
        await page.waitForTimeout(1200);
        assert.equal(await box.inputValue(), '', 'doc page started with a tag');
        await ctx.close();
      } finally { env.TDOC_DEBUG_ACCOUNTS = DEV; }
    });

    // ── 3. Lost reply draft ─────────────────────────────────────────────
    const DRAFT = 'half a thought that must survive';
    for (const name of ['space', 'widget']) {
      await t(`${tag}: ${name}: the agent replies mid-sentence: the card stays, the text stays, and it follows the thread to its tab`, async () => {
        const thread = await ritaThread();
        const ctx = await contextFor(rita);
        const page = await tracked(ctx);
        await surfaces[name].open(page);
        const { box } = await openBox(surfaces[name], page, thread.id);
        await box.fill(DRAFT);
        await ritaAgentAnswers(thread);
        // The space page reads the list when the answer arrives; the widget on
        // its refresh.
        if (name === 'widget') await page.locator('#tdoc-feedback-root .tdoc-fb-refresh').click();
        const list = surfaces[name].root(page).locator(`[data-comment-id="${thread.id}"] .tdoc-replies-toggle`).first();
        await list.waitFor({ timeout: 12000 });
        assert.equal(await box.inputValue(), DRAFT, 'the text went');
        await shot(page, `${name}-kept-after-agent-reply`);
        // Move tabs by hand: it lives under Replied now, with its text.
        await surfaces[name].tab(page, 'Replied');
        const again = surfaces[name].root(page).locator(`[data-comment-id="${thread.id}"] .tdoc-reply-form textarea`).first();
        await again.waitFor({ timeout: 5000 });
        assert.equal(await again.inputValue(), DRAFT, 'gone after the tab change');
        await surfaces[name].tab(page, 'All');
        await again.waitFor({ timeout: 5000 });
        assert.equal(await again.inputValue(), DRAFT);
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    }
    for (const name of ['space', 'widget', 'doc']) {
      await t(`${tag}: ${name}: a draft outlives closing, reloading and a failed post; a good post clears it; another account never sees it`, async () => {
        const isDoc = name === 'doc';
        const thread = isDoc ? { id: await docThread() } : await ritaThread({ ask: false });
        const who = isDoc ? julie : rita;
        const surface = surfaces[name];
        const ctx = await contextFor(who);
        const page = await tracked(ctx);
        await surface.open(page);
        const { card, box } = await openBox(surface, page, thread.id);
        await box.fill(DRAFT);
        // Close it the way people do: the Reply toggle, then an outside tap.
        await card.getByRole('button', { name: 'Reply', exact: true }).first().click();
        await box.waitFor({ state: 'detached' });
        await card.getByRole('button', { name: 'Reply', exact: true }).first().click();
        const box2 = card.locator('.tdoc-reply-form textarea').first();
        assert.equal(await box2.inputValue(), DRAFT, 'gone after close and reopen');
        if (phone) await page.touchscreen.tap(width / 2, 12); else await page.mouse.click(5, 400);
        await page.waitForTimeout(500);
        const after = await cardOf(surface, page, thread.id);
        const box3 = after.locator('.tdoc-reply-form textarea').first();
        await box3.waitFor({ timeout: 5000 });
        assert.equal(await box3.inputValue(), DRAFT, 'gone after an outside tap');
        await page.reload();
        await page.waitForLoadState('domcontentloaded');
        if (isDoc) { await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 }); await page.waitForFunction(() => document.body.dataset.tdocReady === '1'); }
        const fresh = await cardOf(surface, page, thread.id);
        const box4 = fresh.locator('.tdoc-reply-form textarea').first();
        await box4.waitFor({ timeout: 5000 });
        assert.equal(await box4.inputValue(), DRAFT, 'gone after a reload');
        await shot(page, `${name}-restored`);
        // A failed post keeps it.
        await page.route(/\/api\/comments(\?|$)/, (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' }) : r.continue()));
        await fresh.locator('.tdoc-reply-submit.ui-btn-primary').click();
        await page.waitForTimeout(800);
        assert.equal(await box4.inputValue(), DRAFT, 'gone after a failed post');
        await page.unroute(/\/api\/comments(\?|$)/);
        // Another account in the same tab does not get it.
        await ctx.clearCookies();
        await ctx.addCookies([{ name: 'tdoc_sid', value: (isDoc ? rita : sam).sid, url: base }]);
        if (name === 'widget') {
          const samSpace = (await call('/api/feedback/connect', { method: 'POST', cookie: sam.cookie, body: { origin: TDOC } })).body;
          await page.evaluate(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${base}`, JSON.stringify(samSpace)]);
          await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${base}`, JSON.stringify(samSpace)]);
        }
        if (isDoc) {
          const docMeta = JSON.parse(await env.META.get(`meta:${SLUG}`));
          await env.META.put(`meta:${SLUG}`, JSON.stringify({ ...docMeta, access: { ...docMeta.access, mode: 'public', public: true } }));
        }
        await page.reload();
        const other = await cardOf(surface, page, thread.id).catch(() => null);
        if (other) {
          await page.waitForTimeout(500);
          assert.equal(await other.locator('.tdoc-reply-form textarea').count(), 0, 'another account sees the draft');
        }
        // Back as the writer: still there, and a good post clears it.
        await ctx.clearCookies();
        await ctx.addCookies([{ name: 'tdoc_sid', value: who.sid, url: base }]);
        if (name === 'widget') await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${base}`, JSON.stringify(ritaSpace)]);
        await page.reload();
        if (isDoc) { await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 }); await page.waitForFunction(() => document.body.dataset.tdocReady === '1'); }
        const back = await cardOf(surface, page, thread.id);
        const box5 = back.locator('.tdoc-reply-form textarea').first();
        await box5.waitFor({ timeout: 5000 });
        assert.equal(await box5.inputValue(), DRAFT);
        await back.locator('.tdoc-reply-submit.ui-btn-primary').click();
        await box5.waitFor({ state: 'detached', timeout: 8000 });
        await page.reload();
        if (isDoc) { await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 }); await page.waitForFunction(() => document.body.dataset.tdocReady === '1'); }
        const done = await cardOf(surface, page, thread.id);
        await page.waitForTimeout(400);
        assert.equal(await done.locator('.tdoc-reply-form textarea').count(), 0, 'the draft came back after it was posted');
        await ctx.close();
      });
    }
    await t(`${tag}: doc page: a list refresh with a new reply leaves the text alone`, async () => {
      const id = await docThread();
      const ctx = await contextFor(julie);
      const page = await tracked(ctx);
      await surfaces.doc.open(page);
      const { card, box } = await openBox(surfaces.doc, page, id);
      await box.fill(DRAFT);
      await julieAgentAnswers(SLUG, id);
      await card.locator('.tdoc-replies-toggle').waitFor({ timeout: 15000 });
      assert.equal(await box.inputValue(), DRAFT);
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });
    await t(`${tag}: doc page: someone resolves the thread mid-sentence under Open: the card and the text stay`, async () => {
      const id = await docThread();
      const ctx = await contextFor(julie);
      const page = await tracked(ctx);
      await surfaces.doc.open(page);
      if (phone) await page.locator('.tdoc-fab').click();
      await page.getByRole('radio', { name: /^Open/ }).first().click();
      if (phone && !(await page.locator('#tdoc-comment-layer').isVisible().catch(() => false))) await page.locator('.tdoc-fab').click();
      const { card, box } = await openBox(surfaces.doc, page, id);
      await box.fill(DRAFT);
      const done = await call('/api/comments', { method: 'PATCH', cookie: julie.cookie, body: { slug: SLUG, version: 1, id, resolved: true } });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      await card.locator('.tdoc-resolved-chip').waitFor({ timeout: 40000 });
      assert.equal(await box.inputValue(), DRAFT);
      await page.getByRole('radio', { name: /^Resolved/ }).first().click();
      await page.getByRole('radio', { name: /^Open/ }).first().click();
      await page.waitForTimeout(300);
      assert.equal(await page.locator(`#tdoc-comment-layer [data-comment-id="${id}"], .tdoc-floating-open[data-comment-id="${id}"]`).count(), 0, 'it stayed after the viewer changed tab');
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });
    await t(`${tag}: space: a draft answering a reply comes back answering that reply`, async () => {
      const thread = await ritaThread({ ask: false });
      const person = await call('/api/comments', { method: 'POST', cookie: rita.cookie, body: { slug: space.slug, version: 1, text: 'A person speaks', parent_id: thread.id } });
      assert.equal(person.status, 200, JSON.stringify(person.body));
      const ctx = await contextFor(rita);
      const page = await tracked(ctx);
      await surfaces.space.open(page);
      const card = await cardOf(surfaces.space, page, thread.id);
      await card.locator('.tdoc-replies-toggle').click();
      await card.locator(`.tdoc-reply[data-comment-id="${person.body.id}"] .tdoc-reply-toggle`).click();
      await card.locator('.tdoc-reply-form textarea').first().fill(DRAFT);
      await page.reload();
      const after = await cardOf(surfaces.space, page, thread.id);
      const box = after.locator(`.tdoc-reply[data-comment-id="${person.body.id}"] .tdoc-reply-form textarea`);
      await box.waitFor({ timeout: 8000 });
      assert.equal(await box.inputValue(), DRAFT);
      await ctx.close();
    });

    // ── Floating card, long thread ──────────────────────────────────────
    // A thread taller than the screen; the card opens from a pin or the list.
    const longThread = async (post) => post(`A long question ${++n}. ` + 'It goes on. '.repeat(30));
    const fillReplies = async (slug, id, cookie) => {
      for (let i = 0; i < 14; i += 1) {
        const r = await call('/api/comments', { method: 'POST', cookie, body: { slug, version: 1, text: `Reply ${i} ` + 'with quite a few words in it, to take up room. '.repeat(3), parent_id: id } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
    };
    const reachable = async (page, card, label) => {
      const m = await card.evaluate((el) => {
        const body = el.querySelector(':scope > .tdoc-cc-body') || el;
        const r = el.getBoundingClientRect();
        const box = el.querySelector('.tdoc-reply-form textarea')?.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: innerHeight, boxTop: box?.top, boxBottom: box?.bottom, scrolls: body.scrollHeight > body.clientHeight + 1 };
      });
      assert.ok(m.top >= 0 && m.bottom <= m.vh + 1, `${label}: the card runs off the screen (${JSON.stringify(m)})`);
      assert.ok(m.scrolls, `${label}: the thread does not scroll inside the card (${JSON.stringify(m)})`);
      assert.ok(m.boxTop >= m.top && m.boxBottom <= m.bottom && m.boxBottom <= m.vh, `${label}: the reply box is out of reach (${JSON.stringify(m)})`);
    };
    const tall = phone ? 844 : 700;
    const overThread = async (page, card) => {
      // The wheel scrolls the thread, not what is under it.
      const before = await page.evaluate(() => scrollY);
      const body = (await card.locator(':scope > .tdoc-cc-body').count()) ? card.locator(':scope > .tdoc-cc-body') : card;
      const area = await body.boundingBox();
      await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
      await page.mouse.wheel(0, 5000);
      await page.waitForTimeout(150);
      const inside = await body.evaluate((el) => el.scrollTop);
      assert.ok(inside > 0, 'the thread did not scroll');
      await page.mouse.wheel(0, 5000);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => scrollY), before, 'the wheel ran on into the page');
    };
    if (!phone) {
      await t(`${tag}: doc page, 1280x700: a thread taller than the screen fits, scrolls inside, and the reply box is at its foot`, async () => {
        // A doc of its own: one pin, so it opens the floating card, not a cluster.
        const slug = `long-${tag}`;
        assert.equal((await call('/api/upload', { method: 'POST', token: julie.token, body: { slug, version: 1, html: DOC, meta: { title: 'Long' } } })).status, 200);
        const id = (await call('/api/comments', { method: 'POST', cookie: julie.cookie, body: { slug, version: 1, text: `A long question ${++n}. ` + 'It goes on. '.repeat(30), anchor: { kind: 'text', text: 'invoices block' } } })).body.id;
        await fillReplies(slug, id, julie.cookie);
        const ctx = await browser.newContext({ viewport: { width, height: tall } });
        await ctx.addCookies([{ name: 'tdoc_sid', value: julie.sid, url: base }]);
        const page = await tracked(ctx);
        await page.goto(`${base}/d/${slug}`);
        await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
        await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
        await page.locator(`.tdoc-pin[data-id="${id}"], .tdoc-pin`).first().click({ force: true });
        const card = page.locator(`.tdoc-floating-open[data-comment-id="${id}"]`);
        await card.waitFor({ timeout: 8000 });
        await card.getByRole('button', { name: 'Reply', exact: true }).first().click();
        await card.locator('.tdoc-replies-toggle').click();
        await card.locator('.tdoc-reply-form textarea').first().waitFor();
        await page.waitForTimeout(250);
        await reachable(page, card, 'doc');
        await overThread(page, card);
        await shot(page, 'floating-long-thread');
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    } else {
      await t(`${tag}: doc page, 390: a long thread in the drawer: the reply box can be reached`, async () => {
        const id = await longThread(async (text) => (await call('/api/comments', { method: 'POST', cookie: julie.cookie, body: { slug: SLUG, version: 1, text, anchor: { kind: 'text', text: 'invoices block' } } })).body.id);
        await fillReplies(SLUG, id, julie.cookie);
        const ctx = await contextFor(julie);
        const page = await tracked(ctx);
        await surfaces.doc.open(page);
        const { card, box } = await openBox(surfaces.doc, page, id);
        await card.locator('.tdoc-replies-toggle').click();
        await box.scrollIntoViewIfNeeded();
        const b = await box.boundingBox();
        assert.ok(b && b.y >= 0 && b.y + b.height <= tall, `the box is off screen: ${JSON.stringify(b)}`);
        await shot(page, 'drawer-long-thread');
        await ctx.close();
      });
    }
    await t(`${tag}: widget: a floating thread taller than the screen fits, scrolls inside, keeps the box, and yields to a keyboard`, async () => {
      const c = await call('/api/comments', { method: 'POST', token: ritaSpace.token, body: { slug: space.slug, version: 1, text: `A long question ${++n}. ` + 'It goes on. '.repeat(30), anchor: { ...anchor, url: `${base}/__page` } } });
      assert.equal(c.status, 200, JSON.stringify(c.body));
      await fillReplies(space.slug, c.body.id, rita.cookie);
      const ctx = await browser.newContext(phone ? { viewport: { width, height: tall }, hasTouch: true } : { viewport: { width, height: tall } });
      const page = await tracked(ctx);
      await surfaces.widget.open(page);
      const root = surfaces.widget.root(page);
      const inList = root.locator(`.tdoc-fb-panel [data-comment-id="${c.body.id}"]`).first();
      await inList.waitFor({ timeout: 10000 });
      // Open it on the page: the panel's context button, for a comment here.
      await root.locator('.tdoc-fb-item', { has: page.locator(`[data-comment-id="${c.body.id}"]`) }).locator('.tdoc-fb-context').click();
      const card = root.locator(`.tdoc-floating-open[data-comment-id="${c.body.id}"]`);
      await card.waitFor({ timeout: 8000 });
      await card.locator('.tdoc-replies-toggle').click();
      await card.getByRole('button', { name: 'Reply', exact: true }).first().click();
      await card.locator('.tdoc-reply-form textarea').first().waitFor();
      await page.waitForTimeout(250);
      await reachable(page, card, 'widget');
      await overThread(page, card);
      await shot(page, 'widget-floating-long-thread');
      // A reply to a reply opens at the card's foot too, saying who it answers.
      await card.locator('.tdoc-reply .tdoc-reply-toggle').last().click();
      await card.locator(':scope > .tdoc-reply-form .tdoc-reply-to').waitFor();
      await reachable(page, card, 'widget, a reply to a reply');
      // An on-screen keyboard: only the visual viewport shrinks.
      await page.evaluate(() => {
        const view = window.visualViewport;
        const h = view.height;
        Object.defineProperty(view, 'height', { configurable: true, get: () => Math.round(h * 0.55) });
        view.dispatchEvent(new Event('resize'));
      });
      await page.waitForTimeout(250);
      const k = await card.evaluate((el) => { const r = el.getBoundingClientRect(); const b = el.querySelector('.tdoc-reply-form textarea').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, boxBottom: b.bottom, view: visualViewport.height }; });
      assert.ok(k.bottom <= k.view + 1 && k.top >= 0 && k.boxBottom <= k.view, `behind the keyboard: ${JSON.stringify(k)}`);
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    // ── The panel's width ───────────────────────────────────────────────
    await t(`${tag}: widget: the panel's width follows its edge and the keyboard, is remembered, and what the widget draws follows it`, async () => {
      await ritaThread({ ask: false });
      const ctx = await contextFor(rita);
      const page = await tracked(ctx);
      await surfaces.widget.open(page);
      const root = surfaces.widget.root(page);
      const panel = root.locator('.tdoc-fb-panel');
      await panel.waitFor({ timeout: 10000 });
      const handle = panel.locator('[role="separator"]');
      if (phone) {
        assert.equal(await handle.count(), 0, 'a handle on a phone');
        assert.equal((await panel.boundingBox()).width, width, 'the phone panel is not the whole width');
        await ctx.close();
        return;
      }
      assert.equal(Math.round((await panel.boundingBox()).width), 340);
      await page.waitForTimeout(300); // The panel's slide-in.
      const h = await handle.boundingBox();
      await page.mouse.move(h.x + h.width / 2, 300);
      await page.mouse.down();
      await page.mouse.move(h.x - 160, 300, { steps: 6 });
      await page.mouse.up();
      const wider = (await panel.boundingBox()).width;
      assert.ok(Math.abs(wider - 500) < 6, `dragged to ${wider}`);
      // The dock moves with it instead of going under.
      const dock = await root.locator('.tdoc-feedback-dock').boundingBox();
      const edge = (await panel.boundingBox()).x;
      assert.ok(dock.x + dock.width <= edge, `the dock is under the panel: ${JSON.stringify(dock)} / ${edge}`);
      await shot(page, 'panel-wider');
      // Never past the limits.
      await handle.focus();
      await page.keyboard.press('End');
      assert.equal(await handle.getAttribute('aria-valuenow'), String(Math.round((await panel.boundingBox()).width)));
      assert.ok((await panel.boundingBox()).width <= 640 && (await panel.boundingBox()).width >= 500);
      await page.keyboard.press('Home');
      assert.equal(Math.round((await panel.boundingBox()).width), 280);
      await page.keyboard.press('ArrowLeft');
      assert.equal(Math.round((await panel.boundingBox()).width), 296);
      // Remembered on this device.
      await page.reload();
      await panel.waitFor({ timeout: 10000 });
      assert.equal(Math.round((await panel.boundingBox()).width), 296);
      // A narrower window leaves the page room.
      await page.setViewportSize({ width: 800, height: 800 });
      await page.waitForTimeout(150);
      assert.ok((await panel.boundingBox()).width <= 480);
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    // ── 2. Agent list height ────────────────────────────────────────────
    // 30 agents for the owner. Every list stops at one height, scrolls, and
    // stays on the screen.
    const raft = (i) => ({ provider: 'raft', server_id: 'srv-big', agent_sub: `big-${i}`, server_slug: 'big', agent_name: `agent-${String(i).padStart(2, '0')}`, last_touched: new Date().toISOString() });
    const manyAgents = Array.from({ length: 30 }, (_, i) => raft(i));
    const saved = [];
    for (const key of [`account-notify:${julie.account_id}`, `meta:${SLUG}`, `meta:${space.slug}`]) saved.push([key, await env.META.get(key)]);
    const fits = async (page, locator, label) => {
      await locator.waitFor({ timeout: 8000 });
      await page.waitForTimeout(150);
      const m = await locator.evaluate((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right, scrolls: el.scrollHeight > el.clientHeight + 1, overflow: cs.overflowY, vh: innerHeight, vw: innerWidth };
      });
      assert.ok(m.height <= LIST_MAX + 1, `${label}: ${m.height}px tall`);
      assert.ok(m.scrolls && m.overflow === 'auto', `${label}: does not scroll (${JSON.stringify(m)})`);
      assert.ok(m.top >= 0 && m.bottom <= m.vh + 1, `${label}: runs off the screen vertically (${JSON.stringify(m)})`);
      assert.ok(m.left >= 0 && m.right <= m.vw + 1, `${label}: runs off the screen sideways (${JSON.stringify(m)})`);
      await shot(page, `list-${label.replace(/\W+/g, '-')}`);
    };
    const mentionThenPill = async (page, root, card, label) => {
      const box = card.locator('.tdoc-reply-form textarea').first();
      await box.click();
      await box.fill('@');
      await box.press('End');
      await page.keyboard.type('a');
      await page.keyboard.press('Backspace');
      await box.scrollIntoViewIfNeeded();
      const menu = root.locator('.tdoc-mention-menu');
      await fits(page, menu, `${label} typed-at list`);
      await menu.locator('.tdoc-mention-agent').first().click();
      await card.locator('.tdoc-agent-pill').first().click();
      await fits(page, root.locator('.ui-menu-popup.tdoc-agent-menu'), `${label} pill menu`);
      // The widget's Escape closes the card; the rest go on from here.
      if (label !== 'widget') { await page.keyboard.press('Escape'); await box.fill(''); }
    };
    await t(`${tag}: 30 agents: the doc page's @ list, pill menu, Ask AI menu and its More agents`, async () => {
      await env.META.put(`account-notify:${julie.account_id}`, JSON.stringify(manyAgents));
      const docMeta = JSON.parse(await env.META.get(`meta:${SLUG}`));
      await env.META.put(`meta:${SLUG}`, JSON.stringify({ ...docMeta, notify_agents: manyAgents }));
      const id = await docThread();
      const ctx = await contextFor(julie);
      const page = await tracked(ctx);
      await surfaces.doc.open(page);
      const { card } = await openBox(surfaces.doc, page, id);
      await mentionThenPill(page, page, card, 'doc');
      await noSideways(page);
      // Ask AI: the bar's button on a desktop, the drawer's tab on a phone.
      let panel;
      if (phone) {
        await page.getByRole('radiogroup', { name: 'Comments or Ask AI' }).getByRole('radio', { name: /Ask AI/ }).click();
        panel = page.locator('#tdoc-comment-layer .tdoc-ask-panel');
      } else {
        await page.keyboard.press('Escape');
        await page.locator('#tdoc-send-agent-btn').click();
        panel = page.getByRole('dialog', { name: 'Ask AI' });
      }
      await panel.waitFor();
      await panel.locator('.tdoc-ask-target-pill.tdoc-agent-pill').first().click();
      const main = page.locator('.ui-menu-popup.tdoc-agent-menu').first();
      await main.waitFor();
      await page.waitForTimeout(150);
      const box = await main.boundingBox();
      assert.ok(box.height <= LIST_MAX + 1, `Ask AI menu: ${box.height}px`);
      await shot(page, 'list-ask-ai-menu');
      await page.locator('.tdoc-agent-menu-more').click();
      await fits(page, page.locator('.ui-menu-popup.tdoc-agent-menu').last(), 'Ask AI More agents');
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });
    await t(`${tag}: 30 agents: the space page's @ list, pill menu and Send to agent list`, async () => {
      await env.META.put(`account-notify:${julie.account_id}`, JSON.stringify(manyAgents));
      const spaceMeta = JSON.parse(await env.META.get(`meta:${space.slug}`));
      await env.META.put(`meta:${space.slug}`, JSON.stringify({ ...spaceMeta, notify_agents: manyAgents }));
      const c = await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: `Many ${++n}`, anchor } });
      const ctx = await contextFor(julie);
      const page = await tracked(ctx);
      await surfaces.space.open(page);
      const { card } = await openBox(surfaces.space, page, c.body.id);
      await mentionThenPill(page, page, card, 'space');
      await noSideways(page);
      await page.getByRole('button', { name: /Send to agent/ }).first().click();
      await page.locator('.ui-combo-input').first().click();
      await fits(page, page.locator('.ui-combo-popup').first(), 'space Send to agent');
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });
    await t(`${tag}: 30 agents: the widget's @ list and pill menu`, async () => {
      await env.META.put(`account-notify:${julie.account_id}`, JSON.stringify(manyAgents));
      const c = await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: `Many ${++n}`, anchor } });
      const ctx = await contextFor(null);
      const page = await tracked(ctx);
      await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${base}`, JSON.stringify(space)]);
      await page.goto(`${base}/__page`);
      const root = page.locator('#tdoc-feedback-root');
      const card = root.locator(`[data-comment-id="${c.body.id}"]`).first();
      await card.waitFor({ timeout: 10000 });
      await card.getByRole('button', { name: 'Reply', exact: true }).first().click();
      await card.locator('.tdoc-reply-form textarea').first().waitFor();
      await mentionThenPill(page, root, card, 'widget');
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });
    // Put back what the 30 agents replaced.
    for (const [key, value] of saved) { if (value === null) await env.META.delete(key); else await env.META.put(key, value); }
  }

  await chromium.close();
  if (webkit) await webkit.close();
  server.close();
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
