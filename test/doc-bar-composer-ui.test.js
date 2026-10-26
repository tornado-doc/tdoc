// The document page as Julie approved it (2026-10-24), in the real shell
// against the real worker, desktop and phone:
//   bar       logo · title; Edited … · ✈ (owner / admin) · Share (quiet) ·
//             ⋯ · space chip (as on My docs) · avatar only. No space / folder
//             crumbs, no mode dropdown, no Resolved switch: the modes head ⋯,
//             the filter (Open / Resolved / All) heads the comments
//   composer  Comment + @agent. @agent puts an evidenced default in as a pill,
//             otherwise opens the picker;
//             the pill's menu is Mine / Team / tdoc AI (with "Connect my
//             agent"). No mode to pick: the agent answers or edits from the
//             text, where authorship lets it edit; elsewhere it answers only
//             ("Answers only"). "Only me" for one's own agent or tdoc AI,
//             never a team agent.
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
const LONG_ANSWER = 'Billing goes first.\n\n## Why billing leads\n- Invoices block two renewals.\n- Search can follow in April.\n\nCheck **the launch plan** and [details](https://tdoc.dev/docs).\n\n```js\nconst phase = "billing";\nconsole.log(phase);\n```';
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
  await page.mouse.move(box.x + r.x2, box.y + r.y2, { steps: 6 });
  if (await frame.locator('.tdoc-selection-action').isVisible()) throw new Error('Comment action flashed during selection drag');
  await page.mouse.up();
  const action = frame.getByRole('button', { name: 'Comment', exact: true });
  await action.waitFor();
  if (await page.locator('.tdoc-popup').isVisible()) throw new Error('selection opened a composer before Comment was clicked');
  await action.click();
  await page.locator('.tdoc-popup textarea').waitFor();
}

