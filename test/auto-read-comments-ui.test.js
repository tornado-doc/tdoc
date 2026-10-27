// Real document shell: seeing a reply clears its unread state after a full
// second; the list action clears the rest without visiting every card.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveTarget, requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium, webkit } = requirePlaywrightOrSkip('auto-read-comments-ui.test.js');
const shots = process.env.TDOC_UI_SHOTS || '';

const commentsFile = path.join(__dirname, 'fixtures/tdocs/hostile-body-css/comments.json');
const original = fs.readFileSync(commentsFile, 'utf8');
const when = '2026-08-22T00:01:00Z';
const docComment = (id, text, agent = false) => ({
  id, version: 1, text, author: { kind: 'human', login: 'tester' }, status: 'open',
  created: '2026-08-22T00:00:00Z', anchor: null,
  replies: agent ? [{ id: `r_${id}`, text: `Agent answer to ${text}`,
    author: { kind: 'agent', login: 'tdoc-ai' }, created: when }] : [],
});
const seeded = [
  docComment('c_seen_first', 'First reply to read', true),
  ...Array.from({ length: 8 }, (_, index) => docComment(`c_spacer_${index}`, `A separate comment ${index} with enough content to keep later replies below the fold.`)),
  docComment('c_seen_second', 'Second reply to read', true),
  ...Array.from({ length: 8 }, (_, index) => docComment(`c_more_${index}`, `Another separate comment ${index} with enough content to keep the last reply below the fold.`)),
  docComment('c_seen_last', 'Last reply to read', true),
  { ...docComment('c_seen_pin', 'An anchored reply to read', true),
    anchor: { kind: 'text', text: 'An internal link that must navigate the top page', context_before: '', context_after: '' } },
];

let server;
(async () => {
  fs.writeFileSync(commentsFile, JSON.stringify([...JSON.parse(original), ...seeded]));
  try {
    server = await resolveTarget({ e2eUser: 'tester' });
    const url = `${server.url.replace(/\/d\/.*/, '')}/d/hostile-body-css/v/1?shell=1`;
    for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        await page.addInitScript(() => { window.__TDOC_FLAGS__ = { autoReadComments: true }; });
        await page.goto(url, { waitUntil: 'networkidle' });
        const fab = page.locator('.tdoc-fab');
        await fab.waitFor();
        assert.equal(await fab.locator('.tdoc-fab-unread-dot').count(), 1, `${name}: no initial unread dot`);
        await fab.click();
        const drawer = page.locator('#tdoc-comment-layer');
        const first = drawer.locator('[data-comment-id="c_seen_first"]');
        const second = drawer.locator('[data-comment-id="c_seen_second"]');
        const last = drawer.locator('[data-comment-id="c_seen_last"]');
        await first.waitFor();
        if (shots) {
          fs.mkdirSync(shots, { recursive: true });
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(shots, `auto-read-phone-${name}.png`) });
        }
        assert.equal(await drawer.getByRole('button', { name: 'Mark all as read' }).count(), 1, `${name}: no list-wide read action`);
        assert.equal(await first.getByRole('button', { name: 'Mark as read' }).count(), 0, `${name}: per-card Read is still required`);
        await page.waitForTimeout(300);
        assert.equal(await first.locator('.tdoc-thread-unread-dot').count(), 1, `${name}: marked before a second in view`);
        await first.locator('.tdoc-thread-unread-dot').waitFor({ state: 'detached', timeout: 5000 });
        assert.equal(await second.locator('.tdoc-thread-unread-dot').count(), 1, `${name}: offscreen reply was marked read`);
        await second.scrollIntoViewIfNeeded();
        await second.locator('.tdoc-thread-unread-dot').waitFor({ state: 'detached', timeout: 5000 });
        assert.equal(await last.locator('.tdoc-thread-unread-dot').count(), 1, `${name}: last offscreen reply was marked read`);
        await drawer.getByRole('button', { name: 'Mark all as read' }).click();
        await fab.locator('.tdoc-fab-unread-dot').waitFor({ state: 'detached', timeout: 5000 });
        assert.equal(await last.locator('.tdoc-thread-unread-dot').count(), 0, `${name}: Mark all left a reply unread`);
        console.log(`  ✓ ${name}: visible replies auto-read; list action clears FAB dot`);
        await page.close();

        const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await desktop.addInitScript(() => { window.__TDOC_FLAGS__ = { autoReadComments: true }; });
        await desktop.goto(url, { waitUntil: 'networkidle' });
        const dock = desktop.locator('.tdoc-comment-filter-dock');
        await dock.getByRole('button', { name: 'Mark all as read' }).waitFor();
        if (shots) await desktop.screenshot({ path: path.join(shots, `auto-read-desktop-${name}.png`) });
        await desktop.locator('.tdoc-pin-document').click();
        await desktop.waitForFunction(() => {
          const seen = JSON.parse(localStorage.getItem('tdoc.thread-seen.hostile-body-css') || '{}');
          return ['c_seen_first', 'c_seen_second', 'c_seen_last'].every((id) => seen[id]);
        });
        assert.equal(await dock.getByRole('button', { name: 'Mark all as read' }).count(), 1,
          `${name}: opening a cluster also read an unopened pin`);
        await desktop.locator('.tdoc-pin[data-id="c_seen_pin"]').click();
        await desktop.waitForFunction(() => {
          const seen = JSON.parse(localStorage.getItem('tdoc.thread-seen.hostile-body-css') || '{}');
          return Boolean(seen.c_seen_pin);
        });
        assert.equal(await dock.getByRole('button', { name: 'Mark all as read' }).count(), 0,
          `${name}: opening a desktop pin left its reply unread`);
        console.log(`  ✓ ${name}: opening a desktop cluster and pin reads their replies`);
        await desktop.close();
      } finally { await browser.close(); }
    }
  } finally {
    if (server) await server.stop();
    fs.writeFileSync(commentsFile, original);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
