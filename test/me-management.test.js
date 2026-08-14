// Owner catalog (/me) guard.
//
// 2026-08-13 rework (julie: "删改实在是太丑了 uiux 请improve。而且不能只在/me page"):
// /me is now a clean delete-only catalog — title/slug/version + Delete. The
// per-row visibility/history/commenting/allowed_users dropdowns and the
// admin-token input are GONE: access controls moved to the doc-page Share
// panel (overlay.js showManageModal, see jul36-owner-manage.test.js), and
// Delete now authorizes off the owner's session cookie instead of a pasted
// token (safe only because of the CSP on every doc response — see
// csp.test.js). /me is reachable only by the signed-in owner (route-level
// isOwnerSession redirect), so its own same-origin fetches are already
// cookied.
//
// Gate (小cc review #2): the /me HTML response must not contain access data
// of any kind — especially `allowed_users` — since none of that is rendered
// here anymore.

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

console.log('/me owner catalog');

t('/me no longer exposes the per-row access-control form', () => {
  assert(!index.includes('class="access-form"'), '/me must not render the old access-form');
  assert(!index.includes('name="visibility"'), '/me must not render a visibility control');
  assert(!index.includes('name="history_visibility"'), '/me must not render a history-visibility control');
  assert(!index.includes('name="commenting"'), '/me must not render a commenting control');
  assert(!index.includes('name="allowed_users"'), '/me must not render an allowed-users control');
});

t('/me no longer asks for an admin token', () => {
  assert(!index.includes('id="admin-token"'), '/me must not render the admin-token input');
  assert(!index.includes('Admin token'), '/me must not reference "Admin token" anywhere');
  assert(!index.includes('TDOC_UPLOAD_TOKEN'), '/me HTML must not reference TDOC_UPLOAD_TOKEN');
  assert(!index.includes("'Authorization'"), '/me must not build an Authorization header');
});

t('/me never computes or emits allowed_users (gate: no access data leaks into the catalog)', () => {
  assert(!index.includes('allowed_users'), '/me source must not reference allowed_users at all');
  assert(!index.includes('accessFromMeta'), '/me must not compute an access policy per row anymore');
});

t('/me keeps only title, slug, version, and Delete per row', () => {
  assert(index.includes('doc-title'), 'missing doc title link');
  assert(index.includes('doc-meta'), 'missing slug/version meta line');
  assert(index.includes('class="delete-doc"'), 'missing delete button');
});

t('/me deletes remote docs through DELETE /api/doc using the session (no token)', () => {
  assert(index.includes("fetch('/api/doc?slug=' + encodeURIComponent(slug)"), 'delete button must call remote delete endpoint');
  assert(index.includes("method: 'DELETE'"), 'delete button must use DELETE');
  assert(index.includes("credentials: 'same-origin'"), 'delete fetch should be explicit about sending the session cookie');
  assert(!index.includes("'Authorization': 'Bearer'"), 'delete must not send a bearer token');
  assert(deleteRoute.includes('await authorizeOwnerMutation(req, env)'), 'remote delete must accept session-or-token auth');
});

t('/me still uses the styled confirm modal, never native confirm()', () => {
  const nativeConfirmCall = /(?:^|[^\w.])confirm\(/m;
  const stripped = index.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert(!nativeConfirmCall.test(stripped), '/me must not call the native confirm()');
  assert(index.includes('showConfirm('), '/me must use the styled showConfirm() modal');
  assert(index.includes('dataset.versions'), 'delete confirm copy should be built from data-versions/data-comments (honest N/M copy)');
});

t('/me does not introduce a bespoke cookie-only admin-auth path', () => {
  // The session path now used everywhere is the SHARED authorizeOwnerMutation
  // gate (session OR token) — not a one-off same-origin/cookie check bolted
  // onto just this route.
  assert(!worker.includes('requireAdminAuth'), 'worker must not add a separate cookie-based admin-auth function');
  assert(!worker.includes('isSameOriginRequest'), 'same-origin is not sufficient when docs are arbitrary same-origin HTML');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
