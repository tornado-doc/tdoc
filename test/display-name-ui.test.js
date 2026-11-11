// Settings -> Profile -> Name: the field shows the name in use, Save stays
// off until it changes, saves through POST /api/me/name, hands the saved
// name to the account menu, shows a refusal in place, and an empty save goes
// back to the sign-in name. Desktop 1280 and phone 390.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('display-name-ui.test.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_UI_SHOTS || '';
const PROVIDER = 'Jingyu Shi (Julie)';

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-display-name-ui-'));
  const config = path.join(ROOT, `.vite-display-name-${process.pid}.config.mjs`);
  fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/display-name.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
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
  console.log('Display name UI');
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

  async function open(width, answer) {
    const context = await browser.newContext({ viewport: { width, height: 760 } });
    const page = await context.newPage();
    const posts = [];
    await page.route('**/api/me/sign-in-methods', (route) => route.fulfill({ json: {
      ok: true, emails: ['jyshi@example.com'], github: { login: 'julie', id: 1, avatar_url: '' }, can_disconnect_github: true, connect_available: false,
    } }));
    await page.route('**/api/me/name', async (route) => {
      const body = route.request().postDataJSON();
      posts.push(body);
      const reply = answer(body);
      return route.fulfill({ status: reply.status || 200, json: reply.json });
    });
    await page.goto(`${base}/me?view=settings`);
    await page.getByRole('heading', { name: 'Sign-in methods' }).waitFor();
    return { context, page, posts };
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); } };
  const saved = (name) => ({ json: { ok: true, name: name.trim() || PROVIDER, display_name: name.trim(), provider_name: PROVIDER } });

  try {
    for (const width of [1280, 390]) {
      const where = width === 1280 ? 'desktop' : 'phone';

      await t(`${where}: the field shows the name in use; Save is off until it changes`, async () => {
        const { context, page, posts } = await open(width, (b) => saved(b.name));
        const input = page.getByLabel('Name', { exact: true });
        assert.equal(await input.inputValue(), PROVIDER);
        const save = page.locator('#profile').getByRole('button', { name: 'Save' });
        assert.equal(await save.isDisabled(), true);
        assert.match(await save.getAttribute('class'), /ui-btn-primary/);
        assert.equal(await input.getAttribute('maxlength'), '60');
        const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
        assert.equal(posts.length, 0);
        await context.close();
      });

      await t(`${where}: saving sends the name, updates the menu, and offers the sign-in name back`, async () => {
        const { context, page, posts } = await open(width, (b) => saved(b.name));
        const input = page.getByLabel('Name', { exact: true });
        await input.fill('Julie Shi');
        await page.locator('#profile').getByRole('button', { name: 'Save' }).click();
        await page.locator('#profile').getByRole('status').getByText('Saved.').waitFor();
        assert.deepEqual(posts, [{ name: 'Julie Shi' }]);
        assert.equal(await page.getByTestId('menu-name').textContent(), 'Julie Shi');
        assert.match(await page.locator('#profile .manage-hint').textContent(), /Leave it empty to use Jingyu Shi \(Julie\) from your sign-in/);
        assert.equal(await page.locator('#profile').getByRole('button', { name: 'Save' }).isDisabled(), true);
        await shot(page, `display-name-settings-${where}.png`);
        // Enter submits too; an empty name goes back to the sign-in name.
        await input.fill('');
        await input.press('Enter');
        await page.locator('#profile').getByRole('status').getByText('Saved.').waitFor();
        assert.deepEqual(posts[1], { name: '' });
        assert.equal(await input.inputValue(), PROVIDER);
        assert.equal(await page.getByTestId('menu-name').textContent(), PROVIDER);
        await context.close();
      });

      await t(`${where}: a refusal is shown in place and nothing changes`, async () => {
        const { context, page } = await open(width, () => ({ status: 400, json: { error: 'invalid_name', message: 'Names can’t contain < or >.' } }));
        await page.getByLabel('Name', { exact: true }).fill('<b>Julie</b>');
        await page.locator('#profile').getByRole('button', { name: 'Save' }).click();
        await page.locator('#profile').getByRole('status').getByText('Names can’t contain < or >.').waitFor();
        assert.equal(await page.getByTestId('menu-name').textContent(), PROVIDER);
        await context.close();
      });
    }
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
  else console.log('\nall passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
