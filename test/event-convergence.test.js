// Convergence + fold-ordering tests (Batch B + part of Batch C).
//
// Cloudflare KV has no atomic CAS, so concurrent comment writes can clobber
// each other (last-write-wins). Rather than fake a lock, the event log was made
// CONVERGENT: every event carries an `eid`, the fold dedups by it, and the fold
// is stable-sorted by at_version so write order doesn't change the result.
//
// Covers:
//   - kv-lost-update-race / worker-kv-rmw-lost-updates → eid dedup convergence
//   - worker-event-fold-append-order / snapshot-event-order-... → version sort
//
// Run with: node test/event-convergence.test.js

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
  'isFiniteVersion', 'eventEid', 'backfillEids', 'dedupEvents', 'appendEvent',
  'ensureEventLog', 'legacyToEvents', 'snapshotAt',
].map(sliceFn).join('\n\n'), box);

const { eventEid, dedupEvents, backfillEids, appendEvent, snapshotAt } = box;

console.log('event-convergence (Batch B race mitigation + Batch C ordering)');

// --- deterministic eids for idempotent ops ---
t('reaction add/remove get DETERMINISTIC eids (toggle converges)', () => {
  const e1 = { kind: 'reaction_added', emoji: '👍', by: 'alice', at_version: 1, at: 'x' };
  const e2 = { kind: 'reaction_added', emoji: '👍', by: 'alice', at_version: 1, at: 'y' };
  assert(eventEid(e1) === eventEid(e2), 'same reaction by same user must share an eid');
});
t('one-shot events (created/reply) get UNIQUE eids', () => {
  const a = eventEid({ kind: 'created', at: 't1' });
  const b = eventEid({ kind: 'created', at: 't1' });
  assert(a !== b, 'two created events must not collide');
});

// --- dedup convergence: simulate two writers' logs merged ---
t('CONVERGENCE: duplicate-eid events collapse to one after merge', () => {
  // Writer A and Writer B both added the same reaction (concurrent), and both
  // logs get concatenated (what a lost-update + later re-read would surface).
  const react = (at) => { const e = { kind: 'reaction_added', emoji: '🎉', by: 'bob', at_version: 2, at }; e.eid = eventEid(e); return e; };
  const merged = [react('a'), react('b'), react('c')];
  const deduped = dedupEvents(merged);
  assert(deduped.length === 1, `expected 1 after dedup, got ${deduped.length}`);
});
t('CONVERGENCE: merge order does not change the deduped set', () => {
  const mk = (kind, extra) => { const e = { kind, at_version: 1, at: extra, ...(kind.startsWith('reaction') ? { emoji: '👍', by: 'u' } : {}) }; e.eid = eventEid(e); return e; };
  const created = mk('created', 't0');
  const r1 = mk('reaction_added', 't1');
  const r2 = mk('reaction_added', 't2'); // same eid as r1
  const fwd = dedupEvents([created, r1, r2]).length;
  const rev = dedupEvents([created, r2, r1]).length;
  assert(fwd === rev, 'dedup must be order-independent in count');
});

// --- fold ordering: backdated event must not win the latest snapshot ---
t('ORDERING: a backdated anchor_changed does NOT override a newer one', () => {
  // created v1, then anchor changed at v3 (newer), then a reconcile appends an
  // anchor_changed stamped at v2 (OLDER) but pushed LATER in the array.
  const c = {
    id: 'c1', author: { login: 'a' }, created: 't0', created_in: 1,
    events: [
      { kind: 'created', at_version: 1, at: 't0', anchor: { kind: 'text', text: 'orig' } },
      { kind: 'anchor_changed', at_version: 3, at: 't3', anchor: { kind: 'text', text: 'NEW-v3' } },
      { kind: 'anchor_changed', at_version: 2, at: 't2', anchor: { kind: 'text', text: 'stale-v2' } },
    ],
  };
  backfillEids(c.events);
  const snap = snapshotAt(c, Infinity);
  assert(snap.anchor && snap.anchor.text === 'NEW-v3',
    `latest snapshot must reflect the v3 anchor, got ${JSON.stringify(snap.anchor)}`);
});

t('ORDERING: fold result is identical regardless of physical event order', () => {
  const base = [
    { kind: 'created', at_version: 1, at: 't0', text: 'hi', anchor: null },
    { kind: 'text_edited', at_version: 2, at: 't2', text: 'edited' },
    { kind: 'marked_applied', at_version: 3, at: 't3', applied_in: 3 },
  ];
  const mk = (arr) => { const c = { id: 'x', author: {login:'a'}, created: 't0', created_in: 1, events: arr.map(e => ({ ...e })) }; backfillEids(c.events); return snapshotAt(c, Infinity); };
  const inOrder = mk(base);
  const shuffled = mk([base[2], base[0], base[1]]);
  assert(inOrder.text === shuffled.text && inOrder.status === shuffled.status,
    'fold must be order-independent');
  assert(inOrder.text === 'edited' && inOrder.status === 'applied');
});


