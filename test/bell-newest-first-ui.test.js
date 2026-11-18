// The bell lists what happened newest first (Julie, 2026-11-18: "everything
// in Notifications is so old"). Since the bell and the doc page share one
// read state (#1060), a comment read on the doc page is read in the bell
// too -- and the bell used to list every unread row before every read one,
// so a backlog of old unread rows (44 for Julie) filled its first page and
// today's activity sat below them, behind Load more. Locks, in a real
// browser against the local server: the newest row is the first row whether
// or not it was read already; old unread rows follow in time order and keep
// their unread mark; the count is still the unread rows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('bell-newest-first-ui.test.js');
const shots = process.env.TDOC_UI_SHOTS || '';

const ROOT = path.join(__dirname, 'fixtures/tdocs');
const SLUG = 'sample-doc';
const inboxFile = path.join(ROOT, '.inbox-tester.json');
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const DAY = 24 * 60;
const KINDS = ['comment', 'reply', 'mention'];
const PEOPLE = [['claire', 'Claire'], ['serena', 'Serena'], ['bob', 'Bob']];
const row = (id, kind, at, extra = {}) => ({
  id, kind, group_key: `${kind}:${id}`, slug: SLUG, version: 1, comment_id: `c_${id}`, thread_id: `c_${id}`,
  thread_at: { [`c_${id}`]: at }, actor: { login: 'claire', name: 'Claire' }, preview: 'An old question nobody opened again.',
  title: 'Sample doc', at, read: false, count: 1, ...extra,
});

// 24 unread rows from two to three weeks ago (more than a page), and today's
// activity: a reply already read on the doc page, and a new mention.
const old = Array.from({ length: 24 }, (_, n) => {
  const [login, name] = PEOPLE[n % PEOPLE.length];
  return row(`n_old_${n}`, KINDS[n % KINDS.length], ago(14 * DAY + n * 60 * 7), { actor: { login, name } });
});
const fresh = [
  row('n_new_reply', 'reply', ago(3), { read: true, actor: { login: 'serena', name: 'Serena' }, preview: 'Done, the table is updated.' }),
  row('n_new_mention', 'mention', ago(9), { actor: { login: 'bob', name: 'Bob' }, preview: '@tester can you check the launch date?' }),
];

let server;
(async () => {
  console.log('Bell newest first (browser)');
  fs.writeFileSync(inboxFile, JSON.stringify({ items: [...fresh, ...old] }));
  try {
    server = await resolveTarget({ e2eUser: 'tester' });
    const base = server.url.replace(/\/d\/.*/, '');
    const browser = await chromium.launch({ headless: true });
    try {
      for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
        const page = await browser.newPage({ viewport });
        await page.addInitScript(() => { window.__TDOC_NOTIFY_POLL_MS = 10 * 60 * 1000; });
        await page.goto(`${base}/d/${SLUG}/v/1?shell=1`, { waitUntil: 'networkidle' });
        // Desktop: the account menu; phone: the More menu carries the bell.
        await page.locator(label === 'phone' ? '#tdoc-more-btn' : '.tdoc-account-trigger').click();
        const item = page.getByRole('menuitem', { name: /^Notifications/ });
        await item.waitFor();
        assert.equal((await item.textContent()).trim(), 'Notifications (25)', 'the count is the unread rows');
        await item.click();
        const rows = page.locator('.tdoc-notif-row');
        await rows.first().waitFor();
        if (shots) {
          fs.mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: path.join(shots, `bell-newest-first-${label}.png`) });
        }
        const first = rows.nth(0);
        assert.match(await first.textContent(), /Serena/, 'the newest row (read on the doc page) is not first');
        assert.ok(!(await first.getAttribute('class')).includes('unread'), 'a read row is drawn unread');
        const second = rows.nth(1);
        assert.match(await second.textContent(), /Bob.*mentioned/s, 'the new mention is not second');
        assert.ok((await second.getAttribute('class')).includes('unread'), 'the new mention lost its unread mark');
        // The old backlog follows, newest first, still unread.
        const times = await rows.evaluateAll((els) => els.map((el) => el.querySelector('.tdoc-notif-time')?.textContent || ''));
        assert.deepEqual(times.slice(0, 2), ['3m', '9m']);
        assert.equal(times[2], '14d');
        assert.ok((await rows.nth(2).getAttribute('class')).includes('unread'));
        console.log(`  ✓ ${label}: today's activity is at the top of the bell, read or not`);
        await page.close();
      }
    } finally { await browser.close(); }
  } finally {
    if (server) await server.stop();
    fs.rmSync(inboxFile, { force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
