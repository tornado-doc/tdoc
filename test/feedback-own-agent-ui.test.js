// A person who joined someone else's feedback space reaches THEIR OWN agents
// (answer only, in the thread), never the owner's, on both feedback
// surfaces: the space's page on tdoc and the in-app widget, where the widget
// is the bookmarklet on tdoc's own pages. Real worker routes (in-process
// harness) behind a local HTTP server, the built runtimes, a browser.
//
//   - Space page, as the joiner: the reply box's @ list holds the joiner's
//     agents and not the owner's; replying to one asks it (my-agent).
//   - Widget on a tdoc page: the same @ list, and the same ask.
//   - Widget for a third-party app's space: no agents at all.
//   - Desktop and phone: nothing runs off the side.
//
// TDOC_UI_ENGINES=chromium,webkit runs both engines; TDOC_UI_SHOTS=<dir>
// saves a screenshot of each step.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const playwright = requirePlaywrightOrSkip('feedback-own-agent-ui.test.js');

const SHOTS = process.env.TDOC_UI_SHOTS || '';
const ENGINES = (process.env.TDOC_UI_ENGINES || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);
const TDOC = 'https://tdoc.dev';
const HOME = { Origin: TDOC };
const APP = 'http://localhost:3000';

// A plain page on the tdoc origin that loads the widget the way the
// bookmarklet does.
const TDOC_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>tdoc page</title>
<style>body{font:16px system-ui;margin:0}main{max-width:640px;margin:80px auto;padding:0 24px}</style></head>
<body><main><h1>My docs</h1><p id="x">Something to comment on.</p></main>
<script>
window.__fbRoot = () => document.getElementById('tdoc-feedback-root')?.shadowRoot?.getElementById('tdoc-feedback-root');
</script>
<script src="/feedback.js" data-tdoc-open="1"></script></body></html>`;

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (request, res) => {
    const pathname = request.url.split('?')[0];
    if (pathname === '/__page') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(TDOC_PAGE);
    }
    // The built widget (the harness worker serves a placeholder for it).
    if (pathname === '/feedback.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'server/runtime/feedback.js')));
    }
    const asset = byPath.get(pathname);
    if (asset) {
      res.setHeader('content-type', asset.type);
      return res.end(fs.readFileSync(asset.file));
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const headers = { ...request.headers, host: 'tdoc.dev' };
    if (headers.origin) headers.origin = TDOC;
    delete headers.referer;
    const response = await worker.fetch(new Request(`${TDOC}${request.url}`, {
      method: request.method,
      headers,
      redirect: 'manual',
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
  console.log('Feedback: a joiner asks their own agents');
  const mod = await loadWorker();
  const worker = mod.default;
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const call = async (env, p, opts) => {
    const r = await worker.fetch(req(p, opts), env, {});
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  const raft = (sub, name, server) => ({ provider: 'raft', server_id: `srv-${server}`, agent_sub: sub, server_slug: server, agent_name: name, last_touched: new Date().toISOString() });
  // Serena owns a feedback space for tdoc.dev itself (and one for her app),
  // with her agent; Julie joined both and has two agents of her own.
  const world = async () => {
    const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
    const serena = await issue(worker, env, 'serena');
    const julie = await issue(worker, env, 'julie');
    await env.META.put(`account-notify:${serena.account_id}`, JSON.stringify([raft('s1', 'serena-codex', 'stan')]));
    await env.META.put(`account-notify:${julie.account_id}`, JSON.stringify([raft('j1', 'julie-claw', 'julie'), raft('j2', 'bencher', 'raft')]));
    const space = (await call(env, '/api/feedback/connect', { method: 'POST', cookie: serena.cookie, headers: HOME, body: { origin: TDOC } })).body;
    const app = (await call(env, '/api/feedback/connect', { method: 'POST', cookie: serena.cookie, headers: HOME, body: { origin: APP } })).body;
    // Serena invites Julie by name (a link alone no longer lets anyone join).
    for (const s of [space, app]) {
      const meta = JSON.parse(await env.META.get(`meta:${s.slug}`));
      meta.access = { ...meta.access, allowed_users: ['julie'] };
      await env.META.put(`meta:${s.slug}`, JSON.stringify(meta));
      await call(env, '/api/feedback/join', { method: 'POST', cookie: julie.cookie, headers: HOME, body: { slug: s.slug } });
    }
    const mine = (await call(env, '/api/feedback/connect', { method: 'POST', cookie: julie.cookie, headers: HOME, body: { origin: TDOC } })).body;
    const mineApp = (await call(env, '/api/feedback/connect', { method: 'POST', cookie: julie.cookie, headers: HOME, body: { origin: APP } })).body;
    assert.equal(mine.slug, space.slug);
    assert.equal(mineApp.slug, app.slug);
    const anchor = (origin) => ({ kind: 'product', url: `${origin}/me`, selector: '#x', tag: 'p', text: 'Something to comment on.' });
    const comment = (await call(env, '/api/comments', { method: 'POST', token: mine.token, body: { slug: space.slug, version: 1, text: 'Why is the list empty?', anchor: anchor(TDOC) } })).body;
    await call(env, '/api/comments', { method: 'POST', token: mineApp.token, body: { slug: app.slug, version: 1, text: 'Why is the chart empty?', anchor: anchor(APP) } });
    const { server, base } = await startServer(worker, env);
    return { env, serena, julie, space, app, mine, mineApp, comment, server, base };
  };
  const sid = (cookie) => cookie.split('=')[1];
  const noSideways = async (page) => assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the page scrolls sideways',
  );
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const asksOf = async (w, slug) => JSON.parse((await w.env.META.get(`agent-asks:${slug}:${w.julie.account_id}`)) || '[]');

  for (const engine of ENGINES) {
    const browser = await playwright[engine].launch({ headless: true });
    try {
      for (const width of [1440, 390]) {
        const tag = `${engine}-${width}`;
        await t(`${tag}: space page as a joiner: @ lists only the joiner's own agents; a reply asks one`, async () => {
          const w = await world();
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          try {
            await context.addCookies([{ name: 'tdoc_sid', value: sid(w.julie.cookie), url: w.base }]);
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(`${w.base}/d/${w.space.slug}`);
            const card = page.locator(`[data-comment-id="${w.comment.id}"]`).first();
            await card.waitFor();
            await card.getByRole('button', { name: 'Reply' }).first().click();
            const box = page.locator('.tdoc-reply-form textarea').first();
            await box.waitFor();
            await box.fill('@');
            const menu = page.locator('.tdoc-mention-menu');
            await menu.waitFor();
            const names = await menu.locator('.tdoc-mention-agent .tdoc-mention-login').allInnerTexts();
            assert(names.some((n) => /julie-claw/.test(n)) && names.some((n) => /bencher/.test(n)), `own agents missing: ${names}`);
            assert(!names.some((n) => /serena/.test(n)), `the owner's agent is offered: ${names}`);
            assert(!names.some((n) => /tdoc AI/i.test(n)), `tdoc AI is offered: ${names}`);
            await noSideways(page);
            await shot(page, `${tag}-space-page-joiner-at-list`);
            await menu.locator('.tdoc-mention-agent', { hasText: 'bencher' }).first().click();
            await box.press('End');
            await box.type('can you check this?');
            await page.locator('.tdoc-ask-only [role=checkbox][aria-checked="true"][data-disabled]').first().waitFor();
            assert.equal(await page.locator('.tdoc-only-me').count(), 0, 'Only me shows where no private answer can');
            await shot(page, `${tag}-space-page-joiner-picked`);
            await page.locator('.tdoc-reply-form .tdoc-reply-submit.ui-btn-primary').first().click();
            await expectAsk(w, w.space.slug);
            // The page says what happened (this harness has no Raft, so the
            // delivery itself fails; the question is still recorded).
            await page.locator('[role="status"]', { hasText: 'bencher' }).waitFor();
            await shot(page, `${tag}-space-page-joiner-asked`);
            assert.deepEqual(errors, []);
          } finally { await context.close(); w.server.close(); }
        });

        await t(`${tag}: widget on a tdoc page: @ lists the joiner's own agents; a reply asks one`, async () => {
          const w = await world();
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          try {
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${w.base}`, JSON.stringify(w.mine)]);
            await page.goto(`${w.base}/__page`);
            const root = page.locator('#tdoc-feedback-root');
            const card = root.locator(`[data-comment-id="${w.comment.id}"]`).first();
            await card.waitFor();
            await shot(page, `${tag}-widget-open`);
            await card.getByRole('button', { name: 'Reply' }).first().click();
            const box = root.locator('.tdoc-reply-form textarea').first();
            await box.waitFor();
            await box.fill('@');
            const menu = root.locator('.tdoc-mention-menu');
            await menu.waitFor();
            const names = await menu.locator('.tdoc-mention-agent .tdoc-mention-login').allInnerTexts();
            assert(names.some((n) => /julie-claw/.test(n)) && names.some((n) => /bencher/.test(n)), `own agents missing: ${names}`);
            assert(!names.some((n) => /serena/.test(n)), `the owner's agent is offered: ${names}`);
            await noSideways(page);
            await shot(page, `${tag}-widget-joiner-at-list`);
            await menu.locator('.tdoc-mention-agent', { hasText: 'bencher' }).first().click();
            await box.press('End');
            await box.type('can you check this?');
            await root.locator('.tdoc-ask-only [role=checkbox][aria-checked="true"][data-disabled]').first().waitFor();
            await root.locator('.tdoc-reply-form .tdoc-reply-submit.ui-btn-primary').first().click();
            await expectAsk(w, w.space.slug);
            // What happened is said on screen, inside it (phone: over the panel).
            const toast = root.locator('.tdoc-fb-toast', { hasText: 'bencher' });
            await toast.waitFor();
            const tbox = await toast.boundingBox();
            assert(tbox && tbox.x >= 0 && tbox.x + tbox.width <= width + 0.5, `toast off screen: ${JSON.stringify(tbox)}`);
            await shot(page, `${tag}-widget-joiner-asked`);
            assert.deepEqual(errors, []);
          } finally { await context.close(); w.server.close(); }
        });

        await t(`${tag}: the agent the joiner used on this space comes first, on the space page and in the widget`, async () => {
          const w = await world();
          // bencher answered Julie here; julie-claw leads her account's list.
          // In the thread: the widget's token does not count a private question.
          const answered = { ask_id: 'a1', at: new Date().toISOString(), by: w.julie.account_id, question: 'q', comment_id: w.comment.id, recipient: raft('j2', 'bencher', 'raft'),
            delivery: { status: 'delivered' }, answer: { text: 'a', at: new Date().toISOString() } };
          await w.env.META.put(`agent-asks:${w.space.slug}:${w.julie.account_id}`, JSON.stringify([answered]));
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          try {
            await context.addCookies([{ name: 'tdoc_sid', value: sid(w.julie.cookie), url: w.base }]);
            const page = await context.newPage();
            const listFrom = async (root, name) => {
              const card = root.locator(`[data-comment-id="${w.comment.id}"]`).first();
              await card.waitFor();
              // The same tab, so the '@' from the page before is a draft on this thread: its box reopens.
              const box = root.locator('.tdoc-reply-form textarea').first();
              if (!(await box.isVisible().catch(() => false))) await card.getByRole('button', { name: 'Reply' }).first().click();
              await box.waitFor();
              await box.fill('');
              await box.fill('@');
              const menu = root.locator('.tdoc-mention-menu');
              await menu.waitFor();
              const names = await menu.locator('.tdoc-mention-agent .tdoc-mention-login').allInnerTexts();
              assert.ok(/bencher/.test(names[0]) && /julie-claw/.test(names[1]), `order: ${names}`);
              assert.ok(!names.some((n) => /serena/.test(n)), `the owner's agent is offered: ${names}`);
              await shot(page, `${tag}-${name}-used-first`);
            };
            await page.goto(`${w.base}/d/${w.space.slug}`);
            await listFrom(page, 'space-page');
            await context.clearCookies();
            await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${w.base}`, JSON.stringify(w.mine)]);
            await page.goto(`${w.base}/__page`);
            await listFrom(page.locator('#tdoc-feedback-root'), 'widget');
          } finally { await context.close(); w.server.close(); }
        });

        for (const surface of ['space page', 'widget']) {
          await t(`${tag}: ${surface}, the traced case: A replied here, B later elsewhere: A on top, and ⌘⇧Enter hands to A`, async () => {
            const w = await world();
            await w.env.META.put(`account-notify:${w.serena.account_id}`, JSON.stringify([raft('b', 'bee-agent', 'stan'), raft('a', 'ay-agent', 'stan')]));
            const meta = JSON.parse(await w.env.META.get(`meta:${w.space.slug}`));
            await w.env.META.put(`meta:${w.space.slug}`, JSON.stringify({ ...meta, notify_agents: [{ ...raft('a', 'ay-agent', 'stan'), last_touched: new Date(Date.now() - 60000).toISOString() }] }));
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            try {
              const page = await context.newPage();
              let root = page;
              if (surface === 'widget') {
                await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${w.base}`, JSON.stringify(w.space)]);
                await page.goto(`${w.base}/__page`);
                root = page.locator('#tdoc-feedback-root');
              } else {
                await context.addCookies([{ name: 'tdoc_sid', value: sid(w.serena.cookie), url: w.base }]);
                await page.goto(`${w.base}/d/${w.space.slug}`);
              }
              const card = root.locator(`[data-comment-id="${w.comment.id}"]`).first();
              await card.waitFor();
              await card.getByRole('button', { name: 'Reply' }).first().click();
              const box = root.locator('.tdoc-reply-form textarea').first();
              await box.waitFor();
              await box.fill('@');
              const menu = root.locator('.tdoc-mention-menu');
              await menu.waitFor();
              // The rows come in with the targets: wait for both, then read the order.
              await menu.locator('.tdoc-mention-agent', { hasText: 'bee-agent' }).first().waitFor();
              const names = await menu.locator('.tdoc-mention-agent .tdoc-mention-login').allInnerTexts();
              assert.ok(/ay-agent/.test(names[0]) && /bee-agent/.test(names[1]), `order: ${names}`);
              await shot(page, `${tag}-${surface.replace(' ', '-')}-traced-top-row`);
              await box.fill('please look');
              await box.press('Control+Shift+Enter');
              let sent = [];
              for (let i = 0; i < 100 && !sent.length; i++) {
                await page.waitForTimeout(100);
                sent = JSON.parse((await w.env.META.get(`handoffs:${w.space.slug}`)) || '[]');
              }
              assert.equal(sent.length, 1, 'nothing was handed over');
              assert.equal(sent[0].recipient.agent_sub, 'a', `went to ${sent[0].recipient.agent_sub}, not the row on top`);
            } finally { await context.close(); w.server.close(); }
          });
        }

        await t(`${tag}: widget for a third-party app's space offers no agents`, async () => {
          const w = await world();
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          try {
            const page = await context.newPage();
            await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${w.base}`, JSON.stringify(w.mineApp)]);
            const myAgentCalls = [];
            page.on('request', (r) => { if (/\/my-agent/.test(r.url())) myAgentCalls.push(r.url()); });
            await page.goto(`${w.base}/__page`);
            const root = page.locator('#tdoc-feedback-root');
            const card = root.locator('[data-comment-id]', { hasText: 'Why is the chart empty?' }).first();
            await card.waitFor();
            await card.getByRole('button', { name: 'Reply' }).first().click();
            const box = root.locator('.tdoc-reply-form textarea').first();
            await box.waitFor();
            await box.fill('@');
            await page.waitForTimeout(300);
            assert.equal(await root.locator('.tdoc-mention-agent').count(), 0, 'agents offered on a third-party space');
            assert.deepEqual(myAgentCalls, [], 'the widget asked for my-agent on a third-party space');
          } finally { await context.close(); w.server.close(); }
        });
      }
    } finally {
      await browser.close();
    }
  }

  async function expectAsk(w, slug) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const asks = await asksOf(w, slug);
      if (asks.length) {
        assert.equal(asks[0].recipient.agent_sub, 'j2');
        assert(asks[0].comment_id && asks[0].comment_id !== w.comment.id, 'asked about the new reply');
        return;
      }
      if (Date.now() > deadline) throw new Error('no ask recorded');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  console.log(failed ? `\nFAIL — ${failed} failed` : '\nPASS');
  process.exit(failed ? 1 : 0);
})();
