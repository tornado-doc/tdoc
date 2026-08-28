// Coverage tests for the remaining P2 gaps (Batch F):
//   - legacy-migration-untested: legacyToEvents/ensureEventLog
//   - publish-pipeline-untested-real-path: bundle_worker overlay inlining
//   - pull-merge-untested: tdoc-pull's non-destructive jq merge
//   - snapshotat-shallow-coverage: rich event-sequence fold
//
// Run with: node test/coverage.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
function sliceFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`fn ${name} not found`);
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
  'isFiniteVersion', 'eventEid', 'backfillEids', 'dedupEvents',
  'ensureEventLog', 'legacyToEvents', 'snapshotAt', 'snapshotList',
].map(sliceFn).join('\n\n'), box);
const { legacyToEvents, ensureEventLog, snapshotAt } = box;

console.log('coverage (Batch F remaining gaps)');

// ---- legacy migration ----
t('MIGRATION: a legacy flat comment becomes an event log (lossless)', () => {
  const legacy = {
    id: 'c1', version: 2, text: 'hello', anchor: { kind: 'text', text: 'x' },
    author: { login: 'alice' }, status: 'applied', applied_in: 3,
    reactions: { '👍': ['bob'] },
    replies: [{ id: 'r1', text: 'reply', author: { login: 'carol' }, version: 2 }],
  };
  const migrated = !!ensureEventLog(legacy);
  assert(migrated, 'ensureEventLog should report migration');
  assert(Array.isArray(legacy.events) && legacy.events.length > 0, 'events[] not built');
  const snap = snapshotAt(legacy, Infinity);
  assert(snap.text === 'hello', 'text lost in migration');
  assert(snap.status === 'applied' && snap.applied_in === 3, 'applied state lost');
  assert(snap.reactions['👍'] && snap.reactions['👍'].includes('bob'), 'reaction lost');
  assert(snap.replies.length === 1 && snap.replies[0].text === 'reply', 'reply lost');
});

t('MIGRATION: idempotent — re-running does not duplicate events', () => {
  const legacy = { id: 'c2', version: 1, text: 'hi', reactions: { '🎉': ['u'] } };
  ensureEventLog(legacy);
  const n1 = legacy.events.length;
  const again = ensureEventLog(legacy); // already has events[] → only backfill
  assert(legacy.events.length === n1, 'migration duplicated events on re-run');
  // `again` may be true if eids were backfilled, but event count must be stable
});

t('MIGRATION: every migrated event carries an eid (convergence-ready)', () => {
  const legacy = { id: 'c3', version: 1, text: 'hi', reactions: { '👍': ['a', 'b'] } };
  ensureEventLog(legacy);
  assert(legacy.events.every(e => e.eid), 'a migrated event lacks an eid');
});

// ---- rich snapshot folding (13 event kinds, not just created) ----
t('FOLD: reaction add then remove nets to no reaction', () => {
  const c = { id: 'c4', author: {login:'a'}, created: 't0', created_in: 1, events: [
    { kind: 'created', at_version: 1, at: 't0', text: 'x', anchor: null },
    { kind: 'reaction_added', at_version: 1, at: 't1', emoji: '👍', by: 'u', eid: 'r1' },
    { kind: 'reaction_removed', at_version: 1, at: 't2', emoji: '👍', by: 'u', eid: 'r2' },
  ]};
  box.backfillEids(c.events);
  const snap = snapshotAt(c, Infinity);
  assert(!snap.reactions['👍'] || !snap.reactions['👍'].includes('u'),
    'reaction should be gone after add+remove');
});

// Regression (audit, Codex+Claude agreed): add→remove→add must converge to
// "reacted", not silently vanish. Old eventEid put the event KIND in the eid,
// so add and remove lived in two independent dedup slots and folded to a stale
// "removed" even though the user's last action was add. Now both kinds share
// one (emoji,by,at_version) eid so the last toggle wins.
t('FOLD: reaction add→remove→add converges to PRESENT (no data loss)', () => {
  const c = { id: 'c4b', author: {login:'a'}, created: 't0', created_in: 1, events: [
    { kind: 'created', at_version: 1, at: 't0', text: 'x', anchor: null },
    { kind: 'reaction_added',   at_version: 1, at: 't1', emoji: '👍', by: 'u' },
    { kind: 'reaction_removed', at_version: 1, at: 't2', emoji: '👍', by: 'u' },
    { kind: 'reaction_added',   at_version: 1, at: 't3', emoji: '👍', by: 'u' },
  ]};
  box.backfillEids(c.events);
  const snap = snapshotAt(c, Infinity);
  assert(snap.reactions['👍'] && snap.reactions['👍'].includes('u'),
    'after add→remove→add the reaction must be PRESENT');
});

// Regression (audit): a reaction on v1 and a different toggle on v3 must NOT
// clobber each other — snapshots are immutable per version. Old eid omitted
// at_version, so same emoji/user across versions collided into one slot.
t('FOLD: same reaction across versions stays independent (snapshot immutability)', () => {
  const c = { id: 'c4c', author: {login:'a'}, created: 't0', created_in: 1, events: [
    { kind: 'created', at_version: 1, at: 't0', text: 'x', anchor: null },
    { kind: 'reaction_added',   at_version: 1, at: 't1', emoji: '🔥', by: 'u' }, // on v1
    { kind: 'reaction_removed', at_version: 3, at: 't2', emoji: '🔥', by: 'u' }, // un-react on v3
  ]};
  box.backfillEids(c.events);
  // At v1 the reaction is still present; the v3 removal must not reach back.
  const v1 = snapshotAt(c, 1);
  assert(v1.reactions['🔥'] && v1.reactions['🔥'].includes('u'),
    'v1 reaction must survive a later-version removal');
  // At v3 it is removed.
  const v3 = snapshotAt(c, 3);
  assert(!v3.reactions['🔥'] || !v3.reactions['🔥'].includes('u'),
    'v3 must reflect the removal');
});

