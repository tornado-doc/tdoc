// A press on a menu row acts once: one click, not two (a press that acted
// twice opened and closed Edit and sent DELETE twice). Every row of every menu on the feedback widget, the doc page (text,
// slides, a sheet) and the feedback space page (TDOC_FULL): a real mouse press at a
// person's pace, a tap, Enter and Space; a press held on the menu's button and
// let go on a row acts once, a right press on a row not at all. Then what rows
// of the widget do, for real.
// Run with: node test/menu-one-press-ui.test.js (TDOC_FULL=1: every way everywhere)
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('menu-one-press-ui.test.js');
const TDOC = 'https://tdoc.dev';
const DOC = '<!doctype html><html><body><h1>Pricing plan</h1><p>Alpha line one to comment on.</p><p>Bravo line two to comment on.</p></body></html>';
const SLIDES = '<!doctype html><html><body><section data-tdoc-slide><h1>One</h1><p>Alpha line one to comment on.</p></section><section data-tdoc-slide><h1>Two</h1><p>Bravo line two to comment on.</p></section></body></html>';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme</title></head>
<body><main><h1>Settings</h1><p id="x">Something to comment on.</p><button id="save">Save</button></main>
<script src="/feedback.js" data-tdoc-open="1"></script></body></html>`;
// A person opens a menu, then presses a row: longer than Base UI's 200 ms.
const PACE = 280;

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((a) => [a.path, a]));
  const server = http.createServer(async (request, res) => {
    const pathname = request.url.split('?')[0];
    if (pathname === '/__page') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(PAGE); }
    if (pathname === '/feedback.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'server/runtime/feedback.js')));
    }
    const asset = byPath.get(pathname);
    if (asset) { res.setHeader('content-type', asset.type); return res.end(fs.readFileSync(asset.file)); }
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
      if (['content-length', 'content-encoding', 'content-security-policy'].includes(key)) return;
      res.setHeader(key, key === 'location' ? value.replace(TDOC, '') : value);
    });
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// Counts the clicks each menu row gets, and keeps them from acting while
// `__hold` is set.
function countClicks() {
  window.__clicks = [];
  window.__copied = [];
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied.push(text); } } }); } catch {}
  const listen = (root) => root.addEventListener('click', (event) => {
    const at = event.composedPath()[0];
    const row = event.target === at && at.closest && at.closest('.ui-menu-item');
    if (!row) return;
    window.__clicks.push(row.textContent.trim());
    if (window.__hold) { event.stopImmediatePropagation(); event.preventDefault(); }
  }, true);
  listen(document);
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(init) { const root = attach.call(this, init); listen(root); return root; };
}

(async () => {
  console.log('Menus: one press acts once, on every comment surface');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const call = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`${TDOC}${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: TDOC } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, { waitUntil() {} });
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const sid = 'c'.repeat(32);
  await env.META.put(`session:${sid}`, JSON.stringify({ login: 'julie', name: 'julie', email: 'julie@tdoc.test', avatar_url: '', created: new Date().toISOString() }));
  const cookie = `tdoc_sid=${sid}`;
  const token = (await call('/api/hosted/token', { method: 'POST', cookie, body: { label: 'julie' } })).body.token;
  const { server, base } = await startServer(worker, env);
  const M = await import('../shared/sheet-markup.mjs');
  const sheet = M.sheetDocumentHtml({ title: 'Tracker', sheets: [{ name: 'Tasks', columns: [{ name: 'Task', type: 'text' }, { name: 'Points', type: 'number' }], rows: [{ id: 'r1', cells: ['Alpha line one', '1'] }, { id: 'r2', cells: ['Bravo line two', '2'] }] }] });
  for (const [slug, html] of [['press-doc', DOC], ['press-slides', SLIDES], ['press-sheet', sheet]]) {
    assert.equal((await call('/api/upload', { method: 'POST', token, body: { slug, version: 1, html, meta: { title: slug } } })).status, 200);
    assert.equal((await call('/api/comments', { method: 'POST', cookie, body: { slug, version: 1, text: 'Make this shorter', anchor: { kind: 'text', text: 'Alpha line one' } } })).status, 200);
  }
  const space = (await call('/api/feedback/connect', { method: 'POST', cookie, body: { origin: base } })).body;
  const addThread = async (text) => {
    const r = await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text, anchor: { kind: 'product', url: `${base}/__page`, selector: '#x', tag: 'p', text: 'Something' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id;
  };
  await addThread('Too small');

  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${String(error.stack || error.message).split('\n').slice(0, 14).join('\n    ')}`); } };
  const engines = [['chromium', pw.chromium]];
  if (pw.webkit && fs.existsSync(pw.webkit.executablePath())) engines.push(['webkit', pw.webkit]);

  for (const [engineName, engine] of engines) {
    const browser = await engine.launch({ headless: true });
    const open = async (surface, phone) => {
      const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
      await ctx.addCookies([{ name: 'tdoc_sid', value: sid, url: base }]);
      await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
      await ctx.addInitScript(countClicks);
      if (surface === 'widget') await ctx.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${base}`, JSON.stringify(space)]);
      const page = await ctx.newPage();
      page.errors = [];
      page.on('pageerror', (e) => page.errors.push(e.message));
      const thread = page.locator(surface === 'widget' ? '#tdoc-feedback-root .tdoc-fb-list [data-comment-id]'
        : surface === 'space' ? '.tdoc-fbspace-list [data-comment-id]'
          : phone ? '#tdoc-comment-layer .tdoc-cpanel [data-comment-id]' : '.tdoc-doc-side [data-comment-id]').first();
      // The comment list, open (Escape can close it with a menu).
      const ready = async () => {
        if (await thread.isVisible().catch(() => false)) return;
        const button = page.locator(surface === 'widget' ? '#tdoc-feedback-root .tdoc-feedback-dock button' : phone ? '.tdoc-fab' : '.tdoc-comments-toggle').first();
        if (surface !== 'space') await button.click();
        await thread.waitFor({ timeout: 15000 });
        await page.waitForTimeout(450);
      };
      await page.goto(`${base}${surface === 'widget' ? '/__page' : `/d/${surface === 'space' ? space.slug : surface}`}`);
      if (surface.startsWith('press-')) await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
      if (surface === 'widget') await thread.waitFor({ timeout: 6000 }).catch(() => {});
      await ready();
      await page.waitForTimeout(700);
      return { ctx, page, ready };
    };
    const rows = (page) => page.locator('.ui-menu-popup [role^="menuitem"]:not([aria-disabled="true"]):not([aria-haspopup]):visible, .ui-select-popup [role="option"]:visible');
    const clicks = (page) => page.evaluate(() => window.__clicks.splice(0));
    const middle = async (locator) => { const b = await locator.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
    const pressAt = async (page, [x, y], button = 'left') => {
      await page.mouse.move(x, y);
      await page.mouse.down({ button });
      await page.waitForTimeout(40);
      await page.mouse.up({ button });
    };
    // Each row of each menu on the page, pressed each way: the clicks it got.
    const TRIGGERS = '[aria-haspopup="menu"]:visible, .ui-select-trigger:visible';
    const audit = async (page, only, ways, phone, ready) => {
      await page.evaluate(() => { window.__hold = true; });
      const keys = await page.locator(TRIGGERS).evaluateAll((list) => list.map((el) => el.getAttribute('aria-label') || el.textContent.trim()));
      const menus = keys.map((label, n) => ({ label, nth: keys.slice(0, n).filter((x) => x === label).length })).filter((x) => only.test(x.label));
      const seen = [];
      for (const { label, nth } of menus) {
        const button = () => page.locator(`:is([aria-haspopup="menu"], .ui-select-trigger)[aria-label="${label.replace(/["\\]/g, '\\$&')}"]:visible`).nth(nth);
        const isOpen = async () => (await rows(page).count()) > 0;
        const hide = async () => { for (let k = 0; k < 3 && await isOpen(); k++) { await page.keyboard.press('Escape'); await page.waitForTimeout(phone ? 600 : 160); } await ready(); };
        const show = async () => {
          if (await isOpen()) return true;
          await button().scrollIntoViewIfNeeded();
          const at = await middle(button());
          if (phone) await page.touchscreen.tap(...at); else await pressAt(page, at);
          await page.waitForTimeout(PACE);
          return isOpen();
        };
        await page.waitForTimeout(phone ? 600 : 0);
        await ready();
        await button().scrollIntoViewIfNeeded();
        // Not one under a phone's sheet.
        if (!(await button().evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(el.getRootNode().elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }))) continue;
        assert.ok(await show(), `${label} did not open`);
        const count = await rows(page).count();
        for (let k = 0; k < count; k++) {
          for (const how of ways) {
            // A dropdown's drag is Base UI's own gesture, not a click.
            if (how === 'drag' && label === 'Order') continue;
            if (k && !process.env.TDOC_FULL && !['left', 'right', 'tap'].includes(how)) continue;
            await hide();
            if (how === 'drag') {
              await page.mouse.move(...await middle(button()));
              await page.mouse.down();
              await page.waitForTimeout(PACE);
              await page.mouse.move(...await middle(rows(page).nth(k)), { steps: 4 });
              await page.waitForTimeout(40);
              await clicks(page);
              await page.mouse.up();
            } else {
              assert.ok(await show(), `${label} did not open again`);
              const row = rows(page).nth(k);
              await clicks(page);
              if (how === 'Enter' || how === 'Space') await row.press(how);
              else if (how === 'tap') await page.touchscreen.tap(...await middle(row));
              else await pressAt(page, await middle(row), how);
            }
            await page.waitForTimeout(120);
            const got = await clicks(page);
            seen.push({ menu: label, row: k, how, got: got.length, want: how === 'right' ? 0 : 1, text: got[0] || '' });
          }
        }
        await hide();
      }
      await page.evaluate(() => { window.__hold = false; });
      return seen;
    };

    // TDOC_FULL: every way on every surface (many minutes). Else the widget,
    // whose presses are relayed, with the ways besides a press on each menu's
    // first row; and a press on the doc page, in one engine. Both engines do
    // the rows of the widget for real, below.
    const full = !!process.env.TDOC_FULL;
    const menus = /^(More actions|Comment list actions|Order)$/;
    const surfaces = full ? ['widget', 'press-doc', 'press-slides', 'press-sheet', 'space'] : engineName === 'chromium' ? ['widget', 'press-doc'] : [];
    for (const surface of surfaces) {
      for (const phone of [false, true]) {
        await t(`${engineName} ${surface} ${phone ? 'phone' : 'desktop'}: every row of every menu, one click a press`, async () => {
          const { ctx, page, ready } = await open(surface, phone);
          const seen = await audit(page, menus, phone ? ['tap'] : full || surface === 'widget' ? ['left', 'right', 'Enter', 'Space', 'drag'] : ['left'], phone, ready);
          if (process.env.TDOC_DEBUG) console.log(seen.map((x) => `      ${x.menu} / ${x.text || x.row} / ${x.how}: ${x.got}`).join('\n'));
          await ctx.close();
          assert.deepEqual(seen.filter((x) => x.got !== x.want).map((x) => `${x.menu} / ${x.text || x.row} / ${x.how}: ${x.got} clicks`), []);
          assert.ok(new Set(seen.map((x) => x.menu)).size >= 2, `menus: ${[...new Set(seen.map((x) => x.menu))]}`);
        });
      }
    }
    for (const phone of [false, true]) {
      await t(`${engineName} widget ${phone ? 'phone' : 'desktop'}: what its rows do, they do once`, async () => {
        const id = await addThread(`Remove me ${engineName} ${phone}`);
        const { ctx, page, ready } = await open('widget', phone);
        const requests = [];
        page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/comments')) requests.push(r.method()); });
        const root = page.locator('#tdoc-feedback-root');
        const card = root.locator(`.tdoc-fb-list [data-comment-id="${id}"]`);
        const choose = async (button, row) => {
          await button.scrollIntoViewIfNeeded();
          for (const [i, at] of [button, root.locator(`.ui-menu-popup ${row}`)].entries()) {
            if (i) await at.waitFor();
            await page.waitForTimeout(PACE);
            const point = await middle(at);
            if (phone) await page.touchscreen.tap(...point); else await pressAt(page, point);
          }
          await page.waitForTimeout(PACE);
        };
        const more = card.locator('[aria-label="More actions"]');
        await choose(more, '.tdoc-copy-for-agent');
        assert.equal((await page.evaluate(() => window.__copied)).length, 1, 'copies');
        const markers = root.locator('.tdoc-comment-list-more');
        const pins = async () => root.locator('.tdoc-pin').count();
        const before = await pins();
        await choose(markers, '.tdoc-toggle-markers');
        assert.ok(before > 0 && await pins() === 0, `markers: ${before} -> ${await pins()}`);
        await choose(markers, '.tdoc-toggle-markers');
        assert.equal(await pins(), before, 'markers back');
        await choose(more, '.tdoc-edit-toggle');
        const box = root.locator('.tdoc-edit-form textarea');
        assert.ok(await box.isVisible(), 'Edit did not stay open');
        await box.fill('Reworded');
        await root.locator('.tdoc-edit-save').click();
        await box.waitFor({ state: 'detached', timeout: 5000 });
        await card.getByText('Reworded').waitFor({ timeout: 5000 });
        assert.equal(requests.splice(0).join(), 'PATCH');
        await choose(more, '.del');
        await card.waitFor({ state: 'detached', timeout: 5000 });
        await page.waitForTimeout(300);
        assert.equal(requests.splice(0).join(), 'DELETE');
        await ready();
        await choose(root.locator('.tdoc-fb-list [data-comment-id] [aria-label="More actions"]').first(), '.tdoc-reanchor-btn');
        assert.ok(!(await root.locator('.tdoc-fb-panel').isVisible()), 'Move anchor closes the list to pick a place');
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    }
    await browser.close();
  }
  server.close();
  console.log(failed ? `\nFAIL — ${failed} failed` : '\nPASS');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
