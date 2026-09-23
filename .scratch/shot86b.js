const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2];
  const b = await chromium.launch({ headless: true });
  for (const [name, vp] of [['desktop', { width: 1300, height: 800 }], ['phone', { width: 390, height: 760 }]]) {
    const p = await b.newPage({ viewport: vp });
    await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForTimeout(1000);
    const f = p.frames().find(x => x !== p.mainFrame());
    await f.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(900);
    await p.screenshot({ path: `/tmp/jul86-landing-${name}.png` });
    const footer = await p.$eval('.tdoc-footer', el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), shown: el.classList.contains('tdoc-footer-show') }; });
    const frameTop = await p.$eval('.tdoc-doc-frame', el => Math.round(el.getBoundingClientRect().top));
    const covered = await f.evaluate((limit) => {
      // elements with visible text whose bottom edge (in frame coords) is below the footer's top edge
      const out = []; const seen = new Set();
      for (const el of document.querySelectorAll('a, button, p, li, h1, h2, h3, span, footer')) {
        const t = (el.innerText || '').trim(); if (!t || el.children.length > 3) continue;
        const r = el.getBoundingClientRect(); if (r.height === 0 || r.bottom <= limit || r.top >= innerHeight) continue;
        const k = t.slice(0, 40); if (seen.has(k)) continue; seen.add(k);
        out.push({ text: k, bottom: Math.round(r.bottom), limit });
      }
      return out.slice(0, 8);
    }, footer.top - frameTop);
    console.log(`\n=== landing ${name} === footer shown=${footer.shown} top=${footer.top}px (frame starts ${frameTop}px)`);
    console.log('content whose bottom edge sits UNDER the footer:', JSON.stringify(covered, null, 0));
    await p.close();
  }
  await b.close();
})();
