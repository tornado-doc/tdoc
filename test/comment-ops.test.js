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

// ---- edit_text ----
t('edit_text: rewrites a comment and stamps it edited; older versions keep the original', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('a'), text: 'first draft', version: 1, at: '2026-01-01' });
  const r = apply(list, { kind: 'edit_text', id: 'c1', text: 'second draft', version: 2, actor: mkAuthor('a'), at: '2026-01-02' });
  assert(r.status === 200, `edit failed: ${r.status}`);
  assert(r.body.text === 'second draft', `snapshot text is ${r.body.text}`);
  assert(r.body.edited === '2026-01-02', `edited stamp is ${r.body.edited}`);
  const before = box.snapshotAt(list[0], 1);
  assert(before.text === 'first draft', `v1 should keep the original, got ${before.text}`);
  assert(!before.edited, 'v1 was never edited, so it must not say it was');
});

t('edit_text: rewrites a reply, and only that reply', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('a'), text: 'p', version: 1, at: '2026-01-01' });
  apply(list, { kind: 'reply', parent_id: 'c1', reply_id: 'r1', author: mkAuthor('b'), text: 'typo', version: 1, at: '2026-01-02' });
  apply(list, { kind: 'reply', parent_id: 'c1', reply_id: 'r2', author: mkAuthor('b'), text: 'untouched', version: 1, at: '2026-01-02' });
  const r = apply(list, { kind: 'edit_text', id: 'r1', text: 'fixed', version: 1, actor: mkAuthor('b'), at: '2026-01-03' });
  assert(r.status === 200 && r.body.id === 'r1', 'reply edit did not return the reply');
  const replies = box.snapshotAt(list[0], Infinity).replies;
  assert(replies.find(x => x.id === 'r1').text === 'fixed', 'reply text not updated');
  assert(replies.find(x => x.id === 'r1').edited === '2026-01-03', 'reply not stamped edited');
  assert(replies.find(x => x.id === 'r2').text === 'untouched', 'sibling reply was touched');
  assert(!replies.find(x => x.id === 'r2').edited, 'sibling reply wrongly marked edited');
});

t('edit_text: 404 for an id that is neither a comment nor a reply', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('a'), text: 'p', version: 1, at: '2026-01-01' });
  assert(apply(list, { kind: 'edit_text', id: 'zzz', text: 'x', version: 1, actor: mkAuthor('a') }).status === 404, 'missing target should 404');
});

t('edit_text: the last edit at a version wins, and a legacy `edited` record replays as one', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('a'), text: 'one', version: 1, at: '2026-01-01' });
  apply(list, { kind: 'edit_text', id: 'c1', text: 'two', version: 1, actor: mkAuthor('a'), at: '2026-01-02' });
  apply(list, { kind: 'edit_text', id: 'c1', text: 'three', version: 1, actor: mkAuthor('a'), at: '2026-01-03' });
  assert(box.snapshotAt(list[0], 1).text === 'three', 'last edit should win');
  // What tdoc-publish merges up from the local server: one flat record whose
  // text is already the edit, plus the stamp.
  const legacy = { id: 'c2', version: 1, text: 'edited locally', edited: '2026-02-01', author: mkAuthor('a'), status: 'open', created: '2026-01-01', anchor: null, replies: [{ id: 'r9', text: 'reply edited locally', edited: '2026-02-02', author: mkAuthor('b'), version: 1, created: '2026-01-02', reactions: {} }], reactions: {} };
  const snap = box.snapshotAt(legacy, Infinity);
  assert(snap.text === 'edited locally' && snap.edited === '2026-02-01', `legacy edit lost: ${JSON.stringify({ t: snap.text, e: snap.edited })}`);
  assert(snap.replies[0].edited === '2026-02-02', 'legacy reply edit lost');
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

// ---- delete: what happens to the replies (#354) ----
const listAt = (list, V) => box.snapshotList(list, V);

t('deleting a comment that holds replies leaves a tombstone, not a hole', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('alice'), text: 'ALICE asks', anchor: { kind: 'text', text: 'x' }, version: 1, at: '2026-01-01' });
  apply(list, { kind: 'reply', parent_id: 'c1', reply_id: 'r1', author: mkAuthor('bob'), text: 'BOB answers', version: 1, at: '2026-01-02' });
  apply(list, { kind: 'delete', id: 'c1', version: 1, actor: mkAuthor('alice'), at: '2026-01-03' });
  const [c] = listAt(list, 1);
  assert(c, 'the whole thread vanished — bob’s answer went with alice’s question');
  assert(c.text === '', `tombstone kept the text: ${JSON.stringify(c.text)}`);
  assert(c.deleted === true, 'tombstone is not marked deleted');
  assert(c.author && c.author.login === 'alice', 'the name must stay on the tombstone');
  assert(c.replies.length === 1 && c.replies[0].text === 'BOB answers', 'the reply did not survive');
});

t('deleting a comment with nothing under it still disappears outright', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('alice'), text: 'alone', anchor: { kind: 'text', text: 'x' }, version: 1, at: '2026-01-01' });
  apply(list, { kind: 'delete', id: 'c1', version: 1, actor: mkAuthor('alice'), at: '2026-01-02' });
  assert(listAt(list, 1).length === 0, 'a tombstone with no thread under it is litter');
});

