// The homepage hero demos (landing/tornado-doc, .hd-show), as a visitor sees
// them on tdoc.dev, desktop and phone: four real screenshots behind side tabs
// that hand over every 5 s, the active tab filling a thin bar while its demo
// is up. Hovering (mouse) or tabbing in pauses; leaving resumes. Clicking a
// tab shows that demo and restarts the cycle there, even the tab that is
// already checked. prefers-reduced-motion: nothing moves on its own. A phone
// swipe moves to the next / previous demo (frame-probe data-tdoc-carousel). Each
// demo has its own CTA, and changing demos never changes the page height.
//
// The cycle is CSS animation, so the test moves it with the Web Animations
// API (currentTime) instead of waiting 5 s per step.
// Screenshots: TDOC_TEST_SCREENSHOTS=<dir>.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');
const { chromium } = requirePlaywrightOrSkip('landing-hero-rotate-ui.test.js');

const TOKEN = 'landing-upload-token';
const SLUG = 'tornado-doc';
const root = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_TEST_SCREENSHOTS || '';
const DEMOS = ['doc', 'sheet', 'deck', 'bookmark'];

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) { res.setHeader('content-type', asset.type); return res.end(fs.readFileSync(asset.file)); }
    let body = '';
    req.on('data', (d) => { body += d; });
    await new Promise((resolve) => req.on('end', resolve));
    const headers = { ...req.headers, host: 'tdoc.dev', ...(req.headers.origin ? { origin: 'https://tdoc.dev' } : {}) };
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual',
    }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let out = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) {
      out = Buffer.from(out.toString('utf8')
        .replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path)
        .replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    }
    response.headers.forEach((value, key) => {
      if (!['content-length', 'content-encoding', 'content-security-policy'].includes(key)) res.setHeader(key, value);
    });
    res.statusCode = response.status;
    res.end(out);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// In the frame: which demo is on show, which tab is lit, and how far its bar is.
function state() {
  const stage = document.querySelector('.hd-stage').getBoundingClientRect();
  const shown = [...document.querySelectorAll('.hd-slide')].filter((s) => {
    const r = s.getBoundingClientRect();
    return Math.abs(r.top - stage.top) < 12 && Math.abs(r.left - stage.left) < 12;
  }).map((s) => s.id.replace('hd-', ''));
  const tabs = [...document.querySelectorAll('.hd-tabs label')].map((l) => {
    const cs = getComputedStyle(l);
    return { id: l.htmlFor.replace('hd-r-', ''), on: Number(cs.getPropertyValue('--hd-on')), prog: Number(cs.getPropertyValue('--hd-prog')) };
  });
  const anims = document.querySelector('.hd-show').getAnimations({ subtree: true });
  return {
    shown, lit: tabs.filter((t) => t.on > 0.5).map((t) => t.id), tabs,
    anims: anims.length, playing: anims.filter((a) => a.playState === 'running').length,
    showH: Math.round(document.querySelector('.hd-show').getBoundingClientRect().height),
    docH: document.documentElement.scrollHeight,
  };
}
// Move every hero animation forward by ms, as if that much time had passed.
function advance(ms) {
  for (const a of document.querySelector('.hd-show').getAnimations({ subtree: true })) a.currentTime = Number(a.currentTime) + ms;
}

// Put every hero animation at ms into the cycle that started on page load.
function setTime(ms) {
  for (const a of document.querySelector('.hd-show').getAnimations({ subtree: true })) a.currentTime = ms;
}

