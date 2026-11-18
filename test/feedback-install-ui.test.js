// /feedback in a real browser (Julie, 2026-11-18: the SDK sat in a grey box
// under the bookmark). Real worker routes (in-process harness) behind a local
// HTTP server, the built shell runtime, Chromium.
//   - a chooser at the top: two cards, Bookmark and SDK, each jumping to its
//     section, and the one-line rule under them;
//   - the SDK is a section of the same weight as the bookmark: the site
//     picture, three numbered steps, Copy prompt copies the agent prompt and
//     Copy copies the one line (the placeholder signed out);
//   - signed in with a site space of their own, the line carries its id;
//   - desktop and phone: both cards side by side, nothing scrolls sideways.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('feedback-install-ui.test.js');

const SID = 'c4'.repeat(16);
const LINE = (space) => `<script src="https://tdoc.dev/feedback.js" data-tdoc-space="${space}" async></script>`;

async function seed(worker, env) {
  await env.META.put('hosted-account:julie', JSON.stringify({ account_id: 'acct-julie', github_login: 'julie', created: '2026-01-01T00:00:00.000Z' }));
  await env.META.put(`session:${SID}`, JSON.stringify({
    login: 'julie', account_id: 'acct-julie', name: 'Julie', avatar_url: '', created: new Date().toISOString(),
  }));
  const r = await worker.fetch(new Request('https://tdoc.dev/api/feedback/spaces', {
    method: 'POST',
    headers: { Cookie: `tdoc_sid=${SID}`, 'Content-Type': 'application/json', Origin: 'https://tdoc.dev' },
    body: JSON.stringify({ origins: ['https://app.example.com'] }),
  }), env, { waitUntil() {} });
  const made = await r.json();
  assert.ok(made.slug, `no site space: ${JSON.stringify(made)}`);
  return made.slug;
}

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (req, res) => {
    const asset = byPath.get(req.url.split('?')[0]);
    if (asset) {
      res.setHeader('content-type', asset.type);
      return res.end(fs.readFileSync(asset.file));
    }
    const chunks = [];
    try { for await (const chunk of req) chunks.push(chunk); } catch { return; }
    const headers = { ...req.headers, host: 'tdoc.dev' };
    if (headers.origin) headers.origin = 'https://tdoc.dev';
    delete headers.referer;
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, {
      method: req.method, headers, redirect: 'manual',
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    }), env, { waitUntil() {} });
    let body = Buffer.from(await response.arrayBuffer());
    if ((response.headers.get('content-type') || '').includes('text/html')) {
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
  console.log('/feedback install page UI');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { GITHUB_CLIENT_ID: 'test-client' });
  const space = await seed(worker, env);
  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const open = async (viewport, { signedIn = false, phone = false } = {}) => {
    const context = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    if (signedIn) await context.addCookies([{ name: 'tdoc_sid', value: SID, url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/feedback`);
    await page.locator('#sdk .fb-steps').waitFor();
    return { context, page, errors };
  };
  const inView = (page, sel) => page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight / 2;
  }, sel);

  try {
    for (const [device, viewport, phone] of [['desktop', { width: 1280, height: 860 }, false], ['phone', { width: 390, height: 844 }, true]]) {
      await t(`${device}: chooser on top, both cards jump to their sections`, async () => {
        const { context, page, errors } = await open(viewport, { phone });
        try {
          const bookmark = page.locator('#choose-bookmark');
          const sdk = page.locator('#choose-sdk');
          assert.match(await bookmark.innerText(), /Bookmark[\s\S]*Quick feedback, no setup/);
          assert.match(await sdk.innerText(), /SDK[\s\S]*Built into your own product/);
          assert.match(await page.locator('.fb-rule').innerText(), /Quick feedback, no setup → Bookmark\. Feedback built into your product → SDK\./);
          // Side by side on both widths, above either section.
          const [a, b] = [await bookmark.boundingBox(), await sdk.boundingBox()];
          assert.ok(Math.abs(a.y - b.y) < 2 && b.x > a.x + a.width - 1, 'cards are not side by side');
          assert.ok(a.y < (await page.locator('#bookmark').boundingBox()).y, 'chooser is not above the sections');
          await sdk.click();
          await page.waitForFunction(() => location.hash === '#sdk');
          await page.waitForFunction(() => { const r = document.querySelector('#sdk').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2; });
          assert.equal(await inView(page, '#sdk'), true, '#sdk is not on screen after the jump');
          // The SDK heading has the bookmark's weight: same tag, same size.
          const sizes = await page.evaluate(() => ['#bookmark h2', '#sdk h2'].map((s) => getComputedStyle(document.querySelector(s)).fontSize));
          assert.equal(sizes[0], sizes[1], `heading sizes differ: ${sizes}`);
          await page.evaluate(() => window.scrollTo(0, 0));
          await bookmark.click();
          await page.waitForFunction(() => location.hash === '#bookmark');
          await page.waitForFunction(() => { const r = document.querySelector('#bookmark').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2; });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'sideways scroll');
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      await t(`${device}: SDK section is the site picture and three steps; Copy prompt and Copy work`, async () => {
        const { context, page, errors } = await open(viewport, { phone });
        try {
          assert.equal(await page.locator('#sdk .site-demo .site-demo-fab').isVisible(), true, 'no comment button in the site picture');
          assert.deepEqual(await page.locator('#sdk .fb-step h3').allInnerTexts(), [
            'Ask your agent', 'Or paste one line before </head>', 'Comments arrive in your feedback space',
          ]);
          // Who can comment, exactly as the worker admits them.
          assert.match(await page.locator('#sdk-arrive').innerText(), /only you and the people you invite \(or your team\) can comment, signed in to tdoc/);
          await page.locator('#sdk-ask').getByRole('button', { name: 'Copy prompt' }).click();
          await page.locator('#sdk-ask .tdoc-copy-prompt.is-copied').waitFor();
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Add tdoc feedback to my site');
          await page.locator('#sdk-paste').getByRole('button', { name: 'Copy code' }).click();
          await page.locator('#sdk-paste .copy-btn.copied').waitFor();
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), LINE('YOUR_SPACE_ID'));
          assert.match(await page.locator('#sdk-space-note').innerText(), /Your agent fills in YOUR_SPACE_ID/);
          assert.equal(await page.locator('#sdk a[href="https://github.com/tornado-doc/tdoc/tree/main/packages/feedback#readme"]').count(), 1, 'no setup guide link');
          assert.equal(await page.locator('#sdk a[href="/me?view=comments"]').count(), 1, 'no bookmark-space link');
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });

      await t(`${device}: signed in with a site space, the line carries its id`, async () => {
        const { context, page, errors } = await open(viewport, { phone, signedIn: true });
        try {
          await page.waitForFunction((slug) => document.querySelector('#sdk-paste pre').textContent.includes(slug), space);
          assert.match(await page.locator('#sdk-space-note').innerText(), /Your space for app\.example\.com/);
          await page.locator('#sdk-paste').getByRole('button', { name: 'Copy code' }).click();
          await page.locator('#sdk-paste .copy-btn.copied').waitFor();
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), LINE(space));
          assert.equal(await page.locator('#sdk .site-demo .demo-omnibox').innerText(), 'app.example.com');
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }

    await t('/feedback#sdk (the homepage link) lands on the SDK section', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const page = await context.newPage();
      try {
        await page.goto(`${base}/feedback#sdk`);
        await page.locator('#sdk .fb-steps').waitFor();
        await page.waitForFunction(() => { const r = document.querySelector('#sdk').getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2; });
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser.close();
    server.close();
  }
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
})().catch((error) => { console.error(error); process.exit(1); });
