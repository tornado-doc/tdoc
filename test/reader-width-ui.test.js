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
    await page.goto(target.url);
    const frame = page.frameLocator('iframe[aria-label="Document content"]');
    const width = () => frame.locator('.wrap').evaluate(e => Math.round(e.getBoundingClientRect().width));
    await frame.locator('.wrap').waitFor();
    assert.equal(await width(), 720);
    const switchTo = async label => {
      const direct = page.getByRole('button', { name: label, exact: true });
      if (await direct.isVisible()) { await direct.click(); return; }
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
    };
    await page.getByRole('button', { name: 'Wide width', exact:true }).waitFor();
    await page.getByRole('button', { name:'More actions', exact:true }).click();
    assert.equal(await page.getByRole('menuitem', {name:'Wide width',exact:true}).count(),0,
      'wide toolbar must not duplicate its control in More');
    await page.keyboard.press('Escape');

    // Same viewport, different title length: placement is based on actual
    // available room, not a second fixed desktop breakpoint.
    await page.setViewportSize({width:900,height:900});
    await page.getByRole('button', {name:'Wide width',exact:true}).waitFor();
    const originalTitle = await page.locator('.doc-title').textContent();
    await page.locator('.doc-title').evaluate(el=>{el.textContent='A long document title that needs the toolbar space '.repeat(6)});
    await page.locator('#tdoc-width-btn').waitFor({state:'hidden'});
    await page.getByRole('button', {name:'More actions',exact:true}).click();
    await page.getByRole('menuitem', {name:'Wide width',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.locator('.doc-title').evaluate((el,title)=>{el.textContent=title},originalTitle);
    await page.getByRole('button', {name:'Wide width',exact:true}).waitFor();
    await page.setViewportSize({width:1440,height:900});
    await page.getByRole('button', {name:'Wide width',exact:true}).focus();
    await page.keyboard.press('Enter');
    await frame.locator('#tdoc-reader-width').waitFor({ state: 'attached' });
    assert(await width() > 1200);
    // The generic fixture's SVG has no fluid width; model a responsive author
    // figure explicitly, as the Raft document declares it.
    await frame.locator('svg').first().evaluate(e => { e.style.width = '100%'; });
    const wideSvg = await frame.locator('svg').first().evaluate(e => e.getBoundingClientRect().width);
    await page.reload();
    await frame.locator('#tdoc-reader-width').waitFor({ state: 'attached' });
    await frame.locator('svg').first().evaluate(e => { e.style.width = '100%'; });
    assert(await width() > 1200, 'preference survives reload');
    await switchTo('Narrow width');
    await page.waitForFunction(() => localStorage.getItem('tdoc-width:sample-doc') === 'narrow');
    await frame.locator('.wrap').evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await width(), 720);
    assert(await frame.locator('svg').first().evaluate(e => e.getBoundingClientRect().width) < wideSvg, 'visual follows the content width');

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
    await page.locator('#tdoc-width-btn').waitFor({state:'hidden'});
    await switchTo('Wide width');
    assert(await frame.locator('html').evaluate(e => e.scrollWidth <= innerWidth+1));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
    assert.deepEqual(failures, []);
    console.log('  ✓ width control uses toolbar capacity, falls back to More, supports keyboard, persists and resizes visuals');
    console.log('  ✓ dynamic tables and saved content remain intact without phone overflow');
  } finally { await browser.close(); await target.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