(async () => {
  console.log('homepage: the hero demos rotate');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = String(typeof input === 'string' ? input : input.url);
    if (u.startsWith('https://api.github.com/')) return new Response('{}', { status: 404 });
    return realFetch(input, init);
  };
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev', TDOC_UPLOAD_TOKEN: TOKEN });
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'landing', SLUG, 'meta.json'), 'utf8'));
  const latest = meta.versions[meta.versions.length - 1].n;
  const html = fs.readFileSync(path.join(root, 'landing', SLUG, `v${latest}`, 'index.html'), 'utf8');
  const up = await worker.fetch(new Request('https://tdoc.dev/api/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, version: 1, html, meta: {
      slug: SLUG, title: meta.title, created: meta.created, versions: [{ n: 1, created: meta.created }],
      access: { visibility: 'public', history_visibility: 'owner', commenting: 'signed_in', allowed_users: [] },
    } }),
  }), env, {});
  if (up.status !== 200) throw new Error(`landing upload: ${up.status} ${await up.text()}`);
  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); } };
  const assert = (c, m) => { if (!c) throw new Error(m); };

  const open = async (opts) => {
    const context = await browser.newContext(opts);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/`);
    const f = page.frameLocator('iframe');
    await f.locator('.hd-show').waitFor({ timeout: 15000 });
    const frame = page.frames().find((x) => x.url().includes('/frame'));
    await frame.evaluate(() => document.querySelector('.hd-show').scrollIntoView({ block: 'center' }));
    await page.mouse.move(2, 2);
    return { context, page, f, frame, errors };
  };
  const shot = async (page, name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, name) });
  };

  const DESKTOP = { viewport: { width: 1440, height: 1000 } };
  const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

  for (const [label, opts] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    await t(`${label}: each demo shows for 5 s, its tab lit with a filling bar, then the next; page height never changes`, async () => {
      const { context, page, frame, errors } = await open(opts);
      let s = await frame.evaluate(state);
      assert(s.anims === 8 && s.playing === 8, `expected 4 slides + 4 tabs animating, got ${s.anims}/${s.playing}`);
      assert(s.shown.join() === 'doc' && s.lit.join() === 'doc', `start: ${JSON.stringify(s)}`);
      const p0 = s.tabs[0].prog;
      await page.waitForTimeout(1200);
      s = await frame.evaluate(state);
      assert(s.tabs[0].prog > p0 && s.tabs[0].prog < 1, `the Docs bar should be filling: ${p0} -> ${s.tabs[0].prog}`);
      const heights = new Set(), docHeights = new Set();
      for (const [i, id] of DEMOS.entries()) {
        await frame.evaluate(setTime, i * 5000 + 600);
        s = await frame.evaluate(state);
        assert(s.shown.join() === id && s.lit.join() === id, `after ${i * 5} s: ${JSON.stringify({ shown: s.shown, lit: s.lit })}`);
        heights.add(s.showH); docHeights.add(s.docH);
        await shot(page, `hero-${label}-${i + 1}-${id}.png`);
      }
      await frame.evaluate(setTime, 20600);
      s = await frame.evaluate(state);
      assert(s.shown.join() === 'doc', `after the last demo it wraps to Docs: ${s.shown}`);
      assert(heights.size === 1 && docHeights.size === 1, `layout shift: hero ${[...heights]} page ${[...docHeights]}`);
      assert(!errors.length, errors.join(' | '));
      await context.close();
    });
  }

  await t('desktop: hover pauses, leaving resumes; a tab click restarts the cycle there, even the checked tab', async () => {
    const { context, page, f, frame, errors } = await open(DESKTOP);
    await f.locator('.hd-stage').hover();
    let s = await frame.evaluate(state);
    assert(s.playing === 0, `hover should pause all 8, ${s.playing} still running`);
    const before = s.tabs[0].prog;
    await page.waitForTimeout(800);
    s = await frame.evaluate(state);
    assert(s.tabs[0].prog === before && s.shown.join() === 'doc', 'paused bar moved');
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    s = await frame.evaluate(state);
    assert(s.playing === 8 && s.tabs[0].prog > before, 'leaving did not resume');
    // Click Slides: it shows at once, its bar starts from empty, paused under the pointer.
    await f.locator('label[for="hd-r-deck"]').click();
    s = await frame.evaluate(state);
    assert(s.shown.join() === 'deck' && s.lit.join() === 'deck' && s.tabs[2].prog < 0.1, `click Slides: ${JSON.stringify(s)}`);
    assert(s.playing === 0, 'still under the pointer: paused');
    await page.mouse.move(2, 2);
    await frame.evaluate(advance, 5200);
    s = await frame.evaluate(state);
    assert(s.shown.join() === 'bookmark', `after Slides comes Any web app: ${s.shown}`);
    // The checked tab (Slides) is no longer on show; clicking it brings it back.
    await f.locator('label[for="hd-r-deck"]').click();
    s = await frame.evaluate(state);
    assert(s.shown.join() === 'deck' && s.tabs[2].prog < 0.1, `click the checked tab: ${JSON.stringify({ shown: s.shown, tabs: s.tabs })}`);
    // Keyboard focus pauses too.
    await page.mouse.move(2, 2);
    await frame.focus('#hd-r-deck');
    await page.keyboard.press('ArrowRight');
    s = await frame.evaluate(state);
    assert(s.shown.join() === 'bookmark' && s.playing === 0, `arrow key to the next tab, paused while focused: ${JSON.stringify({ shown: s.shown, playing: s.playing })}`);
    assert(!errors.length, errors.join(' | '));
    await context.close();
  });

  await t('reduced motion: nothing rotates; tabs still switch demos', async () => {
    const { context, page, f, frame, errors } = await open({ ...DESKTOP, reducedMotion: 'reduce' });
    let s = await frame.evaluate(state);
    assert(s.anims === 0, `${s.anims} animations under reduced motion`);
    await page.waitForTimeout(600);
    s = await frame.evaluate(state);
    assert(s.shown.join() === 'doc' && s.lit.join() === 'doc' && s.tabs[0].prog === 1, `start: ${JSON.stringify(s)}`);
    await f.locator('label[for="hd-r-sheet"]').click();
    s = await frame.evaluate(state);
    assert(s.shown.join() === 'sheet' && s.lit.join() === 'sheet', `click Sheets: ${JSON.stringify(s)}`);
    assert(!errors.length, errors.join(' | '));
    await context.close();
  });

  await t('phone: a swipe moves to the next or previous demo, a tap on a tab shows it', async () => {
    const { context, page, f, frame, errors } = await open(PHONE);
    const swipe = (dx) => frame.evaluate((dx) => {
      const el = document.querySelector('.hd-stage img');
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const touch = (cx) => new Touch({ identifier: 1, target: el, clientX: cx, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch(x)], changedTouches: [touch(x)] }));
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [touch(x + dx)] }));
    }, dx);
    await swipe(-120);
    let s = await frame.evaluate(state);
    assert(s.shown.join() === 'sheet' && s.lit.join() === 'sheet', `swipe left: ${s.shown}`);
    await swipe(-120);
    s = await frame.evaluate(state);
    assert(s.shown.join() === 'deck', `swipe left again: ${s.shown}`);
    await swipe(120);
    s = await frame.evaluate(state);
    assert(s.shown.join() === 'sheet' && s.tabs[1].prog < 0.1, `swipe right: ${s.shown}`);
    // Back to the radio that is already checked: the cycle restarts there.
    await frame.evaluate(advance, 5000);
    await swipe(120);
    s = await frame.evaluate(state);
    assert(s.shown.join() === 'sheet' && s.tabs[1].prog < 0.1, `swipe back onto the checked demo: ${JSON.stringify({ shown: s.shown, tabs: s.tabs })}`);
    await swipe(-20);
    s = await frame.evaluate(state);
    assert(s.shown.join() === 'sheet', 'a short drag is not a swipe');
    // A comment-selection drag (text selected) never flips the slide under its anchor.
    await frame.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#hd-sheet .hd-real-cap')); getSelection().removeAllRanges(); getSelection().addRange(r); });
    await swipe(-120);
    s = await frame.evaluate(state);
    assert(s.shown.join() === 'sheet', `a swipe over a text selection moved the slide: ${s.shown}`);
    await frame.evaluate(() => getSelection().removeAllRanges());
    // Only the checked radio's group is cycled: a radio of another group inside is skipped.
    await frame.evaluate(() => { const x = document.createElement('input'); x.type = 'radio'; x.name = 'elsewhere'; x.id = 'hd-foreign'; x.className = 'hd-r'; document.querySelector('.hd-show').prepend(x); });
    await swipe(-120);
    s = await frame.evaluate(state);
    const foreign = await frame.evaluate(() => document.getElementById('hd-foreign').checked);
    assert(s.shown.join() === 'deck' && !foreign, `swipe with a foreign radio present: ${s.shown}, foreign checked ${foreign}`);
    await swipe(120);
    await frame.evaluate(() => document.getElementById('hd-foreign').remove());
    await f.locator('label[for="hd-r-bookmark"]').tap();
    s = await frame.evaluate(state);
    assert(s.shown.join() === 'bookmark', `tap Any web app: ${s.shown}`);
    assert(!errors.length, errors.join(' | '));
    await context.close();
  });

  await t('each demo\'s CTA opens its own route', async () => {
    const expected = { doc: ['Make your doc', '/setup?step=doc'], sheet: ['Make your sheet', '/me'], deck: ['Make your deck', '/setup?step=doc'], bookmark: ['Add to your site', '/feedback'] };
    for (const id of DEMOS) {
      const { context, page, f, frame } = await open({ ...DESKTOP, reducedMotion: 'reduce' });
      await f.locator(`label[for="hd-r-${id}"]`).click();
      const cta = f.locator(`#hd-${id} .hd-go`);
      assert(await cta.textContent() === expected[id][0], `${id}: ${await cta.textContent()}`);
      const box = await cta.boundingBox();
      assert(box && box.height >= 40 && box.width >= 120, `${id}: CTA is not a visible button ${JSON.stringify(box)}`);
      await frame.evaluate(() => document.querySelector('.hd-show').scrollIntoView({ block: 'center' }));
      const [nav] = await Promise.all([page.waitForNavigation({ timeout: 10000 }), cta.click()]);
      const u = new URL(page.url());
      // Signed out, /me hands over to the sign-in notice page; the rest are themselves.
      const want = expected[id][1];
      assert(u.pathname + u.search === want || (want === '/me' && u.pathname === '/' && u.search === '?notice=signin'), `${id}: went to ${u.pathname}${u.search}`);
      assert(nav && nav.status() < 400, `${id}: ${want} answered ${nav && nav.status()}`);
      await context.close();
    }
  });

  await browser.close();
  server.close();
  globalThis.fetch = realFetch;
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
