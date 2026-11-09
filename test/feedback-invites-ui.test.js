// Sharing a feedback space from inside the widget (Julie, 2026-11-03), in a
// browser: real worker routes (in-process harness) behind a local tdoc
// server, the built runtimes, and a separate site on another host.
//
//   - The owner opens Share in the widget, copies a one-time invite link and
//     invites someone by name, without leaving the site.
//   - A site with no widget (the bookmarklet's): the link lands on the small
//     tdoc page (who, which site, the bookmark, Open <site>); the site opened
//     from it, with the bookmark clicked, asks "<Name> invited you to comment
//     on <site>": Join connects and joins; the param leaves the address.
//   - Without the link: the one-time prompt, Keep my own, then the space
//     switcher in the list's header.
//   - A site with the SDK: the link is the site; its widget asks Join only.
//   - A space that moved under a page-load: Reconnect, no window opened.
//   - Desktop 1440 and phone 390: nothing runs off the side.
//
// TDOC_UI_ENGINES=chromium,webkit runs both engines; TDOC_UI_SHOTS=<dir>
// saves a screenshot of each step.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const playwright = requirePlaywrightOrSkip('feedback-invites-ui.test.js');

const SHOTS = process.env.TDOC_UI_SHOTS || '';
const ENGINES = (process.env.TDOC_UI_ENGINES || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);
const TDOC = 'https://tdoc.dev';
const HOME = { Origin: TDOC };
const WIDGET = path.join(__dirname, '..', 'server/runtime/feedback.js');

