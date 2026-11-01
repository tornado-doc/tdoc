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
//   - the scripted Edit (flag demoEditRewrite, demo-agent.js DEMO_REWRITES):
//     Edit opens with a fixed request (read-only: the visitor can't change
//     it); Send hands it to Claude (demo), the paragraph is rewritten in the
//     doc (struck, typed, then marked as an insertion), the reply arrives in
//     Agent activity, and Ask AI shows "Create a free doc" (to /start) and
//     Undo, which puts Edit back as it was; on a phone (Chromium and WebKit,
//     430 and 390) the drawer gives way to a slim "Editing…" bar that
//     becomes the call to action, and the paragraph stays fully above it;
//     reduced motion swaps the text at once; flag off, Edit opens empty;
//   - no request reaches /api/comments, /api/notify or /api/docs/*, and
//     nothing but GETs reaches /api at all.
// Desktop 1280/1440 and phone 390/430. Screenshots: TDOC_UI_SHOTS (default
// /tmp/landing-demo).
// Run with: node test/landing-demo-agents-ui.test.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium, webkit, devices } = requirePlaywrightOrSkip('landing-demo-agents-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '/tmp/landing-demo';
const TOKEN = 'landing-upload-token';
const SLUG = 'tornado-doc';
const root = path.join(__dirname, '..');
const { DEMO_REWRITES } = loadDemoRewrites();

