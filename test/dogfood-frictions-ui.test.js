// Small frictions from the 2026-11-20 production dogfood pass, as a visitor
// meets them, desktop and phone:
//   - landing, phone: the "Any web app" tab is readable once tapped (a stuck
//     :hover on touch made its words ink on the ink pill)
//   - landing: a top-bar way to /feedback ("Feedback for your site": the bar
//     on desktop, ⋯ on a phone)
//   - landing, phone: the comment button sits in the top bar, never over a
//     CTA (Make your doc, Add to your site, ...)
//   - widget, signed out: the composer says Post signs in and keeps the
//     words; Post opens one tdoc window and the stale "Not connected"
//     notice goes; no @agent for someone who cannot use it; the send button
//     is "Post" (the dock's button is "Comment")
//   - widget: Esc closes the composer (not back to picking), the words come
//     back on the same element, the next Esc closes what is behind it
// TDOC_UI_SHOTS=<dir> saves screenshots.
// Run with: node test/dogfood-frictions-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const pw = requirePlaywrightOrSkip('dogfood-frictions-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TDOC = 'https://tdoc.dev';
const TOKEN = 'landing-upload-token';
const ROOT = path.join(__dirname, '..');
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shop</title></head>
<body><main style="padding-top:200px"><h1>Shop</h1><p>Something to comment on.</p><button id="trial">Start free trial</button></main>
<script src="/feedback.js" data-tdoc-open="1"></script></body></html>`;

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((a) => [a.path, a]));
  const server = http.createServer(async (request, res) => {
    const pathname = request.url.split('?')[0];
    if (pathname === '/__page') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(PAGE); }
    if (pathname === '/feedback.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      return res.end(fs.readFileSync(path.join(ROOT, 'server/runtime/feedback.js')));
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

// "rgb(r, g, b)" -> relative luminance, 0 (black) .. 1 (white).
// Also "color(srgb r g b)" (0..1), what color-mix() computes to.
function luminance(color) {
  const s = String(color);
  const unit = s.startsWith('color(') ? 1 : 255;
  const m = s.replace(/^color\(srgb/, '').match(/[\d.]+/g) || [];
  const [r, g, b] = m.slice(0, 3).map((v) => {
    const c = Number(v) / unit;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

(async () => {
  console.log('dogfood frictions (2026-11-20): landing, widget composer');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = String(typeof input === 'string' ? input : input.url);
    if (u.startsWith('https://api.github.com/')) return new Response('{}', { status: 404 });
    return realFetch(input, init);
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_UPLOAD_TOKEN: TOKEN });
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'landing/tornado-doc/meta.json'), 'utf8'));
  const latest = meta.versions[meta.versions.length - 1].n;
  const html = fs.readFileSync(path.join(ROOT, 'landing/tornado-doc', `v${latest}`, 'index.html'), 'utf8');
  const up = await worker.fetch(new Request(`${TDOC}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'tornado-doc', version: 1, html, meta: {
      slug: 'tornado-doc', title: meta.title, created: meta.created, versions: [{ n: 1, created: meta.created }],
      access: { visibility: 'public', history_visibility: 'owner', commenting: 'signed_in', allowed_users: [] },
    } }),
  }), env, {});
  assert.equal(up.status, 200, await up.text());
  const { server, base } = await startServer(worker, env);
  const browser = await pw.chromium.launch({ headless: true });
  const DESK = { viewport: { width: 1440, height: 900 } };
  const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${String(error.stack || error.message).split('\n').slice(0, 10).join('\n    ')}`); } };
  const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
  const openLanding = async (opts) => {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.goto(`${base}/`);
    await page.frameLocator('iframe').locator('.hd-show').waitFor({ timeout: 15000 });
    const frame = page.frames().find((x) => x.url().includes('/frame'));
    return { ctx, page, frame };
  };

  try {
    await t('landing desktop: "Feedback for your site" in the bar goes to /feedback; no ⋯ added', async () => {
      const { ctx, page } = await openLanding(DESK);
      const link = page.locator('.tdoc-bar .tdoc-landing-feedback-link');
      assert.ok(await link.isVisible(), 'no Feedback link in the bar');
      assert.equal((await link.innerText()).trim(), 'Feedback for your site');
      assert.equal(await link.getAttribute('href'), '/feedback');
      assert.equal(await page.locator('#tdoc-more-btn').isVisible(), false, 'the link put ⋯ on the desktop bar');
      await shot(page, 'landing-desktop-bar');
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t('landing phone: the link is in ⋯, not the bar; the comment button is in the top bar, over no CTA', async () => {
      const { ctx, page, frame } = await openLanding(PHONE);
      assert.equal(await page.locator('.tdoc-bar .tdoc-landing-feedback-link').isVisible(), false, 'words in the phone bar');
      const fab = page.locator('.tdoc-fab');
      await fab.waitFor();
      const bar = await page.locator('.tdoc-bar').boundingBox();
      const frameBox = await page.locator('iframe').first().boundingBox();
      // Every CTA in the page, brought to the bottom of the screen in turn
      // (where the button used to sit): never under the button.
      const ctas = await frame.evaluate(() => [...document.querySelectorAll('a.btn, .hd-go')].length);
      assert.ok(ctas >= 4, `only ${ctas} CTAs found`);
      for (let i = 0; i < ctas; i++) {
        const r = await frame.evaluate((n) => {
          const el = [...document.querySelectorAll('a.btn, .hd-go')][n];
          window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight + el.getBoundingClientRect().height + 8);
          const b = el.getBoundingClientRect();
          return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, text: el.textContent.trim() };
        }, i);
        if (!r.w) continue;
        await page.waitForTimeout(50);
        const f = await fab.boundingBox();
        const top = frameBox.y + r.top, bottom = frameBox.y + r.bottom, left = frameBox.x + r.left, right = frameBox.x + r.right;
        const overlaps = f.x < right && f.x + f.width > left && f.y < bottom && f.y + f.height > top;
        assert.ok(!overlaps, `the comment button covers "${r.text}"`);
      }
      const f = await fab.boundingBox();
      assert.ok(f.y >= bar.y && f.y + f.height <= bar.y + bar.height + 0.5, `the button is not in the top bar: ${JSON.stringify(f)}`);
      await frame.evaluate(() => { const go = document.querySelector('.hd-go'); window.scrollTo(0, go.getBoundingClientRect().top + window.scrollY - window.innerHeight + 140); });
      await shot(page, 'landing-phone-cta');
      await page.locator('#tdoc-more-btn').click();
      const item = page.locator('.tdoc-landing-feedback-item');
      await item.waitFor();
      assert.equal((await item.innerText()).trim(), 'Feedback for your site');
      assert.equal(await item.getAttribute('href'), '/feedback');
      await shot(page, 'landing-phone-more');
      // The button still opens the comments.
      await page.keyboard.press('Escape');
      await fab.click();
      await page.locator('#tdoc-comment-layer').waitFor({ timeout: 5000 });
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t('landing phone: a tapped "Any web app" tab is readable (words light on the dark pill), like Docs', async () => {
      const { ctx, page, frame } = await openLanding(PHONE);
      const f = page.frameLocator('iframe');
      await frame.evaluate(() => document.querySelector('.hd-tabs').scrollIntoView({ block: 'center' }));
      for (const id of ['bookmark', 'doc']) {
        await f.locator(`label[for="hd-r-${id}"]`).tap();
        await page.waitForTimeout(300);
        const c = await frame.evaluate((which) => {
          const label = document.querySelector(`label[for="hd-r-${which}"]`);
          return { on: Number(getComputedStyle(label).getPropertyValue('--hd-on')), text: getComputedStyle(label.querySelector('b')).color, bg: getComputedStyle(label).backgroundColor, hover: label.matches(':hover') };
        }, id);
        assert.ok(c.on > 0.5, `${id} is not lit after a tap`);
        assert.ok(contrast(c.text, c.bg) >= 4.5, `${id}: words ${c.text} on ${c.bg} (hover ${c.hover}) contrast ${contrast(c.text, c.bg).toFixed(2)}`);
        if (id === 'bookmark') await shot(page, 'landing-phone-anyweb-tab');
      }
      await ctx.close();
    });

    for (const [tag, opts] of [['desktop', DESK], ['phone', PHONE]]) {
      await t(`widget ${tag}, signed out: Post (not Comment), the sign-in line, no @agent; Esc closes and keeps the words; Post opens one window`, async () => {
        const ctx = await browser.newContext(opts);
        const page = await ctx.newPage();
        page.errors = [];
        page.on('pageerror', (e) => page.errors.push(e.message));
        await page.goto(`${base}/__page`);
        const root = page.locator('#tdoc-feedback-root');
        await root.locator('.tdoc-feedback-dock').waitFor({ timeout: 15000 });
        const pick = async () => {
          if (!(await root.locator('.tdoc-fb-banner').count())) await root.locator('.tdoc-feedback-dock button', { hasText: 'Comment' }).first().click();
          await root.locator('.tdoc-fb-banner').waitFor({ timeout: 5000 });
          // The connect window the first click opens: closed, and the
          // widget's word about it settled, before picking.
          await page.waitForTimeout(400);
          for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {});
          await page.waitForTimeout(700);
          const b = await page.locator('#trial').boundingBox();
          await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
          await page.waitForTimeout(100);
          await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        };
        await pick();
        const composer = root.locator('.tdoc-popup:has(textarea)');
        await composer.locator('textarea').waitFor({ timeout: 5000 });
        assert.equal(await composer.locator('.tdoc-composer-agent, .tdoc-send-agent-toggle').count(), 0, 'a disabled @agent for somebody who cannot use it');
        assert.equal((await composer.locator('button.submit').innerText()).trim(), 'Post');
        assert.match(await composer.locator('.tdoc-sign-in-to-post').innerText(), /Sign in to post — your comment is saved/);
        await composer.locator('textarea').fill('CTA label is vague');
        await shot(page, `widget-${tag}-composer-signed-out`);
        // Esc: the composer closes, and it is not back to picking.
        await page.keyboard.press('Escape');
        await composer.waitFor({ state: 'detached' });
        assert.equal(await root.locator('.tdoc-fb-banner').count(), 0, 'Esc went back to picking');
        // The same element again: the words are back.
        await pick();
        await composer.locator('textarea').waitFor({ timeout: 5000 });
        assert.equal(await composer.locator('textarea').inputValue(), 'CTA label is vague', 'the draft was lost');
        // Post while signed out: one tdoc window, the composer says why.
        const before = ctx.pages().length;
        await composer.locator('button.submit').click();
        await page.waitForTimeout(600);
        assert.equal(ctx.pages().length - before, 1, 'Post opened more than one window (or none)');
        assert.match(await composer.locator('.tdoc-sign-in-to-post').innerText(), /Finish signing in/);
        assert.equal(await root.locator('.tdoc-feedback-notice', { hasText: 'Not connected' }).count(), 0, 'a stale Not connected notice beside the window');
        await shot(page, `widget-${tag}-signing-in`);
        // Pressing Post again while the window is still open: no second window.
        const now = ctx.pages().length;
        await composer.locator('button.submit').click({ force: true }).catch(() => {});
        await page.waitForTimeout(400);
        assert.equal(ctx.pages().length, now, 'a second tdoc window');
        assert.deepEqual(page.errors, []);
        await ctx.close();
      });
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
