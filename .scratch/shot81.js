// Screenshot the Resolved switch on/off and report its computed colour.
const fs = require('fs'), path = require('path'), net = require('net'), { spawn } = require('child_process');
const { chromium } = require('playwright');
const REPO = process.env.REPO, OUT = process.env.OUT || '/tmp/shot81';
const FIX = '/tmp/resfix';
function reservePort() { return new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }
async function waitFor(url) { for (let i = 0; i < 80; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await new Promise(r => setTimeout(r, 150)); } throw new Error('no server'); }
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const port = await reservePort();
  const child = spawn('node', [path.join(REPO, 'server/server.js')], { env: { ...process.env, TDOC_DIR: FIX, TDOC_PORT: String(port), TDOC_E2E_USER: 'tester' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${base}/d/sample-doc/v/2`);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(`${base}/d/sample-doc/v/2`, { waitUntil: 'networkidle' });
    const track = page.locator('.tdoc-bar .tdoc-switch-track').first();
    await track.waitFor({ timeout: 5000 });
    const bar = page.locator('.tdoc-bar').first();
    const color = () => track.evaluate(el => getComputedStyle(el).backgroundColor);
    const primary = await page.locator('.tdoc-bar button.primary').first().evaluate(el => getComputedStyle(el).backgroundColor).catch(() => 'n/a');
    console.log('primary button bg   :', primary);
    console.log('switch OFF bg       :', await color());
    await bar.screenshot({ path: path.join(OUT, 'bar-off.png') });
    await track.click(); await page.waitForTimeout(800);
    const probe = await track.evaluate(el => ({
      checked: el.getAttribute('data-checked'), ariaChecked: el.getAttribute('aria-checked'),
      bg: getComputedStyle(el).backgroundColor,
      tokenOnEl: getComputedStyle(el).getPropertyValue('--td-accent').trim(),
      tokenOnRoot: getComputedStyle(document.documentElement).getPropertyValue('--td-accent').trim(),
    }));
    console.log('switch ON  probe    :', JSON.stringify(probe));
    await bar.screenshot({ path: path.join(OUT, 'bar-on.png') });
    await track.screenshot({ path: path.join(OUT, 'switch-on.png') });
    await browser.close();
  } finally { child.kill('SIGTERM'); }
})().catch(e => { console.error(e); process.exit(1); });
