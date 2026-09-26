// Product invariants, independently measured: short values stay together,
// prose gets room, columns remain aligned, and only the wrapper scrolls.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { layoutTables } = require('../server/table-layout');
const { applyReaderWidth } = require('../server/reader-width');
const { measureLayout } = require('./helpers/check-layout');
const reader = fs.readFileSync(path.join(__dirname, '../server/reader.css'), 'utf8');

const fixture = (size = 16) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${reader}</style><style>
table{width:100%;border-spacing:0;font-size:${size}px}td,th{padding:10px;vertical-align:top}
.cramped{table-layout:fixed}.cramped th:nth-child(1){width:22%}.cramped th:nth-child(2){width:55%}
.cramped th:nth-child(3){width:20px}
.cards,.cards tbody,.cards tr,.cards td{display:block;width:auto}
.vertical{writing-mode:vertical-rl}
</style><main>
<div class="tdoc-table-scroll"><table class="cramped"><thead><tr><th>Stage</th><th>Description</th><th>Effort</th><th>Acceptance</th></tr></thead><tbody>
<tr><td>One</td><td><code>configuration.notification_target_identifier</code> 连续的中文说明文字，需要合理的列宽而不是逐字拆开</td><td data-value>5 天</td><td>Ready for independent verification by another team.</td></tr>
<tr><td>Two</td><td>Different content, same layout contract.</td><td data-value>4 days</td><td>另一个完全不同的验收条件需要可读的段落宽度</td></tr>
<tr><td>Three</td><td>None of these names are used by the provider.</td><td data-value>1 天 + 审核</td><td>看完完整内容</td></tr>
</tbody></table></div>
<div class="tdoc-table-scroll"><table><tr><th>Price</th><th>Ratio</th><th>Status</th></tr>
<tr><td data-value>¥ 1,280</td><td data-value>99.95 %</td><td data-value>待审核</td></tr></table></div>
<div class="tdoc-table-scroll"><table><tr><th colspan="2">Merged heading</th><th>Result</th></tr>
<tr><td rowspan="2">Shared group</td><td data-value>12 ms</td><td>正常</td></tr><tr><td data-value>2 GB</td><td>通过</td></tr></table></div>
<div class="tdoc-table-scroll"><table><tr><td>Intentional<br>line break</td><td data-tdoc-cell="value" data-value>Ticket ABC 123 / customer approval pending</td></tr></table></div>
<table class="cards"><tr><td>A deliberately reflowed table remains a card.</td></tr></table>
<table class="vertical"><tr><td>竖排</td></tr></table>
<table hidden><tr><td>Invisible table</td></tr></table>
</main>`;

// Independent of the policy's width floor and diagnostic implementation.
const actual = () => {
  const values = [...document.querySelectorAll('[data-value]')].map(cell => {
    const range = document.createRange(); range.selectNodeContents(cell);
    const lines = new Set([...range.getClientRects()].filter(r=>r.width>0).map(r=>Math.round(r.top)));
    return { text:cell.textContent, lines:lines.size };
  });
  const table = document.querySelector('.cramped');
  const aligned = [...table.rows[0].cells].every((c,i)=>Math.abs(c.getBoundingClientRect().left-table.rows[1].cells[i].getBoundingClientRect().left)<1);
  const wrappers = [...document.querySelectorAll('.tdoc-table-scroll')];
  return { values, aligned, overflow:document.documentElement.scrollWidth>innerWidth+1,
    scrollable:wrappers.some(w=>{w.scrollLeft=1e6;return w.scrollLeft>0}),
    card:getComputedStyle(document.querySelector('.cards')).display,
    vertical:getComputedStyle(document.querySelector('.vertical')).writingMode };
};

(async()=>{
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const font of [16,24]) for (const width of [320,375,768,1440]) for (const mode of ['narrow','wide']) {
      await page.setViewportSize({width,height:900}); await page.setContent(fixture(font));
      await page.evaluate(applyReaderWidth,mode);
      const before = await page.evaluate(measureLayout);
      assert(before.errors.some(e=>e.includes('5 天')), 'raw checker must detect a two-line short value');
      const original = await page.locator('main').innerHTML();
      await page.evaluate(layoutTables);
      const first = await page.locator('#tdoc-provider-table-layout').textContent();
      await page.evaluate(layoutTables);
      assert.equal(await page.locator('#tdoc-provider-table-layout').textContent(),first,'layout must settle, not oscillate');
      assert.equal(await page.locator('main').innerHTML(),original,'no author DOM/anchors may be rewritten');
      const m = await page.evaluate(actual);
      for (const v of m.values) assert.equal(v.lines,1,`${width}/${mode}/${font}: ${v.text} split`);
      assert(m.aligned, 'thead/body column alignment changed'); assert(!m.overflow,'page overflow');
      if(width<=375) assert(m.scrollable,'all columns must be reachable through local scrolling');
      assert.equal(m.card,'block'); assert.equal(m.vertical,'vertical-rl');
      assert.deepEqual((await page.evaluate(measureLayout)).errors,[]);
    }
    console.log('  ✓ 16 independent language/value/span/width/font cases, no content mutations or oscillation');

    await page.setContent(fixture());
    await page.locator('.cramped').evaluate(t=>t.style.setProperty('table-layout','fixed','important'));
    await page.evaluate(layoutTables);
    assert((await page.evaluate(measureLayout)).errors.some(e=>e.includes('compressed table column')),
      'a hostile inline rule the provider cannot override must remain a failed check');
    console.log('  ✓ unresolved author constraints remain errors instead of being hidden by the fallback');

    // The entire reported document, not an extracted first table, is the
    // regression. Do not apply any document-specific author repair here.
    const doc = path.join(__dirname,'fixtures/raft-layout-full.html');
    for (const width of [375,768,1440]) for (const mode of ['narrow','wide']) {
      await page.setViewportSize({width,height:900}); await page.goto('file://'+doc);
      await page.evaluate(applyReaderWidth,mode);
      assert.equal(await page.locator('table').count(),4);
      const before = await page.locator('body').innerHTML();
      await page.evaluate(layoutTables);
      assert.equal(await page.locator('body').innerHTML(),before);
      const measured = await page.locator('table').last().evaluate(t=>[...t.rows].slice(1).map(r=>{
        const cell=r.cells[2],range=document.createRange();range.selectNodeContents(cell);
        return {text:cell.textContent,lines:new Set([...range.getClientRects()].filter(x=>x.width).map(x=>Math.round(x.top))).size};
      }));
      for(const cell of measured) assert.equal(cell.lines,1,`${width}/${mode}: ${cell.text}`);
      const issues=await page.evaluate(measureLayout);
      assert(!issues.errors.some(e=>e.includes('compressed table column')),issues.errors.join('\n'));
      // SVG errors are deliberately still reported; protecting tables must
      // not hide an unrelated bad figure in this unmodified source.
      assert(issues.errors.some(e=>e.includes('SVG')||e.includes('rendered text')||e.includes('overlapping labels')));
    }
    console.log('  ✓ every table in the full, unmodified reported document, six viewport/reader combinations');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
