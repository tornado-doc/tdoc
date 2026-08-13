// Hosted out-of-box publish guards.
//
// Hosted publish must not hand users the provider-wide TDOC_UPLOAD_TOKEN.
// Instead, the Worker mints account-scoped tokens and write routes enforce
// slug ownership before writing document bytes, access policy, comments, or
// deletes.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const worker = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');

function block(startNeedle, endNeedle) {
  const start = worker.indexOf(startNeedle);
  const end = worker.indexOf(endNeedle, start);
  if (start < 0 || end < 0 || end <= start) throw new Error(`block missing: ${startNeedle}`);
  return worker.slice(start, end);
}

const hostedRoute = block("if (p === '/api/hosted/token' && method === 'POST')", '// ---- comments ----');
const uploadRoute = block("if (p === '/api/upload' && method === 'POST')", '// ---- admin access mutation ----');
const accessRoute = block("if (p === '/api/doc/access' && method === 'PATCH')", '// ---- admin delete ----');
const deleteRoute = block("if (p === '/api/doc' && method === 'DELETE')", "return text('Not found'");
const wipeRoute = block("url.searchParams.get('all') === '1'", '// Soft-delete:');
const agentReplyRoute = block("if (p === '/api/agent/reply' && method === 'POST')", '// ---- admin upload');

console.log('hosted out-of-box publish');

t('Worker exposes provider-gated hosted token bootstrap', () => {
  assert(hostedRoute.includes('hostedRegistrationEnabled(env)'), 'hosted route must be registration-gated');
  assert(hostedRoute.includes('issueHostedToken(env, body)'), 'hosted route must mint a token server-side');
  assert(hostedRoute.includes("hosted_registration_disabled"), 'hosted route must return disabled registration error');
  assert(hostedRoute.includes('account_id'), 'hosted route must return account_id');
});

t('Hosted tokens are stored hashed, not in cleartext', () => {
  assert(worker.includes('sha256Hex(token)'), 'token hash helper usage missing');
  assert(worker.includes('hosted-token:${tokenHash}'), 'hosted token records must be keyed by token hash');
  assert(!worker.includes('hosted-token:${token}`'), 'raw hosted tokens must not be KV keys');
});

t('Upload auth accepts either provider admin token or hosted account token', () => {
  assert(worker.includes("actor: { kind: 'admin' }"), 'admin actor branch missing');
  assert(worker.includes("hostedTokenActor(env, token)"), 'hosted token actor branch missing');
  assert(worker.includes("kind: 'hosted'"), 'hosted actor kind missing');
});

t('Hosted upload stamps remote meta ownership before writing', () => {
  assert(uploadRoute.includes('requireDocWriteAccess(env, auth.actor, slug, { create: true })'), 'upload must enforce create/claim write access');
  assert(uploadRoute.includes('stampHostedOwnership(incoming, auth.actor)'), 'upload must stamp hosted owner');
  const gate = uploadRoute.indexOf('requireDocWriteAccess(env, auth.actor, slug, { create: true })');
  const r2 = uploadRoute.indexOf('env.DOCS.put');
  const meta = uploadRoute.indexOf('env.META.put(`meta:${slug}`');
  assert(gate >= 0 && gate < r2, 'upload must enforce owner before R2 write');
  assert(gate < meta, 'upload must enforce owner before META write');
});

t('Hosted slug ownership claim is backed by per-slug Durable Object storage', () => {
  assert(worker.includes('hostedOwner'), 'Durable Object owner storage key missing');
  assert(worker.includes("u.pathname === '/owner'"), 'Durable Object owner endpoint missing');
  assert(worker.includes("kind: 'claim_owner'"), 'atomic owner claim op missing');
  assert(worker.includes("kind: 'verify_owner'"), 'owner verify op missing');
  assert(worker.includes('hostedOwnerOp(env, slug'), 'write gate must use Durable Object owner op');
});

t('Access mutation and delete are scoped to token-owned docs', () => {
  for (const [name, route] of [['access', accessRoute], ['delete', deleteRoute]]) {
    assert(route.includes('requireDocWriteAccess(env, auth.actor, slug)'), `${name}: owner gate missing`);
    const gate = route.indexOf('requireDocWriteAccess(env, auth.actor, slug)');
    const metaWrite = route.indexOf('env.META.put');
    const docDelete = route.indexOf('env.DOCS.delete');
    const firstWrite = [metaWrite, docDelete].filter(i => i >= 0).sort((a, b) => a - b)[0];
    assert(firstWrite === undefined || gate < firstWrite, `${name}: owner gate must precede writes`);
  }
});

t('Admin comment wipe and agent reply are also token-owned-doc scoped', () => {
  for (const [name, route] of [['wipe', wipeRoute], ['agent reply', agentReplyRoute]]) {
    assert(route.includes('requireDocWriteAccess(env, auth.actor, slug)'), `${name}: owner gate missing`);
    const gate = route.indexOf('requireDocWriteAccess(env, auth.actor, slug)');
    const mutate = route.indexOf('mutateComments(env, slug');
    assert(gate >= 0 && mutate >= 0 && gate < mutate, `${name}: owner gate must precede comment mutation`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
