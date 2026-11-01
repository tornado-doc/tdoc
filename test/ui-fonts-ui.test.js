// No serif in the product UI (2026-10-27): scoping docs-hub.css's bare body
// rule left the doc page's drawer tabs in the browser's default serif, because
// the shell had been borrowing its UI font from that sheet. The shell now sets
// its own (shell.css). This walks the real shell on the doc page (desktop and
// phone: bar, open card, composer, ⋯ menu, agent picker, drawer, Ask AI tab)
// and on /me, account settings, team settings (each tab) and /feedback, and fails if any visible control (button,
// tab, radio, menu item, input) computes to a serif face. The author document
// lives in an iframe and is not checked.
const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, issue } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium } = requirePlaywrightOrSkip('ui-fonts-ui.test.js');
const DOC = '<!doctype html><html><body><h1>Launch plan</h1><p>Billing ships first, on March 14, because invoices block two renewals.</p><p>The mobile app waits for Q4.</p></body></html>';

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((a) => [a.path, a]));
  const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) { res.setHeader('content-type', asset.type); return res.end(fs.readFileSync(asset.file)); }
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = { ...req.headers, host: 'tdoc.dev', ...(req.headers.origin ? { origin: 'https://tdoc.dev' } : {}) };
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, { waitUntil() {}, passThroughOnException() {} });
    const type = response.headers.get('content-type') || '';
    let out = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) out = Buffer.from(out.toString('utf8').replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path).replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    response.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'content-security-policy', 'set-cookie'].includes(k)) res.setHeader(k, v); });
    res.statusCode = response.status; res.end(out);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// Every visible control whose first font family is a serif face.
function serifControls(page) {
  return page.evaluate(() => {
    const SERIF = /^["']?(serif|times|times new roman|georgia|cambria|garamond|palatino|book antiqua)["']?$/i;
    const bad = [];
    for (const el of document.querySelectorAll('button, [role=menuitem], [role=menuitemradio], [role=tab], [role=radio], input, textarea, select, a.ui-btn, .ui-menu-item, .tdoc-mention-option')) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
      const first = cs.fontFamily.split(',')[0].trim();
      if (SERIF.test(first)) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}": ${cs.fontFamily}`);
    }
    return bad;
  });
}

