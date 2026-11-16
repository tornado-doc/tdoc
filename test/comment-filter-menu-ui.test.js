// The doc page's comment filter lives in the bar (Julie, 2026-11-16: the
// floating "Open / Replied / Resolved / All" row and its Refresh icon sat on
// the comment column and covered her cards). On a wide screen it is the
// chevron beside Comment: the four choices with counts, Open by default, a
// choice other than Open named on the button; nothing of it floats over the
// document and the first card has nothing on top of it. On a phone the
// drawer keeps its filter. Threads refresh by the poll (use-comment-feed.js).
// Run with: node test/comment-filter-menu-ui.test.js
const assert = require('assert/strict');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { closeDocFilterMenu, docFilterItem, docFilterLabels, pickDocFilter } = require('./helpers/doc-filter');
const { chromium, webkit } = requirePlaywrightOrSkip('comment-filter-menu-ui.test.js');
const comments = require('./fixtures/resolved-visibility-comments.json');

(async () => {
  const target = await resolveTarget();
  const engine = process.env.TDOC_TEST_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
  };
  const open = async (viewport, init = null) => {
    const ctx = await browser.newContext({ viewport, ...(viewport.width < 700 ? { isMobile: true, hasTouch: true } : {}) });
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await page.route('**/api/comments*', (route) => route.fulfill({ json: comments }));
    await page.goto(target.url);
    await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
    return { ctx, page };
  };
  try {
    await t('desktop: no filter row or Refresh over the comments; the filter is the Comment chevron, Open by default', async () => {
      const { ctx, page } = await open({ width: 1512, height: 823 });
      await page.locator('.tdoc-bar .tdoc-comments-filter-menu').waitFor();
      assert.equal(await page.locator('.tdoc-comment-filter-dock, .tdoc-comment-filter, .tdoc-comment-refresh').count(), 0,
        'a filter or Refresh still floats over the comment column');
      assert.deepEqual(await docFilterLabels(page), ['Open (1)', 'Replied (0)', 'Resolved (4)', 'All (5)']);
      assert.equal(await (await docFilterItem(page, 'Open')).getAttribute('aria-checked'), 'true', 'Open is not the default');
      await closeDocFilterMenu(page);
      assert.equal((await page.locator('.tdoc-comments-toggle').innerText()).replace(/\s+/g, ' ').trim(), 'Comment 1');
      await page.locator('.tdoc-pin[data-id="open"]').waitFor();
      assert.equal(await page.locator('.tdoc-pin[data-id="resolved"]').count(), 0, 'Open shows a resolved thread');
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t('desktop: picking Resolved filters the pins and names itself on the button; remembered; back to Open', async () => {
      const { ctx, page } = await open({ width: 1512, height: 823 });
      await pickDocFilter(page, 'Resolved');
      await page.locator('.tdoc-pin[data-id="resolved"]').waitFor();
      assert.equal(await page.locator('.tdoc-pin[data-id="open"]').count(), 0, 'Resolved still shows an open thread');
      assert.equal((await page.locator('.tdoc-comments-toggle').innerText()).replace(/\s+/g, ' ').trim(), 'Comment · Resolved 4');
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
      assert.equal(await (await docFilterItem(page, 'Resolved')).getAttribute('aria-checked'), 'true', 'the choice was not remembered');
      await pickDocFilter(page, 'Open');
      await page.locator('.tdoc-pin[data-id="open"]').waitFor();
      assert.equal(await page.locator('.tdoc-comments-toggle-filter').count(), 0, 'Open, the default, is named on the button');
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t('desktop: a card scrolled to the top of the comment column has nothing on top of it, and the menu keeps it open', async () => {
      const { ctx, page } = await open({ width: 1512, height: 823 }, () => { try { localStorage.setItem('tdoc.comment-filter.sample-doc', 'all'); } catch {} });
      await page.locator('.tdoc-pin[data-id="resolved"]').click();
      const card = page.locator('.tdoc-margin-comment').first();
      await card.waitFor();
      await page.mouse.move(700, 400);
      await page.mouse.wheel(0, 260);
      await page.waitForTimeout(400);
      const covered = await card.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const points = [];
        for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.05, 0.3]) points.push([r.left + r.width * fx, r.top + r.height * fy]);
        return points.filter(([x, y]) => { const hit = document.elementFromPoint(x, y); return !hit || !el.contains(hit); })
          .map(([x, y]) => `${Math.round(x)},${Math.round(y)}: ${document.elementFromPoint(x, y)?.className}`);
      });
      assert.deepEqual(covered, [], 'something sits over the first card');
      // Pressing the filter is not a press on the page: the card stays.
      await pickDocFilter(page, 'Resolved');
      assert.equal(await page.locator('.tdoc-margin-comment').count(), 1, 'the filter menu closed a card it still shows');
      await pickDocFilter(page, 'Open');
      await page.locator('.tdoc-margin-comment').waitFor({ state: 'detached' });
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t('phone 390: the drawer keeps a working filter; nothing floats over the page', async () => {
      const { ctx, page } = await open({ width: 390, height: 844 });
      assert.equal(await page.locator('.tdoc-comment-filter-dock').count(), 0);
      await page.locator('.tdoc-fab').click();
      const drawer = page.locator('#tdoc-comment-layer[data-open]');
      await drawer.waitFor();
      const filter = drawer.locator('.tdoc-comment-filter');
      assert.equal(await filter.getByRole('radio', { name: /^Open/ }).getAttribute('aria-checked'), 'true');
      assert.equal(await drawer.locator('[data-comment-id]').count(), 1);
      await filter.getByRole('radio', { name: /^All/ }).click();
      await page.waitForFunction(() => document.querySelectorAll('#tdoc-comment-layer [data-comment-id]').length === 5);
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });
  } finally {
    await browser.close();
    await target.stop();
  }
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
