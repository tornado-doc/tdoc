// Helper-drift guard (Batch E, patch-smell mitigation).
//
// Finding dup-safejson-injectoverlay-cyrb53: a few correctness-relevant helpers
// are copy-pasted across worker.js / server.js / overlay.js with a "must stay
// identical" contract. tdoc's bundle model (overlay.js is string-inlined into
// the worker; server.js is a separate local process) makes a single shared
// module awkward, so rather than a risky build-system change we convert SILENT
// drift into a CAUGHT regression: this test fails the build if the duplicated
// copies diverge in behavior. Whitespace/indentation differences are ignored
// (overlay lives inside an IIFE and is indented); only the normalized body
// matters.
//
// Run with: node test/no-drift.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Extract a function body by brace matching, then normalize whitespace so
// indentation/line-break differences don't count as drift.
function fnBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  // Skip the parameter list so default values like `body = {}` don't
  // get treated as the function body.
  let i = src.indexOf('(', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  while (i < src.length && src[i] !== '{') i++;
  depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const norm = (s) => s == null ? null : s.replace(/\s+/g, ' ').trim();

const worker = read('worker/worker.js');
const server = read('server/server.js');
const overlay = read('server/overlay.js');
const githubOauth = require(path.join(root, 'shared/github-oauth.js'));

console.log('no-drift (duplicated helper guard)');

t('GITHUB_CLIENT_ID has a single SoT (shared/github-oauth.js)', () => {
  const id = githubOauth.GITHUB_CLIENT_ID;
  assert(typeof id === 'string' && /^Ov[\w]+$/.test(id), `bad SoT client id: ${id}`);
  const template = read('worker/wrangler.toml.template');
  assert(template.includes(`GITHUB_CLIENT_ID = "${id}"`),
    'wrangler.toml.template must ship the SoT client id for CD/BYOK defaults');
  const vercelApi = read('vercel/api/tdoc.js');
  assert(vercelApi.includes('githubOauth.GITHUB_CLIENT_ID'),
    'vercel/api/tdoc.js must read the client id from github-oauth SoT');
  assert(!vercelApi.includes(id),
    'vercel/api/tdoc.js must not hardcode the client id');
  assert(!read('SKILL.md').includes('Ov23liZ1UAGOchvKPmlS'),
    'SKILL.md still mentions the old personal-account OAuth client id');
  for (const rel of [
    'vercel/api/tdoc.js',
    'shared/github-oauth.js',
  ]) {
    // shared owns the literal; vercel must not duplicate it
  }
  assert(read('shared/github-oauth.js').includes(id), 'SoT module missing its own id');
  assert(!read('vercel/api/tdoc.js').includes('Ov23liZ1UAGOchvKPmlS'),
    'vercel still hardcodes the retired personal OAuth client id');
  assert(!template.includes('Ov23liZ1UAGOchvKPmlS'),
    'wrangler.toml.template still hardcodes the retired personal OAuth client id');
  assert(read('bin/tdoc-publish').includes('shared/github-oauth.js'),
    'tdoc-publish must read GITHUB_CLIENT_ID from shared/github-oauth.js (BYOK backfill)');
});

t('safeJsonForScript is identical in worker.js and server.js', () => {
  const a = norm(fnBody(worker, 'safeJsonForScript'));
  const b = norm(fnBody(server, 'safeJsonForScript'));
  assert(a && b, 'safeJsonForScript missing from one of the files');
  assert(a === b, `safeJsonForScript has DRIFTED between worker.js and server.js:\n      worker: ${a}\n      server: ${b}`);
});

t('cyrb53 algorithm body is identical in worker.js and overlay.js (modulo indentation)', () => {
  const a = norm(fnBody(worker, 'cyrb53'));
  const b = norm(fnBody(overlay, 'cyrb53'));
  assert(a && b, 'cyrb53 missing from one of the files');
  assert(a === b, `cyrb53 has DRIFTED between worker.js and overlay.js:\n      worker: ${a}\n      overlay: ${b}`);
});

for (const name of ['isAnthropicCompanyMark', 'logoForAgentLogin', 'isGenericAgentLogin', 'detectAgentRuntime', 'agentIdentity']) {
  t(`${name} is identical in worker.js and server.js`, () => {
    const a = norm(fnBody(worker, name));
    const b = norm(fnBody(server, name));
    assert(a && b, `${name} missing from one of the files`);
    assert(a === b, `${name} has DRIFTED between worker.js and server.js:\n      worker: ${a}\n      server: ${b}`);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
