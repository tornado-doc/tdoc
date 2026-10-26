// Asking in a comment, in the real shell against the real worker
// (in-process harness behind a local HTTP server, built runtime), desktop and
// phone. The composer has one button, Comment; @ opens the list, whose first
// row is the default agent, and Enter picks it. "Ask only" (answer, never
// edit) is ticked and locked for an agent that may not edit this doc:
//   no agent     tdoc AI ("Cloud"). "Only me" starts on: nothing is
//                posted, the answer shows in the composer to its asker alone,
//                and Make public posts the question as their comment with the
//                kept answer as tdoc AI's reply. One muted quota line under
//                it, for the asker only.
//   agent online the reader's own agent ("Mine"); "Only me"
//                starts off: the comment posts and its answer, on the
//                reader's own token, is the reply everyone sees
//   phone        same composer, fits the screen; Only me off → in the thread
//   owner        keeps the paper plane; nothing else new in the bar
// Run with: node test/reader-agent-ask-ui.test.js

const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, issue } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium, devices } = requirePlaywrightOrSkip('reader-agent-ask-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const MODEL = 'https://model.invalid/v1';
const SLUG = 'launch-plan';
const DOC = '<!doctype html><html><body><h1>Launch plan</h1><p>Billing ships first, on March 14, because invoices block two renewals. Search follows in April.</p><p>The mobile app waits for Q4.</p></body></html>';

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) {
      res.setHeader('content-type', asset.type);
      return res.end(fs.readFileSync(asset.file));
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    await new Promise((resolve) => req.on('end', resolve));
    // The worker checks same-origin against its own host.
    const headers = { ...req.headers, host: 'tdoc.dev', ...(req.headers.origin ? { origin: 'https://tdoc.dev' } : {}) };
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let out = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) {
      out = Buffer.from(out.toString('utf8')
        .replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path)
        .replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    }
    response.headers.forEach((value, key) => {
      if (!['content-length', 'content-encoding', 'content-security-policy'].includes(key)) res.setHeader(key, value);
    });
    res.statusCode = response.status;
    res.end(out);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// A drag across a phrase inside the doc frame, with the real mouse.
async function dragSelect(page, phrase) {
  const frameEl = await page.locator('iframe').first().elementHandle();
  const frame = await frameEl.contentFrame();
  const box = await frameEl.boundingBox();
  const r = await frame.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.nodeValue.indexOf(needle);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i); range.setEnd(n, i + needle.length);
      const rects = range.getClientRects();
      const a = rects[0]; const b = rects[rects.length - 1];
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
    }
    return null;
  }, phrase);
  await page.mouse.move(box.x + r.x1, box.y + r.y1);
  await page.mouse.down();
  await page.mouse.move(box.x + r.x2, box.y + r.y2, { steps: 6 });
  await page.mouse.up();
  await page.locator('.tdoc-popup textarea').waitFor();
}

// A phone selects by long-press; the probe reports it on touchend.
async function touchSelect(page, phrase) {
  const frame = await (await page.locator('iframe').first().elementHandle()).contentFrame();
  await frame.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.nodeValue.indexOf(needle);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i); range.setEnd(n, i + needle.length);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      document.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
      return;
    }
  }, phrase);
  await page.locator('.tdoc-popup textarea').waitFor();
}