// Somebody's site. `sdk` puts the widget in the page (data-tdoc-space).
const sitePage = (tdocBase, sdk) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme</title>
<style>body{font:16px system-ui;margin:0}main{max-width:640px;margin:80px auto;padding:0 24px}.card{border:1px solid #ddd;border-radius:8px;padding:16px;margin:0 0 12px}</style></head>
<body><main><h1>Acme dashboard</h1><section class="card" id="users"><h2>Weekly active users</h2><p>1,284</p></section></main>
${sdk ? `<script src="${tdocBase}/feedback.js" data-tdoc-space="${sdk}" async></script>` : ''}
</body></html>`;

async function startTdoc(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (request, res) => {
    const pathname = request.url.split('?')[0];
    if (pathname === '/feedback.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.setHeader('access-control-allow-origin', '*');
      return res.end(fs.readFileSync(WIDGET));
    }
    const asset = byPath.get(pathname);
    if (asset) {
      res.setHeader('content-type', asset.type);
      return res.end(fs.readFileSync(asset.file));
    }
    const chunks = [];
    // A browser closing mid-request (a poll, a read mark) aborts its body.
    try { for await (const chunk of request) chunks.push(chunk); } catch { return; }
    const headers = { ...request.headers, host: 'tdoc.dev' };
    if (headers.origin) headers.origin = request.headers.origin === `http://${request.headers.host}` ? TDOC : headers.origin;
    delete headers.referer;
    const response = await worker.fetch(new Request(`${TDOC}${request.url}`, {
      method: request.method,
      headers,
      redirect: 'manual',
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
      if (['content-length', 'content-encoding', 'content-security-policy'].includes(key)) return;
      res.setHeader(key, key === 'location' ? value.replace(TDOC, '') : value);
    });
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function startSite(state) {
  const server = http.createServer((request, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(sitePage(state.tdocBase, state.sdk));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Another host than tdoc's (127.0.0.1): its own origin, no tdoc cookie.
  return { server, base: `http://localhost:${server.address().port}` };
}

(async () => {
  console.log('Feedback: share and invite from the widget');
  const mod = await loadWorker();
  const worker = mod.default;
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const call = async (env, p, opts) => {
    const r = await worker.fetch(req(p, opts), env, { waitUntil() {} });
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  // Julie owns the bookmarklet space for the site; Bob has an account.
  const world = async ({ sdk = false } = {}) => {
    const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
    const julie = await issue(worker, env, 'julie');
    const bob = await issue(worker, env, 'bob');
    const tdoc = await startTdoc(worker, env);
    const state = { tdocBase: tdoc.base, sdk: null };
    const site = await startSite(state);
    let space;
    if (sdk) {
      const made = await call(env, '/api/feedback/spaces', { method: 'POST', cookie: julie.cookie, headers: HOME, body: { origins: [site.base] } });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      state.sdk = made.body.slug;
      space = (await call(env, '/api/feedback/connect', { method: 'POST', cookie: julie.cookie, headers: HOME, body: { origin: site.base, space: made.body.slug } })).body;
    } else {
      space = (await call(env, '/api/feedback/connect', { method: 'POST', cookie: julie.cookie, headers: HOME, body: { origin: site.base } })).body;
    }
    const close = () => { tdoc.server.close(); site.server.close(); };
    return { env, julie, bob, space, tdoc: tdoc.base, site: site.base, close };
  };
  const sid = (cookie) => cookie.split('=')[1];
  const storageKey = (w) => (w.space.site ? `tdoc-feedback:${w.tdoc}:${w.space.slug}` : `tdoc-feedback:${w.tdoc}`);
  const noSideways = async (page) => assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the page scrolls sideways',
  );
  const fits = async (locator, width, what) => {
    const box = await locator.boundingBox();
    assert(box && box.x >= -0.5 && box.x + box.width <= width + 0.5, `${what} off screen at ${width}: ${JSON.stringify(box)}`);
  };
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const allowed = async (w) => JSON.parse(await w.env.META.get(`meta:${w.space.slug}`)).access.allowed_users;
  // What the bookmark does.
  const clickBookmark = (page, tdocBase) => page.evaluate((src) => {
    const s = document.createElement('script');
    s.src = `${src}?b=${Date.now()}`; s.async = true; s.setAttribute('data-tdoc-open', '1');
    document.documentElement.appendChild(s);
  }, `${tdocBase}/feedback.js`);

  for (const engine of ENGINES) {
    const browser = await playwright[engine].launch({ headless: true });
    try {
      for (const width of [1440, 390]) {
        const tag = `${engine}-${width}`;
        const newContext = () => browser.newContext({ viewport: { width, height: 860 }, ...(engine === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) });

        await t(`${tag}: the owner shares from the widget on their own site: a one-time link and an invite by name`, async () => {
          const w = await world({ sdk: true });
          const context = await newContext();
          try {
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [storageKey(w), JSON.stringify(w.space)]);
            await page.goto(`${w.site}/`);
            const root = page.locator('#tdoc-feedback-root');
            const share = root.locator('.tdoc-feedback-dock .tdoc-fb-share');
            await share.waitFor();
            assert.equal(await share.evaluate((el) => el.localName), 'button', 'Share still leaves the site');
            await fits(share, width, 'Share');
            await share.click();
            const dialog = page.getByRole('dialog', { name: 'Share' });
            await dialog.waitFor();
            await dialog.getByText('A one-time link, made when you copy it').waitFor();
            await fits(dialog, width, 'Share dialog');
            await shot(page, `${tag}-owner-share-open`);
            await dialog.getByRole('button', { name: 'Copy link' }).click();
            await dialog.locator('#tdoc-fb-share-status').filter({ hasText: /Invite link copied|Link ready/ }).waitFor();
            const field = dialog.locator('#tdoc-fb-invite-link');
            await page.waitForFunction(() => /tdoc_invite=/.test(document.getElementById('tdoc-feedback-root').shadowRoot.getElementById('tdoc-fb-invite-link')?.textContent || ''));
            const link = (await field.innerText()).trim();
            // The SDK's link is the site itself.
            assert.equal(link.split('?')[0], `${w.site}/`);
            assert.match(link, /\?tdoc_invite=[a-f0-9]{32}\.[A-Za-z0-9_-]{22}$/);
            await dialog.locator('.tdoc-invite-row', { hasText: 'Invite link' }).waitFor();
            const input = dialog.locator('.tdoc-token-field input');
            await input.fill('bob');
            await input.press('Enter');
            await dialog.locator('.tdoc-invite-row', { hasText: 'bob' }).waitFor();
            assert((await allowed(w)).includes('bob'), 'bob not let in');
            const inbox = JSON.parse(await w.env.META.get('inbox:bob'));
            assert.equal(inbox.items[0].kind, 'feedback_invite');
            await fits(dialog, width, 'Share dialog with invites');
            await noSideways(page);
            await shot(page, `${tag}-owner-share-invited`);
            // Withdraw the name: access goes with it.
            await dialog.locator('.tdoc-invite-row', { hasText: 'bob' }).getByRole('button', { name: 'Withdraw' }).click();
            await dialog.locator('.tdoc-invite-row', { hasText: 'bob' }).waitFor({ state: 'detached' });
            assert(!(await allowed(w)).includes('bob'), 'bob kept access after Withdraw');
            assert.deepEqual(errors, []);
          } finally { await context.close(); w.close(); }
        });

        await t(`${tag}: on somebody else's site (the bookmarklet), Share opens tdoc's Share window`, async () => {
          const w = await world();
          const context = await newContext();
          try {
            await context.addCookies([{ name: 'tdoc_sid', value: sid(w.julie.cookie), url: w.tdoc }]);
            const page = await context.newPage();
            await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [storageKey(w), JSON.stringify(w.space)]);
            await page.goto(`${w.site}/`);
            await clickBookmark(page, w.tdoc);
            const share = page.locator('#tdoc-feedback-root .tdoc-feedback-dock .tdoc-fb-share');
            await share.waitFor();
            const [popup] = await Promise.all([context.waitForEvent('page'), share.click()]);
            await popup.waitForLoadState();
            assert.equal(new URL(popup.url()).pathname, `/feedback/share/${w.space.slug}`);
            const dialog = popup.getByRole('dialog', { name: 'Share' });
            await dialog.waitFor();
            await dialog.getByRole('button', { name: 'Copy link' }).click();
            await popup.waitForFunction(() => /\/feedback\/invite\//.test(document.getElementById('tdoc-fb-invite-link')?.textContent || ''));
            await dialog.locator('.tdoc-invite-row', { hasText: 'Invite link' }).waitFor();
            await shot(popup, `${tag}-owner-share-window`);
            assert.equal(await page.locator('#tdoc-feedback-root .ui-dialog-popup').count(), 0, 'Share drawn on a foreign site');
          } finally { await context.close(); w.close(); }
        });

        await t(`${tag}: no widget on the site: the link's page joins on tdoc and opens the site; the bookmark connects there`, async () => {
          const w = await world();
          const link = (await call(w.env, '/api/feedback/invites', { method: 'POST', cookie: w.julie.cookie, headers: HOME, body: { slug: w.space.slug } })).body.invite;
          const context = await newContext();
          try {
            await context.addCookies([{ name: 'tdoc_sid', value: sid(w.bob.cookie), url: w.tdoc }]);
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(`${w.tdoc}/feedback/invite/${link.id}`);
            const host = new URL(w.site).host;
            await page.getByRole('heading', { name: `julie invited you to comment on ${host}` }).waitFor();
            const open = page.locator('#open-site');
            assert.equal(await open.innerText(), `Join and open ${host}`);
            assert.equal(await page.locator('#step-bookmark').count(), 1, 'no bookmark step');
            if (width > 720) assert.match(await page.locator('#bookmarklet').getAttribute('href'), /^javascript:/);
            else await page.locator('#step-bookmark .phone-only').waitFor();
            await fits(open, width, 'Join button');
            await noSideways(page);
            await shot(page, `${tag}-invite-landing`);
            await open.click();
            await page.waitForURL(`${w.site}/`);
            assert.equal(await page.evaluate(() => location.search), '', 'the site got the invite');
            assert((await allowed(w)).includes('bob'), 'bob not let in');
            // The bookmark: its first connect goes to the space joined.
            const popupP = context.waitForEvent('page', { timeout: 4000 }).catch(() => null);
            await clickBookmark(page, w.tdoc);
            let popup = await popupP;
            if (!popup) {
              const connectBtn = page.locator('#tdoc-feedback-root .tdoc-feedback-notice button.submit');
              await connectBtn.waitFor();
              [popup] = await Promise.all([context.waitForEvent('page'), connectBtn.click()]);
            }
            await popup.waitForLoadState();
            await popup.locator('#connect').click();
            await page.waitForFunction((key) => { try { return Boolean(JSON.parse(localStorage.getItem(key)).token); } catch (_) { return false; } }, storageKey(w));
            const session = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey(w));
            assert.equal(session.slug, w.space.slug);
            await page.locator('#tdoc-feedback-root .tdoc-feedback-dock').waitFor();
            await noSideways(page);
            await shot(page, `${tag}-invite-joined`);
            assert.deepEqual(errors, []);
          } finally { await context.close(); w.close(); }
        });

        await t(`${tag}: invited without the link: asked once, Keep my own, then the switcher`, async () => {
          const w = await world();
          await call(w.env, '/api/feedback/invites', { method: 'POST', cookie: w.julie.cookie, headers: HOME, body: { slug: w.space.slug, invitee: 'bob' } });
          const mine = (await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob.cookie, headers: HOME, body: { origin: w.site } })).body;
          assert(mine.invite_prompt, 'no prompt in the session');
          const context = await newContext();
          try {
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${w.tdoc}`, JSON.stringify(mine)]);
            await page.goto(`${w.site}/`);
            await clickBookmark(page, w.tdoc);
            const root = page.locator('#tdoc-feedback-root');
            const prompt = root.locator('.tdoc-fb-invite-prompt');
            await prompt.waitFor();
            await shot(page, `${tag}-server-prompt`);
            await prompt.getByRole('button', { name: 'Keep my own' }).click();
            await prompt.waitFor({ state: 'detached' });
            assert.equal(await w.env.META.get(`feedback:invite-choice:bob:${w.space.slug}`), 'kept');
            // The list's header is the switcher.
            await root.locator('.tdoc-feedback-dock button', { hasText: 'open' }).click();
            const switcher = root.locator('.tdoc-fb-panel .tdoc-fb-space');
            await switcher.waitFor();
            assert.equal((await switcher.innerText()).trim(), 'My space');
            await switcher.click();
            const item = root.locator('.ui-menu-item', { hasText: 'julie’s space' });
            await item.waitFor();
            await fits(root.locator('.ui-menu-popup'), width, 'switcher menu');
            await shot(page, `${tag}-switcher-open`);
            // Not joined yet: the connect window asks Join (a click on tdoc).
            await context.addCookies([{ name: 'tdoc_sid', value: sid(w.bob.cookie), url: w.tdoc }]);
            const [popup] = await Promise.all([context.waitForEvent('page'), item.click()]);
            await popup.waitForLoadState();
            const card = popup.locator('#invite-card');
            await card.waitFor();
            assert.match(await card.innerText(), /julie invited you to comment on/);
            await shot(popup, `${tag}-invite-connect-window`);
            await popup.locator('#connect').click();
            await root.locator('.tdoc-fb-toast', { hasText: 'Now in julie’s space' }).waitFor({ timeout: 8000 });
            await page.waitForFunction(() => /julie/.test(document.getElementById('tdoc-feedback-root').shadowRoot.querySelector('.tdoc-fb-space')?.textContent || ''));
            const session = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), `tdoc-feedback:${w.tdoc}`);
            assert.equal(session.slug, w.space.slug);
            await noSideways(page);
            await shot(page, `${tag}-switcher-switched`);
            assert.deepEqual(errors, []);
          } finally { await context.close(); w.close(); }
        });

        await t(`${tag}: a site with the SDK: the link is the site, its widget asks Join only`, async () => {
          const w = await world({ sdk: true });
          const link = (await call(w.env, '/api/feedback/invites', { method: 'POST', cookie: w.julie.cookie, headers: HOME, body: { slug: w.space.slug } })).body.invite;
          assert.equal(link.link, `${w.site}/?tdoc_invite=${link.id}`);
          const context = await newContext();
          try {
            await context.addCookies([{ name: 'tdoc_sid', value: sid(w.bob.cookie), url: w.tdoc }]);
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(link.link);
            const prompt = page.locator('#tdoc-feedback-root .tdoc-fb-invite-prompt');
            await prompt.waitFor();
            assert.equal(await prompt.getByRole('button', { name: 'Keep my own' }).count(), 0, 'Keep my own on a site space');
            assert.equal(await page.evaluate(() => location.search), '');
            await fits(prompt, width, 'invite prompt');
            await shot(page, `${tag}-invite-prompt-sdk`);
            const [popup] = await Promise.all([context.waitForEvent('page'), prompt.getByRole('button', { name: 'Join' }).click()]);
            await popup.waitForLoadState();
            await popup.locator('#invite-card').waitFor();
            await popup.locator('#connect').click();
            await page.locator('#tdoc-feedback-root .tdoc-fb-toast', { hasText: 'Joined' }).waitFor({ timeout: 8000 });
            assert((await allowed(w)).includes('bob'), 'bob not let in');
            await shot(page, `${tag}-invite-joined-sdk`);
            assert.deepEqual(errors, []);
          } finally { await context.close(); w.close(); }
        });

        await t(`${tag}: a space that moved while the page loaded: Reconnect, and no window opens by itself`, async () => {
          const w = await world();
          const handle = (await call(w.env, '/api/feedback/invites', { method: 'POST', cookie: w.julie.cookie, headers: HOME, body: { slug: w.space.slug, invitee: 'bob' } })).body.invite;
          const joined = (await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.bob.cookie, headers: HOME, body: { origin: w.site, invite: handle.id } })).body;
          await call(w.env, '/api/feedback/invites/revoke', { method: 'POST', cookie: w.julie.cookie, headers: HOME, body: { slug: w.space.slug, id: handle.id } });
          const context = await newContext();
          try {
            const page = await context.newPage();
            const popups = [];
            context.on('page', (p) => popups.push(p.url()));
            await page.addInitScript(() => { window.__opened = 0; const open = window.open; window.open = (...a) => { window.__opened += 1; return open.apply(window, a); }; });
            await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${w.tdoc}`, JSON.stringify(joined)]);
            await page.goto(`${w.site}/`);
            await page.addScriptTag({ url: `${w.tdoc}/feedback.js` });
            const notice = page.locator('#tdoc-feedback-root .tdoc-feedback-notice');
            await notice.waitFor();
            await notice.getByRole('button', { name: 'Reconnect' }).waitFor();
            await page.waitForTimeout(400);
            assert.equal(await page.evaluate(() => window.__opened), 0, 'a window was opened with no click');
            assert.deepEqual(popups, []);
            await fits(notice, width, 'Reconnect notice');
            await shot(page, `${tag}-reconnect`);
          } finally { await context.close(); w.close(); }
        });
      }
    } finally {
      await browser.close();
    }
  }

  console.log(failed ? `\nFAIL — ${failed} failed` : '\nPASS');
  process.exit(failed ? 1 : 0);
})();
