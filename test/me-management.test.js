// Owner catalog remote-management guard.
//
// /me is the product management surface for remote source-of-truth docs. Since
// published docs are arbitrary HTML on the same origin, remote writes must NOT
// rely on the owner session cookie alone. The page asks for an admin token and
// keeps it in memory only.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const worker = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
const start = worker.indexOf('async function indexHtml(env, session)');
const end = worker.indexOf('// ─────────────────────────────────────────────────────────────────────────', start);
if (start < 0 || end < 0 || end <= start) throw new Error('indexHtml block missing');
const index = worker.slice(start, end);

const deleteStart = worker.indexOf("if (p === '/api/doc' && method === 'DELETE')");
const deleteEnd = worker.indexOf("return text('Not found'", deleteStart);
if (deleteStart < 0 || deleteEnd < 0 || deleteEnd <= deleteStart) throw new Error('/api/doc DELETE block missing');
const deleteRoute = worker.slice(deleteStart, deleteEnd);

console.log('/me remote management UI');

t('/me exposes remote access controls for hosted docs', () => {
  assert(index.includes('class="access-form"'), 'missing access form');
  assert(index.includes('name="visibility"'), 'missing visibility control');
  assert(index.includes('name="history_visibility"'), 'missing history visibility control');
  assert(index.includes('name="commenting"'), 'missing commenting control');
  assert(index.includes('name="allowed_users"'), 'missing allowed users control');
});

t('/me asks for an admin token without embedding the deployment secret', () => {
  assert(index.includes('id="admin-token"'), 'missing admin token input');
  assert(index.includes('type="password"'), 'admin token input should not be plain text');
  assert(index.includes('autocomplete="off"'), 'admin token should not be browser-stored by default');
  assert(!index.includes('TDOC_UPLOAD_TOKEN'), '/me HTML must not reference TDOC_UPLOAD_TOKEN');
});

t('/me saves access through the remote access endpoint with a bearer token', () => {
  assert(index.includes("fetch('/api/doc/access'"), 'access form must call remote access endpoint');
  assert(index.includes("method: 'PATCH'"), 'access form must PATCH');
  assert(index.includes("'Authorization': 'Bearer ' + token"), 'access form must send bearer token');
  assert(!index.includes("credentials: 'same-origin'"), 'remote writes must not rely on owner session cookies');
  assert(index.includes('JSON.stringify({ slug, access })'), 'access form must send slug + access only');
});

t('/me deletes remote docs through DELETE /api/doc with a bearer token', () => {
  assert(index.includes("fetch('/api/doc?slug=' + encodeURIComponent(slug)"), 'delete button must call remote delete endpoint');
  assert(index.includes("method: 'DELETE'"), 'delete button must use DELETE');
  assert(index.includes("headers,"), 'delete button must send auth headers');
  assert(deleteRoute.includes('await requireUploadAuth(req, env)'), 'remote delete must keep upload-token auth');
});

t('/me does not introduce owner-cookie admin writes', () => {
  assert(!worker.includes('requireAdminAuth'), 'worker must not add cookie-based admin writes on same origin as arbitrary docs');
  assert(!worker.includes('isSameOriginRequest'), 'same-origin is not sufficient when docs are arbitrary same-origin HTML');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
