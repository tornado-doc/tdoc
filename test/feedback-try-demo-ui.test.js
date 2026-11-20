// Try it on this page (/feedback), in a real browser: the widget's demo mode
// (feedback/src/demo.js), no account. Real worker routes (in-process
// harness) behind a local HTTP server, the built shell runtime and the built
// feedback.js, Chromium. On desktop and on a 390px phone:
//   - "Try it on this page" starts the real widget: picking, the composer;
//   - Post saves in the tab (sessionStorage), the pin and the thread show,
//     "Demo — only you see this" is on screen, then "Add to your site";
//   - C copies the thread as Markdown for an agent;
//   - not one request to a comment, mention, reaction, seen, session,
//     connect or handoff API, and no tdoc window (popup) opens;
//   - not one request to any other host either (no GitHub user search
//     behind @); only the page's own handwriting font is fetched from Google;
//   - /feedback#try (the homepage's Any web app) starts it straight away;
//   - a real widget already on the page (the bookmark): Try says the demo is
//     off and does nothing, so nothing is posted for real;
//   - the script on another origin, attribute and all, is the real widget.
const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('feedback-try-demo-ui.test.js');

const COMMENT_API = /\/api\/(comments|mentions|reactions|feedback|notify|me\/agents|my-agent)/;
// The /feedback page's own handwriting (useHandFont), loaded with the page.
const PAGE_FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (req, res) => {
    const asset = byPath.get(req.url.split('?')[0]);
    // The built widget, as bin/tdoc-bundle inlines it into the worker.
    if (req.url.split('?')[0] === '/feedback.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      return res.end(fs.readFileSync(path.join(__dirname, '..', 'server', 'runtime', 'feedback.js')));
    }
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
      if (['content-length', 'content-encoding'].includes(key)) return;
      res.setHeader(key, key === 'location' ? value.replace('https://tdoc.dev', '') : value);
    });
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  console.log('/feedback: Try it on this page (demo, no account)');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { GITHUB_CLIENT_ID: 'test-client' });
  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); }
  };
  const open = async (viewport, phone, path = '/feedback') => {
    const context = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    const page = await context.newPage();
    // The clipboard, read back: writeText records what was copied.
    await page.addInitScript(() => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied.push(text); } } });
    });
    const errors = [];
    const calls = [];
    const popups = [];
    const elsewhere = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      const u = new URL(request.url());
      if (u.protocol === 'data:' || u.protocol === 'blob:') return;
      if (u.origin !== base) { if (!PAGE_FONT_HOSTS.has(u.hostname)) elsewhere.push(request.url()); return; }
      if (COMMENT_API.test(u.pathname)) calls.push(`${request.method()} ${u.pathname}`);
    });
    // Nothing leaves the machine, whatever is asked.
    await context.route((url) => new URL(url).origin !== base, (route) => route.abort());
    context.on('page', (p) => { if (p !== page) popups.push(p.url()); });
    await page.goto(`${base}${path}`);
    await page.locator('#try-demo').waitFor();
    return { context, page, errors, calls, popups, elsewhere };
  };
  const shot = async (page, name) => {
    const dir = process.env.TDOC_SHOTS_DIR;
    if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
  };
  const fb = (page, sel) => page.locator(`#tdoc-feedback-root ${sel}`);

  try {
    for (const [device, viewport, phone] of [['desktop', { width: 1280, height: 860 }, false], ['phone', { width: 390, height: 844 }, true]]) {
      await t(`${device}: try it, pick, post locally, pin + thread, C copies Markdown, nothing sent`, async () => {
        const { context, page, errors, calls, popups, elsewhere } = await open(viewport, phone);
        try {
          const tryBtn = page.locator('#try-demo');
          assert.match(await tryBtn.innerText(), /Try it on this page/);
          assert.match(await page.locator('#try').innerText(), /No account/);
          await shot(page, `${device}-01-page`);
          if (phone) await tryBtn.tap(); else await tryBtn.click();
          // The real widget, picking, with the demo said on screen.
          await fb(page, '.tdoc-fb-banner').waitFor({ timeout: 10000 });
          assert.equal(await page.evaluate(() => window.tdocFeedback && window.tdocFeedback.demo), true, 'the widget is not in demo mode');
          assert.match(await fb(page, '.tdoc-fb-demo').innerText(), /Demo — only you see this/);
          await shot(page, `${device}-02-picking`);
          // Pick the page's heading.
          const h = await page.locator('h1').boundingBox();
          if (phone) await page.touchscreen.tap(h.x + 40, h.y + h.height / 2);
          else await page.mouse.click(h.x + 40, h.y + h.height / 2);
          const composer = fb(page, '.tdoc-popup textarea');
          await composer.first().waitFor({ timeout: 5000 });
          // @ with no one local: the real widget would ask GitHub's user search.
          await composer.first().fill('@octo');
          await page.waitForTimeout(700);
          await composer.first().fill('Make this heading say what it does');
          await shot(page, `${device}-03-composer`);
          await fb(page, '.tdoc-popup button.submit').last().click();
          // Saved here: the pin, the open thread, and the next step.
          await fb(page, '.tdoc-pin').first().waitFor({ timeout: 5000 });
          await fb(page, '.tdoc-margin-comment').filter({ hasText: 'Make this heading say what it does' }).first().waitFor({ timeout: 5000 });
          const cta = fb(page, '.tdoc-fb-demo-cta');
          await cta.waitFor();
          assert.equal(await cta.innerText(), 'Add to your site');
          const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('tdoc-feedback-demo:comments') || '[]'));
          assert.equal(stored.length, 1, `sessionStorage holds ${stored.length} comments`);
          assert.equal(stored[0].text, 'Make this heading say what it does');
          assert.equal(stored[0].anchor.kind, 'product');
          await shot(page, `${device}-04-posted`);
          // Copy for agent: C.
          await page.keyboard.press('c');
          await page.waitForFunction(() => window.__copied.length > 0);
          const md = await page.evaluate(() => window.__copied.at(-1));
          assert.match(md, /Make this heading say what it does/);
          assert.match(md, /\/feedback/, 'the Markdown does not name the page');
          assert.doesNotMatch(md, /\/d\/try-tdoc-feedback/, 'the Markdown links to a tdoc doc that does not exist');
          await fb(page, '.tdoc-fb-toast').filter({ hasText: /Copied/ }).waitFor();
          await shot(page, `${device}-05-copied`);
          // Nothing sent, nothing opened, the dock fits.
          assert.deepEqual(calls, [], `comment APIs called: ${calls.join(', ')}`);
          assert.deepEqual(popups, [], `a window opened: ${popups.join(', ')}`);
          assert.deepEqual(elsewhere, [], `requests to other hosts: ${elsewhere.join(', ')}`);
          const dock = await fb(page, '.tdoc-feedback-dock').boundingBox();
          const note = await fb(page, '.tdoc-fb-demo').boundingBox();
          assert.ok(dock.x >= 0 && dock.x + dock.width <= viewport.width, `dock off screen ${JSON.stringify(dock)}`);
          assert.ok(note.x >= 0 && note.x + note.width <= viewport.width, `demo note off screen ${JSON.stringify(note)}`);
          assert.ok(note.y + note.height <= dock.y, 'demo note overlaps the dock');
          // The one next step: Add to your site, on this page.
          if (phone) await cta.tap(); else await cta.click();
          await page.waitForFunction(() => location.hash === '#add');
          assert.equal(await page.locator('#add').isVisible(), true);
          assert.equal(await page.evaluate(() => scrollX), 0, 'the page scrolls sideways');
          assert.deepEqual(calls, [], `comment APIs called: ${calls.join(', ')}`);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      });
    }

    await t('/feedback#try (the homepage link) starts the demo at once', async () => {
      const { context, page, errors, calls } = await open({ width: 1280, height: 860 }, false, '/feedback#try');
      try {
        await fb(page, '.tdoc-fb-banner').waitFor({ timeout: 10000 });
        assert.match(await fb(page, '.tdoc-fb-demo').innerText(), /Demo — only you see this/);
        assert.deepEqual(calls, []);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t('a real widget already on /feedback: Try says the demo is off, posts nothing', async () => {
      const { context, page, errors, calls, elsewhere } = await open({ width: 1280, height: 860 }, false);
      try {
        // The bookmark, clicked on this page: the real widget, no demo.
        await page.evaluate((src) => new Promise((resolve) => {
          const s = document.createElement('script');
          s.src = src; s.onload = resolve; s.onerror = resolve;
          document.documentElement.appendChild(s);
        }), `${base}/feedback.js?b=1`);
        await page.waitForFunction(() => window.tdocFeedback);
        assert.equal(await page.evaluate(() => window.tdocFeedback.demo), false);
        await page.locator('#try-demo').click();
        await page.locator('#try-note').filter({ hasText: 'The tdoc widget is already on — this demo is off' }).waitFor();
        await page.waitForTimeout(500);
        assert.equal(await fb(page, '.tdoc-fb-banner').count(), 0, 'Try started picking in the real widget');
        assert.equal(await fb(page, '.tdoc-fb-demo').count(), 0, 'a demo note on the real widget');
        assert.equal(await page.locator('#tdoc-feedback-demo-script').count(), 0, 'a second (demo) script was added');
        assert.deepEqual(calls.filter((c) => !c.startsWith('GET')), [], `real writes: ${calls.join(', ')}`);
        assert.deepEqual(elsewhere, []);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });

    await t('the script from another origin, data-tdoc-demo and all, is the real widget', async () => {
      // localhost and 127.0.0.1 are two origins: a "site" loading tdoc's script.
      const site = base.replace('127.0.0.1', 'localhost');
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const page = await context.newPage();
      const calls = [];
      page.on('request', (request) => { const u = new URL(request.url()); if (COMMENT_API.test(u.pathname)) calls.push(`${request.method()} ${u.origin}${u.pathname}`); });
      try {
        await page.goto(`${site}/feedback`);
        await page.evaluate((src) => new Promise((resolve) => {
          const s = document.createElement('script');
          s.src = src; s.setAttribute('data-tdoc-demo', '1'); s.setAttribute('data-tdoc-open', '1'); s.onload = resolve; s.onerror = resolve;
          document.documentElement.appendChild(s);
        }), `${base}/feedback.js`);
        await page.waitForFunction(() => window.tdocFeedback);
        assert.equal(await page.evaluate(() => window.tdocFeedback.demo), false, 'demo mode on another origin');
        await fb(page, '.tdoc-feedback-dock').waitFor();
        assert.equal(await fb(page, '.tdoc-fb-demo').count(), 0, 'demo note on another origin');
        assert.equal(await page.evaluate(() => sessionStorage.getItem('tdoc-feedback-demo:comments')), null);
      } finally { await context.close(); }
    });

    await t('the same script elsewhere on tdoc (not /feedback) is not a demo', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const page = await context.newPage();
      try {
        await page.goto(`${base}/`).catch(() => {});
        await page.evaluate((src) => new Promise((resolve) => {
          const s = document.createElement('script');
          s.src = src; s.setAttribute('data-tdoc-demo', '1'); s.onload = resolve; s.onerror = resolve;
          document.documentElement.appendChild(s);
        }), `${base}/feedback.js`);
        await page.waitForFunction(() => window.tdocFeedback);
        assert.equal(await page.evaluate(() => window.tdocFeedback.demo), false, 'demo mode on a page other than /feedback');
      } finally { await context.close(); }
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
