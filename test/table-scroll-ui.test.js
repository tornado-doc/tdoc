// A table wider than the reading column scrolls sideways inside its own box,
// in the real shell, desktop and phone ("table不能scroll", Julie 2026-11-08).
// With overlay scrollbars (the macOS / iOS default) the wrapper drew no bar at
// all: the table was cut at the column edge, nothing said it scrolled and a
// mouse had nothing to drag. Chromium here runs with overlay scrollbars on
// every OS (CI is Linux, whose default is classic bars) and without
// --hide-scrollbars, so the bar a reader sees is the bar this test measures.
//
// Checks: the overflowing wrapper draws a scrollbar (a narrow table draws
// none); dragging that bar, a horizontal wheel and a touch swipe all scroll the
// table; a vertical wheel / swipe over the table still scrolls the document;
// a drag inside a cell still selects text for a comment.
// Run with: node test/table-scroll-ui.test.js
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('table-scroll-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

(async () => {
  console.log('Wide tables scroll inside their own box (real shell)');
  const target = await resolveTarget();
  const browser = await chromium.launch({
    ignoreDefaultArgs: ['--hide-scrollbars'],
    args: ['--enable-features=OverlayScrollbar'],
  });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n    ${String(e.message).split('\n').slice(0, 6).join('\n    ')}`); }
  };
  const open = async (width, phone) => {
    const ctx = await browser.newContext(phone
      ? { viewport: { width, height: 844 }, hasTouch: true, isMobile: true }
      : { viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(new URL('/d/wide-table/v/1', target.url).href);
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    const frame = await (await page.locator('iframe[aria-label="Document content"]').elementHandle()).contentFrame();
    await frame.waitForFunction(() => document.querySelector('#wide')?.parentElement.classList.contains('tdoc-table-scroll')
      && document.querySelector('style#tdoc-provider-table-layout')?.textContent.includes('min-width'));
    const wrap = frame.locator('.tdoc-table-scroll:has(#wide)');
    // Whole wrapper on screen, its scrollbar included.
    await wrap.evaluate((w) => w.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    const state = () => frame.evaluate(() => {
      const w = document.querySelector('#wide').parentElement;
      const n = document.querySelector('#narrow').parentElement;
      return { left: w.scrollLeft, max: w.scrollWidth - w.clientWidth, bar: w.offsetHeight - w.clientHeight,
        narrowBar: n.offsetHeight - n.clientHeight, narrowOverflow: n.scrollWidth - n.clientWidth,
        docY: scrollY, pageOverflow: document.documentElement.scrollWidth - innerWidth };
    });
    const reset = () => frame.evaluate(() => { document.querySelector('#wide').parentElement.scrollLeft = 0; });
    return { ctx, page, frame, wrap, state, reset, errors };
  };
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); } };

  try {
    await t('desktop 1400: the wide table shows a bar, and bar, wheel and selection all work', async () => {
      const { ctx, page, wrap, state, reset, frame, errors } = await open(1400, false);
      try {
        const s = await state();
        assert(s.max > 100, `fixture table must overflow its column (max scroll ${s.max})`);
        assert.equal(s.pageOverflow, 0, 'the page itself must not scroll sideways');
        assert(s.bar >= 6, `an overflowing table must draw a visible scrollbar (got ${s.bar}px)`);
        assert.equal(s.narrowOverflow <= 0 && s.narrowBar, 0, 'a table that fits draws no bar');
        await shot(page, 'table-scroll-1400.png');
        let box = await wrap.boundingBox();
        // Vertical wheel over the table scrolls the document, not the table.
        await page.mouse.move(box.x + box.width / 2, box.y + 40);
        const before = (await state()).docY;
        await page.mouse.wheel(0, 300); await page.waitForTimeout(400);
        const after = await state();
        assert(after.docY > before + 100, `vertical wheel over a table must scroll the page (${before} -> ${after.docY})`);
        assert.equal(after.left, 0, 'vertical wheel must not move the table sideways');
        await wrap.evaluate((w) => w.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(300);
        box = await wrap.boundingBox();
        // Drag the bar's thumb (the bottom strip of the wrapper) right, then back.
        const y = box.y + box.height - s.bar / 2;
        await page.mouse.move(box.x + 15, y); await page.mouse.down();
        await page.mouse.move(box.x + 250, y, { steps: 10 }); await page.mouse.up();
        await page.waitForTimeout(200);
        const dragged = (await state()).left;
        assert(dragged > 50, `dragging the scrollbar must scroll the table (left ${dragged})`);
        await reset();
        // Trackpad sideways swipe / horizontal wheel.
        await page.mouse.move(box.x + box.width / 2, box.y + 40);
        await page.mouse.wheel(200, 0); await page.waitForTimeout(400);
        assert((await state()).left > 50, 'a horizontal wheel must scroll the table');
        await reset();
        // A drag inside a cell is still a text selection for commenting.
        const cell = await frame.locator('#wide tbody td').nth(1).boundingBox();
        await page.mouse.move(cell.x + 4, cell.y + cell.height / 2); await page.mouse.down();
        await page.mouse.move(cell.x + cell.width - 4, cell.y + cell.height / 2, { steps: 8 }); await page.mouse.up();
        await page.waitForTimeout(200);
        const selected = await frame.evaluate(() => getSelection().toString().trim());
        assert(selected.length > 3, `a drag in a cell must select its text (got "${selected}")`);
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });

    await t('phone 390: the wide table shows a bar; a sideways swipe scrolls it, an upward swipe scrolls the page', async () => {
      const { ctx, page, wrap, state, errors } = await open(390, true);
      try {
        const s = await state();
        assert(s.max > 100, `fixture table must overflow (max ${s.max})`);
        assert.equal(s.pageOverflow, 0, 'the page itself must not scroll sideways');
        assert(s.bar >= 6, `an overflowing table must draw a visible scrollbar (got ${s.bar}px)`);
        await shot(page, 'table-scroll-390.png');
        const box = await wrap.boundingBox();
        const cdp = await ctx.newCDPSession(page);
        const swipe = async (x0, y0, x1, y1) => {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
          for (let i = 1; i <= 12; i++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 12, y: y0 + ((y1 - y0) * i) / 12 }] });
            await page.waitForTimeout(16);
          }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await page.waitForTimeout(500);
        };
        const cx = box.x + box.width / 2, cy = box.y + Math.min(80, box.height / 2);
        await swipe(cx + 110, cy, cx - 110, cy);
        const h = await state();
        assert(h.left > 50, `a sideways swipe must scroll the table (left ${h.left})`);
        await swipe(cx, cy + 120, cx, cy - 120);
        const v = await state();
        assert(v.docY > h.docY + 50, `an upward swipe over the table must scroll the page (${h.docY} -> ${v.docY})`);
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });
  } finally {
    await browser.close();
    await target.stop();
  }
  console.log(failed ? `\n${failed} failed.` : '\nall passed.');
  process.exit(failed ? 1 : 0);
})();
