// JUL-31 access policy pure-function regressions.
// Extracts the access-policy block from worker.js as one contiguous chunk.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
const start = workerSrc.indexOf('// Access policy (JUL-31)');
const end = workerSrc.indexOf('function agentIdentity(');
if (start < 0 || end < 0 || end <= start) throw new Error('access policy block markers missing');
// isOwnerSession is defined earlier and is a dependency.
const ownerStart = workerSrc.indexOf('function isOwnerSession(');
let i = workerSrc.indexOf('{', ownerStart), depth = 0;
for (; i < workerSrc.length; i++) {
  if (workerSrc[i] === '{') depth++;
  else if (workerSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
}
const isOwnerFn = workerSrc.slice(ownerStart, i);
const block = isOwnerFn + '\n' + workerSrc.slice(start, end);

const box = {};
vm.createContext(box);
vm.runInContext(block, box);

const ENV = { TDOC_OWNER: 'julie' };
const owner = { login: 'julie' };
const alice = { login: 'alice' };
const bob = { login: 'bob' };

console.log('access policy (JUL-31)');

t('legacy missing access defaults to public + public history', () => {
  const a = box.accessFromMeta({});
  assert(a.visibility === 'public');
  assert(a.history_visibility === 'public');
  assert(a.commenting === 'signed_in');
});

t('explicit private access normalizes allowlist logins', () => {
  const a = box.normalizeAccess({
    visibility: 'private',
    history_visibility: 'owner',
    commenting: 'invited',
    allowed_users: ['github:Alice', '@Bob', 'alice', '!!!', ''],
  }, { legacy: false });
  assert(a.visibility === 'private');
  assert(JSON.stringify(a.allowed_users) === JSON.stringify(['alice', 'bob']));
});

t('new (non-legacy) defaults are unlisted + owner history', () => {
  const a = box.normalizeAccess({}, { legacy: false });
  assert(a.visibility === 'unlisted');
  assert(a.history_visibility === 'owner');
});

t('public/unlisted readable by anyone; private requires allowlist', () => {
  const pub = box.normalizeAccess({ visibility: 'public' });
  const unlist = box.normalizeAccess({ visibility: 'unlisted' });
  const priv = box.normalizeAccess({ visibility: 'private', allowed_users: ['alice'] });
  assert(box.canReadDoc(pub, null, ENV) === true);
  assert(box.canReadDoc(unlist, null, ENV) === true);
  assert(box.canReadDoc(priv, null, ENV) === false);
  assert(box.canReadDoc(priv, alice, ENV) === true);
  assert(box.canReadDoc(priv, bob, ENV) === false);
  assert(box.canReadDoc(priv, owner, ENV) === true);
});

t('history_visibility owner hides picker from allowlisted non-owner', () => {
  const a = box.normalizeAccess({
    visibility: 'private',
    history_visibility: 'owner',
    allowed_users: ['alice'],
  });
  assert(box.canSeeHistory(a, owner, ENV) === true);
  assert(box.canSeeHistory(a, alice, ENV) === false);
  assert(box.canSeeHistory(a, null, ENV) === false);
});

t('history_visibility invited allows allowlist', () => {
  const a = box.normalizeAccess({
    visibility: 'private',
    history_visibility: 'invited',
    allowed_users: ['alice'],
  });
  assert(box.canSeeHistory(a, alice, ENV) === true);
  assert(box.canSeeHistory(a, bob, ENV) === false);
});

t('commenting gates: off / signed_in / owner / invited', () => {
  const off = box.normalizeAccess({ commenting: 'off' });
  const signed = box.normalizeAccess({ commenting: 'signed_in' });
  const own = box.normalizeAccess({ commenting: 'owner' });
  const inv = box.normalizeAccess({ commenting: 'invited', allowed_users: ['alice'] });
  assert(box.canCommentOnDoc(off, alice, ENV) === false);
  assert(box.canCommentOnDoc(signed, alice, ENV) === true);
  assert(box.canCommentOnDoc(signed, null, ENV) === false);
  assert(box.canCommentOnDoc(own, alice, ENV) === false);
  assert(box.canCommentOnDoc(own, owner, ENV) === true);
  assert(box.canCommentOnDoc(inv, alice, ENV) === true);
  assert(box.canCommentOnDoc(inv, bob, ENV) === false);
});

t('invalid visibility falls back by legacy mode', () => {
  assert(box.normalizeAccess({ visibility: 'nope' }, { legacy: true }).visibility === 'public');
  assert(box.normalizeAccess({ visibility: 'nope' }, { legacy: false }).visibility === 'unlisted');
});

t('remote access patch preserves document meta and mutates only access', () => {
  const meta = {
    title: 'Doc',
    versions: [{ n: 1 }],
    owner: 'must-not-change',
    access: {
      visibility: 'private',
      history_visibility: 'owner',
      commenting: 'signed_in',
      allowed_users: ['alice'],
    },
  };
  const r = box.applyAccessPatch(meta, {
    visibility: 'public',
    history_visibility: 'public',
    allowed_users: ['github:Bob', '@alice'],
  });
  assert(!r.error, `unexpected error ${r.error}`);
  assert(r.meta !== meta, 'must return a new meta object');
  assert(meta.access.visibility === 'private', 'must not mutate input meta');
  assert(r.meta.title === 'Doc' && r.meta.versions.length === 1, 'non-access meta was not preserved');
  assert(r.meta.owner === 'must-not-change', 'non-access fields should pass through unchanged');
  assert(r.access.visibility === 'public');
  assert(r.access.history_visibility === 'public');
  assert(r.access.commenting === 'signed_in');
  assert(JSON.stringify(r.access.allowed_users) === JSON.stringify(['bob', 'alice']));
});

t('remote access patch creates product defaults for legacy meta', () => {
  const r = box.applyAccessPatch({ title: 'Legacy' }, { visibility: 'private' });
  assert(!r.error, `unexpected error ${r.error}`);
  assert(r.access.visibility === 'private');
  assert(r.access.history_visibility === 'owner', 'newly managed access must not inherit legacy public history');
  assert(r.access.commenting === 'signed_in');
  assert(JSON.stringify(r.access.allowed_users) === JSON.stringify([]));
});

t('remote access patch rejects non-access fields', () => {
  const r = box.applyAccessPatch({ title: 'Doc' }, { visibility: 'private', owner: 'mallory' });
  assert(r.error === 'invalid_access_field', `expected invalid_access_field, got ${r.error}`);
  assert(JSON.stringify(r.fields) === JSON.stringify(['owner']), `unexpected fields ${JSON.stringify(r.fields)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
