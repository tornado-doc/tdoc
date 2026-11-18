// The feedback widget's comment list is the doc page's comment list
// (AGENTS.md: comment surfaces are shared). Same component (CommentPanel),
// same starting width, and the same filter row: the Open / Replied /
// Resolved / All control sits on one line, every option the same height,
// inside its pill, with the same geometry as on the doc page. Checked on a
// plain host page and on one whose CSS is hostile (resets on button, *,
// div, a huge root font, !important everywhere): the widget's shadow root
// must keep all of that out. Desktop 1280 and phone 390.
// TDOC_UI_SHOTS=<dir> saves screenshots.
// Run with: node test/feedback-panel-parity-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('feedback-panel-parity-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TDOC = 'https://tdoc.dev';
const DOC = (slug) => `<!doctype html><html><body><h1>${slug}</h1><p>Alpha line one to comment on.</p><p>Bravo line two to comment on.</p><p>Charlie line three to comment on.</p></body></html>`;
const HOSTILE_CSS = `
  html { font-size: 22px !important; zoom: 1; }
  *, *::before, *::after { box-sizing: content-box !important; letter-spacing: .08em !important; }
  body { font: 700 20px/2.4 Georgia, serif !important; text-transform: uppercase !important; word-spacing: 6px; }
  div, section, header, aside { display: block !important; padding: 6px !important; margin: 4px !important; }
  button { all: unset; display: block !important; min-width: 120px !important; padding: 14px 22px !important; margin: 6px !important;
    font: 700 18px/2 Georgia, serif !important; border: 3px solid red !important; border-radius: 0 !important; float: left; }
  :host { font-size: 30px !important; }
`;
const PAGE = (hostile) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>page</title>${hostile ? `<style>${HOSTILE_CSS}</style>` : ''}</head>
<body><main><h1>App</h1><p id="x">Something to comment on.</p><p id="y">Something else.</p><button>Host button</button></main>
<script src="/feedback.js" data-tdoc-open="1"></script></body></html>`;

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((a) => [a.path, a]));
  const server = http.createServer(async (request, res) => {
    const pathname = request.url.split('?')[0];
    if (pathname === '/__page' || pathname === '/__hostile') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(PAGE(pathname === '/__hostile'));
    }
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

// Geometry of a comment list: the list box, the filter pill and its options,
// relative to the list's left edge.
function measure(list) {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
  const panel = box(list);
  const seg = list.querySelector('.tdoc-comment-filter');
  const row = list.querySelector('.tdoc-comment-filter-row');
  const buttons = [...seg.querySelectorAll('[role="radio"]')];
  const css = getComputedStyle(buttons[0]);
  return {
    panel,
    seg: box(seg),
    row: box(row),
    segLeft: box(seg).x - panel.x,
    segRightGap: panel.r - box(seg).r,
    buttons: buttons.map((b) => ({ label: b.textContent.trim(), cut: b.scrollWidth > b.clientWidth + 0.5, ...box(b) })),
    font: `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`,
    textTransform: css.textTransform,
    letterSpacing: css.letterSpacing,
    padding: css.padding,
  };
}

// Waits until a sheet / panel has finished sliding in.
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
  console.log('Feedback widget list = doc page list: width and filter row');
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
  const minted = await call('/api/hosted/token', { method: 'POST', cookie, body: { label: 'julie' } });
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  const token = minted.body.token;

  const { server, base } = await startServer(worker, env);
  // Same threads on both, so the labels read the same: two-digit counts
  // (Open (12) ... All (24)), the case where the widget's filter broke.
  const slug = 'panel-parity';
  assert.equal((await call('/api/upload', { method: 'POST', token, body: { slug, version: 1, html: DOC(slug), meta: { title: slug } } })).status, 200);
  const space = (await call('/api/feedback/connect', { method: 'POST', cookie, body: { origin: base } })).body;
  assert.ok(space.slug && space.token, JSON.stringify(space));
  const texts = ['Alpha line one', 'Bravo line two', 'Charlie line three'];
  for (let i = 0; i < 24; i++) {
    const text = texts[i % 3];
    const d = await call('/api/comments', { method: 'POST', cookie, body: { slug, version: 1, text: `Doc thread ${i}`, anchor: { kind: 'text', text } } });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const w = await call('/api/comments', { method: 'POST', token: space.token, body: { slug: space.slug, version: 1, text: `Widget thread ${i}`, anchor: { kind: 'product', url: `${base}/__page`, selector: '#x', tag: 'p', text: 'Something' } } });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    if (i % 2) {
      assert.equal((await call('/api/comments', { method: 'PATCH', cookie, body: { slug, version: 1, id: d.body.id, resolved: true } })).status, 200);
      assert.equal((await call('/api/comments', { method: 'PATCH', token: space.token, body: { slug: space.slug, version: 1, id: w.body.id, resolved: true } })).status, 200);
    }
  }

  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${String(error.message).split('\n').slice(0, 12).join('\n    ')}`); } };
  const chromium = await pw.chromium.launch({ headless: true });

  for (const width of [1280, 390]) {
    const phone = width < 700;
    const tag = `chromium-${width}`;
    const contextFor = async () => {
      const ctx = await chromium.newContext(phone ? { viewport: { width, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width, height: 800 } });
      await ctx.addCookies([{ name: 'tdoc_sid', value: sid, url: base }]);
      await ctx.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
      return ctx;
    };
    const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOTS, `${tag}-${name}.png`) }); } };

    const docList = async () => {
      const ctx = await contextFor();
      const page = await ctx.newPage();
      await page.goto(`${base}/d/${slug}`);
      await page.frameLocator('iframe').locator('h1').waitFor({ timeout: 15000 });
      await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
      let list;
      if (phone) {
        list = page.locator('#tdoc-comment-layer .tdoc-cpanel');
        if (!(await list.isVisible().catch(() => false))) await page.locator('.tdoc-fab').click();
      } else {
        list = page.locator('.tdoc-doc-side');
        if (!(await list.isVisible().catch(() => false))) await page.locator('.tdoc-comments-toggle').click();
        list = page.locator('.tdoc-doc-side .tdoc-cpanel');
      }
      await list.locator('.tdoc-comment-filter').waitFor({ timeout: 15000 });
      await settle(list);
      const outer = phone ? null : await page.locator('.tdoc-doc-side').boundingBox();
      const m = await list.evaluate(measure);
      await shot(page, 'doc-list');
      return { ctx, m, outer };
    };
    const widgetList = async (where) => {
      const ctx = await contextFor();
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${base}`, JSON.stringify(space)]);
      await page.goto(`${base}/${where}`);
      const list = page.locator('#tdoc-feedback-root .tdoc-fb-list');
      const opened = await list.locator('.tdoc-comment-filter').waitFor({ timeout: 8000 }).then(() => true, () => false);
      if (!opened) await page.locator('#tdoc-feedback-root .tdoc-feedback-dock button').first().click();
      await list.locator('.tdoc-comment-filter').waitFor({ timeout: 15000 });
      await settle(list);
      const outer = phone ? null : await page.locator('#tdoc-feedback-root .tdoc-fb-panel').boundingBox();
      const m = await list.evaluate(measure);
      await shot(page, `widget-list${where === '__hostile' ? '-hostile-host' : ''}`);
      assert.deepEqual(errors, []);
      return { ctx, m, outer };
    };

    const doc = await docList();
    const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: widget ${a.toFixed(1)} vs doc ${b.toFixed(1)}`);
    // The filter row must be the doc page's: one line, options inside the
    // pill, the same option heights and font, the same place in the list.
    // One line, every option inside the pill and its words not cut.
    const aligned = (m, who) => {
      const top = m.buttons[0].y;
      for (const b of m.buttons) {
        assert.ok(Math.abs(b.y - top) <= 0.5, `${who}: "${b.label}" is not on the filter's line`);
        assert.ok(Math.abs(b.h - m.buttons[0].h) <= 0.5, `${who}: "${b.label}" height differs from the first option`);
        assert.ok(b.x >= m.seg.x - 0.5 && b.r <= m.seg.r + 0.5 && b.y >= m.seg.y - 0.5 && b.b <= m.seg.b + 0.5, `${who}: "${b.label}" sticks out of the pill: ${JSON.stringify(b)} vs ${JSON.stringify(m.seg)}`);
        assert.ok(!b.cut, `${who}: "${b.label}" is cut`);
      }
      assert.ok(m.seg.r <= m.panel.r + 0.5, `${who}: the pill runs past the list`);
    };
    const sameFilter = (w, d) => {
      assert.deepEqual(w.buttons.map((b) => b.label), d.buttons.map((b) => b.label), 'labels');
      aligned(d, 'doc page');
      aligned(w, 'widget');
      near(w.seg.h, d.seg.h, 1, 'filter pill height');
      near(w.buttons[0].h, d.buttons[0].h, 1, 'option height');
      assert.equal(w.font, d.font, 'option font');
      assert.equal(w.textTransform, d.textTransform, 'option text-transform');
      assert.equal(w.letterSpacing, d.letterSpacing, 'option letter-spacing');
      assert.equal(w.padding, d.padding, 'option padding');
      near(w.segLeft, d.segLeft, 1, 'filter left inset in the list');
      // A phone's doc sheet has its Refresh beside the filter (its title row
      // is the Comments / Ask AI tabs); the widget's Refresh is in its title row.
      if (phone) return;
      near(w.segRightGap, d.segRightGap, 1, 'filter right inset in the list');
      for (const [i, b] of w.buttons.entries()) near(b.w, d.buttons[i].w, 1.5, `"${b.label}" width`);
    };

    for (const where of ['__page', '__hostile']) {
      await t(`${tag}: widget on ${where === '__hostile' ? 'a hostile host page' : 'a plain host page'}: the list is as wide as the doc page's, and its filter row is the doc page's`, async () => {
        const w = await widgetList(where);
        try {
          if (process.env.TDOC_DEBUG) console.log(JSON.stringify({ doc: doc.m, docOuter: doc.outer, widget: w.m, widgetOuter: w.outer }, null, 1));
          // A phone: the same bottom sheet (CommentSheet) on both; the doc's
          // keeps a 12px side inset for its Comments / Ask AI tabs, so its
          // list is the narrower one and the widget's is never narrower.
          if (phone) assert.ok(w.m.panel.w >= doc.m.panel.w - 0.5, `phone list width: widget ${w.m.panel.w} < doc ${doc.m.panel.w}`);
          else near(w.outer.width, doc.outer.width, 1, 'side panel width');
          sameFilter(w.m, doc.m);
        } finally { await w.ctx.close(); }
      });
    }
    if (!phone) {
      await t(`${tag}: widget dragged to its narrowest: the filter row still fits, nothing cut`, async () => {
        const ctx = await contextFor();
        const page = await ctx.newPage();
        await page.addInitScript(([key, value]) => { localStorage.setItem(key, value); }, [`tdoc-feedback:${base}`, JSON.stringify(space)]);
        await page.goto(`${base}/__page`);
        const list = page.locator('#tdoc-feedback-root .tdoc-fb-list');
        await list.locator('.tdoc-comment-filter').waitFor({ timeout: 15000 });
        await page.locator('#tdoc-feedback-root .tdoc-fb-panel .ui-side-resize').focus();
        await page.keyboard.press('Home');
        await settle(list);
        const m = await list.evaluate(measure);
        await shot(page, 'widget-list-narrowest');
        assert.ok(Math.abs(m.panel.w - 320) <= 1, `narrowest is ${m.panel.w}`);
        aligned(m, 'widget at its narrowest');
        // Past that (three-digit counts) the words end in an ellipsis; an
        // option is never clipped by the pill's edge.
        assert.equal(await list.locator('.tdoc-comment-filter [role="radio"]').first().evaluate((b) => getComputedStyle(b).textOverflow), 'ellipsis');
        await ctx.close();
      });
    }
    await doc.ctx.close();
  }

  await chromium.close();
  server.close();
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})().catch((error) => { console.error(error); process.exit(1); });
