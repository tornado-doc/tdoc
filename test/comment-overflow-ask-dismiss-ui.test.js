// Two doc-page regressions, in the real shell against the real worker, for
// normal mode and dev mode (askEditV2), desktop 1280 and phone 390:
//   1. A long markdown reply (bold, a list, inline code like docs/<slug>/vN/,
//      a long unbroken path, a code block) never makes the comment card, its
//      thread or an Ask AI answer scroll sideways: scrollWidth <= clientWidth
//      for the card, its scrolling body, every reply and the Ask AI panel.
//   2. Ask AI on a desktop closes on a click outside it -- in the document
//      frame too, where the page's own listeners never see the press -- and on
//      Escape, like every other popover; a typed draft is still there when it
//      opens again. On a phone the drawer's backdrop already does this.
// Run with: node test/comment-overflow-ask-dismiss-ui.test.js

const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium } = requirePlaywrightOrSkip('comment-overflow-ask-dismiss-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const MODEL = 'https://model.invalid/v1';
const SLUG = 'overflow-plan';
const DOC = '<!doctype html><html><body><h1>Overflow plan</h1><p>Billing ships first, on March 14, because invoices block two renewals.</p><p>The mobile app waits for Q4.</p></body></html>';
const LONG = [
  '**Done.** I moved the versions under `docs/<slug>/vN/` and kept the old ones:',
  '',
  '- **Path**: `docs/overflow-plan/v12/assets/very-long-file-name-without-any-breaks-at-all.html`',
  '- **Also**: /Users/someone/work/tdoc/server/runtime/shell-runtime-0123456789abcdef0123456789abcdef.js',
  '- `a_really_long_identifier_name_that_never_breaks_anywhere_in_the_middle_of_it`',
  '',
  '```',
  'curl -sS https://tdoc.dev/api/runtime | jq -r .runtime.source_sha  # a long code line that must scroll inside its own box',
  '```',
].join('\n');

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

// Every element under `selector` that is wider inside than its own box and
// does not scroll on purpose (a code block's own overflow-x: auto may).
const sideways = (page, selector) => page.evaluate((sel) => {
  const out = [];
  for (const root of document.querySelectorAll(sel)) {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el.closest('.tdoc-md-pre')) continue;
      if (!el.clientWidth || el.scrollWidth <= el.clientWidth + 1) continue;
      const style = getComputedStyle(el);
      // Boxes that scroll or clip: those are what the reader drags (hidden
      // still scrolls, on focus or a find), so hidden content counts too.
      if (style.overflowX === 'visible') continue;
      const box = el.getBoundingClientRect();
      const wide = [...el.querySelectorAll('*')].filter((k) => k.getBoundingClientRect().right > box.right - 1).slice(0, 4)
        .map((k) => `${k.tagName.toLowerCase()}.${k.className}: ${k.textContent.slice(0, 40)} (+${Math.round(k.getBoundingClientRect().right - box.right)})`);
      out.push(`${el.className || el.tagName} ${el.scrollWidth}>${el.clientWidth} (overflow-x ${style.overflowX})${wide.length ? `; widest: ${wide.join(' | ')}` : ''}`);
    }
    const r = root.getBoundingClientRect();
    if (r.right > window.innerWidth + 1) out.push(`${root.className} sticks out of the screen (${Math.round(r.right)} > ${window.innerWidth})`);
  }
  return out;
}, selector);

