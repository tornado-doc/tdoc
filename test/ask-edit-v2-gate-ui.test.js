// Ask/Edit v2 is dev-mode only (askEditV2Allowed), in the real shell against
// the real worker. The owner of a doc, with tdoc AI available and an open
// comment on the doc:
//   not on the dev-mode list   desktop 1280 and phone 390: Ask AI is today's
//                              (one "Ask about this document" input, "Answers
//                              only · won't edit this document"), no Fix with
//                              AI on the comment, no Fix all, no review bar,
//                              and the page never calls a suggestions route.
//   flag pinned in the browser the same: the server leaves canSuggest out of
//                              the boot, so pinning askEditV2 changes nothing.
//   on the list, switch off    the same.
//   on the list, switch on     the control: the unified input
//                              are there (so the checks above can fail).
// Run with: node test/ask-edit-v2-gate-ui.test.js

const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium, devices } = requirePlaywrightOrSkip('ask-edit-v2-gate-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const MODEL = 'https://model.invalid/v1';
const SLUG = 'gate-plan';
const DOC = '<!doctype html><html><body><h1>Gate plan</h1><p>Billing ships first, on March 14, because invoices block two renewals.</p><p>The mobile app waits for Q4.</p></body></html>';

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

(async () => {
  console.log('Ask/Edit v2: dev mode only, nobody else sees a change (real shell)');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (!String(u).startsWith(MODEL)) return realFetch(input, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Invoices block two renewals.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', ASK_API_KEY: 'k', ASK_API_BASE: MODEL });
  let sidN = 0;
  const person = async (login) => {
    const sid = (++sidN).toString(16).padStart(32, 'a');
    await env.META.put(`session:${sid}`, JSON.stringify({ login, name: login, email: `${login}@tdoc.test`, avatar_url: '', created: new Date().toISOString() }));
    const cookie = `tdoc_sid=${sid}`;
    const r = await worker.fetch(new Request('https://tdoc.dev/api/hosted/token', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ label: login }) }), env, {});
    const data = await r.json();
    if (!data.token) throw new Error(`token for ${login}: ${r.status}`);
    return { ...data, cookie, login };
  };
  const julie = await person('julie');
  const bob = await person('bob');
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const up = await api('/api/upload', { method: 'POST', token: julie.token, body: { slug: SLUG, version: 1, html: DOC, meta: { title: 'Gate plan' } } });
  if (up.status !== 200) throw new Error(`upload ${up.status}`);
  const c1 = await api('/api/comments', { method: 'POST', cookie: bob.cookie, body: { slug: SLUG, version: 1, text: 'Say the date first', anchor: { kind: 'text', text: 'Billing ships first' } } });
  const c2 = await api('/api/comments', { method: 'POST', cookie: bob.cookie, body: { slug: SLUG, version: 1, text: 'Cut the mobile paragraph', anchor: { kind: 'text', text: 'The mobile app' } } });
  if (c1.status !== 200 || c2.status !== 200) throw new Error('comments');

  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  const DESKTOP = { viewport: { width: 1280, height: 800 } };
  const PHONE = { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, defaultBrowserType: undefined };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/${name}` }); } };
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };

  // The page as julie sees it; every request to a suggestions route noted.
  const look = async (opts, { phone = false, pin = false } = {}) => {
    const ctx = await browser.newContext(opts);
    await ctx.addCookies([{ name: 'tdoc_sid', value: julie.cookie.split('=')[1], domain: '127.0.0.1', path: '/' }]);
    if (pin) await ctx.addInitScript(() => { window.__TDOC_FLAGS__ = { ...(window.__TDOC_FLAGS__ || {}), askEditV2: true }; });
    const page = await ctx.newPage();
    const suggestCalls = [];
    page.on('request', (r) => { if (/\/api\/docs\/[^/]+\/suggest/.test(r.url())) suggestCalls.push(`${r.method()} ${r.url()}`); });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/d/${SLUG}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    // The comments, where this width shows them.
    if (phone) {
      await page.locator('.tdoc-fab').click();
      await page.locator('#tdoc-comment-layer .tdoc-drawer-tabs').waitFor();
    }
    // A desktop shows a pin in the margin; its card opens on a click.
    if (!phone) await page.locator(`.tdoc-pin[data-id="${c1.body.id}"]`).first().click({ force: true });
    await page.getByText('Say the date first').first().waitFor({ timeout: 10000 });
    const fix = await page.getByText('Fix with AI').count();
    const fixAll = await page.getByText(/Fix all \d+ with AI/).count();
    // Ask AI: the bar's button on a desktop, the drawer's tab on a phone.
    let panel;
    if (phone) {
      await page.getByRole('radiogroup', { name: 'Comments or Ask AI' }).getByRole('radio', { name: /Ask AI/ }).click();
      panel = page.locator('#tdoc-comment-layer .tdoc-ask-panel');
    } else {
      await page.locator('#tdoc-send-agent-btn').click();
      panel = page.getByRole('dialog', { name: 'Ask AI' });
    }
    await panel.waitFor();
    const input = await panel.locator('textarea').first().getAttribute('aria-label');
    const hint = (await panel.locator('.tdoc-ask-only-hint').innerText()).trim();
    const bar = await page.locator('.tdoc-suggest-bar').count();
    const canSuggest = await page.evaluate(() => (window.__TDOC_SHELL__ || {}).canSuggest);
    return { ctx, page, fix, fixAll, input, hint, bar, canSuggest, suggestCalls, errors };
  };
  const unchanged = (v, label) => {
    if (v.canSuggest !== undefined) throw new Error(`${label}: canSuggest in the boot (${v.canSuggest})`);
    if (v.fix || v.fixAll) throw new Error(`${label}: Fix with AI shown (${v.fix} / ${v.fixAll})`);
    if (v.input !== 'Ask about this document') throw new Error(`${label}: Ask input is "${v.input}"`);
    if (v.hint !== 'Answers only · won’t edit this document') throw new Error(`${label}: hint "${v.hint}"`);
    if (v.bar) throw new Error(`${label}: review bar shown`);
    if (v.suggestCalls.length) throw new Error(`${label}: called ${v.suggestCalls.join(', ')}`);
    if (v.errors.length) throw new Error(`${label}: page errors ${v.errors.join(' | ')}`);
  };

  try {
    await t('not on the dev-mode list, desktop: Ask AI and comments exactly as before, no suggestions request', async () => {
      const v = await look(DESKTOP);
      await shot(v.page, 'gate-nondev-1280.png');
      unchanged(v, 'desktop');
      await v.ctx.close();
    });
    await t('not on the dev-mode list, phone: the drawer exactly as before', async () => {
      const v = await look(PHONE, { phone: true });
      await shot(v.page, 'gate-nondev-390.png');
      unchanged(v, 'phone');
      await v.ctx.close();
    });
    await t('not on the list, askEditV2 pinned in the browser: still nothing (the server decides)', async () => {
      const v = await look(DESKTOP, { pin: true });
      unchanged(v, 'pinned');
      await v.ctx.close();
    });
    env.TDOC_DEBUG_ACCOUNTS = 'julie@tdoc.test';
    await t('on the list with dev mode switched off: still nothing', async () => {
      const off = await api('/api/me/dev-mode', { method: 'POST', cookie: julie.cookie, body: { on: false } });
      if (off.status !== 200) throw new Error(`dev mode off ${off.status}`);
      const v = await look(DESKTOP);
      unchanged(v, 'switched off');
      await v.ctx.close();
    });
    await t('control: on the list with dev mode on, the unified input is there, and Fix with AI is gone for good', async () => {
      const on = await api('/api/me/dev-mode', { method: 'POST', cookie: julie.cookie, body: { on: true } });
      if (on.status !== 200) throw new Error(`dev mode on ${on.status}`);
      const v = await look(DESKTOP);
      await shot(v.page, 'gate-dev-1280.png');
      if (v.canSuggest !== true) throw new Error(`canSuggest ${v.canSuggest}`);
      if (v.fix || v.fixAll) throw new Error(`Fix with AI is back for a dev-mode owner (${v.fix} / ${v.fixAll})`);
      if (v.input === 'Ask about this document') throw new Error('Ask input not unified');
      if (v.errors.length) throw new Error(v.errors.join(' | '));
      await v.ctx.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
