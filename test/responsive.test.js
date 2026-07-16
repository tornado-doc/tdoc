// Responsive UI invariant tests across four real viewport sizes.
//
// Run: node test/responsive.test.js            (local fixture, default)
//      TDOC_TEST_URL=<url> node ...            (a live published doc)
//
// DESIGN (#35): we assert layout INVARIANTS, not hardcoded per-viewport
// booleans. The previous version hardcoded expectMore/expectFab per width
// against one specific doc's article geometry, so it failed whenever the doc or
// the layout heuristic changed — even on the correct live layout. Narrow mode
// ("drawer + More menu") is driven by the article's ACTUAL width, not the
// viewport, so the right thing to verify is internal consistency + monotonicity,
// which hold for any doc:
//
//   1. No horizontal overflow at any width (a real bug if violated).
//   2. Top bar always present.
//   3. Comment cards never overflow the window.
//   4. Narrow-mode is SELF-CONSISTENT: when body.tdoc-narrow is set, the FAB +
//      More menu are the narrow affordances; when not, cards sit in the right
//      margin column and the FAB is hidden. We read the actual narrow state and
//      assert the matching layout, instead of guessing it from the width.
//   5. Narrow-mode is MONOTONIC across widths: never narrow at a wider viewport
//      yet non-narrow at a strictly narrower one.
//   6. Footer + Copy affordances present and fit.
//
// Published-only chrome (Fork / All-docs / sign-in / identity chip) only exists
// in the worker's published mode, so those assertions run only against a live
// TDOC_TEST_URL and skip loudly otherwise.

const { requirePlaywrightOrSkip, resolveTarget, isPublishedTarget } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('responsive.test.js');

// Widest → narrowest, so we can assert narrow-mode monotonicity.
const viewports = [
  { name: 'desktop-1440', width: 1440, height: 900,  mobile: false },
  { name: 'laptop-1024',  width: 1024, height: 768,  mobile: false },
  { name: 'ipad-768',     width: 768,  height: 1024, mobile: true  },
  { name: 'iphone-375',   width: 375,  height: 812,  mobile: true  },
];

let pass = 0, fail = 0, skipped = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e.message || e}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }
async function tPub(name, fn) {
  if (!isPublishedTarget()) { console.log(`  ⊘ ${name} — SKIP (published-only)`); skipped++; return; }
  await t(name, fn);
}

