// JUL-38 reproduction: seed a notification, click it, see where we land.
const fs = require('fs'), path = require('path'), { spawn } = require('child_process'), net = require('net');
const { chromium } = require('playwright');
const REPO = process.env.REPO;
const FIX = '/tmp/orphanfix';
const USER = 'tester';

function reservePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }
async function waitFor(url, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(url); if (r.ok || r.status < 500) return; } catch {} await new Promise(r => setTimeout(r, 200)); } throw new Error('server never came up'); }

(async () => {
  const port = await reservePort();
  const inboxFile = path.join(FIX, `.inbox-${USER}.json`);
  fs.writeFileSync(inboxFile, JSON.stringify({ items: [{
    id: 'n1', kind: 'comment', group_key: 'g1', slug: 'sample-doc', version: 2,
    comment_id: 'c_fixture_1', thread_id: 'c_fixture_1',
    actor: { login: 'alice', name: 'alice', avatar_url: '' },
    preview: 'Fixture comment on Section Two prose', title: 'sample-doc',
    at: new Date().toISOString(), read: false, count: 1,
  }] }));
  const child = spawn('node', [path.join(REPO, 'server/server.js')], {
    env: { ...process.env, TDOC_DIR: FIX, TDOC_PORT: String(port), TDOC_E2E_USER: USER },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${base}/d/sample-doc/v/2`);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', e => console.log('  [pageerror]', e.message));
    page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text()); });

    async function run(label, startUrl) {
      console.log(`\n=== ${label}: start at ${startUrl.replace(base, '')} ===`);
      // reset read state each run
      const inbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8')); inbox.items[0].read = false; fs.writeFileSync(inboxFile, JSON.stringify(inbox));
      await page.goto(startUrl, { waitUntil: 'networkidle' });
      await page.click('.tdoc-account-trigger');
      await page.waitForSelector('.ui-menu-popup', { timeout: 3000 });
      await page.locator('.ui-menu-popup').getByText(/^Notifications/).click();
      await page.waitForSelector('.ui-dialog-popup', { timeout: 3000 });
      await page.waitForSelector('.tdoc-notification-list .tdoc-cluster-row', { timeout: 5000 });
      const rows = await page.locator('.tdoc-notification-list .tdoc-cluster-row').allTextContents();
      console.log('  notification rows:', rows.map(t => t.trim().slice(0, 60)));
      const item = page.locator('.tdoc-notification-list .tdoc-cluster-row').first();
      const before = page.url();
      await item.click();
      const samples = [];
      for (const ms of [300, 800, 1500, 3000, 6000]) {
        await page.waitForTimeout(ms - (samples.length ? [300,800,1500,3000,6000][samples.length-1] : 0));
        samples.push({ ms, pins: await page.locator('.tdoc-pin').count(),
          active: await page.locator('.tdoc-margin-comment.active').count(),
          floating: await page.locator('.tdoc-floating-open').count(),
          unanchored: await page.locator('.tdoc-margin-comment.unanchored, .tdoc-margin-comment[data-unanchored], .tdoc-lost').count() });
      }
      console.log('  timeline:', JSON.stringify(samples));
      const after = page.url();
      console.log('  url before :', before.replace(base, ''));
      console.log('  url after  :', after.replace(base, ''));
      const opened = await page.locator('.tdoc-margin-comment.active, .tdoc-current-comment').count();
      const classes = await page.locator('.tdoc-margin-comment').evaluateAll(els => els.map(e => e.className));
      console.log('  margin-comment classes:', JSON.stringify(classes));
      const pins = await page.locator('.tdoc-pin').count();
      const dialogStillOpen = await page.locator('.ui-dialog-popup').count();
      console.log(`  comment card open (.active): ${opened}   pins: ${pins}   dialog still open: ${dialogStillOpen}`);
      console.log(`  RESULT: ${opened > 0 ? 'OPENED the comment' : 'did NOT open the comment'}`);
      const geo = await page.evaluate(() => {
        const pin = document.querySelector('.tdoc-pin');
        const r = pin ? pin.getBoundingClientRect() : null;
        const frame = document.querySelector('.tdoc-doc-frame');
        return { innerHeight: window.innerHeight, pinTop: r && Math.round(r.top), pinLeft: r && Math.round(r.left),
                 frameH: frame && Math.round(frame.getBoundingClientRect().height), narrow: window.innerWidth < 900 };
      });
      console.log('  geometry:', JSON.stringify(geo));

    }
    await run('A. cross-version (v1 -> notification for v2)', `${base}/d/sample-doc/v/1`);
    await run('B. same document (already on v2)', `${base}/d/sample-doc/v/2`);
    await browser.close();
  } finally {
    child.kill('SIGTERM');
    try { fs.rmSync(inboxFile, { force: true }); } catch {}
  }
})().catch(e => { console.error('REPRO FAILED:', e); process.exit(1); });