(async () => {
  console.log('Comment cards never scroll sideways; Ask AI closes on an outside click (real shell)');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = typeof input === 'string' ? input : input.url;
    if (!String(u).startsWith(MODEL)) return realFetch(input, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: LONG } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
    return { ...data, sid, cookie, login };
  };
  const julie = await person('julie');
  const bob = await person('bob');
  const api = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`https://tdoc.dev${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: 'https://tdoc.dev' } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const up = await api('/api/upload', { method: 'POST', token: julie.token, body: { slug: SLUG, version: 1, html: DOC, meta: { title: 'Overflow plan' } } });
  if (up.status !== 200) throw new Error(`upload ${up.status}`);
  const c1 = await api('/api/comments', { method: 'POST', cookie: bob.cookie, body: { slug: SLUG, version: 1, text: 'Where do the versions live? `docs/overflow-plan/v12/assets/very-long-file-name-without-any-breaks-at-all.html`', anchor: { kind: 'text', text: 'Billing ships first' } } });
  if (c1.status !== 200) throw new Error(`comment ${c1.status}`);
  const reply = await api('/api/agent/reply', { method: 'POST', token: julie.token, body: { slug: SLUG, parent_id: c1.body.id, text: LONG, status: 'answered', agent_login: 'claude', agent_name: 'claude' } });
  if (reply.status !== 200) throw new Error(`reply ${reply.status} ${JSON.stringify(reply.body)}`);
  const human = await api('/api/comments', { method: 'POST', cookie: bob.cookie, body: { slug: SLUG, version: 1, parent_id: c1.body.id, text: 'And **this** one: `server/runtime/shell-runtime-0123456789abcdef0123456789abcdef0123456789.css`' } });
  if (human.status !== 200) throw new Error(`human reply ${human.status} ${JSON.stringify(human.body)}`);
  env.TDOC_DEBUG_ACCOUNTS = 'julie@tdoc.test';

  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/${name}` }); } };
  let failed = 0;
  const only = process.env.TDOC_TEST_ONLY ? new RegExp(process.env.TDOC_TEST_ONLY) : null;
  const t = async (name, fn) => { if (only && !only.test(name)) return; try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${String(error.message).split('\n').slice(0, 8).join('\n    ')}`); } };

  const open = async ({ width, dev }) => {
    const on = await api('/api/me/dev-mode', { method: 'POST', cookie: julie.cookie, body: { on: dev } });
    if (on.status !== 200) throw new Error(`dev mode ${dev} ${on.status}`);
    const phone = width < 700;
    const ctx = await browser.newContext(phone ? { viewport: { width, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width, height: 800 } });
    await ctx.addCookies([{ name: 'tdoc_sid', value: julie.sid, domain: '127.0.0.1', path: '/' }]);
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.goto(`${base}/d/${SLUG}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    const canSuggest = await page.evaluate(() => (window.__TDOC_SHELL__ || {}).canSuggest === true);
    if (canSuggest !== dev) throw new Error(`dev ${dev} but canSuggest ${canSuggest}`);
    return { ctx, page, phone };
  };

  try {
    for (const dev of [false, true]) {
      const mode = dev ? 'dev mode (V2)' : 'normal mode (V1)';
      const tag = dev ? 'v2' : 'v1';
      for (const width of [1280, 390]) {
        await t(`${mode}, ${width}: the open comment card and its replies never scroll sideways`, async () => {
          const { ctx, page, phone } = await open({ width, dev });
          if (phone) await page.locator('.tdoc-fab').click();
          else await page.locator(`.tdoc-pin[data-id="${c1.body.id}"]`).first().click({ force: true });
          const card = page.locator(`[data-comment-id="${c1.body.id}"]`).first();
          await card.waitFor({ timeout: 10000 });
          // The thread, open: its replies are what run long.
          const toggle = card.locator('.tdoc-replies-toggle').first();
          if (await toggle.count() && !(await toggle.getAttribute('class')).includes('open')) await toggle.click();
          await card.locator('.tdoc-md-code', { hasText: 'docs/<slug>/vN/' }).first().waitFor({ timeout: 10000 });
          await card.locator('.tdoc-md-code', { hasText: 'shell-runtime-0123456789abcdef0123456789abcdef0123456789.css' }).first().waitFor({ timeout: 10000 });
          await shot(page, `overflow-card-${tag}-${width}.png`);
          const bad = await sideways(page, phone ? '#tdoc-comment-layer .tdoc-drawer-list' : `[data-comment-id="${c1.body.id}"]`);
          if (bad.length) throw new Error(`sideways scroll:\n${bad.join('\n')}`);
          // The code block may scroll inside itself but stays within the card.
          const pre = await page.evaluate((id) => {
            const card = document.querySelector(`[data-comment-id="${id}"]`);
            const box = card.getBoundingClientRect();
            return [...card.querySelectorAll('.tdoc-md-pre')].map((p) => Math.round(p.getBoundingClientRect().right - box.right));
          }, c1.body.id);
          if (pre.some((d) => d > 1)) throw new Error(`code block sticks out of the card by ${pre.join(', ')}px`);
          if (page.errors.length) throw new Error(page.errors.join(' | '));
          await ctx.close();
        });
        await t(`${mode}, ${width}: a long Ask AI answer never scrolls sideways`, async () => {
          const { ctx, page, phone } = await open({ width, dev });
          let panel;
          if (phone) {
            const tabs = page.getByRole('radiogroup', { name: 'Comments or Ask AI' });
            if (!(await tabs.count())) await page.locator('.tdoc-fab').click();
            await page.getByRole('radiogroup', { name: 'Comments or Ask AI' }).getByRole('radio', { name: /Ask AI/ }).click();
            panel = page.locator('#tdoc-comment-layer .tdoc-ask-panel');
          } else {
            await page.locator('#tdoc-send-agent-btn').click();
            panel = page.getByRole('dialog', { name: 'Ask AI' });
          }
          await panel.waitFor();
          await panel.locator('textarea').first().fill('Where do the versions live?');
          await panel.locator('textarea').first().press('Enter');
          await page.locator('.tdoc-ask-answer .tdoc-md-code', { hasText: 'docs/<slug>/vN/' }).first().waitFor({ timeout: 10000 });
          await shot(page, `overflow-ask-${tag}-${width}.png`);
          const bad = await sideways(page, '.tdoc-ask-panel');
          if (bad.length) throw new Error(`sideways scroll:\n${bad.join('\n')}`);
          if (page.errors.length) throw new Error(page.errors.join(' | '));
          await ctx.close();
        });
      }
      await t(`${mode}, 1280: Ask AI closes on a click in the document and on Escape, and keeps the draft`, async () => {
        const { ctx, page } = await open({ width: 1280, dev });
        const panel = page.getByRole('dialog', { name: 'Ask AI' });
        await page.locator('#tdoc-send-agent-btn').click();
        await panel.waitFor();
        await panel.locator('textarea').first().fill('half a question');
        await shot(page, `ask-open-${tag}-1280.png`);
        // A click on the document itself: inside the frame.
        await page.frameLocator('iframe').locator('p').nth(1).click({ position: { x: 5, y: 5 } });
        await panel.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => { throw new Error('still open after a click in the document'); });
        await page.locator('#tdoc-send-agent-btn').click();
        await panel.waitFor();
        const kept = await panel.locator('textarea').first().inputValue();
        if (kept !== 'half a question') throw new Error(`draft after reopening: "${kept}"`);
        // A click on the page around the frame (the bar's title area).
        await page.mouse.click(10, 790);
        await panel.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => { throw new Error('still open after a click on the page'); });
        await page.locator('#tdoc-send-agent-btn').click();
        await panel.waitFor();
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => { throw new Error('still open after Escape'); });
        await page.locator('#tdoc-send-agent-btn').click();
        await panel.waitFor();
        const again = await panel.locator('textarea').first().inputValue();
        if (again !== 'half a question') throw new Error(`draft after Escape: "${again}"`);
        if (page.errors.length) throw new Error(page.errors.join(' | '));
        await ctx.close();
      });
      await t(`${mode}, 390: the Ask AI drawer closes on a tap outside it and keeps the draft`, async () => {
        const { ctx, page } = await open({ width: 390, dev });
        const unified = await page.getByRole('radiogroup', { name: 'Comments or Ask AI' }).count();
        let panel;
        const openAsk = async () => {
          if (await page.locator('#tdoc-send-agent-btn').count()) await page.locator('#tdoc-send-agent-btn').click();
          else {
            await page.locator('.tdoc-fab').click();
            await page.getByRole('radiogroup', { name: 'Comments or Ask AI' }).getByRole('radio', { name: /Ask AI/ }).click();
          }
          panel = page.locator('.tdoc-ask-panel').first();
          await panel.waitFor();
        };
        await openAsk();
        await panel.locator('textarea').first().fill('half a question');
        await page.mouse.click(195, 40);
        await panel.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => { throw new Error(`still open after a tap outside (unified entry: ${unified})`); });
        await openAsk();
        const kept = await panel.locator('textarea').first().inputValue();
        if (kept !== 'half a question') throw new Error(`draft after reopening: "${kept}"`);
        await ctx.close();
      });
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