(async () => {
  console.log('Ask AI in a comment (real shell)');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (!String(u).startsWith(MODEL)) return realFetch(input, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Billing goes **first** because invoices block renewals.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: MODEL });
  const owner = await issue(worker, env, 'owner');
  const reader = await issue(worker, env, 'reader');
  const other = await issue(worker, env, 'other');
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, {
      method: o.method || 'GET',
      headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.body ? { 'Content-Type': 'application/json' } : {}) },
      body: o.body ? JSON.stringify(o.body) : undefined,
    }), env, {});
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  await api('/api/upload', { method: 'POST', token: owner.token, body: { slug: SLUG, version: 1, html: DOC } });
  const setTier = async (tier) => {
    for (const k of ['account-notify', 'local-agents-seen', 'account-terminal']) await env.META.delete(`${k}:${reader.account_id}`);
    if (tier === 'none') return;
    await env.META.put(`account-terminal:${reader.account_id}`, '1');
    await api('/api/notify/local/register', { method: 'POST', token: reader.token, body: { device: 'readerbox', clis: ['claude'] } });
    if (tier === 'offline') await env.META.put(`local-agents-seen:${reader.account_id}`, JSON.stringify({ readerbox: new Date(Date.now() - 3600e3).toISOString() }));
  };
  const comments = async () => {
    const r = await api(`/api/comments?slug=${SLUG}&version=1`);
    return Array.isArray(r.body) ? r.body : r.body.comments;
  };

  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  const open = async (who, opts) => {
    const context = await browser.newContext(opts);
    await context.addCookies([{ name: 'tdoc_sid', value: who.cookie.split('=')[1], domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(`${base}/d/${SLUG}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 10000 });
    return { context, page };
  };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}` }); } };
  const noBarAsk = async (page) => {
    for (const sel of ['#tdoc-ask-btn', '#tdoc-my-agent-btn', '.tdoc-ask-panel']) {
      if (await page.locator(sel).count()) throw new Error(`${sel} is back`);
    }
  };
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };
  const DESKTOP = { viewport: { width: 1280, height: 800 } };
  const PHONE = { ...devices['iPhone 13'], defaultBrowserType: undefined };

  // Typing @ by hand: the list's first row is the default; Enter picks it.
  const ask = async (page, text) => {
    const pop = page.locator('.tdoc-popup');
    await pop.locator('textarea').pressSequentially(`${text} @`);
    const first = page.locator('.tdoc-mention-option').first();
    await first.waitFor();
    const row = (await first.textContent()).trim();
    await page.keyboard.press('Enter');
    return { pop, row };
  };
  // No mode control (Julie, 2026-10-24): an agent that may only answer here
  // gets one quiet "Answers only" line.
  const answersOnly = async (pop) => {
    if (await pop.locator('.tdoc-ask-mode').count()) throw new Error('a mode control is back');
    if (!(await pop.locator('.tdoc-ask-only-label', { hasText: 'Answers only' }).count())) throw new Error('no "Answers only" note');
  };
  try {
    await t("desktop, no agent: @ → tdoc AI first; Only me on: a private answer, then Make public posts it to the thread; the quota line is the asker's alone", async () => {
      await setTier('none');
      const { context, page } = await open(reader, DESKTOP);
      await noBarAsk(page);
      await dragSelect(page, 'Billing ships first');
      const pop = page.locator('.tdoc-popup');
      await pop.waitFor();
      const labels = (await pop.locator('.tdoc-composer-foot-actions button').allTextContents()).map((x) => x.trim());
      if (labels.join('|') !== '@agent|Comment') throw new Error(`popover buttons: ${labels.join('|')}`);
      const { row } = await ask(page, 'Why billing first?');
      if (!/^tdoc AI/.test(row) || !/5 free/.test(row)) throw new Error(`first row: ${row}`);
      await answersOnly(pop);
      const onlyMe = pop.locator('.tdoc-only-me [role=checkbox]');
      if (await onlyMe.getAttribute('aria-checked') !== 'true') throw new Error('Only me is not on for tdoc AI');
      await shot(page, 'composer-only-me.png');
      await pop.getByRole('button', { name: 'Comment', exact: true }).click();
      const card = page.locator('.tdoc-private-ask');
      await card.getByText('invoices block renewals').waitFor({ timeout: 10000 });
      await card.getByText('Only you can see this').waitFor();
      if ((await comments()).some((c) => c.text.includes('Why billing first?'))) throw new Error('an Only me question was posted');
      await shot(page, 'composer-private-answer.png');
      await card.getByRole('button', { name: 'Make public' }).click();
      const open_ = page.locator('.tdoc-margin-comment.active');
      await open_.waitFor({ timeout: 10000 });
      let posted = null;
      for (let i = 0; i < 40 && !(posted && (posted.replies || []).length); i++) {
        posted = (await comments()).find((c) => c.text.startsWith('Why billing first?'));
        if (!(posted && (posted.replies || []).length)) await page.waitForTimeout(250);
      }
      if (!posted || posted.anchor?.text !== 'Billing ships first') throw new Error(`not anchored: ${JSON.stringify(posted && posted.anchor)}`);
      if (/@/.test(posted.text)) throw new Error(`the question kept its tag: ${posted.text}`);
      if (!(posted.replies || []).some((r) => r.author?.name === 'tdoc AI' && r.text.includes('invoices block renewals'))) throw new Error(`no tdoc AI reply: ${JSON.stringify(posted.replies)}`);
      const toggle = open_.locator('.tdoc-replies-toggle:not(.open)');
      if (await toggle.count()) await toggle.click();
      await open_.locator('.tdoc-ai-quota').getByText(/tdoc AI · 4 free left/).waitFor();
      await shot(page, 'thread-tdoc-ai-reply.png');
      const peer = await open(other, DESKTOP);
      await peer.page.locator('.tdoc-pin').first().click();
      await peer.page.locator('.tdoc-margin-comment.active .tdoc-replies-toggle').click();
      await peer.page.getByText('invoices block renewals').waitFor({ timeout: 10000 });
      if (await peer.page.locator('.tdoc-ai-quota').count()) throw new Error("another reader sees the asker's quota line");
      await peer.context.close();
      await context.close();
    });

    await t("desktop, agent online: @ → own agent first (Mine, answers only); Only me off: the daemon's answer is the reply everyone sees", async () => {
      await setTier('online');
      const { context, page } = await open(reader, DESKTOP);
      await noBarAsk(page);
      await dragSelect(page, 'Search follows in April');
      const { pop, row } = await ask(page, 'What blocks search?');
      if (!/Mine/.test(row)) throw new Error(`first row: ${row}`);
      await answersOnly(pop);
      if (await pop.locator('.tdoc-only-me [role=checkbox]').getAttribute('aria-checked') !== 'false') throw new Error('Only me is on for an agent');
      await shot(page, 'composer-own-agent.png');
      await pop.getByRole('button', { name: 'Comment', exact: true }).click();
      let pending = [];
      for (let i = 0; i < 40 && !pending.length; i++) {
        pending = (await api('/api/notify/local/pending?device=readerbox', { token: reader.token })).body.pending;
        if (!pending.length) await page.waitForTimeout(250);
      }
      const posted = (await comments()).find((c) => c.text.startsWith('What blocks search?'));
      if (!posted) throw new Error('comment not posted');
      if (pending.length !== 1 || pending[0].kind !== 'ask' || pending[0].comment_id !== posted.id) throw new Error(JSON.stringify(pending));
      const r = await api('/api/agent/ask-reply', { method: 'POST', token: reader.token, body: { slug: SLUG, ask_id: pending[0].ask_id, text: 'THREAD: the new index is still in beta.', agent_login: 'claude', agent_name: 'Claude' } });
      if (r.status !== 200 || !r.body.reply_id) throw new Error(`reply ${r.status} ${JSON.stringify(r.body)}`);
      await page.locator('.tdoc-margin-comment.active').getByText('THREAD: the new index is still in beta.').waitFor({ timeout: 15000 });
      await shot(page, 'thread-my-agent-reply.png');
      const reply = ((await comments()).find((c) => c.id === posted.id).replies || []).find((x) => x.id === r.body.reply_id);
      if (!reply || reply.author.owner?.key !== 'reader') throw new Error(JSON.stringify(reply));
      await context.close();
    });

    await t('top bar Ask AI asks my agent privately and shows its reply before I choose to post it', async () => {
      await setTier('online');
      const { context, page } = await open(reader, DESKTOP);
      await page.locator('#tdoc-send-agent-btn').click();
      const panel = page.getByRole('dialog', { name: 'Ask AI' });
      await panel.getByRole('button', { name: 'Who should answer?' }).click();
      await page.locator('.tdoc-agent-menu').getByRole('menuitem', { name: /Mine/ }).click();
      await panel.getByRole('textbox', { name: 'Ask about this document' }).fill('Can my agent check the Q4 plan?');
      await panel.getByRole('button', { name: 'Send question' }).click();
      let ask = null;
      for (let i = 0; i < 40 && !ask; i++) {
        const pending = (await api('/api/notify/local/pending?device=readerbox', { token: reader.token })).body.pending;
        ask = pending.find((item) => item.kind === 'ask' && item.question === 'Can my agent check the Q4 plan?');
        if (!ask) await page.waitForTimeout(250);
      }
      if (!ask || ask.comment_id) throw new Error(`private Ask AI request not queued: ${JSON.stringify(ask)}`);
      if ((await comments()).some((c) => c.text.includes('Can my agent check the Q4 plan?'))) throw new Error('private agent question was posted');
      const reply = await api('/api/agent/ask-reply', { method: 'POST', token: reader.token, body: {
        slug: SLUG, ask_id: ask.ask_id, text: 'The mobile app remains planned for Q4.', agent_login: 'claude', agent_name: 'Claude',
      } });
      if (reply.status !== 200) throw new Error(`agent reply ${reply.status}: ${JSON.stringify(reply.body)}`);
      await panel.getByText('The mobile app remains planned for Q4.').waitFor({ timeout: 15000 });
      if ((await comments()).some((c) => c.text.includes('Can my agent check the Q4 plan?'))) throw new Error('agent reply made the question public');
      await panel.getByRole('button', { name: 'Post as comment' }).click();
      await panel.getByText('Posted as a comment').waitFor();
      const posted = (await comments()).find((c) => c.text === 'Can my agent check the Q4 plan?');
      if (!posted || !(posted.replies || []).some((r) => r.text === 'The mobile app remains planned for Q4.')) {
        throw new Error(`agent answer not posted: ${JSON.stringify(posted)}`);
      }
      const documentSection = page.locator('.tdoc-document-comments');
      await documentSection.getByText('Can my agent check the Q4 plan?').waitFor();
      if (await page.locator(`.tdoc-pin[data-id="${posted.id}"]`).count()) {
        throw new Error('public Ask AI answer appeared as a margin pin instead of under the title');
      }
      await context.close();
    });

    await t('phone, helper offline: tdoc AI; Only me off posts the answer in the thread; the composer fits', async () => {
      await setTier('offline');
      const { context, page } = await open(reader, PHONE);
      await noBarAsk(page);
      await page.locator('#tdoc-more-btn').click();
      await page.locator('.ui-menu-popup').waitFor();
      for (const name of ['Ask AI', 'Copy for my agent', 'Send to my agent', 'Connect my agent']) {
        if (await page.getByRole('menuitem', { name }).count()) throw new Error(`⋯ still has ${name}`);
      }
      await page.keyboard.press('Escape');
      await page.locator('.ui-menu-popup').waitFor({ state: 'detached' });
      await touchSelect(page, 'The mobile app waits for Q4');
      const pop = page.locator('.tdoc-popup');
      await pop.waitFor();
      const { row } = await ask(page, 'Why Q4?');
      if (!/^tdoc AI/.test(row)) throw new Error(`first row: ${row}`);
      // The phone composer settles as the keyboard moves it: toggle from the
      // keyboard rather than wait for it to hold still.
      await pop.locator('.tdoc-only-me [role=checkbox]').focus();
      await page.keyboard.press('Space');
      if (await pop.locator('.tdoc-only-me [role=checkbox]').getAttribute('aria-checked') !== 'false') throw new Error('Only me did not turn off');
      const popBox = await pop.boundingBox();
      if (popBox.x < 0 || popBox.x + popBox.width > 390) throw new Error(`popover off screen ${JSON.stringify(popBox)}`);
      await shot(page, 'phone-composer.png');
      await pop.getByRole('button', { name: 'Comment', exact: true }).click();
      let answered = false;
      for (let i = 0; i < 40 && !answered; i++) {
        const posted = (await comments()).find((c) => c.text.startsWith('Why Q4?'));
        answered = Boolean(posted && (posted.replies || []).some((r) => r.author?.name === 'tdoc AI'));
        if (!answered) await page.waitForTimeout(250);
      }
      if (!answered) throw new Error('tdoc AI did not answer in the thread');
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      if (layout.scrollWidth > layout.width + 1) throw new Error(JSON.stringify(layout));
      await context.close();
    });

    await t('without a connected agent the comment @agent button opens the connection guide', async () => {
      const { context, page } = await open(owner, DESKTOP);
      await page.locator('#tdoc-send-agent-btn').waitFor();
      await noBarAsk(page);
      await dragSelect(page, 'Billing ships first');
      const pop = page.locator('.tdoc-popup');
      await pop.waitFor();
      const labels = (await pop.locator('.tdoc-composer-foot-actions button').allTextContents()).map((x) => x.trim());
      if (labels.join('|') !== '@agent|Comment') throw new Error(`owner popover buttons: ${labels.join('|')}`);
      await pop.locator('textarea').fill('Tighten this');
      await pop.locator('.tdoc-composer-agent').click();
      await pop.getByText('No agent is connected yet.').waitFor();
      if (await pop.locator('.tdoc-agent-pill').count()) throw new Error('an unrelated agent was preselected');
      if (await pop.getByRole('link', { name: 'Set up an agent' }).count() !== 1) throw new Error('missing setup action');
      if (await pop.getByText('Or paste this into your agent').count() !== 1) throw new Error('missing existing connection prompt');
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
