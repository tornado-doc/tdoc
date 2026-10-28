// A doc built from a house style's CSS alone must sit in the same reading
// column as the same doc after tdoc-bake stamps server/reader.css in: every
// block starts at the same x with the same width, nothing scrolls sideways.
// (Vertical rhythm of elements the style leaves unstyled, e.g. reader.css's
// table chips and pre box, is reader typography, not the column.) Unbaked: the reading column
// comes from the style (authoring/style/*.md). Baked: both copies are present,
// equal and zero-specificity, so nothing moves. Set TDOC_SHOT_DIR to also
// write screenshots (before = style CSS without its column block).
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('style-reader-column-render.test.js');

const ROOT = path.join(__dirname, '..');
const READER = fs.readFileSync(path.join(ROOT, 'server/reader.css'), 'utf8');
const SHOTS = process.env.TDOC_SHOT_DIR;
const styleCss = (name) => [...fs.readFileSync(path.join(ROOT, `authoring/style/${name}.md`), 'utf8')
  .matchAll(/```css\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
const withoutColumn = (css) => css.replace(/\/\* Reading column:[\s\S]*?:where\(body pre\)[^}]*\}/, '');

const doc = (css, baked) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>col</title>
<style>${css}</style>${baked ? `<style id="tdoc-reader">${READER}</style>` : ''}</head><body><div class="wrap">
<h1>Styles carry the reading column</h1>
<p>A page written with only a house style's CSS, never baked by tdoc, should still sit in a narrow centered column with the same margins a published doc has. ${'This sentence pads the paragraph so it wraps across several lines at desktop width. '.repeat(3)}</p>
<h2>A wide table</h2>
<div class="tdoc-table-scroll"><table><tr><th>Field</th><th>Meaning</th><th>Example</th><th>Default</th><th>Notes</th></tr>
<tr><td>max-width</td><td>reading column width</td><td>720px</td><td>720px</td><td>${'kept narrow on purpose '.repeat(3)}</td></tr>
<tr><td>padding</td><td>column padding</td><td>56px 24px 80px</td><td>same</td><td>identical baked or not</td></tr></table></div>
<h2>A wide figure</h2>
<svg width="1200" height="160" viewBox="0 0 1200 160"><rect x="1" y="1" width="1198" height="158" fill="#dde7f9" stroke="#a9c0ee"/><text x="20" y="90" font-size="28">A 1200px-wide figure must shrink to the column</text></svg>
<pre>npx tdoc-bake --scan --apply --dir ~/tdocs/${'a-very-long-path-segment/'.repeat(6)}</pre>
<p>Closing paragraph.</p></div></body></html>`;

async function measure(page) {
  return page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width)]; };
    const scroll = document.querySelector('.tdoc-table-scroll');
    return { page: document.documentElement.scrollWidth, wrap: r(document.querySelector('.wrap')),
      h1: r(document.querySelector('h1')), svg: r(document.querySelector('svg')), pre: r(document.querySelector('pre')),
      table: r(scroll), tableScrolls: scroll.scrollWidth > scroll.clientWidth,
      pad: getComputedStyle(document.querySelector('.wrap')).padding };
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  try {
    const page = await browser.newPage();
    for (const name of ['default', 'technical', 'paper', 'editorial']) {
      const css = styleCss(name);
      for (const width of [1280, 390]) {
        const label = `${name} @ ${width}px`;
        try {
          await page.setViewportSize({ width, height: 900 });
          const shot = async (tag) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}-${width}-${tag}.png`), fullPage: true });
          if (SHOTS) { await page.setContent(doc(withoutColumn(css), false)); await shot('before-unbaked'); }
          await page.setContent(doc(css, false)); const unbaked = await measure(page); await shot('unbaked');
          await page.setContent(doc(css, true)); const baked = await measure(page); await shot('baked');
          assert.deepEqual(unbaked, baked, 'unbaked and baked columns differ');
          assert.equal(unbaked.page, width, 'page scrolls sideways');
          assert.equal(unbaked.wrap[1], Math.min(720, width - 16), 'column width (body keeps its 8px UA margin, as in reader.css)');
          if (width > 720) assert.equal(unbaked.wrap[0], (width - 720) / 2, 'column is not centered');
          assert.equal(unbaked.pad, '56px 24px 80px');
          assert(unbaked.svg[1] <= unbaked.wrap[1] - 48, 'wide figure overflows the column');
          assert(unbaked.tableScrolls || width > 720, 'wide table does not scroll locally on a phone');
          console.log(`  ✓ ${label}`);
        } catch (e) { failed++; console.log(`  ✗ ${label}\n    ${e.message}`); }
      }
    }
  } finally { await browser.close(); }
  process.exit(failed ? 1 : 0);
})();
