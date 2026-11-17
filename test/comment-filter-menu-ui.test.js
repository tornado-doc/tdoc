// The doc page's comment filter lives once, at the head of the side comment
// list (Serena, 2026-11-16: the bar's chevron "Show" menu repeated the list's
// Open / Replied / Resolved / All, and the Comment button's count and dot
// followed the filter, so a doc with nothing open read "4" with a blue dot).
// The Comment button is the mark and the number of open threads, nothing
// when none is open; its dot is unread agent replies only. Nothing floats
// over the comment column (Julie, 2026-11-16). On a phone the drawer keeps
// the same filter. Threads refresh by the poll (use-comment-feed.js).
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
    const label = async (page) => (await page.locator('.tdoc-comments-toggle').innerText()).replace(/\s+/g, ' ').trim();

    await t('desktop: one Comment button with the open count, no chevron, no dot; the filter is the side list\'s, Open by default', async () => {
      const { ctx, page } = await open({ width: 1512, height: 823 });
      await page.locator('.tdoc-bar .tdoc-comments-toggle').waitFor();
      assert.equal(await page.locator('.tdoc-comments-filter-menu, .tdoc-comments-filter-popup, .tdoc-comments-split').count(), 0,
        'the bar still repeats the comment filter');
      assert.equal(await page.locator('.tdoc-comment-filter-dock, .tdoc-comment-filter, .tdoc-comment-refresh').count(), 0,
        'a filter or Refresh still floats over the comment column');
      assert.equal(await label(page), '1');
      assert.equal(await page.locator('.tdoc-comments-toggle').getAttribute('title'), 'Comments');
      assert.equal(await page.locator('.tdoc-comments-toggle').getAttribute('aria-label'), 'Comments, 1 open');
      assert.equal(await page.locator('.tdoc-comments-toggle-dot').count(), 0, 'a dot with nothing unread');
      const box = await page.locator('.tdoc-comments-toggle').boundingBox();
      assert.ok(box.width <= 60, `the Comment button is ${Math.round(box.width)}px wide`);
      assert.deepEqual(await docFilterLabels(page), ['Open (1)', 'Replied (0)', 'Resolved (4)', 'All (5)']);
      assert.equal(await (await docFilterItem(page, 'Open')).getAttribute('aria-checked'), 'true', 'Open is not the default');
      await closeDocFilterMenu(page);
      await page.locator('.tdoc-pin[data-id="open"]').waitFor();
      assert.equal(await page.locator('.tdoc-pin[data-id="resolved"]').count(), 0, 'Open shows a resolved thread');
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t('desktop: picking Resolved filters the pins; the button still counts open threads, no dot; remembered; back to Open', async () => {
      const { ctx, page } = await open({ width: 1512, height: 823 });
      await pickDocFilter(page, 'Resolved');
      await page.locator('.tdoc-pin[data-id="resolved"]').waitFor();
      assert.equal(await page.locator('.tdoc-pin[data-id="open"]').count(), 0, 'Resolved still shows an open thread');
      assert.equal(await label(page), '1', 'the button counts what the filter shows, not what is open');
      assert.equal(await page.locator('.tdoc-comments-toggle-dot').count(), 0, 'the filter put a dot on the button');
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
      assert.equal(await (await docFilterItem(page, 'Resolved')).getAttribute('aria-checked'), 'true', 'the choice was not remembered');
      await closeDocFilterMenu(page);
      await pickDocFilter(page, 'Open');
      await page.locator('.tdoc-pin[data-id="open"]').waitFor();
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t('desktop: nothing open, Resolved shown (the reported case): the button is the bare mark, no "4", no dot', async () => {
      const resolvedOnly = comments.filter((c) => c.id !== 'open');
      const ctx = await browser.newContext({ viewport: { width: 1512, height: 823 } });
      await ctx.addInitScript(() => { try { localStorage.setItem('tdoc.comment-filter.sample-doc', 'resolved'); } catch {} });
      const page = await ctx.newPage();
      page.errors = [];
      page.on('pageerror', (e) => page.errors.push(e.message));
      await page.route('**/api/comments*', (route) => route.fulfill({ json: resolvedOnly }));
      await page.goto(target.url);
      await page.waitForFunction(() => document.body.dataset.tdocReady === '1');
      await page.locator('.tdoc-pin[data-id="resolved"]').waitFor();
      assert.equal(await label(page), '');
      assert.equal(await page.locator('.tdoc-comments-toggle-count, .tdoc-comments-toggle-dot').count(), 0);
      assert.equal(await page.locator('.tdoc-comments-toggle').getAttribute('aria-label'), 'Comments');
      // Open, the button is a quiet grey fill, not the accent.
      await page.locator('.tdoc-comments-toggle').click();
      await page.locator('.tdoc-doc-side .tdoc-comment-filter').waitFor();
      const look = await page.locator('.tdoc-comments-toggle').evaluate((el) => {
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--td-accent').trim();
        const probe = document.createElement('span');
        probe.style.color = accent; document.body.append(probe);
        const accentRgb = getComputedStyle(probe).color; probe.remove();
        return { color: getComputedStyle(el).color, accentRgb };
      });
      assert.notEqual(look.color, look.accentRgb, 'the open Comment button is drawn in the accent');
      assert.deepEqual(page.errors, []);
      await ctx.close();
    });

    await t('desktop: a card scrolled to the top of the comment column has nothing on top of it', async () => {
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
