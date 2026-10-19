// The Notifications dialog in a real browser (Julie, 2026-10-14: tagged and
// never told; the modal had no spacing and made little sense). Locks: rows
// say who did what on which doc with the comment's words, unread is marked,
// Mark all read clears it, and the opt-in browser switch asks permission only
// when turned on and then raises one desktop alert per new notification.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('notifications-ui.test.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-notif-ui-'));
  const config = path.join(ROOT, `.vite-notif-ui-${process.pid}.config.mjs`);
  fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/notifications.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
  try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', config], { cwd: ROOT, stdio: 'pipe' }); }
  finally { fs.rmSync(config, { force: true }); }
  return out;
}

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const row = (id, kind, min, extra = {}) => ({ id, kind, slug: 'q3-plan', version: 2, comment_id: `c_${id}`, title: 'Q3 plan', actor: { login: 'claire', name: 'Claire' }, preview: 'Can we move the launch to Thursday? Marketing needs one more day for the assets.', at: ago(min), read: false, count: 1, ...extra });

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

(async () => {
  console.log('Notifications dialog UI');
  const out = build();
  const html = '<!doctype html><html><head><link rel="stylesheet" href="/h.css"></head><body><div id="root"></div><script type="module" src="/h.js"></script></body></html>';
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/h.js' || u === '/h.css') {
      res.setHeader('content-type', u.endsWith('.js') ? 'text/javascript' : 'text/css');
      return res.end(fs.readFileSync(path.join(out, u.slice(1))));
    }
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });

  async function open(width = 900, extra = [], notificationPermission = 'granted', requestResult = 'granted') {
    const context = await browser.newContext({ viewport: { width, height: 760 } });
    if (notificationPermission === 'granted') await context.grantPermissions(['notifications'], { origin: base });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Record desktop alerts instead of raising real ones.
    await page.addInitScript(({ permission, requested }) => {
      window.__TDOC_NOTIFY_POLL_MS = 300;
      window.__alerts = [];
      class FakeNotification {
        constructor(title, opts) { window.__alerts.push({ title, body: opts && opts.body }); }
        close() {}
      }
      FakeNotification.permission = permission;
      FakeNotification.requestPermission = async () => {
        FakeNotification.permission = requested;
        return requested;
      };
      window.Notification = FakeNotification;
    }, { permission: notificationPermission, requested: requestResult });
    const state = {
      items: [row('n1', 'mention', 3), row('n2', 'reply', 50, { actor: { login: 'serena', name: 'Serena' }, preview: 'Done, updated the table.' }), row('n3', 'comment', 60 * 26, { read: true, count: 3, actor: { login: 'bob', name: 'Bob' }, preview: 'Typo in the second section.' })],
      posts: [],
    };
    state.items = [...extra, ...state.items];
    const unread = () => state.items.filter((i) => !i.read).length;
    await page.route('**/api/notifications/unread', (r) => r.fulfill({ json: { unread: unread() } }));
    await page.route('**/api/notifications/read', (r) => {
      const body = JSON.parse(r.request().postData());
      state.posts.push(body);
      state.items = state.items.map((i) => (body.all || (body.ids || []).includes(i.id) ? { ...i, read: true } : i));
      return r.fulfill({ json: { ok: true, unread: unread() } });
    });
    state.email = { available: true, on: true };
    await page.route('**/api/notifications/email', (r) => {
      if (r.request().method() === 'POST') {
        const body = JSON.parse(r.request().postData());
        state.posts.push({ email: body });
        state.email = { ...state.email, on: body.on };
      }
      return r.fulfill({ json: state.email });
    });
    await page.route('**/api/notifications?*', (r) => r.fulfill({ json: { items: state.items, unread: unread(), has_more: false } }));
    await page.route('**/api/doc/access-request', (r) => {
      const body = JSON.parse(r.request().postData());
      state.posts.push(body);
      return r.fulfill({ json: { ok: true, resolved: body.action === 'approve' ? 'approved' : 'ignored' } });
    });
    await page.goto(`${base}${notificationPermission === 'default' ? '/?prompt=1' : ''}`);
    const dialog = page.getByRole('dialog', { name: 'Notifications' });
    if (notificationPermission !== 'default') {
      await dialog.waitFor();
      await dialog.locator('.tdoc-notif-row').first().waitFor();
    }
    return { context, page, dialog, state, errors };
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `notifications-${name}.png`) }); } };

  try {
    await t('rows say who, what, which doc and the comment itself; unread is marked', async () => {
      const { context, page, dialog, errors } = await open();
      const rows = dialog.locator('.tdoc-notif-row');
      assert.equal(await rows.count(), 3);
      assert.equal((await rows.nth(0).locator('.tdoc-notif-line').textContent()).trim(), 'Claire mentioned you on Q3 plan');
      assert.match(await rows.nth(0).locator('.tdoc-notif-preview').textContent(), /move the launch to Thursday/);
      assert.match(await rows.nth(0).getAttribute('class'), /\bunread\b/);
      assert.doesNotMatch(await rows.nth(2).getAttribute('class'), /\bunread\b/);
      assert.equal((await rows.nth(2).locator('.tdoc-notif-line').textContent()).trim(), 'Bob commented and 2 more commented on Q3 plan');
      assert.equal((await dialog.locator('.tdoc-notif-count').textContent()).trim(), '2 unread');
      const pad = await rows.nth(0).locator('.tdoc-notif-open').evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
      assert.ok(pad >= 8, `rows are cramped (${pad}px padding)`);
      await shot(page, 'desktop');
      assert.deepEqual(errors, []);
      await context.close();
    });

    await t('Mark all read clears every unread row in one request', async () => {
      const { context, dialog, state } = await open();
      await dialog.getByRole('button', { name: 'Mark all read' }).click();
      await dialog.getByText('All caught up').waitFor();
      assert.deepEqual(state.posts.at(-1), { all: true });
      assert.equal(await dialog.locator('.tdoc-notif-row.unread').count(), 0);
      await context.close();
    });

    await t('a document with unread activity soft-asks before Chrome and sends a proof alert after approval', async () => {
      const { context, page } = await open(900, [], 'default', 'granted');
      await page.waitForFunction(() => window.__notifications?.unread > 0);
      const promptState = await page.evaluate(() => ({ permission: Notification.permission, prompt: window.__notifications.browserPrompt, unread: window.__notifications.unread }));
      assert.equal(promptState.prompt, true, JSON.stringify(promptState));
      const prompt = page.getByRole('dialog', { name: 'Turn on browser notifications' });
      await prompt.getByText('Don’t miss replies').waitFor();
      await shot(page, 'prompt-desktop');
      assert.equal(await page.evaluate(() => Notification.permission), 'default');
      await prompt.getByRole('button', { name: 'Turn on' }).click();
      await prompt.getByText('Test alert sent').waitFor();
      await shot(page, 'prompt-approved');
      const alerts = await page.evaluate(() => window.__alerts);
      assert.equal(alerts.length, 1, JSON.stringify(alerts));
      assert.equal(alerts[0].title, 'Browser notifications are on');
      assert.equal(await page.evaluate(() => localStorage.getItem('tdoc.browserNotify')), '1');
      await context.close();
    });

    await t('Not now and a dismissed Chrome prompt both silence the soft ask for seven days', async () => {
      const first = await open(900, [], 'default', 'granted');
      const firstPrompt = first.page.getByRole('dialog', { name: 'Turn on browser notifications' });
      await firstPrompt.getByRole('button', { name: 'Not now' }).click();
      const firstUntil = await first.page.evaluate(() => Number(localStorage.getItem('tdoc.browserNotify.snoozeUntil')));
      assert.ok(firstUntil > Date.now() + 6.9 * 24 * 60 * 60 * 1000, String(firstUntil));
      await first.page.reload();
      assert.equal(await first.page.getByRole('dialog', { name: 'Turn on browser notifications' }).count(), 0);
      await first.context.close();

      const second = await open(900, [], 'default', 'default');
      const secondPrompt = second.page.getByRole('dialog', { name: 'Turn on browser notifications' });
      await secondPrompt.getByRole('button', { name: 'Turn on' }).click();
      await secondPrompt.getByText('Notifications weren’t enabled').waitFor();
      const secondUntil = await second.page.evaluate(() => Number(localStorage.getItem('tdoc.browserNotify.snoozeUntil')));
      assert.ok(secondUntil > Date.now() + 6.9 * 24 * 60 * 60 * 1000, String(secondUntil));
      await second.context.close();
    });

    await t('the phone soft ask fits the viewport and keeps 44px actions', async () => {
      const { context, page } = await open(390, [], 'default', 'granted');
      const prompt = page.getByRole('dialog', { name: 'Turn on browser notifications' });
      await prompt.waitFor();
      const layout = await prompt.evaluate((element) => ({
        right: element.getBoundingClientRect().right,
        width: element.getBoundingClientRect().width,
        viewport: innerWidth,
        actions: [...element.querySelectorAll('button')].map((button) => button.getBoundingClientRect().height),
      }));
      assert.ok(layout.right <= layout.viewport + 1 && layout.width <= layout.viewport - 24 + 1, JSON.stringify(layout));
      assert.ok(layout.actions.every((height) => height >= 44), JSON.stringify(layout.actions));
      await shot(page, 'prompt-phone');
      await context.close();
    });

    await t('the browser switch starts off, and once on, a new notification raises one desktop alert', async () => {
      const { context, page, dialog, state } = await open();
      const sw = dialog.getByRole('switch', { name: 'Browser notifications' });
      assert.equal(await sw.getAttribute('aria-checked'), 'false');
      assert.equal(await page.evaluate(() => window.__alerts.length), 0, 'alerted before being turned on');
      await sw.click();
      await page.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true');
      assert.equal(await page.evaluate(() => window.__alerts.length), 1, 'approval did not send the proof alert');
      state.items = [row('n4', 'mention', 0, { actor: { login: 'claire', name: 'Claire' }, preview: 'Please check the numbers' }), ...state.items];
      await page.waitForFunction(() => window.__alerts.length > 1, null, { timeout: 5_000 });
      const alerts = await page.evaluate(() => window.__alerts);
      assert.equal(alerts.length, 2, JSON.stringify(alerts));
      assert.equal(alerts[1].title, 'Claire mentioned you on Q3 plan');
      assert.equal(alerts[1].body, 'Please check the numbers');
      await context.close();
    });

    await t('the email switch starts on and turning it off tells the server', async () => {
      const { context, dialog, state } = await open();
      const email = dialog.getByRole('switch', { name: 'Email notifications' });
      await email.waitFor();
      assert.equal(await email.getAttribute('aria-checked'), 'true');
      await email.click();
      for (let i = 0; i < 50 && await email.getAttribute('aria-checked') !== 'false'; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(await email.getAttribute('aria-checked'), 'false');
      assert.deepEqual(state.posts.filter((p) => p.email), [{ email: { on: false } }]);
      await context.close();
    });

    // A thread's unread replies share one row and one id: a second reply
    // bumps count/at. It must alert again (review on #746).
    await t('a second reply folded into an unread row alerts again', async () => {
      const { context, page, dialog, state } = await open();
      await dialog.getByRole('switch', { name: 'Browser notifications' }).click();
      await page.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true');
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => window.__alerts.length), 1);
      state.items = state.items.map((i) => (i.id === 'n2' ? { ...i, count: 2, at: new Date().toISOString(), preview: 'One more thing on the table' } : i));
      await page.waitForFunction(() => window.__alerts.length > 1, null, { timeout: 5_000 });
      const alerts = await page.evaluate(() => window.__alerts);
      assert.equal(alerts.length, 2, JSON.stringify(alerts));
      assert.equal(alerts[1].body, 'One more thing on the table');
      await context.close();
    });

    // One read and one new: the unread total does not change, and the new one
    // must still alert.
    await t('a new notification arriving as another is read still alerts', async () => {
      const { context, page, dialog, state } = await open();
      await dialog.getByRole('switch', { name: 'Browser notifications' }).click();
      await page.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true');
      await page.waitForTimeout(800);
      state.items = [row('n5', 'comment', 0, { actor: { login: 'dan', name: 'Dan' }, preview: 'Looks good' }), ...state.items.map((i) => (i.id === 'n1' ? { ...i, read: true } : i))];
      await page.waitForFunction(() => window.__alerts.length > 1, null, { timeout: 5_000 });
      const alerts = await page.evaluate(() => window.__alerts);
      assert.equal(alerts.length, 2, JSON.stringify(alerts));
      assert.equal(alerts[1].title, 'Dan commented on Q3 plan');
      await context.close();
    });

    await t('an access request is answered on the notification: Approve closes it and says so', async () => {
      const request = row('n6', 'access_request', 1, { actor: { login: 'claire', name: 'Claire' }, requester: 'claire', preview: '', comment_id: undefined });
      const { context, page, dialog, state } = await open(900, [request]);
      const first = dialog.locator('.tdoc-notif-row').first();
      assert.equal((await first.locator('.tdoc-notif-line').textContent()).trim(), 'Claire asked for access to Q3 plan');
      await shot(page, 'access-request');
      await first.getByRole('button', { name: 'Approve', exact: true }).click();
      await first.getByText('Approved. Claire can open it now.').waitFor();
      assert.deepEqual(state.posts.at(-1), { slug: 'q3-plan', requester: 'claire', action: 'approve' });
      assert.equal(await first.getByRole('button', { name: 'Approve', exact: true }).count(), 0, 'Approve is still offered after approving');
      assert.doesNotMatch(await first.getAttribute('class'), /\bunread\b/);
      await context.close();
    });

    await t('phone width: rows stay readable, nothing overflows sideways', async () => {
      const { context, page, dialog } = await open(390);
      const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
      assert.ok(overflow <= 1, `dialog scrolls sideways by ${overflow}px`);
      await shot(page, 'phone');
      await context.close();
    });
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
