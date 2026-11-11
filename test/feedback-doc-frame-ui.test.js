// The feedback widget on tdoc's own doc page (feedbackDocFramePick): the doc
// is a sandboxed frame, so to the widget it was one element, the whole page
// ("Document content"), and nothing smaller could be picked (Julie,
// 2026-11-10). With the flag the frame answers what is under the pointer
// (server/frame-probe.js tdoc:fb*): the hover outline hugs the paragraph, a
// click comments on it, a drag over words quotes them, the pins follow the
// frame's scroll. Desktop and phone; and a phone tap that picks never also
// opens the doc's own composer under it (flag or not).
// Run with: node test/feedback-doc-frame-ui.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('feedback-doc-frame-ui.test.js');

let pass = 0, fail = 0;
async function test(name, operation) {
  try { await operation(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message || error}`); fail++; }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

function waitForServer(port, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const request = http.get({ host: '127.0.0.1', port, path: '/api/ping' }, (response) => { response.resume(); resolve(); });
      request.on('error', () => { if (Date.now() >= deadline) reject(new Error('local server did not start')); else setTimeout(poll, 80); });
    })();
  });
}

const SHOTS = process.env.TDOC_SHOTS_DIR || os.tmpdir();
const SLUG = 'frame-pick';
const BODY = '<!doctype html><title>Frame pick</title><h1>Quarterly plan</h1>'
  + '<p id="p1">First paragraph with some words to select.</p>'
  + '<p id="p2">Second paragraph about the launch budget.</p>'
  + Array.from({ length: 40 }, (_, i) => `<p>Filler paragraph ${i + 1}.</p>`).join('');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-fb-frame-'));
  fs.mkdirSync(path.join(root, SLUG, 'v1'), { recursive: true });
  fs.writeFileSync(path.join(root, SLUG, 'v1', 'index.html'), BODY);
  fs.writeFileSync(path.join(root, SLUG, 'meta.json'), JSON.stringify({ slug: SLUG, title: 'Frame pick', versions: [{ n: 1, created: new Date().toISOString() }] }));
  fs.writeFileSync(path.join(root, SLUG, 'comments.json'), '[]');
  const port = await reservePort();
  const base = `http://localhost:${port}`;
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'julie' }, stdio: 'ignore',
  });
  const browser = await chromium.launch();

  // Every stored feedback comment, wherever its space is.
  const stored = () => fs.readdirSync(root).flatMap((dir) => {
    const file = path.join(root, dir, 'comments.json');
    if (dir === SLUG || !fs.existsSync(file)) return [];
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return []; }
  });
  const fb = (p, selector) => p.evaluate((sel) => {
    const r = document.getElementById('tdoc-feedback-root')?.shadowRoot;
    const el = r && r.querySelector(sel);
    return el ? { text: el.innerText, rect: el.getBoundingClientRect().toJSON() } : null;
  }, selector);
  const fbAll = (p, selector) => p.evaluate((sel) => [...(document.getElementById('tdoc-feedback-root')?.shadowRoot?.querySelectorAll(sel) || [])].map((el) => el.getBoundingClientRect().toJSON()), selector);
  // The doc page's own composer (light DOM; the widget's is in its shadow root).
  const docComposers = (p) => p.evaluate(() => document.querySelectorAll('.tdoc-popup').length);

  async function open({ phone = false, flag = true, area = false } = {}) {
    const ctx = await browser.newContext(phone
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
      : { viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript(([on, box]) => { window.__TDOC_FLAGS__ = { feedbackDocFramePick: on, feedbackAreaSelect: box }; }, [flag, area]);
    await p.goto(`${base}/d/${SLUG}/v/1`);
    const frame = await (await p.waitForSelector('iframe.tdoc-doc-frame')).contentFrame();
    await frame.waitForSelector('#p1');
    await p.evaluate((src) => { const s = document.createElement('script'); s.src = src; s.setAttribute('data-tdoc-open', '1'); document.documentElement.appendChild(s); }, `${base}/feedback.js`);
    await p.waitForFunction(() => document.getElementById('tdoc-feedback-root')?.shadowRoot?.querySelector('.tdoc-feedback-dock'));
    const connect = p.locator('#tdoc-feedback-root .tdoc-feedback-notice button.submit');
    if (await connect.count()) {
      const [popup] = await Promise.all([ctx.waitForEvent('page'), connect.click()]);
      await popup.waitForEvent('close', { timeout: 5000 }).catch(() => {});
    }
    const pick = p.locator('#tdoc-feedback-root .tdoc-feedback-dock button.primary');
    const startPicking = async () => {
      await p.waitForTimeout(150);
      // The list opens first once the space has comments (a phone's covers
      // the dock): the public API's comment() is the dock's Comment.
      if (!(await pick.isVisible()) || !(await pick.evaluate((b) => b.classList.contains('on')))) await p.evaluate(() => window.tdocFeedback.comment());
      await p.locator('#tdoc-feedback-root .tdoc-fb-banner').waitFor();
    };
    const box = async (sel) => {
      const b = await frame.locator(sel).boundingBox();
      assert(b, `${sel} has no box`);
      return b;
    };
    return { ctx, p, frame, errors, startPicking, box };
  }

  try {
    await waitForServer(port);

    await test('desktop: hover outlines the paragraph, a click comments on it, a drag quotes words, a box in the margin is an area; pins follow the frame', async () => {
      const { ctx, p, frame, errors, startPicking, box } = await open({ area: true });
      try {
        await startPicking();
        const p1 = await box('#p1');
        await p.mouse.move(p1.x + 30, p1.y + p1.height / 2);
        await p.mouse.move(p1.x + 40, p1.y + p1.height / 2);
        await p.waitForFunction(() => {
          const el = document.getElementById('tdoc-feedback-root').shadowRoot.querySelector('.tdoc-hover-outline');
          return el && el.getBoundingClientRect().height < 100;
        }, null, { timeout: 4000 }).catch(() => {});
        const outline = await fb(p, '.tdoc-hover-outline');
        await p.screenshot({ path: path.join(SHOTS, 'after-desktop-hover.png') });
        assert(outline && Math.abs(outline.rect.top - p1.y) < 6 && outline.rect.height < p1.height + 12,
          `hover outlines ${JSON.stringify(outline && outline.rect)}, not the paragraph at ${JSON.stringify(p1)}`);

        await p.mouse.click(p1.x + 40, p1.y + p1.height / 2);
        const composer = p.locator('#tdoc-feedback-root .tdoc-popup');
        await composer.waitFor();
        const label = (await fb(p, '.tdoc-popup')).text;
        assert(/First paragraph/.test(label) && !/Document content/.test(label), `composer is for ${JSON.stringify(label)}`);
        assert((await docComposers(p)) === 0, 'the doc page opened its own composer too');
        await p.screenshot({ path: path.join(SHOTS, 'after-desktop-click.png') });
        await composer.locator('textarea').fill('Tighten this paragraph');
        await composer.locator('button.submit').click();
        await composer.waitFor({ state: 'detached' });
        const first = stored().find((c) => c.text === 'Tighten this paragraph');
        assert(first && first.anchor && first.anchor.frame, `no frame anchor stored: ${JSON.stringify(first && first.anchor)}`);
        assert(first.anchor.frame.selector === '#p1' && /First paragraph/.test(first.anchor.frame.text), `frame anchor ${JSON.stringify(first.anchor.frame)}`);
        assert(first.anchor.kind === 'product' && /\/d\/frame-pick\/v\/1/.test(first.anchor.url), `anchor page ${first.anchor.url}`);

        // A drag over words: a quote, marked in the doc.
        await startPicking();
        const p2 = await box('#p2');
        await p.mouse.move(p2.x + 2, p2.y + p2.height / 2);
        await p.waitForTimeout(150);
        await p.mouse.down();
        for (let i = 1; i <= 12; i++) await p.mouse.move(p2.x + 2 + i * 12, p2.y + p2.height / 2);
        await p.mouse.up();
        await composer.waitFor();
        const quoteLabel = (await fb(p, '.tdoc-popup')).text;
        assert(/^“Second/.test(quoteLabel), `drag composer is for ${JSON.stringify(quoteLabel)}`);
        await p.screenshot({ path: path.join(SHOTS, 'after-desktop-drag.png') });
        await composer.locator('textarea').fill('Which budget?');
        await composer.locator('button.submit').click();
        await composer.waitFor({ state: 'detached' });
        const second = stored().find((c) => c.text === 'Which budget?');
        assert(second && second.anchor.frame && second.anchor.frame.quote && /^Second/.test(second.anchor.frame.quote.text),
          `quote anchor ${JSON.stringify(second && second.anchor)}`);

        // A drag from the blank margin (area select on): a box in the doc.
        await startPicking();
        await p.mouse.move(60, 300);
        await p.waitForTimeout(50);
        await p.mouse.down();
        for (let i = 1; i <= 10; i++) await p.mouse.move(60 + i * 15, 300 + i * 8);
        await p.mouse.up();
        await composer.waitFor();
        const areaLabel = (await fb(p, '.tdoc-popup')).text;
        assert(/^Area 150×80/.test(areaLabel), `box composer is for ${JSON.stringify(areaLabel)}`);
        await p.screenshot({ path: path.join(SHOTS, 'after-desktop-box.png') });
        await composer.locator('textarea').fill('Too much white space');
        await composer.locator('button.submit').click();
        await composer.waitFor({ state: 'detached' });
        const third = stored().find((c) => c.text === 'Too much white space');
        assert(third && third.anchor.frame && third.anchor.frame.region && third.anchor.frame.region.rel.width === 150,
          `area anchor ${JSON.stringify(third && third.anchor)}`);

        // Pins sit on the paragraph and move with the frame's own scroll.
        await p.waitForFunction(() => document.getElementById('tdoc-feedback-root').shadowRoot.querySelectorAll('.tdoc-pin').length === 3, null, { timeout: 5000 });
        const pinsBefore = (await fbAll(p, '.tdoc-pin')).map((r) => r.top).sort((a, b) => a - b);
        assert(Math.abs(pinsBefore[0] - (p1.y - 14)) < 20, `pin at ${pinsBefore[0]}, paragraph at ${p1.y}`);
        await p.screenshot({ path: path.join(SHOTS, 'after-desktop-pins.png') });
        await frame.evaluate(() => window.scrollTo(0, 60));
        await p.waitForFunction((top) => {
          const tops = [...document.getElementById('tdoc-feedback-root').shadowRoot.querySelectorAll('.tdoc-pin')].map((el) => el.getBoundingClientRect().top).sort((a, b) => a - b);
          return tops.length && Math.abs(tops[0] - (top - 60)) < 6;
        }, pinsBefore[0], { timeout: 4000 });
        assert(!errors.length, `page errors: ${errors.join(' | ')}`);
      } finally { await ctx.close(); }
    });

    await test('phone: a tap comments on the paragraph, and only the widget composer opens', async () => {
      const { ctx, p, startPicking, box } = await open({ phone: true });
      try {
        await startPicking();
        const p1 = await box('#p1');
        await p.touchscreen.tap(p1.x + 30, p1.y + p1.height / 2);
        await p.locator('#tdoc-feedback-root .tdoc-popup').waitFor();
        await p.waitForTimeout(500);
        const label = (await fb(p, '.tdoc-popup')).text;
        await p.screenshot({ path: path.join(SHOTS, 'after-phone-tap.png') });
        assert(/First paragraph/.test(label), `phone composer is for ${JSON.stringify(label)}`);
        assert((await docComposers(p)) === 0, 'the doc page opened its own composer under the widget');
      } finally { await ctx.close(); }
    });

    await test('phone, flag off: the tap that picks does not also open the doc composer', async () => {
      const { ctx, p, startPicking, box } = await open({ phone: true, flag: false });
      try {
        await startPicking();
        const p1 = await box('#p1');
        await p.touchscreen.tap(p1.x + 30, p1.y + p1.height / 2);
        await p.locator('#tdoc-feedback-root .tdoc-popup').waitFor();
        await p.waitForTimeout(500);
        assert((await docComposers(p)) === 0, 'two composers: the widget one and the doc page one');
      } finally { await ctx.close(); }
    });
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
