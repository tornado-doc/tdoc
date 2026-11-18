// One read state in a real browser (Julie, 2026-11-16: the bell said 44
// unread, Needs you something else). Opening a thread on the doc page marks
// it seen, its bell row goes read on the server, and the bell on that page
// counts again at once -- not at its next 30-second poll. Reading a row in
// the bell marks its thread seen, so the doc page has nothing unread there.
// Opening the doc alone marks nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('bell-read-unify-ui.test.js');
const shots = process.env.TDOC_UI_SHOTS || '';

const ROOT = path.join(__dirname, 'fixtures/tdocs');
const SLUG = 'hostile-body-css';
const commentsFile = path.join(ROOT, SLUG, 'comments.json');
const inboxFile = path.join(ROOT, '.inbox-tester.json');
const original = fs.readFileSync(commentsFile, 'utf8');
const ANCHOR = { kind: 'text', text: 'An internal link that must navigate the top page', context_before: '', context_after: '' };
// Recent: a row older than 30 days no longer counts as unread.
const created = new Date(Date.now() - 2 * 3600e3).toISOString().replace(/\.\d+Z$/, '.000Z');
const replied = new Date(Date.now() - 2 * 3600e3 + 5 * 60e3).toISOString().replace(/\.\d+Z$/, '.000Z');
const seeded = [
  { id: 'c_bell_open', version: 1, text: 'Is this link right?', author: { kind: 'human', login: 'tester' }, status: 'open', created, anchor: ANCHOR,
    replies: [{ id: 'r_bell_open', text: 'Yes, checked it.', author: { kind: 'human', login: 'claire' }, created: replied }] },
  { id: 'c_bell_click', version: 1, text: 'A second question for the owner', author: { kind: 'human', login: 'claire' }, status: 'open', created, anchor: null, replies: [] },
];
const row = (id, kind, thread, at, extra = {}) => ({ id, kind, group_key: `${kind}:${thread}`, slug: SLUG, version: 1, comment_id: thread, thread_id: thread,
  thread_at: { [thread]: at }, actor: { login: 'claire', name: 'Claire' }, preview: 'words', title: 'Hostile body', at, read: false, count: 1, ...extra });

let server;
(async () => {
  fs.writeFileSync(commentsFile, JSON.stringify([...JSON.parse(original), ...seeded]));
  fs.writeFileSync(inboxFile, JSON.stringify({ items: [
    row('n_reply', 'reply', 'c_bell_open', replied),
    row('n_comment', 'comment', 'c_bell_click', created),
  ] }));
  try {
    server = await resolveTarget({ e2eUser: 'tester' });
    const base = server.url.replace(/\/d\/.*/, '');
    const url = `${base}/d/${SLUG}/v/1?shell=1`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      // The poll never fires during the test: only the seen mark can move the count.
      await page.addInitScript(() => { window.__TDOC_NOTIFY_POLL_MS = 10 * 60 * 1000; });
      await page.goto(url, { waitUntil: 'networkidle' });
      const account = page.locator('.tdoc-account-trigger');
      await account.waitFor();
      const count = async () => {
        await account.click();
        const item = page.getByRole('menuitem', { name: /^Notifications/ });
        await item.waitFor();
        const text = (await item.textContent()).trim();
        await page.keyboard.press('Escape');
        return text;
      };
      assert.equal(await count(), 'Notifications (2)', 'two unread rows to start');
      // Opening the doc marked nothing.
      const before = await (await page.request.get(`${base}/api/comments/seen?slug=${SLUG}`)).json();
      assert.deepEqual(before.seen, {}, 'opening the doc marked a thread seen');

      // See the thread in the doc: its pin opens it.
      await page.locator('.tdoc-pin[data-id="c_bell_open"]').click();
      await page.waitForFunction(() => {
        const seen = JSON.parse(localStorage.getItem('tdoc.thread-seen.hostile-body-css') || '{}');
        return Boolean(seen.c_bell_open);
      });
      // The server took the mark (polled: a page predicate cannot await).
      for (let i = 0; i < 40; i++) {
        const { unread } = await (await page.request.get(`${base}/api/notifications/unread`)).json();
        if (unread === 1) break;
        await page.waitForTimeout(100);
      }
      // The page's own bell, without a poll.
      for (let i = 0; i < 20 && (await count()) !== 'Notifications (1)'; i++) await page.waitForTimeout(150);
      assert.equal(await count(), 'Notifications (1)', 'the bell still counts the thread just read');
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, 'bell-read-unify-desktop.png') });
      }
      console.log('  ✓ seeing a thread in the doc drops the bell count on that page at once');

      // A bell row read marks its thread seen.
      const read = await page.evaluate(async () => (await fetch('/api/notifications/read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['n_comment'] }),
      })).json());
      assert.equal(read.unread, 0);
      const after = await (await page.request.get(`${base}/api/comments/seen?slug=${SLUG}`)).json();
      assert.equal(after.seen.c_bell_click, Date.parse(created), 'the bell read did not mark its thread seen');
      console.log('  ✓ reading a row in the bell marks its thread seen');
      await page.close();
    } finally { await browser.close(); }
  } finally {
    if (server) await server.stop();
    fs.writeFileSync(commentsFile, original);
    fs.rmSync(inboxFile, { force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
