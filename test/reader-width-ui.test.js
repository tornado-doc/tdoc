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
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
    };
    await switchTo('Wide width');
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
    await page.setViewportSize({ width: 375, height: 800 });
    await switchTo('Wide width');
    assert(await frame.locator('html').evaluate(e => e.scrollWidth <= innerWidth+1));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
    assert.deepEqual(failures, []);
    console.log('  ✓ live shell toggles, remembers and resizes visuals without changing saved content or overflowing phones');
  } finally { await browser.close(); await target.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
