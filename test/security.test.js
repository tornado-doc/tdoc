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
  // Identity widening: the authorship gates now compare actor keys, so an
  // email-only identity can own its own words.
  sliceFn(workerSrc, 'normalizeEmail'),
  sliceFn(workerSrc, 'sessionPrincipal'),
  sliceFn(workerSrc, 'actorKey'),
  sliceFn(workerSrc, 'hostedGithubLogin'),
  sliceFn(workerSrc, 'isOwnerSession'),
  sliceFn(workerSrc, 'isDocOwnerSession'),
  sliceFn(workerSrc, 'canMutate'),
  sliceFn(workerSrc, 'isRecordAuthor'),
  sliceFn(workerSrc, 'isAgentRecord'),
  sliceFn(workerSrc, 'mayDelete'),
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

// --- isRecordAuthor: editing is the author's alone, owner NOT included ---
// canMutate deliberately grants the doc owner (delete/re-anchor). Rewriting
// someone else's words under their name is not one of those powers, so the
// edit path must not fall back to it.
t('isRecordAuthor ALLOWS the author of the record', () => {
  assert(box.isRecordAuthor({ author: { login: 'alice' } }, { login: 'alice' }) === true);
});
t('isRecordAuthor DENIES the doc owner on someone else’s record [the whole point]', () => {
  assert(box.isRecordAuthor({ author: { login: 'alice' } }, { login: 'owner' }) === false);
});
t('isRecordAuthor DENIES a null-author (legacy) record and an anonymous session', () => {
  assert(box.isRecordAuthor({ author: null }, { login: 'owner' }) === false);
  assert(box.isRecordAuthor({ author: { login: 'alice' } }, null) === false);
});
t('the worker edit path checks isRecordAuthor, never canMutate', () => {
  const at = workerSrc.indexOf("if (typeof body.text === 'string') {");
  assert(at !== -1, 'the PATCH edit branch is gone');
  const branch = workerSrc.slice(at, workerSrc.indexOf("if (!slug || !id || !anchor)", at));
  assert(branch.includes('isRecordAuthor(target, s)'), 'the edit branch does not check the author');
  assert(!/canMutate\(/.test(branch), 'the edit branch fell back to the owner-granting gate');
});
t('the worker delete path checks mayDelete, never canMutate', () => {
  // The doc owner used to be able to delete anybody's comment here. Taking
  // someone's words off the page belongs to whoever wrote them.
  const at = workerSrc.indexOf("if (p === '/api/comments' && method === 'DELETE') {");
  assert(at !== -1, 'the DELETE route is gone');
  const branch = workerSrc.slice(at, workerSrc.indexOf("kind: 'delete'", at));
  assert(branch.includes('mayDelete(target, s, env, meta)'), 'the delete branch does not check mayDelete');
  // The call, not the word: the comment above the route explains why canMutate
  // is deliberately not used here.
  assert(!/canMutate\(/.test(branch), 'the delete branch still grants the doc owner');
});

// --- mayDelete: your own words, and an agent's if the doc is yours ---
// /api/agent/reply is authed with the doc's upload token, so an agent is the
// owner writing through a tool, not a third party with speech of its own.
t('mayDelete ALLOWS the author of a human comment', () => {
  assert(box.mayDelete({ author: { login: 'alice' } }, { login: 'alice' }, ENV) === true);
});
t('mayDelete DENIES the doc owner on a human comment [#349 point 3]', () => {
  assert(box.mayDelete({ author: { login: 'alice' } }, { login: 'owner' }, ENV) === false);
});
t('mayDelete ALLOWS the doc owner on an AGENT comment', () => {
  assert(box.mayDelete({ author: { kind: 'agent', login: 'claude' } }, { login: 'owner' }, ENV) === true);
});
t('mayDelete DENIES a stranger on an agent comment', () => {
  assert(box.mayDelete({ author: { kind: 'agent', login: 'claude' } }, { login: 'mallory' }, ENV) === false);
});
t('mayDelete DENIES everyone on a null-author legacy record except by ownership of an agent', () => {
  assert(box.mayDelete({ author: null }, { login: 'owner' }, ENV) === false,
    'a record with no author is not an agent record');
  assert(box.mayDelete({ author: null }, { login: 'alice' }, ENV) === false);
});
t('mayDelete on a hosted doc follows the publisher, not TDOC_OWNER', () => {
  const meta = { hosted: { github_login: 'alice' } };
  const agent = { author: { kind: 'agent', login: 'claude' } };
  assert(box.mayDelete(agent, { login: 'alice' }, ENV, meta) === true, 'the publisher owns what its agent said');
  assert(box.mayDelete(agent, { login: 'owner' }, ENV, meta) === false, 'TDOC_OWNER does not own someone else’s hosted doc');
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

// --- shell comment card: delete / re-anchor are author-or-owner affordances ---
// The React shell replaced the overlay's `canDelete` gate and shipped without
// it, so every reader saw "delete" and "move anchor" on everyone's comments —
// the worker's 403 (`not_author`) was the only thing left. Source-level because
// the UI suites need playwright; these assert the gate exists and is wired.
const cardSrc = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'document', 'comment-card.jsx'), 'utf8');
const layerSrc = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'document', 'comment-layer.jsx'), 'utf8');
const shellSrc = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'document-shell.jsx'), 'utf8');