t('a tombstone drops what the words earned: reactions, verdict, mentions', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('alice'), text: 'ALICE asks', anchor: { kind: 'text', text: 'x' }, version: 1, at: '2026-01-01' });
  apply(list, { kind: 'reply', parent_id: 'c1', reply_id: 'r1', author: mkAuthor('bob'), text: 'BOB answers', version: 1, at: '2026-01-02' });
  apply(list, { kind: 'react', comment_id: 'c1', emoji: '👍', by: 'bob', version: 1, at: '2026-01-02' });
  apply(list, { kind: 'raw_events', id: 'c1', events: [{ kind: 'marked_applied', at_version: 1, at: '2026-01-02', applied_in: 1, by: 'claude', agent_status: 'applied' }] });
  apply(list, { kind: 'delete', id: 'c1', version: 1, actor: mkAuthor('alice'), at: '2026-01-03' });
  const [c] = listAt(list, 1);
  assert(Object.keys(c.reactions).length === 0, `tombstone kept reactions: ${JSON.stringify(c.reactions)}`);
  assert(c.status === 'open' && c.applied_in === undefined, 'tombstone still claims to be resolved');
});

t('a deleted MIDDLE reply is a tombstone too, and keeps its child in place', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('alice'), text: 'top', version: 1, at: '2026-01-01' });
  apply(list, { kind: 'reply', parent_id: 'c1', reply_id: 'r1', author: mkAuthor('bob'), text: 'middle', version: 1, at: '2026-01-02' });
  apply(list, { kind: 'reply', parent_id: 'r1', reply_id: 'r2', author: mkAuthor('alice'), text: 'child of middle', version: 1, at: '2026-01-03' });
  apply(list, { kind: 'delete', id: 'r1', version: 1, actor: mkAuthor('bob'), at: '2026-01-04' });
  const [c] = listAt(list, 1);
  const mid = c.replies.find(r => r.id === 'r1');
  assert(mid, 'the middle reply vanished and orphaned its child');
  assert(mid.text === '' && mid.deleted === true, 'middle reply is not a tombstone');
  assert(mid.author.login === 'bob', 'the name must stay on a reply tombstone');
  const kid = c.replies.find(r => r.id === 'r2');
  assert(kid && kid.parent_id === 'r1', 'the child lost the parent it was answering');
});

t('a deleted reply whose only child was also deleted goes with it', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('alice'), text: 'top', version: 1, at: '2026-01-01' });
  apply(list, { kind: 'reply', parent_id: 'c1', reply_id: 'r1', author: mkAuthor('bob'), text: 'middle', version: 1, at: '2026-01-02' });
  apply(list, { kind: 'reply', parent_id: 'r1', reply_id: 'r2', author: mkAuthor('bob'), text: 'child', version: 1, at: '2026-01-03' });
  apply(list, { kind: 'delete', id: 'r2', version: 1, actor: mkAuthor('bob'), at: '2026-01-04' });
  apply(list, { kind: 'delete', id: 'r1', version: 1, actor: mkAuthor('bob'), at: '2026-01-05' });
  const [c] = listAt(list, 1);
  assert(c.replies.length === 0, `a chain of tombstones holding nothing should collapse: ${JSON.stringify(c.replies)}`);
});

t('an agent comment tombstones on exactly the same terms', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: { kind: 'agent', login: 'claude', name: 'Claude' }, text: 'Rewrote it.', anchor: { kind: 'text', text: 'x' }, version: 1, at: '2026-01-01' });
  apply(list, { kind: 'reply', parent_id: 'c1', reply_id: 'r1', author: mkAuthor('alice'), text: 'thanks', version: 1, at: '2026-01-02' });
  apply(list, { kind: 'delete', id: 'c1', version: 1, actor: mkAuthor('alice'), at: '2026-01-03' });
  const [c] = listAt(list, 1);
  assert(c && c.text === '' && c.deleted === true, 'agent comment did not tombstone');
  assert(c.author.login === 'claude' && c.author.kind === 'agent', 'the agent keeps its name too');
});

t('the agent’s own view (?version=all) still shows no deleted records', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('alice'), text: 'ALICE asks', anchor: { kind: 'text', text: 'x' }, version: 1, at: '2026-01-01' });
  apply(list, { kind: 'reply', parent_id: 'c1', reply_id: 'r1', author: mkAuthor('bob'), text: 'BOB answers', version: 1, at: '2026-01-02' });
  apply(list, { kind: 'delete', id: 'c1', version: 1, actor: mkAuthor('alice'), at: '2026-01-03' });
  // A tombstone has no text to act on; /tdoc edit must not be handed one.
  assert(box.historyList(list).length === 0, 'tdoc-pull would write a blank comment into comments.json');
});

t('an older version still folds to the comment as it stood, not a tombstone', () => {
  const list = [];
  apply(list, { kind: 'create', id: 'c1', author: mkAuthor('alice'), text: 'ALICE asks', anchor: { kind: 'text', text: 'x' }, version: 1, at: '2026-01-01' });
  apply(list, { kind: 'reply', parent_id: 'c1', reply_id: 'r1', author: mkAuthor('bob'), text: 'BOB answers', version: 1, at: '2026-01-02' });
  apply(list, { kind: 'delete', id: 'c1', version: 3, actor: mkAuthor('alice'), at: '2026-01-03' });
  const [atV2] = listAt(list, 2);
  assert(atV2.text === 'ALICE asks' && !atV2.deleted, 'a delete at v3 rewrote v2');
  const [atV3] = listAt(list, 3);
  assert(atV3.text === '' && atV3.deleted === true, 'v3 should be the tombstone');
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
