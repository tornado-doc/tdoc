// The team invite page asks one question with two answers, a <button> and an
// <a>. Their user-agent defaults differ (a button is border-box, a link is
// content-box), so a shared min-height used to land 18px apart. Measure the
// real built page and require one size for both.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('team-join-buttons-ui.test.js');

const RUNTIME = path.join(__dirname, '..', 'server', 'runtime');
const manifest = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'manifest.json'), 'utf8'));
const entry = manifest['shell/src/main.jsx'];
const origin = 'https://tdoc.test';
const boot = {
  page: 'team-join',
  token: '0'.repeat(32),
  team: { id: 't_0000000000000000', name: 'Acme Research', member_count: 3 },
  identity: { login: 'sam', name: 'Sam' },
};
const html = `<!doctype html><html><head><meta charset="utf-8">${(entry.css || []).map((c) => `<link rel="stylesheet" href="/runtime/${c}">`).join('')}</head>
<body><div id="tdoc-app-root"></div><script>window.__TDOC_APP_BOOT__ = ${JSON.stringify(boot)};</script>
<script type="module" src="/runtime/${entry.file}"></script></body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.route(`${origin}/**`, (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === '/team/join') return route.fulfill({ contentType: 'text/html', body: html });
        if (pathname.startsWith('/runtime/')) return route.fulfill({ path: path.join(RUNTIME, pathname.slice('/runtime/'.length)) });
        return route.fulfill({ status: 404, body: '' });
      });
      await page.goto(`${origin}/team/join`);
      const join = page.getByRole('button', { name: 'Join team' });
      const later = page.getByRole('link', { name: 'Not now' });
      await join.waitFor();
      const a = await join.boundingBox();
      const b = await later.boundingBox();
      assert.ok(Math.abs(a.width - b.width) < 0.5, `${width}px: widths ${a.width} vs ${b.width}`);
      assert.ok(Math.abs(a.height - b.height) < 0.5, `${width}px: heights ${a.height} vs ${b.height}`);
      assert.ok(Math.abs(a.y - b.y) < 0.5, `${width}px: same row`);
      console.log(`  ✓ ${width}px: Join team and Not now are both ${a.width.toFixed(1)}×${a.height.toFixed(1)}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
