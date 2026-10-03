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
    const view = page.getByRole('main', { name: 'Version changes' });
    const summary = view.locator('.tdoc-diff-summary');
    await summary.waitFor({state:'attached'});
    assert(!(await summary.innerText()).startsWith('No content'));
    assert.equal(await page.getByRole('dialog').count(),0,'diff is a page, not a popup');
    assert.equal(await view.getByRole('radiogroup').count(),0,'no view setup is required');
    const pairText = () => view.getByRole('group', { name: 'Versions to compare' }).innerText();
    assert.equal((await pairText()).replace(/\s+/g,' ').trim(),'Compare v1 v2','opens on the previous version and the viewed one');
    assert.equal(await page.locator('iframe[aria-label="Document content"]').isVisible(),false);
    await page.frameLocator('iframe[aria-label="Document content"]').locator('body').evaluate(() => { window.__readerInstance = 'retained'; });
    await page.evaluate(() => window.postMessage({source:'tdoc-compare',type:'error',message:'spoof'},'*'));
    assert.equal(await view.getByRole('alert').count(),0,'unrelated windows cannot impersonate a comparison frame');
    if (process.env.TDOC_DIFF_SCREENSHOTS) await page.screenshot({path: process.env.TDOC_DIFF_SCREENSHOTS + '/desktop.png',fullPage:true});
    const frame = async name => {
      const locator = view.locator(`iframe[aria-label="${name}"]`);
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
    assert.equal(await view.locator('iframe').first().getAttribute('sandbox'), 'allow-scripts');

    // Unequal content heights must align matching blocks, not raw pixels or
    // whole-document percentages. This also models an asset expanding on load.
    await before.locator('#flow-title').evaluate(el => {
      const gap=document.createElement('div'); gap.id='scroll-test-gap'; gap.style.height='350px'; el.before(gap);
    });
    const alignAt = async (source, targetFrame, id) => {
      await source.evaluate(id => scrollTo(0,document.getElementById(id).getBoundingClientRect().top+scrollY),id);
      await targetFrame.waitForFunction(id => Math.abs(document.getElementById(id).getBoundingClientRect().top)<2,id);
    };
    await alignAt(before,after,'flow-title');
    const positions = await Promise.all([before,after].map(f=>f.evaluate(()=>scrollY)));
    assert(Math.abs(positions[0]-positions[1])>300,'matched sections align despite different pixel offsets');
    await alignAt(after,before,'budget-title');
    await before.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
    await after.waitForFunction(()=>Math.abs(scrollY-(document.documentElement.scrollHeight-innerHeight))<2);
    const oldBottom=await before.evaluate(()=>scrollY);
    await page.evaluate(()=>{window.__scrollMessages=0;addEventListener('message',e=>{if(e.data?.source==='tdoc-compare'&&e.data.type==='scroll')window.__scrollMessages++;});});
    const afterBox=await view.locator('iframe[aria-label="New version"]').boundingBox();
    await page.mouse.move(afterBox.x+100,afterBox.y+100);
    await page.mouse.wheel(0,-180);
    await before.waitForFunction(bottom=>scrollY<bottom-10,oldBottom);
    await page.waitForTimeout(200);
    const settled=await Promise.all([before,after].map(f=>f.evaluate(()=>scrollY)));
    await page.waitForTimeout(200);
    const later=await Promise.all([before,after].map(f=>f.evaluate(()=>scrollY)));
    assert(later.every((y,i)=>Math.abs(y-settled[i])<1),'following scroll does not bounce back or drift');
    assert(await page.evaluate(()=>window.__scrollMessages)<20,'programmatic following cannot form a message loop');
    await alignAt(before,after,'flow-title');
    await after.evaluate(()=>scrollTo(0,0));
    await before.waitForFunction(()=>scrollY===0);
    await before.locator('#scroll-test-gap').evaluate(el=>el.remove());

    await page.setViewportSize({ width: 390, height: 900 });
    await view.locator('.tdoc-diff-frames.is-narrow').waitFor();
    await summary.waitFor({state:'attached'});
    after = await frame('New version');
    await after.locator('.tdoc-diff-del').first().waitFor();
    assert.equal(await view.locator('.tdoc-diff-pane.is-before').isVisible(), false);
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

    await view.getByRole('button',{name:'Show animation',exact:true}).click();
    await view.getByRole('button', { name: 'Play together' }).waitFor();
    assert(await view.locator('.tdoc-diff-pane.is-before').isVisible());
    before = await frame('Previous version'); after = await frame('New version');
    await before.waitForFunction(()=>document.querySelector('#motion').getBoundingClientRect().top < innerHeight);
    const slider = view.getByRole('slider', { name: 'Shared animation time' });
    await slider.press('End');
    await before.waitForFunction(() => document.getAnimations()[0]?.currentTime > 0);
    const times = await Promise.all([before,after].map(f=>f.evaluate(()=>document.getAnimations()[0].currentTime)));
    assert.equal(times[0],times[1], 'both versions have one clock');
    await view.getByRole('button',{name:'Back to changes',exact:true}).click();
    assert.equal(await view.locator('.tdoc-diff-pane.is-before').isVisible(),false);
    await view.getByRole('button', { name: 'Back to document', exact: true }).click();
    await view.waitFor({state:'detached'});
    assert.equal(await page.locator('iframe[aria-label="Document content"]').count(),1);
    assert.equal(await page.frameLocator('iframe[aria-label="Document content"]').locator('body').evaluate(() => window.__readerInstance),'retained','reader instance survives the comparison');
    assert.equal(await page.frameLocator('iframe[aria-label="Document content"]').locator('[data-tdoc-change],.tdoc-diff-del').count(),0,'comparison annotations never touch the reader');
    await page.getByRole('button', {name:'More actions',exact:true}).click();
    await page.getByRole('menuitem', {name:'Compare versions',exact:true}).click();
    await summary.waitFor({state:'attached'});
    assert(new URL(page.url()).searchParams.has('compare'));
    await page.goBack();
    await view.waitFor({state:'detached'});
    assert(await page.locator('iframe[aria-label="Document content"]').isVisible());
    await page.goForward();
    await summary.waitFor({state:'attached'});
    for (const width of [320,390,1400]) {
      await page.setViewportSize({width,height:900});
      await summary.waitFor({state:'attached'});
      assert(await view.evaluate(el=>el.scrollWidth<=el.clientWidth+1), 'comparison fits '+width);
    }
    await page.goto(`${url.replace(/\/v\/2$/, '/v/1')}?compare=1`);
    await summary.waitFor({state:'attached'});
    after = await frame('New version');
    await after.locator('#title[data-tdoc-change="add"]').waitFor();
    assert.equal(await view.getByRole('button',{name:'Older version: Empty'}).count(),0,'nothing older than v1 to pick');
    assert.equal(await view.locator('.tdoc-diff-version.is-fixed').innerText(),'Empty');
    assert.equal(await view.locator('iframe[aria-label="Previous version"]').count(),0);

    // Either side can be picked. Picking replaces the history step, so one
    // Back still leaves the comparison.
    await view.getByRole('button',{name:'Newer version: v1'}).click();
    await page.getByRole('menuitem',{name:'v2',exact:true}).click();
    await view.locator('iframe[aria-label="Previous version"]').waitFor({state:'attached'});
    assert.equal((await pairText()).replace(/\s+/g,' ').trim(),'Compare v1 v2');
    let params = new URL(page.url()).searchParams;
    assert.deepEqual([params.get('compare'),params.get('from'),params.get('to')],['1','1','2']);
    after = await frame('New version');
    await after.locator('#added[data-tdoc-change="add"]').waitFor();
    await view.getByRole('button',{name:'Newer version: v2'}).click();
    await page.getByRole('menuitem',{name:'v1',exact:true}).click();
    await view.locator('iframe[aria-label="Previous version"]').waitFor({state:'detached'});
    assert.equal(new URL(page.url()).searchParams.get('to'),'1');
    await page.keyboard.press('Escape');
    await view.waitFor({state:'detached'});
    assert(!new URL(page.url()).searchParams.has('compare'),'Esc leaves in one press');

    // An older version's "latest is" strip opens viewed → latest in place.
    await page.getByRole('button',{name:'See changes',exact:true}).click();
    await summary.waitFor({state:'attached'});
    params = new URL(page.url()).searchParams;
    assert.deepEqual([params.get('from'),params.get('to')],['1','2']);
    assert(new URL(page.url()).pathname.endsWith('/v/1'));
    await view.getByRole('button',{name:'Back to document',exact:true}).click();
    await view.waitFor({state:'detached'});
    assert(await page.locator('.tdoc-oldver-strip').isVisible());
    await page.goBack();
    await summary.waitFor({state:'attached'});
    await page.goBack();
    await view.waitFor({state:'detached'});

    // A stale pair falls back instead of failing.
    await page.goto(`${url}?compare=1&from=9&to=7`);
    await summary.waitFor({state:'attached'});
    assert.equal((await pairText()).replace(/\s+/g,' ').trim(),'Compare v1 v2');
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
    await summary.waitFor({state:'attached'});
    await view.getByText(/cannot be precisely synchronized/).waitFor();
    await page.unroute(baselineRoute);
    // The comparison reuses the real protected frame route. A denied baseline
    // cannot be treated as an empty version or a successful zero-change diff.
    await page.route(baselineRoute, route => route.fulfill({status:403,contentType:'text/html',body:'Access denied'}));
    await page.goto(`${url}?compare=1`);
    await view.getByRole('alert').waitFor({timeout:25000});
    assert((await view.getByRole('alert').innerText()).includes('may not have access'));
    assert.equal(await summary.count(),0);
    console.log('PASS version diff: bidirectional aligned scrolling without feedback, direct page and history, both-side version picking, See changes strip, Esc exit, stale pairs, desktop/mobile, words, aligned rows/columns, SVG IDs, synchronized motion, first version, close/reopen and no writes');
  } finally { await browser.close(); await target.stop(); }
})().catch(error => { console.error(error); process.exitCode=1; });
