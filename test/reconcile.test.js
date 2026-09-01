// reconcileAnchors + compaction tests (Batch C + the P1 reconcile-untested gap).
//
// Covers:
//   - reconcile-anchors-untested (P1): exercise the rebind branches directly
//   - reconcile-lost-is-sticky-forever (P2): a lost anchor RE-BINDS when the
//     artifact returns in a later version
//   - kv-single-value-unbounded-growth (P2): compactComments shrinks the log
//
// Run with: node test/reconcile.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
function sliceFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const box = { AGENT_STATUS_EMOJI: { applied: '✅', partial: '🟡', question: '❓' } };
vm.createContext(box);
vm.runInContext([
  'isFiniteVersion', 'eventEid', 'backfillEids', 'dedupEvents', 'compactComments',
  'appendEvent', 'ensureEventLog', 'ensureMigrated', 'legacyToEvents', 'snapshotAt',
  'keepThread', 'asTombstone', 'snapshotList', 'reconcileAnchors',
].map(sliceFn).join('\n\n'), box);
const { reconcileAnchors, snapshotAt, compactComments, backfillEids } = box;

// helper: a comment anchored to an element with a fingerprint
function elementComment(id, aid, tag, heading) {
  return {
    id, author: { login: 'a' }, created: 't0', created_in: 1,
    events: [{
      kind: 'created', at_version: 1, at: 't0', eid: 'created:t0:'+id,
      anchor: { kind: 'element', aid, selector: `[data-tdoc-aid="${aid}"]`, label: tag,
                fingerprint: { tag }, fallback: { nearestHeading: { text: heading } } },
    }],
  };
}
const aids = (...arr) => arr.map(a => ({ aid: a.aid, tag: a.tag, heading: a.heading }));

console.log('reconcile (Batch C + P1 reconcile coverage)');

// --- rebind branches (P1 coverage) ---
t('REBIND single-candidate: drifted aid re-binds to the lone fingerprint match', () => {
  const c = elementComment('c1', 'OLDAID', 'section', 'Intro');
  // version 2 no longer has OLDAID, but has one section under "Intro"
  reconcileAnchors([c], aids({ aid: 'NEWAID', tag: 'section', heading: 'Intro' }), 2);
  const snap = snapshotAt(c, 2);
  assert(snap.anchor.kind === 'element' && snap.anchor.aid === 'NEWAID',
    `expected rebind to NEWAID, got ${JSON.stringify(snap.anchor)}`);
});

t('NO REBIND when aid still present in version', () => {
  const c = elementComment('c2', 'KEEP', 'section', 'Intro');
  const evBefore = c.events.length;
  reconcileAnchors([c], aids({ aid: 'KEEP', tag: 'section', heading: 'Intro' }), 2);
  assert(c.events.length === evBefore, 'should not append when anchor still valid');
});

t('LOST when ambiguous (2+ candidates)', () => {
  const c = elementComment('c3', 'GONE', 'section', 'Intro');
  reconcileAnchors([c], aids(
    { aid: 'A', tag: 'section', heading: 'Intro' },
    { aid: 'B', tag: 'section', heading: 'Intro' }), 2);
  const snap = snapshotAt(c, 2);
  assert(snap.anchor.kind === 'lost' && snap.anchor.reason === 'ambiguous',
    `expected lost/ambiguous, got ${JSON.stringify(snap.anchor)}`);
});

// --- sticky-lost recovery (the P2 fix) ---
t('RECOVERY: a lost anchor RE-BINDS when the artifact returns later [the fix]', () => {
  const c = elementComment('c4', 'GONE', 'figure', 'Chart');
  // v2: artifact absent → goes lost
  reconcileAnchors([c], aids({ aid: 'OTHER', tag: 'section', heading: 'Body' }), 2);
  assert(snapshotAt(c, 2).anchor.kind === 'lost', 'precondition: should be lost at v2');
  // v3: a matching figure under "Chart" returns → must re-bind (was sticky-forever before)
  reconcileAnchors([c], aids({ aid: 'BACK', tag: 'figure', heading: 'Chart' }), 3);
  const snap = snapshotAt(c, 3);
  assert(snap.anchor.kind === 'element' && snap.anchor.aid === 'BACK',
    `lost anchor must recover when target returns, got ${JSON.stringify(snap.anchor)}`);
});

t('NO LOG BLOAT: a perpetually-lost anchor does not append a new lost event every publish', () => {
  const c = elementComment('c5', 'GONE', 'figure', 'Chart');
  reconcileAnchors([c], aids({ aid: 'X', tag: 'section', heading: 'Body' }), 2);
  const afterFirst = c.events.length;
  reconcileAnchors([c], aids({ aid: 'X', tag: 'section', heading: 'Body' }), 3);
  reconcileAnchors([c], aids({ aid: 'X', tag: 'section', heading: 'Body' }), 4);
  assert(c.events.length === afterFirst, `lost should not re-append; was ${afterFirst}, now ${c.events.length}`);
});

// --- compaction (KV growth bound) ---
t('COMPACTION: superseded reaction toggles collapse in the stored log', () => {
  const c = {
    id: 'c6', author: { login: 'a' }, created: 't0', created_in: 1,
    events: [
      { kind: 'created', at_version: 1, at: 't0', text: 'hi', anchor: null },
      // same user reacts the same emoji 3x (concurrent dup writes) → same eid
      { kind: 'reaction_added', at_version: 1, at: 't1', emoji: '👍', by: 'u' },
      { kind: 'reaction_added', at_version: 1, at: 't2', emoji: '👍', by: 'u' },
      { kind: 'reaction_added', at_version: 1, at: 't3', emoji: '👍', by: 'u' },
    ],
  };
  backfillEids(c.events);
  const before = c.events.length;
  const changed = compactComments([c]);
  assert(changed === true, 'compaction should report a change');
  assert(c.events.length < before, `log should shrink (${before} → ${c.events.length})`);
  // and the reaction is still present after fold
  const snap = snapshotAt(c, 1);
  assert(snap.reactions['👍'] && snap.reactions['👍'].includes('u'), 'reaction preserved after compaction');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
