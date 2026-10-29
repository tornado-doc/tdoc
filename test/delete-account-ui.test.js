// Settings -> Delete account: the danger card, the dialog that asks the
// server what deleting would do, type-to-confirm (the login, or the address
// for an email account), blockers with links to fix them, a refusal from the
// server shown in place, and the phone layout. Desktop 1280 and phone 390.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('delete-account-ui.test.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-delete-account-ui-'));
  const config = path.join(ROOT, `.vite-delete-account-${process.pid}.config.mjs`);
  fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/delete-account.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
  try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', config], { cwd: ROOT, stdio: 'pipe' }); }
  finally { fs.rmSync(config, { force: true }); }
  return out;
}

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
}

const CLEAR = { ok: true, confirm: 'alice', confirm_kind: 'login', retention_days: 30, blockers: [], teams_deleted: [{ id: 't_1', name: 'Solo' }], teams_left: [{ id: 't_2', name: 'Acme' }] };
const BLOCKED = {
  ...CLEAR,
  blockers: [
    { kind: 'sole_admin', team: { id: 't_2', name: 'Acme' }, url: '/me?team=t_2&view=settings', message: 'You are the only admin of Acme, which has other members. Make another member an admin first.' },
    { kind: 'paid_team', team: { id: 't_3', name: 'Paid' }, url: '/me?team=t_3&view=settings#billing', message: 'Paid has an active paid subscription. Cancel it in the team\'s billing, or make someone else admin and leave the team, first.' },
  ],
};

(async () => {
  console.log('Delete account UI');
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

  async function open(width, plan, post = { status: 200, json: { ok: true } }) {
    const context = await browser.newContext({ viewport: { width, height: 820 } });
    const page = await context.newPage();
    const calls = [];
    await page.route('**/api/me/account/delete', async (route) => {
      const request = route.request();
      calls.push({ method: request.method(), body: request.method() === 'POST' ? request.postDataJSON() : null });
      if (request.method() === 'GET') return route.fulfill({ json: plan });
      return route.fulfill({ status: post.status, json: post.json });
    });
    await page.goto(`${base}/me?view=settings`);
    await page.getByRole('heading', { name: 'Delete account' }).waitFor();
    return { context, page, calls };
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); } };
  const dialog = (page) => page.getByRole('dialog', { name: 'Delete account' });
  const confirmButton = (page) => dialog(page).getByRole('button', { name: 'Delete account' });

  try {
    for (const width of [1280, 390]) {
      const where = width === 1280 ? 'desktop' : 'phone';

      await t(`${where}: the card says what deleting does; nothing is asked of the server until the dialog opens`, async () => {
        const { context, page, calls } = await open(width, CLEAR);
        assert.match(await page.locator('#delete-account').textContent(), /Signs you out everywhere.*Trash.*30 days/s);
        assert.equal(calls.length, 0);
        const button = page.locator('#delete-account').getByRole('button', { name: 'Delete account…' });
        assert.match(await button.getAttribute('class'), /ui-btn-danger/);
        await shot(page, `delete-account-card-${where}.png`);
        await context.close();
      });

      await t(`${where}: type-to-confirm: the button stays off until the login is typed (any case), then deletes and leaves`, async () => {
        const { context, page, calls } = await open(width, CLEAR);
        await page.getByRole('button', { name: 'Delete account…' }).click();
        await dialog(page).getByText('Type alice to confirm').waitFor();
        const text = await dialog(page).textContent();
        assert.match(text, /signed out everywhere/);
        assert.match(text, /Deleted user/);
        assert.match(text, /only member of Solo/);
        assert.match(text, /You leave Acme/);
        assert.equal(await confirmButton(page).isDisabled(), true);
        const input = dialog(page).getByLabel('Type alice to confirm');
        await input.fill('alic');
        assert.equal(await confirmButton(page).isDisabled(), true);
        await input.fill('bob');
        assert.equal(await confirmButton(page).isDisabled(), true);
        await input.fill('ALICE');
        assert.equal(await confirmButton(page).isDisabled(), false);
        const layout = await page.evaluate(() => {
          const pop = document.querySelector('.ui-dialog-popup').getBoundingClientRect();
          return { width: innerWidth, scroll: document.documentElement.scrollWidth, left: pop.left, right: pop.right };
        });
        assert.ok(layout.scroll <= layout.width + 1 && layout.left >= 0 && layout.right <= layout.width + 1, JSON.stringify(layout));
        await shot(page, `delete-account-confirm-${where}.png`);
        await confirmButton(page).click();
        await page.waitForURL(/\/\?notice=account-deleted$/);
        assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body), [{ confirm: 'ALICE' }]);
        await context.close();
      });

      await t(`${where}: an email account types its address`, async () => {
        const { context, page } = await open(width, { ...CLEAR, confirm: 'carol@example.com', confirm_kind: 'email', teams_deleted: [], teams_left: [] });
        await page.getByRole('button', { name: 'Delete account…' }).click();
        const input = dialog(page).getByLabel('Type carol@example.com to confirm');
        await input.fill('carol');
        assert.equal(await confirmButton(page).isDisabled(), true);
        await input.fill('carol@example.com');
        assert.equal(await confirmButton(page).isDisabled(), false);
        await context.close();
      });

      await t(`${where}: blockers are listed with links to fix them, no confirm field, Delete stays off`, async () => {
        const { context, page, calls } = await open(width, BLOCKED);
        await page.getByRole('button', { name: 'Delete account…' }).click();
        const box = dialog(page).getByTestId('delete-account-blockers');
        await box.waitFor();
        assert.match(await box.textContent(), /only admin of Acme.*Make another member an admin first.*Paid has an active paid subscription/s);
        assert.equal(await box.getByRole('link', { name: 'Open team settings' }).getAttribute('href'), '/me?team=t_2&view=settings');
        assert.equal(await box.getByRole('link', { name: 'Open billing' }).getAttribute('href'), '/me?team=t_3&view=settings#billing');
        assert.equal(await dialog(page).locator('input').count(), 0);
        assert.equal(await confirmButton(page).isDisabled(), true);
        const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
        await shot(page, `delete-account-blocked-${where}.png`);
        await dialog(page).getByRole('button', { name: 'Cancel' }).click();
        await dialog(page).waitFor({ state: 'detached' });
        assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
        await context.close();
      });

      await t(`${where}: a refusal from the server (a blocker that appeared since) is shown in place`, async () => {
        const blocker = BLOCKED.blockers[0];
        const { context, page } = await open(width, CLEAR, { status: 409, json: { error: 'blocked', message: blocker.message, blockers: [blocker] } });
        await page.getByRole('button', { name: 'Delete account…' }).click();
        await dialog(page).getByLabel('Type alice to confirm').fill('alice');
        await confirmButton(page).click();
        await dialog(page).getByRole('alert').getByText(/only admin of Acme/).waitFor();
        await dialog(page).getByTestId('delete-account-blockers').waitFor();
        assert.equal(await confirmButton(page).isDisabled(), true);
        assert.match(page.url(), /\/me\?view=settings$/);
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