(async () => {
  console.log('Doc bar and composer (real shell)');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (!String(u).startsWith(MODEL)) return realFetch(input, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: LONG_ANSWER } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: MODEL });
  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  const reader = await issue(worker, env, 'reader');
  for (const who of [bob, reader]) await env.META.delete(`account-terminal:${who.account_id}`);
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json', ...o.headers }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const julieAgent = { 'X-Tdoc-Agent': 'local/juliesmac/juliesmac_claude' };
  const up = (token, slug, v, title, headers = {}) => api('/api/upload', { method: 'POST', token, headers, body: { slug, version: v, html: DOC(title), meta: { title } } });
  await api('/api/notify/local/register', { method: 'POST', token: julie.token, body: { device: 'juliesmac', clis: ['claude'] } });
  await up(julie.token, 'launch-plan', 1, 'Launch plan', julieAgent);
  await up(julie.token, 'own-agent-draft', 1, 'Agent draft', julieAgent);
  const team = (await api('/api/teams', { method: 'POST', cookie: julie.cookie, body: { name: 'Tdoc' } })).body.team;
  await api('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: team.invite_url.split('/').pop() } });
  await up(julie.token, 'team-plan', 1, 'Team plan');
  await up(julie.token, 'julies-draft', 1, "Julie's draft", julieAgent);
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
  // flags: pin feature flags for this page, e.g. { unifiedEntry: false } for
  // the phone top-bar Ask AI drawer that the unified entry replaces.
  const open = async (who, slug, phone = false, flags = null) => {
    const context = await browser.newContext(phone ? { ...devices['iPhone 13'], defaultBrowserType: undefined } : { viewport: { width: 1440, height: 800 } });
    if (flags) await context.addInitScript((pinned) => { window.__TDOC_FLAGS__ = pinned; }, flags);
    if (who) await context.addCookies([{ name: 'tdoc_sid', value: who.cookie.split('=')[1], domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    page.on('pageerror', (e) => { throw e; });
    await page.goto(`${base}/d/${slug}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    return { context, page };
  };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}` }); } };
  const compose = async (page, text) => {
    await dragSelect(page, 'Billing ships first');
    const pop = page.locator('.tdoc-popup');
    await pop.waitFor();
    await pop.locator('textarea').fill(text);
    await pop.locator('.tdoc-composer-agent').click();
    await pop.locator('.tdoc-agent-pill').click();
    const menu = page.locator('.ui-menu-popup');
    await menu.waitFor();
    const items = await menu.innerText();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    if (await pop.locator('.tdoc-ask-mode').count()) throw new Error('a mode control is back');
    return { pop, items };
  };
  const answersOnly = (pop) => pop.locator('.tdoc-ask-only-label').count();
  const comments = async (slug, v = 1) => { const r = await api(`/api/comments?slug=${slug}&version=${v}`, { cookie: julie.cookie }); return Array.isArray(r.body) ? r.body : r.body.comments; };
  const pending = async (device, token) => (await api(`/api/notify/local/pending?device=${device}`, { token })).body.pending;
  let failed = 0;
  let desktopAskIcon = '';
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };

  try {
    await t('selection opens a composer; an empty draft copies the quote while a typed draft keeps native copy', async () => {
      const { context, page } = await open(julie, 'launch-plan');
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await dragSelect(page, 'Billing ships first');
      const pop = page.locator('.tdoc-popup');
      await shot(page, 'selection-composer-desktop.png');
      const selected = (await pop.locator('.head .h').textContent()).replace(/^"|"$/g, '');
      if (!selected.includes('Billing ships')) throw new Error(`composer lost selected text: ${JSON.stringify(selected)}`);
      const textarea = pop.locator('textarea');
      if (!(await textarea.evaluate((el) => document.activeElement === el))) throw new Error('desktop composer did not focus its textarea');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
      const keyboardCopy = await page.evaluate(() => navigator.clipboard.readText());
      if (keyboardCopy !== selected) throw new Error(`empty draft copied ${JSON.stringify(keyboardCopy)} instead of ${JSON.stringify(selected)}`);
      await textarea.fill('draft text');
      await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
      if ((await page.evaluate(() => navigator.clipboard.readText())) !== 'sentinel') throw new Error('typed draft shortcut copied the quote');
      await textarea.evaluate((el) => el.select());
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
      if ((await page.evaluate(() => navigator.clipboard.readText())) !== 'draft text') throw new Error('native textarea copy was intercepted');
      await pop.getByRole('button', { name: 'Copy selected text' }).click();
      const buttonCopy = await page.evaluate(() => navigator.clipboard.readText());
      if (buttonCopy !== selected) throw new Error(`quote icon copied ${JSON.stringify(buttonCopy)}`);
      await pop.locator('.x').click();
      await page.locator('.tdoc-bar .tdoc-mode-trigger').click();
      await page.getByRole('menuitemradio', { name: /Read/ }).click();
      await page.locator('.tdoc-bar .tdoc-mode-trigger[data-mode="read"]').waitFor();
      await page.waitForFunction(() => localStorage.getItem('tdoc-mode:launch-plan:julie') === 'read');
      await page.reload();
      await page.locator('.tdoc-bar .tdoc-mode-trigger[data-mode="read"]').waitFor();
      await context.close();
    });

    await t('phone keeps native copy, shows Comment after release, and remembers a chosen Read per document', async () => {
      const { context, page } = await open(julie, 'launch-plan', true);
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.locator('.tdoc-mode-trigger[data-mode="comment"]').waitFor();
      const frame = await (await page.locator('iframe').first().elementHandle()).contentFrame();
      const select = async () => frame.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = node.nodeValue.indexOf('Billing ships first');
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index); range.setEnd(node, index + 'Billing ships first'.length);
          getSelection().removeAllRanges(); getSelection().addRange(range);
          const rect = range.getBoundingClientRect();
          const touch = new Touch({ identifier: 1, target: document.body, clientX: rect.left + 2, clientY: rect.top + rect.height / 2 });
          document.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch] }));
          document.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [touch] }));
          return;
        }
      });
      await select();
      const action = frame.getByRole('button', { name: 'Comment', exact: true });
      await action.waitFor();
      if (await page.locator('.tdoc-popup').count()) throw new Error('selection opened the composer before Comment was clicked');
      const selected = await frame.evaluate(() => getSelection().toString());
      if (selected !== 'Billing ships first') throw new Error(`native selection was lost: ${JSON.stringify(selected)}`);
      const geometry = await frame.evaluate(() => ({
        selectedBottom: getSelection().getRangeAt(0).getBoundingClientRect().bottom,
        actionTop: document.querySelector('.tdoc-selection-action').getBoundingClientRect().top,
      }));
      if (geometry.actionTop < geometry.selectedBottom) throw new Error(`phone action covered the system Copy menu: ${JSON.stringify(geometry)}`);
      const nativeCopy = await frame.evaluate(() => {
        const data = new DataTransfer();
        document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
        return data.getData('text/plain');
      });
      if (nativeCopy !== selected) throw new Error(`native copy did not preserve selected text: ${JSON.stringify(nativeCopy)}`);
      await action.click();
      const pop = page.locator('.tdoc-popup');
      await pop.waitFor();
      if (await pop.locator('textarea').evaluate((el) => document.activeElement === el)) throw new Error('phone composer opened the keyboard');
      await shot(page, 'selection-composer-phone.png');
      await frame.evaluate(() => {
        const touch = new Touch({ identifier: 2, target: document.body, clientX: innerWidth - 12, clientY: innerHeight - 12 });
        document.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch] }));
        document.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [touch] }));
      });
      await pop.waitFor({ state: 'detached' });
      if (await frame.evaluate(() => getSelection().toString() || window.CSS?.highlights?.has('tdoc-pending'))) throw new Error('tap away left selection or pending highlight');
      await page.locator('.tdoc-mode-trigger').click();
      await page.getByRole('menuitemradio', { name: /Read/ }).click();
      await page.reload();
      await page.locator('.tdoc-mode-trigger[data-mode="read"]').waitFor();
      await page.goto(`${base}/d/own-agent-draft`);
      await page.locator('.tdoc-mode-trigger[data-mode="comment"]').waitFor();
      await context.close();
    });

    await t('desktop bar: logo · title; Edited · ✈ · Share · ⋯ · space chip · avatar; mode switch in the bar; the filter heads the comments', async () => {
      const { context, page } = await open(julie, 'launch-plan');
      await page.locator('.tdoc-bar .tdoc-space-trigger', { hasText: 'My docs' }).waitFor();
      if (await page.locator('.tdoc-crumbs, .tdoc-crumb').count()) throw new Error('space / folder crumbs are back');
      if (!(await page.locator('.tdoc-bar-left .doc-title').isVisible())) throw new Error('no title on the left');
      if (await page.locator('#tdoc-show-resolved, #tdoc-theme-btn, #tdoc-star-btn').count()) throw new Error('an old bar control is back');
      if (!(await page.locator('.tdoc-bar .tdoc-mode-trigger').isVisible())) throw new Error('the mode switch is not in the bar');
      if (!/^Edited /.test((await page.locator('#tdoc-version-toggle').textContent()).trim())) throw new Error('no Edited …');
      await page.locator('#tdoc-send-agent-btn').waitFor();
      desktopAskIcon = await page.locator('#tdoc-send-agent-btn .tdoc-ask-ai-mark').evaluate((el) => el.outerHTML);
      const share = page.locator('#tdoc-share-btn');
      if (await share.evaluate((el) => el.classList.contains('primary'))) throw new Error('Share is a filled primary button');
      const askStyle = await page.locator('#tdoc-send-agent-btn').evaluate((el) => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, border: style.borderWidth };
      });
      if (askStyle.background !== 'rgba(0, 0, 0, 0)' || askStyle.border !== '0px') throw new Error(`Ask AI has a pill: ${JSON.stringify(askStyle)}`);
      if (await page.locator('.tdoc-account-trigger .name').isVisible()) throw new Error('the avatar shows a name');
      await page.locator('.tdoc-bar .tdoc-mode-trigger').click();
      await page.getByRole('menuitemradio', { name: /Comment/ }).waitFor();
      await page.getByRole('menuitemradio', { name: /Read/ }).waitFor();
      await page.getByRole('menuitemradio', { name: /Edit/ }).click();
      await page.locator('.tdoc-bar .tdoc-mode-trigger').click();
      if (await page.getByRole('menuitemradio', { name: /Edit/ }).getAttribute('aria-checked') !== 'true') throw new Error('mode did not change from the bar');
      await page.keyboard.press('Escape');
      const filter = page.locator('.tdoc-comment-filter');
      await filter.waitFor();
      await filter.getByRole('radio', { name: /Resolved/ }).click();
      await page.waitForFunction(() => document.querySelectorAll('.tdoc-pin').length === 1);
      await filter.getByRole('radio', { name: /All/ }).click();
      await page.locator('.tdoc-bar .tdoc-space-trigger').click();
      await page.locator('.ui-menu-popup .tdoc-space-item-name', { hasText: 'Tdoc' }).waitFor();
      await shot(page, 'doc-bar-desktop.png');
      await context.close();
    });

    await t('phone bar and Ask AI drawer fit 375px, 390px and 430px, including a reduced keyboard viewport', async () => {
      for (const width of [375, 390, 430]) {
      const { context, page } = await open(julie, 'launch-plan', true, { unifiedEntry: false });
      await page.setViewportSize({ width, height: 800 });
      await page.locator('#tdoc-send-agent-btn').waitFor();
      const phoneAskIcon = await page.locator('#tdoc-send-agent-btn .tdoc-ask-ai-mark').evaluate((el) => el.outerHTML);
      if (phoneAskIcon !== desktopAskIcon) throw new Error('Ask AI uses a different icon on phone');
      if (!(await page.locator('#tdoc-share-btn').isVisible())) throw new Error('no Share on a phone');
      if (!(await page.locator('#tdoc-share-btn svg').isVisible())) throw new Error('Share icon is missing on a phone');
      const actions = await page.evaluate(() => ['tdoc-send-agent-btn', 'tdoc-share-btn', 'tdoc-more-btn'].map((id) => {
        const el = document.getElementById(id);
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return { id, x: box.x, width: box.width, right: box.right, background: style.backgroundColor, border: style.borderWidth };
      }));
      if (actions.some((action) => action.width !== 44 || action.background !== 'rgba(0, 0, 0, 0)' || action.border !== '0px')) {
        throw new Error(`phone actions are not matching flat icon targets: ${JSON.stringify(actions)}`);
      }
      if (!(actions[0].x < actions[1].x && actions[1].x < actions[2].x && actions[2].right <= width)) {
        throw new Error(`Ask AI · Share · More do not fit in order at ${width}px: ${JSON.stringify(actions)}`);
      }
      if (!(await page.locator('.tdoc-bar .doc-title').isVisible())) throw new Error('no title on a phone');
      if (!(await page.locator('.tdoc-bar-mark').isVisible())) throw new Error('mobile logo is missing');
      if (await page.locator('.tdoc-ask-ai-label').isVisible()) throw new Error('Ask AI label crowds the phone bar');
      if (await page.locator('.tdoc-bar .tdoc-space-trigger').isVisible()) throw new Error('space chip crowds the phone bar');
      if (await page.locator('.tdoc-account-trigger').isVisible()) throw new Error('avatar in the phone bar');
      await page.locator('#tdoc-more-btn').click();
      await page.getByRole('menuitem', { name: 'My docs', exact: true }).waitFor();
      await page.getByRole('menuitem', { name: /My account/ }).waitFor();
      const unreadDot = page.locator('#tdoc-more-btn .tdoc-unread-dot');
      if (await unreadDot.count() && await unreadDot.evaluate((el) => getComputedStyle(el).backgroundColor) !== 'rgb(22, 82, 240)') throw new Error('mobile unread dot is not blue');
      await page.keyboard.press('Escape');
      await page.locator('#tdoc-send-agent-btn').click();
      const drawer = page.getByRole('dialog', { name: 'Ask AI' });
      await drawer.waitFor();
      const clickedBackground = await page.locator('#tdoc-send-agent-btn').evaluate((el) => getComputedStyle(el).backgroundColor);
      if (clickedBackground !== 'rgba(0, 0, 0, 0)') throw new Error(`Ask AI keeps a grey hover background after opening: ${clickedBackground}`);
      await drawer.getByRole('button', { name: 'Who should answer?' }).click();
      const menu = page.locator('.tdoc-agent-menu');
      await menu.getByRole('menuitem').first().waitFor();
      if (!(await menu.getByRole('menuitem').first().innerText()).includes('Claude Code')) throw new Error('the connected agent is not first');
      if (!(await menu.getByRole('menuitem', { name: /tdoc AI/ }).count())) throw new Error('tdoc AI fallback is missing');
      await shot(page, `ask-ai-agent-menu-${width}.png`);
      await page.keyboard.press('Escape');
      const bounds = await drawer.boundingBox();
      if (!bounds || Math.abs(bounds.x) > 2 || Math.abs(bounds.width - width) > 2 || bounds.y < 0) throw new Error(`Ask AI is not a bottom drawer at ${width}px: ${JSON.stringify(bounds)}`);
      if (await page.locator('.tdoc-fab').isVisible()) throw new Error('comment FAB overlaps Ask AI drawer');
      await shot(page, `ask-ai-phone-${width}.png`);
      await drawer.locator('textarea').fill('Why billing first?');
      await page.evaluate(() => {
        // Headless browsers have no software keyboard. Shrink and shift the
        // visual viewport as iOS does when the keyboard opens.
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 420 });
        Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, value: 20 });
        window.visualViewport.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(() => {
        const rect = document.querySelector('.tdoc-ask-mobile-drawer')?.getBoundingClientRect();
        return rect && rect.bottom <= 441 && rect.height <= 413 && rect.top >= 18;
      });
      const keyboard = await drawer.evaluate((el) => ({ drawer: el.getBoundingClientRect().toJSON(), input: el.querySelector('textarea').getBoundingClientRect().toJSON() }));
      if (keyboard.drawer.y < 18 || keyboard.input.bottom > 440 || keyboard.drawer.bottom > 441) throw new Error(`keyboard covers Ask AI at ${width}px: ${JSON.stringify(keyboard)}`);
      await shot(page, `ask-ai-keyboard-${width}.png`);
      await drawer.getByRole('button', { name: 'Close Ask AI' }).click();
      await page.locator('.tdoc-fab').click();
      await page.locator('#tdoc-comment-layer .tdoc-comment-filter').waitFor();
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      if (layout.scrollWidth > layout.width + 1) throw new Error(JSON.stringify(layout));
      await shot(page, `doc-bar-phone-${width}.png`);
      await context.close();
      }
    });

    await t('owner on own doc: @agent puts in their agent; Comment hands it to them to answer or edit', async () => {
      const { context, page } = await open(julie, 'launch-plan');
      const { pop, items } = await compose(page, 'Tighten this line');
      if (!/Mine/.test(items) || !/Connect my agent/.test(items)) throw new Error(`menu: ${items}`);
      if (await answersOnly(pop)) throw new Error('"Answers only" for an agent that may edit');
      await pop.getByRole('button', { name: 'Comment', exact: true }).click();
      let queued = [];
      for (let i = 0; i < 40 && !queued.length; i++) { queued = (await pending('juliesmac', julie.token)).filter((h) => h.kind !== 'ask'); if (!queued.length) await page.waitForTimeout(250); }
      if (queued.length !== 1) throw new Error(`not handed to edit: ${JSON.stringify(queued)}`);
      await context.close();
    });

    await t('member on a doc the team agent wrote: Team first; no Only me; Comment hands it to the team agent', async () => {
      const { context, page } = await open(bob, 'team-plan');
      const { pop, items } = await compose(page, 'Add last week');
      if (!/Team/.test(items) || !/tdoc-bot/.test(items)) throw new Error(`menu: ${items}`);
      if (await answersOnly(pop)) throw new Error('"Answers only" for the team agent on its own doc');
      if (await pop.locator('.tdoc-only-me').count()) throw new Error('Only me for a team agent');
      await shot(page, 'composer-team-edit.png');
      await pop.getByRole('button', { name: 'Comment', exact: true }).click();
      let queued = [];
      for (let i = 0; i < 40 && !queued.length; i++) { queued = (await pending('team-box', agentToken)).filter((h) => h.kind !== 'ask'); if (!queued.length) await page.waitForTimeout(250); }
      if (queued.length !== 1) throw new Error(`not handed to the team agent: ${JSON.stringify(queued)}`);
      await context.close();
    });

    await t('Ask AI puts the team editor first in the menu but defaults private questions to tdoc AI', async () => {
      const { context, page } = await open(bob, 'team-plan', true, { unifiedEntry: false });
      await page.locator('#tdoc-send-agent-btn').click();
      const panel = page.getByRole('dialog', { name: 'Ask AI' });
      if (!(await panel.getByRole('button', { name: 'Who should answer?' }).innerText()).includes('tdoc AI')) throw new Error('a team editor was selected for a private question');
      await panel.getByRole('button', { name: 'Who should answer?' }).click();
      const first = await page.locator('.tdoc-agent-menu').getByRole('menuitem').first().innerText();
      if (!first.includes('tdoc-bot') || !first.includes('Edited last')) throw new Error(`last editor is not explained in the menu: ${first}`);
      await page.keyboard.press('Escape');
      await panel.locator('textarea').fill('Why billing first?');
      await panel.getByRole('button', { name: 'Send question' }).click();
      await panel.getByText('Invoices block two renewals.').waitFor();
      if (await panel.getByText('Your agent could not be reached.').count()) throw new Error('the private question went to the team editor');
      await context.close();
    });

    await t('Ask AI defaults to the viewer’s own agent when it last edited the document', async () => {
      const { context, page } = await open(julie, 'own-agent-draft');
      await page.locator('#tdoc-send-agent-btn').click();
      const selected = await page.getByRole('dialog', { name: 'Ask AI' }).getByRole('button', { name: 'Who should answer?' }).innerText();
      if (!selected.includes('Claude Code')) throw new Error(`own last editor was not selected: ${selected}`);
      await context.close();
    });

    await t("member on a doc Julie's agent wrote: no automatic recipient; explicit team agent answers only", async () => {
      const { context, page } = await open(bob, 'julies-draft');
      await dragSelect(page, 'Billing ships first');
      const pop = page.locator('.tdoc-popup');
      await pop.waitFor();
      await pop.locator('textarea').fill('Can we move billing?');
      await pop.locator('.tdoc-composer-agent').click();
      if (await pop.locator('.tdoc-agent-pill').count()) throw new Error('somebody else’s agent became the default');
      const picker = page.locator('.tdoc-mention-menu');
      await picker.waitFor();
      await picker.getByRole('option', { name: /tdoc-bot/ }).click();
      await pop.locator('.tdoc-agent-pill').waitFor();
      if (!(await answersOnly(pop))) throw new Error('no "Answers only"');
      await shot(page, 'composer-ask-only-locked.png');
      await pop.getByRole('button', { name: 'Comment', exact: true }).click();
      let asks = [];
      for (let i = 0; i < 40 && !asks.length; i++) { asks = (await pending('team-box', agentToken)).filter((h) => h.kind === 'ask'); if (!asks.length) await page.waitForTimeout(250); }
      const posted = (await comments('julies-draft')).find((c) => c.text.startsWith('Can we move billing?'));
      if (asks.length !== 1 || !posted || asks[0].comment_id !== posted.id) throw new Error(JSON.stringify({ asks, posted: posted && posted.id }));
      await context.close();
    });

    await t('reader with no agent: explicitly chooses tdoc AI; Answers only; Only me on', async () => {
      const { context, page } = await open(reader, 'launch-plan');
      await dragSelect(page, 'Billing ships first');
      const pop = page.locator('.tdoc-popup');
      await pop.waitFor();
      await pop.locator('textarea').fill('Why billing first?');
      await pop.locator('.tdoc-composer-agent').click();
      if (await pop.locator('.tdoc-agent-pill').count()) throw new Error('reader inherited the owner’s agent as default');
      const picker = page.locator('.tdoc-mention-menu');
      await picker.waitFor();
      await picker.getByRole('option', { name: /tdoc AI/ }).click();
      await pop.locator('.tdoc-agent-pill').click();
      const menu = page.locator('.ui-menu-popup');
      await menu.waitFor();
      const items = await menu.innerText();
      await page.keyboard.press('Escape');
      if (!/tdoc AI/.test(items) || !/Connect my agent/.test(items)) throw new Error(`menu: ${items}`);
      if (!(await answersOnly(pop))) throw new Error('no "Answers only"');
      if (await pop.locator('.tdoc-only-me [role=checkbox]').getAttribute('aria-checked') !== 'true') throw new Error('Only me is not on for tdoc AI');
      await context.close();
    });

    await t('long Markdown answer stays readable in the 390px drawer and can expand to full height', async () => {
      const { context, page } = await open(reader, 'launch-plan', true, { unifiedEntry: false });
      await page.setViewportSize({ width: 390, height: 800 });
      if (!(await page.locator('.tdoc-bar-mark').isVisible())) throw new Error('reader logo is missing');
      await page.locator('#tdoc-send-agent-btn').click();
      const drawer = page.getByRole('dialog', { name: 'Ask AI' });
      await drawer.getByRole('textbox', { name: 'Ask about this document' }).fill('Explain the plan');
      await drawer.getByRole('button', { name: 'Send question' }).click();
      await drawer.locator('.tdoc-ask-answer-body h2').waitFor();
      if (!(await drawer.locator('.tdoc-ask-answer-body ul li').count())) throw new Error('Markdown list did not render');
      if (!(await drawer.locator('.tdoc-ask-answer-body pre code').count())) throw new Error('code block did not render');
      if (await drawer.locator('.tdoc-ask-answer-body a[href="https://tdoc.dev/docs"]').count() !== 1) throw new Error('safe Markdown link did not render');
      const clipped = await drawer.evaluate((root) => {
        const right = root.getBoundingClientRect().right;
        return [...root.querySelectorAll('.tdoc-ask-conversation, .tdoc-ask-turn, .tdoc-ask-question, .tdoc-ask-answer, .tdoc-md-pre, .tdoc-ask-turn-summary')]
          .filter((node) => node.getBoundingClientRect().right > right + 1)
          .map((node) => `${node.className}: ${Math.round(node.getBoundingClientRect().right - right)}px`);
      });
      if (clipped.length) throw new Error(`Ask AI content exceeds the phone drawer: ${clipped.join(', ')}`);
      const box = await drawer.boundingBox();
      if (!box || box.height < 800 * .69) throw new Error(`drawer is too short: ${JSON.stringify(box)}`);
      await shot(page, 'ask-ai-phone-long-answer-390.png');
      // Drag the handle upward to the full-height snap point.
      const handle = await drawer.getByRole('button', { name: 'Expand Ask AI' }).boundingBox();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2, 80, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(350);
      const expanded = await drawer.boundingBox();
      if (!expanded || expanded.y > box.y - 100) throw new Error(`drawer did not expand: ${JSON.stringify({ box, expanded })}`);
      await shot(page, 'ask-ai-phone-long-answer-expanded-390.png');
      await context.close();
    });

    await t('Ask AI opens for a reader, answers privately, preserves follow-ups and posts only on request', async () => {
      const { context, page } = await open(reader, 'launch-plan');
      await page.locator('#tdoc-send-agent-btn').click();
      const panel = page.getByRole('dialog', { name: 'Ask AI' });
      await panel.waitFor();
      const filterBox = await page.locator('.tdoc-comment-filter').boundingBox();
      const panelBox = await panel.boundingBox();
      if (filterBox && panelBox && panelBox.y < filterBox.y + filterBox.height) throw new Error('Ask AI panel overlaps the comment filters');
      await shot(page, 'ask-ai-reader-empty.png');
      const input = panel.getByRole('textbox', { name: 'Ask about this document' });
      if (!(await input.evaluate((el) => document.activeElement === el))) throw new Error('Ask input did not receive focus');
      if (await input.evaluate((el) => getComputedStyle(el).resize) !== 'none') throw new Error('textarea resize handle is visible');
      await input.fill('What is the conclusion?');
      await panel.getByRole('button', { name: 'Send question' }).click();
      await panel.getByText('Billing goes first.').waitFor();
      await panel.locator('.tdoc-ask-answer-body h2').waitFor();
      const questionBox = await panel.locator('.tdoc-ask-turn .tdoc-ask-question').boundingBox();
      const answerBox = await panel.locator('.tdoc-ask-turn .tdoc-ask-answer').boundingBox();
      if (!questionBox || !answerBox || questionBox.x <= answerBox.x) throw new Error('private question and answer do not read as a conversation');
      const before = (await api('/api/comments?slug=launch-plan&version=1', { cookie: reader.cookie })).body;
      if (JSON.stringify(before).includes('What is the conclusion?')) throw new Error('private question was posted');
      await panel.getByRole('button', { name: 'Keep to myself' }).click();
      await panel.getByText('Kept private').waitFor();
      await input.fill('What happens next?');
      await input.press('Enter');
      await panel.getByText('Billing goes first.').last().waitFor();
      if (await panel.locator('.tdoc-ask-turn').count() !== 1 || await panel.locator('.tdoc-ask-turn-summary').count() !== 1) throw new Error('previous answer did not collapse');
      await panel.locator('.tdoc-ask-turn-summary').click();
      if (!(await panel.locator('.tdoc-ask-turn').getByText('Kept private').isVisible())) throw new Error('previous answer did not expand');
      await panel.locator('.tdoc-ask-turn-collapse').click();
      await panel.getByRole('button', { name: 'Post as comment' }).click();
      await panel.getByText('Posted as a comment').waitFor();
      if (!(await panel.locator('.tdoc-ask-turn.is-public .tdoc-margin-comment').count()) || !(await panel.locator('.tdoc-ask-turn.is-public .tdoc-reply').count())) throw new Error('posted turn did not return to comment and reply cards');
      if (await panel.locator('.tdoc-ask-turn').getByText('Only you can see this').count()) throw new Error('public answer still looks private');
      const after = (await api('/api/comments?slug=launch-plan&version=1', { cookie: reader.cookie })).body;
      if (!JSON.stringify(after).includes('What happens next?')) throw new Error('public question was not posted');
      await page.locator('#tdoc-send-agent-btn').click();
      await page.locator('#tdoc-send-agent-btn').click();
      if (await page.getByRole('dialog', { name: 'Ask AI' }).locator('.tdoc-ask-turn-summary').count() !== 1) throw new Error('conversation disappeared after closing the panel');
      await shot(page, 'ask-ai-reader-desktop.png');
      await context.close();
    });

    await t('phone: one entry; the comment button opens Comments and Ask AI tabs, no Ask AI in the bar', async () => {
      for (const width of [375, 390, 430]) {
        const { context, page } = await open(reader, 'launch-plan', true);
        await page.setViewportSize({ width, height: 800 });
        if (await page.locator('#tdoc-send-agent-btn').count()) throw new Error(`${width}px: Ask AI is still in the top bar`);
        await page.locator('.tdoc-fab').click();
        const tabs = page.getByRole('radiogroup', { name: 'Comments or Ask AI' });
        await tabs.waitFor();
        await tabs.getByRole('radio', { name: /Ask AI/ }).click();
        const box = page.locator('#tdoc-comment-layer').getByRole('textbox', { name: 'Ask about this document' });
        await box.waitFor();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) throw new Error(`${width}px: page overflows by ${overflow}px`);
        await tabs.getByRole('radio', { name: /Comments/ }).click();
        if (await box.count()) throw new Error(`${width}px: Ask AI panel stays after switching back to Comments`);
        await shot(page, `unified-entry-${width}.png`);
        await context.close();
      }
    });

    await t('Ask AI keeps a long agent list behind More agents on a phone', async () => {
      for (const device of ['studio-a', 'studio-b', 'studio-c', 'studio-d']) {
        const registered = await api('/api/notify/local/register', { method: 'POST', token: julie.token, body: { device, clis: ['codex'] } });
        if (registered.status >= 400) throw new Error(`could not register ${device}: ${registered.status}`);
      }
      const { context, page } = await open(julie, 'launch-plan', true, { unifiedEntry: false });
      await page.setViewportSize({ width: 390, height: 800 });
      await page.locator('#tdoc-send-agent-btn').click();
      const drawer = page.getByRole('dialog', { name: 'Ask AI' });
      await drawer.getByRole('button', { name: 'Who should answer?' }).click();
      const menu = page.locator('.tdoc-agent-menu');
      const shown = await menu.innerText();
      if (!shown.includes('tdoc AI') || !shown.includes('More agents')) throw new Error(`agent list did not show tdoc AI and More agents: ${shown}`);
      await menu.getByRole('menuitem', { name: 'More agents' }).click();
      const extra = page.locator('.ui-menu-popup').nth(1);
      await extra.waitFor({ state: 'visible', timeout: 3000 });
      const choice = extra.getByRole('menuitem').first();
      await choice.waitFor();
      await shot(page, 'ask-ai-more-agents-390.png');
      const picked = (await choice.innerText()).trim();
      await choice.click();
      const selected = await drawer.getByRole('button', { name: 'Who should answer?' }).innerText();
      if (!picked.startsWith(selected.trim())) throw new Error(`agent choice was not selected: ${picked} / ${selected}`);
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
