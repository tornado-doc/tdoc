// New -> Doc -> "Write it with tdoc AI" (flag writeWithTdocAi): the row is
// there only with the flag, the dialog takes one sentence, shows honest
// progress ("Writing the draft · N s"), and lands on the new doc's v1. Real
// worker routes (in-process harness) and the real built shell in Chromium;
// only the model is stubbed (it answers after a pause, so the progress state
// can be seen). Desktop and phone.
//
// TDOC_TEST_SCREENSHOTS=<dir> writes the menu, the dialog, the progress and
// the landed doc per viewport.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('write-with-ai-ui.test.js');

const SID = 'c4'.repeat(16);
const SHOTS = process.env.TDOC_TEST_SCREENSHOTS || '';

async function seed(env) {
  await env.META.put('hosted-account:alice', JSON.stringify({
    account_id: 'acct-alice', github_login: 'alice', created: '2026-01-01T00:00:00.000Z',
  }));
  await env.META.put(`session:${SID}`, JSON.stringify({
    login: 'alice', account_id: 'acct-alice', name: 'alice', email: 'alice@example.com', avatar_url: '', created: new Date().toISOString(),
  }));
  await env.META.put('meta:q4-roadmap', JSON.stringify({
    title: 'Q4 roadmap', slug: 'q4-roadmap', created: '2026-10-01T00:00:00.000Z', versions: [{ n: 1, created: '2026-10-01T00:00:00.000Z' }],
    hosted: { account_id: 'acct-alice', github_login: 'alice', owner_key: 'alice' },
    access: { visibility: 'unlisted', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
  }));
  await env.DOCS.put('docs/q4-roadmap/v1/index.html', '<!doctype html><html><body><h1>Q4 roadmap</h1><p>Notes.</p></body></html>');
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
    try { for await (const chunk of req) chunks.push(chunk); } catch { return; }
    const headers = { ...req.headers, host: 'tdoc.dev' };
    if (headers.origin) headers.origin = 'https://tdoc.dev';
    delete headers.referer;
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      redirect: 'manual',
    }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let body = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) {
      body = Buffer.from(body.toString('utf8')
        .replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path)
        .replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    }
    response.headers.forEach((value, key) => {
      if (!['content-length', 'content-encoding', 'content-security-policy'].includes(key)) res.setHeader(key, value);
    });
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  console.log('Write with tdoc AI (New menu)');
  const mod = await loadWorker();
  const worker = mod.default;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  let passed = 0;
  const t = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); }
  };
  // The model: answers after a pause. Anything else the worker fetches fails.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : input.url;
    if (/\/chat\/completions$/.test(u)) {
      await new Promise((r) => setTimeout(r, 2500));
      return new Response(JSON.stringify({ choices: [{ message: { content: '# Iceland packing list\n\n## Clothes\n\n- Wool base layers\n- Rain shell\n\n## Gear\n\n- Headlamp' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };

  const run = async (label, viewport, flag) => {
    const env = makeEnv(mod.CommentsStore);
    env.ASK_API_KEY = 'test-key';
    env.TDOC_DEBUG_ACCOUNTS = 'alice@example.com';
    await seed(env);
    const { server, base } = await startServer(worker, env);
    const phone = viewport.width < 600;
    const context = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await context.addCookies([{ name: 'tdoc_sid', value: SID, url: base }]);
    await context.addInitScript((on) => {
      try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {}
      if (window === window.top) window.__TDOC_FLAGS__ = Object.assign({}, window.__TDOC_FLAGS__, { writeWithTdocAi: on });
    }, flag);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = async (name) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(SHOTS, `${label}-${name}.png`) });
    };
    const press = (locator) => (phone ? locator.tap() : locator.click());
    const openDoc = async () => {
      await press(page.getByRole('button', { name: 'New', exact: true }));
      await press(page.getByRole('menuitem', { name: 'Doc', exact: true }));
      const popup = page.locator('.ui-menu-popup.mk-pushed');
      await popup.waitFor();
      return popup;
    };
    try {
      await page.goto(`${base}/me`);
      await page.locator('.doc-row[data-slug="q4-roadmap"]').waitFor();
      if (!flag) {
        await t(`${label}, flag off: Doc offers no tdoc AI row`, async () => {
          const popup = await openDoc();
          const rows = (await popup.locator('.mk-item b').allTextContents()).map((s) => s.trim());
          assert.deepEqual(rows, ['Blank doc', 'Write it with your agent']);
        });
        return;
      }
      await t(`${label}: Doc → Write it with tdoc AI → one sentence → progress → the new doc's v1`, async () => {
        const popup = await openDoc();
        const rows = (await popup.locator('.mk-item b').allTextContents()).map((s) => s.trim());
        assert.deepEqual(rows, ['Blank doc', 'Write it with your agent', 'Write it with tdoc AI']);
        await shot('menu');
        await press(popup.getByRole('menuitem', { name: /Write it with tdoc AI/ }));
        const dialog = page.getByRole('dialog', { name: 'Write it with tdoc AI' });
        await dialog.waitFor();
        await dialog.getByText(/5 free requests left/).waitFor();
        const write = dialog.getByRole('button', { name: 'Write it', exact: true });
        assert.equal(await write.isDisabled(), true, 'Write it before a sentence');
        await dialog.getByRole('textbox').fill('A packing list for a week of hiking in Iceland');
        await shot('dialog');
        await press(write);
        const status = dialog.locator('.mk-write-status');
        await status.waitFor();
        assert.match(await status.innerText(), /^Writing the draft · \d+ s$/);
        await page.waitForTimeout(1200);
        await shot('writing');
        await page.waitForURL(/\/d\/[a-z0-9-]+\/v\/1$/, { timeout: 20000 });
        const slug = page.url().match(/\/d\/([a-z0-9-]+)\/v\/1$/)[1];
        const meta = JSON.parse(await env.META.get(`meta:${slug}`));
        assert.equal(meta.title, 'Iceland packing list');
        assert.equal(meta.access.visibility, 'private');
        await page.frameLocator('iframe').first().getByRole('heading', { name: 'Iceland packing list' }).waitFor({ timeout: 15000 });
        await shot('landed');
        assert.deepEqual(errors, []);
      });
    } finally {
      await context.close();
      server.close();
    }
  };

  try {
    await run('desktop', { width: 1280, height: 860 }, true);
    await run('phone', { width: 390, height: 844 }, true);
    await run('desktop', { width: 1280, height: 860 }, false);
  } finally {
    await browser.close();
    globalThis.fetch = realFetch;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
