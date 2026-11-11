// Slide controls in Edit mode (server/slides-edit.js): add a slide (Title /
// Bullets / Big number), duplicate, move up and down, delete with Undo, and a
// Big number slide's image by link -- on a Blank deck, desktop (hover) and
// phone (tap). Whole slides only: never one inside another; ids follow their
// slides; nothing of the bar is saved. Real worker routes (in-process
// harness), real built shell runtime, real Chromium.
//
// TDOC_TEST_SCREENSHOTS=<dir> writes the bar, the layout menu, the image
// field, the Undo toast and the saved deck per viewport.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('slide-controls-ui.test.js');

const SID = 'd4'.repeat(16);
const SHOTS = process.env.TDOC_TEST_SCREENSHOTS || '';

async function seed(env) {
  await env.META.put('hosted-account:alice', JSON.stringify({
    account_id: 'acct-alice', github_login: 'alice', created: '2026-01-01T00:00:00.000Z',
  }));
  await env.META.put(`session:${SID}`, JSON.stringify({
    login: 'alice', account_id: 'acct-alice', name: 'alice', avatar_url: '', created: new Date().toISOString(),
  }));
  for (const [slug, title] of [['q4-roadmap', 'Q4 roadmap'], ['meeting-notes', 'Meeting notes']]) {
    await env.META.put(`meta:${slug}`, JSON.stringify({
      title, slug, created: '2026-10-01T00:00:00.000Z', versions: [{ n: 1, created: '2026-10-01T00:00:00.000Z' }],
      hosted: { account_id: 'acct-alice', github_login: 'alice', owner_key: 'alice' },
      access: { visibility: 'unlisted', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
    }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, `<!doctype html><html><body><h1>${title}</h1><p>Notes.</p></body></html>`);
  }
}

// The harness bucket models If-None-Match only. A browser's first save
// replaces the blank scaffold with `onlyIf: { etagMatches }` (worker
// _saveVersion), so give its objects an etag and honour that condition here.
function withEtags(bucket) {
  const tags = new Map();
  let n = 0;
  const get = bucket.get.bind(bucket);
  const put = bucket.put.bind(bucket);
  bucket.get = async (k, opts) => {
    const object = await get(k, opts);
    return object ? { ...object, etag: tags.get(k) } : object;
  };
  bucket.put = async (k, v, opts) => {
    const match = opts && opts.onlyIf && opts.onlyIf.etagMatches;
    if (match) {
      if (tags.get(k) !== match) return null;
      const { onlyIf, ...rest } = opts;
      opts = rest;
    }
    const result = await put(k, v, opts);
    if (result) tags.set(k, `e${++n}`);
    return result;
  };
  return bucket;
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
  console.log('Slide controls in Edit mode');
  const mod = await loadWorker();
  const worker = mod.default;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  let passed = 0;
  const t = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); }
  };

  const run = async (label, viewport) => {
    const env = makeEnv(mod.CommentsStore);
    withEtags(env.DOCS);
    await seed(env);
    const { server, base } = await startServer(worker, env);
    const phone = viewport.width < 600;
    const context = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await context.addCookies([{ name: 'tdoc_sid', value: SID, url: base }]);
    await context.addInitScript(() => { try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {} });
    // The picture "on the web": served locally, so the test needs no network.
    await context.route('https://example.com/chart.png', (route) => route.fulfill({
      contentType: 'image/png', body: fs.readFileSync(path.join(__dirname, '..', 'assets', 'mac-downloads.png')),
    }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = async (name) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SHOTS, `${label}-${name}.png`) });
    };
    const press = (locator) => (phone ? locator.tap() : locator.click());
    const frame = page.frameLocator('iframe[aria-label="Document content"]');
    const doc = () => page.frames().find((f) => f.url().includes('/frame'));
    const bar = frame.locator('.tdoc-slide-bar');
    // The deck as the frame holds it: each top-level slide's data-tdoc-slide
    // value and the id comments anchor by (TdocSelection.slideId).
    const deck = () => doc().evaluate(() => [...document.querySelectorAll('[data-tdoc-slide]')]
      .filter((el) => !el.parentElement.closest('[data-tdoc-slide]'))
      .map((el) => ({ value: el.getAttribute('data-tdoc-slide'), anchor: TdocSelection.slideId(el), heading: (el.querySelector('h1,h2,.tds-num') || {}).textContent })));
    const nested = () => doc().evaluate(() => document.querySelectorAll('[data-tdoc-slide] [data-tdoc-slide]').length);
    // Point at slide i: hover on a desktop, a tap into its text on a phone.
    const pick = async (i) => {
      const slide = frame.locator('main > [data-tdoc-slide]').nth(i);
      await slide.scrollIntoViewIfNeeded();
      if (phone) await slide.locator('h1, h2, .tds-num').first().tap();
      else await slide.hover({ position: { x: 60, y: 60 } });
      await bar.waitFor();
      await doc().waitForFunction((n) => {
        const b = document.querySelector('.tdoc-slide-bar');
        return b && !b.hidden && b.getAttribute('aria-label') === `Slide ${n + 1} of ${document.querySelectorAll('main > [data-tdoc-slide]').length}`;
      }, i);
    };
    const barButton = (name) => bar.getByRole('button', { name });

    try {
      await page.goto(`${base}/me`);
      await page.locator('.doc-row[data-slug="q4-roadmap"]').waitFor();
      await press(page.getByRole('button', { name: 'New', exact: true }));
      await press(page.getByRole('menuitem', { name: 'Slides', exact: true }));
      await press(page.getByRole('menuitem', { name: /Blank deck/ }));
      await page.waitForURL(/\/d\/[^/]+\/v\/1\?edit=1/, { timeout: 15000 });
      const slug = new URL(page.url()).pathname.split('/')[2];
      await frame.locator('[data-tdoc-slide]').first().waitFor({ timeout: 15000 });
      await doc().waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'edit');
      const start = await deck();

      await t(`${label}: the starter deck's slides carry their own ids`, async () => {
        assert.equal(start.length, 3);
        assert.ok(start.every((s) => /^s-[a-z0-9]{6}$/.test(s.value) && s.anchor === `v:${s.value}`), JSON.stringify(start));
        assert.equal(new Set(start.map((s) => s.value)).size, 3, 'three different ids');
      });

      await t(`${label}: ${phone ? 'a tap into' : 'hovering'} a slide shows its bar`, async () => {
        await pick(1);
        assert.equal(await barButton('Move slide up').isDisabled(), false);
        assert.equal(await barButton('Delete slide').isDisabled(), false);
        assert.equal(await barButton('Slide image').isVisible(), false, 'no image slot on a bullet slide');
        const inside = await doc().evaluate(() => {
          const b = document.querySelector('.tdoc-slide-bar').getBoundingClientRect();
          const s = document.querySelectorAll('main > [data-tdoc-slide]')[1].getBoundingClientRect();
          return b.left >= s.left - 1 && b.right <= s.right + 1 && b.top >= s.top - 1 && b.right <= innerWidth;
        });
        assert.ok(inside, 'the bar sits on its slide, on screen');
        assert.equal(await doc().evaluate(() => !!document.querySelector('main .tdoc-slide-bar, main [data-tdoc-provider]')), false, 'the bar is not in the document');
        await shot('bar');
        if (!phone) {
          await pick(0);
          assert.equal(await barButton('Move slide up').isDisabled(), true, 'the first slide cannot go up');
        }
      });

      await t(`${label}: Add slide offers three layouts and inserts the slide after this one`, async () => {
        await pick(1);
        await press(barButton('Add slide after this one'));
        const menu = frame.getByRole('menu', { name: 'Add a slide' });
        await menu.waitFor();
        const items = (await menu.getByRole('menuitem').allTextContents()).map((s) => s.trim());
        assert.deepEqual(items.map((s) => s.split(/(?<=[a-z])(?=[A-Z])/)[0]), ['Title', 'Bullets', 'Big number']);
        await shot('add-menu');
        if (!phone) {
          // Keyboard: the menu opens on its first item; ↓ walks it; Escape returns.
          assert.equal(await doc().evaluate(() => document.activeElement.getAttribute('data-layout')), 'title');
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('ArrowDown');
          assert.equal(await doc().evaluate(() => document.activeElement.getAttribute('data-layout')), 'number');
          await page.keyboard.press('Escape');
          await menu.waitFor({ state: 'detached' });
          assert.equal(await doc().evaluate(() => document.activeElement.getAttribute('aria-label')), 'Add slide after this one');
          await press(barButton('Add slide after this one'));
          await menu.waitFor();
        }
        await press(menu.getByRole('menuitem', { name: /Big number/ }));
        await menu.waitFor({ state: 'detached' });
        const now = await deck();
        assert.equal(now.length, 4);
        assert.equal(now[2].heading, '42%', 'inserted right after slide 2');
        assert.ok(/^s-/.test(now[2].value) && !start.some((s) => s.value === now[2].value), 'its own id');
        assert.equal(await nested(), 0, 'no slide inside another');
        assert.equal(await doc().evaluate(() => document.querySelectorAll('style[data-tdoc-slide-kit]').length), 1, 'one kit stylesheet');
      });

      await t(`${label}: a Big number slide takes an image by link, http(s) only`, async () => {
        await pick(2);
        await press(barButton('Slide image'));
        const dialog = frame.getByRole('dialog', { name: 'Slide image' });
        await dialog.waitFor();
        await shot('image-empty');
        const input = dialog.getByLabel('Image link');
        for (const bad of ['javascript:alert(1)', 'data:image/png;base64,iVBORw0KGgo=', 'ftp://example.com/a.png', 'not a link']) {
          await input.fill(bad);
          await press(dialog.getByRole('button', { name: 'Add image' }));
          await dialog.getByRole('alert').waitFor();
          assert.equal(await doc().evaluate(() => document.querySelectorAll('[data-tdoc-slide-image] img').length), 0, `${bad} was accepted`);
        }
        await shot('image-error');
        await input.fill('https://example.com/chart.png');
        await press(dialog.getByRole('button', { name: 'Add image' }));
        await dialog.waitFor({ state: 'detached' });
        const img = await doc().evaluate(() => {
          const el = document.querySelector('[data-tdoc-slide-image] img');
          return el && { src: el.getAttribute('src'), editable: el.closest('[data-tdoc-slide-image]').getAttribute('contenteditable') };
        });
        assert.deepEqual(img, { src: 'https://example.com/chart.png', editable: 'false' });
      });

      await t(`${label}: Duplicate copies the slide right after it, with a new id`, async () => {
        await pick(0);
        await press(barButton('Duplicate slide'));
        await doc().waitForFunction(() => document.querySelectorAll('main > [data-tdoc-slide]').length === 5);
        const now = await deck();
        assert.equal(now[1].heading, now[0].heading, 'the copy follows its original');
        assert.notEqual(now[1].value, now[0].value, 'with an id of its own');
        assert.notEqual(now[1].anchor, now[0].anchor, 'so comments on the original stay on the original');
        assert.equal(await nested(), 0, 'no slide inside another');
      });

      await t(`${label}: Move up / Move down move the slide, and every id goes with its slide`, async () => {
        const before = await deck();
        await pick(4);
        await press(barButton('Move slide up'));
        await press(barButton('Move slide up'));
        const after = await deck();
        assert.deepEqual(after.map((s) => s.value), [before[0], before[1], before[4], before[2], before[3]].map((s) => s.value));
        // Each slide keeps the id its comments anchor by.
        const byValue = Object.fromEntries(before.map((s) => [s.value, s.anchor]));
        assert.ok(after.every((s) => byValue[s.value] === s.anchor), 'an anchor id changed on a move');
        await doc().waitForFunction(() => document.querySelector('.tdoc-slide-bar').getAttribute('aria-label') === 'Slide 3 of 5');
        await press(barButton('Move slide down'));
        assert.deepEqual((await deck()).map((s) => s.value), [before[0], before[1], before[2], before[4], before[3]].map((s) => s.value));
        assert.equal(await nested(), 0);
      });

      await t(`${label}: Delete removes the slide, Undo puts it back where it was`, async () => {
        const before = await deck();
        await pick(1);
        await press(barButton('Delete slide'));
        await doc().waitForFunction(() => document.querySelectorAll('main > [data-tdoc-slide]').length === 4);
        const toast = frame.locator('.tdoc-slide-toast');
        await toast.waitFor();
        await shot('deleted');
        await press(toast.getByRole('button', { name: 'Undo' }));
        await toast.waitFor({ state: 'detached' });
        assert.deepEqual((await deck()).map((s) => s.value), before.map((s) => s.value), 'Undo restores it in place');
        await pick(1);
        await press(barButton('Delete slide'));
        await doc().waitForFunction(() => document.querySelectorAll('main > [data-tdoc-slide]').length === 4);
        assert.deepEqual((await deck()).map((s) => s.value), before.filter((_, i) => i !== 1).map((s) => s.value));
      });

      await t(`${label}: Save writes the slides in order, and nothing of the controls`, async () => {
        const order = (await deck()).map((s) => s.value);
        await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'); return b && !b.disabled; });
        await press(page.locator('button').filter({ hasText: /^\s*Save\s*$/ }).first());
        await page.waitForURL(/\/v\/2/, { timeout: 15000 });
        const html = await env.DOCS.get(`docs/${slug}/v2/index.html`).then((o) => o.text());
        const saved = [...html.matchAll(/data-tdoc-slide="([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual(saved, order, 'the saved order is the edited order');
        assert.ok(!/tdoc-slide-bar|tdoc-slide-pop|tdoc-slide-toast|data-tdoc-provider|contenteditable|data-tdoc-editor/.test(html), 'controls or editor state saved');
        assert.match(html, /<img src="https:\/\/example\.com\/chart\.png"/);
        assert.ok(!/src="data:/.test(html), 'no inline data');
        // The saved page, read back: whole slides, side by side.
        await page.goto(`${base}/d/${slug}/v/2`);
        await frame.locator('[data-tdoc-slide]').first().waitFor();
        assert.equal(await nested(), 0);
        assert.equal(await frame.locator('main > [data-tdoc-slide]').count(), 4);
        assert.equal(await frame.locator('.tdoc-slide-bar:visible').count(), 0, 'no bar outside Edit mode');
        await frame.locator('[data-tdoc-slide-image] img').scrollIntoViewIfNeeded();
        await shot('saved');
      });

      assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
    } finally {
      await context.close();
      server.close();
    }
  };

  try {
    await run('desktop', { width: 1280, height: 860 });
    await run('phone', { width: 390, height: 844 });
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