(async () => {
  console.log('UI fonts: no serif in product controls');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (!String(u).startsWith('https://model.test')) return realFetch(input, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Because invoices block two renewals.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: 'https://model.test' });
  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  await env.META.delete(`account-terminal:${bob.account_id}`);
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json', ...o.headers }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  await api('/api/notify/local/register', { method: 'POST', token: julie.token, body: { device: 'juliesmac', clis: ['claude'] } });
  await api('/api/upload', { method: 'POST', token: julie.token, headers: { 'X-Tdoc-Agent': 'local/juliesmac/juliesmac_claude' }, body: { slug: 'launch-plan', version: 1, html: DOC, meta: { title: 'Launch plan' } } });
  const team = (await api('/api/teams', { method: 'POST', cookie: julie.cookie, body: { name: 'BeFreed' } })).body.team;
  await api('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: team.invite_url.split('/').pop() } });
  await api('/api/comments', { method: 'POST', cookie: bob.cookie, body: { slug: 'launch-plan', version: 1, text: 'Who owns billing?', anchor: { kind: 'text', text: 'The mobile app waits' } } });

  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); } };
  // Settings cards: hints, notes and status lines are the muted card-hint
  // size, not body text (they fell back to 15px ink outside .tdoc-modal).
  const hintsAreHints = async (page, where) => {
    const big = await page.evaluate(() => [...document.querySelectorAll('.tm-settings-card .manage-hint, .tm-settings-card .muted, .tm-settings-card .status')]
      .filter((el) => el.getBoundingClientRect().height && (parseFloat(getComputedStyle(el).fontSize) > 13.5 || getComputedStyle(el).color === getComputedStyle(document.querySelector('.tm-settings-head h2')).color))
      .map((el) => `${el.className} "${el.textContent.trim().slice(0, 30)}" ${getComputedStyle(el).fontSize}`));
    if (big.length) throw new Error(`${where}: hints read as body text: ${big.join('; ')}`);
  };
  const check = async (page, where) => {
    const bad = await serifControls(page);
    if (bad.length) throw new Error(`${where}: serif controls: ${bad.join('; ')}`);
  };
  try {
    for (const [label, opts] of [['desktop', { viewport: { width: 1280, height: 820 } }], ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
      const phone = label === 'phone';
      const open = async (url) => {
        const context = await browser.newContext(opts);
        await context.addCookies([{ name: 'tdoc_sid', value: julie.cookie.split('=')[1], domain: '127.0.0.1', path: '/' }]);
        const page = await context.newPage();
        await page.goto(`${base}${url}`);
        return { context, page };
      };
      const openDoc = async () => {
        const o = await open('/d/launch-plan');
        await o.page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
        await o.page.waitForFunction(() => document.body.dataset.tdocReady === '1');
        return o;
      };

      await t(`${label}: doc page bar, comments, Ask AI and ⋯ menu`, async () => {
        const { context, page } = await openDoc();
        await check(page, 'doc bar');
        if (phone) {
          await page.locator('.tdoc-fab').click();
          await page.getByRole('radiogroup', { name: 'Comments or Ask AI' }).waitFor();
          await check(page, 'comments drawer');
          await page.getByRole('radiogroup', { name: 'Comments or Ask AI' }).getByRole('radio', { name: /Ask AI/ }).click();
          await page.waitForTimeout(300);
          await check(page, 'Ask AI tab');
          // Agent activity inside the Ask AI tab (rows, Details, Mark all as read).
          const activity = page.locator('#tdoc-comment-layer .tdoc-ask-activity-toggle');
          if (await activity.count()) {
            await activity.click();
            await page.waitForTimeout(300);
            await check(page, 'Agent activity');
          }
          await page.keyboard.press('Escape');
        } else {
          await page.locator('button.tdoc-pin').first().click();
          await page.locator('.tdoc-margin-comment').first().waitFor();
          await check(page, 'open card');
          await page.locator('#tdoc-send-agent-btn').click();
          await page.locator('.tdoc-handoff-popover').waitFor();
          await check(page, 'Ask AI');
          await page.keyboard.press('Escape');
        }
        await page.getByRole('button', { name: 'More actions' }).first().click();
        await page.locator('.ui-menu-popup').first().waitFor();
        await check(page, '⋯ menu');
        await context.close();
      });

      await t(`${label}: composer and agent picker`, async () => {
        const { context, page } = await openDoc();
        const frameEl = await page.locator('iframe').first().elementHandle();
        const frame = await frameEl.contentFrame();
        await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'comment');
        const box = await frameEl.boundingBox();
        const r = await frame.evaluate(() => {
          const p = document.querySelector('p'); const range = document.createRange();
          range.setStart(p.firstChild, 0); range.setEnd(p.firstChild, 'Billing ships first'.length);
          const rects = range.getClientRects(); const a = rects[0]; const b = rects[rects.length - 1];
          return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
        });
        await page.mouse.move(box.x + r.x1, box.y + r.y1); await page.mouse.down();
        await page.mouse.move(box.x + r.x2, box.y + r.y2, { steps: 6 }); await page.mouse.up();
        const pop = page.locator('.tdoc-popup');
        await pop.locator('textarea').waitFor();
        await pop.locator('textarea').fill('Can we move this?');
        await check(page, 'composer');
        await pop.locator('.tdoc-composer-agent').click();
        await pop.locator('.tdoc-agent-pill').click();
        await page.locator('.ui-menu-popup').waitFor();
        await check(page, 'agent picker');
        await context.close();
      });

      await t(`${label}: My docs, account and team settings (Members, Guests, Agents), /feedback`, async () => {
        const { context, page } = await open('/me');
        await page.locator('main').waitFor();
        await page.waitForTimeout(500);
        await check(page, '/me');
        await page.goto(`${base}/me?view=settings`);
        await page.locator('.tm-settings').waitFor();
        await page.waitForTimeout(500);
        await check(page, 'account settings');
        await hintsAreHints(page, 'account settings');
        if (phone) {
          // All six views fit a 390px phone: none cut to "Settir".
          const tabs = await page.locator('.tabs').first().evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
          if (tabs.scroll > tabs.client + 1) throw new Error(`My docs views are cut off: ${JSON.stringify(tabs)}`);
        }
        await page.goto(`${base}/me?team=${team.id}&view=settings`);
        await page.locator('.tm-settings').waitFor();
        await check(page, 'team settings');
        for (const name of ['Guests', 'Agents']) {
          await page.getByRole('radiogroup', { name: 'Team settings' }).getByRole('radio', { name }).click();
          await page.waitForTimeout(400);
          await check(page, `team settings ${name}`);
          await hintsAreHints(page, `team settings ${name}`);
        }
        await page.goto(`${base}/feedback`);
        await page.locator('main').waitFor();
        await check(page, '/feedback');
        await context.close();
      });
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
