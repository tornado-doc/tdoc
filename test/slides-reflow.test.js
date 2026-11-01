// Phone browse mode for slides. A deck written to the slides guide (cqw type
// with px floors, .inner released by a container query, .cols stacking) is
// read on a phone like a page: every card as wide as the phone and as tall as
// its content. A deck that cannot reflow (text placed absolutely, wider than
// the card, or under 11px) keeps the scaled 960px cards, for the whole deck.
// Present and desktop browse do not change. A slide's fullscreen button sits
// under the card, never over its text, and tapping a card opens nothing.
// Run with: node test/slides-reflow.test.js

const assert = require('node:assert/strict');
const path = require('node:path');
const { requirePlaywrightOrSkip, resolveTarget } = require('./helpers/fixture-server');
const pw = requirePlaywrightOrSkip('slides-reflow.test.js');

(async () => {
  const target = await resolveTarget();
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack.split('\n').slice(0, 3).join(' | ')}`); }
  };
  const shots = process.env.TDOC_TEST_SCREENSHOTS;
  const open = async (browser, slug, width) => {
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: width < 700 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(new URL(`/d/${slug}/v/1`, target.url).href);
    const frame = page.frameLocator('iframe[aria-label="Document content"]');
    await frame.locator('.tdoc-slide-num').first().waitFor({ timeout: 15000 });
    await frame.locator('.tdoc-visual-open.is-slide').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);
    return { ctx, page, frame, errors };
  };
  const measure = (frame) => frame.locator('html').evaluate(() => {
    const cards = [...document.querySelectorAll('[data-tdoc-slide]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.id, layout: el.offsetWidth, w: r.width, h: r.height, top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right, room: el.parentElement.clientWidth - parseFloat(getComputedStyle(el.parentElement).paddingLeft) - parseFloat(getComputedStyle(el.parentElement).paddingRight) };
    });
    const buttons = [...document.querySelectorAll('.tdoc-visual-open.is-slide')].filter((b) => !b.hidden).map((b) => { const r = b.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right }; });
    const nums = [...document.querySelectorAll('.tdoc-slide-num')].map((n) => { const r = n.getBoundingClientRect(); return { text: n.textContent, top: r.top + scrollY, left: r.left, right: r.right }; });
    const body = [...document.querySelectorAll('[data-tdoc-slide] p, [data-tdoc-slide] li')].map((p) => parseFloat(getComputedStyle(p).fontSize));
    return { mode: document.documentElement.getAttribute('data-tdoc-slides'), cards, buttons, nums, body, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  // Fullscreen buttons and slide numbers sit under their card and cover no card.
  const outsideCards = (m) => {
    assert.equal(m.buttons.length, m.cards.length, 'one fullscreen button per slide');
    m.buttons.forEach((b, i) => {
      assert(b.top >= m.cards[i].bottom - 1, `fullscreen button ${i + 1} is over its card: ${JSON.stringify(b)} vs ${JSON.stringify(m.cards[i])}`);
      for (const c of m.cards) assert(b.bottom <= c.top + 1 || b.top >= c.bottom - 1, `fullscreen button ${i + 1} covers ${c.id}`);
      assert(m.nums[i].right <= b.left + 1, `slide number ${i + 1} overlaps its button`);
    });
  };
  try {
    for (const engine of ['webkit', 'chromium']) {
      const browser = await pw[engine].launch();
      try {
        await t(`${engine} 390px: a guide-style deck reflows into a page`, async () => {
          const { ctx, page, frame, errors } = await open(browser, 'slides-reflow', 390);
          await page.waitForFunction(() => {
            const f = document.querySelector('iframe[aria-label="Document content"]');
            try { const h = f.contentWindow.CSS.highlights; return !h || (h.get('tdoc-anchor') && h.get('tdoc-anchor').size > 0); } catch { return true; }
          }, null, { timeout: 10000 }).catch(() => {});
          const m = await measure(frame);
          assert.equal(m.mode, 'reflow', 'deck is in reflow mode');
          for (const c of m.cards) {
            assert(Math.abs(c.w - c.room) <= 1 && c.layout === Math.round(c.w), `card laid out at the column width, unscaled: ${JSON.stringify(c)}`);
          }
          assert(m.body.length && Math.min(...m.body) >= 15, `body text at least 15px: ${m.body}`);
          assert(m.overflow <= 1, `no sideways overflow: ${m.overflow}`);
          assert(m.nums.every((n) => !/cut off/.test(n.text)), 'no cut-off flag on reflowed cards');
          outsideCards(m);
          const cols = await frame.locator('#r2 .big').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
          assert(cols[1] > cols[0] + 20, `.cols stack on a phone: ${cols}`);
          // The comment highlight sits on its text.
          const anchor = await frame.locator('html').evaluate(() => {
            const hl = window.CSS && CSS.highlights && CSS.highlights.get('tdoc-anchor');
            if (!hl) return null;
            const p = document.getElementById('r2p').getBoundingClientRect();
            for (const range of hl) {
              if (!String(range).includes('Average wait before')) continue;
              // WebKit's bounding box includes an empty rect where the range
              // starts, at the end of the line above; only painted rects count.
              const rects = [...range.getClientRects()].filter((x) => x.width > 1);
              const r = { left: Math.min(...rects.map((x) => x.left)), right: Math.max(...rects.map((x) => x.right)), top: Math.min(...rects.map((x) => x.top)), bottom: Math.max(...rects.map((x) => x.bottom)) };
              return { inside: r.left >= p.left - 2 && r.right <= p.right + 2 && r.top >= p.top - 2 && r.bottom <= p.bottom + 2, r: [r.left, r.top, r.right, r.bottom], p: [p.left, p.top, p.right, p.bottom], s: String(range) };
            }
            return { inside: false };
          });
          assert(anchor || engine === 'webkit', 'no comment anchor drawn');
          if (anchor) assert(anchor.inside, `comment anchor is not on its text: ${JSON.stringify(anchor)}`);
          // A selection on a reflowed card reports the text under the finger.
          const sel = await frame.locator('#r1p').evaluate((el) => {
            const range = document.createRange(); range.selectNodeContents(el.firstChild);
            const s = getSelection(); s.removeAllRanges(); s.addRange(range);
            const r = range.getBoundingClientRect(), b = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + 4, r.top + r.height / 2);
            s.removeAllRanges();
            return { onText: hit === el, inside: r.left >= b.left - 1 && r.right <= b.right + 1 };
          });
          assert(sel.onText && sel.inside, `selection rects match the text: ${JSON.stringify(sel)}`);
          if (shots) await page.screenshot({ path: path.join(shots, `slides-reflow-${engine}-390.png`), fullPage: true });
          // Taps on a card read it: nothing opens, nothing jumps.
          const ib = await page.locator('iframe[aria-label="Document content"]').boundingBox();
          for (const mode of ['comment', 'read']) {
            await page.evaluate((md) => document.querySelector('iframe').contentWindow.postMessage({ source: 'tdoc-shell', type: 'tdoc:mode', mode: md }, '*'), mode);
            await page.waitForTimeout(200);
            for (const id of ['r1', 'r2']) {
              await frame.locator(`#${id}`).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 80));
              await page.waitForTimeout(150);
              const r = await frame.locator(`#${id}`).evaluate((el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
              for (const [fx, fy] of [[0.5, 0.5], [0.95, 0.08]]) {
                const y0 = await frame.locator('html').evaluate(() => scrollY);
                await page.touchscreen.tap(ib.x + r.x + r.w * fx, ib.y + r.y + Math.min(r.h * fy, 400));
                await page.waitForTimeout(350);
                const s = await frame.locator('html').evaluate(() => ({ visual: document.documentElement.hasAttribute('data-tdoc-visual-open'), present: document.documentElement.hasAttribute('data-tdoc-presenting'), y: scrollY }));
                assert(!s.visual && !s.present, `${mode} tap on ${id} at ${fx},${fy} opened ${s.visual ? 'fullscreen' : 'Present'}`);
                assert(Math.abs(s.y - y0) <= 1, `${mode} tap on ${id} scrolled the page: ${y0} -> ${s.y}`);
                await page.keyboard.press('Escape');
                await frame.locator('html').evaluate(() => getSelection().removeAllRanges());
              }
            }
          }
          // The button under the card still opens it fullscreen.
          await frame.locator('#r2').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 80));
          await frame.locator('.tdoc-visual-open.is-slide').nth(1).click();
          await frame.locator('html[data-tdoc-visual-open]').waitFor();
          await page.keyboard.press('Escape');
          await frame.locator('html[data-tdoc-visual-open]').waitFor({ state: 'detached' });
          // Present is unchanged: the full 16:9 slide at presentation width.
          await frame.locator('html').evaluate(() => window.scrollTo(0, 0));
          await frame.getByRole('button', { name: 'Present slides' }).click();
          await frame.locator('html[data-tdoc-presenting]').waitFor();
          const p = await frame.locator('#r1').evaluate((el) => { const r = el.getBoundingClientRect(); return { layout: el.offsetWidth, ratio: el.offsetWidth / el.offsetHeight, r: [r.left, r.top, r.right, r.bottom] }; });
          assert(p.layout >= 960 && Math.abs(p.ratio - 16 / 9) < 0.02, `Present shows the 16:9 slide: ${JSON.stringify(p)}`);
          assert(p.r[0] >= -1 && p.r[2] <= 391 && p.r[1] >= -1 && p.r[3] <= 845, `presented slide fits: ${p.r}`);
          if (shots) await page.screenshot({ path: path.join(shots, `slides-reflow-present-${engine}-390.png`) });
          await page.keyboard.press('Escape');
          await frame.locator('html[data-tdoc-presenting]').waitFor({ state: 'detached' });
          await page.waitForTimeout(200);
          assert.equal((await measure(frame)).mode, 'reflow', 'back to the page after Present');
          assert.deepEqual(errors, []);
          await ctx.close();
        });
        await t(`${engine} 390px: an absolutely placed px deck keeps the scaled cards`, async () => {
          const { ctx, page, frame, errors } = await open(browser, 'slides-legacy', 390);
          const m = await measure(frame);
          assert.equal(m.mode, '', 'legacy deck stays scaled');
          for (const c of m.cards) {
            assert.equal(c.layout, 960, 'laid out at 960px');
            assert(Math.abs(c.w / c.h - 16 / 9) < 0.02 && c.w <= c.room + 1, `scaled 16:9 card: ${JSON.stringify(c)}`);
          }
          assert(m.overflow <= 1, `no sideways overflow: ${m.overflow}`);
          if (shots) await page.screenshot({ path: path.join(shots, `slides-legacy-${engine}-390.png`), fullPage: true });
          assert.deepEqual(errors, []);
          await ctx.close();
        });
        await t(`${engine} 1280px: desktop browse is unchanged`, async () => {
          for (const slug of ['slides-reflow', 'slides-legacy']) {
            const { ctx, page, frame, errors } = await open(browser, slug, 1280);
            const m = await measure(frame);
            assert.equal(m.mode, '', `${slug} is scaled on desktop`);
            for (const c of m.cards) assert(c.layout === 960 && Math.abs(c.w / c.h - 16 / 9) < 0.02, `${slug} 960px 16:9 card: ${JSON.stringify(c)}`);
            if (slug === 'slides-reflow') outsideCards(m);
            if (shots) await page.screenshot({ path: path.join(shots, `${slug}-${engine}-1280.png`), fullPage: true });
            assert.deepEqual(errors, []);
            await ctx.close();
          }
        });
      } finally {
        await browser.close();
      }
    }
  } finally {
    await target.stop();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