(async () => {
  const target = await resolveTarget();
  const URL = target.url;
  console.log(`testing ${URL}\n`);
  const browser = await chromium.launch({ headless: true });

  // Track narrow-mode across widths for the monotonicity invariant.
  const narrowByWidth = [];

  for (const v of viewports) {
    console.log(`--- ${v.name} (${v.width}×${v.height}) ---`);
    const ctx = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      isMobile: v.mobile, hasTouch: v.mobile, deviceScaleFactor: v.mobile ? 2 : 1,
    });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    // Let layout settle (narrow-mode is set after the first refreshComments).
    await page.waitForFunction(
      () => document.querySelector('.tdoc-margin-comment') !== null || document.body.dataset.tdocReady === '1',
      null, { timeout: 5000 }
    ).catch(() => {});
    await page.waitForTimeout(400);

    // Read the actual layout state once; assertions derive from it.
    const st = await page.evaluate(() => {
      const vis = (sel) => { const el = document.querySelector(sel); return !!(el && el.offsetWidth > 0 && el.offsetHeight > 0); };
      const cards = [...document.querySelectorAll('.tdoc-margin-comment')].map(c => {
        const r = c.getBoundingClientRect(); return { left: r.left, right: r.right };
      });
      // v0.8.0 pins model: in wide mode comment cards are display:none by default
      // and each comment renders a .tdoc-pin in #tdoc-pin-layer in the right
      // margin. Capture the pins + the article's right edge so the wide-mode
      // margin-column invariant can assert on the PINS (the visible margin
      // affordance), not on the hidden cards.
      const article = document.querySelector('.wrap') || document.querySelector('article') || document.querySelector('main');
      const articleRight = article ? article.getBoundingClientRect().right : null;
      const pins = [...document.querySelectorAll('#tdoc-pin-layer .tdoc-pin')].map(p => {
        const r = p.getBoundingClientRect();
        return { left: r.left, right: r.right, vis: p.offsetWidth > 0 && p.offsetHeight > 0 };
      });
      return {
        narrow: document.body.classList.contains('tdoc-narrow'),
        hasComments: document.querySelectorAll('.tdoc-margin-comment').length > 0,
        bar: !!document.querySelector('.tdoc-bar'),
        more: vis('#tdoc-more-btn'),
        fab: vis('.tdoc-fab'),
        cards,
        pins,
        articleRight,
        scrollW: document.documentElement.scrollWidth,
        winW: window.innerWidth,
      };
    });
    narrowByWidth.push({ width: v.width, narrow: st.narrow });

    // 1. No horizontal overflow — a real responsive bug if violated.
    await t('no horizontal overflow', async () => {
      if (st.scrollW > st.winW + 1) throw new Error(`scrollWidth ${st.scrollW} > innerWidth ${st.winW}`);
    });

    // 2. Top bar always present.
    await t('top bar present', async () => { if (!st.bar) throw new Error('no .tdoc-bar'); });

    // 3. Comment cards never overflow the window.
    await t('comment cards fit within the window', async () => {
      for (const c of st.cards) {
        if (c.right > st.winW + 1) throw new Error(`card right=${c.right} > window ${st.winW}`);
      }
    });

    // 4. Narrow-mode self-consistency: the affordances match the actual mode.
    if (st.narrow) {
      await t('narrow mode: More menu is the visible nav affordance', async () => {
        if (!st.more) throw new Error('narrow mode but More (⋯) button not visible');
      });
      await t('narrow mode: FAB visible iff comments exist', async () => {
        if (st.hasComments && !st.fab) throw new Error('narrow + has comments but FAB hidden');
        if (!st.hasComments && st.fab) throw new Error('no comments but FAB shown');
      });
      if (st.hasComments && st.fab) {
        await t('narrow mode: tapping FAB opens the bottom drawer', async () => {
          await page.evaluate(() => document.querySelector('.tdoc-fab').click());
          await page.waitForTimeout(250);
          const open = await page.evaluate(() => document.querySelector('#tdoc-comment-layer.open') !== null);
          if (!open) throw new Error('drawer did not gain .open');
          await page.evaluate(() => document.querySelector('#tdoc-comment-layer').classList.remove('open'));
          await page.waitForTimeout(120);
        });
      }
      if (st.more) {
        await t('narrow mode: More opens the secondary menu', async () => {
          await page.evaluate(() => document.querySelector('#tdoc-more-btn').click());
          await page.waitForTimeout(150);
          const open = await page.evaluate(() => document.querySelector('#tdoc-secondary-menu.open') !== null);
          await page.evaluate(() => { const m = document.querySelector('#tdoc-secondary-menu'); if (m) m.classList.remove('open'); });
          if (!open) throw new Error('secondary menu did not open');
        });
      }
    } else {
      await t('wide mode: FAB hidden', async () => {
        if (st.fab) throw new Error('FAB should be hidden in wide (non-narrow) mode');
      });
      await t('wide mode: comment pins sit in the right margin column', async () => {
        // v0.8.0 pins model: the margin affordance in wide mode is the PIN, not
        // the card (cards are display:none until revealed). Assert the pins live
        // in #tdoc-pin-layer, are visible, and sit in the right margin: left of
        // the pin is past the article's right edge, and the whole pin fits inside
        // the viewport. Do NOT assert on the hidden cards' geometry.
        if (!st.hasComments) { console.log('    (no comments)'); return; }
        if (!st.pins.length) throw new Error('wide + has comments but no .tdoc-pin in #tdoc-pin-layer');
        if (st.articleRight == null) throw new Error('could not resolve article right edge');
        for (const p of st.pins) {
          if (!p.vis) throw new Error(`pin not visible (left=${p.left})`);
          if (p.left < st.articleRight) throw new Error(`pin left=${p.left} not past article right edge ${st.articleRight} — not in the right margin`);
          if (p.right > st.winW + 1) throw new Error(`pin right=${p.right} overflows window ${st.winW}`);
        }
      });
    }

    // 6. Footer + Copy affordances present and fit.
    await t('footer visible and fits', async () => {
      const m = await page.evaluate(() => {
        const f = document.querySelector('.tdoc-footer'); if (!f) return null;
        const r = f.getBoundingClientRect();
        return { visible: f.offsetWidth > 0 && f.offsetHeight > 0, right: r.right, ww: window.innerWidth };
      });
      if (!m) throw new Error('footer missing');
      if (!m.visible) throw new Error('footer not visible');
      if (m.right > m.ww + 1) throw new Error(`footer right=${m.right} > viewport ${m.ww}`);
    });

    await t('Copy button opens its dropdown', async () => {
      await page.evaluate(() => document.querySelector('#tdoc-copy-md-btn').click());
      await page.waitForTimeout(120);
      const open = await page.evaluate(() => document.querySelector('#tdoc-copy-md-menu.open') !== null);
      await page.evaluate(() => { const m = document.querySelector('#tdoc-copy-md-menu'); if (m) m.classList.remove('open'); });
      if (!open) throw new Error('copy dropdown did not open');
    });

    // Published-only: identity chip present.
    await tPub('sign-in / identity chip present', async () => {
      const present = await page.evaluate(() => {
        const slot = document.querySelector('#tdoc-identity-slot');
        return !!(slot && slot.children.length > 0);
      });
      if (!present) throw new Error('identity slot empty');
    });

    await ctx.close();
    console.log();
  }

  // 5. Monotonicity invariant: once narrow, all strictly-narrower widths stay
  // narrow. (narrowByWidth is widest→narrowest.)
  await t('narrow-mode is monotonic across widths (never wide-after-narrow)', async () => {
    let seenNarrow = false;
    for (const e of narrowByWidth) {
      if (e.narrow) seenNarrow = true;
      else if (seenNarrow) throw new Error(`width ${e.width} is wide but a wider viewport was already narrow — non-monotonic`);
    }
  });

  await browser.close();
  await target.stop();
  console.log(`${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped (published-only)` : ''}.`);
  process.exit(fail ? 1 : 0);
})();
