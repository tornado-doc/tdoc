// Regression test: a table inside an overflow:auto wrapper must not have its
// first column clipped by the overlay's default table styling.
//
// Bug (issue: overlay table negative left margin): the default template gave
// every table `margin-left: -14px` to pull the first cell's text under the
// prose column. A negative left margin pushes the table's left edge OUTSIDE
// its containing block; when the table sits in an overflow:auto/scroll wrapper
// — which SKILL.md explicitly tells authors to use for tables, and which the
// overlay's own `@media (max-width: 760px)` rule also creates — the overhang
// is clipped and unreachable by scroll, so the first column gets cut off.
//
// The invariant we assert is host-independent and doesn't hardcode pixels:
// the first cell's left edge must be at or after (never to the left of) the
// scroll wrapper's content-left edge. With the negative margin it lands ~14px
// to the LEFT of the wrapper and is clipped; with the fix it sits flush.
//
// Run: node test/table-clip.test.js               (local fixture, default)
//      TDOC_TEST_URL=<url> node test/table-clip.test.js   (a live doc)

const { requirePlaywrightOrSkip, resolveTarget, isPublishedTarget } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('table-clip.test.js');

let pass = 0, fail = 0, skipped = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e.message || e}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

(async () => {
  // Live published docs don't carry this committed fixture, so target it only
  // on the local fixture server. A live URL skips loudly.
  if (isPublishedTarget()) {
    console.log('  ⊘ table-clip — SKIP (needs the committed wide-table fixture; not on a live URL)');
    process.exit(0);
  }

  const target = await resolveTarget({ slug: 'wide-table', version: 1 });
  console.log(`testing ${target.url}\n`);
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(target.url, { waitUntil: 'networkidle' });
    await page.waitForSelector('#clip-probe-wrap table', { timeout: 5000 });

    await t('first column is not clipped by the overflow wrapper', async () => {
      const m = await page.evaluate(() => {
        const wrap = document.getElementById('clip-probe-wrap');
        const cell = document.getElementById('clip-probe-cell');
        const table = wrap.querySelector('table');
        const wr = wrap.getBoundingClientRect();
        const cr = cell.getBoundingClientRect();
        return {
          wrapLeft: wr.left,
          cellLeft: cr.left,
          scrollLeft: wrap.scrollLeft,
          tableMarginLeft: getComputedStyle(table).marginLeft,
        };
      });
      // The wrapper is not scrolled, so a clip can only come from the table
      // overhanging its own wrapper's left edge.
      if (m.scrollLeft !== 0) {
        throw new Error(`wrapper unexpectedly scrolled (scrollLeft=${m.scrollLeft}); test precondition broken`);
      }
      // Core invariant: first cell must start at or after the wrapper's left.
      if (m.cellLeft < m.wrapLeft - 0.5) {
        throw new Error(
          `first cell is clipped: cell.left=${m.cellLeft.toFixed(1)} is left of ` +
          `wrapper.left=${m.wrapLeft.toFixed(1)} (overhang ${(m.wrapLeft - m.cellLeft).toFixed(1)}px). ` +
          `table margin-left=${m.tableMarginLeft}.`
        );
      }
    });

    await t('default table margin-left is not negative', async () => {
      const ml = await page.evaluate(() => {
        const table = document.querySelector('#clip-probe-wrap table');
        return parseFloat(getComputedStyle(table).marginLeft) || 0;
      });
      if (ml < 0) throw new Error(`table margin-left is ${ml}px; a negative left margin clips inside overflow wrappers`);
    });
  } finally {
    await browser.close();
    await target.stop();
  }

  console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(fail ? 1 : 0);
})();
