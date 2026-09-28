const assert = require('assert/strict');
const { chromium, webkit } = require('playwright');
const { resolveTarget } = require('./helpers/fixture-server');

(async () => {
  const target = await resolveTarget();
  const engine = process.env.TDOC_TEST_BROWSER === 'webkit' ? webkit : chromium;
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET' && /api\/(upload|comments|document|save)/.test(request.url())) writes.push(request.url()); });
    const url = process.env.TDOC_TEST_URL || target.url.replace('sample-doc', 'version-diff');
    await page.goto(`${url}?compare=1`);
    const dialog = page.getByRole('dialog', { name: 'Compare versions' });
    const summary = dialog.locator('.tdoc-diff-summary');
    await summary.waitFor();
    assert(!(await summary.innerText()).startsWith('No content'));
    await dialog.getByRole('button',{name:'Next change',exact:true}).click();
    assert.equal(await dialog.locator('.tdoc-diff-navigation output').innerText(),'1 / 7');
    await page.evaluate(() => window.postMessage({source:'tdoc-compare',type:'error',message:'spoof'},'*'));
    assert.equal(await dialog.getByRole('alert').count(),0,'unrelated windows cannot impersonate a comparison frame');
    if (process.env.TDOC_DIFF_SCREENSHOTS) await page.screenshot({path: process.env.TDOC_DIFF_SCREENSHOTS + '/desktop.png',fullPage:true});
    const frame = async name => {
      const locator = dialog.locator(`iframe[aria-label="${name}"]`);
      await locator.waitFor({state:'attached'});
      for (let i=0;i<50;i++) { const handle=await locator.elementHandle(); const result=handle && await handle.contentFrame(); if(result) return result; await page.waitForTimeout(50); }
      throw new Error('Frame did not attach: '+name);
    };
    let before = await frame('Previous version'), after = await frame('New version');
    assert.equal(await before.locator('#removed').getAttribute('data-tdoc-change'), 'delete');
    assert.equal(await after.locator('#added').getAttribute('data-tdoc-change'), 'add');
    assert.equal(await after.locator('#workflow #review').getAttribute('data-tdoc-change'), 'add');
    assert.equal(await after.locator('#workflow #draft').getAttribute('data-tdoc-change'), null);
    assert.equal(await after.locator('#intro a').getAttribute('href'), 'https://tdoc.dev', 'word diff preserves unchanged links');
    assert.equal(await dialog.locator('iframe').first().getAttribute('sandbox'), 'allow-scripts');

    await page.setViewportSize({ width: 390, height: 900 });
    await dialog.locator('.tdoc-diff-frames.is-narrow').waitFor();
    await summary.waitFor();
    after = await frame('New version');
    await after.locator('.tdoc-diff-del').first().waitFor();
    assert.equal(await dialog.locator('.tdoc-diff-pane.is-before').isVisible(), false);
    assert((await after.locator('body').innerText()).includes('Send changes through chat.'));
    assert.equal(await after.locator('[onclick]').count(), 0, 'historical copies cannot carry event handlers');
    if (process.env.TDOC_DIFF_SCREENSHOTS) await page.screenshot({path: process.env.TDOC_DIFF_SCREENSHOTS + '/mobile.png',fullPage:true});
    const table = await after.locator('#budget').evaluate(el => [...el.rows].map(r => [...r.cells].map(c => {
      const copy = c.cloneNode(true); copy.querySelectorAll('del').forEach(d=>d.remove()); return copy.textContent;
    })));
    assert.deepEqual(table[0], ['Project','Budget','Status','Legacy','Owner']);
    assert.deepEqual(table.find(row => row[0] === 'Testing'), ['Testing','4,000','Planned','—','Mei']);
    assert.deepEqual(table.find(row => row[0] === 'Research'), ['Research','10,000','Active','A','Lin']);
    assert.deepEqual(table.find(row => row[0] === 'Ads'), ['Ads','6,000','Planned','C','—']);
    assert.equal(await after.locator('#intro a').getAttribute('href'), 'https://tdoc.dev');

    await dialog.getByRole('radio', { name: 'Both', exact: true }).click();
    await dialog.getByRole('button', { name: 'Play together' }).waitFor();
    assert(await dialog.locator('.tdoc-diff-pane.is-before').isVisible());
    before = await frame('Previous version'); after = await frame('New version');
    await dialog.getByRole('button',{name:'Show animation',exact:true}).click();
    await before.waitForFunction(()=>document.querySelector('#motion').getBoundingClientRect().top < innerHeight);
    const slider = dialog.getByRole('slider', { name: 'Shared animation time' });
    await slider.press('End');
    await before.waitForFunction(() => document.getAnimations()[0]?.currentTime > 0);
    const times = await Promise.all([before,after].map(f=>f.evaluate(()=>document.getAnimations()[0].currentTime)));
    assert.equal(times[0],times[1], 'both versions have one clock');
    assert.equal(await after.locator('[data-tdoc-change]').count(), 0, 'Both shows unmodified originals');

    await dialog.getByRole('radio', { name: 'Before', exact: true }).click();
    await dialog.getByRole('button', { name: 'Play together' }).waitFor();
    assert(await dialog.locator('.tdoc-diff-pane.is-before').isVisible());
    assert.equal(await dialog.locator('.tdoc-diff-pane.is-after').isVisible(),false);
    await dialog.getByRole('radio', { name: 'Changes', exact: true }).click();
    await summary.waitFor();
    await dialog.getByRole('combobox', { name: 'After version' }).selectOption('1');
    await summary.waitFor();
    after = await frame('New version');
    await after.locator('#title[data-tdoc-change="add"]').waitFor();
    assert.equal(await dialog.getByRole('combobox', { name: 'Before version' }).inputValue(), '0');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({state:'detached'});
    assert.equal(await page.locator('iframe[aria-label="Document content"]').count(),1);
    assert.equal(await page.frameLocator('iframe[aria-label="Document content"]').locator('[data-tdoc-change],.tdoc-diff-del').count(),0,'comparison annotations never touch the reader');
    await page.getByRole('button', {name:'More actions',exact:true}).click();
    await page.getByRole('menuitem', {name:'Compare versions…',exact:true}).click();
    await summary.waitFor();
    for (const width of [320,390,1400]) {
      await page.setViewportSize({width,height:900});
      await summary.waitFor();
      assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1), 'comparison fits '+width);
    }
    assert.deepEqual(writes, [], 'review never writes document or comment state');
    assert.deepEqual(errors, []);
    const baselineRoute = '**/v/1/frame?tdoc_compare=1';
    await page.route(baselineRoute, async route => {
      // APIRequestContext does not preserve browser-generated fetch metadata.
      const response=await route.fetch({headers:{...route.request().headers(),'sec-fetch-dest':'iframe'}});
      assert.equal(response.status(),200);
      await route.fulfill({response,body:(await response.text()).replace('</article>','<canvas width="10" height="10"></canvas></article>')});
    });
    await page.goto(`${url}?compare=1`);
    await summary.waitFor();
    await dialog.getByText(/cannot be precisely synchronized/).waitFor();
    await page.unroute(baselineRoute);
    // The comparison reuses the real protected frame route. A denied baseline
    // cannot be treated as an empty version or a successful zero-change diff.
    await page.route(baselineRoute, route => route.fulfill({status:403,contentType:'text/html',body:'Access denied'}));
    await page.goto(`${url}?compare=1`);
    await dialog.getByRole('alert').waitFor({timeout:25000});
    assert((await dialog.getByRole('alert').innerText()).includes('may not have access'));
    assert.equal(await summary.count(),0);
    console.log('PASS version diff: desktop/mobile, words, aligned rows/columns, SVG IDs, synchronized motion, first version, close/reopen and no writes');
  } finally { await browser.close(); await target.stop(); }
})().catch(error => { console.error(error); process.exitCode=1; });
