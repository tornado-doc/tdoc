// Reproduces the dark authored report with light reader headings/table fills.
// Uses the real sandbox, provider bridge and shell, including a saved dark preference.
const assert = require('assert/strict');
const { chromium, webkit } = require('playwright');
const { resolveTarget } = require('./helpers/fixture-server');
(async () => {
  const target = await resolveTarget();
  const browser = await (process.env.TDOC_TEST_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true });
  try {
    const page = await browser.newPage();
    const base = new URL(target.url).origin;
    await page.addInitScript(() => { if (window === window.top) localStorage.setItem('tdoc-theme', 'dark'); });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${base}/d/custom-design/v/1`);
      const frame = page.frameLocator('iframe[aria-label="Document content"]');
      await frame.locator('html[data-tdoc-interaction-mode]').waitFor();
      assert.equal(await page.locator('#tdoc-theme-btn').count(), 0, 'custom design must have no light/dark toggle');
      // Even a stale/mistaken theme message cannot recolor a custom document.
      await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({source:'tdoc-shell',type:'tdoc:theme',theme:'dark'}, '*'));
      const colors = await frame.locator('html').evaluate(el => {
        const style = s => getComputedStyle(el.querySelector(s));
        return {filter:getComputedStyle(el).filter, bg:style('body').backgroundColor,
          heading:style('h1').color, text:style('td').color, cell:style('td').backgroundColor,
          header:style('th').color, headerBg:style('th').backgroundColor,
          overflow:el.scrollWidth > innerWidth + 1};
      });
      assert.deepEqual(colors, {filter:'none',bg:'rgb(15, 17, 21)',heading:'rgb(230, 232, 238)',text:'rgb(230, 232, 238)',cell:'rgba(0, 0, 0, 0)',header:'rgb(230, 232, 238)',headerBg:'rgb(29, 33, 42)',overflow:false});
      assert.equal(await page.evaluate(() => localStorage.getItem('tdoc-theme')), 'dark', 'custom doc must not erase the saved default-doc preference');
      console.log(`✓ custom palette preserved at ${width}px`);
    }
    await page.setViewportSize({width:1280,height:800});
    await page.goto(target.url);
    const frame = page.frameLocator('iframe[aria-label="Document content"]');
    await page.locator('#tdoc-theme-btn[aria-pressed="true"]').waitFor();
    await frame.locator('html[data-tdoc-theme="dark"]').waitFor();
    await page.locator('#tdoc-theme-btn').click();
    await frame.locator('html:not([data-tdoc-theme])').waitFor();
    assert.equal(await frame.locator('html').evaluate(el => getComputedStyle(el).filter), 'none');
    console.log('✓ tdoc design retains working dark/light control');

    const fs = require('fs'), path = require('path');
    const reader = fs.readFileSync(path.join(__dirname, '../server/reader.css'), 'utf8');
    const probe = require('../server/frame-probe-source')();
    for (const [name, attrs, css, custom] of [
      ['layout-only CSS', '', '@media(max-width:520px){.wrap{padding:12px}} body{background:white}', false],
      ['reader tokens', '', 'body{color:var(--td-ink);background:var(--td-ground);font-family:var(--td-font-display)}', false],
      ['custom light palette', '', 'body{color:#123;background:#fff}', true],
      ['custom type', '', 'body{font-family:Georgia}', true],
      ['custom content root', '', 'main{color:#eee;background:#111}', true],
      ['conditional palette', '', '@media(min-width:2000px){body{color:#eee;background:#111}}', true],
      ['explicit custom design', 'data-tdoc-design="custom"', '', true],
      ['explicit reader design', 'data-tdoc-design="tdoc"', 'body{font-family:Georgia}', false],
    ]) {
      await page.setContent(`<!doctype html><html ${attrs}><head><style>${css}</style><style id="tdoc-reader">${reader}</style></head><body><main><h1>Design ownership</h1></main></body></html>`);
      await page.evaluate(() => { window.testReady = null; window.addEventListener('message', e => {if(e.data.type === 'tdoc:ready') window.testReady=e.data;}); });
      await page.addScriptTag({content:probe});
      await page.waitForFunction(() => window.testReady);
      assert.equal(await page.evaluate(() => window.testReady.supportsTheme), !custom, name);
      assert.equal(await page.locator('#tdoc-reader').evaluate(el => el.sheet.disabled), custom, name);
      console.log(`✓ ${name}`);
    }
  } finally { await browser.close(); await target.stop(); }
})().catch(e => {console.error(e);process.exitCode=1;});
