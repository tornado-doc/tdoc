const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2];
  const b = await chromium.launch({ headless: true });
  for (const [name, vp] of [['desktop', { width: 1300, height: 800 }], ['phone', { width: 390, height: 760 }]]) {
    const p = await b.newPage({ viewport: vp });
    await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForTimeout(800);
    const f = p.frames().find(x => x !== p.mainFrame());
    await f.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(700);
    await p.screenshot({ path: `/tmp/jul86-${name}-bottom.png` });
    // what fixed/sticky things sit over the bottom 120px of the viewport?
    const over = await p.evaluate(() => {
      const out = []; const H = innerHeight;
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el); if (!['fixed','sticky'].includes(cs.position) || cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect(); if (r.height === 0 || r.bottom < H - 120) continue;
        out.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 50), top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) });
      }
      return out;
    });
    const inner = await f.evaluate(() => ({ padBottom: getComputedStyle(document.body).paddingBottom, lastEl: (() => { const els=[...document.querySelectorAll('.wrap > *')]; const l=els[els.length-1]; const r=l.getBoundingClientRect(); return { tag:l.tagName, bottom: Math.round(r.bottom), viewportH: innerHeight }; })() }));
    console.log(`\n=== ${name} ${vp.width}x${vp.height} ===`); console.log('fixed/sticky over bottom 120px:', JSON.stringify(over)); console.log('frame: body padding-bottom =', inner.padBottom, '| last element bottom =', inner.lastEl.bottom, 'of', inner.lastEl.viewportH);
    await p.close();
  }
  await b.close();
})();
