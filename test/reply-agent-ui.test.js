// The @agent in a thread's reply box is the new-comment composer's
// (Julie, 2026-10-24), in the real shell against the real worker:
//   - @agent puts the default agent in as a pill at the caret, no menu; the
//     pill's dropdown (Mine / Team / tdoc AI, Connect my agent) swaps it;
//     typing @ makes the same pill; Backspace takes the whole pill away.
//   - no mode control: an agent that may edit (authorship) gets the thread
//     to answer or change; elsewhere it answers only, under the reply, with
//     one quiet "Answers only" line.
//   - Only me for one's own agent or tdoc AI: the answer shows in the reply
//     box; Make public posts it.
// Cases: author on own doc; member on a team-agent doc; member on a doc
// someone else's agent wrote. TDOC_UI_SHOTS=<dir> saves 1440-wide shots.
// Run with: node test/reply-agent-ui.test.js

const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, issue } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium, devices } = requirePlaywrightOrSkip('reply-agent-ui.test.js');
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
  console.log('Reply box @agent (real shell)');
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
  await up(agentToken, 'team-plan', 2, 'Team plan');
  // Two threads on launch-plan, one resolved, for the filter.
  const c1 = await api('/api/comments', { method: 'POST', cookie: reader.cookie, body: { slug: 'launch-plan', version: 1, text: 'Who owns billing?', anchor: { kind: 'text', text: 'Search follows in April' } } });
  const c2 = await api('/api/comments', { method: 'POST', cookie: reader.cookie, body: { slug: 'launch-plan', version: 1, text: 'Q4?', anchor: { kind: 'text', text: 'The mobile app waits' } } });
  void c2;
  // Thread roots to reply to on the team docs.
  const t1 = await api('/api/comments', { method: 'POST', cookie: julie.cookie, body: { slug: 'team-plan', version: 2, text: 'Is March 14 firm?', anchor: { kind: 'text', text: 'Search follows in April' } } });
  const t2 = await api('/api/comments', { method: 'POST', cookie: julie.cookie, body: { slug: 'julies-draft', version: 1, text: 'Is March 14 firm?', anchor: { kind: 'text', text: 'Search follows in April' } } });


  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  const open = async (who, slug) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (who) await context.addCookies([{ name: 'tdoc_sid', value: who.cookie.split('=')[1], domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(`${base}/d/${slug}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    return { context, page };
  };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}` }); } };
  const comments = async (slug, v = 1) => { const r = await api(`/api/comments?slug=${slug}&version=${v}`, { cookie: julie.cookie }); return Array.isArray(r.body) ? r.body : r.body.comments; };
  const pending = async (device, token) => (await api(`/api/notify/local/pending?device=${device}`, { token })).body.pending;
  const until = async (page, fn) => { let v; for (let i = 0; i < 40; i++) { v = await fn(); if (v) return v; await page.waitForTimeout(250); } return v; };
  // The thread's reply box, open.
  const replyBox = async (page, rootId) => {
    await page.locator(`.tdoc-pin[data-id="${rootId}"]`).first().click({ force: true });
    const card = page.locator(`.tdoc-margin-comment.active[data-comment-id="${rootId}"]`);
    await card.waitFor();
    await card.locator('.tdoc-reply-toggle').first().click();
    const form = card.locator(`.tdoc-reply-form.open[data-parent-id="${rootId}"]`);
    await form.waitFor();
    return { card, form };
  };
  const menuItems = async (page, scope) => {
    await scope.locator('.tdoc-agent-pill').click();
    const menu = page.locator('.ui-menu-popup');
    await menu.waitFor();
    return { menu, items: await menu.innerText() };
  };
  const noMode = async (scope) => { if (await scope.locator('.tdoc-ask-mode').count()) throw new Error('a mode control is back'); };
  const answersOnly = (scope) => scope.locator('.tdoc-ask-only-label').count();
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };

  try {
    await t('reply, author on own doc: @agent puts their agent in as a pill (no menu), Only me offered; Reply hands the thread to it', async () => {
      const { context, page } = await open(julie, 'launch-plan');
      const { form } = await replyBox(page, c1.body.id);
      if (await form.locator('.tdoc-ask-row, .tdoc-agent-pill').count()) throw new Error('agent options before any agent is named');
      await form.locator('textarea').fill('Can you tighten this?');
      await form.locator('.tdoc-reply-agent').click();
      await form.locator('.tdoc-agent-pill').waitFor();
      if (await page.locator('.ui-menu-popup').count()) throw new Error('@agent opened a menu');
      await noMode(form);
      if (await answersOnly(form)) throw new Error('"Answers only" for the owner\'s own agent');
      if (await form.locator('.tdoc-only-me [role=checkbox]').getAttribute('aria-checked') !== 'false') throw new Error('Only me missing or on for own agent');
      await shot(page, 'reply-owner-own-doc.png');
      const { items } = await menuItems(page, form);
      if (!/Mine/.test(items) || !/Connect my agent/.test(items)) throw new Error(`menu: ${items}`);
      await shot(page, 'reply-pill-menu-owner.png');
      await page.keyboard.press('Escape');
      await form.getByRole('button', { name: 'Reply', exact: true }).click();
      const queued = await until(page, async () => (await pending('juliesmac', julie.token)).filter((h) => h.kind !== 'ask').length);
      if (queued !== 1) throw new Error(`not handed to edit: ${queued}`);
      await context.close();
    });

    await t('reply, member on a team-agent doc: the team agent pill, no Only me, no "Answers only"; Reply hands the thread to it', async () => {
      const { context, page } = await open(bob, 'team-plan');
      const { form } = await replyBox(page, t1.body.id);
      await form.locator('textarea').fill('Add last week');
      await form.locator('.tdoc-reply-agent').click();
      await form.locator('.tdoc-agent-pill').waitFor();
      await noMode(form);
      if (await answersOnly(form)) throw new Error('"Answers only" for the team agent on its own doc');
      if (await form.locator('.tdoc-only-me').count()) throw new Error('Only me for a team agent');
      const { items } = await menuItems(page, form);
      if (!/Team/.test(items) || !/tdoc-bot/.test(items)) throw new Error(`menu: ${items}`);
      await page.keyboard.press('Escape');
      await shot(page, 'reply-member-team-agent-doc.png');
      await form.getByRole('button', { name: 'Reply', exact: true }).click();
      const queued = await until(page, async () => (await pending('team-box', agentToken)).filter((h) => h.kind !== 'ask').length);
      if (queued !== 1) throw new Error(`not handed to the team agent: ${queued}`);
      await context.close();
    });

    await t("reply, member on a doc Julie's agent wrote: Answers only (no control); Reply asks the team agent, answer under the reply", async () => {
      const { context, page } = await open(bob, 'julies-draft');
      const { form } = await replyBox(page, t2.body.id);
      await form.locator('textarea').fill('Why not April?');
      await form.locator('.tdoc-reply-agent').click();
      await form.locator('.tdoc-agent-pill').waitFor();
      await noMode(form);
      if (!(await answersOnly(form))) throw new Error('no "Answers only"');
      await shot(page, 'reply-member-ask-only-doc.png');
      await form.getByRole('button', { name: 'Reply', exact: true }).click();
      const asks = await until(page, async () => { const a = (await pending('team-box', agentToken)).filter((h) => h.kind === 'ask'); return a.length ? a : null; });
      const root = (await comments('julies-draft')).find((c) => c.id === t2.body.id);
      const reply = (root.replies || []).find((r) => r.text.startsWith('Why not April?'));
      if (!asks || asks.length !== 1 || !reply || asks[0].comment_id !== reply.id) throw new Error(JSON.stringify({ asks, reply: reply && reply.id }));
      if ((await pending('team-box', agentToken)).filter((h) => h.kind !== 'ask').length !== 1) throw new Error('an edit handoff reached the team agent from an ask-only doc');
      await context.close();
    });

    await t('reply: the pill dropdown swaps the agent; typed @ makes the same pill; Backspace takes the whole pill and its options away', async () => {
      const { context, page } = await open(bob, 'julies-draft');
      const { form } = await replyBox(page, t2.body.id);
      const box = form.locator('textarea');
      await box.fill('');
      await box.type('Quick one ');
      await box.type('@');
      await page.locator('.tdoc-mention-menu .tdoc-mention-agent').first().waitFor();
      await page.keyboard.press('Enter');
      await form.locator('.tdoc-agent-pill').waitFor();
      if (!(await answersOnly(form))) throw new Error('typed @: no options');
      await shot(page, 'reply-typed-at-pill.png');
      const { menu } = await menuItems(page, form);
      await shot(page, 'reply-pill-menu.png');
      await menu.locator('.tdoc-agent-menu-item', { hasText: 'tdoc AI' }).click();
      const value = await box.inputValue();
      if (!value.includes('@⁠tdoc AI') || value.includes('tdoc-bot')) throw new Error(`not swapped: ${value}`);
      await form.locator('.tdoc-only-me').waitFor();
      await shot(page, 'reply-pill-swapped-tdoc-ai.png');
      await box.focus();
      await page.keyboard.press('End');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');
      if (await form.locator('.tdoc-agent-pill, .tdoc-ask-row').count()) throw new Error(`pill survived Backspace: ${await box.inputValue()}`);
      if ((await box.inputValue()).trim() !== 'Quick one') throw new Error(`left: ${await box.inputValue()}`);
      await context.close();
    });

    await t('reply with tdoc AI, Only me: the answer shows in the reply box alone; Make public posts the question and its answer as replies', async () => {
      const { context, page } = await open(reader, 'launch-plan');
      const { card, form } = await replyBox(page, c1.body.id);
      await form.locator('textarea').fill('Why billing first?');
      await form.locator('.tdoc-reply-agent').click();
      await form.locator('.tdoc-agent-pill').waitFor();
      if (await form.locator('.tdoc-only-me [role=checkbox]').getAttribute('aria-checked') !== 'true') throw new Error('Only me is not on for tdoc AI');
      await form.getByRole('button', { name: 'Reply', exact: true }).click();
      const priv = card.locator('.tdoc-reply-form.tdoc-private-ask');
      await priv.getByText('Billing goes first.').waitFor({ timeout: 10000 });
      if (((await comments('launch-plan')).find((c) => c.id === c1.body.id).replies || []).some((r) => r.text.includes('Why billing first?'))) throw new Error('an Only me question was posted');
      await shot(page, 'reply-only-me-answer.png');
      await priv.getByRole('button', { name: 'Make public' }).click();
      const root = await until(page, async () => { const r = (await comments('launch-plan')).find((c) => c.id === c1.body.id); return (r.replies || []).some((x) => x.author?.name === 'tdoc AI') ? r : null; });
      if (!root) throw new Error('not made public');
      const q = root.replies.find((r) => r.text === 'Why billing first?');
      const a = root.replies.find((r) => r.author?.name === 'tdoc AI');
      if (!q || !a || a.parent_id !== q.id) throw new Error(JSON.stringify(root.replies));
      await context.close();
    });

    await t('new comment: @agent puts the pill at the caret; ⌘⇧Enter in a reply puts the default agent in and sends', async () => {
      const { context, page } = await open(bob, 'team-plan');
      await dragSelect(page, 'Billing ships first');
      const pop = page.locator('.tdoc-popup');
      await pop.waitFor();
      const box = pop.locator('textarea');
      await box.fill('Please  shorten');
      await box.evaluate((el) => { el.focus(); el.setSelectionRange(7, 7); });
      await pop.locator('.tdoc-composer-agent').click();
      await pop.locator('.tdoc-agent-pill').waitFor();
      const v = await box.inputValue();
      if (!/^Please @⁠tdoc-bot/.test(v) || !/shorten$/.test(v)) throw new Error(`not at the caret: ${JSON.stringify(v)}`);
      await noMode(pop);
      await shot(page, 'composer-pill-at-caret.png');
      await pop.locator('.x').click();
      const before = (await pending('team-box', agentToken)).filter((h) => h.kind !== 'ask').length;
      const { form } = await replyBox(page, t1.body.id);
      await form.locator('textarea').fill('One more');
      await form.locator('textarea').press('Meta+Shift+Enter');
      const root = await until(page, async () => { const r = (await comments('team-plan', 2)).find((c) => c.id === t1.body.id); return (r.replies || []).some((x) => x.text.startsWith('One more')) ? r : null; });
      const sent = root && root.replies.find((x) => x.text.startsWith('One more'));
      if (!sent || !sent.text.includes('@⁠tdoc-bot')) throw new Error(`default agent not put in: ${sent && sent.text}`);
      const after = await until(page, async () => { const n = (await pending('team-box', agentToken)).filter((h) => h.kind !== 'ask').length; return n > before ? n : null; });
      if (!after) throw new Error('⌘⇧Enter did not hand it to the agent');
      await context.close();
    });
    await t('typed @ and the pill dropdown list the same agents, Mine / Team / tdoc AI -- tdoc AI is not cut off for someone with agents of their own', async () => {
      const { context, page } = await open(julie, 'team-plan');
      const { form } = await replyBox(page, t1.body.id);
      const box = form.locator('textarea');
      await box.type('@');
      const list = page.locator('.tdoc-mention-menu');
      await list.locator('.tdoc-mention-agent').first().waitFor();
      const typed = await list.evaluate((menu) => [...menu.querySelectorAll('.tdoc-mention-group, .tdoc-mention-agent .tdoc-mention-login')].map((el) => (el.classList.contains('tdoc-mention-group') ? `# ${el.textContent}` : el.textContent.trim())));
      for (const want of ['# Team', '# tdoc AI']) if (!typed.includes(want)) throw new Error(`@ list without ${want}: ${JSON.stringify(typed)}`);
      if (!typed.some((x) => /tdoc-bot/.test(x)) || !typed.some((x) => /^tdoc AI/.test(x))) throw new Error(JSON.stringify(typed));
      await shot(page, 'reply-typed-at-list.png');
      await page.keyboard.press('Enter');
      const { menu, items } = await menuItems(page, form);
      const pillGroups = await menu.locator('.tdoc-agent-menu-group').allTextContents();
      const typedGroups = typed.filter((x) => x.startsWith('# ') && x !== '# People').map((x) => x.slice(2));
      if (JSON.stringify(pillGroups) !== JSON.stringify(typedGroups)) throw new Error(`pill ${JSON.stringify(pillGroups)} vs @ ${JSON.stringify(typedGroups)}`);
      if (!/tdoc AI/.test(items) || !/tdoc-bot/.test(items)) throw new Error(`menu: ${items}`);
      await page.keyboard.press('Escape');
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
