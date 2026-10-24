// Comment / Ask AI / Send to my agent, in the real shell against the real
// worker (in-process harness behind a local HTTP server, built runtime), at
// desktop and phone width, for each of the reader's three tiers:
//   none     the popover and the bar say "Connect my agent"; it goes to
//            /start with the question kept, the setup page leads back, and
//            the doc opens with the question ready for the new agent
//   online   "Send to my agent" sends the popover's question with its
//            passage to the reader's own daemon; the answer (posted on the
//            reader's own token) shows to them alone, and posts anchored
//   offline  "Copy for my agent" copies the line in one click
// plus Ask AI from the popover, anchored to the passage when posted.
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
}

(async () => {
  console.log('Comment / Ask AI / Send to my agent (real shell)');
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
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };
  const DESKTOP = { viewport: { width: 1280, height: 800 } };
  const PHONE = { ...devices['iPhone 13'], defaultBrowserType: undefined };

  try {
    await t('desktop, no agent: bar and popover read Comment / Ask AI / Connect my agent; Ask AI about the passage posts anchored', async () => {
      await setTier('none');
      const { context, page } = await open(reader, DESKTOP);
      await page.getByRole('button', { name: 'Connect my agent' }).waitFor();
      await dragSelect(page, 'Billing ships first');
      const pop = page.locator('.tdoc-popup');
      await pop.waitFor();
      const labels = await pop.locator('.tdoc-composer-foot-actions button').allTextContents();
      if (labels.join('|') !== 'Ask AI|Connect my agent|Comment') throw new Error(`popover: ${labels.join('|')}`);
      await shot(page, 'reader-none-popover.png');
      await pop.locator('textarea').fill('Why billing first?');
      await pop.getByRole('button', { name: 'Ask AI' }).click();
      const dialog = page.getByRole('dialog', { name: 'Ask this doc' });
      await dialog.locator('.tdoc-ask-answer-text').waitFor({ timeout: 10000 });
      await dialog.getByRole('button', { name: 'Post as comment' }).click();
      await dialog.getByRole('button', { name: 'Posted as comment' }).waitFor();
      const posted = (await comments()).find((c) => /^Q: Why billing first\?/.test(c.text));
      if (!posted || posted.anchor?.text !== 'Billing ships first') throw new Error(`not anchored: ${JSON.stringify(posted && posted.anchor)}`);
      await context.close();
    });

    await t('desktop, no agent: Connect my agent keeps the question through /start and setup, then hands it to the new agent', async () => {
      await setTier('none');
      const { context, page } = await open(reader, DESKTOP);
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      await dragSelect(page, 'The mobile app waits for Q4');
      await page.locator('.tdoc-popup textarea').fill('Why does mobile wait?');
      await page.locator('.tdoc-popup').getByRole('button', { name: 'Connect my agent' }).click();
      await page.waitForURL((u) => u.pathname === '/start' && u.searchParams.get('return') === `/d/${SLUG}`);
      // The agent is connected (paired, helper not running yet).
      await setTier('offline');
      await page.goto(`${base}/setup`);
      await page.getByRole('button', { name: 'Back to the doc' }).click();
      await page.waitForURL(`${base}/d/${SLUG}`);
      const dialog = page.getByRole('dialog', { name: 'Copy for my agent' });
      await dialog.waitFor({ timeout: 10000 });
      if (await dialog.getByRole('textbox').inputValue() !== 'Why does mobile wait?') throw new Error('question lost');
      await dialog.getByRole('button', { name: 'Copy for my agent' }).click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      if (copied !== `Read ${base}/d/${SLUG} and answer: Why does mobile wait?\n\nAbout this passage: "The mobile app waits for Q4"`) throw new Error(`copied: ${copied}`);
      // Handed over once: a reload does not ask again.
      await page.reload();
      await page.frameLocator('iframe').locator('h1').waitFor();
      await page.waitForTimeout(500);
      if (await page.getByRole('dialog').count()) throw new Error('the pending question came back');
      // Used up: the setup page no longer leads back to the doc.
      await page.goto(`${base}/setup`);
      await page.getByRole('button', { name: 'Next', exact: true }).waitFor({ timeout: 10000 });
      if (!await page.getByRole('button', { name: 'Next', exact: true }).isDisabled()) throw new Error('an offline historical pairing enabled Next');
      if (await page.getByRole('button', { name: 'Back to the doc' }).count()) throw new Error('setup still offers the way back');
      await context.close();
    });

    await t('desktop, no agent: Later on the setup page dismisses the waiting question', async () => {
      await setTier('none');
      const { context, page } = await open(reader, DESKTOP);
      await page.getByRole('button', { name: 'Connect my agent' }).click();
      await page.waitForURL((u) => u.pathname === '/start');
      await setTier('offline');
      await page.goto(`${base}/setup`);
      await page.getByRole('button', { name: 'Back to the doc' }).waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: 'Later', exact: true }).click();
      await page.waitForURL((u) => u.pathname !== '/setup');
      await page.goto(`${base}/setup`);
      await page.getByRole('button', { name: 'Next', exact: true }).waitFor({ timeout: 10000 });
      if (!await page.getByRole('button', { name: 'Next', exact: true }).isDisabled()) throw new Error('an offline historical pairing enabled Next');
      await context.close();
    });

    await t('desktop, agent online: Send to my agent → own daemon → private answer, posted anchored; nobody else sees it', async () => {
      await setTier('online');
      const { context, page } = await open(reader, DESKTOP);
      await page.getByRole('button', { name: 'Send to my agent' }).waitFor();
      await dragSelect(page, 'Search follows in April');
      await page.locator('.tdoc-popup textarea').fill('What blocks search?');
      await page.locator('.tdoc-popup').getByRole('button', { name: 'Send to my agent' }).click();
      const dialog = page.getByRole('dialog', { name: 'Send to my agent' });
      await dialog.getByText(/Sent to .* on readerbox · waiting for the answer/).waitFor({ timeout: 10000 });
      // The reader's own daemon picks it up and answers on the reader's token.
      const pending = (await api('/api/notify/local/pending?device=readerbox', { token: reader.token })).body.pending;
      if (pending.length !== 1 || pending[0].kind !== 'ask' || pending[0].selection !== 'Search follows in April') throw new Error(JSON.stringify(pending));
      const r = await api('/api/agent/ask-reply', { method: 'POST', token: reader.token, body: { slug: SLUG, ask_id: pending[0].ask_id, text: 'PRIVATE: the new index is still in beta.' } });
      if (r.status !== 200) throw new Error(`reply ${r.status}`);
      await dialog.getByText('PRIVATE: the new index is still in beta.').waitFor({ timeout: 12000 });
      await shot(page, 'reader-online-answer.png');
      if ((await comments()).some((c) => c.text.includes('PRIVATE'))) throw new Error('the answer is a comment before posting');
      const peer = await open(other, DESKTOP);
      await peer.page.waitForTimeout(800);
      if ((await peer.page.content()).includes('PRIVATE')) throw new Error('another reader sees it');
      await peer.context.close();
      await dialog.getByRole('button', { name: 'Post as comment' }).click();
      await dialog.getByRole('button', { name: 'Posted as comment' }).waitFor();
      const posted = (await comments()).find((c) => c.text.includes('PRIVATE'));
      if (!posted || posted.anchor?.text !== 'Search follows in April' || !/^Q: What blocks search\?\n\nAnswer from my agent \(/.test(posted.text)) throw new Error(JSON.stringify(posted));
      await context.close();
    });

    await t('phone, helper offline: ⋯ menu and the popover read Copy for my agent; one tap copies; the sheet fits', async () => {
      await setTier('offline');
      const { context, page } = await open(reader, PHONE);
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Copy for my agent' }).waitFor();
      await page.keyboard.press('Escape');
      await touchSelect(page, 'Billing ships first');
      const pop = page.locator('.tdoc-popup');
      await pop.waitFor();
      const labels = await pop.locator('.tdoc-composer-foot-actions button').allTextContents();
      if (labels.join('|') !== 'Ask AI|Copy for my agent|Comment') throw new Error(`popover: ${labels.join('|')}`);
      const popBox = await pop.boundingBox();
      if (popBox.x < 0 || popBox.x + popBox.width > 390) throw new Error(`popover off screen ${JSON.stringify(popBox)}`);
      await pop.locator('textarea').fill('Who owns billing?');
      await shot(page, 'reader-offline-phone-popover.png');
      await pop.getByRole('button', { name: 'Copy for my agent' }).click();
      const dialog = page.getByRole('dialog', { name: 'Copy for my agent' });
      await dialog.getByText('Copied. Paste it into your agent.').waitFor();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      if (!copied.endsWith('answer: Who owns billing?\n\nAbout this passage: "Billing ships first"')) throw new Error(copied);
      if (!(await dialog.getByRole('link', { name: /Turn on the background helper/ }).isVisible())) throw new Error('no helper link');
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      if (layout.scrollWidth > layout.width + 1) throw new Error(JSON.stringify(layout));
      await shot(page, 'reader-offline-phone-copied.png');
      await context.close();
    });

    await t('the owner keeps Send to agent / @agent and gets no reader entry', async () => {
      const { context, page } = await open(owner, DESKTOP);
      await page.locator('#tdoc-send-agent-btn').waitFor();
      if (await page.locator('#tdoc-my-agent-btn').count()) throw new Error('owner sees the reader entry');
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
