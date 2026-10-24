// Slide view scales each 960px card to the column once, in every engine.
// It used zoom, and Safari sizes cqw type against the zoomed width and then
// zooms it again: on an iPhone, card-relative titles came out at half size
// (24px instead of 61px) until Present. Measured as title height over card
// width, which has to match across WebKit and Chromium, desktop and phone, for
// a cqw deck and a px deck alike; comment anchors must still sit on their text.
// Run with: node test/slides-scale.test.js

const assert = require('node:assert/strict');
const { requirePlaywrightOrSkip, resolveTarget } = require('./helpers/fixture-server');
const pw = requirePlaywrightOrSkip('slides-scale.test.js');

(async () => {
  const target = await resolveTarget();
  let failed = 0;
  const seen = {};
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
  };
  try {
    for (const engine of ['chromium', 'webkit']) {
      const browser = await pw[engine].launch();
      try {
        for (const width of [1280, 390]) {
          await t(`${engine} ${width}px: one scale step, cards fit, anchors on their text`, async () => {
            const page = await browser.newPage({ viewport: { width, height: 820 } });
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(new URL('/d/slides-scale/v/1', target.url).href);
            const frame = page.frameLocator('iframe[aria-label="Document content"]');
            await frame.locator('.tdoc-slide-num').first().waitFor({ timeout: 15000 });
            await page.waitForFunction(() => {
              const f = document.querySelector('iframe[aria-label="Document content"]');
              try { const h = f.contentWindow.CSS.highlights; return !h || (h.get('tdoc-anchor') && h.get('tdoc-anchor').size > 0); } catch { return true; }
            }, null, { timeout: 10000 }).catch(() => {});
            const m = await frame.locator('html').evaluate(() => {
              const ratio = (id) => {
                const card = document.getElementById(id).getBoundingClientRect();
                const title = document.getElementById(id + 't').getBoundingClientRect();
                return { card: card.width, room: document.getElementById(id).parentElement.clientWidth, ratio: title.height / card.width };
              };
              let anchor = null;
              const hl = window.CSS && CSS.highlights && CSS.highlights.get('tdoc-anchor');
              if (hl) {
                const title = document.getElementById('c1t').getBoundingClientRect();
                for (const range of hl) {
                  if (!String(range).includes('Scaled title')) continue;
                  const r = range.getBoundingClientRect();
                  anchor = { inside: r.left >= title.left - 2 && r.right <= title.right + 2 && r.top >= title.top - 2 && r.bottom <= title.bottom + 2, r: [r.left, r.top, r.width, r.height].map(Math.round), title: [title.left, title.top, title.width, title.height].map(Math.round) };
                }
              }
              return { cq: ratio('c1'), px: ratio('p1'), overflow: document.documentElement.scrollWidth - innerWidth, anchor };
            });
            seen[`${engine}-${width}`] = m;
            assert(m.cq.card <= m.cq.room + 1 && m.px.card <= m.px.room + 1, `card wider than the column: ${JSON.stringify(m)}`);
            assert(m.overflow <= 1, `page scrolls sideways: ${m.overflow}`);
            assert(m.anchor || engine === 'webkit', 'no comment anchor drawn on the title');
            if (m.anchor) assert(m.anchor.inside, `comment anchor is not on its text: ${JSON.stringify(m.anchor)}`);
            assert.equal(errors.length, 0, errors.join('\n'));
            if (process.env.TDOC_TEST_SCREENSHOTS) await page.screenshot({ path: require('node:path').join(process.env.TDOC_TEST_SCREENSHOTS, `slides-scale-${engine}-${width}.png`), fullPage: true });
            await page.close();
          });
        }
      } finally {
        await browser.close();
      }
    }
    await t('the same proportions in WebKit and Chromium, on desktop and phone, for cqw and px decks', async () => {
      const base = seen['chromium-1280'];
      assert(base, 'no chromium desktop measurement');
      for (const [key, m] of Object.entries(seen)) {
        for (const kind of ['cq', 'px']) {
          const drift = Math.abs(m[kind].ratio - base[kind].ratio) / base[kind].ratio;
          // Line boxes round to whole pixels, so a small card drifts a little.
          assert(drift < 0.12, `${key} ${kind} title/card ${m[kind].ratio.toFixed(4)} vs ${base[kind].ratio.toFixed(4)}`);
        }
      }
    });
  } finally {
    await target.stop();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
