// The Send to agent dialog in a real browser (the document page and the
// feedback overlay render this same NotifyHandoffPanel). Julie, 2026-10-06:
// with 0 new comments Send looked clickable and did nothing; a send gave no
// sign it happened. This locks: no dead button, "send them to X instead" when
// the last batch went to someone else, Sending… then a named result, a
// failure that says why and offers Retry, and AppSelect for the recipient.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('notify-handoff-ui.test.js');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_UI_SHOTS || '';

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-nh-ui-'));
  const config = path.join(ROOT, `.vite-nh-ui-${process.pid}.config.mjs`);
  fs.writeFileSync(config, `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], logLevel: 'error', build: { outDir: ${JSON.stringify(out)}, emptyOutDir: true,
  rollupOptions: { input: ${JSON.stringify(path.join(__dirname, 'fixtures/ui-harness/notify-handoff.jsx'))}, output: { entryFileNames: 'h.js', assetFileNames: 'h[extname]' } } } });\n`);
  try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', config], { cwd: ROOT, stdio: 'pipe' }); }
  finally { fs.rmSync(config, { force: true }); }
  return out;
}

const agent = (sub, name, source) => ({ provider: 'raft', server_id: 'S1', server_slug: 'julie', agent_sub: sub, agent_name: name, source });
const SMARTER = agent('s', 'smarter-tdoc-claw', 'doc');
const DEVIN = agent('d', 'tdoc-claw-devin', 'account');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

(async () => {
  console.log('Send to agent dialog UI');
  const out = build();
  const page404 = '<!doctype html><html><head><link rel="stylesheet" href="/h.css"></head><body><div id="root"></div><script type="module" src="/h.js"></script></body></html>';
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/h.js' || u === '/h.css') {
      res.setHeader('content-type', u.endsWith('.js') ? 'text/javascript' : 'text/css');
      return res.end(fs.readFileSync(path.join(out, u.slice(1))));
    }
    res.setHeader('content-type', 'text/html');
    res.end(page404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });

  async function open({ ids, deliver = 'delivered' }) {
    const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let handoffs = [{ handoff_id: 'h1', at: new Date(Date.now() - 20 * 60000).toISOString(), recipient: SMARTER, comment_ids: ['c0'], delivery: { status: 'delivered' } }];
    const posts = [];
    await page.route('**/api/notify/targets*', (r) => r.fulfill({ json: { default: SMARTER, candidates: [DEVIN], fallback: DEVIN, reason: null } }));
    await page.route('**/api/notify/handoffs*', (r) => r.fulfill({ json: { handoffs } }));
    await page.route('**/api/notify/handoff', async (r) => {
      const body = JSON.parse(r.request().postData());
      posts.push(body);
      await new Promise((res) => setTimeout(res, 300));
      if (deliver === 'failed') return r.fulfill({ json: { ok: true, sent: body.comment_ids.length, delivery: { status: 'failed', error: 'request_403' } } });
      handoffs = [{ handoff_id: `h${posts.length + 1}`, at: new Date().toISOString(), recipient: body.recipient, comment_ids: body.comment_ids, delivery: { status: 'delivered' } }, ...handoffs];
      return r.fulfill({ json: { ok: true, sent: body.comment_ids.length, delivery: { status: 'delivered' } } });
    });
    await page.goto(`${base}/?ids=${encodeURIComponent(JSON.stringify(ids))}`);
    const dialog = page.getByRole('dialog', { name: 'Send to agent' });
    await dialog.waitFor();
    await page.locator('#tdoc-notify-recipient').waitFor();
    await page.waitForFunction(() => /went to|for your agent/.test(document.querySelector('.ui-dialog-description')?.textContent || ''));
    const pick = async (name) => {
      await page.locator('#tdoc-notify-recipient').click();
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'send-to-agent-open.png') }); }
      await page.getByRole('option', { name: new RegExp(name) }).click();
    };
    const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `send-to-agent-${name}.png`) }); } };
    return { page, dialog, errors, posts, pick, shot, primary: dialog.locator('.actions .primary') };
  }

  try {
    await t('0 new comments, last batch to the same agent: no dead Send button, it says where they went', async () => {
      const { page, dialog, primary, errors, shot } = await open({ ids: [] });
      assert.match(await dialog.locator('.ui-dialog-description').textContent(), /No new comments\. The last one went to smarter-tdoc-claw 20 min ago\./);
      assert.equal(await primary.count(), 0, 'a primary button that can do nothing is back');
      assert.equal(await page.locator('select').count(), 0, 'native <select> in the dialog');
      await shot('nothing-new');
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t('0 new comments, another agent picked: "Send it to X instead" hands the last batch over, with feedback', async () => {
      const { page, dialog, primary, posts, pick, shot } = await open({ ids: [] });
      await pick('tdoc-claw-devin');
      assert.equal((await primary.textContent()).trim(), 'Send it to tdoc-claw-devin');
      await shot('reassign');
      await primary.click();
      await page.getByText('Sending to tdoc-claw-devin…').waitFor();
      await page.getByText('Sent 1 comment to tdoc-claw-devin ✓').waitFor();
      assert.deepEqual(posts[0].comment_ids, ['c0']);
      assert.equal(posts[0].recipient.agent_sub, 'd');
      assert.equal(await primary.count(), 0, 'after handing it over there is nothing left to send');
      assert.match(await dialog.locator('.ui-dialog-description').textContent(), /went to tdoc-claw-devin just now/);
      await shot('reassigned');
      await page.close();
    });

    await t('a failed send says who and why, in the error colour, and the button becomes Retry', async () => {
      const { page, dialog, primary, posts, pick, shot } = await open({ ids: ['c1', 'c2'], deliver: 'failed' });
      await pick('tdoc-claw-devin');
      assert.equal((await primary.textContent()).trim(), 'Send to tdoc-claw-devin');
      await primary.click();
      const status = dialog.locator('.tdoc-send-result');
      await page.getByText(/Not delivered to tdoc-claw-devin: Raft refused/).waitFor();
      assert.match(await status.getAttribute('class'), /tdoc-notify-error/);
      const color = await status.evaluate((el) => getComputedStyle(el).color);
      assert.notEqual(color, 'rgb(136, 136, 136)', 'failure is in the muted grey of a hint');
      assert.equal((await primary.textContent()).trim(), 'Retry');
      await shot('failed');
      await primary.click();
      await page.getByText(/Not delivered to tdoc-claw-devin/).waitFor();
      assert.equal(posts.length, 2, 'Retry did not send again');
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
