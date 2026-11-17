// The doc bar's Comment button and its filter caret sit side by side, never on
// top of each other (Julie, 2026-11-16: after the compact button, #1072, the
// "Filter comments" caret covered a two-digit count). The mark, the count, the
// filter dot and the caret are plain inline flow, so the group grows with the
// count: 1, 12 and 123 open threads, the default filter and another one (the
// dot), on a doc, a sheet and a deck, wide and narrow desktop; the phone bar
// has no such button.
// Run with: node test/comment-count-caret-ui.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { pickDocFilter, closeDocFilterMenu } = require('./helpers/doc-filter');
const { chromium } = requirePlaywrightOrSkip('comment-count-caret-ui.test.js');
const SHOTS = process.env.TDOC_TEST_SCREENSHOTS || '';

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function waitForServer(port, timeout = 8000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(); });
      req.on('error', () => { if (Date.now() > deadline) reject(new Error('server did not start')); else setTimeout(poll, 80); });
    })();
  });
}

(async () => {
  const M = await import('../shared/sheet-markup.mjs');
  const S = await import('../shared/slides-markup.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-count-caret-'));
  const thread = (i, status) => ({
    id: `c${i}`, text: `thread ${i}`, anchor: { kind: 'document' }, status,
    ...(status === 'applied' ? { applied_in: 1 } : {}),
    author: { login: 'owner' }, created: '2026-11-16T00:00:00Z', version: 1, replies: [],
  });
  const writeDoc = (slug, html, open) => {
    fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), html);
    fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({ slug, title: 'Plan', versions: [{ n: 1, created: new Date().toISOString() }] }));
    // `open` open threads and as many resolved ones, so the Resolved filter
    // (the dot) shows the same number of digits.
    const comments = [];
    for (let i = 0; i < open; i++) comments.push(thread(`o${i}`, 'open'));
    for (let i = 0; i < open; i++) comments.push(thread(`r${i}`, 'applied'));
    fs.writeFileSync(path.join(root, slug, 'comments.json'), JSON.stringify(comments));
  };
  const COUNTS = [1, 12, 123];
  const KINDS = {
    doc: () => '<!doctype html><html><head><meta charset="utf-8"><title>Plan</title></head><body><main><h1>Plan</h1><p>What we will do, and why.</p></main></body></html>',
    sheet: () => M.blankSheetHtml('Plan'),
    deck: () => S.blankDeckHtml('Plan'),
  };
  for (const kind of Object.keys(KINDS)) for (const n of COUNTS) writeDoc(`${kind}-${n}`, KINDS[kind](), n);

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'owner' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  let browser;
  console.log('doc bar: the filter caret never covers the comment count');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });

    // Boxes of the count text (its glyphs, via a Range), the dot, the toggle
    // and the caret trigger, in the bar.
    const geometry = (page) => page.evaluate(() => {
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; };
      const bar = document.querySelector('.tdoc-bar');
      const count = bar.querySelector('.tdoc-comments-toggle-count');
      const range = document.createRange();
      if (count) range.selectNodeContents(count);
      return {
        text: count ? count.textContent : null,
        countText: count ? r(range) : null,
        count: r(count),
        dot: r(bar.querySelector('.tdoc-comments-toggle-dot')),
        toggle: r(bar.querySelector('.tdoc-comments-toggle')),
        caret: r(bar.querySelector('.tdoc-comments-filter-menu')),
      };
    });
    const apart = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5;
    const check = (g, label, n, dot) => {
      assert(g.text === String(n), `${label}: the count reads ${JSON.stringify(g.text)}, not ${n}`);
      assert(g.caret, `${label}: no filter caret`);
      assert(apart(g.countText, g.caret), `${label}: the caret ${JSON.stringify(g.caret)} covers the count text ${JSON.stringify(g.countText)}`);
      assert(apart(g.count, g.caret), `${label}: the caret ${JSON.stringify(g.caret)} covers the count ${JSON.stringify(g.count)}`);
      assert(apart(g.toggle, g.caret), `${label}: the caret ${JSON.stringify(g.caret)} overlaps the Comment button ${JSON.stringify(g.toggle)}`);
      assert(g.countText.right <= g.toggle.right + 0.5, `${label}: the count spills out of the Comment button`);
      if (dot) {
        assert(g.dot, `${label}: no filter dot`);
        assert(apart(g.dot, g.caret) && apart(g.dot, g.countText), `${label}: the dot overlaps the count or the caret`);
      }
      // Compact: mark + count + caret, no wider than the digits need.
      const limit = 80 + 8 * (String(n).length - 1) + (dot ? 8 : 0);
      assert(g.caret.right - g.toggle.left <= limit, `${label}: the group is ${Math.round(g.caret.right - g.toggle.left)}px wide (limit ${limit})`);
    };

    // Phone (390): the bar has no Comment button (the drawer has the list and
    // its filter), so nothing to cover; it must stay that way.
    await test('phone: no Comment split button in the bar (the drawer keeps the filter)', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      for (const kind of Object.keys(KINDS)) {
        await page.goto(`${base}/d/${kind}-123/v/1`);
        await page.locator('.tdoc-document-app').waitFor();
        await page.waitForTimeout(500);
        assert(await page.locator('.tdoc-bar .tdoc-comments-filter-menu').count() === 0, `${kind}: a filter caret in the phone bar`);
      }
      await context.close();
    });

    // Julie's 1512 wide window, and 720, just wider than the phone layout,
    // where the bar is most crowded.
    for (const [label, viewport] of [['desktop', { width: 1512, height: 945 }], ['narrow-desktop', { width: 720, height: 900 }]]) {
      for (const kind of Object.keys(KINDS)) {
        await test(`${label} ${kind}: caret clear of a 1-, 2- and 3-digit count, Open and Resolved (dot)`, async () => {
          // 3x so the screenshots are zoomed crops.
          const context = await browser.newContext({ viewport, deviceScaleFactor: SHOTS ? 3 : 1 });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          for (const n of COUNTS) {
            await page.goto(`${base}/d/${kind}-${n}/v/1`);
            await page.locator('.tdoc-document-app').waitFor();
            await page.locator('.tdoc-bar .tdoc-comments-filter-menu').waitFor();
            await page.waitForFunction((want) => document.querySelector('.tdoc-bar .tdoc-comments-toggle-count')?.textContent === want, String(n));
            check(await geometry(page), `${kind} ${n} Open`, n, false);
            if (SHOTS) {
              fs.mkdirSync(SHOTS, { recursive: true });
              const box = await page.locator('.tdoc-bar .tdoc-comments-split').boundingBox();
              await page.screenshot({ path: path.join(SHOTS, `count-caret-${label}-${kind}-${n}.png`), clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 8), width: box.width + 48, height: box.height + 16 } });
            }
            await pickDocFilter(page, /^Resolved/);
            await closeDocFilterMenu(page).catch(() => {});
            await page.locator('.tdoc-bar .tdoc-comments-toggle-dot').waitFor();
            await page.waitForFunction((want) => document.querySelector('.tdoc-bar .tdoc-comments-toggle-count')?.textContent === want, String(n));
            check(await geometry(page), `${kind} ${n} Resolved`, n, true);
            if (SHOTS) {
              const box = await page.locator('.tdoc-bar .tdoc-comments-split').boundingBox();
              await page.screenshot({ path: path.join(SHOTS, `count-caret-${label}-${kind}-${n}-dot.png`), clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 8), width: box.width + 48, height: box.height + 16 } });
            }
            await pickDocFilter(page, /^Open/);
            await closeDocFilterMenu(page).catch(() => {});
          }
          assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
          await context.close();
        });
      }
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
