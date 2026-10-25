// The document page as Julie approved it (2026-10-24), in the real shell
// against the real worker, desktop and phone:
//   bar       logo · space / folder / title; Edited … · ✈ (owner / admin) ·
//             Share (quiet) · ⋯ · avatar only. No mode dropdown, no Resolved
//             switch, no space chip: the modes head ⋯, the filter (Open /
//             Resolved / All) heads the comments
//   composer  Comment + @agent. @agent puts the default agent in; its menu
//             is Mine / Team / tdoc AI (with "Connect my agent"). "Ask" or
//             "Ask + request change" -- the second only where that agent may
//             edit (authorship); "Only me" for Ask to one's own agent or
//             tdoc AI, never a team agent.
// Each case checks what reached the server: an edit handoff, or a question.
// Run with: node test/doc-bar-composer-ui.test.js

const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, issue } = require('./helpers/worker-harness');
const browserEdit = (env, slug, login) => {
  // A person's last edit in the browser (what the editor stamps), so the
  // team agent may write the doc: authorship is enforced at write time.
  const meta = JSON.parse(env.META.map.get(`meta:${slug}`));
  const last = meta.versions.reduce((a, b) => (Number(b.n) > Number(a.n) ? b : a));
  Object.assign(last, { source: 'browser', author: login });
  delete last.by;
  env.META.map.set(`meta:${slug}`, JSON.stringify(meta));
};
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium, devices } = requirePlaywrightOrSkip('doc-bar-composer-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const MODEL = 'https://model.invalid/v1';
const DOC = (t) => `<!doctype html><html><body><h1>${t}</h1><p>Billing ships first, on March 14, because invoices block two renewals. Search follows in April.</p><p>The mobile app waits for Q4.</p></body></html>`;

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
async function dragSelect(page, phrase) {
  const frameEl = await page.locator('iframe').first().elementHandle();
  const frame = await frameEl.contentFrame();
  const box = await frameEl.boundingBox();
  const r = await frame.evaluate((needle) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.nodeValue.indexOf(needle); if (i < 0) continue; const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + needle.length); const rects = range.getClientRects(); const a = rects[0]; const b = rects[rects.length - 1]; return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 }; }
  }, phrase);
  await page.mouse.move(box.x + r.x1, box.y + r.y1); await page.mouse.down();
  await page.mouse.move(box.x + r.x2, box.y + r.y2, { steps: 6 }); await page.mouse.up();
}

