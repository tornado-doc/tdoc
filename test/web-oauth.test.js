// Web OAuth redirect flow (browsers), alongside the existing device flow.
//
// Device flow strands phone users: after Approve they sit on GitHub's
// "Congratulations" page while the tab that was polling is somewhere they
// can't find. The redirect flow hands the whole tab to GitHub and GitHub sends
// it back signed in. This guards the security-critical piece (the post-login
// redirect target can't be pointed off-site) with real behaviour, and pins the
// structure so the flow — and its safe fallback to device flow — can't silently
// regress.
//
// Run with: node test/web-oauth.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const worker = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
const documentShell = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'document-shell.jsx'), 'utf8');
const neutralLanding = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'neutral-landing.jsx'), 'utf8');
const signInDialog = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'sign-in-dialog.jsx'), 'utf8');
const tomlProd = fs.readFileSync(path.join(__dirname, '..', 'worker', 'wrangler.toml.template'), 'utf8');
const tomlPrev = fs.readFileSync(path.join(__dirname, '..', 'worker', 'wrangler.preview.toml.template'), 'utf8');

// VM-extract sanitizeReturn from worker.js so we test its real behaviour, not a
// copy. (Same approach as overlay-pure.test.js.)
function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`fn ${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const box = {};
vm.createContext(box);
vm.runInContext(sliceFn(worker, 'sanitizeReturn'), box);
const { sanitizeReturn } = box;

console.log('web OAuth redirect flow');

// --- sanitizeReturn: the open-redirect guard ---
t('same-origin paths pass through untouched', () => {
  assert(sanitizeReturn('/d/conway-life/v/2') === '/d/conway-life/v/2', 'doc path');
  assert(sanitizeReturn('/me') === '/me', '/me');
  assert(sanitizeReturn('/?notice=x') === '/?notice=x', 'query kept');
});

t('off-site and protocol-relative targets are refused', () => {
  assert(sanitizeReturn('//evil.com') === '/', 'protocol-relative //');
  assert(sanitizeReturn('https://evil.com') === '/', 'absolute https');
  assert(sanitizeReturn('http://evil.com') === '/', 'absolute http');
  assert(sanitizeReturn('/\\evil.com') === '/', 'backslash smuggling');
  assert(sanitizeReturn('javascript:alert(1)') === '/', 'scheme');
});

t('empty / non-string / control chars fall back to root', () => {
  assert(sanitizeReturn('') === '/', 'empty');
  assert(sanitizeReturn(null) === '/', 'null');
  assert(sanitizeReturn(undefined) === '/', 'undefined');
  assert(sanitizeReturn('/a\nb') === '/', 'newline');
  assert(sanitizeReturn('/a\x00b') === '/', 'NUL');
});

// --- structure: the redirect flow exists and is wired correctly ---
t('the worker serves the authorize redirect and the token-exchange callback', () => {
  assert(/p === '\/api\/auth\/web\/login'/.test(worker), 'no /api/auth/web/login route');
  assert(/login\/oauth\/authorize/.test(worker), 'never sends the visitor to GitHub authorize');
  assert(/p === '\/auth\/github\/callback'/.test(worker), 'no callback route');
  assert(/client_secret: env\.GITHUB_CLIENT_SECRET/.test(worker),
    'the callback must exchange the code using the client secret');
});

t('the callback is CSRF-guarded and mints the same session as device flow', () => {
  assert(/tdoc_oauth=/.test(worker), 'no state cookie for CSRF');
  assert(/oauthstate:/.test(worker), 'no server-side state/return record');
  assert(/state !== cookieNonce/.test(worker), 'state is not checked against the cookie');
  assert(/session:\$\{sid\}/.test(worker) && /tdoc_sid=\$\{sid\}/.test(worker),
    'the callback must mint the same tdoc_sid session');
});

t('a callback with no code stays a friendly static page (device soft-landing)', () => {
  assert(/if \(!code\) return authStatusResponse\(/.test(worker),
    'a code-less callback must not error — it is the device-flow soft landing');
});

// --- graceful fallback: no secret ⇒ device flow, nothing breaks ---
t('web flow is gated on the secret so a deploy without it keeps device flow', () => {
  assert(/if \(!env\.GITHUB_CLIENT_SECRET\)/.test(worker),
    'the worker must guard the web routes on the secret');
  assert(/webAuth: !!webAuth/.test(worker) || /webAuth: !!env\.GITHUB_CLIENT_SECRET/.test(worker),
    'the page cfg must expose webAuth from the secret');
});

t('React surfaces take the redirect when webAuth is on, else the device modal', () => {
  assert(/config\.webAuth/.test(documentShell), 'document shell does not branch on webAuth');
  assert(/\/api\/auth\/web\/login\?return=/.test(documentShell),
    'document shell does not hand off to the web login route');
  assert(/boot\.webAuth/.test(neutralLanding), 'neutral landing does not branch on webAuth');
  assert(/<SignInDialog/.test(documentShell) && /tdoc-device-code/.test(signInDialog),
    'the device-code modal must remain as the fallback');
});

t('both wrangler templates document GITHUB_CLIENT_SECRET as a secret, not a var', () => {
  for (const [name, toml] of [['prod', tomlProd], ['preview', tomlPrev]]) {
    assert(/wrangler secret put GITHUB_CLIENT_SECRET/.test(toml),
      `${name} template must document the secret via 'wrangler secret put'`);
    assert(!/^\s*GITHUB_CLIENT_SECRET\s*=/m.test(toml),
      `${name} template must NOT put the secret in [vars]`);
  }
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
