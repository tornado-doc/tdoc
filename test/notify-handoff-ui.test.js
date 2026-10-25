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

  async function open({ ids, deliver = 'delivered', targets = null, query = '' }) {
    const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let handoffs = [{ handoff_id: 'h1', at: new Date(Date.now() - 20 * 60000).toISOString(), recipient: SMARTER, comment_ids: ['c0'], delivery: { status: 'delivered' } }];
    const posts = [];
    await page.route('**/api/notify/targets*', (r) => r.fulfill({ json: targets || { default: SMARTER, candidates: [DEVIN], fallback: DEVIN, reason: null } }));
    await page.route('**/api/notify/handoffs*', (r) => r.fulfill({ json: { handoffs } }));
    await page.route('**/api/notify/handoff', async (r) => {
      const body = JSON.parse(r.request().postData());
      posts.push(body);
      await new Promise((res) => setTimeout(res, 300));
      if (deliver === 'failed') return r.fulfill({ json: { ok: true, sent: body.comment_ids.length, delivery: { status: 'failed', error: 'request_403' } } });
      handoffs = [{ handoff_id: `h${posts.length + 1}`, at: new Date().toISOString(), recipient: body.recipient, comment_ids: body.comment_ids, delivery: { status: 'delivered' } }, ...handoffs];
      return r.fulfill({ json: { ok: true, sent: body.comment_ids.length, delivery: { status: 'delivered' } } });
    });
    await page.goto(`${base}/?ids=${encodeURIComponent(JSON.stringify(ids))}${query}`);
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
    await t('a stopped agent is flagged in the picker and before sending, and sending still works', async () => {
      const stopped = { ...DEVIN, status: 'stopped' };
      const { page, dialog, primary, posts, pick, shot } = await open({ ids: ['c1'], targets: { default: SMARTER, candidates: [stopped], fallback: stopped, reason: null } });
      assert.equal(await dialog.locator('.tdoc-send-warn').count(), 0, 'a running agent was warned about');
      await page.locator('#tdoc-notify-recipient').click();
      await page.getByRole('option', { name: /tdoc-claw-devin.*stopped in Raft/ }).waitFor();
      await page.getByRole('option', { name: /tdoc-claw-devin/ }).click();
      const warn = dialog.locator('.tdoc-send-warn');
      assert.equal((await warn.textContent()).trim(), "tdoc-claw-devin is stopped in Raft — it won't receive this");
      assert.equal(await primary.isEnabled(), true, 'a stopped agent blocked sending');
      await shot('stopped');
      await primary.click();
      await page.getByText('Sent 1 comment to tdoc-claw-devin ✓').waitFor();
      assert.equal(posts[0].recipient.agent_sub, 'd');
      void pick;
      await page.close();
    });

    await t('"Send to another agent" opens the picker on someone other than the silent agent', async () => {
      const { page, primary } = await open({ ids: ['c1'], query: '&avoid=smarter-tdoc-claw' });
      assert.equal((await primary.textContent()).trim(), 'Send to tdoc-claw-devin');
      await page.close();
    });

    await t('the card line climbs queued → picked up → replied, and a silent one offers Resend / another agent', async () => {
      const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/?view=status`);
      const line = (id) => page.locator(`[data-comment-id="${id}"] .tdoc-handoff-status-text`);
      await line('queued').waitFor();
      assert.equal((await line('queued').textContent()).trim(), 'Delivered');
      assert.equal(await line('queued').getAttribute('title'), 'Delivered to smarter-tdoc-claw · 2 min ago');
      assert.equal((await line('local-queued').textContent()).trim(), 'Sent');
      assert.equal((await line('picked').textContent()).trim(), 'On it');
      assert.equal((await line('stale').textContent()).trim(), 'No response · Resend');
      assert.equal((await line('expired').textContent()).trim(), 'No response · Resend');
      assert.equal((await line('replied').textContent()).trim(), 'Agent replied');
      assert.equal((await line('question').textContent()).trim(), '❓ Asked you');
      assert.equal((await line('partial').textContent()).trim(), '🟡 Partial');
      assert.equal(await page.locator('[data-comment-id="resolved"] .tdoc-handoff-chip').count(), 0, 'resolved comment repeats the agent verdict');
      assert.equal((await page.locator('[data-comment-id="resolved"] .tdoc-resolved-chip').textContent()).trim(), '✅ Done');
      assert.equal(await page.locator('[data-comment-id="human-followup"] .tdoc-handoff-chip').count(), 0, 'human follow-up still shows the old agent question');
      assert.equal((await line('resent-followup').textContent()).trim(), 'Delivered', 'new delivery still shows the old agent question');
      for (const id of ['queued', 'picked', 'replied', 'question']) {
        assert.equal(await page.locator(`[data-comment-id="${id}"] .tdoc-handoff-chip`).count(), 1, `${id} shows more than one status`);
        const style = await line(id).evaluate((el) => ({
          background: getComputedStyle(el).backgroundColor,
          cardBackground: getComputedStyle(el.closest('.tdoc-margin-comment')).backgroundColor,
          height: el.getBoundingClientRect().height,
          padding: getComputedStyle(el).padding,
          lineHeight: getComputedStyle(el).lineHeight,
          display: getComputedStyle(el).display,
          radius: getComputedStyle(el).borderRadius,
        }));
        assert.notEqual(style.background, style.cardBackground, `${id} lost its pill background`);
        assert.equal(style.radius, '999px', `${id} lost its pill shape`);
        assert.ok(style.height <= 22, `${id} status is still tall: ${JSON.stringify(style)}`);
      }
      // Buttons only where there is something to do.
      for (const id of ['queued', 'picked', 'replied']) {
        assert.equal(await page.locator(`[data-comment-id="${id}"] .tdoc-handoff-nudge`).count(), 0, `${id} has actions`);
      }
      const stale = page.locator('[data-comment-id="stale"] .tdoc-handoff-chip-action');
      assert.equal(await stale.textContent(), 'Resend');
      const expired = page.locator('[data-comment-id="expired"] .tdoc-handoff-chip-action');
      assert.equal(await expired.textContent(), 'Resend');
      // Nothing spills out of a narrow card.
      for (const id of ['queued', 'picked', 'stale', 'expired']) {
        const [card, chip] = await Promise.all([
          page.locator(`[data-comment-id="${id}"]`).boundingBox(),
          line(id).boundingBox(),
        ]);
        assert.ok(chip.x + chip.width <= card.x + card.width + 0.5, `${id} line overflows its card`);
      }
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'handoff-status-ladder.png'), clip: { x: 0, y: 0, width: 340, height: 900 } }); }
      if (SHOTS) { await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(SHOTS, 'handoff-status-phone.png'), fullPage: true }); }
      await stale.first().click();
      await page.getByText('Resending…').waitFor();
      await page.waitForFunction(() => document.getElementById('log').textContent === 'resend:stale');
      assert.equal(await stale.count(), 1);
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t('the top plane replaces the banner and opens activity with both comment and agent reply', async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/?view=activity`);
      const plane = page.locator('#tdoc-send-agent-btn');
      await plane.waitFor();
      assert.match(await plane.getAttribute('title'), /to send.*waiting for agent.*new agent replies/);
      assert.equal(await page.locator('.tdoc-handoff-banner').count(), 0);
      assert.equal(await plane.locator('.tdoc-send-agent-badge').count(), 1);
      assert.equal(await plane.locator('.tdoc-send-agent-badge').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(229, 72, 77)');
      assert.equal(await plane.locator('.tdoc-send-agent-badge').textContent(), '4');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'handoff-plane-desktop.png') });
      await plane.click();
      const details = page.getByRole('dialog', { name: 'Agent activity' });
      await details.waitFor();
      await details.getByText('❓ Asked you').waitFor();
      assert.equal(await details.locator('.tdoc-handoff-details-preview').filter({ hasText: 'please fix this' }).count() > 0, true);
      await details.getByRole('button', { name: 'Details' }).first().click();
      assert.equal(await details.locator('.tdoc-handoff-details-history').count(), 1);
      assert.equal(await details.locator('.tdoc-handoff-details-unread-dot').count(), 4);
      assert.equal(await details.getByRole('status', { name: 'New agent reply' }).count(), 4);
      assert.equal(await details.getByText('✅ Done', { exact: true }).count(), 1);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'handoff-plane-details-desktop.png') });
      const readyChecks = details.getByRole('checkbox');
      assert.equal(await readyChecks.count(), 2);
      assert.equal(await readyChecks.first().isChecked(), true);
      await readyChecks.nth(1).uncheck();
      assert.equal(await details.getByRole('button', { name: /Send 1 comment/ }).count(), 1);
      await details.locator('#activity-refresh').click();
      assert.equal(await readyChecks.nth(1).isChecked(), false, 'comment refresh selected a comment the user unchecked');
      assert.equal(await details.getByRole('button', { name: /Send 1 comment/ }).count(), 1);
      await readyChecks.nth(1).check();
      await details.getByRole('button', { name: /Send 2 comments/ }).click();
      assert.equal(await page.locator('#activity-log').textContent(), 'send-ready:human-followup,new-comment');
      await details.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t('the plane shows a red dot for failed delivery and fits a phone', async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/?view=activity&failed=1&unread=0`);
      const plane = page.locator('#tdoc-send-agent-btn');
      await plane.waitFor();
      assert.match(await plane.getAttribute('title'), /1 not delivered/);
      assert.equal(await plane.locator('.tdoc-send-agent-badge').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(22, 82, 240)');
      await plane.click();
      const details = page.getByRole('dialog', { name: 'Agent activity' });
      await details.locator('.tdoc-handoff-details-state.is-failed').waitFor();
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'handoff-plane-details-phone.png') });
      const failedRow = details.locator('.tdoc-handoff-details-row').filter({ hasText: 'Add a conclusion to the report' });
      await failedRow.getByRole('button', { name: 'Details' }).click();
      assert.match(await failedRow.locator('.tdoc-handoff-details-history').textContent(), /Delivery failed: Raft refused/);
      await failedRow.getByRole('button', { name: 'Send to another agent' }).click();
      assert.equal(await page.locator('#activity-log').textContent(), 'elsewhere:failed');
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t('collapsed pins show private corner markers, unread dots and hover focus without breaking clusters', async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${base}/?view=pins&viewer=julie&hover=question`);
      const pin = (id) => page.locator(`.tdoc-pin[data-id="${id}"]`);
      assert.equal(await pin('question').locator('.tdoc-pin-handoff-badge').textContent(), '❓');
      assert.equal(await pin('partial').locator('.tdoc-pin-handoff-badge').textContent(), '🟡');
      assert.equal(await pin('resolved').locator('.tdoc-pin-handoff-badge').textContent(), '✅');
      assert.equal(await pin('failed').locator('.tdoc-pin-handoff-badge').textContent(), '⚠');
      assert.match(await pin('picked').getAttribute('class'), /is-waiting-handoff/);
      assert.equal(await pin('question').locator('.tdoc-pin-unread-dot').count(), 1);
      assert.match(await pin('question').getAttribute('class'), /tdoc-pin-anchor-hover/);
      assert.equal((await page.locator('.tdoc-pin-cluster').textContent()).trim(), '2');
      assert.equal(await page.locator('.tdoc-pin-cluster .tdoc-pin-handoff-badge').count(), 0);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'handoff-pins-desktop.png') });
      await page.goto(`${base}/?view=pins&viewer=other`);
      assert.equal(await page.locator('.tdoc-pin-handoff-badge, .tdoc-pin-unread-dot, .is-waiting-handoff').count(), 0);
      assert.doesNotMatch(await pin('resolved').getAttribute('class'), /tdoc-pin-resolved/);
      await page.goto(`${base}/?view=pins&viewer=owner`);
      assert.equal(await pin('question').locator('.tdoc-pin-handoff-badge').textContent(), '❓');
      await page.close();
    });

    await t('a quiet handoff pin becomes a warning when its response window passes', async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.clock.install({ time: new Date('2026-10-25T09:00:00Z') });
      await page.goto(`${base}/?view=pins&near-stale=1`);
      const pin = page.locator('.tdoc-pin[data-id="near-stale"]');
      await pin.waitFor();
      assert.match(await pin.getAttribute('class'), /is-waiting-handoff/);
      assert.equal(await pin.locator('.tdoc-pin-handoff-badge').count(), 0);
      await page.clock.runFor(30000);
      await pin.locator('.tdoc-pin-handoff-badge.is-warning').waitFor();
      assert.equal(await pin.locator('.tdoc-pin-handoff-badge').textContent(), '⚠');
      await page.close();
    });

    await t('mobile FAB stays an icon with no open comments and offers compose in the empty drawer', async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/?view=mobile-fab&state=active`);
      const fab = page.locator('.tdoc-fab');
      await fab.waitFor();
      assert.equal((await fab.textContent()).trim(), '2');
      assert.equal(await fab.locator('.tdoc-fab-unread-dot').count(), 1);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'handoff-mobile-fab-active.png') });
      await fab.click();
      await page.locator('#tdoc-comment-layer').waitFor();
      await page.goto(`${base}/?view=mobile-fab&state=resolved`);
      await fab.waitFor();
      assert.equal((await fab.textContent()).trim(), '');
      assert.equal(await fab.locator('#tdoc-fab-count').count(), 0);
      assert.equal(await fab.locator('.tdoc-fab-unread-dot').count(), 0);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'handoff-mobile-fab-zero.png') });
      await fab.click();
      await page.locator('#tdoc-comment-layer [data-comment-id="resolved"]').waitFor();
      await page.goto(`${base}/?view=mobile-fab&state=empty`);
      await fab.waitFor();
      assert.equal((await fab.textContent()).trim(), '');
      await fab.click();
      const empty = page.locator('.tdoc-drawer-empty');
      await empty.getByRole('button', { name: 'Leave a comment', exact: true }).waitFor();
      await empty.getByRole('button', { name: 'Ask AI', exact: true }).waitFor();
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'handoff-mobile-drawer-empty.png') });
      await empty.getByRole('button', { name: 'Leave a comment', exact: true }).click();
      await page.locator('.tdoc-popup').getByText('On this document').waitFor();
      await page.locator('.tdoc-popup textarea').fill('Please clarify the pricing');
      await page.locator('.tdoc-popup').getByRole('button', { name: 'Comment', exact: true }).click();
      assert.deepEqual(JSON.parse(await page.locator('#mobile-comment-log').textContent()), { text: 'Please clarify the pricing', anchor: null });
      await fab.click();
      await page.locator('.tdoc-drawer-empty').getByRole('button', { name: 'Ask AI', exact: true }).click();
      await page.locator('.tdoc-popup').getByText('On this document').waitFor();
      assert.match(await page.locator('.tdoc-popup textarea').inputValue(), /tdoc AI/);
      assert.deepEqual(errors, []);
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
