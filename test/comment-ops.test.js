// applyCommentOp tests (#34 — DO-serialized mutations).
//
// All 7 comment mutations now funnel through applyCommentOp (the single shared
// mutation function the DO and the KV fallback both call). This tests that
// function directly — the mutation LOGIC — so a regression is caught without a
// live Durable Object. The DO itself only provides serialization (single-
// threaded execution); the per-op behavior lives here.
//
// Run with: node test/comment-ops.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
function fn(name) {
  const s = src.indexOf(`function ${name}(`);
  if (s === -1) throw new Error(`fn ${name} not found`);
  let i = src.indexOf('{', s), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) { i++; break; } } }
  return src.slice(s, i);
}
function konst(name) { return new RegExp(`const ${name} = \\[[\\s\\S]*?\\];`).exec(src)[0]; }
function region(from, to) {
  const s = src.indexOf(`function ${from}(`);
  const e0 = src.indexOf(`function ${to}(`);
  let i = src.indexOf('{', e0), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) { i++; break; } } }
  return src.slice(s, i);
}

const box = { AGENT_STATUS_EMOJI: { applied: '✅', partial: '🟡', question: '❓' }, crypto: globalThis.crypto };
vm.createContext(box);
vm.runInContext([
  fn('cyrb53'), fn('aidFor'), konst('STAMPABLE_TAGS'), fn('isFiniteVersion'),
  region('legacyToEvents', 'compactComments'), // event-log helpers
  fn('reconcileAnchors'),
  fn('findCommentThread'),
  fn('applyCommentOp'),
].join('\n\n'), box);
const apply = box.applyCommentOp;

const mkAuthor = (login) => ({ login, name: login, avatar_url: '' });

console.log('comment-ops (#34 applyCommentOp)');

// ---- create ----
t('create: adds a comment, returns its snapshot', () => {
  const list = [];
  const r = apply(list, { kind: 'create', id: 'c1', author: mkAuthor('alice'), text: 'hi', anchor: { kind: 'text', text: 'x' }, version: 1, at: '2026-01-01' });
  assert(r.status === 200, `status ${r.status}`);
  assert(r.body.text === 'hi' && r.body.id === 'c1', 'wrong snapshot');
  assert(list.length === 1, 'not added to list');
});

// ---- reply ----
t('reply: appends to parent; 404 if parent missing', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('a'), text: 'p', version: 1, at: '2026-01-01' });
  const r = apply(list, { kind: 'reply', parent_id: 'c1', reply_id: 'r1', author: mkAuthor('b'), text: 'child', version: 1, at: '2026-01-02' });
  assert(r.status === 200 && r.body.id === 'r1', 'reply not created');
  const miss = apply(list, { kind: 'reply', parent_id: 'nope', reply_id: 'r2', author: mkAuthor('b'), text: 'x', version: 1 });
  assert(miss.status === 404, 'missing parent should 404');
});

t('reply: can nest under an existing reply (HN-style)', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('a'), text: 'p', version: 1, at: '2026-01-01' });
  apply(list, { kind: 'reply', parent_id: 'c1', reply_id: 'r1', author: mkAuthor('b'), text: 'child', version: 1, at: '2026-01-02' });
  const r = apply(list, { kind: 'reply', parent_id: 'r1', reply_id: 'r2', author: mkAuthor('a'), text: 'grandchild', version: 1, at: '2026-01-03' });
  assert(r.status === 200 && r.body.id === 'r2', 'nested reply not created');
  assert(r.body.parent_id === 'r1', `parent_id should be r1, got ${r.body.parent_id}`);
  assert(r.body.thread_id === 'c1', `thread_id should be c1, got ${r.body.thread_id}`);
  const ev = (list[0].events || []).find(e => e.kind === 'reply_added' && e.reply && e.reply.id === 'r2');
  assert(ev && ev.reply.parent_id === 'r1', 'event should record immediate parent');
});

// ---- react: the toggle is the race-prone one ----
t('react: first toggle ADDS, second toggle REMOVES (computed from list, not caller)', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('a'), text: 'p', version: 1, at: '2026-01-01' });
  const add = apply(list, { kind: 'react', comment_id: 'c1', emoji: '👍', by: 'bob', version: 1, at: '2026-01-02' });
  assert(add.status === 200, 'react add failed');
  assert((add.body.reactions['👍'] || []).includes('bob'), 'add did not record reaction');
  const rem = apply(list, { kind: 'react', comment_id: 'c1', emoji: '👍', by: 'bob', version: 1, at: '2026-01-03' });
  assert(!(rem.body.reactions['👍'] || []).includes('bob'), 'second toggle should remove');
});

