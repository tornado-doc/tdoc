// New -> Doc -> "Write it with tdoc AI" (flag writeWithTdocAi): the row is
// there only with the flag, the dialog takes one sentence, and the draft
// appears in it as tdoc AI writes it (server-sent events), set like a doc;
// then the dialog lands on the new doc's v1. Markup the model writes is text
// in the live view, never elements. Stop ends it with nothing saved and the
// allowance given back; a model failure mid-stream says so and stays. Real
// worker routes (in-process harness, the response streamed through) and the
// real built shell in Chromium; only the model is stubbed, streaming its
// answer a piece at a time. Desktop and phone.
//
// TDOC_TEST_SCREENSHOTS=<dir> writes the menu, the dialog, the live draft
// mid-stream and the landed doc per viewport.
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
    if (type.includes('text/event-stream')) {
      // Streamed through as it comes, as the edge does.
      response.headers.forEach((value, key) => { if (key !== 'content-length') res.setHeader(key, value); });
      res.statusCode = response.status;
      res.flushHeaders();
      const reader = response.body.getReader();
      res.on('close', () => { if (!res.writableEnded) reader.cancel().catch(() => {}); });
      try {
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          res.write(Buffer.from(step.value));
        }
      } catch {}
      return res.end();
    }
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
  // The model streams its answer a piece at a time (chat-completions SSE).
  // `model.fail` ends it with an error after a few pieces.
  const DRAFT = [
    '# Iceland packing list\n\n',
    'A week on the Laugavegur trail in late summer: ',
    'pack for **rain, wind and 0 °C nights**, not for the photos.\n\n',
    '## Clothes\n\n',
    '- Wool base layers, top and bottom\n',
    '- A rain shell with a hood\n',
    '- <img src=x onerror="window.__xss=1"> two pairs of liner socks\n\n',
    '## Gear\n\n',
    '| Item | Why |\n| --- | --- |\n',
    '| Headlamp | Huts are dark |\n',
    '| Poles | River crossings |\n\n',
    '<script>window.__xss=2</script>\n\n',
    '## Food\n\n',
    'Huts sell little; carry five days of lunches.\n',
  ];
  const model = { fail: false, step: 450, calls: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : input.url;
    if (/\/chat\/completions$/.test(u)) {
      model.calls++;
      const enc = new TextEncoder();
      const signal = init && init.signal;
      const pieces = model.fail ? DRAFT.slice(0, 3) : DRAFT;
      const fail = model.fail;
      const step = model.step;
      const body = new ReadableStream({
        async start(c) {
          try {
            for (const p of pieces) {
              await new Promise((r) => setTimeout(r, step));
              if (signal && signal.aborted) return;
              c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
            }
            c.enqueue(enc.encode(fail ? `data: ${JSON.stringify({ error: { message: 'overloaded', code: 502 } })}\n\n` : 'data: [DONE]\n\n'));
            c.close();
          } catch {}
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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
      const openDialog = async () => {
        const popup = await openDoc();
        const rows = (await popup.locator('.mk-item b').allTextContents()).map((s) => s.trim());
        assert.deepEqual(rows, ['Blank doc', 'Write it with your agent', 'Write it with tdoc AI']);
        await shot('menu');
        await press(popup.getByRole('menuitem', { name: /Write it with tdoc AI/ }));
        const dialog = page.getByRole('dialog', { name: 'Write it with tdoc AI' });
        await dialog.waitFor();
        return dialog;
      };
      const remaining = () => page.evaluate(async () => (await (await fetch('/api/write-with-ai')).json()).remaining);
      await t(`${label}: Doc → Write it with tdoc AI → one sentence → the draft appears live → the new doc's v1`, async () => {
        const dialog = await openDialog();
        // A draft is three of the five free requests.
        await dialog.getByText(/A draft uses 3 of your 5 free requests/).waitFor();
        const write = dialog.getByRole('button', { name: 'Write it', exact: true });
        assert.equal(await write.isDisabled(), true, 'Write it before a sentence');
        await dialog.getByRole('textbox').fill('A packing list for a week of hiking in Iceland');
        await shot('dialog');
        await press(write);
        const paper = dialog.locator('.mk-write-paper');
        await paper.waitFor();
        // Mid-stream: the title and the first section are there, the rest is
        // not, the status counts, and nothing has navigated yet.
        await paper.getByRole('heading', { name: 'Clothes' }).waitFor({ timeout: 10000 });
        await paper.locator('li', { hasText: 'liner socks' }).waitFor({ timeout: 10000 });
        assert.equal(await paper.getByRole('heading', { name: 'Iceland packing list', level: 1 }).count(), 1);
        assert.equal(await paper.getByRole('heading', { name: 'Food' }).count(), 0, 'the end arrived at once');
        assert.match(await dialog.locator('.mk-write-status').innerText(), /^Writing · \d+ s · \d+ words$/);
        assert.equal(await dialog.getByRole('button', { name: 'Stop' }).isEnabled(), true);
        assert.match(page.url(), /\/me$/);
        assert.equal(await paper.locator('strong', { hasText: 'rain, wind and 0 °C nights' }).count(), 1, 'bold not rendered');
        await shot('writing');
        await paper.locator('table').waitFor({ timeout: 10000 });
        await shot('writing-table');
        // The model's markup is text: shown, never an element, never run.
        await paper.getByText('<script>window.__xss=2</script>').waitFor({ timeout: 10000 });
        assert.equal(await paper.locator('img, script').count(), 0, 'model markup became elements');
        assert.match(await paper.innerText(), /<img src=x onerror="window.__xss=1">/);
        assert.equal(await page.evaluate(() => window.__xss), undefined, 'model markup ran');
        await page.waitForURL(/\/d\/[a-z0-9-]+\/v\/1$/, { timeout: 20000 });
        const slug = page.url().match(/\/d\/([a-z0-9-]+)\/v\/1$/)[1];
        const meta = JSON.parse(await env.META.get(`meta:${slug}`));
        assert.equal(meta.title, 'Iceland packing list');
        assert.equal(meta.access.visibility, 'private');
        await page.frameLocator('iframe').first().getByRole('heading', { name: 'Iceland packing list' }).waitFor({ timeout: 15000 });
        await shot('landed');
        assert.equal(await page.evaluate(() => window.__xss), undefined, 'model markup ran');
        assert.deepEqual(errors, []);
      });
      if (phone) return;
      await t(`${label}: Stop mid-stream: no doc, no navigation, the requests given back`, async () => {
        await page.goto(`${base}/me`);
        await page.locator('.doc-row[data-slug="q4-roadmap"]').waitFor();
        env.ASK_FREE_LIMIT = '9';
        const before = await remaining();
        const docs = (await env.META.list({ prefix: 'meta:' })).keys.length;
        const dialog = await openDialog();
        await dialog.getByRole('textbox').fill('A second list');
        await press(dialog.getByRole('button', { name: 'Write it', exact: true }));
        await dialog.locator('.mk-write-paper h2').first().waitFor({ timeout: 10000 });
        await press(dialog.getByRole('button', { name: 'Stop' }));
        await dialog.getByText(/Stopped\. Nothing was saved/).waitFor();
        // What was written stays readable; the sentence can be sent again.
        assert.equal(await dialog.locator('.mk-write-paper h1').count(), 1);
        assert.equal(await dialog.getByRole('button', { name: 'Try again' }).isEnabled(), true);
        let left = null;
        for (let i = 0; i < 50 && left !== before; i++) { left = await remaining(); if (left !== before) await page.waitForTimeout(100); }
        assert.equal(left, before, 'not given back');
        await page.waitForTimeout(DRAFT.length * model.step);
        assert.match(page.url(), /\/me$/);
        assert.equal((await env.META.list({ prefix: 'meta:' })).keys.length, docs, 'a doc was created');
        await page.keyboard.press('Escape');
      });
      await t(`${label}: the model fails mid-stream: the error shows, no navigation, nothing charged`, async () => {
        await page.goto(`${base}/me`);
        await page.locator('.doc-row[data-slug="q4-roadmap"]').waitFor();
        const before = await remaining();
        model.fail = true;
        try {
          const dialog = await openDialog();
          await dialog.getByRole('textbox').fill('A third list');
          await press(dialog.getByRole('button', { name: 'Write it', exact: true }));
          await dialog.getByRole('alert').getByText(/could not write it this time/).waitFor({ timeout: 15000 });
          assert.equal(await dialog.locator('.mk-write-paper h1').count(), 1, 'the partial draft went away');
          assert.equal(await remaining(), before, 'charged for a failure');
          assert.match(page.url(), /\/me$/);
          await shot('failed');
        } finally { model.fail = false; }
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
