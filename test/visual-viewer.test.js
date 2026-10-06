const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const { resolveTarget } = require('./helpers/fixture-server');
(async () => {
  const target = await resolveTarget();
  const browser = await (process.env.TDOC_TEST_BROWSER === 'webkit' ? webkit : chromium).launch();
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({width,height:850});
      await page.goto(new URL('/d/visual-viewer/v/1', target.url).href);
      const frame = page.frameLocator('iframe[aria-label="Document content"]');
      await frame.locator('html[data-tdoc-interaction-mode]').waitFor();
      await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({source:'tdoc-shell',type:'tdoc:mode',mode:'read'},'*'));
      await frame.locator('html[data-tdoc-interaction-mode="read"]').waitFor();
      await frame.getByRole('button',{name:'View Landscape illustration fullscreen'}).waitFor();
      const iconOffsets = await frame.locator('.tdoc-visual-open').evaluateAll(buttons => buttons.map(button => {
        const b = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect();
        return { x: icon.x + icon.width / 2 - b.x - b.width / 2, y: icon.y + icon.height / 2 - b.y - b.height / 2 };
      }));
      assert(iconOffsets.every(({x,y}) => Math.abs(x) < 1 && Math.abs(y) < 1), 'expand icons stay centered despite reader SVG margins');
      assert(await frame.locator('main').evaluate(el => el.getBoundingClientRect().width <= 720), 'standard stays narrow despite legacy wide attribute');
      for (const selector of ['#photo','#flow','#vector','#composed']) {
        const before = await frame.locator(selector).getAttribute('style');
        await frame.locator(selector).click({position:{x:25,y:25}});
        await page.locator('[data-visual-open]').waitFor();
        const r = await frame.locator(selector).boundingBox();
        assert(r.x >= -1 && r.x+r.width <= width+1, `${selector} fits ${width}px viewport`);
        assert(r.y >= 55 && r.y+r.height <= 851, `${selector} clears toolbar and fits height`);
        await frame.getByRole('button',{name:'Zoom in',exact:true}).click();
        await frame.getByRole('button',{name:'Fit visual',exact:true}).click();
        await frame.getByRole('button',{name:'Close fullscreen'}).click();
        await page.locator('[data-visual-open]').waitFor({state:'detached'});
        assert.equal(await frame.locator(selector).getAttribute('style'),before,'temporary styles restored');
      }
      const widget = frame.frameLocator('#widget');
      await widget.getByRole('button',{name:'Add one'}).click();
      await frame.getByRole('button',{name:'View Interactive counter fullscreen'}).click();
      await page.locator('[data-visual-open]').waitFor();
      assert.equal(await widget.locator('#count').innerText(),'1','widget state survives expansion');
      await widget.getByRole('button',{name:'Add one'}).click();
      await frame.getByRole('button',{name:'Close fullscreen'}).click();
      assert.equal(await widget.locator('#count').innerText(),'2','widget state survives close');
      await frame.getByRole('button',{name:'View Publishing flowchart fullscreen'}).focus();
      await page.keyboard.press('Enter');
      await page.locator('[data-visual-open]').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('[data-visual-open]').waitFor({state:'detached'});
      assert.equal(await frame.locator('.tdoc-visual-open:focus').getAttribute('aria-label'),'View Publishing flowchart fullscreen');
      assert.equal(await frame.getByRole('button',{name:'View Linked illustration fullscreen'}).count(),0,'linked image keeps navigation');
      await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({source:'tdoc-shell',type:'tdoc:mode',mode:'comment'},'*'));
      await frame.locator('html[data-tdoc-interaction-mode="comment"]').waitFor();
      assert(await frame.locator('.tdoc-visual-open:visible').count()>0,'comment mode keeps an explicit expand button');
      await frame.locator('#flow').click({position:{x:25,y:25}});
      assert.equal(await page.locator('[data-visual-open]').count(),0,'click-to-comment is not hijacked');
      console.log(`✓ images, HTML flowchart, SVG, widgets, keyboard and comment mode at ${width}px`);
    }
    await page.setViewportSize({width:1280,height:850});
    await page.goto(new URL('/d/visual-viewer/v/1', target.url).href);
    const f = page.frameLocator('iframe[aria-label="Document content"]');
    await f.getByRole('button',{name:'View Landscape illustration fullscreen'}).click();
    await page.locator('[data-visual-open]').waitFor();
    const lightImage = await f.locator('#photo').screenshot();
    await f.getByRole('button',{name:'Close fullscreen'}).click();
    await page.getByRole('button',{name:'Dark mode',exact:true}).click();
    await f.locator('html[data-tdoc-theme="dark"]').waitFor();
    await f.getByRole('button',{name:'View Landscape illustration fullscreen'}).click();
    await page.locator('[data-visual-open]').waitFor();
    const darkImage = await f.locator('#photo').screenshot();
    const changedPixels = await page.evaluate(async ([light,dark]) => {
      const pixels = async data => {
        const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height;
        const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0);
        return ctx.getImageData(0,0,image.width,image.height).data;
      };
      const a=await pixels(light),b=await pixels(dark);
      if(a.length!==b.length)return 1;
      let changed=0;
      for(let i=0;i<a.length;i+=4)if(Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]))>2)changed++;
      return changed/(a.length/4);
    },[lightImage.toString('base64'),darkImage.toString('base64')]);
    assert(changedPixels < .005,'fullscreen photos preserve colors, allowing subpixel edge antialiasing');
    for(let n=0;n<5;n++) await f.getByRole('button',{name:'Zoom in',exact:true}).click();
    await f.getByRole('button',{name:'Close fullscreen'}).click();
    await page.locator('[data-visual-open]').waitFor({state:'detached'});
    console.log('✓ original image colors in dark mode; controls stay reachable at high zoom');
    await page.goto(new URL('/d/custom-design/v/1',target.url).href);
    const custom = page.frameLocator('iframe[aria-label="Document content"]');
    await custom.getByRole('button',{name:'View Custom palette panel fullscreen'}).waitFor();
    assert(await custom.locator('.wrap').evaluate(el=>el.getBoundingClientRect().width)>720,'custom design keeps its authored width');
    const beforeColor = await custom.locator('.card').evaluate(el=>[getComputedStyle(el).color,getComputedStyle(el).backgroundColor]);
    await custom.getByRole('button',{name:'View Custom palette panel fullscreen'}).click();
    await page.locator('[data-visual-open]').waitFor();
    assert.deepEqual(await custom.locator('.card').evaluate(el=>[getComputedStyle(el).color,getComputedStyle(el).backgroundColor]),beforeColor);
    await custom.getByRole('button',{name:'Close fullscreen'}).click();
    console.log('✓ custom width and palette preserved');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); await target.stop(); }
})().catch(e => { console.error(e); process.exitCode=1; });
