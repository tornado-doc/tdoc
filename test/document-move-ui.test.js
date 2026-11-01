// An author can move the open document from its top-right menu. The shared
// picker offers My docs and other teams, never the current workspace.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('document-move-ui.test.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-document-move-ui-'));
  const config = path.join(ROOT, `.vite-document-move-${process.pid}.config.mjs`);
  fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/document-move.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
  try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', config], { cwd: ROOT, stdio: 'pipe' }); }
  finally { fs.rmSync(config, { force: true }); }
  return out;
}

(async () => {
  console.log('Document move UI');
  const out = build();
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/h.css"></head><body><div id="root"></div><script type="module" src="/h.js"></script></body></html>';
  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    if (pathname === '/h.js' || pathname === '/h.css') {
      res.setHeader('content-type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      return res.end(fs.readFileSync(path.join(out, pathname.slice(1))));
    }
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };
  const open = async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 780 } });
    await page.goto(base);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Move document…' }).click();
    await page.getByRole('dialog', { name: 'Move Quarterly plan' }).waitFor();
    return page;
  };

  try {
    await t('offers personal and other workspaces, excluding the current team', async () => {
      const page = await open(1100);
      const choices = await page.locator('.move-list button').evaluateAll((buttons) => buttons.map((button) => (
        [...button.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim()
      )));
      assert.deepEqual(choices, ['My docs', 'BeFreed']);
      assert.equal(choices.includes('Tdoc'), false);
      assert.match(await page.getByRole('dialog').textContent(), /You stay the author/);
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'document-move-desktop.png'), fullPage: true }); }
      await page.locator('.move-list button').nth(1).click();
      await page.getByRole('status').waitFor();
      assert.match(await page.getByRole('status').textContent(), /Moving to BeFreed/);
      await page.close();
    });

    await t('fits the workspace picker on a phone without sideways overflow', async () => {
      const page = await open(390);
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        buttons: [...document.querySelectorAll('.move-list button')].map((el) => el.getBoundingClientRect().height),
      }));
      assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
      assert.ok(layout.buttons.every((height) => height >= 44), JSON.stringify(layout.buttons));
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'document-move-phone.png'), fullPage: true }); }
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
