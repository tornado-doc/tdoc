// Unread pin semantics. Run: node test/thread-seen.test.js

const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function load() {
  const file = path.join(__dirname, '../shell/src/document/thread-seen.js');
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace(
    "import { readStored, writeStored } from '../safe-storage.js';",
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
    latestAgentActivityAt, isThreadUnread, markThreadSeen, readSeenMap,
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

  assert.strictEqual(isThreadUnread({ ...base, status: 'applied' }, {}), false);
  ok('applied is never unread');

  console.log(`\n${pass} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
