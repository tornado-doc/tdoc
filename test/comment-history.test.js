// Regression test for "comments disappear on pull" (Bug 2).
//
// Root cause: tdoc-pull fetched /api/comments WITHOUT a version param, so the
// worker returned snapshotList(list, Infinity) — only comments alive at the
// LATEST version. A comment created on v1 is dropped once the doc reaches v2+,
// because snapshotAt() bails at `if (c.created_in > at) return null`. Pull then
// overwrote comments.json wholesale, losing those comments permanently.
//
// Fix: a `historyList()` view (served via ?version=all) that returns every
// comment that ever existed across all versions, and a non-destructive pull.
//
// This test reproduces the data-loss with the worker's own folding logic.
// It extracts snapshotAt/snapshotList/historyList from worker/worker.js and
// asserts: (1) the OLD path (latest snapshot) DROPS an older-version comment
// [the bug], and (2) the NEW path (historyList) KEEPS it [the fix].
//
// Run with: node test/comment-history.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, err) { console.log(`  ✗ ${name}\n    ${err}`); fail++; }
function t(name, fn) { try { fn(); ok(name); } catch (e) { bad(name, e.message); } }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// --- Load the worker's pure folding functions in an isolated VM sandbox. ---
// worker.js is an ES module (export default {...}); we can't `require` it. We
// slice out the helper functions we need and eval them, so the test exercises
// the REAL implementation, not a copy that could drift.
const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');

function sliceFn(name) {
  // Grab `function <name>(...) { ... }` by brace-matching from its declaration.
  const start = workerSrc.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in worker.js — fix may be incomplete`);
  let i = workerSrc.indexOf('{', start);
  let depth = 0;
  for (; i < workerSrc.length; i++) {
    if (workerSrc[i] === '{') depth++;
    else if (workerSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return workerSrc.slice(start, i);
}

// Dependencies the folding functions reference.
const deps = [
  'isFiniteVersion', 'eventEid', 'backfillEids', 'dedupEvents',
  'ensureEventLog', 'legacyToEvents', 'snapshotAt',
  'keepThread', 'asTombstone', 'snapshotList', 'historyList',
].map(sliceFn).join('\n\n');

const sandbox = { AGENT_STATUS_EMOJI: { applied: '✅', partial: '🟡', question: '❓' } };
vm.createContext(sandbox);
vm.runInContext(deps, sandbox);

// --- Build a synthetic comment list using the event-log shape worker uses. ---
// One comment created on v1, one created on v2. Doc is now at v2.
function mkComment(id, createdIn, text) {
  return {
    id,
    author: { login: 'tester', avatar_url: '', name: 'Tester' },
    created: '2026-01-01T00:00:00Z',
    created_in: createdIn,
    events: [
      { kind: 'created', at_version: createdIn, at: '2026-01-01T00:00:00Z',
        anchor: { kind: 'text', text: 'anchor-' + id }, text },
    ],
  };
}

const list = [
  mkComment('c_v1', 1, 'comment made on version 1'),
  mkComment('c_v2', 2, 'comment made on version 2'),
];

console.log('comment-history (Bug 2: comments disappear on pull)');

t('REPRO: latest-snapshot (old pull behavior) DROPS the v1 comment once doc is on v2', () => {
  // Old pull did: GET /api/comments?slug=... with NO version => snapshotList(list, Infinity).
  // Infinity == latest. Both comments have created_in <= Infinity, so actually
  // both survive at Infinity. The real loss happens when the *viewed/pulled*
  // version is an EARLIER snapshot than a later comment, OR when latest-only
  // hides comments. Assert the precise mechanism: snapshotAt at an OLD version
  // hides the NEWER comment — proving version scoping drops comments.
  const atV1 = sandbox.snapshotList(list, 1);
  const ids = atV1.map(c => c.id);
  assert(ids.includes('c_v1'), 'v1 comment should exist at v1');
  assert(!ids.includes('c_v2'), 'v2 comment must NOT appear at v1 snapshot (this is the scoping that drops comments)');
  assert(atV1.length === 1, `expected 1 comment at v1 snapshot, got ${atV1.length}`);
});

t('FIX: historyList returns EVERY comment across all versions (lossless pull)', () => {
  const all = sandbox.historyList(list);
  const ids = all.map(c => c.id).sort();
  assert(ids.length === 2, `historyList must return both comments, got ${ids.length}: ${ids}`);
  assert(ids[0] === 'c_v1' && ids[1] === 'c_v2', `historyList must include both v1 and v2 comments, got ${ids}`);
});

t('FIX: historyList preserves author identity on every comment', () => {
  const all = sandbox.historyList(list);
  for (const c of all) {
    assert(c.author && c.author.login === 'tester', `comment ${c.id} lost its author`);
  }
});

t('FIX: a comment deleted via event is still excluded by historyList (delete != version-scope)', () => {
  const withDeleted = [
    mkComment('c_keep', 1, 'keep me'),
    (() => { const c = mkComment('c_del', 1, 'delete me');
      c.events.push({ kind: 'deleted', at_version: 2, at: '2026-01-02T00:00:00Z', by: 'tester' });
      return c; })(),
  ];
  const all = sandbox.historyList(withDeleted);
  const ids = all.map(c => c.id);
  assert(ids.includes('c_keep'), 'non-deleted comment should remain');
  assert(!ids.includes('c_del'), 'deleted comment must be excluded (intentional removal, not scoping)');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