// True when `needle` sits inside a `{canMutate ? ... : null}` block.
function gatedByCanMutate(src, needle) {
  const at = src.indexOf(needle);
  if (at === -1) throw new Error(`${needle} not found in comment-card.jsx`);
  const open = src.lastIndexOf('{canMutate ? (', at);
  if (open === -1) return false;
  const close = src.indexOf(') : null}', open);
  return close !== -1 && close > at;
}

// The condition guarding EVERY occurrence of `needle`, in source order. A
// delete button that escapes its gate shows up here as an unexpected string
// (or null when nothing closes the block), so a second, ungated copy of the
// control cannot pass by hiding behind the first one.
function gatesAround(src, needle) {
  const gates = [];
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
    const arm = src.lastIndexOf('? (', at);
    const open = src.lastIndexOf('{', arm);
    const close = src.indexOf(') : null}', arm);
    gates.push(close !== -1 && close > at ? src.slice(open + 1, arm).trim() : null);
  }
  return gates;
}

t('comment card derives the mutate gate from the author login or doc owner', () => {
  const decl = cardSrc.slice(cardSrc.indexOf('function mayMutate'), cardSrc.indexOf('function mayMutate') + 400);
  assert(decl.includes('isOwner'), 'mayMutate ignores the doc owner');
  assert(decl.includes('item.author?.login') && decl.includes('currentUser'),
    'mayMutate does not compare the author to the signed-in viewer');
  assert(cardSrc.includes('const canMutate = mayMutate(comment, currentUser, isOwner);'),
    'the root comment no longer runs through mayMutate');
});
t('comment card renders delete for the author, and for the owner only on an agent record', () => {
  // Two deletes: the comment's and — since replies stopped being dead ends
  // (#343) — every reply's. Both were the author's OR the doc owner's until
  // #349; deleting someone else's words is not an owner's power. An agent's
  // words are the exception, because they are the owner's own token speaking.
  const gates = gatesAround(cardSrc, 'className="del"');
  assert(gates.length === 2, `expected a delete on the comment and on replies, found ${gates.length}`);
  assert(gates.includes('canDelete'), "the comment's delete is not gated by mayDelete");
  assert(gates.includes('mayDelete(reply, currentUser, isOwner)'),
    "a reply's delete is not gated by mayDelete");
  assert(!gates.some((g) => g && /canMutate|mayMutate/.test(g)),
    'a delete is still gated by the re-anchor gate');
  const decl = cardSrc.slice(cardSrc.indexOf('function mayDelete'), cardSrc.indexOf('function mayDelete') + 300);
  assert(/kind === 'agent'/.test(decl), 'the owner’s reach must be limited to agent-authored records');
});
t('comment card derives the your-own gate from the author alone, never the owner', () => {
  const decl = cardSrc.slice(cardSrc.indexOf('function authoredBy'), cardSrc.indexOf('function authoredBy') + 400);
  assert(decl.includes('item.author?.login') && decl.includes('currentUser'),
    'authoredBy does not compare the author to the signed-in viewer');
  assert(!decl.includes('isOwner'), 'authoredBy grants the doc owner — it must not');
});
t('comment card renders edit only for the author, on the comment and on replies', () => {
  const gates = gatesAround(cardSrc, 'className="tdoc-edit-toggle"');
  assert(gates.length === 2, `expected an edit on the comment and on replies, found ${gates.length}`);
  assert(gates.includes('isMine'), "the comment's edit is not gated by authoredBy");
  assert(gates.includes('authoredBy(reply, currentUser)'), "a reply's edit is not gated by authoredBy");
  assert(cardSrc.includes('const isMine = authoredBy(comment, currentUser);'),
    'the root comment no longer runs through authoredBy');
});
t('the re-anchor gate is the only thing left that the doc owner unlocks', () => {
  assert(gatedByCanMutate(cardSrc, 'tdoc-anchor-actions'), 're-anchor action is not gated by canMutate');
  assert(cardSrc.split('mayMutate(').length === 3,
    'mayMutate should be declared once and called once — for the re-anchor only');
});
t('comment card renders the re-anchor button only for the author or the doc owner', () => {
  assert(gatedByCanMutate(cardSrc, 'tdoc-anchor-actions'), 're-anchor action is not gated by canMutate');
});
t('both comment layers forward isOwner to the card', () => {
  assert(layerSrc.split('isOwner={isOwner}').length === 3,
    'desktop layer and mobile drawer must both pass isOwner to CommentCard');
});
t('the document shell sources isOwner from the boot config', () => {
  assert(shellSrc.split('isOwner={Boolean(config.isOwner)}').length === 3,
    'both comment layers must receive config.isOwner');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
