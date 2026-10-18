// Team plan card (#48): free docs used, upgrade with a monthly/yearly choice, a
// paid plan's seats and renewal, Manage billing, and a phone layout.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('team-billing-ui.test.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-team-billing-ui-'));
  const config = path.join(ROOT, `.vite-team-billing-${process.pid}.config.mjs`);
  fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/team-billing.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
  try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', config], { cwd: ROOT, stdio: 'pipe' }); }
  finally { fs.rmSync(config, { force: true }); }
  return out;
}

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
}

(async () => {
  console.log('Team plan UI');
  const out = build();
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/h.css"></head><body><div id="root"></div><script type="module" src="/h.js"></script></body></html>';
  const server = http.createServer((request, response) => {
    const pathname = request.url.split('?')[0];
    if (pathname === '/h.js' || pathname === '/h.css') {
      response.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      return response.end(fs.readFileSync(path.join(out, pathname.slice(1))));
    }
    response.setHeader('content-type', 'text/html');
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });

  const FREE = { configured: true, free_docs: 20, prices: { month: 5, year: 50 }, docs: 12, seats: 3, plan: 'free', status: null, interval: null, quantity: null, current_period_end: null, cancel_at_period_end: false, has_customer: false, at_limit: false };
  const PAID = { ...FREE, docs: 53, seats: 5, plan: 'team', status: 'active', interval: 'year', quantity: 5, current_period_end: '2027-10-18T00:00:00Z', has_customer: true };

  async function open(width, billing, query = '') {
    const context = await browser.newContext({ viewport: { width, height: 820 } });
    const page = await context.newPage();
    const calls = [];
    await page.route('**/api/team/billing*', async (route) => {
      const request = route.request();
      calls.push({ method: request.method(), body: request.postDataJSON?.() });
      if (request.method() === 'GET') return route.fulfill({ json: { ok: true, billing } });
      return route.fulfill({ json: { ok: true, url: `${base}/stripe-hosted?${request.postDataJSON().action}` } });
    });
    await page.goto(`${base}/${query}`);
    if (billing.configured) await page.getByRole('heading', { name: 'Plan' }).waitFor();
    return { context, page, calls };
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); } };

  try {
    await t('a deployment without Stripe shows no plan card at all', async () => {
      const { context, page, calls } = await open(1050, { ...FREE, configured: false });
      await page.waitForTimeout(300);
      assert.equal(calls.length, 1);
      assert.equal(await page.locator('#billing').count(), 0);
      await context.close();
    });

    await t('a free team sees its docs used, the price for both periods, and upgrades through Checkout', async () => {
      const { context, page, calls } = await open(1050, FREE);
      assert.match(await page.locator('#billing').textContent(), /Free for 20 docs and any number of members.*unlimited docs and Data backup.*\$5 per member a month, or \$50 a year.*12 of 20 free docs used/s);
      assert.equal(await page.locator('.tm-plan-badge').textContent(), 'Free');
      assert.match(await page.locator('.tm-plan-choose').textContent(), /3 × \$5 = \$15 \/ month/);
      await page.getByRole('radio', { name: 'Yearly' }).click();
      assert.match(await page.locator('.tm-plan-choose').textContent(), /3 × \$50 = \$150 \/ year/);
      assert.equal(await page.getByRole('button', { name: 'Manage billing' }).count(), 0, 'no portal before a customer exists');
      await shot(page, 'team-billing-free-desktop.png');
      await page.getByRole('button', { name: 'Upgrade to Team' }).click();
      await page.waitForURL(/stripe-hosted\?checkout/);
      assert.deepEqual(calls.filter((c) => c.method === 'POST').at(-1).body, { id: 't_0123456789abcdef', action: 'checkout', interval: 'year' });
      await context.close();
    });

    await t('a team at the free limit is told new docs need the plan and existing ones stay editable', async () => {
      const { context, page } = await open(1050, { ...FREE, docs: 53, seats: 5, at_limit: true });
      assert.match(await page.locator('.tm-plan-summary.is-error').textContent(), /53 docs\. The free plan holds 20; upgrade to add more\. Existing docs stay editable\./);
      await shot(page, 'team-billing-limit-desktop.png');
      await context.close();
    });

    await t('a paid team sees seats, period and renewal, and opens the Customer Portal', async () => {
      const { context, page, calls } = await open(1050, PAID);
      assert.equal(await page.locator('.tm-plan-badge').textContent(), 'Team');
      assert.match(await page.locator('.tm-plan-summary').textContent(), /5 seats, billed yearly\. Renews/);
      assert.equal(await page.getByRole('button', { name: 'Upgrade to Team' }).count(), 0);
      assert.equal(await page.locator('.tm-plan-choose').count(), 0);
      await shot(page, 'team-billing-paid-desktop.png');
      await page.getByRole('button', { name: 'Manage billing' }).click();
      await page.waitForURL(/stripe-hosted\?portal/);
      assert.deepEqual(calls.filter((c) => c.method === 'POST').at(-1).body, { id: 't_0123456789abcdef', action: 'portal' });
      await context.close();
    });

    await t('a failed payment is called out in the summary', async () => {
      const { context, page } = await open(1050, { ...PAID, status: 'past_due' });
      assert.match(await page.locator('.tm-plan-summary.is-error').textContent(), /last payment failed/);
      await context.close();
    });

    await t('returning from Checkout says the plan is turning on', async () => {
      const { context, page } = await open(1050, FREE, '?billing=success');
      await page.getByText('Payment received. The Team plan turns on in a few seconds.').waitFor();
      await context.close();
    });

    await t('phone: 44px actions, stacked price choice, no sideways overflow', async () => {
      const { context, page } = await open(390, FREE);
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        actions: [...document.querySelectorAll('#billing .tm-settings-actions button')].map((el) => el.getBoundingClientRect().height),
        dir: getComputedStyle(document.querySelector('.tm-plan-choose')).flexDirection,
      }));
      assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
      assert.ok(layout.actions.length && layout.actions.every((h) => h >= 44), JSON.stringify(layout.actions));
      assert.equal(layout.dir, 'column');
      await shot(page, 'team-billing-free-phone.png');
      await context.close();
    });
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
  else console.log('\nall passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
