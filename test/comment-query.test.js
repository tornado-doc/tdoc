// The one comment query every surface uses (shell/src/comments/core/
// comment-query.js): filter (Open by default = not resolved), counts, the
// deleted-thread rule, "waiting on you", search, sort and groupBy.
// Run with: node test/comment-query.test.js

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// No bundler in the offline job: load handoff-state.js as its own data URL
// and point comment-query.js's import at it.
async function load() {
  const dir = path.join(__dirname, '../shell/src/comments/core');
  const url = (src) => `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
  const handoff = url(fs.readFileSync(path.join(dir, 'handoff-state.js'), 'utf8'));
  const container = url(fs.readFileSync(path.join(dir, '../selection/anchors/container.js'), 'utf8'));
  const query = fs.readFileSync(path.join(dir, 'comment-query.js'), 'utf8').replace("'./handoff-state.js'", `'${handoff}'`)
    .replace("'../selection/anchors/container.js'", `'${container}'`);
  return import(url(query));
}

const at = (m) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
const human = (login) => ({ kind: 'human', login, name: login });
const agent = { kind: 'agent', login: 'claude', name: 'Claude' };

(async () => {
  const q = await load();
  let pass = 0;
  const ok = (n) => { console.log(`  ✓ ${n}`); pass += 1; };

  const open = { id: 'a', status: 'open', author: human('julie'), created: at(1), text: 'Fix the header', replies: [] };
  const replied = { id: 'b', status: 'open', author: human('julie'), created: at(2), text: 'why red?', replies: [{ id: 'b1', author: agent, created: at(3), text: 'Brand colour' }] };
  const answeredBack = { id: 'c', status: 'open', author: human('bob'), created: at(4), text: 'typo', replies: [{ id: 'c1', author: agent, created: at(5), text: 'fixed?' }, { id: 'c2', author: human('julie'), created: at(6), text: 'not yet' }] };
  const resolved = { id: 'd', status: 'applied', author: human('julie'), created: at(7), text: 'done', replies: [] };
  const tombstone = { id: 'e', status: 'open', deleted: true, author: human('bob'), created: at(8), text: '', replies: [{ id: 'e1', author: human('ann'), created: at(9), text: 'still here' }] };
  const empty = { id: 'f', status: 'open', deleted: true, author: human('bob'), created: at(10), text: '', replies: [] };
  const all = [open, replied, answeredBack, resolved, tombstone, empty];

  assert.strictEqual(q.DEFAULT_FILTER, 'open');
  assert.deepStrictEqual(q.queryThreads(all).shown.map((c) => c.id), ['a', 'b', 'c', 'e'], 'default is Open = not resolved; resolved hidden');
  ok('default filter is Open: every unresolved thread, resolved ones hidden');

  assert.deepStrictEqual(q.queryThreads(all, { filter: 'replied' }).shown.map((c) => c.id), ['b']);
  assert.deepStrictEqual(q.queryThreads(all, { filter: 'resolved' }).shown.map((c) => c.id), ['d']);
  assert.deepStrictEqual(q.queryThreads(all, { filter: 'all' }).shown.map((c) => c.id), ['a', 'b', 'c', 'd', 'e']);
  ok('Replied = an agent spoke last; Resolved; All');

  assert.strictEqual(q.isListedThread(tombstone), true);
  assert.strictEqual(q.isListedThread(empty), false);
  ok('deleted rule: a tombstone holding replies stays, an empty one goes');

  const counts = q.countThreads(all, ['julie']);
  // a: julie's own word last -> not waiting; b: agent last -> waiting;
  // c: julie answered last -> not; e: ann last -> waiting.
  assert.deepStrictEqual(counts, { open: 4, replied: 1, resolved: 1, all: 5, waitingOnYou: 2 });
  ok('counts: open = not resolved; waiting on you = open and the last word is not yours');

  assert.strictEqual(q.isWaitingOn(open, ['julie']), false);
  assert.strictEqual(q.isWaitingOn(open, ['bob']), true);
  assert.strictEqual(q.isWaitingOn(replied, ['julie']), true);
  assert.strictEqual(q.isWaitingOn(answeredBack, ['JULIE']), false);
  assert.strictEqual(q.isWaitingOn(resolved, ['bob']), false);
  ok('waiting on you per viewer, linked keys case-insensitive');

  assert.deepStrictEqual(q.searchThreads(all, 'brand').map((c) => c.id), ['b']);
  assert.deepStrictEqual(q.searchThreads(all, 'author:bob').map((c) => c.id), ['c', 'e', 'f']);
  assert.deepStrictEqual(q.searchThreads(all, 'agent:@claude').map((c) => c.id), ['b', 'c']);
  assert.deepStrictEqual(q.searchThreads(all, { text: 'typo', author: 'julie' }).map((c) => c.id), ['c']);
  assert.strictEqual(q.searchThreads(all, '').length, all.length);
  ok('search: text, author, @agent');

  const pos = { a: [300, 0], b: [100, 50], c: [100, 10] };
  assert.deepStrictEqual(q.sortThreads([open, replied, answeredBack, resolved], 'position', { positionOf: (c) => pos[c.id] || null }).map((c) => c.id), ['c', 'b', 'a', 'd']);
  assert.deepStrictEqual(q.sortThreads([open, replied, answeredBack], 'newest').map((c) => c.id), ['c', 'b', 'a']);
  assert.deepStrictEqual(q.sortThreads([answeredBack, open, replied], 'oldest').map((c) => c.id), ['a', 'b', 'c']);
  assert.strictEqual(q.normalizeSort('nonsense'), 'position');
  ok('sort: position (top, then left; unplaced last, oldest first), newest, oldest');

  const pages = [
    { id: 'p1', created: at(1), anchor: { kind: 'product', url: 'https://app/x' } },
    { id: 'p2', created: at(2), anchor: { kind: 'product', url: 'https://app/y' } },
    { id: 'p3', created: at(3), anchor: { kind: 'product', url: 'https://app/x' } },
    { id: 'd1', created: at(4), anchor: null },
  ];
  const groups = q.groupBy(pages, q.defaultContainerOf, { first: 'page:https://app/y' });
  assert.deepStrictEqual(groups.map((g) => [g.key, g.items.map((c) => c.id)]), [
    ['page:https://app/y', ['p2']], ['page:https://app/x', ['p1', 'p3']], ['document', ['d1']],
  ]);
  ok('groupBy(container): this page first, then first-seen order');

  const keep = q.queryThreads([resolved], { filter: 'open', keep: (c) => c.id === 'd' }).shown;
  assert.deepStrictEqual(keep.map((c) => c.id), ['d']);
  ok('keep holds a card someone is typing in');

  assert.deepStrictEqual(q.filterOptions(counts).map((o) => o.label), ['Open (4)', 'Replied (1)', 'Resolved (1)', 'All (5)']);
  ok('filter labels carry counts');

  console.log(`\n${pass} passed`);
})().catch((error) => { console.error(error); process.exit(1); });
