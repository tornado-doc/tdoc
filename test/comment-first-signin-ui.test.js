// Comment first, sign in later, on the doc page (slides and sheets share its
// composer). A signed-out reader picks text and writes; Post signs in in a
// window of its own and the page stays where it is:
//   - Post opens the sign-in window (no navigation of the page); once tdoc
//     says this browser is signed in, the held comment posts by itself and
//     the page shows it, open, on the same doc;
//   - the window's word is only a hint: a "signed in" message with no
//     session behind it posts nothing (the page asks /api/auth/me);
//   - the sign-in window blocked: the page's own sign-in (a redirect) as
//     before, and on the way back the words are in the composer again,
//     "Your comment is saved — Post", posted only by that Post; Back
//     without signing in restores them too ("Sign in to post");
//   - × / Esc while signing in: the window closes, nothing is held, and
//     finishing the sign-in later posts nothing; the words stay for the
//     same passage.
// The widget's side (no window from the bookmark, Post opens it, the held
// comment posts after connecting) is in dogfood-frictions-ui.test.js and
// feedback-connect-coop-ui.test.js.
// Sign-in is stubbed as in those suites: /api/auth/web/login goes to a
// local "provider" page whose Continue sets the session cookie and returns.
// TDOC_UI_SHOTS=<dir> saves screenshots (desktop 1440 and phone 390).
// Run with: node test/comment-first-signin-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chooseMode, modeSelector } = require('./helpers/doc-mode');
const { loadWorker, makeEnv, issue, putSession } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium } = requirePlaywrightOrSkip('comment-first-signin-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TDOC = 'https://tdoc.dev';
const DOC = '<!doctype html><html><body><h1>Launch plan</h1><p>Billing ships first, on March 14, because invoices block two renewals.</p><p>Search follows in April.</p></body></html>';
const DESK = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 } };

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((a) => [a.path, a]));
  const server = http.createServer(async (request, res) => {
    const url = new URL(request.url, 'http://x');
    const asset = byPath.get(url.pathname);
    if (asset) { res.setHeader('content-type', asset.type); return res.end(fs.readFileSync(asset.file)); }
    // The provider: a page of its own, and Continue comes back signed in.
    if (url.pathname === '/api/auth/web/login') {
      res.writeHead(302, { location: `/__test/provider?return=${encodeURIComponent(url.searchParams.get('return') || '/')}` });
      return res.end();
    }
    if (url.pathname === '/__test/provider') {
      const back = `/__test/signin?return=${encodeURIComponent(url.searchParams.get('return') || '/')}`;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><meta charset="utf-8"><title>Sign in</title><h1>Sign in</h1><a id="continue" href="${back}">Continue</a>`);
    }
    if (url.pathname === '/__test/signin') {
      const cookie = await putSession(env, 'reader');
      const ret = url.searchParams.get('return') || '/';
      res.writeHead(302, { location: ret.startsWith('/') && !ret.startsWith('//') ? ret : '/', 'set-cookie': `${cookie}; Path=/; HttpOnly; SameSite=Lax` });
      return res.end();
    }
    const chunks = [];
    try { for await (const chunk of request) chunks.push(chunk); } catch { return; }
    const headers = { ...request.headers, host: 'tdoc.dev' };
    if (headers.origin) headers.origin = TDOC;
    delete headers.referer;
    const response = await worker.fetch(new Request(`${TDOC}${request.url}`, {
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
      res.setHeader(key, key === 'location' ? value.replace(TDOC, '') : value);
    });
    const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    if (cookies.length) res.setHeader('set-cookie', cookies.map((c) => c.replace(/;\s*Secure/gi, '')));
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function select(page, phrase) {
  const frameEl = await page.locator('iframe').first().elementHandle();
  const frame = await frameEl.contentFrame();
  await frame.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'comment');
  const box = await frameEl.boundingBox();
  const r = await frame.evaluate((needle) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = n.nodeValue.indexOf(needle);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i); range.setEnd(n, i + needle.length);
      const rects = range.getClientRects();
      const a = rects[0]; const b = rects[rects.length - 1];
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
    }
    return null;
  }, phrase);
  await page.mouse.move(box.x + r.x1, box.y + r.y1); await page.mouse.down();
  await page.mouse.move(box.x + r.x2, box.y + r.y2, { steps: 6 });
  await page.mouse.up();
  await page.locator('.tdoc-popup textarea').waitFor();
}

(async () => {
  console.log('Comment first, sign in later: the doc page');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret' });
  const julie = await issue(worker, env, 'julie');
  const up = await worker.fetch(new Request(`${TDOC}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${julie.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'launch-plan', version: 1, html: DOC, meta: { title: 'Launch plan' } }),
  }), env, {});
  assert.equal(up.status, 200, `upload ${up.status}`);
  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); }
  };
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const posted = async () => {
    const r = await worker.fetch(new Request(`${TDOC}/api/comments?slug=launch-plan&version=1`, { headers: { cookie: julie.cookie } }), env, {});
    const body = await r.json();
    return (Array.isArray(body) ? body : body.comments || []).filter((c) => c && !c.deleted);
  };
  // Every case starts with no comments: the reader's own are deleted (by
  // the reader: only an author deletes).
  const clear = async () => {
    const cookie = await putSession(env, 'reader');
    for (const c of await posted()) {
      await worker.fetch(new Request(`${TDOC}/api/comments?slug=launch-plan&version=1&id=${encodeURIComponent(c.id)}`, { method: 'DELETE', headers: { cookie, origin: TDOC } }), env, {});
    }
    assert.equal((await posted()).length, 0, 'could not clear the comments');
  };
  const open = async (opts, { blockPopups = false } = {}) => {
    const context = await browser.newContext(opts);
    if (blockPopups) await context.addInitScript(() => { window.open = () => null; });
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.goto(`${base}/d/launch-plan`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    await chooseMode(page, 'Comment');
    await page.locator(modeSelector('comment')).waitFor();
    return { context, page };
  };
  const composer = (page) => page.locator('.tdoc-popup:has(textarea)');

  try {
    for (const [tag, opts] of [['desktop', DESK], ['phone', PHONE]]) {
      await t(`${tag}: signed-out Post opens sign-in in a window; after it the comment posts by itself and the page stays`, async () => {
        await clear();
        const { context, page } = await open(opts);
        try {
          await select(page, 'Billing ships first');
          const pop = composer(page);
          await pop.locator('textarea').fill('Which renewals?');
          assert.match(await pop.locator('.tdoc-sign-in-to-post').innerText(), /Sign in to post — your comment is saved/);
          await shot(page, `doc-${tag}-signed-out-composer`);
          const docUrl = page.url();
          const [win] = await Promise.all([context.waitForEvent('page'), pop.getByRole('button', { name: 'Post', exact: true }).click()]);
          await win.waitForLoadState();
          assert.match(win.url(), /\/__test\/provider\?return=%2Fauth%2Fsigned-in/);
          assert.ok(!/token|code=|session/i.test(win.url()), `a credential in the sign-in URL: ${win.url()}`);
          // The page did not leave; the composer says what is happening.
          assert.equal(page.url(), docUrl);
          assert.match(await pop.locator('.tdoc-sign-in-to-post').innerText(), /Finish signing in/);
          assert.equal((await pop.locator('button.submit').innerText()).trim(), 'Open sign-in');
          await shot(page, `doc-${tag}-signing-in`);
          // A "signed in" word with no session behind it posts nothing.
          await page.evaluate(() => { const c = new BroadcastChannel('tdoc-auth'); c.postMessage({ type: 'tdoc:signed-in' }); c.close(); });
          await page.waitForTimeout(1800);
          assert.equal((await posted()).length, 0, 'posted on the window\'s word alone');
          assert.equal(await pop.locator('textarea').inputValue(), 'Which renewals?');
          // Open sign-in while the window is there: no second window.
          const pages = context.pages().length;
          await pop.locator('button.submit').click();
          await page.waitForTimeout(300);
          assert.equal(context.pages().length, pages, 'a second sign-in window');
          // Sign in in the window: it lands on /auth/signed-in and closes.
          await win.locator('#continue').click();
          await page.waitForURL((u) => new URL(u).searchParams.get('comment'), { timeout: 15000 });
          assert.equal(new URL(page.url()).pathname, new URL(docUrl).pathname, 'the page left the doc');
          const list = await posted();
          assert.equal(list.length, 1, `comments: ${JSON.stringify(list)}`);
          assert.equal(list[0].text, 'Which renewals?');
          assert.equal(list[0].author?.login || list[0].author, 'reader');
          assert.match(list[0].anchor?.text || list[0].anchor?.quote || JSON.stringify(list[0].anchor), /Billing ships first/);
          assert.equal(new URL(page.url()).searchParams.get('comment'), list[0].id);
          await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
          await page.waitForTimeout(500);
          assert.ok(win.isClosed(), 'the sign-in window stayed open');
          await shot(page, `doc-${tag}-posted`);
          assert.equal(await page.evaluate(() => sessionStorage.getItem('tdoc-comment-signin-draft:launch-plan:v1')), null, 'the held draft outlived the post');
          assert.deepEqual(page.errors, []);
        } finally { await context.close(); }
      });

      await t(`${tag}: the sign-in window blocked: the page signs in as before and the words come back, saved, for one Post`, async () => {
        await clear();
        const { context, page } = await open(opts, { blockPopups: true });
        try {
          await select(page, 'Billing ships first');
          await composer(page).locator('textarea').fill('Blocked, then restored');
          await composer(page).getByRole('button', { name: 'Post', exact: true }).click();
          await page.waitForURL(/\/__test\/provider/);
          // Back without signing in: the words are there, "Sign in to post".
          await page.goBack();
          await page.locator('.tdoc-popup textarea').waitFor({ timeout: 15000 });
          assert.equal(await composer(page).locator('textarea').inputValue(), 'Blocked, then restored');
          assert.match(await composer(page).locator('.tdoc-sign-in-to-post').innerText(), /Sign in to post — your comment is saved/);
          await shot(page, `doc-${tag}-back-restored`);
          // Post again (still blocked): off to sign in, and this time finish.
          await composer(page).getByRole('button', { name: 'Post', exact: true }).click();
          await page.waitForURL(/\/__test\/provider/);
          await page.locator('#continue').click();
          await page.waitForURL((u) => new URL(u).pathname === '/d/launch-plan');
          await page.locator('.tdoc-popup textarea').waitFor({ timeout: 15000 });
          const pop = composer(page);
          assert.equal(await pop.locator('textarea').inputValue(), 'Blocked, then restored');
          assert.match(await pop.locator('.tdoc-draft-restored').innerText(), /Your comment is saved — Post/);
          assert.match(await pop.locator('.head .h').innerText(), /Billing ships/);
          await shot(page, `doc-${tag}-redirect-restored`);
          // Never posted by itself.
          await page.waitForTimeout(800);
          assert.equal((await posted()).length, 0, 'the restored draft posted without Post');
          await pop.getByRole('button', { name: 'Post', exact: true }).click();
          await pop.waitFor({ state: 'detached', timeout: 10000 });
          const list = await posted();
          assert.equal(list.length, 1);
          assert.equal(list[0].text, 'Blocked, then restored');
          assert.equal(list[0].author?.login || list[0].author, 'reader');
          assert.deepEqual(page.errors, []);
        } finally { await context.close(); }
      });
    }

    await t('Esc while signing in: the window closes, nothing is held, signing in later posts nothing; the words stay for the passage', async () => {
      await clear();
      const { context, page } = await open(DESK);
      try {
        await select(page, 'Billing ships first');
        await composer(page).locator('textarea').fill('Walked away');
        const [win] = await Promise.all([context.waitForEvent('page'), composer(page).getByRole('button', { name: 'Post', exact: true }).click()]);
        await win.waitForLoadState();
        await page.keyboard.press('Escape');
        await composer(page).waitFor({ state: 'detached' });
        await page.waitForTimeout(300);
        assert.ok(win.isClosed(), 'Esc left the sign-in window open');
        assert.equal(await page.evaluate(() => sessionStorage.getItem('tdoc-comment-signin-draft:launch-plan:v1')), null, 'Esc left the post held');
        // Signing in anyway (another tab) posts nothing here.
        const other = await context.newPage();
        await other.goto(`${base}/__test/signin?return=/auth/signed-in`);
        await page.waitForTimeout(2500);
        assert.equal((await posted()).length, 0, 'an abandoned comment posted');
        await other.close().catch(() => {});
        // The words are still there for the same passage.
        await select(page, 'Billing ships first');
        assert.equal(await composer(page).locator('textarea').inputValue(), 'Walked away');
        assert.deepEqual(page.errors, []);
      } finally { await context.close(); }
    });

    await t('/auth/signed-in says signed in only with a session, carries nothing, and never caches', async () => {
      const anon = await worker.fetch(new Request(`${TDOC}/auth/signed-in`), env, {});
      const anonHtml = await anon.text();
      assert.match(anonHtml, /Not signed in/);
      assert.ok(!/signedInWindow/.test(anonHtml), 'a signed-out visit announces a sign-in');
      const cookie = await putSession(env, 'reader');
      const r = await worker.fetch(new Request(`${TDOC}/auth/signed-in`, { headers: { cookie } }), env, {});
      const body = await r.text();
      assert.equal(r.status, 200);
      assert.match(body, /signedInWindow/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.ok(!body.includes(cookie.split('=')[1]), 'the session id in the page');
    });
  } finally {
    await browser.close();
    server.close();
  }
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
