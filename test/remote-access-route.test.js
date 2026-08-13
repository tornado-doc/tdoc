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

console.log('remote access mutation route');

t('CORS allows PATCH for remote access mutation', () => {
  assert(worker.includes("'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'"),
    'PATCH missing from Access-Control-Allow-Methods');
});

t('PATCH /api/doc/access authenticates before parsing body or writing meta', () => {
  const auth = route.indexOf('await requireUploadAuth(req, env)');
  const body = route.indexOf('await req.json()');
  const write = route.indexOf('env.META.put(`meta:${slug}`');
  assert(auth >= 0, 'route must call requireUploadAuth');
  assert(body >= 0, 'route should parse request JSON after auth');
  assert(write >= 0, 'route should persist meta after auth');
  assert(auth < body, 'auth must happen before body parse');
  assert(auth < write, 'auth must happen before META write');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
