const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1200, height: 1400 } });
  await p.goto(process.argv[2], { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: process.argv[3], fullPage: false });
  const f = p.frames().find(x => x !== p.mainFrame());
  if (f) { const h = await f.evaluate(() => document.documentElement.scrollHeight); console.log('doc height', h);
    await f.evaluate(() => window.scrollTo(0, 2200)); await p.waitForTimeout(500);
    await p.screenshot({ path: process.argv[3].replace('.png','-mid.png') }); }
  await b.close();
})();