t('react: two DIFFERENT users adding the same emoji both count (no clobber)', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('a'), text: 'p', version: 1, at: '2026-01-01' });
  apply(list, { kind: 'react', comment_id: 'c1', emoji: '🎉', by: 'u1', version: 1, at: '2026-01-02' });
  const r = apply(list, { kind: 'react', comment_id: 'c1', emoji: '🎉', by: 'u2', version: 1, at: '2026-01-03' });
  const who = (r.body.reactions['🎉'] || []).sort();
  assert(JSON.stringify(who) === JSON.stringify(['u1', 'u2']), `expected both users, got ${who}`);
});

// ---- delete (soft) ----
t('delete: soft-deletes a top-level comment (hidden from snapshot)', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('a'), text: 'p', version: 1, at: '2026-01-01' });
  const r = apply(list, { kind: 'delete', id: 'c1', version: 1, actor: mkAuthor('a'), at: '2026-01-02' });
  assert(r.status === 200, 'delete failed');
  assert(box.snapshotAt(list[0], Infinity).deleted === true, 'comment not marked deleted');
});

// ---- patch_anchor ----
t('patch_anchor: re-anchors; 404 if target missing', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('a'), text: 'p', anchor: { kind: 'text', text: 'old' }, version: 1, at: '2026-01-01' });
  const r = apply(list, { kind: 'patch_anchor', id: 'c1', anchor: { kind: 'text', text: 'new' }, reset_status: true, version: 2, actor: mkAuthor('a'), at: '2026-01-02' });
  assert(r.status === 200, 'patch failed');
  assert(box.snapshotAt(list[0], 2).anchor.text === 'new', 'anchor not updated');
  assert(apply(list, { kind: 'patch_anchor', id: 'zzz', anchor: {}, version: 2, actor: mkAuthor('a') }).status === 404, 'missing target should 404');
});

// ---- publish_merge: the data-safety-critical one ----
t('publish_merge: adds local-only comments, NEVER overwrites/deletes worker ones', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c_worker', author: mkAuthor('reader'), text: 'WORKER ORIGINAL', version: 1, at: '2026-01-01' });
  const r = apply(list, { kind: 'publish_merge', localComments: [
    { id: 'c_worker', version: 1, text: 'LOCAL OVERWRITE', author: mkAuthor('me'), status: 'open', created: '2026-01-01', anchor: { kind: 'text', text: 'x' }, replies: [], reactions: {} },
    { id: 'c_local', version: 1, text: 'NEW LOCAL', author: mkAuthor('me'), status: 'open', created: '2026-01-02', anchor: { kind: 'text', text: 'y' }, replies: [], reactions: {} },
  ], aids: [], version: 1 });
  assert(r.status === 200, 'merge failed');
  assert(r.body.mergedComments === 1, `expected 1 merged (only c_local), got ${r.body.mergedComments}`);
  const byId = Object.fromEntries(list.map(c => [c.id, c]));
  assert(/WORKER ORIGINAL/.test(box.snapshotAt(byId['c_worker'], Infinity).text), 'worker comment was overwritten!');
  assert(byId['c_local'], 'local-only comment not added');
});

t('publish_merge is idempotent — re-merging the same set adds nothing', () => {
  const list = [];
  const local = [{ id: 'c_a', version: 1, text: 'a', author: mkAuthor('me'), status: 'open', created: '2026-01-01', anchor: { kind: 'text', text: 'x' }, replies: [], reactions: {} }];
  apply(list, { kind: 'publish_merge', localComments: local, aids: [], version: 1 });
  const r2 = apply(list, { kind: 'publish_merge', localComments: local, aids: [], version: 1 });
  assert(r2.body.mergedComments === 0, `second merge added ${r2.body.mergedComments}`);
});

// ---- wipe (admin ?all=1) ----
t('wipe: signals deletion of the whole key (__wipe), reports prior count', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('a'), text: 'p', version: 1, at: '2026-01-01' });
  apply(list, { kind: 'create', id: 'c2', author: mkAuthor('a'), text: 'q', version: 1, at: '2026-01-01' });
  const r = apply(list, { kind: 'wipe', slug: 's' });
  assert(r.status === 200, 'wipe failed');
  assert(r.__wipe === true, 'wipe must signal __wipe so caller deletes the key');
  assert(r.body.deleted === 2, `expected deleted=2, got ${r.body.deleted}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
