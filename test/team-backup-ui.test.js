// Team backup setup is understandable and usable on desktop and phone.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('team-backup-ui.test.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-team-backup-ui-'));
  const config = path.join(ROOT, `.vite-team-backup-${process.pid}.config.mjs`);
  fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/team-backup.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
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
  console.log('Team backup UI');
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

  async function open(width, enabled = false) {
    const context = await browser.newContext({ viewport: { width, height: 820 } });
    const page = await context.newPage();
    const calls = [];
    await page.route('**/api/team/backup*', async (route) => {
      const request = route.request();
      calls.push({ method: request.method(), body: request.postDataJSON?.() });
      if (request.method() === 'GET') {
        await route.fulfill({ json: { ok: true, backup: enabled ? {
          enabled: true, endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'acme-backups', region: 'auto', prefix: 'tdoc-backups',
          access_key_hint: 'ACCE…1234', state: 'active', last_synced_at: '2026-10-16T20:00:00Z',
        } : { enabled: false } } });
      } else if (request.method() === 'PUT') {
        await route.fulfill({ json: { ok: true, backup: {
          enabled: true, endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'acme-backups', region: 'auto', prefix: 'tdoc-backups',
          access_key_hint: 'ACCE…1234', state: 'syncing', last_synced_at: null,
        } } });
      } else if (request.method() === 'POST') {
        await route.fulfill({ json: { ok: true, backup: { enabled: true, state: 'syncing' } } });
      } else {
        await route.fulfill({ json: { ok: true, backup: { enabled: false } } });
      }
    });
    await page.goto(base);
    await page.getByRole('heading', { name: 'Acme data backup' }).waitFor();
    await page.getByLabel('S3-compatible endpoint').waitFor();
    return { context, page, calls };
  }

  try {
    await t('connects a bucket and explains asynchronous ownership clearly', async () => {
      const { context, page, calls } = await open(1050);
      assert.match(await page.locator('.tm-backup-intro').textContent(), /tdoc stays live even if the destination is offline/);
      await page.getByLabel('S3-compatible endpoint').fill('https://acct.r2.cloudflarestorage.com');
      await page.getByLabel('Bucket').fill('acme-backups');
      await page.getByLabel('Access key ID').fill('ACCESS-KEY-1234');
      await page.getByLabel('Secret access key').fill('super-secret-value');
      await page.getByRole('button', { name: 'Connect and back up' }).click();
      await page.getByText('Connected. The first full backup is running in the background.').waitFor();
      assert.equal(calls.at(-1).method, 'PUT');
      assert.equal(calls.at(-1).body.bucket, 'acme-backups');
      assert.match(await page.locator('.tm-backup-health').textContent(), /Initial backup running/);
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'team-backup-desktop.png'), fullPage: true }); }
      await context.close();
    });

    await t('an active backup can be fully resynced or turned off without deletion', async () => {
      const { context, page, calls } = await open(1050, true);
      assert.match(await page.locator('.tm-backup-health').textContent(), /Backup active.*Last copy/s);
      await page.getByRole('button', { name: 'Sync everything now' }).click();
      await page.getByText('Full backup queued. You can close this window.').waitFor();
      assert.equal(calls.at(-1).method, 'POST');
      await page.getByRole('button', { name: 'Turn off' }).click();
      await page.getByText('Existing files in your bucket were not deleted.').waitFor();
      assert.equal(calls.at(-1).method, 'DELETE');
      await context.close();
    });

    await t('phone form has 44px controls and no sideways overflow', async () => {
      const { context, page } = await open(390);
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        inputs: [...document.querySelectorAll('.tm-backup-grid input')].map((element) => element.getBoundingClientRect().height),
        actions: [...document.querySelectorAll('.tdoc-modal .actions button')].map((element) => element.getBoundingClientRect().height),
      }));
      assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
      assert.ok(layout.inputs.every((height) => height >= 44), JSON.stringify(layout.inputs));
      assert.ok(layout.actions.every((height) => height >= 44), JSON.stringify(layout.actions));
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'team-backup-phone.png'), fullPage: true }); }
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
