// The reader's table look survives an author who restyles it. The old look
// (filled cells, an 8px radius, 3px gutters) drew a white "+" at every cell
// corner once a doc's own CSS collapsed the table and added cell borders, and
// its header was the same grey as the body. Rendered three ways: a new bake
// (server/reader.css), and a doc baked with the old look served with the
// serve-time READER_PATCH_CSS, each with and without the author's restyle.
// A custom design keeps its own cells. Set TDOC_SHOT_DIR to keep screenshots.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('table-style-render.test.js');

const ROOT = path.join(__dirname, '..');
const READER = fs.readFileSync(path.join(ROOT, 'server/reader.css'), 'utf8');
const PATCH = /const READER_PATCH_CSS = '([^']*)';/.exec(fs.readFileSync(path.join(ROOT, 'worker/worker.js'), 'utf8'))[1];
// What a doc baked before this change carries.
const OLD_TABLE = ':where(:root){--td-line:#e8e7e3;--td-surface:#f0f0ee;--td-th-bg:#f0f0ee}'
  + ':where(body table){border-collapse:separate;border-spacing:3px;margin:0 0 18px;font-size:16px}'
  + ':where(body th, body td){padding:10px 14px;background:var(--td-surface);border-radius:8px;border:0;text-align:left}'
  + ':where(body th){font-weight:600;background:var(--td-th-bg)}';
const SHOTS = process.env.TDOC_SHOT_DIR;

const TABLE = '<table><thead><tr><th>Entry</th><th>Status</th></tr></thead><tbody><tr><td>Write it with AI</td><td>Shipped</td></tr><tr><td>Import</td><td>Planned</td></tr></tbody></table>';
const AUTHOR = '.notes table{border-collapse:collapse}.notes th,.notes td{border:1px solid #d9d8d3}';
const doc = ({ reader, patch, author = '', attrs = '' }) => `<!doctype html><html${attrs}><head>${patch ? `<style id="tdoc-reader-patch">${PATCH}</style>` : ''}
<meta name="viewport" content="width=device-width, initial-scale=1"><style>body{background:#fff}${author}</style>
<style id="tdoc-reader">${reader}</style></head><body><main><div class="tdoc-table-scroll">${TABLE}</div>
<div class="notes tdoc-table-scroll">${TABLE}</div></main></body></html>`;

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; } }

async function cells(page) {
  return page.evaluate(() => [...document.querySelectorAll('table')].map((tb) => {
    const cs = (el) => getComputedStyle(el);
    const th = tb.querySelector('th'), td = tb.querySelector('td');
    return {
      collapse: cs(tb).borderCollapse,
      radius: [...tb.querySelectorAll('th,td')].map((c) => cs(c).borderTopLeftRadius),
      th: cs(th).backgroundColor, td: cs(td).backgroundColor,
      rowRule: cs(td).borderBottomWidth,
    };
  }));
}

(async () => {
  console.log('table style render (the reader table survives an author restyle)\n');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 820, height: 700 } });
  const render = async (name, opts) => {
    await page.setContent(doc(opts));
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `table-${name}.png`), fullPage: true }); }
    return cells(page);
  };
  const looksRight = (tables, label) => {
    for (const [i, x] of tables.entries()) {
      const which = `${label}, table ${i + 1}`;
      assert.equal(x.collapse, 'collapse', `${which}: border-collapse`);
      assert(x.radius.every((r) => r === '0px'), `${which}: a rounded cell (${x.radius.join(' ')}) leaves corner gaps under collapse`);
      assert.notEqual(x.th, x.td, `${which}: the header must not be the body's colour (${x.th})`);
      assert(/^rgba\(0, 0, 0, 0\)$|^rgb\(255, 255, 255\)$/.test(x.td), `${which}: body cells are unfilled, got ${x.td}`);
    }
  };
  try {
    await t('a new bake: a tinted header over ruled rows, plain and restyled', async () => {
      const r = await render('new', { reader: READER, author: AUTHOR });
      looksRight(r, 'new bake');
      assert.equal(r[0].rowRule, '1px', 'rows are separated by a hairline');
    });
    await t('a doc baked with the old look, served with the patch, matches', async () => {
      looksRight(await render('old-patched', { reader: OLD_TABLE, patch: true, author: AUTHOR }), 'old bake + patch');
    });
    await t('without the patch the old bake is the reported bug (the test can see it)', async () => {
      const r = await render('old-unpatched', { reader: OLD_TABLE, author: AUTHOR });
      assert(r[1].collapse === 'collapse' && r[1].radius.includes('8px') && r[1].th === r[1].td, JSON.stringify(r[1]));
    });
    await t('author rules still win over the patch; a custom design keeps its own cells', async () => {
      const own = '.mine td{background:rgb(250, 250, 250);border-radius:4px}';
      const r = await render('author-wins', { reader: OLD_TABLE, patch: true, author: own.replace('.mine', '.notes') });
      assert.equal(r[1].td, 'rgb(250, 250, 250)', 'a class rule beats the patch');
      const c = await render('custom', { reader: OLD_TABLE, patch: true, attrs: ' data-tdoc-design="custom"' });
      assert(c[0].radius.includes('8px') && c[0].collapse === 'separate', 'a custom design is left alone: ' + JSON.stringify(c[0]));
    });
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
