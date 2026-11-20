// Copy for agent and the comment keys (flag copyForAgent), on every comment
// surface: the doc page (side list on desktop, drawer on a phone), the
// feedback widget on a host page, and the feedback space page.
//   - flag off: nothing new (no ⋯ on the list, no row in a thread's ⋯, C does nothing)
//   - a thread's ⋯ › Copy for agent: that thread as Markdown, with its tdoc link
//   - the list's ⋯ › Copy N open for agent: every open thread, and the toast
//   - C copies the selected thread, else every open one; never while typing
//     (the search box, the reply box / composer)
//   - H hides and shows the markers (pins); Esc still closes the list
// TDOC_UI_SHOTS=<dir> saves screenshots (the PR's).
// Run with: node test/copy-for-agent-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('copy-for-agent-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TDOC = 'https://tdoc.dev';
const DOC = `<!doctype html><html><body><h1>Pricing plan</h1><p>Alpha line one to comment on.</p><p>Bravo line two to comment on.</p><p>Charlie line three to comment on.</p></body></html>`;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme settings</title></head>
<body><main><h1>Settings</h1><p id="x">Something to comment on.</p><p id="y">Something else.</p><button id="save" aria-label="Save changes">Save</button></main>
<script src="/feedback.js" data-tdoc-open="1"></script></body></html>`;

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

async function settle(locator) {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const box = JSON.stringify(await locator.boundingBox());
    if (box === last) return;
    last = box;
    await new Promise((r) => setTimeout(r, 150));
  }
}

(async () => {
  console.log('Copy for agent: every comment surface');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const call = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`${TDOC}${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: TDOC } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const sid = 'b'.repeat(32);
  await env.META.put(`session:${sid}`, JSON.stringify({ login: 'julie', name: 'julie', email: 'julie@tdoc.test', avatar_url: '', created: new Date().toISOString() }));
  const cookie = `tdoc_sid=${sid}`;
  const token = (await call('/api/hosted/token', { method: 'POST', cookie, body: { label: 'julie' } })).body.token;
  const { server, base } = await startServer(worker, env);

  const slug = 'copy-agent';
  assert.equal((await call('/api/upload', { method: 'POST', token, body: { slug, version: 1, html: DOC, meta: { title: 'Pricing plan' } } })).status, 200);
  const space = (await call('/api/feedback/connect', { method: 'POST', cookie, body: { origin: base } })).body;
  assert.ok(space.slug && space.token, JSON.stringify(space));
  const docIds = [];
  for (const [text, words] of [['Make this *shorter*', 'Alpha line one'], ['Wrong number here', 'Bravo line two'], ['Done already', 'Charlie line three']]) {
    const d = await call('/api/comments', { method: 'POST', cookie, body: { slug, version: 1, text, anchor: { kind: 'text', text: words } } });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    docIds.push(d.body.id);
  }
  assert.equal((await call('/api/comments', { method: 'POST', cookie, body: { slug, version: 1, text: 'Agreed', parent_id: docIds[0] } })).status, 200);
  assert.equal((await call('/api/comments', { method: 'PATCH', cookie, body: { slug, version: 1, id: docIds[2], resolved: true } })).status, 200);
  const anchor = {
    kind: 'product', url: `${base}/__page`, selector: '#save', tag: 'button', text: 'Save', accessible_name: 'Save changes',
    state: { dialog: 'Billing settings', tabs: ['Plans'] }, rect: { x: 10, y: 120, width: 60, height: 28 },
    viewport: { width: 1280, height: 800, device_pixel_ratio: 1 },
  };
  const w1 = await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: 'Save button is too small', anchor } });
  assert.equal(w1.status, 200, JSON.stringify(w1.body));
  const w2 = await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: 'Typo in this line', anchor: { kind: 'product', url: `${base}/__page`, selector: '#x', tag: 'p', text: 'Something to comment on.' } } });
  assert.equal(w2.status, 200);

  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${String(error.stack || error.message).split('\n').slice(0, 14).join('\n    ')}`); } };
  const chromium = await pw.chromium.launch({ headless: true });

  // The clipboard, read back: writeText records what was copied.
  const newPage = async (width, { flag = true, widget = false } = {}) => {
    const phone = width < 700;
    const ctx = await chromium.newContext(phone ? { viewport: { width, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width, height: 800 } });
    await ctx.addCookies([{ name: 'tdoc_sid', value: sid, url: base }]);
    await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    await ctx.addInitScript(([on]) => {
      window.__TDOC_FLAGS__ = { ...(window.__TDOC_FLAGS__ || {}), copyForAgent: on };
      window.__copied = [];
      try {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied.push(text); } } });
      } catch {}
    }, [flag]);
    if (widget) await ctx.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${base}`, JSON.stringify(space)]);
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    return { ctx, page };
  };
  const copied = (page) => page.evaluate(() => window.__copied.slice());
  const lastCopied = async (page) => { const all = await copied(page); return all[all.length - 1] || ''; };
  const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
  const waitCopies = async (page, n) => { for (let i = 0; i < 40 && (await copied(page)).length < n; i++) await page.waitForTimeout(50); assert.equal((await copied(page)).length, n, 'copies'); };

  const openDoc = async (width, opts) => {
    const { ctx, page } = await newPage(width, opts);
    await page.goto(`${base}/d/${slug}`);
    await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    let list;
    if (width < 700) {
      list = page.locator('#tdoc-comment-layer .tdoc-cpanel');
      if (!(await list.isVisible().catch(() => false))) await page.locator('.tdoc-fab').click();
    } else {
      if (!(await page.locator('.tdoc-doc-side').isVisible().catch(() => false))) await page.locator('.tdoc-comments-toggle').click();
      list = page.locator('.tdoc-doc-side .tdoc-cpanel');
    }
    await list.locator('.tdoc-comment-filter').waitFor({ timeout: 15000 });
    await list.locator('[data-comment-id]').first().waitFor();
    await settle(list);
    return { ctx, page, list };
  };

  try {
    await t('flag off: no list ⋯, no Copy for agent in a thread\'s ⋯, C copies nothing (doc page)', async () => {
      const { ctx, page, list } = await openDoc(1280, { flag: false });
      assert.equal(await list.locator('.tdoc-comment-list-more').count(), 0);
      await list.locator('[data-comment-id] .tdoc-cc-icon[aria-label="More actions"]').first().click();
      await page.locator('.ui-menu-popup').waitFor();
      assert.equal(await page.locator('.tdoc-copy-for-agent').count(), 0);
      await page.keyboard.press('Escape');
      await page.locator('body').click({ position: { x: 5, y: 400 } }).catch(() => {});
      await page.keyboard.press('c');
      assert.deepEqual(await copied(page), []);
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    for (const width of [1280, 390]) {
      const tag = width < 700 ? 'phone' : 'desktop';
      await t(`doc page ${tag}: list ⋯ copies every open thread as Markdown, with a toast`, async () => {
        const { ctx, page, list } = await openDoc(width);
        await list.locator('.tdoc-comment-list-more').click();
        const item = page.locator('.tdoc-copy-open-for-agent');
        await item.waitFor();
        if (width < 700) {
          // A touch screen: the same rows, no key hints.
          assert.equal((await item.innerText()).trim(), 'Copy 2 open for agent');
          assert.equal((await page.locator('.tdoc-toggle-markers').innerText()).trim(), 'Hide comment markers');
          assert.equal(await page.locator('.tdoc-comment-keys-hint').isVisible(), false);
          // The ⋯ ends the search row; the filter row keeps its room.
          assert.equal(await list.locator('.tdoc-comment-query .tdoc-comment-list-more').count(), 1);
          const cut = await list.locator('.tdoc-comment-filter [role="radio"]').evaluateAll((els) => els.filter((b) => b.scrollWidth > b.clientWidth + 0.5).map((b) => b.textContent));
          assert.deepEqual(cut, [], 'a filter label is cut off');
        } else {
          assert.match(await item.innerText(), /Copy 2 open for agent\s*C/);
          assert.match(await page.locator('.tdoc-toggle-markers').innerText(), /Hide comment markers\s*H/);
          assert.match(await page.locator('.tdoc-comment-keys-hint').innerText(), /Esc closes/);
        }
        await shot(page, `doc-${tag}-list-menu`);
        await item.click();
        await waitCopies(page, 1);
        const text = await lastCopied(page);
        assert.match(text, /^# 2 open comments on Pricing plan\nPage: <http:\/\/127\.0\.0\.1:\d+\/d\/copy-agent>/);
        assert.ok(text.includes('> Make this *shorter*') && text.includes('> Wrong number here') && !text.includes('Done already'), text);
        assert.ok(text.includes('- on the words:\n  > Alpha line one') && text.includes(`?comment=${docIds[0]}>`) && text.includes('Replies:\n- julie:\n  > Agreed'), text);
        await page.locator('.tdoc-toast, [role="status"]').filter({ hasText: 'Copied 2 open comments for agent' }).first().waitFor();
        await shot(page, `doc-${tag}-copied-toast`);
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });

      await t(`doc page ${tag}: a thread's ⋯ › Copy for agent copies that thread only`, async () => {
        const { ctx, page, list } = await openDoc(width);
        const card = list.locator(`[data-comment-id="${docIds[1]}"]`);
        await card.locator('.tdoc-cc-icon[aria-label="More actions"]').click();
        await page.locator('.tdoc-copy-for-agent').waitFor();
        assert.match(await page.locator('.tdoc-copy-for-agent').innerText(), width < 700 ? /^Copy for agent$/ : /Copy for agent\s*C/);
        await shot(page, `doc-${tag}-thread-menu`);
        await page.locator('.tdoc-copy-for-agent').click();
        await waitCopies(page, 1);
        const text = await lastCopied(page);
        assert.match(text, /^# 1 comment on Pricing plan/);
        assert.ok(text.includes('> Wrong number here') && !text.includes('shorter') && text.includes(`- id: \`${docIds[1]}\``), text);
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    }

    await t('doc page desktop: C copies all open, then the selected thread; never from the search box; H hides the pins; Esc closes the list', async () => {
      const { ctx, page, list } = await openDoc(1280);
      await page.locator('.tdoc-pin').first().waitFor();
      await page.locator('.tdoc-cpanel-title').click();
      await page.keyboard.press('c');
      await waitCopies(page, 1);
      assert.match(await lastCopied(page), /^# 2 open comments/);
      await list.locator(`[data-comment-id="${docIds[1]}"] .tdoc-cc-head`).click();
      await list.locator(`[data-comment-id="${docIds[1]}"][aria-current="true"]`).waitFor();
      await page.keyboard.press('c');
      await waitCopies(page, 2);
      assert.match(await lastCopied(page), /^# 1 comment on Pricing plan[\s\S]*Wrong number here/);
      await list.locator('.tdoc-comment-search').fill('');
      await list.locator('.tdoc-comment-search').press('c');
      assert.equal(await list.locator('.tdoc-comment-search').inputValue(), 'c', 'the letter did not reach the search box');
      assert.equal((await copied(page)).length, 2, 'C in the search box copied');
      await list.locator('.tdoc-comment-search').fill('');
      await page.locator('.tdoc-cpanel-title').click();
      await page.keyboard.press('h');
      await page.waitForFunction(() => document.querySelector('.tdoc-document-app')?.hasAttribute('data-markers-hidden'));
      assert.equal(await page.locator('.tdoc-pin:visible').count(), 0, 'pins still showing');
      await shot(page, 'doc-desktop-markers-hidden');
      await page.keyboard.press('h');
      await page.locator('.tdoc-pin').first().waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.locator('.tdoc-doc-side').waitFor({ state: 'hidden' });
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    const openWidget = async (width, opts = {}) => {
      const { ctx, page } = await newPage(width, { ...opts, widget: true });
      await page.goto(`${base}/__page`);
      const list = page.locator('#tdoc-feedback-root .tdoc-fb-list');
      const opened = await list.locator('.tdoc-comment-filter').waitFor({ timeout: 8000 }).then(() => true, () => false);
      if (!opened) await page.locator('#tdoc-feedback-root .tdoc-feedback-dock button').first().click();
      await list.locator('[data-comment-id]').first().waitFor({ timeout: 15000 });
      await settle(list);
      return { ctx, page, list };
    };

    for (const width of [1280, 390]) {
      const tag = width < 700 ? 'phone' : 'desktop';
      await t(`widget ${tag}: list ⋯ and a thread's ⋯ copy with element, selector, accessible name, state and area; toast`, async () => {
        const { ctx, page, list } = await openWidget(width);
        await list.locator('.tdoc-comment-list-more').click();
        await page.locator('.tdoc-copy-open-for-agent').waitFor();
        assert.match(await page.locator('.tdoc-copy-open-for-agent').innerText(), /Copy 2 open for agent/);
        await shot(page, `widget-${tag}-list-menu`);
        await page.locator('.tdoc-copy-open-for-agent').click();
        await waitCopies(page, 1);
        const all = await lastCopied(page);
        assert.match(all, /^# 2 open comments on Acme settings\nPage: <http:\/\/127\.0\.0\.1:\d+\/__page>/);
        assert.ok(all.includes('- element: `#save` "Save changes" (button)') && all.includes('- state: dialog "Billing settings" · tab Plans')
          && all.includes('- area: 60×28px at 10,120 · viewport 1280×800') && all.includes(`/d/${space.slug}?comment=${w1.body.id}>`), all);
        await page.locator('#tdoc-feedback-root .tdoc-fb-toast').filter({ hasText: 'Copied 2 open comments for agent' }).waitFor();
        await shot(page, `widget-${tag}-copied-toast`);
        await list.locator(`[data-comment-id="${w2.body.id}"] .tdoc-cc-icon[aria-label="More actions"]`).click();
        await page.locator('.tdoc-copy-for-agent').click();
        await waitCopies(page, 2);
        const one = await lastCopied(page);
        assert.ok(one.startsWith('# 1 comment on Acme settings') && one.includes('Typo in this line') && !one.includes('Save button'), one);
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    }

    await t('widget desktop: C copies, not from the search box or the composer; H hides the pins; Esc closes the list; flag off: nothing', async () => {
      const { ctx, page, list } = await openWidget(1280);
      await page.locator('#tdoc-feedback-root .tdoc-pin').first().waitFor();
      await page.locator('h1').click();
      await page.keyboard.press('c');
      await waitCopies(page, 1);
      assert.match(await lastCopied(page), /^# 2 open comments on Acme settings/);
      await list.locator('.tdoc-comment-search').press('c');
      assert.equal(await list.locator('.tdoc-comment-search').inputValue(), 'c');
      assert.equal((await copied(page)).length, 1, 'C in the search box copied');
      await list.locator('.tdoc-comment-search').fill('');
      await page.locator('h1').click();
      await page.keyboard.press('h');
      await page.waitForFunction(() => !document.querySelector('#tdoc-feedback-root')?.shadowRoot?.querySelector('.tdoc-pin') && !document.querySelector('#tdoc-feedback-root .tdoc-pin'));
      await shot(page, 'widget-desktop-markers-hidden');
      await page.keyboard.press('h');
      await page.locator('#tdoc-feedback-root .tdoc-pin').first().waitFor();
      // A thread opened on the page: C copies it; typing a reply is typing.
      await page.locator('#tdoc-feedback-root .tdoc-pin').first().click();
      const card = page.locator('#tdoc-feedback-root .tdoc-floating-open');
      await card.waitFor();
      await page.locator('h1').click({ position: { x: 2, y: 2 } }).catch(() => {});
      if (await card.isVisible()) {
        await card.locator('.tdoc-cc-head').click();
        await page.keyboard.press('c');
        await waitCopies(page, 2);
        assert.match(await lastCopied(page), /^# 1 comment on Acme settings/);
      }
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await list.waitFor({ state: 'detached' });
      const before = (await copied(page)).length;
      await page.locator('h1').click();
      await page.keyboard.press('c');
      await page.waitForTimeout(200);
      assert.equal((await copied(page)).length, before, 'C copied with the comment layer closed (the host page\'s key)');
      assert.deepEqual(page.errors, []);
      await ctx.close();
      const off = await openWidget(1280, { flag: false });
      assert.equal(await off.list.locator('.tdoc-comment-list-more').count(), 0);
      await off.page.locator('h1').click();
      await off.page.keyboard.press('c');
      await off.page.waitForTimeout(200);
      assert.deepEqual(await copied(off.page), []);
      await off.ctx.close();
    });

    for (const width of [1280, 390]) {
      const tag = width < 700 ? 'phone' : 'desktop';
      await t(`space page ${tag}: list ⋯ copies every open thread; ?comment= selects a thread and C copies it`, async () => {
        const { ctx, page } = await newPage(width);
        await page.goto(`${base}/d/${space.slug}`);
        const list = page.locator('.tdoc-fbspace-list');
        await list.locator('[data-comment-id]').first().waitFor({ timeout: 15000 });
        await list.locator('.tdoc-comment-list-more').click();
        await page.locator('.tdoc-copy-open-for-agent').waitFor();
        assert.equal(await page.locator('.tdoc-toggle-markers').count(), 0, 'the space page has no markers');
        await shot(page, `space-${tag}-list-menu`);
        await page.locator('.tdoc-copy-open-for-agent').click();
        await waitCopies(page, 1);
        const text = await lastCopied(page);
        assert.ok(text.startsWith('# 2 open comments on ') && text.includes('Save button is too small') && text.includes('- page: <http://127.0.0.1:'), text);
        await page.getByText('Copied 2 open comments for agent').waitFor();
        await page.goto(`${base}/d/${space.slug}?comment=${encodeURIComponent(w2.body.id)}`);
        await list.locator(`[data-comment-id="${w2.body.id}"][aria-current="true"]`).waitFor({ timeout: 15000 });
        await page.locator('h1').click();
        await page.keyboard.press('c');
        await waitCopies(page, 1);
        const one = await lastCopied(page);
        assert.ok(one.startsWith('# 1 comment on ') && one.includes('Typo in this line'), one);
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    }
  } finally {
    await chromium.close();
    server.close();
  }
  console.log(failed ? `\nFAIL — ${failed} failed` : '\nPASS');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
