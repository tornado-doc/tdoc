const assert = require('assert/strict');
const { chromium } = require('playwright');
const { resolveTarget } = require('./helpers/fixture-server');

(async () => {
  const target = await resolveTarget();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const failures = [];
    page.on('pageerror', e => failures.push(e.message));
    // Ignore preferences left behind by the removed reader-width switch.
    await page.addInitScript(() => {
      if (window === window.top) localStorage.setItem('tdoc-width:sample-doc', 'wide');
    });
    await page.goto(target.url);
    const frame = page.frameLocator('iframe[aria-label="Document content"]');
    const width = () => frame.locator('.wrap').evaluate(e => Math.round(e.getBoundingClientRect().width));
    await frame.locator('.wrap').waitFor();
    assert.equal(await width(), 720);
    for (const viewportWidth of [1440, 1100, 944, 900, 700, 375]) {
      await page.setViewportSize({width:viewportWidth,height:900});
      assert.equal(await page.locator('#tdoc-width-btn').count(), 0, 'width toggle is removed');
      await page.getByRole('button', {name:'More actions',exact:true}).click();
      assert.equal(await page.getByRole('menuitem', {name:/^(Wide|Narrow) width$/}).count(), 0,
        'More has no width mode');
      await page.keyboard.press('Escape');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    await page.setViewportSize({width:1440,height:900});
    await page.reload();
    await frame.locator('.wrap').waitFor();
    assert.equal(await width(), 720, 'old wide preference cannot override the document layout');
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage(
      {source:'tdoc-shell', type:'tdoc:width', width:'wide'}, '*'));
    await frame.locator('.wrap').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await width(), 720, 'removed width messages cannot change the layout');
    assert.equal(await frame.locator('#tdoc-reader-width').count(), 0);

    // Editing/adding a table must engage the same provider policy without a
    // page reload or an author running a CLI. Mutation observer + real probe.
    await frame.locator('.wrap').evaluate(root => {
      root.insertAdjacentHTML('beforeend', '<table id="added-table" style="table-layout:fixed;width:100%"><tr><th style="width:90%">Description</th><th>Value</th></tr><tr><td>New table from an edit</td><td id="short-value">1 天 + 审核</td></tr></table>');
    });
    await frame.locator('#short-value').evaluate(cell => new Promise((resolve,reject) => {
      const until = Date.now()+5000;
      function check() {
        const range=document.createRange();range.selectNodeContents(cell);
        const lines=new Set([...range.getClientRects()].filter(r=>r.width).map(r=>Math.round(r.top))).size;
        if(lines===1) return resolve();
        if(Date.now()>until) return reject(new Error('new table short value remains split'));
        requestAnimationFrame(check);
      } check();
    }));
    assert(await frame.locator('#added-table').evaluate(t=>t.parentElement.classList.contains('tdoc-table-scroll')),
      'tables inserted without an author wrapper still scroll locally');

    const serialized = await page.evaluate(() => new Promise(resolve => {
      const iframe = document.querySelector('iframe[aria-label="Document content"]');
      const listener = e => {
        if (e.source === iframe.contentWindow && e.data.type === 'tdoc:editDocument') {
          window.removeEventListener('message', listener); resolve(e.data.html);
        }
      };
      window.addEventListener('message', listener);
      iframe.contentWindow.postMessage({ source:'tdoc-shell', type:'tdoc:editSerialize', requestId:1 }, '*');
    }));
    assert(!serialized.includes('id="tdoc-reader-width"'), 'reader preference must not become author HTML');
    assert(!serialized.includes('id="tdoc-provider-table-layout"'), 'computed table widths must not become author HTML');
    assert(serialized.includes('id="added-table"'), 'table content must survive serialization');
    await page.setViewportSize({ width: 375, height: 800 });
    assert(await frame.locator('html').evaluate(e => e.scrollWidth <= innerWidth+1));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
    assert.deepEqual(failures, []);
    console.log('  ✓ reader uses document layout with no width switch or saved width override');
    console.log('  ✓ dynamic tables and saved content remain intact without phone overflow');
  } finally { await browser.close(); await target.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
