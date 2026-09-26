// Real layout regression: a grid's long inline code widened a 375px Raft doc
// to 490px. Also exercise explicit wide documents with old, already-baked CSS.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('reader-layout.test.js');
const { measureLayout } = require('./helpers/check-layout');
const root = path.join(__dirname, '..');
const reader = fs.readFileSync(path.join(root, 'server/reader.css'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8');
const patch = /const READER_PATCH_CSS = '([^']*)';/.exec(worker)[1];
const oldReader = ':where(body>.wrap){max-width:720px;margin:auto;padding:56px 24px 80px;box-sizing:border-box}';
const fixture = (css, wide) => `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style><style>body{background:white}.kv{display:grid;grid-template-columns:max-content 1fr;gap:14px}svg{width:100%;min-width:680px}.diagram-box{overflow-x:auto}table{min-width:720px}pre{overflow-x:auto}</style>
<div class="wrap" ${wide ? 'data-tdoc-width="wide"' : ''}><h1>Reader layout</h1>
<div class="kv"><b>manifest</b><span><code>resourceBoundTokenIdentifierWithNoNaturalBreaksresourceBoundTokenIdentifierWithNoNaturalBreaks</code></span></div>
<div class="tdoc-table-scroll"><table><tr><th>First column</th><th>Last column</th></tr><tr><td>Readable</td><td>Reachable</td></tr></table></div>
<div class="tdoc-table-scroll natural-scroll"><table style="min-width:0"><tr><td>${'identifier'.repeat(12)}</td><td>Value</td></tr></table></div>
<div class="diagram-box"><svg viewBox="0 0 900 100"><text x="10" y="30">A wide diagram</text></svg></div>
<pre>keep-this-command-on-one-line-${'x'.repeat(300)}</pre></div>`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  try {
    const page = await browser.newPage();
    for (const [name, css] of [['baked', reader], ['legacy served', patch + oldReader]]) {
      for (const wide of [false, true]) for (const width of [375, 768, 1440]) {
        const label = `${name}, ${wide ? 'wide' : 'default'}, ${width}px`;
        try {
          await page.setViewportSize({ width, height: 900 });
          await page.setContent(fixture(css, wide));
          const m = await page.evaluate(() => {
            const wrap = document.querySelector('.wrap');
            const table = document.querySelector('.tdoc-table-scroll');
            table.scrollLeft = 10000;
            return { page: document.documentElement.scrollWidth, viewport: innerWidth,
              root: wrap.getBoundingClientRect().width, tableScroll: table.scrollLeft,
              naturalTableScroll: document.querySelector('.natural-scroll').scrollWidth > document.querySelector('.natural-scroll').clientWidth,
              preScroll: document.querySelector('pre').scrollWidth > document.querySelector('pre').clientWidth };
          });
          assert(m.page <= m.viewport + 1, `page ${m.page}px exceeds viewport ${m.viewport}px`);
          if (width === 1440) assert(wide ? m.root > 1200 : m.root === 720, `wrong column width ${m.root}`);
          if (width === 375) assert(m.tableScroll > 0, 'wide table must remain reachable by local scrolling');
          if (width === 375) assert(m.naturalTableScroll, 'natural table columns must not be squeezed by prose wrapping');
          assert(m.preScroll, 'preformatted commands must retain local scrolling');
          console.log(`  ✓ ${label}`);
        } catch (e) { failed++; console.error(`  ✗ ${label}: ${e.message}`); }
      }
    }
    try {
      await page.setViewportSize({ width: 375, height: 900 });
      await page.setContent('<div style="width:600px">overflow</div><svg viewBox="0 0 100 100" width="100"><text x="90" y="30">outside</text><text x="10" y="60">overlap</text><text x="11" y="60">another</text></svg>');
      const bad = await page.evaluate(measureLayout);
      assert(bad.errors.some(s => s.includes('page overflow')), 'audit missed page overflow');
      assert(bad.errors.some(s => s.includes('outside SVG')), 'audit missed clipped SVG text');
      assert(bad.errors.some(s => s.includes('overlapping labels')), 'audit missed overlapping text');
      await page.setContent(fixture(reader, true));
      const good = await page.evaluate(measureLayout);
      assert.deepEqual(good.errors, [], 'local scrolling is not page overflow');
      assert(good.scrollers.length >= 2, 'audit must report local scroll areas');
      console.log('  ✓ browser audit catches geometry defects and permits local scrolling');
    } catch (e) { failed++; console.error(`  ✗ browser audit: ${e.message}`); }
  } finally { await browser.close(); }
  process.exitCode = failed ? 1 : 0;
})();