// demo-agent.js is an ES module; read its script without a bundler.
function loadDemoRewrites() {
  const src = fs.readFileSync(path.join(root, 'shell/src/document/demo-agent.js'), 'utf8')
    .replace(/^import .*$/m, 'const TDOC_AI = {};')
    .replace(/^export /gm, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { DEMO_REWRITES };`)();
}

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
  let webkitBrowser = null;
  const browsers = { chromium: () => browser, webkit: async () => (webkitBrowser ||= await webkit.launch({ headless: true })) };
  fs.mkdirSync(SHOTS, { recursive: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); } };

  const open = async (name, opts, flags = null, engine = 'chromium') => {
    const context = await (await browsers[engine]()).newContext(opts);
    if (flags) await context.addInitScript((pinned) => { window.__TDOC_FLAGS__ = pinned; }, flags);
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

  // The scripted Edit.
  const script = DEMO_REWRITES[SLUG];
  const REWRITE_ON = { demoEditRewrite: true };
  // The paragraph's state in the frame: its text, the marked insertion, and
  // the animation step (data-tdoc-demo-rewrite).
  const paragraph = async (page) => {
    const frame = await (await page.locator('iframe').first().elementHandle()).contentFrame();
    return frame.evaluate(({ before, after }) => {
      const norm = (x) => x.replace(/\s+/g, ' ').trim();
      const el = [...document.querySelectorAll('[data-tdoc-demo-rewrite], p')]
        .find((p) => p.hasAttribute('data-tdoc-demo-rewrite') || norm(p.textContent) === norm(before) || norm(p.textContent) === norm(after));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const ins = el.querySelector('ins.tdoc-diff-ins');
      return {
        text: norm(el.textContent),
        step: el.getAttribute('data-tdoc-demo-rewrite'),
        ins: ins ? norm(ins.textContent) : null,
        insBg: ins ? getComputedStyle(ins).backgroundColor : null,
        del: el.querySelectorAll('del').length,
        top: r.top, bottom: r.bottom, innerH: innerHeight,
      };
    }, script);
  };
  // Every step the paragraph goes through, recorded in the frame.
  const recordSteps = async (page) => {
    const frame = await (await page.locator('iframe').first().elementHandle()).contentFrame();
    await frame.evaluate(() => {
      window.__steps = [];
      new MutationObserver((list) => list.forEach((m) => {
        const v = m.target.getAttribute('data-tdoc-demo-rewrite');
        if (v && window.__steps[window.__steps.length - 1] !== v) window.__steps.push(v);
      })).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-tdoc-demo-rewrite'] });
    });
    return () => frame.evaluate(() => window.__steps);
  };
  const pickEdit = async (page, panel) => {
    await panel.getByRole('button', { name: /^Mode:/ }).click();
    await page.getByRole('menuitem', { name: /^Edit/ }).click();
    return panel.getByRole('textbox', { name: 'What should the agent change?' });
  };
  // The scripted request is fixed: read-only, and typing, deleting or
  // pasting leaves it as it is.
  const fixedRequest = async (page, box, name) => {
    if (await box.isEditable()) throw new Error(`${name}: the request is editable`);
    if ((await box.getAttribute('readonly')) === null) throw new Error(`${name}: the request is not read-only`);
    await box.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(' and in French');
    await box.evaluate((el) => el.blur());
    if ((await box.inputValue()) !== script.prompt) throw new Error(`${name}: the request changed: ${await box.inputValue()}`);
  };
  const noOverflow = async (page, name) => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) throw new Error(`${name}: ${over}px of horizontal overflow`);
  };
  const ctaShown = async (page, panel, width, name) => {
    const cta = panel.locator('.tdoc-ask-demo-cta');
    await cta.waitFor({ timeout: 10000 });
    const link = cta.getByRole('link', { name: 'Create a free doc' });
    if ((await link.getAttribute('href')) !== '/start') throw new Error(`${name}: CTA goes to ${await link.getAttribute('href')}`);
    if (!/\bui-btn-primary\b/.test(await link.getAttribute('class'))) throw new Error(`${name}: the CTA is not the primary button`);
    await link.scrollIntoViewIfNeeded();
    const box = await link.boundingBox();
    const vp = page.viewportSize();
    if (!box || box.x < 0 || box.x + box.width > width || box.y < 0 || box.y + box.height > vp.height) throw new Error(`${name}: CTA off screen: ${JSON.stringify(box)}`);
    return cta;
  };

  try {
    await t('desktop 1440: Edit opens with the scripted request; Send rewrites the paragraph in the doc, Claude (demo) replies, then "Create a free doc"; Undo resets', async () => {
      const { context, page, shot, noWrites } = await open('desktop', { viewport: { width: 1440, height: 900 } }, REWRITE_ON);
      const steps = await recordSteps(page);
      await page.locator('#tdoc-send-agent-btn').click();
      const panel = page.locator('.tdoc-ask-panel');
      await panel.waitFor();
      const box = await pickEdit(page, panel);
      if ((await box.inputValue()) !== script.prompt) throw new Error(`Edit input: ${JSON.stringify(await box.inputValue())}`);
      await fixedRequest(page, box, 'desktop');
      const send = panel.getByRole('button', { name: 'Send to Claude (demo)', exact: true });
      if (await send.isDisabled()) throw new Error('Send is off with the prefilled request');
      await shot('desktop-1440-rewrite-before.png');
      await send.click();
      await panel.getByText('Sent to Claude (demo) ✓').waitFor({ timeout: 5000 });
      // During: the old words struck, the new ones typing in.
      const deadline = Date.now() + 8000;
      let mid = null;
      while (Date.now() < deadline) {
        mid = await paragraph(page);
        if (mid && mid.step === 'typing' && mid.ins) break;
        await page.waitForTimeout(80);
      }
      if (!mid || mid.step !== 'typing' || mid.del !== 1) throw new Error(`no struck-and-typing step: ${JSON.stringify(mid)}`);
      await shot('desktop-1440-rewrite-during.png');
      await ctaShown(page, panel, 1440, 'desktop');
      const end = await paragraph(page);
      if (end.step !== 'done' || end.text !== script.after || end.ins !== script.after || end.del !== 0) throw new Error(`end state: ${JSON.stringify(end)}`);
      if (!end.insBg || end.insBg === 'rgba(0, 0, 0, 0)') throw new Error('the new text is not marked');
      if (end.top < 0 || end.bottom > end.innerH) throw new Error(`the rewritten paragraph is not in view: ${JSON.stringify(end)}`);
      const seen = await steps();
      if (seen.join(' → ') !== 'striking → typing → folding → done') throw new Error(`steps: ${seen.join(' → ')}`);
      // The reply, in Agent activity, as a real handoff ends.
      const activity = panel.locator('.tdoc-ask-activity');
      await activity.waitFor();
      await activity.getByText(/^Make the paragraph under/).first().waitFor({ timeout: 5000 });
      if (!/\bDone\b/.test(await activity.innerText())) throw new Error(`Agent activity row: ${await activity.innerText()}`);
      await noOverflow(page, 'desktop');
      await shot('desktop-1440-rewrite-after-cta.png');
      // Undo: the paragraph and the request come back; it can run again.
      await panel.getByRole('button', { name: 'Undo', exact: true }).click();
      await panel.locator('.tdoc-ask-demo-cta').waitFor({ state: 'detached' });
      let back = await paragraph(page);
      for (let i = 0; i < 20 && back.step; i++) { await page.waitForTimeout(50); back = await paragraph(page); }
      if (back.text !== script.before.replace(/\s+/g, ' ') || back.step) throw new Error(`after Undo: ${JSON.stringify(back)}`);
      if ((await box.inputValue()) !== script.prompt) throw new Error('Undo did not put the request back');
      await fixedRequest(page, box, 'desktop after Undo');
      if (await send.isDisabled()) throw new Error('after Undo, Send is off');
      if (await panel.getByText('Sent to Claude (demo) ✓').count()) throw new Error('after Undo, the old "Sent" line is still there');
      // The reply is under the request's comment, as any agent reply is.
      await activity.getByText(/^Make the paragraph under/).first().click();
      const card = page.locator('[data-comment-id]').filter({ hasText: 'Make the paragraph under' }).first();
      await card.locator('.tdoc-handoff-chip[data-handoff-state="answered"]').waitFor({ timeout: 5000 });
      await card.locator('.tdoc-replies-toggle').click();
      await card.getByText(/^Done: that paragraph is 19 words now, down from 28/).waitFor({ timeout: 5000 });
      noWrites();
      await context.close();
    });

    await t('desktop 1440, reduced motion: the paragraph swaps at once, no striking or typing; the CTA still follows', async () => {
      const { context, page, shot, noWrites } = await open('desktop-reduced', { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }, REWRITE_ON);
      const steps = await recordSteps(page);
      await page.locator('#tdoc-send-agent-btn').click();
      const panel = page.locator('.tdoc-ask-panel');
      await (await pickEdit(page, panel)).waitFor();
      await panel.getByRole('button', { name: 'Send to Claude (demo)', exact: true }).click();
      await ctaShown(page, panel, 1440, 'reduced');
      const end = await paragraph(page);
      if (end.step !== 'done' || end.ins !== script.after) throw new Error(`end state: ${JSON.stringify(end)}`);
      const seen = await steps();
      if (seen.join(',') !== 'done') throw new Error(`reduced motion animated: ${seen.join(' → ')}`);
      await shot('desktop-1440-rewrite-reduced.png');
      noWrites();
      await context.close();
    });

    // A different instruction (plain demo reply, no rewrite) is covered by
    // tornado-doc-landing.test.js against the backend: the visitor can no
    // longer type one.
    await t('desktop: the request can\'t be changed or emptied; flag off, Edit opens empty and editable', async () => {
      const { context, page, noWrites } = await open('desktop-fixed', { viewport: { width: 1280, height: 800 } }, REWRITE_ON);
      await page.locator('#tdoc-send-agent-btn').click();
      const panel = page.locator('.tdoc-ask-panel');
      const box = await pickEdit(page, panel);
      await fixedRequest(page, box, 'desktop');
      await box.click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.press('Delete');
      if ((await box.inputValue()) !== script.prompt) throw new Error('select-all + Delete emptied the request');
      let filled = true;
      try { await box.fill('Translate the headline into French', { timeout: 1500 }); } catch { filled = false; }
      if (filled || (await box.inputValue()) !== script.prompt) throw new Error('fill() changed the request');
      if (await panel.getByRole('button', { name: 'Send to Claude (demo)', exact: true }).isDisabled()) throw new Error('Send is off');
      noWrites();
      await context.close();
      const off = await open('desktop-flag-off', { viewport: { width: 1280, height: 800 } }, { demoEditRewrite: false });
      await off.page.locator('#tdoc-send-agent-btn').click();
      const offPanel = off.page.locator('.tdoc-ask-panel');
      const offBox = await pickEdit(off.page, offPanel);
      if (await offBox.inputValue()) throw new Error(`flag off, Edit prefilled: ${await offBox.inputValue()}`);
      if (!(await offBox.isEditable())) throw new Error('flag off, Edit is read-only');
      await off.context.close();
    });

    // On a phone the drawer covers 70% of the screen: after Send it gives
    // way to a slim bar ("Editing…"), the paragraph is rewritten fully above
    // that bar, and the bar becomes "Create a free doc" + Undo.
    const slimBar = (page) => page.locator('.tdoc-demo-rewrite-bar');
    const aboveBar = async (page, name) => {
      const p = await paragraph(page);
      const frameBox = await page.locator('iframe').first().boundingBox();
      const bar = await slimBar(page).boundingBox();
      const top = await page.locator('.tdoc-bar').first().boundingBox();
      const pTop = frameBox.y + p.top; const pBottom = frameBox.y + p.bottom;
      if (!bar) throw new Error(`${name}: no slim bar`);
      if (pTop < (top ? top.y + top.height : frameBox.y) - 1 || pBottom > bar.y + 1) throw new Error(`${name}: the paragraph (${pTop}-${pBottom}) is not between the top bar and the slim bar at ${bar.y}`);
      return p;
    };
    const drawerClosed = async (page, name) => {
      const layer = page.locator('#tdoc-comment-layer');
      if (await layer.count() && await layer.isVisible()) {
        const b = await layer.boundingBox();
        if (b && b.y < page.viewportSize().height - 2) throw new Error(`${name}: the drawer is still open (top ${b.y})`);
      }
    };
    const phoneEdit = async (page) => {
      await page.locator('.tdoc-fab').click();
      const panel = page.locator('#tdoc-comment-layer .tdoc-ask-panel');
      // WebKit can take the tab tap while the drawer is still sliding in.
      for (let i = 0; i < 3; i++) {
        await page.locator('.tdoc-drawer-tabs').getByText('Ask AI').click();
        try { await panel.getByRole('button', { name: /^Mode:/ }).waitFor({ timeout: 4000 }); break; } catch (e) { if (i === 2) throw e; }
      }
      return { panel, box: await pickEdit(page, panel) };
    };
    for (const engine of ['chromium', 'webkit']) for (const width of [430, 390]) {
      await t(`phone ${width} ${engine}: the request is fixed; after Send the drawer gives way to an "Editing…" bar, the paragraph is rewritten above it, the bar becomes the CTA; Undo brings the drawer back`, async () => {
        const PHONE = { ...devices['iPhone 13'], defaultBrowserType: undefined, viewport: { width, height: 844 } };
        const { context, page, shot, noWrites } = await open(`phone-${width}-${engine}`, PHONE, REWRITE_ON, engine);
        const steps = await recordSteps(page);
        const { panel, box } = await phoneEdit(page);
        if ((await box.inputValue()) !== script.prompt) throw new Error(`Edit input: ${JSON.stringify(await box.inputValue())}`);
        if (await box.isEditable() || (await box.getAttribute('readonly')) === null) throw new Error('the request is editable');
        await shot(`phone-${width}-${engine}-rewrite-before.png`);
        await panel.getByRole('button', { name: 'Send to Claude (demo)' }).first().click();
        await slimBar(page).getByText(/Editing…/).waitFor({ timeout: 5000 });
        let mid = null;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          mid = await paragraph(page);
          if (mid && mid.step === 'typing' && mid.ins && mid.ins.split(' ').length > 6) break;
          await page.waitForTimeout(80);
        }
        if (!mid || mid.step !== 'typing') throw new Error(`no typing step: ${JSON.stringify(mid)}`);
        await drawerClosed(page, 'during');
        if (!/Editing…/.test(await slimBar(page).innerText())) throw new Error('the bar is not "Editing…" during the rewrite');
        await page.waitForTimeout(400); // the smooth scroll settles
        await aboveBar(page, 'during');
        await shot(`phone-${width}-${engine}-rewrite-during.png`);
        const link = slimBar(page).getByRole('link', { name: 'Create a free doc' });
        await link.waitFor({ timeout: 10000 });
        if ((await link.getAttribute('href')) !== '/start') throw new Error(`CTA goes to ${await link.getAttribute('href')}`);
        if (!/\bui-btn-primary\b/.test(await link.getAttribute('class'))) throw new Error('the CTA is not the primary button');
        await page.waitForTimeout(500);
        const end = await aboveBar(page, 'after');
        if (end.step !== 'done' || end.ins !== script.after) throw new Error(`end state: ${JSON.stringify(end)}`);
        if ((await steps()).join(' → ') !== 'striking → typing → folding → done') throw new Error(`steps: ${(await steps()).join(' → ')}`);
        await drawerClosed(page, 'after');
        const vp = page.viewportSize();
        for (const el of [link, slimBar(page).getByRole('button', { name: 'Undo' })]) {
          const b = await el.boundingBox();
          if (!b || b.x < 0 || b.x + b.width > width || b.y + b.height > vp.height) throw new Error(`bar control off screen: ${JSON.stringify(b)}`);
        }
        await noOverflow(page, `phone ${width}`);
        await shot(`phone-${width}-${engine}-rewrite-after-cta.png`);
        // Undo: the paragraph back, the drawer's Edit as before Send.
        await slimBar(page).getByRole('button', { name: 'Undo' }).click();
        await slimBar(page).waitFor({ state: 'detached' });
        const again = page.locator('#tdoc-comment-layer .tdoc-ask-panel').getByRole('textbox', { name: 'What should the agent change?' });
        await again.waitFor();
        if ((await again.inputValue()) !== script.prompt) throw new Error('Undo did not bring the request back');
        if (await page.locator('#tdoc-comment-layer .tdoc-ask-panel').getByRole('button', { name: 'Send to Claude (demo)' }).first().isDisabled()) throw new Error('after Undo, Send is off');
        let back = await paragraph(page);
        for (let i = 0; i < 20 && back.step; i++) { await page.waitForTimeout(50); back = await paragraph(page); }
        if (back.text !== script.before.replace(/\s+/g, ' ') || back.step) throw new Error(`after Undo: ${JSON.stringify(back)}`);
        noWrites();
        await context.close();
      });
    }

    await t('phone 390, reduced motion: the bar shows, the paragraph swaps at once above it, the CTA follows', async () => {
      const PHONE = { ...devices['iPhone 13'], defaultBrowserType: undefined, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' };
      const { context, page, shot, noWrites } = await open('phone-390-reduced', PHONE, REWRITE_ON);
      const steps = await recordSteps(page);
      const { panel } = await phoneEdit(page);
      await panel.getByRole('button', { name: 'Send to Claude (demo)' }).first().click();
      await slimBar(page).waitFor({ timeout: 5000 });
      await slimBar(page).getByRole('link', { name: 'Create a free doc' }).waitFor({ timeout: 10000 });
      await page.waitForTimeout(200);
      const end = await aboveBar(page, 'reduced');
      if (end.step !== 'done' || end.ins !== script.after) throw new Error(`end state: ${JSON.stringify(end)}`);
      if ((await steps()).join(',') !== 'done') throw new Error(`reduced motion animated: ${(await steps()).join(' → ')}`);
      await shot('phone-390-rewrite-reduced.png');
      noWrites();
      await context.close();
    });

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
      // The signed-out "You" has no picture: its face is the initial, on the
      // card and on the margin pin, never a blank.
      const face = (await card.locator('.author .tdoc-avatar-fallback').first().textContent().catch(() => '')).trim();
      if (face !== 'Y') throw new Error(`the "You" card has no initial face: ${JSON.stringify(face)}`);
      const pins = await page.locator('.tdoc-pin[data-id]').count();
      const pinFaces = await page.locator('.tdoc-pin .tdoc-avatar-fallback').allTextContents();
      if (!pins || !pinFaces.includes('Y')) throw new Error(`the "You" pin has no initial face: ${JSON.stringify(pinFaces)}`);
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
    if (webkitBrowser) await webkitBrowser.close();
    server.close();
    globalThis.fetch = realFetch;
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
