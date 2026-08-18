// Security regression tests for the 2026-06 review fixes (Batch A).
//
// Covers four confirmed findings by extracting the real pure functions from
// worker.js / server.js and asserting the security property each fix
// establishes. Coupled to source: re-runs the actual implementation, so a
// regression that weakens any guard fails here.
//
//   - worker-fork-export-html-comment-injection → forHtmlComment
//   - worker-null-author-authz-bypass           → canMutate (deny-by-default)
//   - server-slug-path-traversal                → safeSlug
//   - server-unauth-csrf-publish                → isLocalMutation
//
// Run with: node test/security.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found — fix missing/renamed`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');

const box = { URL }; // isLocalMutation uses the URL global
vm.createContext(box);
vm.runInContext([
  sliceFn(workerSrc, 'forHtmlComment'),
  sliceFn(workerSrc, 'sessionLogin'),
  sliceFn(workerSrc, 'normalizeGithubLogin'),
  sliceFn(workerSrc, 'hostedGithubLogin'),
  sliceFn(workerSrc, 'isOwnerSession'),
  sliceFn(workerSrc, 'isDocOwnerSession'),
  sliceFn(workerSrc, 'canMutate'),
  sliceFn(serverSrc, 'safeSlug'),
  sliceFn(serverSrc, 'isLocalMutation'),
].join('\n\n'), box);

console.log('security (Batch A review fixes)');

// --- forHtmlComment: fork/export HTML-comment injection ---
t('forHtmlComment neutralizes --> (cannot close an HTML comment)', () => {
  const out = box.forHtmlComment('legit --> <script>alert(1)</script>');
  assert(!out.includes('-->'), 'output still contains a comment terminator');
});
t('forHtmlComment neutralizes <!-- (cannot open a nested comment)', () => {
  const out = box.forHtmlComment('x <!-- y');
  assert(!out.includes('<!--'), 'output still contains a comment opener');
});
t('forHtmlComment preserves benign text intact', () => {
  assert(box.forHtmlComment('hello world @user') === 'hello world @user');
});
t('forHtmlComment handles null/undefined without throwing', () => {
  assert(box.forHtmlComment(null) === '' && box.forHtmlComment(undefined) === '');
});

// --- canMutate: null-author authz bypass (deny-by-default) ---
const ENV = { TDOC_OWNER: 'owner' };
t('canMutate DENIES a stranger on a null-author (legacy) record [the bug]', () => {
  assert(box.canMutate({ author: null }, { login: 'stranger' }, ENV) === false,
    'null-author record must NOT be mutable by an arbitrary signed-in user');
});
t('canMutate DENIES a stranger on someone else’s record', () => {
  assert(box.canMutate({ author: { login: 'alice' } }, { login: 'mallory' }, ENV) === false);
});
t('canMutate ALLOWS the author of the record', () => {
  assert(box.canMutate({ author: { login: 'alice' } }, { login: 'alice' }, ENV) === true);
});
t('canMutate ALLOWS the unhosted worker owner regardless of author', () => {
  assert(box.canMutate({ author: { login: 'alice' } }, { login: 'owner' }, ENV) === true);
  assert(box.canMutate({ author: null }, { login: 'owner' }, ENV) === true, 'owner can clean up legacy null-author records');
});
t('canMutate ALLOWS the hosted publisher, not TDOC_OWNER, on a hosted doc', () => {
  const meta = { hosted: { github_login: 'alice' } };
  assert(box.canMutate({ author: { login: 'bob' } }, { login: 'alice' }, ENV, meta) === true);
  assert(box.canMutate({ author: { login: 'bob' } }, { login: 'owner' }, ENV, meta) === false,
    'operator must not moderate comments on another tenant\'s hosted doc');
});
t('canMutate DENIES when session is null/anonymous', () => {
  assert(box.canMutate({ author: { login: 'alice' } }, null, ENV) === false);
});

// --- safeSlug: path traversal ---
t('safeSlug rejects path traversal', () => {
  assert(box.safeSlug('../secret') === null);
  assert(box.safeSlug('../../etc/passwd') === null);
  assert(box.safeSlug('a/b') === null);
  assert(box.safeSlug('a\\b') === null);
});
t('safeSlug rejects non-strings and overlong', () => {
  assert(box.safeSlug(null) === null);
  assert(box.safeSlug(123) === null);
  assert(box.safeSlug('a'.repeat(65)) === null);
});
t('safeSlug accepts a normal slug', () => {
  assert(box.safeSlug('my-doc_2') === 'my-doc_2');
});

// --- isLocalMutation: CSRF on the unauthenticated local server ---
const hdr = (h) => ({ headers: h });
t('isLocalMutation rejects a CORS-simple text/plain cross-site POST [CSRF vector]', () => {
  assert(box.isLocalMutation(hdr({ 'content-type': 'text/plain' })) === false);
});
t('isLocalMutation rejects a non-local Origin even with JSON content-type', () => {
  assert(box.isLocalMutation(hdr({ 'content-type': 'application/json', origin: 'https://evil.example.com' })) === false);
});
t('isLocalMutation allows same-origin JSON POST (no Origin header)', () => {
  assert(box.isLocalMutation(hdr({ 'content-type': 'application/json' })) === true);
});
t('isLocalMutation allows an explicit localhost Origin JSON POST', () => {
  assert(box.isLocalMutation(hdr({ 'content-type': 'application/json', origin: 'http://localhost:7878' })) === true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