(async () => {
  console.log('Doc bar and composer (real shell)');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (!String(u).startsWith(MODEL)) return realFetch(input, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Billing goes first.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: MODEL });
  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  const reader = await issue(worker, env, 'reader');
  for (const who of [bob, reader]) await env.META.delete(`account-terminal:${who.account_id}`);
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const up = (token, slug, v, title) => api('/api/upload', { method: 'POST', token, body: { slug, version: v, html: DOC(title), meta: { title } } });
  await up(julie.token, 'launch-plan', 1, 'Launch plan');
  await api('/api/notify/local/register', { method: 'POST', token: julie.token, body: { device: 'juliesmac', clis: ['claude'] } });
  const team = (await api('/api/teams', { method: 'POST', cookie: julie.cookie, body: { name: 'Tdoc' } })).body.team;
  await api('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: team.invite_url.split('/').pop() } });
  await up(julie.token, 'team-plan', 1, 'Team plan');
  await up(julie.token, 'julies-draft', 1, "Julie's draft");
  await api('/api/team/move', { method: 'POST', cookie: julie.cookie, body: { slugs: ['team-plan', 'julies-draft'], team: team.id } });
  const added = (await api('/api/team/agents', { method: 'POST', cookie: julie.cookie, body: { id: team.id, name: 'tdoc-bot' } })).body;
  const agentToken = (await api('/api/team/agents/connect', { method: 'POST', body: { code: added.setup_code, device: 'team-box' } })).body.token;
  await api('/api/notify/local/register', { method: 'POST', token: agentToken, body: { device: 'team-box', clis: ['claude'] } });
  browserEdit(env, 'team-plan', 'julie');
  await up(agentToken, 'team-plan', 2, 'Team plan');
  // Two threads on launch-plan, one resolved, for the filter.
  const c1 = await api('/api/comments', { method: 'POST', cookie: reader.cookie, body: { slug: 'launch-plan', version: 1, text: 'Who owns billing?', anchor: { kind: 'text', text: 'Search follows in April' } } });
  const c2 = await api('/api/comments', { method: 'POST', cookie: reader.cookie, body: { slug: 'launch-plan', version: 1, text: 'Q4?', anchor: { kind: 'text', text: 'The mobile app waits' } } });
  await api('/api/comments', { method: 'PATCH', cookie: julie.cookie, body: { slug: 'launch-plan', version: 1, id: c2.body.id, resolved: true } });
  void c1;

  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  const open = async (who, slug, phone = false) => {
    const context = await browser.newContext(phone ? { ...devices['iPhone 13'], defaultBrowserType: undefined } : { viewport: { width: 1280, height: 800 } });
    if (who) await context.addCookies([{ name: 'tdoc_sid', value: who.cookie.split('=')[1], domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(`${base}/d/${slug}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    return { context, page };
  };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}` }); } };
  const mode = (pop) => pop.locator('.tdoc-ask-mode button').evaluateAll((els) => els.map((e) => `${e.textContent}${e.classList.contains('active') ? '*' : ''}${e.disabled ? '(off)' : ''}`).join('|'));
  const compose = async (page, text) => {
    await dragSelect(page, 'Billing ships first');
    const pop = page.locator('.tdoc-popup');
    await pop.waitFor();
    await pop.locator('textarea').fill(text);
    await pop.locator('.tdoc-composer-agent').click();
    const menu = page.locator('.ui-menu-popup');
    await menu.waitFor();
    const items = await menu.innerText();
    await page.keyboard.press('Escape');
    await pop.locator('.tdoc-ask-mode').waitFor();
    return { pop, items };
  };
  const comments = async (slug, v = 1) => { const r = await api(`/api/comments?slug=${slug}&version=${v}`, { cookie: julie.cookie }); return Array.isArray(r.body) ? r.body : r.body.comments; };
  const pending = async (device, token) => (await api(`/api/notify/local/pending?device=${device}`, { token })).body.pending;
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };

  try {
    await t('desktop bar: logo · My docs / title; Edited · ✈ · Share · ⋯ · avatar; modes in ⋯; the filter heads the comments', async () => {
      const { context, page } = await open(julie, 'launch-plan');
      await page.locator('.tdoc-crumb-space', { hasText: 'My docs' }).waitFor();
      if (await page.locator('.tdoc-mode-trigger, #tdoc-show-resolved, .tdoc-space-trigger, #tdoc-theme-btn, #tdoc-star-btn').count()) throw new Error('an old bar control is back');
      if (!/^Edited /.test((await page.locator('#tdoc-version-toggle').textContent()).trim())) throw new Error('no Edited …');
      await page.locator('#tdoc-send-agent-btn').waitFor();
      const share = page.locator('#tdoc-share-btn');
      if (await share.evaluate((el) => el.classList.contains('primary'))) throw new Error('Share is a filled primary button');
      if (await page.locator('.tdoc-account-trigger .name').isVisible()) throw new Error('the avatar shows a name');
      await page.locator('#tdoc-more-btn').click();
      await page.getByRole('menuitemradio', { name: /Comment/ }).waitFor();
      await page.getByRole('menuitemradio', { name: /Read/ }).click();
      await page.locator('#tdoc-more-btn').click();
      if (await page.getByRole('menuitemradio', { name: /Read/ }).getAttribute('aria-checked') !== 'true') throw new Error('mode did not change from ⋯');
      await page.keyboard.press('Escape');
      const filter = page.locator('.tdoc-comment-filter');
      await filter.waitFor();
      await filter.getByRole('radio', { name: /Resolved/ }).click();
      await page.waitForFunction(() => document.querySelectorAll('.tdoc-pin').length === 1);
      await filter.getByRole('radio', { name: /All/ }).click();
      await page.locator('.tdoc-crumb-space').click();
      await page.locator('.ui-menu-popup .tdoc-space-item-name', { hasText: 'Tdoc' }).waitFor();
      await shot(page, 'doc-bar-desktop.png');
      await context.close();
    });

    await t('phone bar: title; ✈ · Share icon · ⋯; the account is in ⋯; the filter heads the drawer', async () => {
      const { context, page } = await open(julie, 'launch-plan', true);
      await page.locator('#tdoc-send-agent-btn').waitFor();
      if (!(await page.locator('#tdoc-share-btn').isVisible())) throw new Error('no Share on a phone');
      if (await page.locator('.tdoc-crumb').first().isVisible()) throw new Error('crumbs crowd the phone bar');
      if (await page.locator('.tdoc-account-trigger').isVisible()) throw new Error('avatar in the phone bar');
      await page.locator('#tdoc-more-btn').click();
      await page.getByRole('menuitem', { name: /My account/ }).waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.tdoc-fab').click();
      await page.locator('#tdoc-comment-layer .tdoc-comment-filter').waitFor();
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      if (layout.scrollWidth > layout.width + 1) throw new Error(JSON.stringify(layout));
      await context.close();
    });

    await t('owner on own doc: @agent puts in their agent; Ask + request change hands the comment to it to edit', async () => {
      const { context, page } = await open(julie, 'launch-plan');
      const { pop, items } = await compose(page, 'Tighten this line');
      if (!/Mine/.test(items) || !/Connect my agent/.test(items)) throw new Error(`menu: ${items}`);
      if (await mode(pop) !== 'Ask|Ask + request change*') throw new Error(`mode: ${await mode(pop)}`);
      if (await pop.locator('.tdoc-only-me').count()) throw new Error('Only me beside an edit');
      await pop.getByRole('button', { name: 'Comment', exact: true }).click();
      let queued = [];
      for (let i = 0; i < 40 && !queued.length; i++) { queued = (await pending('juliesmac', julie.token)).filter((h) => h.kind !== 'ask'); if (!queued.length) await page.waitForTimeout(250); }
      if (queued.length !== 1) throw new Error(`not handed to edit: ${JSON.stringify(queued)}`);
      await context.close();
    });

    await t('member on a doc the team agent wrote: Team first, both modes; Ask has no Only me and asks the team agent', async () => {
      const { context, page } = await open(bob, 'team-plan');
      const { pop, items } = await compose(page, 'Why billing first?');
      if (!/Team/.test(items) || !/tdoc-bot/.test(items)) throw new Error(`menu: ${items}`);
      if (await mode(pop) !== 'Ask|Ask + request change*') throw new Error(`mode: ${await mode(pop)}`);
      await shot(page, 'composer-team-edit.png');
      await pop.locator('.tdoc-ask-mode button', { hasText: /^Ask$/ }).click();
      if (await pop.locator('.tdoc-only-me').count()) throw new Error('Only me for a team agent');
      await pop.getByRole('button', { name: 'Comment', exact: true }).click();
      let asks = [];
      for (let i = 0; i < 40 && !asks.length; i++) { asks = (await pending('team-box', agentToken)).filter((h) => h.kind === 'ask'); if (!asks.length) await page.waitForTimeout(250); }
      const posted = (await comments('team-plan', 2)).find((c) => c.text.startsWith('Why billing first?'));
      if (asks.length !== 1 || !posted || asks[0].comment_id !== posted.id) throw new Error(JSON.stringify({ asks, posted: posted && posted.id }));
      if ((await pending('team-box', agentToken)).some((h) => h.kind !== 'ask')) throw new Error('an edit handoff reached the team agent');
      await context.close();
    });

    await t("member on a doc Julie's agent wrote: Ask only (Ask + request change disabled, with why)", async () => {
      const { context, page } = await open(bob, 'julies-draft');
      const { pop } = await compose(page, 'Can we move billing?');
      if (await mode(pop) !== 'Ask*|Ask + request change(off)') throw new Error(`mode: ${await mode(pop)}`);
      const why = await pop.locator('.tdoc-ask-mode button[disabled]').getAttribute('title');
      if (!/can’t edit/.test(why || '')) throw new Error(`no reason: ${why}`);
      await shot(page, 'composer-ask-only-locked.png');
      await context.close();
    });

    await t('reader with no agent: tdoc AI with Connect my agent; Ask only; Only me on', async () => {
      const { context, page } = await open(reader, 'launch-plan');
      const { pop, items } = await compose(page, 'Why billing first?');
      if (!/tdoc AI/.test(items) || !/Connect my agent/.test(items)) throw new Error(`menu: ${items}`);
      if (await mode(pop) !== 'Ask*|Ask + request change(off)') throw new Error(`mode: ${await mode(pop)}`);
      if (await pop.locator('.tdoc-only-me [role=checkbox]').getAttribute('aria-checked') !== 'true') throw new Error('Only me is not on for tdoc AI');
      await context.close();
    });
  } finally {
    await browser.close();
    server.close();
    globalThis.fetch = realFetch;
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