// --- agent status is a toggle, and must converge back to applied (#229) ---
// question/partial -> applied is the NORMAL progression: the agent asks, the
// human answers, the agent applies. Under the old `<kind>:<at_version>` eid
// that path could never converge, because marked_applied and marked_open sat
// in two slots and dedupEvents re-seats each slot at its FIRST occurrence.

t('marked_applied and marked_open share one eid slot (status is a toggle)', () => {
  const applied = eventEid({ kind: 'marked_applied', at_version: 1 });
  const open = eventEid({ kind: 'marked_open', at_version: 1 });
  assert(applied === open,
    `status kinds must share an eid, got ${applied} vs ${open}`);
  // ...but not across versions, so snapshots stay immutable.
  assert(eventEid({ kind: 'marked_open', at_version: 2 }) !== open,
    'status eid must still include at_version');
  // deleted is terminal, not a toggle — it keeps its own slot.
  assert(eventEid({ kind: 'deleted', at_version: 1 }) !== open,
    'deleted must not share the status slot');
});

t('CONVERGENCE: applied -> partial -> applied ends applied, not stuck open', () => {
  const c = { id: 'c_1', created_in: 1, author: { login: 'u' }, text: 'q',
    events: [{ kind: 'created', at_version: 1, at: 't0', eid: 'created:1' }] };
  appendEvent(c, { kind: 'marked_applied', at_version: 1, at: 't1', applied_in: 1, by: 'claude', agent_status: 'applied' });
  appendEvent(c, { kind: 'marked_open', at_version: 1, at: 't2', by: 'claude', agent_status: 'partial' });
  appendEvent(c, { kind: 'marked_applied', at_version: 1, at: 't3', applied_in: 1, by: 'claude', agent_status: 'applied' });
  const snap = snapshotAt(c, 1);
  assert(snap.status === 'applied', `status stuck at "${snap.status}" after re-applying`);
  assert(Object.keys(snap.reactions || {}).join('') === '✅',
    `emoji is ${JSON.stringify(Object.keys(snap.reactions || {}))}, expected ✅`);
});

t('CONVERGENCE: question -> applied flips the verdict within one version', () => {
  const c = { id: 'c_2', created_in: 2, author: { login: 'u' }, text: 'q',
    events: [{ kind: 'created', at_version: 2, at: 't0', eid: 'created:2' }] };
  appendEvent(c, { kind: 'marked_open', at_version: 2, at: 't1', by: 'claude', agent_status: 'question' });
  appendEvent(c, { kind: 'marked_applied', at_version: 2, at: 't2', applied_in: 2, by: 'claude', agent_status: 'applied' });
  const snap = snapshotAt(c, 2);
  assert(snap.status === 'applied', `question->applied left status "${snap.status}"`);
});

t('a later marked_open still reopens an applied comment', () => {
  // The toggle must work in both directions — converging must not mean
  // "applied always wins".
  const c = { id: 'c_3', created_in: 1, author: { login: 'u' }, text: 'q',
    events: [{ kind: 'created', at_version: 1, at: 't0', eid: 'created:1' }] };
  appendEvent(c, { kind: 'marked_applied', at_version: 1, at: 't1', applied_in: 1, by: 'claude', agent_status: 'applied' });
  appendEvent(c, { kind: 'marked_open', at_version: 1, at: 't2', by: 'claude', agent_status: 'question' });
  const snap = snapshotAt(c, 1);
  assert(snap.status !== 'applied', 'a later marked_open must reopen the comment');
});

t('MIGRATION: events stored under the old <kind>:<version> eid are recomputed', () => {
  // Real stored data: two status events written before this fix, each carrying
  // the old eid. backfillEids must migrate both into the shared slot so the
  // comment self-heals on the next fold rather than staying stuck.
  const events = [
    { kind: 'created', at_version: 1, at: 't0', eid: 'created:1' },
    { kind: 'marked_applied', at_version: 1, at: 't1', applied_in: 1, by: 'claude', agent_status: 'applied', eid: 'marked_applied:1' },
    { kind: 'marked_open', at_version: 1, at: 't2', by: 'claude', agent_status: 'partial', eid: 'marked_open:1' },
    { kind: 'marked_applied', at_version: 1, at: 't3', applied_in: 1, by: 'claude', agent_status: 'applied', eid: 'marked_applied:1' },
  ];
  const changed = backfillEids(events);
  assert(changed === true, 'backfillEids must report the eid format migration');
  const statusEids = new Set(events.filter(e => e.kind.startsWith('marked_')).map(e => e.eid));
  assert(statusEids.size === 1, `status events still in ${statusEids.size} slots: ${[...statusEids]}`);
  const c = { id: 'c_4', created_in: 1, author: { login: 'u' }, text: 'q', events };
  assert(snapshotAt(c, 1).status === 'applied', 'migrated legacy events did not converge');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
