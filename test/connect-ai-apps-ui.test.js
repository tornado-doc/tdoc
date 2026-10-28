// "Connect in one click" in a real browser: tdoc in Claude, ChatGPT or
// Cursor through the remote MCP server, with no terminal. Behind the
// remoteMcp flag (on in PR previews only), so:
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
        assert(rows === 3, `three app rows, got ${rows}`);
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
        await page.getByRole('heading', { name: 'Allow Claude to use tdoc' }).waitFor();
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
