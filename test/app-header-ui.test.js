// One header everywhere, in a real browser (Julie, 2026-10-24: /feedback had
// a letter for an avatar and no account menu). Real worker routes (in-process
// harness) behind a local HTTP server, the built shell runtime, Chromium.
//
// For every page a person can land on — My docs, a profile, a doc, a
// feedback space, /feedback, the connect popup, a shared folder, a status
// page, the neutral landing, /activate, /setup — signed in:
//   desktop: the tdoc mark links to /me, the avatar chip opens the account
//            menu (My docs, Agents, Sign out);
//   phone:   ⋯ is on screen and holds My account;
// signed out: the same bar with Sign in. And on /feedback the bookmark is
// the real javascript: address (React 19 would swap one passed as a prop),
// Copy copies the one line, and a click on the pill opens the drag coach.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('app-header-ui.test.js');

const SID = 'c3'.repeat(16);
const BOOKMARK = (base) => `javascript:(function(){if(window.tdocFeedback){window.tdocFeedback.toggle();return}var s=document.createElement('script');s.src='${base}/feedback.js?b='+Date.now();s.async=true;s.setAttribute('data-tdoc-open','1');document.documentElement.appendChild(s)})()`;

async function seed(worker, env) {
  await env.META.put('hosted-account:julie', JSON.stringify({ account_id: 'acct-julie', github_login: 'julie', created: '2026-01-01T00:00:00.000Z' }));
  await env.META.put(`session:${SID}`, JSON.stringify({
    login: 'julie', account_id: 'acct-julie', name: 'Julie', avatar_url: '', created: new Date().toISOString(),
  }));
  await env.META.put('meta:sample', JSON.stringify({
    title: 'Sample doc', slug: 'sample', created: '2026-01-01T00:00:00.000Z', versions: [{ n: 1, created: '2026-01-01T00:00:00.000Z' }],
    hosted: { account_id: 'acct-julie', github_login: 'julie' }, access: { visibility: 'unlisted' },
  }));
  await env.DOCS.put('docs/sample/v1/index.html', '<h1>Sample doc</h1><p>Opening paragraph.</p>');
  const call = async (path, body, method = 'POST') => (await worker.fetch(new Request(`https://tdoc.dev${path}`, {
    method,
    headers: { Cookie: `tdoc_sid=${SID}`, 'Content-Type': 'application/json', Origin: 'https://tdoc.dev' },
    body: JSON.stringify(body),
  }), env, { waitUntil() {} })).json();
  assert.equal((await call('/api/me/handle', { handle: 'julie' })).ok, true);
  const space = await call('/api/feedback/connect', { origin: 'http://localhost:3000' });
  const folder = await call('/api/folders', { name: 'Specs' });
  const shared = await call('/api/folders', { id: folder.folder.id, visibility: 'unlisted' }, 'PATCH');
  return { space: space.slug, share: shared.folder.share_id };
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
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = { ...req.headers, host: 'tdoc.dev' };
    if (headers.origin) headers.origin = 'https://tdoc.dev';
    delete headers.referer;
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, {
      method: req.method,
      headers,
      redirect: 'manual',
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
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
      res.setHeader(key, key === 'location' ? value.replace('https://tdoc.dev', '') : value);
    });
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  console.log('App header UI');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { GITHUB_CLIENT_ID: 'test-client' });
  const ids = await seed(worker, env);
  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const pages = [
    ['My docs', '/me'],
    ['profile', '/@julie'],
    ['document', '/d/sample/v/1'],
    ['feedback space', `/d/${ids.space}`],
    ['/feedback', '/feedback'],
    ['/feedback/connect', '/feedback/connect?origin=http%3A%2F%2Flocalhost%3A3000'],
    ['shared folder', `/f/${ids.share}`],
    ['status page', '/email/optout?t=expired'],
    ['neutral landing', '/?notice=notfound'],
    ['/activate', '/activate'],
    ['/setup', '/setup'],
  ];
  const signedOut = new Set(['profile', 'document', 'feedback space', '/feedback', 'shared folder', 'status page', 'neutral landing', '/activate']);

  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 860 } });
      await context.addCookies([{ name: 'tdoc_sid', value: SID, url: base }]);
      for (const [name, path] of pages) {
        await t(`${width}px signed in, ${name}: the shared bar, its mark and the account`, async () => {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          try {
            await page.goto(base + path);
            if (name === '/setup') {
              // The setup dialog traps focus over My docs; dismiss it before
              // testing the shared header underneath.
              await page.getByRole('heading', { name: 'Which AI do you use?', exact: true }).waitFor();
              await page.keyboard.press('Escape');
              await page.getByRole('dialog').waitFor({ state: 'hidden' });
            }
            await page.locator('.tdoc-bar').first().waitFor();
            assert.equal(await page.locator('.tdoc-bar').count(), 1, 'one bar');
            const mark = page.locator('.tdoc-bar a.tdoc-bar-mark');
            assert.equal(await mark.getAttribute('href'), '/me');
            assert.equal(await mark.locator('img').getAttribute('src'), '/tdoc_logo.svg');
            if (width > 700) {
              const chip = page.locator('.tdoc-bar .tdoc-account-trigger');
              await chip.waitFor();
              // Avatar only in the bar; the name is its label and tooltip.
              assert.match(await chip.getAttribute('aria-label'), /Julie/);
              await chip.click();
              for (const item of ['My docs', 'Agents', 'Sign out']) await page.getByRole('menuitem', { name: item, exact: true }).waitFor();
              await page.keyboard.press('Escape');
            } else {
              const more = page.locator('#tdoc-more-btn');
              await more.waitFor();
              const box = await more.boundingBox();
              assert(box && box.x + box.width <= width, `⋯ is off screen at ${JSON.stringify(box)}`);
              await more.click();
              await page.getByRole('menuitem', { name: 'My account' }).waitFor();
              await page.keyboard.press('Escape');
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
            assert.deepEqual(errors, []);
          } finally {
            await page.close();
          }
        });
      }
      await context.close();
    }

    const anon = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    for (const [name, path] of pages.filter(([n]) => signedOut.has(n))) {
      await t(`signed out, ${name}: the same bar with Sign in`, async () => {
        const page = await anon.newPage();
        try {
          await page.goto(base + path);
          await page.locator('.tdoc-bar .tdoc-account-trigger.signin').waitFor();
          assert.equal(await page.locator('.tdoc-bar a.tdoc-bar-mark img').getAttribute('src'), '/tdoc_logo.svg');
        } finally {
          await page.close();
        }
      });
    }
    await anon.close();

    await t('/feedback: the bookmark is the real address, Copy copies the one line, the pill opens the coach', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      const page = await context.newPage();
      try {
        await page.goto(`${base}/feedback`);
        const pill = page.locator('#bookmarklet');
        await pill.waitFor();
        assert.equal(await pill.getAttribute('href'), BOOKMARK('https://tdoc.dev'));
        await page.getByRole('button', { name: 'Copy code' }).click();
        await page.locator('.code-copy .copy-btn.copied').waitFor();
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '<script src="https://tdoc.dev/feedback.js"></script>');
        await pill.click();
        await page.locator('#coach .coach-copy').waitFor();
        await page.waitForFunction(() => /^M [\d.]+ [\d.]+ C /.test(
          [...document.querySelectorAll('#coach path')].at(-1)?.getAttribute('d') || '',
        ));
        assert.match(await page.locator('#coach path').last().getAttribute('d'), /^M [\d.]+ [\d.]+ C /);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#coach').count(), 0, 'Escape closes the coach');
      } finally {
        await context.close();
      }
    });

    await t('feedback space: its bookmark is the real address too', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      await context.addCookies([{ name: 'tdoc_sid', value: SID, url: base }]);
      const page = await context.newPage();
      try {
        await page.goto(`${base}/d/${ids.space}`);
        await page.locator('.tdoc-fbspace-how summary').click();
        assert.equal(await page.locator('a.tdoc-fbspace-bm').getAttribute('href'), BOOKMARK('https://tdoc.dev'));
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser.close();
    server.close();
  }
  if (failed) {
    console.log(`\nFAIL — ${failed} failed`);
    process.exit(1);
  }
  console.log('\nPASS');
})().catch((error) => { console.error(error); process.exit(1); });
