// Slides mode: a doc whose author HTML marks pages with data-tdoc-slide gets a
// Present control that shows one slide at a time, fitted to the screen, with
// keyboard, button and swipe navigation, and restores the page on exit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requirePlaywrightOrSkip, resolveTarget } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('slides-mode.test.js');
(async () => {
  const target = await resolveTarget();
  const browser = await chromium.launch();
  let failed = 0;
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    for (const width of [1280, 390]) {
      try {
        await page.setViewportSize({ width, height: 820 });
        await page.goto(new URL('/d/slides-mode/v/1', target.url).href);
        const frame = page.frameLocator('iframe[aria-label="Document content"]');
        await frame.locator('html[data-tdoc-interaction-mode]').waitFor();
        const before = await frame.locator('#s2').getAttribute('style');
        // Slide view: each slide is a 960px 16:9 card zoomed to the column,
        // numbered underneath, and the page does not scroll sideways.
        await frame.locator('.tdoc-slide-num').first().waitFor();
        const view = await frame.locator('html').evaluate(() => {
          const s = document.querySelector('#s1'), r = s.getBoundingClientRect();
          return { layoutWidth: s.offsetWidth, w: r.width, h: r.height, room: s.parentElement.clientWidth,
            nums: Array.from(document.querySelectorAll('.tdoc-slide-num')).map((n) => n.textContent),
            overflow: document.documentElement.scrollWidth - innerWidth };
        });
        assert.equal(view.layoutWidth, 960, 'slides are laid out at 960px');
        assert(Math.abs(view.w / view.h - 16 / 9) < 0.02, `16:9 card: ${view.w}x${view.h}`);
        assert(view.w <= view.room + 1, `card fits the column: ${view.w} > ${view.room}`);
        assert.deepEqual(view.nums, ['1 / 3', '2 / 3', '3 / 3 · content is cut off'], 'overflowing slide is flagged');
        assert(view.overflow <= 1, `no sideways overflow in slide view: ${view.overflow}`);
        if (process.env.TDOC_TEST_SCREENSHOTS) {
          fs.mkdirSync(process.env.TDOC_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.TDOC_TEST_SCREENSHOTS, `slide-view-${width}.png`), fullPage: true });
        }
        await frame.getByRole('button', { name: 'Present slides' }).click();
        await page.locator('[data-visual-open]').waitFor();
        await frame.locator('html[data-tdoc-presenting]').waitFor();
        const counter = frame.locator('.tdoc-present-bar output');
        assert.equal(await counter.textContent(), '1 / 3');
        const fits = async (id) => {
          const r = await frame.locator(id).boundingBox();
          assert(r && r.x >= -1 && r.x + r.width <= width + 1 && r.y >= -1 && r.y + r.height <= 821, `${id} fits ${width}px: ${JSON.stringify(r)}`);
        };
        await fits('#s1');
        assert.equal(await frame.getByRole('button', { name: 'Previous slide' }).isDisabled(), true);
        await page.keyboard.press('ArrowRight');
        assert.equal(await counter.textContent(), '2 / 3');
        await fits('#s2');
        assert.equal(await frame.locator('#s1').getAttribute('aria-current'), null);
        await frame.getByRole('button', { name: 'Next slide' }).click();
        assert.equal(await counter.textContent(), '3 / 3');
        assert.equal(await frame.getByRole('button', { name: 'Next slide' }).isDisabled(), true);
        // Commenting while presenting: slide 2 has one thread; its count is
        // on the bar and opens the card above the full-screen frame.
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowRight');
        await frame.getByRole('button', { name: 'Show 2 comments on this slide' }).click();
        // Desktop opens the floating card, a phone the comment drawer; both
        // above the full-screen frame.
        const card = width < 700 ? page.locator('#tdoc-comment-layer.open') : page.locator('.tdoc-floating-open');
        await card.waitFor();
        const cb = await card.boundingBox();
        assert(cb && cb.width > 0 && cb.y >= 0 && cb.y < 820, `comment card visible while presenting: ${JSON.stringify(cb)}`);
        const first = await card.textContent();
        assert(/Make this a number|shorten the title/.test(first), first);
        if (width >= 700) {
          // A second press opens the slide's other thread.
          await frame.getByRole('button', { name: 'Show 2 comments on this slide' }).click();
          await page.waitForFunction((f) => { const c = document.querySelector('.tdoc-floating-open'); return c && c.textContent !== f; }, first);
          assert(/Make this a number|shorten the title/.test(await card.textContent()));
        }
        assert.equal(await frame.locator('html[data-tdoc-presenting]').count(), 1, 'still presenting');
        if (width < 700) { await page.keyboard.press('Escape'); await card.waitFor({ state: 'hidden' }); }
        await frame.getByRole('button', { name: 'Comment on this slide', exact: true }).click();
        const popup = page.locator('.tdoc-popup');
        await popup.waitFor();
        const pb = await popup.boundingBox();
        assert(pb && pb.y >= 0 && pb.y + 40 < 820, `composer visible while presenting: ${JSON.stringify(pb)}`);
        if (process.env.TDOC_TEST_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.TDOC_TEST_SCREENSHOTS, `present-comment-${width}.png`) });
        await popup.getByRole('button', { name: 'Close' }).click();
        // Give the keyboard back to the slides (focus moved to the shell's composer).
        await frame.locator('.tdoc-present-bar output').click();
        await page.keyboard.press('Home');
        assert.equal(await counter.textContent(), '1 / 3');
        // Laid out at presentation width, then scaled: on a phone the slide
        // keeps its desktop layout (the box is wider than the reading column).
        assert(await frame.locator('#s1').evaluate((el) => el.offsetWidth >= 960), 'slide laid out at presentation width');
        await page.keyboard.press('ArrowRight');
        await frame.getByRole('button', { name: 'Previous slide' }).focus();
        await page.keyboard.press(' ');
        assert.equal(await counter.textContent(), '1 / 3', 'space on the previous button goes back');
        if (process.env.TDOC_TEST_SCREENSHOTS) {
          fs.mkdirSync(process.env.TDOC_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.TDOC_TEST_SCREENSHOTS, `slides-${width}.png`) });
        }
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Escape');
        await page.locator('[data-visual-open]').waitFor({ state: 'detached' });
        assert.equal(await frame.locator('html[data-tdoc-presenting]').count(), 0);
        // The comment hover can leave an empty style attribute; only content counts.
        assert.equal((await frame.locator('#s2').getAttribute('style')) || '', before || '', 'temporary styles restored');
        assert.equal(await frame.locator('.tdoc-present-stage').count(), 0, 'stage removed');
        assert(await frame.locator('html').evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways overflow after exit');
        console.log(`  ✓ present, navigate and exit at ${width}px`);
      } catch (error) { failed++; console.log(`  ✗ ${width}px\n    ${error.stack.split('\n').slice(0,4).join(' | ')}`); }
    }
    try {
      await page.goto(new URL('/d/visual-viewer/v/1', target.url).href);
      const frame = page.frameLocator('iframe[aria-label="Document content"]');
      await frame.locator('html[data-tdoc-interaction-mode]').waitFor();
      await page.waitForTimeout(300);
      assert.equal(await frame.getByRole('button', { name: 'Present slides' }).count(), 0);
      console.log('  ✓ a doc without slides shows no Present control');
    } catch (error) { failed++; console.log(`  ✗ no-slides doc\n    ${error.message}`); }
    assert.deepEqual(errors, [], 'page errors');
  } finally { await browser.close(); await target.stop(); }
  if (failed) process.exitCode = 1; else console.log('\nall passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
