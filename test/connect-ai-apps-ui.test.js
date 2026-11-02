// "Connect in one click" in a real browser: tdoc in Claude, ChatGPT or
// Cursor through the remote MCP server, with no terminal. Behind the
// remoteMcp flag (on by default; a page can still pin it off), so:
//   - flag off: /start, /setup and Settings look exactly as before
//   - flag on: /start shows a strip that opens the panel; /setup and
//     Settings -> Agents show it inline. Claude opens the prefilled custom
//     connector link for this host's /mcp, Cursor its install deeplink,
//     ChatGPT its Plugins page; the server URL and the CLI line are there.
//   - the OAuth consent page an app sends you to: names the app and the
//     return host, Allow lands back at the app with a code.
// Real worker routes (in-process harness) behind a local HTTP server, real
// built shell runtime, desktop and phone widths.
// TDOC_SHOT_DIR=<dir> keeps screenshots for review.
//
// Run with: node test/connect-ai-apps-ui.test.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, req, putSession } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium } = requirePlaywrightOrSkip('connect-ai-apps-ui.test.js');
const SHOTS = process.env.TDOC_SHOT_DIR || '';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (inReq, res) => {
    const pathname = inReq.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) {
      res.setHeader('content-type', asset.type);
      return res.end(fs.readFileSync(asset.file));
    }
    const chunks = [];
    for await (const c of inReq) chunks.push(c);
    const headers = { ...inReq.headers, host: 'tdoc.dev' };
    if (headers.origin) headers.origin = 'https://tdoc.dev';
    const response = await worker.fetch(new Request(`https://tdoc.dev${inReq.url}`, {
      method: inReq.method,
      headers,
      body: chunks.length && !['GET', 'HEAD'].includes(inReq.method) ? Buffer.concat(chunks) : undefined,
      redirect: 'manual',
    }), env, { waitUntil() {}, passThroughOnException() {} });
    const type = response.headers.get('content-type') || '';
    let body = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) {
      body = Buffer.from(body.toString('utf8')
        .replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path)
        .replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    }
    response.headers.forEach((value, key) => {
      if (!['content-length', 'content-encoding', 'content-security-policy', 'set-cookie'].includes(key)) res.setHeader(key, value);
    });
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  console.log('Connect AI apps UI (remoteMcp flag, /start, /setup, Settings, consent page)');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { TDOC_REMOTE_MCP: '1', TDOC_UPLOAD_TOKEN: 'admin-secret' });
  const call = async (p, opts) => {
    const r = await worker.fetch(req(p, opts), env, { waitUntil() {}, passThroughOnException() {} });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  // /start is a published doc: ship the tutorial as the provider would.
  const startDir = path.join(__dirname, '..', 'landing', 'tdoc-start');
  const startMeta = JSON.parse(fs.readFileSync(path.join(startDir, 'meta.json'), 'utf8'));
  const latest = startMeta.versions[startMeta.versions.length - 1].n;
  const startHtml = fs.readFileSync(path.join(startDir, `v${latest}`, 'index.html'), 'utf8');
  const shipped = await call('/api/upload', { method: 'POST', token: 'admin-secret', body: { slug: 'tdoc-start', version: 1, html: startHtml, meta: { title: startMeta.title || 'Start', versions: [{ n: 1, created: new Date().toISOString() }], access: { visibility: 'public' } } } });
  assert(shipped.status === 200, `ship /start: ${shipped.status} ${shipped.text}`);
  // The homepage too: its hero "Use tdoc in" picker.
  const homeDir = path.join(__dirname, '..', 'landing', 'tornado-doc');
  const homeMeta = JSON.parse(fs.readFileSync(path.join(homeDir, 'meta.json'), 'utf8'));
  const homeLatest = homeMeta.versions[homeMeta.versions.length - 1].n;
  const homeHtml = fs.readFileSync(path.join(homeDir, `v${homeLatest}`, 'index.html'), 'utf8').replace(new RegExp(`/d/tornado-doc/v/${homeLatest}/widget/`, 'g'), '/d/tornado-doc/v/1/widget/');
  const home = await call('/api/upload', { method: 'POST', token: 'admin-secret', body: { slug: 'tornado-doc', version: 1, html: homeHtml, meta: { title: homeMeta.title, versions: [{ n: 1, created: new Date().toISOString() }], access: { visibility: 'public' } } } });
  assert(home.status === 200, `ship homepage: ${home.status} ${home.text}`);
  // A document of anybody's with a quick-send button: the shell must ignore it.
  const probeHtml = '<!doctype html><html><head><title>Send probe</title></head><body><main><p id="p">pwn my agent</p><button id="send" type="button" data-tdoc-send="codex" data-tdoc-send-text="#p">Send</button></main></body></html>';
  const sendProbe = await call('/api/upload', { method: 'POST', token: 'admin-secret', body: { slug: 'send-probe', version: 1, html: probeHtml, meta: { title: 'Send probe', versions: [{ n: 1, created: new Date().toISOString() }], access: { visibility: 'public' } } } });
  assert(sendProbe.status === 200, `ship send probe: ${sendProbe.status} ${sendProbe.text}`);
  const cookie = await putSession(env, 'julie');
  await call('/api/hosted/token', { method: 'POST', cookie, body: { label: 'setup' } });

  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  const widths = [['desktop', 1280, 860], ['phone', 390, 844]];
  // Somebody who has not connected anything yet: /setup still asks.
  const newcomer = await putSession(env, 'newbie');
  const open = async (width, height, { flag, signedIn = true, as = cookie } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    if (signedIn) await context.addCookies([{ name: 'tdoc_sid', value: as.split('=')[1], url: base }]);
    await context.addInitScript((pinned) => {
      if (pinned !== null) window.__TDOC_FLAGS__ = { remoteMcp: pinned };
      window.__opened = [];
      window.open = (href) => { window.__opened.push(String(href)); return null; };
      window.__appOpened = [];
      window.__tdocOpenApp = (href) => { window.__appOpened.push(String(href)); };
    }, flag === undefined ? null : flag);
    const page = await context.newPage();
    return { context, page };
  };
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }); };

  try {
    for (const [label, width, height] of widths) {
      await t(`${label}: flag off, /start, /setup and Settings show no connect panel`, async () => {
        const { context, page } = await open(width, height, { flag: false, as: newcomer });
        await page.goto(`${base}/start`);
        await page.waitForSelector('iframe.tdoc-doc-frame');
        assert(await page.locator('.tdoc-connect-strip').count() === 0, 'strip on /start');
        await page.goto(`${base}/setup`);
        await page.waitForSelector('.sg-h1');
        assert(await page.locator('[data-testid="connect-ai-apps"]').count() === 0, 'panel on /setup');
        await page.goto(`${base}/me?view=settings#agents`);
        await page.waitForSelector('#agent-access');
        assert(await page.locator('[data-testid="connect-ai-apps"]').count() === 0, 'panel in Settings');
        await context.close();
      });

      await t(`${label}: flag on, /start strip opens the panel; Claude, Cursor and ChatGPT open the right links`, async () => {
        const { context, page } = await open(width, height, { flag: true, signedIn: false });
        await page.goto(`${base}/start`);
        const strip = page.locator('.tdoc-connect-strip');
        await strip.waitFor();
        await shot(page, `${label}-start-strip`);
        await strip.getByRole('button', { name: 'Connect in one click' }).click();
        const dialog = page.getByRole('dialog', { name: 'Connect in one click' });
        await dialog.waitFor();
        await shot(page, `${label}-start-dialog`);
        const box = await dialog.boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width + 1, `dialog fits the width: ${JSON.stringify(box)}`);
        await dialog.getByRole('button', { name: 'Connect Claude' }).click();
        await dialog.getByRole('button', { name: 'Open ChatGPT' }).click();
        const opened = await page.evaluate(() => window.__opened);
        const claude = new URL(opened[0]);
        assert(claude.origin === 'https://claude.ai' && claude.pathname === '/customize/connectors', opened[0]);
        assert(claude.searchParams.get('modal') === 'add-custom-connector' && claude.searchParams.get('connectorName') === 'tdoc', opened[0]);
        assert(claude.searchParams.get('connectorUrl') === `${base}/mcp`, `connector URL is this host's /mcp: ${claude.searchParams.get('connectorUrl')}`);
        assert(opened[1] === 'https://chatgpt.com/plugins', opened[1]);
        assert((await dialog.locator('.ui-code-block code').innerText()).trim() === `${base}/mcp`, 'server URL shown');
        assert(await dialog.getByRole('button', { name: 'Copy the line' }).count() === 1, 'CLI fallback');
        // Cursor hands off to the app by scheme; catch the navigation.
        const cursorHref = await page.evaluate(() => {
          let seen = '';
          const desc = Object.getOwnPropertyDescriptor(window.Location.prototype, 'href');
          try {
            Object.defineProperty(window.location, 'href', { configurable: true, set(v) { seen = String(v); }, get() { return desc.get.call(window.location); } });
          } catch { return 'unpatchable'; }
          [...document.querySelectorAll('[data-app="cursor"]')].pop().click();
          return seen;
        });
        if (cursorHref !== 'unpatchable') {
          const u = new URL(cursorHref);
          assert(u.protocol === 'cursor:' && u.searchParams.get('name') === 'tdoc', cursorHref);
          assert(JSON.parse(Buffer.from(u.searchParams.get('config'), 'base64').toString()).url === `${base}/mcp`, 'cursor config');
        }
        await context.close();
      });

      await t(`${label}: flag at its default, signed out: /start shows the strip, ?connect=<app> opens the panel on that app`, async () => {
        const { context, page } = await open(width, height, { signedIn: false });
        await page.goto(`${base}/start`);
        await page.locator('.tdoc-connect-strip').waitFor();
        assert(await page.getByRole('dialog').count() === 0, 'dialog open without ?connect');
        // The tutorial's Before you start box sends the chat apps to the same panel.
        const before = page.frameLocator('iframe.tdoc-doc-frame').locator('.before');
        assert(!/ChatGPT chat/.test(await before.innerText()), 'Before you start still says the chats are unsupported');
        await before.scrollIntoViewIfNeeded();
        await shot(page, `${label}-start-before`);
        await before.getByRole('link', { name: 'Connect in one click' }).click();
        await page.getByRole('dialog', { name: 'Connect in one click' }).waitFor();
        await page.goto(`${base}/start`);
        await page.locator('.tdoc-connect-strip').waitFor();
        await page.goto(`${base}/start?connect=vscode`);
        const dialog = page.getByRole('dialog', { name: 'Connect in one click' });
        await dialog.waitFor();
        await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-app') === 'vscode');
        await shot(page, `${label}-start-connect-vscode`);
        const vscodeHref = await page.evaluate(() => {
          let seen = '';
          const desc = Object.getOwnPropertyDescriptor(window.Location.prototype, 'href');
          try {
            Object.defineProperty(window.location, 'href', { configurable: true, set(v) { seen = String(v); }, get() { return desc.get.call(window.location); } });
          } catch { return 'unpatchable'; }
          document.querySelector('.tdoc-connect-dialog [data-app="vscode"]').click();
          return seen;
        });
        if (vscodeHref !== 'unpatchable') {
          assert(vscodeHref.startsWith('vscode:mcp/install?'), vscodeHref);
          const cfg = JSON.parse(decodeURIComponent(vscodeHref.slice('vscode:mcp/install?'.length)));
          assert(cfg.name === 'tdoc' && cfg.type === 'http' && cfg.url === `${base}/mcp`, JSON.stringify(cfg));
        }
        // An app with no button of its own lands on the server URL.
        await page.goto(`${base}/start?connect=codex`);
        await page.getByRole('dialog', { name: 'Connect in one click' }).waitFor();
        assert(/Codex, Gemini CLI/.test(await page.locator('.tdoc-connect-dialog [data-app="other"]').innerText()), 'codex lands on the URL block');
        await context.close();
      });

      await t(`${label}: homepage connect card: prompt + Copy, quick connect, each app in its own popover`, async () => {
        const { context, page } = await open(width, height, { signedIn: false });
        await page.goto(`${base}/`);
        const frame = page.frameLocator('iframe.tdoc-doc-frame');
        const pick = frame.locator('.pick');
        await pick.locator('.pick-quick .pick-pill').first().waitFor();
        await shot(page, `${label}-home`);
        await pick.scrollIntoViewIfNeeded();
        assert((await pick.locator('#pick-prompt').innerText()).trim() === 'set up https://tdoc.dev/SKILL.md', 'setup prompt');
        const quick = await pick.locator('.pick-quick .pick-pill').evaluateAll((els) => els.map((l) => l.textContent.replace(/\u2197/g, '').trim()));
        assert(JSON.stringify(quick) === JSON.stringify(['Claude Code', 'Codex', 'Cursor', 'Claude.ai', 'ChatGPT', 'More']), JSON.stringify(quick));
        if (width > 560) {
          const rows = await pick.locator('.pick-quick > *').evaluateAll((els) => new Set(els.map((e) => { const r = e.getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2 / 10); })).size);
          assert(rows === 1, `quick connect wraps onto ${rows} lines at ${label}`);
        }
        const card = await pick.boundingBox();
        assert(card && card.x >= 0 && card.x + card.width <= width + 1, `card inside the page at ${label}: ${JSON.stringify(card)}`);
        for (const l of await pick.locator('.pick-quick .pick-pill').all()) {
          const b = await l.boundingBox();
          assert(b && b.x >= 0 && b.x + b.width <= width + 1, `button inside the page at ${label}: ${JSON.stringify(b)}`);
        }
        // Copy shows the done mark, then the icon button comes back empty (its icon is a background).
        const copy = pick.locator('.pick-promptcopy');
        await copy.click();
        assert((await copy.innerText()).trim() === '\u2713', `copy done mark: ${await copy.innerText()}`);
        await page.waitForTimeout(1800);
        assert((await copy.innerText()).trim() === '', `copy button text after: ${await copy.innerText()}`);
        if (SHOTS) await pick.screenshot({ path: path.join(SHOTS, `${label}-home-pick.png`) });
        // Quick send: Codex, Cursor, Claude.ai and ChatGPT copy the prompt and hand it to the app, filled in.
        const prompt = encodeURIComponent('set up https://tdoc.dev/SKILL.md');
        for (const [label2, href] of [['Codex', `codex://new?prompt=${prompt}`], ['Cursor', `cursor://anysphere.cursor-deeplink/prompt?text=${prompt}`], ['Claude.ai', `https://claude.ai/new?q=${prompt}`], ['ChatGPT', `https://chatgpt.com/?q=${prompt}`]]) {
          await pick.locator('.pick-quick .pick-pill', { hasText: label2 }).click();
          await page.waitForFunction((h) => window.__appOpened.includes(h), href);
          await page.getByText(/Prompt copied\. Opening (Codex|Cursor|Claude|ChatGPT)/).first().waitFor();
        }
        if (SHOTS) await shot(page, `${label}-home-quick-send`);
        const openPops = async () => pick.locator('.pick-pop:popover-open').evaluateAll((els) => els.map((e) => e.id));
        assert(JSON.stringify(await openPops()) === '[]', `a popover is open before any click: ${await openPops()}`);
        const expect = {
          claudecode: 'claude plugin marketplace add tornado-doc/tdoc && claude plugin install tdoc@tornado-tdoc',
          codex: 'codex plugin marketplace add tornado-doc/tdoc && codex plugin add tdoc@tornado-tdoc',
          cursor: 'https://cursor.com/en/install-mcp?', claude: 'https://claude.ai/customize/connectors?',
          chatgpt: 'https://tdoc.dev/mcp', grok: 'https://grok.com/connectors', vscode: 'https://vscode.dev/redirect/mcp/install?',
          gemini: 'gemini mcp add --scope user --transport http tdoc https://tdoc.dev/mcp',
          grokbot: 'Connect the tdoc MCP server: https://tdoc.dev/mcp',
        };
        const inMore = ['chatgpt', 'grok', 'vscode', 'gemini', 'grokbot', 'claude', 'cursor', 'codex'];
        for (const [app, needle] of Object.entries(expect)) {
          if (inMore.includes(app)) {
            await pick.locator('.pick-quick .pick-more').click();
            assert(JSON.stringify(await openPops()) === '["pick-pop-more"]', `More: ${await openPops()}`);
            if (app === 'chatgpt') {
              assert(await pick.locator('#pick-pop-more').getByRole('link', { name: /Add a webhook/ }).getAttribute('href') === '/me?view=settings#agents', 'bot line in More');
              await shot(page, `${label}-home-pop-more`);
            }
            await pick.locator(`#pick-pop-more .pick-pill[popovertarget="pick-pop-${app}"]`).click();
          } else {
            await pick.locator(`.pick-quick .pick-pill[popovertarget="pick-pop-${app}"]`).click();
          }
          // Opened from More, the app's popover stacks on top of the list; closing it goes back to the list.
          const want = inMore.includes(app) ? [`pick-pop-${app}`, 'pick-pop-more'] : [`pick-pop-${app}`];
          assert(JSON.stringify((await openPops()).sort()) === JSON.stringify(want.sort()), `${app}: ${JSON.stringify(await openPops())}`);
          const pop = pick.locator(`#pick-pop-${app}`);
          const text = await pop.evaluate((el) => [...el.querySelectorAll('a.pick-go')].map((a) => a.getAttribute('href')).concat([...el.querySelectorAll('code')].map((c) => c.textContent)).join(' '));
          assert(text.includes(needle), `${app}: ${text}`);
          for (const a of await pop.locator('a.pick-go').all()) assert(/^https:\/\//.test(await a.getAttribute('href')), `${app} link is https`);
          const box = await pop.boundingBox();
          assert(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= height + 1, `${app} popover on screen at ${label}: ${JSON.stringify(box)}`);
          if (app === 'claudecode') await shot(page, `${label}-home-pop-${app}`);
          if (app === 'gemini') await page.keyboard.press('Escape');
          else await pop.locator('.pick-close').click();
          if (inMore.includes(app)) {
            assert(JSON.stringify(await openPops()) === '["pick-pop-more"]', `${app}: closing did not go back to More: ${await openPops()}`);
            await pick.locator('#pick-pop-more .pick-close').click();
          }
          assert(JSON.stringify(await openPops()) === '[]', `${app}: still open ${await openPops()}`);
        }
        await context.close();
      });

      await t(`${label}: a published document cannot use quick send (site pages only)`, async () => {
        const { context, page } = await open(width, height, { signedIn: false });
        await page.goto(`${base}/d/send-probe`);
        const frame = page.frameLocator('iframe.tdoc-doc-frame');
        await frame.locator('#send').click();
        await page.waitForTimeout(500);
        const opened = await page.evaluate(() => window.__appOpened);
        assert(JSON.stringify(opened) === '[]', `a document opened an app: ${JSON.stringify(opened)}`);
        assert(await page.getByText(/Opening Codex/).count() === 0, 'toast shown for a document');
        await context.close();
      });

      await t(`${label}: flag on, /setup and Settings -> Agents show the panel inline`, async () => {
        const { context, page } = await open(width, height, { flag: true, as: newcomer });
        await page.goto(`${base}/setup`);
        const panel = page.locator('[data-testid="connect-ai-apps"]');
        await panel.waitFor();
        assert(await page.getByRole('heading', { name: 'No terminal? Connect in one click' }).count() === 1, 'setup heading');
        await panel.scrollIntoViewIfNeeded();
        await shot(page, `${label}-setup`);
        await page.goto(`${base}/me?view=settings#agents`);
        const settings = page.locator('[data-testid="connect-ai-apps"]');
        await settings.waitFor();
        await settings.scrollIntoViewIfNeeded();
        await shot(page, `${label}-settings`);
        const rows = await settings.locator('.tdoc-connect-app').count();
        assert(rows === 4, `four app rows (Claude, ChatGPT, Cursor, VS Code), got ${rows}`);
        for (const btn of await settings.locator('.tdoc-connect-app .ui-btn').all()) {
          const b = await btn.boundingBox();
          assert(b && b.x + b.width <= width + 1, `button inside the page at ${label}`);
        }
        await context.close();
      });

      await t(`${label}: the consent page names the app and return host; Allow returns a code to the app`, async () => {
        const client = (await call('/oauth/register', { method: 'POST', body: { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' } })).body;
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'abc', scope: 'mcp' });
        const { context, page } = await open(width, height, {});
        let landed = '';
        await context.route('https://claude.ai/**', (route) => { landed = route.request().url(); route.fulfill({ status: 200, body: 'ok' }); });
        await page.goto(`${base}/oauth/authorize?${q}`);
        await page.getByRole('heading', { name: 'Allow Claude (claude.ai) to use tdoc' }).waitFor();
        assert(/claude\.ai/.test(await page.locator('.tdoc-oauth-return').innerText()), 'return host named');
        await shot(page, `${label}-consent`);
        await page.getByRole('button', { name: 'Allow' }).click();
        await page.waitForURL((u) => u.hostname === 'claude.ai');
        const u = new URL(landed);
        assert(u.searchParams.get('code') && u.searchParams.get('state') === 'abc' && u.searchParams.get('iss') === 'https://tdoc.dev', landed);
        await context.close();
      });
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
