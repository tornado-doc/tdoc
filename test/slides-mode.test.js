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
        await page.keyboard.press('Home');
        assert.equal(await counter.textContent(), '1 / 3');
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
      } catch (error) { failed++; console.log(`  ✗ ${width}px\n    ${error.message}`); }
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
