// Unread pin semantics. Run: node test/thread-seen.test.js

const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function load() {
  const file = path.join(__dirname, '../shell/src/comments/core/thread-seen.js');
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace(
    "import { readStored, writeStored } from '../../safe-storage.js';",
    `const store = (globalThis.__tdocSeenStore = globalThis.__tdocSeenStore || new Map());
     const readStored = (k, f) => (store.has(k) ? store.get(k) : f);
     const writeStored = (k, v) => { store.set(k, v); return true; };`,
  );
  const url = `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
  return import(url);
}

(async () => {
  globalThis.__tdocSeenStore = new Map();
  const {
    latestAgentActivityAt, isThreadUnread, markThreadSeen, readSeenMap, mergeSeenMap, reconcileSeenMap,
  } = await load();
  let pass = 0;
  const ok = (n) => { console.log(`  ✓ ${n}`); pass += 1; };

  const base = {
    id: 'c1',
    status: 'open',
    deleted: false,
    replies: [
      { author: { kind: 'agent' }, created: '2026-01-01T02:00:00Z', text: 'done' },
    ],
  };

  assert.strictEqual(latestAgentActivityAt(base), Date.parse('2026-01-01T02:00:00Z'));
  ok('latestAgentActivityAt');

  assert.strictEqual(isThreadUnread(base, {}), true);
  ok('unseen agent reply is unread');

  markThreadSeen('doc', base);
  const seen = readSeenMap('doc');
  assert.strictEqual(isThreadUnread(base, seen), false);
  ok('markThreadSeen clears unread');

  const newer = {
    ...base,
    replies: [
      ...base.replies,
      { author: { kind: 'agent' }, created: '2026-01-01T03:00:00Z', text: 'more' },
    ],
  };
  assert.strictEqual(isThreadUnread(newer, seen), true);
  ok('newer agent reply is unread again');

  const ownReply = {
    ...newer,
    replies: [...newer.replies, { author: { kind: 'human', login: 'julie' }, created: '2026-01-01T04:00:00Z', text: 'thanks' }],
  };
  assert.strictEqual(isThreadUnread(ownReply, {}, 'julie'), false);
  assert.strictEqual(isThreadUnread(ownReply, {}, ['new-handle', 'julie']), false);
  assert.strictEqual(isThreadUnread(ownReply, {}, 'bob'), true);
  ok('only the viewer\'s own later reply clears the old unread agent turn');

  assert.strictEqual(isThreadUnread({ ...base, status: 'applied' }, {}), true);
  ok('an unread agent resolution is still an unread reply');
  assert.strictEqual(isThreadUnread({ ...base, status: 'applied', resolved_by: 'julie' }, {}), false);
  ok('a person resolving the thread has seen the reply');

  // Read state at rest writes nothing: a thread no agent spoke in is never marked.
  assert.strictEqual(markThreadSeen('quiet', { id: 'h1', replies: [{ author: { kind: 'human', login: 'julie' }, created: '2026-01-01T02:00:00Z' }] }), false);
  assert.deepStrictEqual(readSeenMap('quiet'), {});
  ok('a human-only thread is never marked (no stamp, no write)');

  // After a POST: unknown threads leave, a lowered stamp is taken only while
  // the cache still holds what was sent, a merely-not-kept id stays.
  globalThis.__tdocSeenStore.set('tdoc.thread-seen.r', JSON.stringify({ gone: 5, ahead: 9000, newer: 700, capped: 40 }));
  const sent = { gone: 5, ahead: 9000, newer: 600, capped: 40 };
  reconcileSeenMap('r', sent, { ahead: 8000, newer: 500 }, ['gone']);
  assert.deepStrictEqual(readSeenMap('r'), { ahead: 8000, newer: 700, capped: 40 });
  ok('reconcile: unknown dropped, clamp only the stamp sent, newer local and capped ids kept');
  const { ahead } = mergeSeenMap('r', { ahead: 8000, newer: 700 });
  assert.deepStrictEqual(ahead, { capped: 40 });
  ok('a capped id is the only thing still ahead of the server');

  // Past the server's cap: kept here, and not sent again until it moves on.
  globalThis.__tdocSeenStore.set('tdoc.thread-seen.cap', JSON.stringify({ old: 10, kept: 20 }));
  reconcileSeenMap('cap', { old: 10, kept: 20 }, { kept: 20 }, [], ['old']);
  assert.deepStrictEqual(readSeenMap('cap'), { old: 10, kept: 20 });
  assert.deepStrictEqual(mergeSeenMap('cap', { kept: 20 }).ahead, {});
  globalThis.__tdocSeenStore.set('tdoc.thread-seen.cap', JSON.stringify({ old: 30, kept: 20 }));
  assert.deepStrictEqual(mergeSeenMap('cap', { kept: 20 }).ahead, { old: 30 });
  ok('a capped mark stays local and is not resent until it moves on');

  console.log(`\n${pass} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
