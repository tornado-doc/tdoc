// My docs rows show the doc's opening line under the title, in a real
// browser against the local server and built shell: one line on desktop,
// up to two on a phone, never pushing the row actions off the row.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('my-docs-preview-ui.test.js');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

(async () => {
  console.log('My docs preview UI');
  const target = await resolveTarget({ e2eUser: 'alice' });
  const base = new URL(target.url).origin;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(`${base}/me`);
        const row = page.locator('.doc-row[data-slug="sample-doc"]');
        await row.waitFor();
        const excerpt = row.locator('.doc-excerpt');
        assert.equal(await excerpt.count(), 1, 'the row has no opening-line preview');
        assert.ok((await excerpt.textContent()).trim().length > 10, 'the preview is empty');
        const box = await excerpt.evaluate((el) => {
          const s = getComputedStyle(el);
          const lh = parseFloat(s.lineHeight);
          return { lines: Math.round(el.getBoundingClientRect().height / lh), size: s.fontSize };
        });
        assert.equal(box.size, '13px');
        assert.ok(box.lines <= (width > 700 ? 1 : 2), `preview runs ${box.lines} lines`);
        const fits = await row.evaluate((el) => {
          const actions = el.querySelector('.row-actions').getBoundingClientRect();
          return actions.right <= el.getBoundingClientRect().right + 1;
        });
        assert.ok(fits, 'row actions were pushed off the row');
        assert.deepEqual(errors, []);
        if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `my-docs-${width}.png`) }); }
        console.log(`  ✓ ${width}px: rows show the opening line, actions stay in the row`);
      } catch (e) {
        failed++;
        console.log(`  ✗ ${width}px\n    ${e.message}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
    await target.stop();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
