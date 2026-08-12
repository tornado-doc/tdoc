// Auth configuration guardrails.
//
// GitHub's Device Flow authorization screen shows the OAuth App owner/name.
// This test prevents tdoc from silently falling back to a deprecated personal
// app client ID after the project has moved under tornado-doc.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e.message}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(start, i);
}

const root = path.join(__dirname, '..');
const workerSrc = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
const vercelSrc = fs.readFileSync(path.join(root, 'vercel', 'api', 'tdoc.js'), 'utf8');
const wranglerTemplate = fs.readFileSync(path.join(root, 'worker', 'wrangler.toml.template'), 'utf8');

const oldClientId = 'Ov23liZ1UAGOchvKPmlS';

const box = {};
vm.createContext(box);
vm.runInContext([
  sliceFn(workerSrc, 'githubClientId'),
  sliceFn(workerSrc, 'hasGitHubAuth'),
].join('\n\n'), box);

console.log('auth config');

t('worker treats missing/blank GITHUB_CLIENT_ID as auth disabled', () => {
  assert(box.githubClientId({}) === '');
  assert(box.githubClientId({ GITHUB_CLIENT_ID: '   ' }) === '');
  assert(box.hasGitHubAuth({}) === false);
  assert(box.hasGitHubAuth({ GITHUB_CLIENT_ID: '   ' }) === false);
});

t('worker accepts an explicitly configured GitHub OAuth client id', () => {
  assert(box.githubClientId({ GITHUB_CLIENT_ID: 'abc123' }) === 'abc123');
  assert(box.hasGitHubAuth({ GITHUB_CLIENT_ID: 'abc123' }) === true);
});

t('deprecated personal OAuth client id is not baked into worker/vercel/template', () => {
  assert(!workerSrc.includes(oldClientId), 'old client id is still in worker.js');
  assert(!vercelSrc.includes(oldClientId), 'old client id is still in Vercel shim');
  assert(!wranglerTemplate.includes(oldClientId), 'old client id is still in wrangler template');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
