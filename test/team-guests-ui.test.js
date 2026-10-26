const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('team-guests-ui.test.js');

const ROOT = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-team-guests-ui-'));
const config = path.join(ROOT, `.vite-team-guests-${process.pid}.config.mjs`);
fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/team-guests.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', config], { cwd: ROOT, stdio: 'pipe' }); }
finally { fs.rmSync(config, { force: true }); }

(async () => {
  const server = http.createServer((request, response) => {
    const pathname = request.url.split('?')[0];
    if (pathname === '/h.js' || pathname === '/h.css') {
      response.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      return response.end(fs.readFileSync(path.join(out, pathname.slice(1))));
    }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/h.css"></head><body><div id="root"></div><script type="module" src="/h.js"></script></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const shots = process.env.TDOC_UI_SHOTS;
  let failed = 0;
  try {
    for (const width of [1280, 390]) {
      try {
        const page = await browser.newPage({ viewport: { width, height: 850 } });
        await page.route('**/api/team/guests*', (route) => route.fulfill({ json: { ok: true,
          guests: [{ invitee: 'marie@befreed.ai', documents: [{ slug: 'roadmap', title: 'Roadmap' }], added_by: 'Julie' }],
          limit: 5, invites: ['marie@befreed.ai'],
        } }));
        await page.route('**/api/team?*', (route) => route.fulfill({ json: { ok: true, team: {
          id: 't_0123456789abcdef', name: 'BeFreed', role: 'admin', members: [{ account_id: 'alice', key: 'alice', name: 'Alice', role: 'admin', me: true }], invites: [],
        } } }));
        await page.route('**/api/team/billing*', (route) => route.fulfill({ json: { ok: true, billing: { configured: false } } }));
        await page.route('**/api/team/backup*', (route) => route.fulfill({ json: { ok: true, backup: null } }));
        await page.goto(base);
        await page.getByRole('radio', { name: 'Guests' }).click();
        await page.getByText('1 guest · limit 5').waitFor();
        assert.match(await page.locator('[aria-label="Guests"]').textContent(), /ma•••@befreed.ai.*Roadmap.*Julie.*Resend invite/s);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
        if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `team-guests-${width}.png`), fullPage: true }); }
        console.log(`  ✓ ${width}px: guest settings tab, roster, invite and layout`);
        await page.close();
      } catch (error) { failed++; console.log(`  ✗ ${width}px: ${error.message}`); }
    }
    const member = await browser.newPage();
    await member.goto(`${base}/?role=member`);
    await member.getByRole('radio', { name: 'Members' }).waitFor();
    assert.equal(await member.getByRole('radio', { name: 'Guests' }).count(), 0, 'member should not see guest settings');
    await member.close();
    console.log('  ✓ member settings omit private guest roster');
  } finally { await browser.close(); server.close(); fs.rmSync(out, { recursive: true, force: true }); }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
