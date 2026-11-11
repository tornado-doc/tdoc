// My docs "New": pick the type (Doc · Sheet · Slides), then the method, with
// New folder under a rule at the bottom. Real worker routes (in-process
// harness) behind a local HTTP server, real built shell runtime, real
// Chromium; desktop and phone, the `sheets` flag on and off.
//
// TDOC_TEST_SCREENSHOTS=<dir> writes level 1 and each level 2 per viewport.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('create-menu-ui.test.js');

const SID = 'c3'.repeat(16);
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
  console.log('New menu: type, then method');
  const mod = await loadWorker();
  const worker = mod.default;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  let passed = 0;
  const t = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); }
  };

  const run = async (label, viewport, sheets) => {
    const env = makeEnv(mod.CommentsStore);
    withEtags(env.DOCS);
    await seed(env);
    const { server, base } = await startServer(worker, env);
    const phone = viewport.width < 600;
    const context = await browser.newContext({
      viewport,
      ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    await context.addCookies([{ name: 'tdoc_sid', value: SID, url: base }]);
    await context.addInitScript((on) => {
      try { localStorage.setItem('tdoc-save-notice-dismissed', '1'); } catch {}
      if (window === window.top) window.__TDOC_FLAGS__ = Object.assign({}, window.__TDOC_FLAGS__, { sheets: on });
    }, sheets);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const tag = `${label}, sheets ${sheets ? 'on' : 'off'}`;
    const shot = async (name) => {
      if (!SHOTS || !sheets) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SHOTS, `${label}-${name}.png`) });
    };
    const press = (locator) => (phone ? locator.tap() : locator.click());
    const newButton = page.getByRole('button', { name: 'New', exact: true });
    const level1 = async () => {
      await press(newButton);
      await page.getByRole('menuitem', { name: 'Doc', exact: true }).waitFor();
    };
    const open = async (type) => {
      await level1();
      await press(page.getByRole('menuitem', { name: type, exact: true }));
      // The methods are pushed into the same popup, desktop and phone alike.
      const popup = page.locator('.ui-menu-popup.mk-pushed');
      await popup.waitFor();
      return popup;
    };
    const methods = async (popup) => (await popup.locator('.mk-item b').allTextContents()).map((s) => s.trim());
    const close = async () => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.locator('.ui-menu-popup').first().waitFor({ state: 'detached' }).catch(() => {});
    };
    const insideViewport = async (locator, what) => {
      const box = await locator.boundingBox();
      assert.ok(box, `${what} has no box`);
      assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
        `${what} leaves the screen: ${JSON.stringify(box)}`);
    };

    try {
      await page.goto(`${base}/me`);
      await page.locator('.doc-row[data-slug="q4-roadmap"]').waitFor();

      await t(`${tag}: the button reads New; level 1 is three type tiles, New folder under a rule`, async () => {
        assert.equal(await page.getByRole('button', { name: 'Create a doc' }).count(), 0, 'the old label is gone');
        assert.equal(await page.locator('.toolbar .new-folder-btn').count(), 0, 'New folder is no longer a toolbar button');
        await level1();
        const popup = page.locator('.ui-menu-popup.mk-types');
        const rows = (await popup.getByRole('menuitem').allTextContents()).map((s) => s.trim());
        assert.deepEqual(rows, sheets ? ['Doc', 'Sheet', 'Slides', 'New folder'] : ['Doc', 'Slides', 'New folder']);
        assert.equal(await popup.locator('.ui-menu-sep').count(), 1, 'one rule, above New folder');
        // Tiles: the mark over the label, side by side in one row.
        const tiles = await popup.locator('.mk-tile').evaluateAll((els) => els.map((el) => {
          const mark = el.querySelector('.mk-tile-mark').getBoundingClientRect();
          const label = el.querySelector('.mk-tile-label').getBoundingClientRect();
          const box = el.getBoundingClientRect();
          return { top: box.top, left: box.left, markAbove: mark.bottom <= label.top + 1, svg: !!el.querySelector('.mk-tile-mark svg') };
        }));
        assert.equal(tiles.length, sheets ? 3 : 2);
        assert.ok(tiles.every((tile) => tile.markAbove && tile.svg), `mark over label: ${JSON.stringify(tiles)}`);
        assert.ok(tiles.every((tile) => Math.abs(tile.top - tiles[0].top) < 1), 'the tiles share one row');
        assert.ok(tiles.every((tile, i) => !i || tile.left > tiles[i - 1].left), 'left to right in order');
        await insideViewport(popup, 'level 1');
        await shot('level1');
        await close();
      });

      await t(`${tag}: Doc → Blank doc · Write it with your agent`, async () => {
        const popup = await open('Doc');
        assert.deepEqual(await methods(popup), ['Blank doc', 'Write it with your agent']);
        await insideViewport(popup, 'Doc methods');
        await shot('doc');
        await close();
      });

      await t(`${tag}: Sheet ${sheets ? '→ Blank sheet · Import CSV or Excel · Build it with your agent' : 'is not offered'}`, async () => {
        if (!sheets) {
          await level1();
          assert.equal(await page.getByRole('menuitem', { name: 'Sheet', exact: true }).count(), 0);
          await close();
          return;
        }
        const popup = await open('Sheet');
        assert.deepEqual(await methods(popup), ['Blank sheet', 'Import CSV or Excel', 'Build it with your agent']);
        await insideViewport(popup, 'Sheet methods');
        await shot('sheet');
        await close();
      });

      await t(`${tag}: Slides → Blank deck · Build it with your agent, and the line asks for a slide deck`, async () => {
        const popup = await open('Slides');
        assert.deepEqual(await methods(popup), ['Blank deck', 'Build it with your agent']);
        await insideViewport(popup, 'Slides methods');
        await shot('slides');
        await press(popup.getByRole('menuitem', { name: /Build it with your agent/ }));
        const dialog = page.getByRole('dialog');
        await dialog.locator('.mk-agent[data-kind="slides"]').waitFor();
        assert.equal((await dialog.locator('.ui-dialog-title').textContent()).trim(), 'Build it with your agent');
        await dialog.locator('.mk-subject input').fill('our Q4 plan');
        assert.equal((await dialog.locator('.mk-line p').textContent()).trim(),
          'Use tdoc to make a slide deck about our Q4 plan, publish it, and give me the link');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
      });

      await t(`${tag}: each agent answer composes its own line`, async () => {
        const cases = [['Doc', /Write it with your agent/, 'doc', 'Write it with your agent', 'Use tdoc to write a doc about X, publish it, and give me the link']];
        if (sheets) cases.push(['Sheet', /Build it with your agent/, 'sheet', 'Build it with your agent', 'Use tdoc to make a sheet of X, publish it, and give me the link']);
        for (const [type, row, kind, title, line] of cases) {
          const popup = await open(type);
          await press(popup.getByRole('menuitem', { name: row }));
          const dialog = page.getByRole('dialog');
          await dialog.locator(`.mk-agent[data-kind="${kind}"]`).waitFor();
          assert.equal((await dialog.locator('.ui-dialog-title').textContent()).trim(), title);
          await dialog.locator('.mk-subject input').fill('X');
          assert.equal((await dialog.locator('.mk-line p').textContent()).trim(), line);
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached' });
        }
      });

      {
        await t(`${tag}: a type pushes its methods in place, and Back returns`, async () => {
          const popup = await open('Doc');
          assert.equal(await page.locator('.ui-menu-popup').count(), 1, 'one popup, never a second on top');
          const back = popup.getByRole('menuitem', { name: 'Back from Doc' });
          await press(back);
          await page.locator('.ui-menu-popup.mk-types:not(.mk-pushed)').waitFor();
          await page.getByRole('menuitem', { name: 'Slides', exact: true }).waitFor();
          await close();
          // Closing forgets the pushed level: the next open starts at the type.
          await open('Slides');
          await close();
          await level1();
          assert.equal(await page.locator('.ui-menu-popup.mk-pushed').count(), 0, 'reopened on level 2');
          await close();
        });
      }

      await t(`${tag}: New folder opens the folder dialog`, async () => {
        await level1();
        await press(page.getByRole('menuitem', { name: 'New folder' }));
        const dialog = page.getByRole('dialog', { name: 'New folder' });
        await dialog.waitFor();
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
      });

      if (!phone) {
        await t(`${tag}: the keyboard walks both levels`, async () => {
          await newButton.focus();
          await page.keyboard.press('Enter');
          await page.locator('.ui-menu-popup.mk-types').waitFor();
          await page.waitForFunction(() => !!document.activeElement?.closest('.ui-menu-popup'));
          const focused = () => page.evaluate(() => (document.activeElement?.textContent || '').trim());
          await page.keyboard.press('ArrowDown');
          if ((await focused()) !== 'Doc') await page.keyboard.press('Home');
          assert.equal(await focused(), 'Doc');
          // ← → step between tiles; ↓ walks on to New folder.
          await page.keyboard.press('ArrowRight');
          assert.equal(await focused(), sheets ? 'Sheet' : 'Slides');
          await page.keyboard.press('ArrowLeft');
          assert.equal(await focused(), 'Doc');
          await page.keyboard.press('Enter');
          await page.locator('.ui-menu-popup.mk-pushed').waitFor();
          await page.waitForFunction(() => /^Blank doc/.test((document.activeElement?.textContent || '').trim()));
          await page.keyboard.press('ArrowUp');
          assert.equal(await focused(), 'Doc', 'the back row');
          await page.keyboard.press('Enter');
          await page.locator('.ui-menu-popup.mk-types:not(.mk-pushed)').waitFor();
          await page.waitForFunction(() => (document.activeElement?.textContent || '').trim() === 'Doc');
          await page.keyboard.press('End');
          assert.equal(await focused(), 'New folder');
          await page.keyboard.press('Escape');
          await page.locator('.ui-menu-popup.mk-types').waitFor({ state: 'detached' });
        });
      }

      if (sheets) {
        await t(`${tag}: a spreadsheet dropped on My docs still asks to import`, async () => {
          await page.evaluate(() => {
            const dt = new DataTransfer();
            dt.items.add(new File(['A,B\n1,x\n'], 'dropped.csv', { type: 'text/csv' }));
            window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
            window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
          });
          await page.locator('.sheet-drop-hint').waitFor();
          await page.evaluate(() => {
            const dt = new DataTransfer();
            dt.items.add(new File(['A,B\n1,x\n'], 'dropped.csv', { type: 'text/csv' }));
            window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          });
          const dialog = page.getByRole('dialog', { name: 'Import as sheet' });
          await dialog.waitFor();
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'detached' });
        });
      }

      await t(`${tag}: Blank doc opens a new doc in edit mode`, async () => {
        const popup = await open('Doc');
        await press(popup.getByRole('menuitem', { name: /Blank doc/ }));
        await page.waitForURL(/\/d\/[^/]+\/v\/1\?edit=1/, { timeout: 15000 });
      });

      await t(`${tag}: Blank deck opens three slides in edit mode, and slide text edits and saves`, async () => {
        await page.goto(`${base}/me`);
        const popup = await open('Slides');
        await press(popup.getByRole('menuitem', { name: /Blank deck/ }));
        await page.waitForURL(/\/d\/[^/]+\/v\/1\?edit=1/, { timeout: 15000 });
        const slug = new URL(page.url()).pathname.split('/')[2];
        const frame = page.frameLocator('iframe[aria-label="Document content"]');
        await frame.locator('[data-tdoc-slide]').first().waitFor({ timeout: 15000 });
        assert.equal(await frame.locator('section[data-tdoc-slide]').count(), 3, 'three starter slides');
        const doc = page.frames().find((f) => f.url().includes('/frame'));
        await doc.waitForFunction(() => document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'edit');
        if (SHOTS && sheets) { await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, `${label}-blank-deck-edit.png`) }); }
        // Retitle the cover and add a bullet: plain text edits inside a slide.
        await doc.evaluate(() => {
          const h1 = document.querySelector('[data-tdoc-slide] h1');
          const range = document.createRange();
          range.selectNodeContents(h1);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        });
        await page.keyboard.type('Launch plan');
        await doc.evaluate(() => {
          const li = document.querySelectorAll('[data-tdoc-slide] li')[2];
          const range = document.createRange();
          range.selectNodeContents(li); range.collapse(false);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        });
        await page.keyboard.press('Enter');
        await page.keyboard.type('Fourth point');
        await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'); return b && !b.disabled; });
        // On a phone Save is the icon button; its label is visually hidden.
        await press(page.locator('button').filter({ hasText: /^\s*Save\s*$/ }).first());
        await page.waitForURL(/\/v\/2/, { timeout: 15000 });
        const html = await env.DOCS.get(`docs/${slug}/v2/index.html`).then((o) => o.text());
        assert.match(html, /<h1>Launch plan<\/h1>/, 'the cover heading was edited');
        assert.match(html, /<li>Fourth point<\/li>/, 'a bullet was added');
        assert.equal((html.match(/data-tdoc-slide="/g) || []).length, 3, 'still three slides');
        assert.ok(!/contenteditable|data-tdoc-editor|data-tdoc-slides=/.test(html), 'no editor or viewer state saved');
        assert.equal(JSON.parse(await env.META.get(`meta:${slug}`)).title, 'Launch plan', 'titled from the cover');
        if (SHOTS && sheets) {
          await frame.locator('[data-tdoc-slide]').first().waitFor();
          await page.waitForTimeout(600);
          await page.screenshot({ path: path.join(SHOTS, `${label}-blank-deck-saved.png`) });
        }
      });

      assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
    } finally {
      await context.close();
      server.close();
    }
  };

  try {
    for (const sheets of [true, false]) {
      await run('desktop', { width: 1280, height: 860 }, sheets);
      await run('phone', { width: 390, height: 844 }, sheets);
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
