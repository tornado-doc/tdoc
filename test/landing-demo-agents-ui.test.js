// The homepage demo (the landing doc, config.demoComments) runs the real
// comment experience against a simulated agent (shell/src/document/
// demo-agent.js), signed out, and writes nothing anywhere:
//   - the composer's @agent puts "Claude (demo)" in as the agent pill, and
//     the @ list offers Claude (demo) and tdoc AI;
//   - posting a comment that names it runs the real handoff status line:
//     Delivered to Claude (demo) → Claude (demo) is on it → its reply;
//   - Ask AI (the bar on desktop, the drawer's Ask AI tab on a phone) gives
//     the demo answer, and its Send to agent hands a ready comment to Claude
//     (demo), which replies;
//   - no request reaches /api/comments, /api/notify or /api/docs/*, and
//     nothing but GETs reaches /api at all.
// Desktop 1280 and phone 390. Screenshots: TDOC_UI_SHOTS (default
// /tmp/landing-demo).
// Run with: node test/landing-demo-agents-ui.test.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium, devices } = requirePlaywrightOrSkip('landing-demo-agents-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '/tmp/landing-demo';
const TOKEN = 'landing-upload-token';
const SLUG = 'tornado-doc';
const root = path.join(__dirname, '..');

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

// The rectangle of a phrase in the doc frame, in page coordinates.
async function phraseBox(page, phrase) {
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
      range.startContainer.parentElement.scrollIntoView({ block: 'center' });
      const rects = range.getClientRects();
      const a = rects[0]; const b = rects[rects.length - 1];
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
    }
    return null;
  }, phrase);
  if (!r) throw new Error(`phrase not in the landing doc: ${phrase}`);
  return { frame, x1: box.x + r.x1, y1: box.y + r.y1, x2: box.x + r.x2, y2: box.y + r.y2 };
}

async function dragSelect(page, phrase) {
  const r = await phraseBox(page, phrase);
  await page.mouse.move(r.x1, r.y1);
  await page.mouse.down();
  await page.mouse.move(r.x2, r.y2, { steps: 6 });
  await page.mouse.up();
  await page.locator('.tdoc-popup textarea').waitFor();
}

