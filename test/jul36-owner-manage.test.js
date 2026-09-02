// Owner access management is server-gated boot data rendered by React.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const root = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8');
const dialog = fs.readFileSync(path.join(root, 'shell/src/document/owner-access-dialog.jsx'), 'utf8');
const toolbar = fs.readFileSync(path.join(root, 'shell/src/document/document-toolbar.jsx'), 'utf8');
const api = fs.readFileSync(path.join(root, 'shell/src/document/api.js'), 'utf8');
// The lookup moved out of the dialog when the @mention picker started sharing
// it; the guarantee it carries did not move.
const userSearch = fs.readFileSync(path.join(root, 'shell/src/document/github-user-search.js'), 'utf8');

console.log('owner access management');

t('ownerManage defaults null and is populated only inside the owner guard', () => {
  const start = worker.indexOf('let ownerManage = null;');
  const block = worker.slice(start, start + 800);
  assert(start >= 0, 'ownerManage declaration missing');
  assert(block.indexOf('if (isOwner)') > 0, 'owner guard missing');
  assert(block.includes('ownerManage = { access: gate.access, versionCount: versions.length, commentCount }'), 'owner payload missing');
});

t('shellDocumentWorker strips owner data for non-owners', () => {
  // The whole function, not a fixed byte window — a window silently stops
  // covering the gate the moment anything is added above it, which is a test
  // that reports "gate missing" when the gate is right there (#395).
  const start = worker.indexOf('function shellDocumentWorker(');
  const block = worker.slice(start, worker.indexOf('\nfunction ', start + 20));
  assert(block.includes('ownerManage: isOwner ? (ownerManage || null) : null'), 'defense-in-depth owner check missing');
});

t('React Share dialog renders only when ownerManage exists', () => {
  assert(dialog.includes('if (!manage) return null;'), 'owner dialog must render nothing without owner data');
  assert(dialog.includes('export function OwnerAccessDialog'), 'owner access component missing');
  assert(toolbar.includes('{config.ownerManage ? ('), 'owner-only delete menu gate missing');
});

t('access controls cover visibility, commenting, history, and invited users', () => {
  for (const needle of ['visibility', 'commenting', 'history_visibility', 'allowed_users', 'InviteField', 'SegmentedControl']) {
    assert(dialog.includes(needle), `missing access control: ${needle}`);
  }
});

t('access and delete mutations use same-origin session requests', () => {
  assert(api.includes("export function updateDocumentAccess"), 'access API missing');
  assert(api.includes("export function deleteDocument"), 'delete API missing');
  assert(api.includes("credentials: 'same-origin'"), 'session credentials missing');
  assert(!/Authorization|Bearer/.test(dialog), 'owner UI must not ask for or send a token');
});

t('Worker access and delete routes share authorizeOwnerMutation', () => {
  for (const routeStart of [
    "if (p === '/api/doc/access' && method === 'PATCH')",
    "if (p === '/api/doc' && method === 'DELETE')",
  ]) {
    const start = worker.indexOf(routeStart);
    const block = worker.slice(start, start + 2200);
    assert(start >= 0, `${routeStart} missing`);
    assert(block.includes('await authorizeOwnerMutation(req, env, slug)'), `${routeStart} bypasses owner gate`);
  }
});

t('delete uses a styled React confirmation and never native confirm()', () => {
  assert(dialog.includes('export function DeleteDocumentDialog'), 'delete dialog missing');
  assert(dialog.includes('<AppDialog'), 'shared dialog primitive missing');
  assert(!/(^|[^.\w])confirm\(/m.test(dialog), 'native confirm() returned');
});

t('GitHub invite autocomplete remains client-side and token-free', () => {
  assert(/fetch\(`https:\/\/api\.github\.com\/search\/users\?/.test(userSearch), 'GitHub user lookup missing');
  assert(userSearch.includes('AbortController'), 'stale autocomplete request cancellation missing');
  assert(!/Authorization|Bearer|access_token/i.test(userSearch), 'autocomplete sends a credential');
  assert(dialog.includes('useGithubUserSearch'), 'the invite field no longer uses the shared lookup');
  // One implementation, not two: a second copy would drift and would double
  // the unauthenticated rate-limit spend.
  assert(!/api\.github\.com/.test(dialog), 'the dialog has its own copy of the lookup again');
  const field = fs.readFileSync(path.join(root, 'shell/src/document/mention-field.jsx'), 'utf8');
  assert(field.includes('useGithubUserSearch'), 'the @ picker does not share the lookup');
  assert(!/api\.github\.com/.test(field), 'the @ picker has its own copy of the lookup');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