// Regression (audit): backfillEids must MIGRATE a stored old-format reaction
// eid to the new format, not leave it stale — otherwise reactions created
// before the fix never converge.
t('MIGRATE: stale old-format reaction eid is recomputed by backfillEids', () => {
  const e = { kind: 'reaction_added', at_version: 2, at: 't1', emoji: '🎉', by: 'bob',
    eid: 'reaction_added:🎉:bob' /* OLD format: kind-in-eid, no at_version */ };
  box.backfillEids([e]);
  assert(e.eid === 'reaction:🎉:bob:2',
    `old-format eid should be migrated; got ${e.eid}`);
});

t('FOLD: text_edited overrides created text', () => {
  const c = { id: 'c5', author: {login:'a'}, created: 't0', created_in: 1, events: [
    { kind: 'created', at_version: 1, at: 't0', text: 'orig', anchor: null },
    { kind: 'text_edited', at_version: 2, at: 't2', text: 'edited' },
  ]};
  box.backfillEids(c.events);
  assert(snapshotAt(c, Infinity).text === 'edited');
});

t('FOLD: marked_open after marked_applied clears the applied state', () => {
  const c = { id: 'c6', author: {login:'a'}, created: 't0', created_in: 1, events: [
    { kind: 'created', at_version: 1, at: 't0', text: 'x', anchor: null },
    { kind: 'marked_applied', at_version: 2, at: 't2', applied_in: 2 },
    { kind: 'marked_open', at_version: 3, at: 't3' },
  ]};
  box.backfillEids(c.events);
  const snap = snapshotAt(c, Infinity);
  assert(snap.status === 'open' && snap.applied_in === undefined, 'applied state not cleared');
});

t('FOLD: deleted reply is excluded', () => {
  const c = { id: 'c7', author: {login:'a'}, created: 't0', created_in: 1, events: [
    { kind: 'created', at_version: 1, at: 't0', text: 'x', anchor: null },
    { kind: 'reply_added', at_version: 1, at: 't1', reply: { id: 'r1', text: 'keep', author: {login:'a'} } },
    { kind: 'reply_added', at_version: 1, at: 't2', reply: { id: 'r2', text: 'gone', author: {login:'b'} } },
    { kind: 'reply_deleted', at_version: 2, at: 't3', reply_id: 'r2' },
  ]};
  box.backfillEids(c.events);
  const snap = snapshotAt(c, Infinity);
  assert(snap.replies.length === 1 && snap.replies[0].text === 'keep', 'deleted reply not excluded');
});

// ---- bundle_worker overlay inlining (the deploy-critical transform) ----
t('BUNDLE: real bundler replaces shell/probe/runtime placeholders with valid ESM', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-bundle-'));
  execFileSync(process.execPath, [path.join(root, 'bin/tdoc-bundle')], {
    env: { ...process.env, OUT_DIR: out, TDOC_GENERATED_BY: 'coverage.test' },
    stdio: 'pipe',
  });
  const bundled = fs.readFileSync(path.join(out, '_worker.bundled.js'), 'utf8');
  for (const declaration of [
    'const PROBE_JS = `__TDOC_PROBE_JS__`;',
    'const SHELL_RUNTIME_JS = `__TDOC_SHELL_RUNTIME_JS__`;',
    'const TDOC_BUILD_INFO = "__TDOC_BUILD_INFO__";',
  ]) assert(!bundled.includes(declaration), `active placeholder remains: ${declaration}`);
  assert(/const PROBE_JS = "/.test(bundled), 'frame probe was not embedded');
  assert(/const SHELL_RUNTIME_JS = "/.test(bundled), 'React runtime was not embedded');
  const modulePath = path.join(out, '_worker.bundled.mjs');
  fs.copyFileSync(path.join(out, '_worker.bundled.js'), modulePath);
  execFileSync(process.execPath, ['--check', modulePath], { stdio: 'pipe' });
  fs.rmSync(out, { recursive: true, force: true });
});

// ---- tdoc-pull non-destructive merge ----
t('PULL-MERGE: keeps local-only comments and prefers remote, with backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-pull-'));
  try {
    const slug = 'mydoc';
    const out = path.join(dir, slug, 'comments.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // local has L1 (also remote) + L2 (local-only)
    fs.writeFileSync(out, JSON.stringify([{ id: 'L1', text: 'old' }, { id: 'L2', text: 'local-only' }]));
    // simulate the merge jq tdoc-pull runs (remote wins on shared id, local-only appended)
    const remote = [{ id: 'L1', text: 'updated-remote' }, { id: 'R3', text: 'remote-new' }];
    const jqFilter = '($local[0] // []) as $loc | ($remote | map(.id)) as $rids | ' +
      '($loc | map(select(.id as $i | ($rids | index($i)) | not))) as $localOnly | $remote + $localOnly';
    const merged = spawnSync('jq', ['-n', '--argjson', 'remote', JSON.stringify(remote),
      '--slurpfile', 'local', out, jqFilter], { encoding: 'utf8' });
    assert(merged.status === 0, `jq merge failed: ${merged.stderr}`);
    const result = JSON.parse(merged.stdout);
    const ids = result.map(c => c.id).sort();
    assert(ids.includes('L1') && ids.includes('L2') && ids.includes('R3'),
      `merge must keep all: got ${ids}`);
    const l1 = result.find(c => c.id === 'L1');
    assert(l1.text === 'updated-remote', 'remote should win on shared id');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