// A phone selects by long-press; the probe reports it on touchend.
async function touchSelect(page, phrase) {
  const { frame } = await phraseBox(page, phrase);
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
  console.log('homepage demo: real @agent, handoff line and Ask AI, simulated');
  const realFetch = globalThis.fetch;
  // The landing shell asks GitHub for a star count; keep the suite offline.
  globalThis.fetch = async (input, init) => {
    const u = String(typeof input === 'string' ? input : input.url);
    if (u.startsWith('https://api.github.com/')) return new Response('{}', { status: 404 });
    return realFetch(input, init);
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_UPLOAD_TOKEN: TOKEN, ASK_API_KEY: 'k', ASK_API_BASE: 'https://model.invalid/v1' });
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'landing', SLUG, 'meta.json'), 'utf8'));
  const latest = meta.versions[meta.versions.length - 1].n;
  const html = fs.readFileSync(path.join(root, 'landing', SLUG, `v${latest}`, 'index.html'), 'utf8');
  const up = await worker.fetch(new Request('https://tdoc.dev/api/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, version: 1, html, meta: {
      slug: SLUG, title: meta.title, created: meta.created,
      versions: [{ n: 1, created: meta.created }],
      access: { visibility: 'public', history_visibility: 'owner', commenting: 'signed_in', allowed_users: [] },
    } }),
  }), env, {});
  if (up.status !== 200) throw new Error(`landing upload: ${up.status} ${await up.text()}`);

  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); } };

  const open = async (name, opts) => {
    const context = await browser.newContext(opts);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const requests = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/')) requests.push({ method: r.method(), path: u.pathname });
    });
    await page.goto(`${base}/`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    const config = await page.evaluate(() => window.__TDOC_SHELL__ || {});
    if (!config.demoComments || !config.isLanding || config.identity) throw new Error(`${name}: not the signed-out demo landing`);
    const shot = (file) => page.screenshot({ path: path.join(SHOTS, file) });
    // Nothing the demo does may write, or read comments / agents.
    const noWrites = () => {
      const bad = requests.filter((r) => /^\/api\/(comments|notify|docs\/)/.test(r.path) || !['GET', 'HEAD'].includes(r.method));
      if (bad.length) throw new Error(`${name}: the demo reached the server: ${JSON.stringify(bad)}`);
      if (errors.length) throw new Error(`${name}: page errors: ${errors.join(' | ')}`);
    };
    return { context, page, shot, noWrites, requests };
  };

  // The handoff line, as the card shows it, through its three states.
  const handoffRuns = async (page, scope) => {
    const chip = scope.locator('.tdoc-handoff-chip').first();
    await chip.waitFor({ timeout: 5000 });
    const states = [];
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = await chip.getAttribute('data-handoff-state').catch(() => null);
      const title = await chip.getAttribute('title').catch(() => '');
      if (state && states[states.length - 1]?.state !== state) states.push({ state, title });
      if (state === 'answered') break;
      await page.waitForTimeout(100);
    }
    const seq = states.map((s) => s.state).join(' → ');
    const waiting = states.find((s) => s.state === 'waiting');
    const received = states.find((s) => s.state === 'received');
    if (!waiting || !/^Delivered to Claude \(demo\)/.test(waiting.title)) throw new Error(`no "Delivered to Claude (demo)": ${JSON.stringify(states)}`);
    if (!received || !/^Claude \(demo\) is on it/.test(received.title)) throw new Error(`no "Claude (demo) is on it": ${JSON.stringify(states)}`);
    if (states[states.length - 1].state !== 'answered') throw new Error(`no reply: ${seq}`);
    // The reply is under the thread's "1 reply", as any agent reply is.
    await scope.locator('.tdoc-replies-toggle').first().click();
    await scope.getByText(/^Demo reply:/).first().waitFor({ timeout: 5000 });
    return seq;
  };

  try {
    await t('desktop 1280: @agent → Claude (demo) pill; the comment runs the real handoff line to a reply', async () => {
      const { context, page, shot, noWrites } = await open('desktop', { viewport: { width: 1280, height: 800 } });
      await dragSelect(page, 'Humans and agents collaborate');
      const pop = page.locator('.tdoc-popup');
      const labels = (await pop.locator('.tdoc-composer-foot-actions button').allTextContents()).map((x) => x.trim());
      if (labels.join('|') !== '@agent|Comment') throw new Error(`composer buttons: ${labels.join('|')}`);
      // Typing @ lists the demo agents above people.
      await pop.locator('textarea').pressSequentially('Make the headline shorter @');
      const rows = (await page.locator('.tdoc-mention-option').allTextContents()).map((x) => x.trim());
      if (!/^Claude \(demo\)/.test(rows[0] || '') || !rows.some((r) => /^tdoc AI/.test(r))) throw new Error(`@ list: ${JSON.stringify(rows)}`);
      await page.keyboard.press('Backspace');
      // The @agent button: the default agent's pill.
      await pop.getByRole('button', { name: '@agent' }).click();
      const pill = pop.locator('.tdoc-agent-pill, .tdoc-mention-agent-pill, [data-agent-pill]').first();
      if (!(await pop.textContent()).includes('Claude (demo)')) throw new Error('no Claude (demo) pill in the composer');
      await shot('desktop-composer-agent.png');
      if (await pill.count()) await pill.waitFor();
      await pop.getByRole('button', { name: 'Comment', exact: true }).click();
      const card = page.locator('[data-comment-id]').filter({ hasText: 'Make the headline shorter' }).first();
      await card.waitFor({ timeout: 5000 });
      await page.waitForTimeout(300);
      await shot('desktop-handoff-delivered.png');
      await handoffRuns(page, card);
      await shot('desktop-handoff-replied.png');
      noWrites();
      await context.close();
    });

    await t('desktop 1280: Ask AI gives the demo answer; Send to agent hands a ready comment to Claude (demo)', async () => {
      const { context, page, shot, noWrites } = await open('desktop', { viewport: { width: 1280, height: 800 } });
      // A plain comment: ready to send.
      await dragSelect(page, 'An AI that runs on your computer');
      const pop = page.locator('.tdoc-popup');
      await pop.locator('textarea').fill('Say what an agent is in fewer words');
      await pop.getByRole('button', { name: 'Comment', exact: true }).click();
      await pop.waitFor({ state: 'detached' });
      await page.locator('#tdoc-send-agent-btn').click();
      const panel = page.locator('.tdoc-ask-panel');
      await panel.waitFor();
      await panel.locator('textarea').fill('What does tdoc do?');
      await page.keyboard.press('Enter');
      await panel.locator('.tdoc-ask-answer').getByText(/^Demo answer:/).waitFor({ timeout: 5000 });
      await shot('desktop-ask-answer.png');
      // Send to agent (main) / Edit (#879): the ready comment, to Claude (demo).
      const switchTo = panel.getByRole('radio', { name: 'Send to agent' });
      if (await switchTo.count()) await switchTo.click();
      else {
        await panel.getByRole('button', { name: /^Mode:/ }).click();
        await page.getByRole('menuitem', { name: /^Edit/ }).click();
      }
      if (!(await panel.textContent()).includes('Claude (demo)')) throw new Error('Send to agent does not name Claude (demo)');
      await shot('desktop-ask-send.png');
      await panel.getByRole('button', { name: /^Send/ }).click();
      await panel.getByText(/Sent .*Claude \(demo\)/).waitFor({ timeout: 5000 });
      await shot('desktop-ask-sent.png');
      // Agent activity lists it; its reply arrives (the line's steps are
      // the first test's).
      await page.keyboard.press('Escape');
      await page.locator('[data-comment-id] .tdoc-handoff-chip, .tdoc-pin').first().waitFor();
      await page.locator('#tdoc-send-agent-btn').click();
      await panel.getByRole('button', { name: /Agent activity/ }).click();
      await panel.getByText(/Say what an agent is/).first().waitFor({ timeout: 5000 });
      await panel.getByText(/Say what an agent is/).first().click();
      const card = page.locator('[data-comment-id]').filter({ hasText: 'Say what an agent is' }).first();
      await card.locator('.tdoc-handoff-chip[data-handoff-state="answered"]').waitFor({ timeout: 8000 });
      await card.locator('.tdoc-replies-toggle').click();
      await card.getByText(/^Demo reply:/).waitFor();
      await shot('desktop-send-replied.png');
      noWrites();
      await context.close();
    });

    await t('phone 390: the same @agent and handoff, and the drawer\'s Ask AI tab gives the demo answer', async () => {
      const PHONE = { ...devices['iPhone 13'], defaultBrowserType: undefined, viewport: { width: 390, height: 844 } };
      const { context, page, shot, noWrites } = await open('phone', PHONE);
      await touchSelect(page, 'Humans and agents collaborate');
      const pop = page.locator('.tdoc-popup');
      await pop.locator('textarea').fill('Shorter headline please ');
      await pop.getByRole('button', { name: '@agent' }).click();
      if (!(await pop.textContent()).includes('Claude (demo)')) throw new Error('no Claude (demo) pill in the phone composer');
      const box = await pop.boundingBox();
      if (box.x < 0 || box.x + box.width > 390) throw new Error(`composer off screen: ${JSON.stringify(box)}`);
      await shot('phone-composer-agent.png');
      await pop.getByRole('button', { name: 'Comment', exact: true }).click();
      await pop.waitFor({ state: 'detached' });
      await page.locator('.tdoc-fab').click();
      const card = page.locator('#tdoc-comment-layer [data-comment-id]').filter({ hasText: 'Shorter headline please' }).first();
      await card.waitFor();
      await handoffRuns(page, card);
      await shot('phone-handoff-replied.png');
      // The drawer's Ask AI tab.
      await page.locator('.tdoc-drawer-tabs').getByText('Ask AI').click();
      const panel = page.locator('.tdoc-ask-panel');
      await panel.locator('textarea').fill('What does tdoc do?');
      await panel.locator('button[type=submit]').click();
      await panel.locator('.tdoc-ask-answer').getByText(/^Demo answer:/).waitFor({ timeout: 5000 });
      await shot('phone-ask-answer.png');
      noWrites();
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
