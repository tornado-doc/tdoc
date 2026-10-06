// Pure handoff-surface classifier. Run: node test/handoff-state.test.js

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Load the ESM module via dynamic import from a tiny loader.
async function load() {
  const file = path.join(__dirname, '../shell/src/document/handoff-state.js');
  // Node can import .js ESM if package says type module; tdoc root is CJS.
  // Read + eval as ESM through data URL.
  const src = fs.readFileSync(file, 'utf8');
  const url = `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
  return import(url);
}

function comment(partial) {
  return {
    id: 'c1',
    deleted: false,
    status: 'open',
    handoff_status: 'note',
    handoff_at: null,
    handoff_delivery: null,
    author: { kind: 'human', login: 'julie' },
    created: '2026-01-01T00:00:00Z',
    text: 'please fix this',
    replies: [],
    ...partial,
  };
}

(async () => {
  const {
    handoffSurfaceState,
    summarizeHandoffSurfaces,
    shortCommentPreview,
    lastHumanAt,
  } = await load();
  let pass = 0;
  const ok = (n) => { console.log(`  ✓ ${n}`); pass += 1; };

  assert.strictEqual(handoffSurfaceState(comment()), 'ready');
  ok('untouched comment is ready');

  assert.strictEqual(handoffSurfaceState(comment({
    handoff_status: 'sent',
    handoff_at: '2026-01-01T01:00:00Z',
    handoff_delivery: { status: 'failed', error: 'x' },
  })), 'failed');
  ok('failed delivery is failed');

  assert.strictEqual(handoffSurfaceState(comment({
    handoff_status: 'sent',
    handoff_at: '2026-01-01T01:00:00Z',
    handoff_delivery: { status: 'delivered' },
  })), 'waiting');
  ok('delivered with no reply is waiting');

  assert.strictEqual(handoffSurfaceState(comment({
    handoff_status: 'sent',
    handoff_at: '2026-01-01T01:00:00Z',
    handoff_acked_at: '2026-01-01T01:05:00Z',
    handoff_delivery: { status: 'delivered' },
  })), 'received');
  ok('acked without reply is received');

  assert.strictEqual(handoffSurfaceState(comment({
    handoff_status: 'sent',
    handoff_at: '2026-01-01T01:00:00Z',
    handoff_delivery: { status: 'delivered' },
    replies: [{ author: { kind: 'agent', login: 'bot' }, created: '2026-01-01T02:00:00Z', text: 'done' }],
  })), 'replied');
  ok('agent reply after handoff is replied');

  const olderVersion = comment({
    handoff_status: 'sent', handoff_at: '2026-01-01T01:00:00Z',
    handoff_acked_at: '2026-01-01T01:05:00Z',
    thread_activity: { agent_at: '2026-01-01T02:00:00Z', human_at: '2026-01-01T00:00:00Z' },
    replies: [],
  });
  assert.strictEqual(handoffSurfaceState(olderVersion), 'replied');
  assert.strictEqual(handoffSurfaceState({ ...olderVersion, thread_activity: {
    ...olderVersion.thread_activity, human_at: '2026-01-01T03:00:00Z',
  } }), 'ready');
  ok('a later-version reply stops an older version waiting; a later human turn stays independent');

  assert.strictEqual(handoffSurfaceState(comment({
    handoff_status: 'resolved',
    handoff_at: '2026-01-01T01:00:00Z',
    handoff_delivery: { status: 'delivered' },
  })), 'replied');
  ok('handoff resolved counts as replied');

  assert.strictEqual(handoffSurfaceState(comment({
    handoff_status: 'sent',
    handoff_at: '2026-01-01T01:00:00Z',
    handoff_delivery: { status: 'delivered' },
    replies: [
      { author: { kind: 'agent', login: 'bot' }, created: '2026-01-01T02:00:00Z', text: 'done' },
      { author: { kind: 'human', login: 'julie' }, created: '2026-01-01T03:00:00Z', text: 'more' },
    ],
  })), 'ready');
  ok('human follow-up after agent reply is ready again');

  assert.strictEqual(handoffSurfaceState(comment({
    handoff_status: 'sent',
    handoff_at: '2026-01-01T01:00:00Z',
    handoff_delivery: { status: 'delivered' },
    replies: [
      { author: { kind: 'human', login: 'julie' }, created: '2026-01-01T01:30:00Z', text: 'also this' },
      { author: { kind: 'agent', login: 'bot' }, created: '2026-01-01T02:00:00Z', text: 'saw both' },
    ],
  })), 'replied');
  ok('one agent reply after self-reply counts as processed');

  assert.strictEqual(handoffSurfaceState(comment({ status: 'applied' })), null);
  ok('applied comments leave the surface');

  assert.ok(lastHumanAt(comment({
    replies: [
      { author: { kind: 'agent' }, created: '2026-01-01T05:00:00Z' },
      { author: { kind: 'human' }, created: '2026-01-01T04:00:00Z' },
    ],
  })) === Date.parse('2026-01-01T04:00:00Z'));
  ok('lastHumanAt ignores agent stamps');

  const buckets = summarizeHandoffSurfaces([
    comment({ id: 'a' }),
    comment({
      id: 'b',
      handoff_status: 'sent',
      handoff_at: '2026-01-01T01:00:00Z',
      handoff_delivery: { status: 'failed' },
    }),
  ]);
  assert.strictEqual(buckets.ready.length, 1);
  assert.strictEqual(buckets.failed.length, 1);
  ok('summarize buckets');

  assert.strictEqual(shortCommentPreview('hello world'), 'hello world');
  assert.ok(shortCommentPreview('x'.repeat(100)).endsWith('…'));
  ok('preview truncates');

  // Answered from a pull, never handed off: the agent has the last word, so
  // it is not ready to send again (Julie, 2026-10-01).
  assert.strictEqual(handoffSurfaceState(comment({
    id: 'p', handoff_status: 'note',
    replies: [{ id: 'r', author: { kind: 'agent', login: 'claude' }, created: '2026-01-01T02:00:00Z' }],
  })), 'replied');
  // A person replies after it: ready again.
  assert.strictEqual(handoffSurfaceState(comment({
    id: 'q', handoff_status: 'note',
    replies: [
      { id: 'r1', author: { kind: 'agent', login: 'claude' }, created: '2026-01-01T02:00:00Z' },
      { id: 'r2', author: { login: 'julie' }, created: '2026-01-01T03:00:00Z' },
    ],
  })), 'ready');
  ok('the last speaker decides: agent last is replied, never ready');

  console.log(`\n${pass} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
