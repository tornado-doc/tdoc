// One comment layer on every surface (AGENTS.md): the same cases run against
// the doc page and the feedback widget, and read state crosses to the space
// page. Phase 1 of the shared comments core (shell/src/comments/core/):
//   - the filter: Open by default (resolved hidden), Open / Replied /
//     Resolved / All with counts, remembered per doc / space;
//   - an agent's reply arrives by the shared 15 s feed (pinned short here)
//     into an open thread, without a reload;
//   - read state is the server's: read in the widget = read on the space
//     page and the reverse, and it survives a fresh browser on the doc page;
//   - the widget honours autoReadComments (read when seen) as the doc does;
//   - /api/comments/seen refuses whoever cannot read the comments.
// Real worker routes behind a local server, the built runtimes, chromium at
// 1280 and 390. TDOC_UI_SHOTS=<dir> saves screenshots.
// Run with: node test/comment-parity-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('comment-parity-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TDOC = 'https://tdoc.dev';
const DOC = (slug) => `<!doctype html><html><body><h1>${slug}</h1><p id="a">Alpha line one to comment on.</p><p id="b">Bravo line two to comment on.</p><p id="c">Charlie line three to comment on.</p><p id="d">Delta line four to comment on.</p></body></html>`;
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
    // A browser closing mid-request (a poll, a read mark) aborts its body.
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
  console.log('Comment parity: doc page and widget run the same cases');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
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
  const eve = await person('eve', 'e');
  assert.equal((await call('/api/notify/local/register', { method: 'POST', token: julie.token, body: { device: 'mac-mini', clis: ['claude'] } })).status, 200);
  // An agent of Julie's that may edit her space, reachable from the widget
  // (a Raft one: the widget's list leaves her computer's CLIs out).
  const RAFT = { provider: 'raft', server_id: 'srv-owner', agent_sub: 'fixer', server_slug: 'owner', agent_name: 'fixer-agent', last_touched: new Date().toISOString() };
  await env.META.put(`account-notify:${julie.account_id}`, JSON.stringify([RAFT]));
  const space = (await call('/api/feedback/connect', { method: 'POST', cookie: julie.cookie, body: { origin: TDOC } })).body;
  assert.ok(space.slug && space.token, JSON.stringify(space));

  let n = 0;
  const anchors = ['Alpha line one', 'Bravo line two', 'Charlie line three', 'Delta line four'];
  // Each surface gets its own doc / space: the same four threads on each.
  const surfaces = {};
  const freshDoc = async () => {
    const slug = `parity-${++n}`;
    assert.equal((await call('/api/upload', { method: 'POST', token: julie.token, body: { slug, version: 1, html: DOC(slug), meta: { title: slug } } })).status, 200);
    return { slug, version: 1, auth: { cookie: julie.cookie } };
  };
  const freshSpace = async () => {
    const made = (await call('/api/feedback/connect', { method: 'POST', cookie: julie.cookie, body: { origin: `http://127.0.0.1:${4000 + (++n)}` } })).body;
    // The widget runs on this test's own origin: point the space at it.
    return { slug: made.slug, version: 1, auth: { token: made.token }, session: made };
  };
  const anchorFor = (kind, i) => (kind === 'doc'
    ? { kind: 'text', text: anchors[i] }
    : { kind: 'product', url: `${base}/__page`, selector: i % 2 ? '#y' : '#x', tag: 'p', text: 'Something' });
  const thread = async (target, kind, i, text) => {
    const c = await call('/api/comments', { method: 'POST', ...target.auth, body: { slug: target.slug, version: 1, text, anchor: anchorFor(kind, i) } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    return c.body.id;
  };
  const agentReplies = async (target, id, text) => {
    const h = await call('/api/notify/handoff', { method: 'POST', cookie: julie.cookie, body: { slug: target.slug, comment_ids: [id], recipient: { provider: 'local', server_id: 'mac-mini', agent_sub: 'mac-mini_claude' } } });
    assert.equal(h.status, 200, JSON.stringify(h.body));
    const a = await call('/api/agent/reply', { method: 'POST', token: julie.token, body: { slug: target.slug, parent_id: id, text, status: 'answered', agent_login: 'claude', agent_name: 'claude' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
  };
  // The agent answers once per human turn: a person speaks, then it answers.
  const turn = async (target, id, words) => {
    const r = await call('/api/comments', { method: 'POST', cookie: julie.cookie, body: { slug: target.slug, version: 1, text: `And then? ${++n}`, parent_id: id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await agentReplies(target, id, words);
  };
  const resolve = async (target, id) => {
    const r = await call('/api/comments', { method: 'PATCH', cookie: julie.cookie, body: { slug: target.slug, version: 1, id, resolved: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };

  const { server, base } = await startServer(worker, env);
  let failed = 0;
  const only = process.env.TDOC_TEST_ONLY ? new RegExp(process.env.TDOC_TEST_ONLY) : null;
  const t = async (name, fn) => { if (only && !only.test(name)) return; try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${String(error.message).split('\n').slice(0, 8).join('\n    ')}`); } };
  const chromium = await pw.chromium.launch({ headless: true });

  for (const width of [1280, 390]) {
    const tag = `chromium-${width}`;
    const phone = width < 700;
    const contextFor = async () => {
      const ctx = await chromium.newContext(phone ? { viewport: { width, height: 844 }, hasTouch: true } : { viewport: { width, height: 800 } });
      await ctx.addCookies([{ name: 'tdoc_sid', value: julie.sid, url: base }]);
      await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
      return ctx;
    };
    const tracked = async (ctx, { pollMs = 0, flags = null } = {}) => {
      const page = await ctx.newPage();
      page.errors = [];
      page.on('pageerror', (e) => page.errors.push(e.message));
      if (pollMs) await page.addInitScript((ms) => { window.__TDOC_COMMENT_POLL_MS = ms; }, pollMs);
      if (flags) await page.addInitScript((f) => { window.__TDOC_FLAGS__ = f; }, flags);
      return page;
    };
    const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, `${tag}-${name}.png`) }); } };

    // How each surface shows its list header and a card. The doc page's
    // header is the filter dock (desktop) or the drawer (phone).
    const ui = {
      doc: {
        open: async (page, target) => {
          await page.goto(`${base}/d/${target.slug}`);
          await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
          await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
        },
        header: async (page) => {
          if (!phone) return page.locator('.tdoc-comment-filter-dock');
          const drawer = page.locator('#tdoc-comment-layer');
          if (!(await drawer.isVisible().catch(() => false))) await page.locator('.tdoc-fab').click();
          await drawer.locator('.tdoc-comment-filter').waitFor();
          return drawer;
        },
        filter: async (page, name) => (await ui.doc.header(page)).locator('.tdoc-comment-filter').getByRole('radio', { name: new RegExp(`^${name}`) }),
        labels: async (page) => (await ui.doc.header(page)).locator('.tdoc-comment-filter [role="radio"]').allInnerTexts(),
        // Where a thread can be seen: its pin on desktop, its card in the drawer.
        present: async (page, id) => (phone
          ? (await ui.doc.header(page)).locator(`[data-comment-id="${id}"]`)
          : page.locator(`.tdoc-pin[data-id="${id}"]`)),
        openThread: async (page, id) => {
          if (phone) { await (await ui.doc.header(page)).locator(`[data-comment-id="${id}"]`).first().click(); return; }
          await page.locator(`.tdoc-pin[data-id="${id}"]`).click({ force: true });
          await page.locator(`.tdoc-margin-comment [data-comment-id="${id}"], .tdoc-margin-comment[data-comment-id="${id}"]`).first().waitFor({ timeout: 8000 }).catch(() => {});
        },
        markAll: async (page) => (await ui.doc.header(page)).getByRole('button', { name: 'Mark all as read' }),
      },
      widget: {
        open: async (page, target) => {
          await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${base}`, JSON.stringify(target.session)]);
          await page.goto(`${base}/__page`);
        },
        header: async (page) => {
          // Opened by the bookmark: the list opens itself once loaded.
          const panel = page.locator('#tdoc-feedback-root .tdoc-fb-panel');
          const filter = panel.locator('.tdoc-fb-filter');
          const opened = await filter.waitFor({ timeout: 8000 }).then(() => true, () => false);
          if (!opened) await page.locator('#tdoc-feedback-root .tdoc-feedback-dock button').first().click();
          await filter.waitFor({ timeout: 15000 });
          return panel;
        },
        filter: async (page, name) => (await ui.widget.header(page)).locator('.tdoc-fb-filter button', { hasText: new RegExp(`^${name}`) }),
        labels: async (page) => (await ui.widget.header(page)).locator('.tdoc-fb-filter button').allInnerTexts(),
        present: async (page, id) => (await ui.widget.header(page)).locator(`[data-comment-id="${id}"]`),
        openThread: async (page, id) => { await (await ui.widget.header(page)).locator(`[data-comment-id="${id}"]`).first().click(); },
        markAll: async (page) => (await ui.widget.header(page)).locator('.tdoc-fb-readbar').getByRole('button', { name: 'Mark all as read' }),
      },
    };
    const selected = async (el) => ((await el.getAttribute('aria-checked')) || (await el.getAttribute('aria-pressed'))) === 'true';

    for (const kind of ['doc', 'widget']) {
      const s = ui[kind];
      const target = kind === 'doc' ? await freshDoc() : await freshSpace();
      const ids = {};
      ids.open = await thread(target, kind, 0, `Open one ${tag}`);
      ids.replied = await thread(target, kind, 1, `Answered ${tag}`);
      await agentReplies(target, ids.replied, `First answer ${tag}`);
      ids.resolved = await thread(target, kind, 2, `Closed ${tag}`);
      await resolve(target, ids.resolved);

      await t(`${tag}: ${kind}: Open is the default, every choice says its count, and the choice is remembered`, async () => {
        const ctx = await contextFor();
        const page = await tracked(ctx);
        await s.open(page, target);
        assert.deepEqual((await s.labels(page)).map((x) => x.trim()), ['Open (2)', 'Replied (1)', 'Resolved (1)', 'All (3)']);
        assert.equal(await selected(await s.filter(page, 'Open')), true, 'Open is not the default');
        await (await s.present(page, ids.open)).first().waitFor({ timeout: 10000 });
        assert.equal(await (await s.present(page, ids.resolved)).count(), 0, 'a resolved thread shows under Open');
        await shot(page, `${kind}-filter-open`);
        await (await s.filter(page, 'All')).click();
        await (await s.present(page, ids.resolved)).first().waitFor({ timeout: 10000 });
        await page.reload();
        assert.equal(await selected(await s.filter(page, 'All')), true, 'the choice was not remembered');
        await (await s.filter(page, 'Open')).click();
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });

      await t(`${tag}: ${kind}: an agent's reply arrives by the poll into an open thread, no reload`, async () => {
        const ctx = await contextFor();
        const page = await tracked(ctx, { pollMs: 700 });
        await s.open(page, target);
        await (await s.present(page, ids.open)).first().waitFor({ timeout: 10000 });
        // The thread is open where the surface opens one in place (the doc's
        // phone drawer sends a tap to the document, so there it stays listed).
        const inPlace = !(kind === 'doc' && phone);
        if (inPlace) await s.openThread(page, ids.open);
        const words = `Polled answer ${tag} ${kind}`;
        await agentReplies(target, ids.open, words);
        // The counts move with it...
        const deadline = Date.now() + 15000;
        while (!(await s.labels(page)).some((x) => x.trim() === 'Replied (2)')) {
          assert.ok(Date.now() < deadline, `no poll: ${(await s.labels(page)).join(' | ')}`);
          await page.waitForTimeout(250);
        }
        // ...and the open thread shows the reply.
        if (inPlace) await page.getByText(words).first().waitFor({ state: 'attached', timeout: 15000 });
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });

      await t(`${tag}: ${kind}: read state is the server's: Mark all as read here is read in a fresh browser`, async () => {
        await turn(target, ids.replied, `Second answer ${tag}`);
        const first = await contextFor();
        const page = await tracked(first);
        await s.open(page, target);
        const button = await s.markAll(page);
        await button.waitFor({ timeout: 10000 });
        await button.click();
        await button.waitFor({ state: 'detached', timeout: 10000 });
        await page.waitForTimeout(600);
        await first.close();
        // A new browser has no localStorage: only the server knows.
        const second = await contextFor();
        const again = await tracked(second);
        await s.open(again, target);
        await (await s.present(again, ids.replied)).first().waitFor({ timeout: 10000 });
        await again.waitForTimeout(1500);
        assert.equal(await (await s.markAll(again)).count(), 0, 'read in one browser, unread in the next');
        assert.deepEqual(again.errors, []);
        await second.close();
      });
    }

    // Read state costs nothing at rest: a poll over a thread no agent has
    // spoken in sends no mark; a mark the server will not keep (a thread
    // that is gone) is sent once, then dropped from this browser's cache.
    for (const kind of ['doc', 'widget']) {
      const s = ui[kind];
      await t(`${tag}: ${kind}: a steady poll over an open human-only thread sends no read marks`, async () => {
        const target = kind === 'doc' ? await freshDoc() : await freshSpace();
        const id = await thread(target, kind, 0, `Quiet ${tag}`);
        const ctx = await contextFor();
        const page = await tracked(ctx, { pollMs: 400 });
        const posts = [];
        page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/comments/seen')) posts.push(r.url()); });
        await s.open(page, target);
        await (await s.present(page, id)).first().waitFor({ timeout: 10000 });
        if (!(kind === 'doc' && phone)) await s.openThread(page, id);
        await page.waitForTimeout(4000);
        assert.deepEqual(posts, [], `${posts.length} read-mark POSTs at rest`);
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });

      await t(`${tag}: ${kind}: a mark the server will not keep is sent once, then dropped`, async () => {
        const target = kind === 'doc' ? await freshDoc() : await freshSpace();
        const id = await thread(target, kind, 0, `Gone mark ${tag}`);
        const ctx = await contextFor();
        const page = await tracked(ctx, { pollMs: 400 });
        await page.addInitScript((slug) => { if (window.top !== window) return; if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem(`tdoc.thread-seen.${slug}`, JSON.stringify({ c_gone_thread_1: Date.now() - 1000 })); } }, target.slug);
        const posts = [];
        page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/comments/seen')) posts.push(r.postData()); });
        await s.open(page, target);
        await (await s.present(page, id)).first().waitFor({ timeout: 10000 });
        await page.waitForTimeout(12000);
        assert.ok(posts.length <= 1, `sent ${posts.length} times: ${posts.join(' | ')}`);
        const cache = await page.evaluate((slug) => JSON.parse(localStorage.getItem(`tdoc.thread-seen.${slug}`) || '{}'), target.slug);
        assert.ok(!('c_gone_thread_1' in cache), `still cached: ${JSON.stringify(cache)}`);
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    }

    // Ask only on an agent that may edit (#969): the widget and the space
    // page ask it, through my-agent, in the thread; nothing is handed off.
    for (const where of ['widget', 'space']) {
      await t(`${tag}: ${where}: Ask only on an agent that may edit asks it, and hands nothing off`, async () => {
        const target = { slug: space.slug, version: 1, auth: { token: space.token }, session: space };
        const anchor = { kind: 'product', url: `${base}/__page`, selector: '#x', tag: 'p', text: 'Something' };
        const c = await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: `Ask me ${tag} ${where}`, anchor } });
        assert.equal(c.status, 200, JSON.stringify(c.body));
        const ctx = await contextFor();
        const page = await tracked(ctx);
        const asks = [];
        const handoffs = [];
        page.on('request', (r) => {
          if (r.method() !== 'POST') return;
          if (r.url().includes(`/api/docs/${space.slug}/my-agent`)) asks.push(r.postDataJSON());
          if (r.url().includes('/api/notify/handoff')) handoffs.push(r.url());
        });
        let root;
        if (where === 'widget') { await ui.widget.open(page, target); root = await ui.widget.header(page); }
        else { await page.goto(`${base}/d/${space.slug}`); root = page; }
        const card = root.locator(`[data-comment-id="${c.body.id}"]`).first();
        await card.waitFor({ timeout: 15000 });
        await card.getByRole('button', { name: 'Reply', exact: true }).first().click();
        const form = card.locator('.tdoc-reply-form').first();
        await form.locator('textarea').fill('Why is it here?');
        await form.locator('.tdoc-reply-agent').click();
        await form.locator('.tdoc-agent-pill').waitFor({ timeout: 10000 });
        const box = form.locator('.tdoc-ask-only [role=checkbox]');
        assert.equal(await box.getAttribute('aria-checked'), 'false', 'Ask only is not offered, off, for an agent that may edit');
        await form.locator('.tdoc-ask-only .ui-checkbox-label').click();
        assert.equal(await box.getAttribute('aria-checked'), 'true', 'Ask only did not tick');
        await form.getByRole('button', { name: 'Reply', exact: true }).click();
        for (let i = 0; i < 40 && !asks.length; i++) await page.waitForTimeout(250);
        assert.equal(asks.length, 1, 'nobody was asked');
        assert.equal(asks[0].recipient && asks[0].recipient.agent_sub, RAFT.agent_sub, JSON.stringify(asks[0]));
        assert.deepEqual(handoffs, [], 'handed off to edit');
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    }

    // The widget and the space's own tdoc page are two origins of the same
    // space in real life (the app's and tdoc's): a reply read on one is read
    // on the other, both ways.
    await t(`${tag}: a reply read in the widget is read on the space page, and the reverse`, async () => {
      const target = await freshSpace();
      const id = await thread(target, 'widget', 0, `Cross ${tag}`);
      await agentReplies(target, id, `Cross answer one ${tag}`);
      const spaceUnread = async (page) => page.locator(`[data-comment-id="${id}"] .tdoc-thread-unread-dot`).count();

      let ctx = await contextFor();
      let page = await tracked(ctx);
      await ui.widget.open(page, target);
      await (await ui.widget.markAll(page)).click();
      await (await ui.widget.header(page)).locator('.tdoc-fb-readbar').waitFor({ state: 'detached' });
      await page.waitForTimeout(600);
      await ctx.close();
      ctx = await contextFor();
      page = await tracked(ctx);
      await page.goto(`${base}/d/${target.slug}`);
      await page.locator(`[data-comment-id="${id}"]`).first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(1500);
      assert.equal(await spaceUnread(page), 0, 'read in the widget, unread on the space page');
      await shot(page, 'space-read');

      await turn(target, id, `Cross answer two ${tag}`);
      await page.reload();
      await page.locator(`[data-comment-id="${id}"] .tdoc-thread-unread-dot`).first().waitFor({ timeout: 15000 });
      await page.getByRole('button', { name: 'Mark all as read' }).click();
      await page.locator(`[data-comment-id="${id}"] .tdoc-thread-unread-dot`).waitFor({ state: 'detached' });
      await page.waitForTimeout(600);
      assert.deepEqual(page.errors, []);
      await ctx.close();
      ctx = await contextFor();
      page = await tracked(ctx);
      await ui.widget.open(page, target);
      await (await ui.widget.present(page, id)).first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(1500);
      assert.equal(await page.locator('#tdoc-feedback-root .tdoc-fb-readbar').count(), 0, 'read on the space page, unread in the widget');
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    // autoReadComments: on, a thread is read once its card has been in view;
    // off, only when opened. The widget reads its own flags (here pinned).
    await t(`${tag}: widget: autoReadComments reads a card once seen; off, it waits to be opened`, async () => {
      const target = await freshSpace();
      const id = await thread(target, 'widget', 0, `Seen ${tag}`);
      await agentReplies(target, id, `Seen answer ${tag}`);
      let ctx = await contextFor();
      let page = await tracked(ctx, { flags: { autoReadComments: false } });
      await ui.widget.open(page, target);
      const header = await ui.widget.header(page);
      await header.locator(`[data-comment-id="${id}"] .tdoc-thread-unread-dot`).first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(1800);
      assert.equal(await header.locator('.tdoc-fb-readbar').count(), 1, 'flag off: read without being opened');
      await ctx.close();
      ctx = await contextFor();
      page = await tracked(ctx, { flags: { autoReadComments: true } });
      await ui.widget.open(page, target);
      const panel = await ui.widget.header(page);
      await panel.locator(`[data-comment-id="${id}"]`).first().waitFor({ timeout: 10000 });
      await panel.locator('.tdoc-fb-readbar').waitFor({ state: 'detached', timeout: 8000 });
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });
  }

  await t('the seen endpoint refuses whoever cannot read the comments, on a doc and on a space', async () => {
    const doc = await freshDoc();
    // A private doc (uploads are link-readable by default).
    const meta = JSON.parse(await env.META.get(`meta:${doc.slug}`));
    await env.META.put(`meta:${doc.slug}`, JSON.stringify({ ...meta, access: { ...(meta.access || {}), visibility: 'private' } }));
    for (const slug of [doc.slug, space.slug]) {
      const comments = await call(`/api/comments?slug=${slug}&version=1`, { cookie: eve.cookie });
      const seen = await call(`/api/comments/seen?slug=${slug}`, { cookie: eve.cookie });
      const posted = await call('/api/comments/seen', { method: 'POST', cookie: eve.cookie, body: { slug, seen: { c_x: 1 } } });
      assert.equal(comments.status, 403, `eve reads ${slug}: ${comments.status}`);
      for (const r of [seen, posted]) assert.deepEqual([r.status, r.body], [comments.status, comments.body]);
    }
    // The widget's token, on a doc it was not minted for.
    const cross = await call(`/api/comments/seen?slug=${doc.slug}`, { token: space.token });
    assert.deepEqual([cross.status, cross.body.error], [403, 'feedback_token_scope']);
  });

  await chromium.close();
  server.close();
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
