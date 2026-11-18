// Bell follow-ups on a doc page, against the local server (Julie's calls,
// 2026-11-18): an agent's reply is a bell row wearing the agent's mark,
// grouped per thread ("replied 2 times"); an unread row older than 30 days
// stays in the list but is not tinted and not counted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('bell-followup-ui.test.js');
const shots = process.env.TDOC_UI_SHOTS || '';

const ROOT = path.join(__dirname, 'fixtures/tdocs');
const SLUG = 'sample-doc';
const inboxFile = path.join(ROOT, '.inbox-tester.json');
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const DAY = 24 * 60;
const row = (id, kind, at, extra = {}) => ({
  id, kind, group_key: `${kind}:${id}`, slug: SLUG, version: 1, comment_id: `c_${id}`, thread_id: `c_${id}`,
  thread_at: { [`c_${id}`]: at }, actor: { login: 'claire', name: 'Claire' }, preview: 'words',
  title: 'Sample doc', at, read: false, count: 1, ...extra,
});
const CLAUDE = { kind: 'agent', login: 'claude', name: 'Claude Code', avatar_url: 'https://cdn.simpleicons.org/claude/d97757', provider: 'local', cli: 'claude', owner: { display: 'tester' } };
const items = [
  row('n_agent', 'agent_reply', ago(2), { quiet: true, count: 2, actor: CLAUDE, preview: 'Checked: the launch date moves to Thursday.' }),
  row('n_mention', 'mention', ago(6), { actor: { login: 'bob', name: 'Bob' }, preview: '@tester can you check the launch date?' }),
  row('n_week', 'reply', ago(5 * DAY), { actor: { login: 'serena', name: 'Serena' }, preview: 'Still open from last week.' }),
  // Unread but 40 days old: listed, not tinted, not counted.
  row('n_aged', 'comment', ago(40 * DAY), { actor: { login: 'claire', name: 'Claire' }, preview: 'A question from last month.' }),
];

let server;
(async () => {
  console.log('Bell follow-ups (browser)');
  fs.writeFileSync(inboxFile, JSON.stringify({ items }));
  try {
    server = await resolveTarget({ e2eUser: 'tester' });
    const base = server.url.replace(/\/d\/.*/, '');
    const browser = await chromium.launch({ headless: true });
    try {
      for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
        const page = await browser.newPage({ viewport });
        await page.addInitScript(() => { window.__TDOC_NOTIFY_POLL_MS = 10 * 60 * 1000; });
        await page.goto(`${base}/d/${SLUG}/v/1?shell=1`, { waitUntil: 'networkidle' });
        await page.locator(label === 'phone' ? '#tdoc-more-btn' : '.tdoc-account-trigger').click();
        const item = page.getByRole('menuitem', { name: /^Notifications/ });
        await item.waitFor();
        assert.equal((await item.textContent()).trim(), 'Notifications (3)', 'the 40-day-old row still counts');
        await item.click();
        const rows = page.locator('.tdoc-notif-row');
        await rows.first().waitFor();
        await page.waitForTimeout(150);
        if (shots) {
          fs.mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: path.join(shots, `bell-followup-${label}.png`) });
        }
        assert.equal(await rows.count(), 4, 'the aged row left the list');
        const first = rows.nth(0);
        assert.equal((await first.locator('.tdoc-notif-line').textContent()).trim(), 'Claude Code replied 2 times on Sample doc');
        assert.equal(await first.locator('.tdoc-notif-avatar.is-agent').count(), 1, 'the agent row wears its mark');
        assert.match(await first.getAttribute('class'), /\bunread\b/);
        const last = rows.nth(3);
        assert.match(await last.textContent(), /A question from last month/);
        assert.doesNotMatch(await last.getAttribute('class'), /\bunread\b/, 'the 40-day-old row is tinted unread');
        assert.equal((await page.locator('.tdoc-notif-count').textContent()).trim(), '3 unread');
        console.log(`  ✓ ${label}: an agent reply is a row with its mark; a 40-day-old unread row is listed untinted and not counted`);
        await page.close();
      }
    } finally { await browser.close(); }
  } finally {
    if (server) await server.stop();
    fs.rmSync(inboxFile, { force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
