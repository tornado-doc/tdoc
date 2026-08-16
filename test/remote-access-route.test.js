// Remote access mutation route guard.
//
// This route can turn a private document public. It must stay upload-token
// gated, mutate only meta.access, and never touch document bytes.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const worker = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');

const start = worker.indexOf("if (p === '/api/doc/access' && method === 'PATCH')");
const end = worker.indexOf('// ---- admin delete ----', start);
if (start < 0 || end < 0 || end <= start) throw new Error('/api/doc/access route block missing');
const route = worker.slice(start, end);

const uploadStart = worker.indexOf("if (p === '/api/upload' && method === 'POST')");
const uploadEnd = worker.indexOf('// ---- admin access mutation ----', uploadStart);
if (uploadStart < 0 || uploadEnd < 0 || uploadEnd <= uploadStart) throw new Error('/api/upload route block missing');
const uploadRoute = worker.slice(uploadStart, uploadEnd);

console.log('remote access mutation route');

t('CORS allows PATCH for remote access mutation', () => {
  assert(worker.includes("'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'"),
    'PATCH missing from Access-Control-Allow-Methods');
});

t('PATCH /api/doc/access authenticates (session-or-token) before writing meta', () => {
  // Hosted tokens are slug-scoped, so the route reads `slug` from the body
  // first, then runs the shared authorizeOwnerMutation(req, env, slug) gate.
  // No META write may happen before that gate.
  const auth = route.indexOf('await authorizeOwnerMutation(req, env, slug)');
  const write = route.indexOf('env.META.put(`meta:${slug}`');
  assert(auth >= 0, 'route must call authorizeOwnerMutation with the slug');
  assert(write >= 0, 'route should persist meta after auth');
  assert(auth < write, 'auth must happen before META write');
});

t('PATCH /api/doc/access rejects oversized Content-Length before req.json', () => {
  const guard = route.indexOf('ACCESS_PATCH_MAX_BYTES');
  const parse = route.indexOf('await req.json()');
  assert(guard >= 0, 'route must define an access-patch size cap');
  assert(route.includes("error: 'payload_too_large'"), 'route must return payload_too_large');
  assert(route.includes('status: 413'), 'route must use HTTP 413');
  assert(parse >= 0 && guard < parse, 'Content-Length guard must run before req.json()');
});

t('PATCH /api/doc/access only writes remote meta, never document bytes', () => {
  assert(route.includes('applyAccessPatch(meta, access)'), 'route must use access-only helper');
  assert(route.includes('env.META.put(`meta:${slug}`'), 'route must write updated meta');
  assert(!route.includes('env.DOCS.put'), 'route must not write R2 document HTML');
  assert(!route.includes('env.DOCS.delete'), 'route must not delete R2 document HTML');
  assert(!route.includes('mutateComments'), 'route must not mutate comments');
});

t('PATCH /api/doc/access rejects top-level fields outside slug/access', () => {
  assert(route.includes("k !== 'slug' && k !== 'access'"), 'route must whitelist top-level fields');
  assert(route.includes("json({ error: 'invalid_field'"), 'route must reject top-level unknown fields');
});

t('PATCH /api/doc/access returns invalid value details without writing', () => {
  assert(route.includes("error: next.error"), 'route should surface helper errors');
  assert(route.includes("field: next.field"), 'route should surface the invalid access field');
  const error = route.indexOf('if (next.error)');
  const write = route.indexOf('env.META.put(`meta:${slug}`');
  assert(error >= 0 && write >= 0 && error < write, 'route must reject invalid access before META write');
});

t('POST /api/upload validates incoming access before writing document bytes', () => {
  assert(uploadRoute.includes('validateAccessWrite(incoming.access)'), 'upload route must validate incoming access');
  const validate = uploadRoute.indexOf('validateAccessWrite(incoming.access)');
  const r2Write = uploadRoute.indexOf('env.DOCS.put');
  const metaWrite = uploadRoute.indexOf('env.META.put(`meta:${slug}`');
  assert(validate >= 0 && r2Write >= 0 && metaWrite >= 0, 'upload route missing validation/R2/meta operations');
  assert(validate < r2Write, 'upload must reject invalid access before writing R2 document bytes');
  assert(validate < metaWrite, 'upload must reject invalid access before writing meta');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
