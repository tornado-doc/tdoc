// The feedback connect popup when signing in cuts it off from the app
// (owner report, app.hustlefree.ai, 2026-11-01: a comment left through the
// widget never arrived).
//
// Signing in takes the popup through pages that send
// Cross-Origin-Opener-Policy: same-origin. The browser then moves the popup
// into a new browsing context group: window.opener is null in the popup for
// good, and popup.closed reads true in the app while the person is still
// signing in. The app used to give up there, and the comment in hand was
// lost. Here the real worker (in-process harness) serves tdoc on one origin,
// an "identity provider" on another sends COOP: same-origin, and the app is
// a third. Checked:
//   - the hypothesis itself: after the sign-in round trip the popup has no
//     opener, and the app reads it as closed while it is still open;
//   - the comment written before connecting posts once the person clicks
//     Connect, collected through the claim (no postMessage possible);
//   - a blocked popup keeps the comment and posts it after Connect tdoc;
//   - cancelling keeps it too; retrying posts it.
// TDOC_UI_SHOTS=<dir> saves screenshots (1440 and 390).
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, putSession } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('feedback-connect-coop-ui.test.js');

const SHOTS = process.env.TDOC_UI_SHOTS || '';
const ROOT = path.join(__dirname, '..');

const APP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Acme dashboard</title>
<style>body{font:16px system-ui;margin:0}main{max-width:640px;margin:80px auto 40px;padding:0 24px}.card{border:1px solid #ddd;border-radius:8px;padding:16px;margin:0 0 12px}button{background:#111;color:#fff;border:0;padding:8px 14px;border-radius:6px}</style>
</head><body><main>
<section class="card"><h2>Weekly active users</h2><p>1,284 · +12%</p></section>
<section class="card"><h2>Invite teammates</h2><button id="invite">Send invite</button></section>
</main></body></html>`;

function listen(handler, port) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

(async () => {
  console.log('Feedback connect: popup cut off by COOP while signing in');
  const mod = await loadWorker();
  const worker = mod.default;
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const feedbackJs = fs.readFileSync(path.join(ROOT, 'server/runtime/feedback.js'));
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); }
  };
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  const tdocPort = await reservePort();
  const idpPort = await reservePort();
  const appPort = await reservePort();
  // Three origins: tdoc on localhost, the app and the provider on 127.0.0.1.
  const tdocBase = `http://localhost:${tdocPort}`;
  const idpBase = `http://127.0.0.1:${idpPort}`;
  const appBase = `http://127.0.0.1:${appPort}`;
  let env = null;

  const tdoc = await listen(async (request, res) => {
    const url = new URL(request.url, tdocBase);
    if (url.pathname === '/feedback.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.setHeader('access-control-allow-origin', '*');
      return res.end(feedbackJs);
    }
    const asset = byPath.get(url.pathname);
    if (asset) { res.setHeader('content-type', asset.type); return res.end(fs.readFileSync(asset.file)); }
    // Sign-in: off to the provider (which sends COOP), and back signed in.
    if (url.pathname === '/api/auth/web/login') {
      res.writeHead(302, { location: `${idpBase}/sign-in?return=${encodeURIComponent(url.searchParams.get('return') || '/')}` });
      return res.end();
    }
    if (url.pathname === '/__test/signin') {
      const cookie = await putSession(env, 'julie');
      res.writeHead(302, { location: url.searchParams.get('return') || '/', 'set-cookie': `${cookie}; Path=/; HttpOnly; SameSite=Lax` });
      return res.end();
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const headers = { ...request.headers, host: 'tdoc.dev' };
    // The worker sees its own pages as https://tdoc.dev; the app keeps its own Origin.
    if (headers.origin === tdocBase) headers.origin = 'https://tdoc.dev';
    delete headers.referer;
    const response = await worker.fetch(new Request(`https://tdoc.dev${request.url}`, {
      method: request.method, headers, redirect: 'manual',
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks),
    }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let body = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) {
      body = Buffer.from(body.toString('utf8')
        .replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path)
        .replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    }
    response.headers.forEach((value, key) => {
      if (['content-length', 'content-encoding', 'content-security-policy', 'set-cookie'].includes(key)) return;
      res.setHeader(key, key === 'location' ? value.replace('https://tdoc.dev', '') : value);
    });
    const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    // http://localhost is a secure context to the browser, so the worker's
    // Secure (and __Host-) cookies are kept as they are.
    if (cookies.length) res.setHeader('set-cookie', cookies);
    res.statusCode = response.status;
    res.end(body);
  }, tdocPort);

  // The provider's sign-in page: COOP same-origin, like the real one.
  const idp = await listen((request, res) => {
    const url = new URL(request.url, idpBase);
    const back = `${tdocBase}/__test/signin?return=${encodeURIComponent(url.searchParams.get('return') || '/')}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cross-origin-opener-policy': 'same-origin' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Sign in</title><h1>Sign in</h1><a id="continue" href="${back}">Continue</a>`);
  }, idpPort);

  const app = await listen((request, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cross-origin-opener-policy': 'same-origin-allow-popups' });
    res.end(APP_HTML);
  }, appPort);

  const browser = await chromium.launch({ headless: true });
  const storageKey = `tdoc-feedback:${tdocBase}`;
  const fb = (page, selector) => page.locator(`#tdoc-feedback-root ${selector}`);
  const comments = async () => {
    const all = [];
    for (const key of [...env.META.map.keys()].filter((k) => k.startsWith('meta:'))) {
      const slug = key.slice(5);
      const meta = JSON.parse(await env.META.get(key));
      if (meta.created_from !== 'feedback') continue;
      const r = await worker.fetch(new Request(`https://tdoc.dev/api/comments?slug=${slug}&version=1`, { headers: { cookie: await putSession(env, 'julie') } }), env, {});
      const body = await r.json();
      all.push(...(body.comments || body || []));
    }
    return all.filter((c) => c && !c.deleted);
  };

  // Load the client, with window.open failing until the test lets it.
  const start = async (width, { signedIn = false } = {}) => {
    env = makeEnv(mod.CommentsStore, { GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret' });
    const context = await browser.newContext({ viewport: { width, height: 860 } });
    if (signedIn) {
      const cookie = await putSession(env, 'julie');
      await context.addCookies([{ name: 'tdoc_sid', value: cookie.split('=')[1], url: tdocBase }]);
    }
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${appBase}/dashboard`);
    await page.evaluate(() => { window.__realOpen = window.open; window.open = () => null; });
    await page.addScriptTag({ url: `${tdocBase}/feedback.js` });
    await page.waitForFunction(() => window.tdocFeedback && window.tdocFeedback.base);
    // The bookmark: shows the overlay; connecting is blocked this once.
    await page.evaluate(() => window.tdocFeedback.open());
    await fb(page, '.tdoc-feedback-notice').waitFor();
    await page.evaluate(() => { window.open = window.__realOpen; });
    await fb(page, '.tdoc-feedback-notice button.x').click();
    return { context, page, errors };
  };
  const compose = async (page, text) => {
    await fb(page, '.tdoc-feedback-dock button.primary').click();
    await page.locator('#invite').click({ force: true });
    const field = fb(page, '.tdoc-popup textarea');
    await field.waitFor();
    await field.fill(text);
  };
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

  try {
    for (const width of [1440, 390]) {
      await t(`${width}px: signing in through a COOP page cuts the popup off; the comment still posts`, async () => {
        const { context, page, errors } = await start(width);
        try {
          await compose(page, 'The invite button does nothing');
          const [popup] = await Promise.all([context.waitForEvent('page'), fb(page, '.tdoc-popup button.submit').click()]);
          await popup.waitForLoadState();
          assert(popup.url().startsWith(`${tdocBase}/feedback/connect?origin=${encodeURIComponent(appBase)}`), popup.url());
          await popup.getByRole('link', { name: 'Sign in with GitHub' }).click();
          await popup.waitForURL(`${idpBase}/**`);
          // The hypothesis: the popup is still open, yet the app reads it as
          // closed (the waiting line shows only once popup.closed is true).
          const waiting = fb(page, '.tdoc-feedback-waiting');
          await waiting.waitFor({ timeout: 5000 });
          assert.match(await waiting.innerText(), /Finish signing in in the tdoc window/);
          assert.equal(await fb(page, '.tdoc-popup textarea').inputValue(), 'The invite button does nothing', 'composer lost the text while connecting');
          await shot(page, `coop-${width}-waiting`);
          await popup.locator('#continue').click();
          await popup.waitForURL(`${tdocBase}/feedback/connect?**`);
          assert.equal(await popup.evaluate(() => window.opener), null, 'expected the COOP page to have severed window.opener');
          assert.equal(popup.isClosed(), false);
          await popup.locator('#connect').click();
          await popup.getByText(/Connected\. Go back to/).waitFor({ timeout: 5000 });
          await fb(page, '.tdoc-pin').first().waitFor({ timeout: 8000 });
          assert.equal(await fb(page, '.tdoc-popup textarea').count(), 0, 'composer still open after posting');
          const posted = await comments();
          assert.equal(posted.length, 1, `comments: ${JSON.stringify(posted)}`);
          assert.equal(posted[0].text, 'The invite button does nothing');
          assert.equal(posted[0].anchor.selector, '#invite');
          const stored = await page.evaluate((key) => ({ s: JSON.parse(localStorage.getItem(key) || 'null'), d: sessionStorage.getItem(`${key}:draft`) }), storageKey);
          assert(stored.s && /^fb_/.test(stored.s.token), 'no stored session');
          assert.equal(stored.d, null, 'draft not cleared after posting');
          await shot(page, `coop-${width}-posted`);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }

    await t('a blocked popup keeps the comment; Connect tdoc posts it', async () => {
      const { context, page } = await start(1440, { signedIn: true });
      try {
        await compose(page, 'Blocked, then posted');
        await page.evaluate(() => { window.open = () => null; });
        await fb(page, '.tdoc-popup button.submit').click();
        const notice = fb(page, '.tdoc-feedback-notice');
        await notice.waitFor();
        assert.match(await notice.innerText(), /blocked[\s\S]*Your comment is kept/);
        assert.equal(await fb(page, '.tdoc-popup textarea').inputValue(), 'Blocked, then posted');
        const draft = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(`${key}:draft`)), storageKey);
        assert.equal(draft.text, 'Blocked, then posted');
        assert.equal(draft.anchor.selector, '#invite');
        await page.evaluate(() => { window.open = window.__realOpen; });
        const [popup] = await Promise.all([context.waitForEvent('page'), notice.locator('button.submit').click()]);
        await popup.locator('#connect').click();
        await fb(page, '.tdoc-pin').first().waitFor({ timeout: 8000 });
        assert.equal(await fb(page, '.tdoc-popup textarea').count(), 0, 'composer still open');
        const posted = await comments();
        assert.equal(posted.length, 1, `comments: ${posted.length}`);
        assert.equal(posted[0].text, 'Blocked, then posted');
      } finally { await context.close(); }
    });

    await t('cancelling the wait keeps the comment; retrying posts it once', async () => {
      const { context, page } = await start(1440);
      try {
        await compose(page, 'Cancelled, then posted');
        const [popup] = await Promise.all([context.waitForEvent('page'), fb(page, '.tdoc-popup button.submit').click()]);
        await popup.getByRole('link', { name: 'Sign in with GitHub' }).click();
        await popup.waitForURL(`${idpBase}/**`);
        await fb(page, '.tdoc-feedback-waiting').waitFor({ timeout: 5000 });
        await fb(page, '.tdoc-feedback-waiting').getByRole('button', { name: 'Cancel' }).click();
        const notice = fb(page, '.tdoc-feedback-notice');
        await notice.waitFor();
        assert.match(await notice.innerText(), /Not connected\. Your comment is kept/);
        assert.equal(await fb(page, '.tdoc-popup textarea').inputValue(), 'Cancelled, then posted');
        // Finish signing in in that window anyway, then retry from the app.
        await popup.locator('#continue').click();
        await popup.waitForURL(`${tdocBase}/feedback/connect?**`);
        await popup.close();
        const [again] = await Promise.all([context.waitForEvent('page'), notice.locator('button.submit').click()]);
        await again.locator('#connect').click();
        await fb(page, '.tdoc-pin').first().waitFor({ timeout: 8000 });
        const posted = await comments();
        assert.equal(posted.length, 1, `comments: ${posted.length}`);
        assert.equal(posted[0].text, 'Cancelled, then posted');
      } finally { await context.close(); }
    });
  } finally {
    await browser.close();
    tdoc.close(); idp.close(); app.close();
  }
  console.log(`\n${failed ? 'FAIL' : 'PASS'} — ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
