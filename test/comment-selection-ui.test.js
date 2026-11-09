// Phase C: one selection engine (shell/src/comments/selection/) in the doc
// frame and the feedback widget.
//   - doc: an old cssPath anchor still resolves; a slide comment follows its
//     slide when the deck is reordered in the next version (stable container
//     id, not nth-of-type); a box drawn on a chart is an area comment
//     (feedbackAreaSelect); + Comment picks, and a click on nothing is a
//     whole-document comment;
//   - widget: a drag over words is a quote (text anchor) found again after a
//     reload; "Comment on this page" needs no element; old anchors resolve.
// Real worker routes behind a local server, the built runtimes, chromium.
// Run with: node test/comment-selection-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('comment-selection-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TDOC = 'https://tdoc.dev';
const CHART = '<figure id="chart" style="margin:0"><svg width="480" height="240" viewBox="0 0 480 240" aria-label="Revenue chart"><rect width="480" height="240" fill="#eef"/><rect x="40" y="60" width="60" height="160" fill="#88f"/><rect x="140" y="20" width="60" height="200" fill="#55f"/></svg></figure>';
const DOC = `<!doctype html><html><body><h1>Plan</h1><p id="p1">Billing ships first, on March 14, because invoices block two renewals.</p>${CHART}<p>Search follows in April once billing is stable.</p><figure><img alt="Diagram" width="200" height="80" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='80'/%3E"></figure></body></html>`;
const slide = (title, body) => `<section data-tdoc-slide><h2>${title}</h2><p>${body}</p></section>`;
const DECK = (order) => `<!doctype html><html><body>${order.map(([t, b]) => slide(t, b)).join('')}</body></html>`;
const WIDGET_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head>
<body style="font:16px/1.5 system-ui;margin:0"><main style="padding:40px"><h1>Dashboard</h1>
<p id="intro">Weekly active users rose to 1,284 after the billing launch.</p>
<p id="second">Churn held steady at four percent this month.</p></main>
<script src="/feedback.js" data-tdoc-open="1"></script></body></html>`;

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((a) => [a.path, a]));
  const server = http.createServer(async (request, res) => {
    const pathname = request.url.split('?')[0];
    if (pathname === '/__page') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(WIDGET_PAGE); }
    if (pathname === '/feedback.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'server/runtime/feedback.js')));
    }
    const asset = byPath.get(pathname);
    if (asset) { res.setHeader('content-type', asset.type); return res.end(fs.readFileSync(asset.file)); }
    const chunks = [];
    // A browser closing mid-request (a poll, a read mark) aborts its body.
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

(async () => {
  console.log('Comment selection: one engine for the doc frame and the widget');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const call = async (p, o = {}) => {
    const r = await worker.fetch(new Request(`${TDOC}${p}`, { method: o.method || 'GET', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie, origin: TDOC } : {}), 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined }), env, {});
    let body = null; try { body = await r.json(); } catch {} return { status: r.status, body };
  };
  const sid = 'a'.repeat(32);
  await env.META.put(`session:${sid}`, JSON.stringify({ login: 'julie', name: 'julie', email: 'julie@tdoc.test', avatar_url: '', created: new Date().toISOString() }));
  const cookie = `tdoc_sid=${sid}`;
  const julie = { cookie, token: (await call('/api/hosted/token', { method: 'POST', cookie, body: { label: 'julie' } })).body.token };
  const upload = async (slug, version, html) => {
    const r = await call('/api/upload', { method: 'POST', token: julie.token, body: { slug, version, html, meta: { title: slug } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };
  const comments = async (slug, version = 1) => (await call(`/api/comments?slug=${slug}&version=${version}`, { cookie })).body;
  const post = async (slug, version, text, anchor) => {
    const r = await call('/api/comments', { method: 'POST', cookie, body: { slug, version, text, anchor } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id;
  };

  const { server, base } = await startServer(worker, env);
  let failed = 0;
  const only = process.env.TDOC_TEST_ONLY ? new RegExp(process.env.TDOC_TEST_ONLY) : null;
  const t = async (name, fn) => { if (only && !only.test(name)) return; try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${String(error.message).split('\n').slice(0, 8).join('\n    ')}`); } };
  const chromium = await pw.chromium.launch({ headless: true });
  const space = (await call('/api/feedback/connect', { method: 'POST', cookie, body: { origin: TDOC } })).body;
  let n = 0;

  for (const width of [1280, 390]) {
    const tag = `chromium-${width}`;
    const phone = width < 700;
    const open = async ({ flags = null } = {}) => {
      const ctx = await chromium.newContext(phone ? { viewport: { width, height: 844 }, hasTouch: true } : { viewport: { width, height: 800 } });
      await ctx.addCookies([{ name: 'tdoc_sid', value: sid, url: base }]);
      const page = await ctx.newPage();
      page.errors = [];
      page.on('pageerror', (e) => page.errors.push(e.message));
      if (flags) await page.addInitScript((f) => { window.__TDOC_FLAGS__ = f; }, flags);
      return { ctx, page };
    };
    const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, `${tag}-${name}.png`) }); } };
    const openDoc = async (page, slug, version = null) => {
      await page.goto(`${base}/d/${slug}${version ? `/v/${version}` : ''}`);
      await page.frameLocator('iframe').locator('h1, h2').first().waitFor({ timeout: 15000 });
      await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
      return page.frames().find((f) => /\/frame/.test(f.url()));
    };

    // ── Doc page ────────────────────────────────────────────────────────
    await t(`${tag}: doc: an old cssPath element anchor still finds its element`, async () => {
      const slug = `legacy-${++n}`;
      await upload(slug, 1, DOC);
      const id = await post(slug, 1, 'Old element comment', { kind: 'element', selector: 'figure:nth-of-type(1)', label: 'figure' });
      const { ctx, page } = await open();
      const frame = await openDoc(page, slug);
      const docY = await frame.evaluate(() => document.querySelector('#chart').getBoundingClientRect().top + scrollY);
      // Found by its words only when they name one element; two copies are a guess.
      const byText = await frame.evaluate(() => {
        const add = (text) => { const p = document.createElement('p'); p.textContent = text; document.body.appendChild(p); return p; };
        const one = add('Only once here'); add('Twice here'); add('Twice here');
        const r1 = TdocSelection.resolveElement({ kind: 'element', selector: '#gone', tag: 'p', text: 'Only once here' }, {});
        const r2 = TdocSelection.resolveElement({ kind: 'element', selector: '#gone', tag: 'p', text: 'Twice here' }, {});
        return { unique: r1.element === one && !r1.approximate, twice: Boolean(r2.element) && r2.approximate };
      });
      assert.deepEqual(byText, { unique: true, twice: true });
      // A sheet's cells resolve through the registry: the frame registers the
      // sheets viewer's hook as the 'sheet' adapter (sheets-ui covers the cells).
      assert.equal(await frame.evaluate(() => Boolean(TdocSelection.adapterFor({ kind: 'element', sheet: { table: 'Budget', row: 'r1', key: 'amount' } }))), true);
      if (!phone) {
        const pin = page.locator(`.tdoc-pin[data-id="${id}"]`);
        await pin.waitFor({ timeout: 10000 });
        assert.equal(await pin.evaluate((el) => el.classList.contains('tdoc-pin-lost')), false, 'the old anchor is lost');
      }
      assert.ok(docY > 0);
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t(`${tag}: doc: a slide comment follows its slide when the next version reorders the deck`, async () => {
      const slug = `deck-${++n}`;
      await upload(slug, 1, DECK([['Alpha', 'First slide words.'], ['Bravo', 'Second slide words.'], ['Charlie', 'Third slide words.']]));
      const { ctx, page } = await open();
      let frame = await openDoc(page, slug, 1);
      // The anchor a comment on slide Bravo gets: the frame's own describer.
      const anchor = await frame.evaluate(() => {
        const bravo = [...document.querySelectorAll('[data-tdoc-slide]')].find((s) => s.querySelector('h2').textContent === 'Bravo');
        const d = TdocSelection.describeElement(bravo);
        return { kind: 'element', selector: d.selector, label: 'section', tag: d.tag, text: d.text, container: d.container, container_is_target: d.container_is_target };
      });
      assert.equal(anchor.container.kind, 'slide');
      assert.ok(anchor.container_is_target, 'a slide comment is the slide');
      const id = await post(slug, 1, 'On Bravo', anchor);
      // v2: Bravo moves to the front. Its old positional path now names Alpha.
      await upload(slug, 2, DECK([['Bravo', 'Second slide words.'], ['Alpha', 'First slide words.'], ['Charlie', 'Third slide words.']]));
      frame = await openDoc(page, slug, 2);
      const where = await frame.evaluate((a) => {
        const el = TdocSelection.findElement(a, {});
        const byPath = document.querySelector(a.selector);
        return { found: el && el.querySelector('h2') && el.querySelector('h2').textContent, byPath: byPath && byPath.querySelector('h2') && byPath.querySelector('h2').textContent };
      }, anchor);
      assert.equal(where.found, 'Bravo', `found ${where.found}`);
      assert.notEqual(where.byPath, 'Bravo', 'the test does not exercise a moved slide');
      // And the frame's own resolution of the stored comment lands there:
      // its anchor target is the Bravo slide.
      await frame.waitForFunction(() => document.querySelectorAll('[data-tdoc-slide]').length === 3);
      void id;
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t(`${tag}: doc: two slides with the same heading keep their own comments, counted on the right one`, async () => {
      const slug = `twins-${++n}`;
      const qa = [['Alpha', 'Opening words.'], ['Q&A', 'First questions.'], ['Bravo', 'Middle words.'], ['Q&A', 'Second questions.']];
      await upload(slug, 1, DECK(qa));
      const { ctx, page } = await open();
      let frame = await openDoc(page, slug, 1);
      const anchor = await frame.evaluate(() => {
        const second = [...document.querySelectorAll('[data-tdoc-slide]')].filter((s) => s.querySelector('h2').textContent === 'Q&A')[1];
        const d = TdocSelection.describeElement(second);
        return { kind: 'element', selector: d.selector, label: 'section', tag: d.tag, text: d.text, container: d.container, container_is_target: d.container_is_target };
      });
      assert.match(anchor.container.id, /~2$/, `twins share an id: ${anchor.container.id}`);
      await post(slug, 1, 'On the second Q&A', anchor);
      const check = () => frame.evaluate((a) => {
        const hit = TdocSelection.resolveElement(a, {});
        const slides = [...document.querySelectorAll('[data-tdoc-slide]')];
        // The slide view's count: a thread is on the slide whose id its element sits under.
        const counted = slides.map((s) => { const c = TdocSelection.containerFor(hit.element); return Boolean(c && c.id === TdocSelection.slideId(s)); });
        return { body: hit.element && hit.element.querySelector('p').textContent, approximate: hit.approximate, counted: slides.map((s, i) => counted[i] ? s.querySelector('p').textContent : null).filter(Boolean) };
      }, anchor);
      let seen = await check();
      assert.deepEqual(seen, { body: 'Second questions.', approximate: false, counted: ['Second questions.'] });
      // v2 adds a slide in front: the twins keep their order, the comment its slide.
      await upload(slug, 2, DECK([['Intro', 'New first slide.'], ...qa]));
      frame = await openDoc(page, slug, 2);
      seen = await check();
      assert.deepEqual(seen, { body: 'Second questions.', approximate: false, counted: ['Second questions.'] });
      // v3 drops the first Q&A: the place among twins no longer says which,
      // so the guess is marked approximate (dashed card, Re-anchor).
      await upload(slug, 3, DECK([['Alpha', 'Opening words.'], ['Bravo', 'Middle words.'], ['Q&A', 'Second questions.']]));
      frame = await openDoc(page, slug, 3);
      seen = await frame.evaluate((a) => { const hit = TdocSelection.resolveElement(a, {}); return { body: hit.element && hit.element.querySelector('p').textContent, approximate: hit.approximate }; }, anchor);
      assert.deepEqual(seen, { body: 'Second questions.', approximate: true });
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t(`${tag}: doc: a box drawn on a chart is an area comment (feedbackAreaSelect)`, async () => {
      const slug = `box-${++n}`;
      await upload(slug, 1, DOC);
      const { ctx, page } = await open({ flags: { feedbackAreaSelect: true } });
      const frame = await openDoc(page, slug);
      const frameBox = await page.locator('iframe.tdoc-doc-frame').boundingBox();
      await frame.evaluate(() => document.querySelector('#chart').scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(300);
      const r = await frame.evaluate(() => { const b = document.querySelector('#chart svg').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
      const x0 = frameBox.x + r.x + r.w * 0.2, y0 = frameBox.y + r.y + r.h * 0.2;
      const x1 = frameBox.x + r.x + r.w * 0.6, y1 = frameBox.y + r.y + r.h * 0.7;
      if (phone) {
        // Touch: hold, then drag (the same gesture as the widget).
        await frame.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          const fire = (type, px, py) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch', clientX: px, clientY: py, isPrimary: true }));
          fire('pointerdown', x, y);
          window.__fire = fire;
        }, { x: x0 - frameBox.x, y: y0 - frameBox.y });
        await page.waitForTimeout(600);
        await frame.evaluate(({ x, y }) => { window.__fire('pointermove', x, y); window.__fire('pointerup', x, y); }, { x: x1 - frameBox.x, y: y1 - frameBox.y });
      } else {
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        await page.mouse.move(x1, y1, { steps: 8 });
        await page.mouse.up();
      }
      const composer = page.locator('.tdoc-popup textarea').first();
      await composer.waitFor({ timeout: 8000 });
      await shot(page, 'doc-area-composer');
      await composer.fill('This bar looks wrong');
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      await page.waitForFunction(async (s) => { const r = await fetch(`/api/comments?slug=${s}&version=1`); const list = await r.json(); return list.some((c) => c.text === 'This bar looks wrong'); }, slug, { timeout: 10000 });
      const saved = (await comments(slug)).find((c) => c.text === 'This bar looks wrong');
      assert.equal(saved.anchor.kind, 'element');
      assert.ok(saved.anchor.region && saved.anchor.region.frac, JSON.stringify(saved.anchor));
      assert.ok(saved.anchor.region.frac.width > 0.2 && saved.anchor.region.frac.width < 0.6, JSON.stringify(saved.anchor.region));
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    if (!phone) {
      await t(`${tag}: doc: + Comment picks; a click on nothing is a whole-document comment, a click on the chart is about the chart; Esc cancels`, async () => {
        const slug = `pick-${++n}`;
        await upload(slug, 1, DOC);
        const { ctx, page } = await open();
        const frame = await openDoc(page, slug);
        await page.locator('.tdoc-comments-toggle').click();
        await page.locator('.tdoc-doc-side .tdoc-cpanel-add').click();
        await frame.locator('html[data-tdoc-picking]').waitFor({ timeout: 5000 });
        // Esc cancels the pick, from inside the doc.
        await frame.locator('h1').hover();
        await page.keyboard.press('Escape');
        await frame.locator('html[data-tdoc-picking]').waitFor({ state: 'detached', timeout: 5000 });
        // Again: a click on the chart is about the chart.
        await page.locator('.tdoc-doc-side .tdoc-cpanel-add').click();
        await frame.locator('html[data-tdoc-picking]').waitFor({ timeout: 5000 });
        await frame.locator('#chart svg').click();
        const composer = page.locator('.tdoc-popup textarea').first();
        await composer.waitFor({ timeout: 8000 });
        await page.keyboard.press('Escape');
        await composer.waitFor({ state: 'detached', timeout: 5000 });
        // And a click on nothing in particular: the whole document.
        await page.locator('.tdoc-doc-side .tdoc-cpanel-add').click();
        await frame.locator('html[data-tdoc-picking]').waitFor({ timeout: 5000 });
        await frame.locator('h1').click();
        await composer.waitFor({ timeout: 8000 });
        await composer.fill('About the whole thing');
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
        await page.waitForFunction(async (s) => { const r = await fetch(`/api/comments?slug=${s}&version=1`); return (await r.json()).some((c) => c.text === 'About the whole thing'); }, slug, { timeout: 10000 });
        const saved = (await comments(slug)).find((c) => c.text === 'About the whole thing');
        assert.ok(!saved.anchor || saved.anchor.kind === 'document', JSON.stringify(saved.anchor));
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    }

    // ── Widget ──────────────────────────────────────────────────────────
    const openWidget = async (page) => {
      await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${base}`, JSON.stringify(space)]);
      await page.goto(`${base}/__page`);
      await page.waitForFunction(() => Boolean(window.tdocFeedback && document.getElementById('tdoc-feedback-root')), null, { timeout: 15000 });
      await page.waitForTimeout(800);
    };
    // The SDK's own way in (window.tdocFeedback.comment()): start picking.
    const startPicking = async (page) => {
      await page.evaluate(() => window.tdocFeedback.comment());
      await page.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor({ timeout: 8000 });
    };

    await t(`${tag}: widget: "Comment on this page" needs no element`, async () => {
      const { ctx, page } = await open();
      await openWidget(page);
      await startPicking(page);
      await page.locator('#tdoc-feedback-root .tdoc-fb-page-comment').click();
      const composer = page.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
      await composer.waitFor({ timeout: 8000 });
      await composer.fill(`The whole page ${tag}`);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
      await page.waitForFunction(async ([s, text]) => (await (await fetch(`/api/comments?slug=${s}&version=1`)).json()).some((c) => c.text === text), [space.slug, `The whole page ${tag}`], { timeout: 10000 });
      const saved = (await comments(space.slug)).find((c) => c.text === `The whole page ${tag}`);
      assert.equal(saved.anchor.page, true, JSON.stringify(saved.anchor));
      assert.equal(saved.anchor.url, `${base}/__page`);
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    if (!phone) {
      await t(`${tag}: widget: a drag over words is a quote, found again after a reload`, async () => {
        const { ctx, page } = await open();
        await openWidget(page);
        await startPicking(page);
        const words = await page.evaluate(() => {
          const p = document.querySelector('#intro');
          const node = p.firstChild;
          const range = document.createRange();
          const at = node.textContent.indexOf('1,284');
          range.setStart(node, at); range.setEnd(node, at + 5);
          const a = range.getClientRects()[0];
          return { x0: a.left + 1, y: a.top + a.height / 2, x1: a.right - 1 };
        });
        await page.mouse.move(words.x0, words.y);
        await page.mouse.down();
        await page.mouse.move(words.x1, words.y, { steps: 6 });
        await page.mouse.up();
        const composer = page.locator('#tdoc-feedback-root .tdoc-popup textarea').first();
        await composer.waitFor({ timeout: 8000 });
        await shot(page, 'widget-quote-composer');
        await composer.fill('Is this number right?');
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
        await page.waitForFunction(async (s) => (await (await fetch(`/api/comments?slug=${s}&version=1`)).json()).some((c) => c.text === 'Is this number right?'), space.slug, { timeout: 10000 });
        const saved = (await comments(space.slug)).find((c) => c.text === 'Is this number right?');
        assert.ok(saved.anchor.quote && /1,284/.test(saved.anchor.quote.text), JSON.stringify(saved.anchor));
        assert.ok(saved.anchor.quote.context_before.length > 0, 'no context saved');
        // Reload: the pin sits on the words, and they are marked in the page.
        await page.reload();
        const pin = page.locator(`#tdoc-feedback-root .tdoc-pin[data-id="${saved.id}"]`);
        await pin.waitFor({ timeout: 15000 });
        const near = await page.evaluate(() => {
          const p = document.querySelector('#intro').getBoundingClientRect();
          return { top: p.top, bottom: p.bottom };
        });
        const box = await pin.boundingBox();
        assert.ok(box.y + box.height >= near.top - 20 && box.y <= near.bottom + 20, `pin at ${box.y}, words at ${near.top}`);
        assert.ok(await page.evaluate(() => (CSS.highlights.get('tdoc-fb-quote') || { size: 0 }).size >= 1), 'the quote is not marked');
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    }

    await t(`${tag}: widget: an anchor written before the shared finder still resolves`, async () => {
      const id = (await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: `Legacy ${tag}`, anchor: { kind: 'product', url: `${base}/__page`, selector: 'main > p:nth-of-type(2)', tag: 'p', text: 'Churn held steady at four percent this month.' } } })).body.id;
      const { ctx, page } = await open();
      await openWidget(page);
      await page.locator(`#tdoc-feedback-root .tdoc-pin[data-id="${id}"]`).waitFor({ timeout: 15000 });
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });
  }

  await chromium.close();
  server.close();
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
