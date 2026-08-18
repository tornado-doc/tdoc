// Onboarding (#142): the /start page, the modal served with it, and the route.
//
// The flow this file guards was rewritten once already. It used to open with a
// GitHub device-flow sign-in, then ask which runtime you use, then hand over a
// token. Every one of those steps turned out to be friction with nothing
// behind it, so the assertions here are mostly about what must NOT come back.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'landing', 'tdoc-start', 'meta.json'), 'utf8'));
const latest = meta.versions[meta.versions.length - 1].n;
const html = fs.readFileSync(path.join(root, 'landing', 'tdoc-start', `v${latest}`, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
const onboard = fs.readFileSync(path.join(root, 'server', 'onboard.js'), 'utf8');
const text = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');

console.log('onboarding /start (#142)');

t('the page runs no author JavaScript', () => {
  // Published docs run under a nonce-only CSP, so an author <script> never
  // executes. A page that needed one would look right in a local preview and
  // be dead in production.
  assert(!/<script\b/i.test(html), 'page contains a <script> tag; CSP will not run it');
  assert(!/\son[a-z]+\s*=\s*["']/i.test(html), 'page contains an inline event handler');
});

t('teaches the loop on the real published doc', () => {
  assert(/\/d\/tornado-doc\//.test(html) || /conway/i.test(html),
    'the example must point at a real published doc, not a mockup');
});

t('never asks which runtime you use', () => {
  // Only Claude Code has a documented `/plugin` line, Codex is a git clone,
  // and three runtimes have none. ONBOARDING.md also says an agent cannot run
  // `/plugin` for the user — so the agent reads the guide and installs itself.
  assert(!/plugin marketplace add/.test(html) && !/plugin marketplace add/.test(onboard),
    'a /plugin line is back; it is Claude Code only and agents cannot run it');
  assert(/ONBOARDING\.md/.test(onboard), 'the paste line must point the agent at the setup guide');
});

t('sign-in is step one, and is skippable', () => {
  // It leads now because of what it buys: since #156 the hosted mint is
  // session-gated, so signing in is what turns step two into "paste, get a
  // link" with nothing to set up, and the same login remints the same account
  // so the doc stays recoverable. It must stay skippable, because publishing
  // to a host you own needs no account at all.
  assert(/function stepSignIn/.test(onboard), 'the sign-in step is gone');
  assert(/tdo-skip/.test(onboard), 'the sign-in step must be skippable');
  assert(/authConfigured === false/.test(onboard),
    'a host with no auth configured must not be asked to sign in');
  assert(/cfg\.identity && cfg\.identity\.login/.test(onboard),
    'someone already signed in must not be asked again');
  // Reuse, not a second device flow.
  assert(/getElementById\('tdoc-signin'\)/.test(onboard),
    'must reuse the overlay device flow rather than building a parallel one');
  assert(!/device\/start|device\/poll/.test(onboard),
    'a second device flow implementation is back in the modal');
});

t('the first doc is a Game of Life lesson, not a blank noun', () => {
  // The first doc has to be worth commenting on, because commenting on it is
  // the lesson. A live artifact plus a tutorial gives the loop something real
  // to happen to.
  assert(/Game of Life/.test(onboard), 'the first doc is no longer the Game of Life example');
  assert(/artifact/i.test(onboard), 'the first doc must carry a live artifact');
  for (const beat of ['comments', 'fix them', 'new version', 'sharing the link']) {
    assert(onboard.includes(beat), `the tutorial no longer covers: ${beat}`);
  }
});

t('points at the hub only when there is a hosted account behind it', () => {
  // /me is per-user only once #156 lands, and only for someone who actually
  // holds a hosted account. Naming it for a self-host visitor would dead-end
  // them on the operator catalog's sign-in wall (#131).
  // Check the code, not the prose: a comment mentioning /me must not satisfy
  // this, and every place the visitor can actually SEE it must be guarded.
  const code = onboard.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const mentions = code.split('tdoc.dev/me').length - 1;
  assert(mentions >= 2, `expected the hub in both the paste line and the lesson, found ${mentions}`);
  assert(/if \(st\.token\) s \+= '[^']*tdoc\.dev\/me/.test(code),
    'the paste line names the hub without checking for a hosted token');
  assert(/st\.token \? '[^']*tdoc\.dev\/me/.test(code),
    'the lesson names the hub without checking for a hosted token');
});

t('does not offer to email the line', () => {
  // Added once, cut on sight: it is a second exit from a dialog whose whole
  // job is one button.
  assert(!/mailto/.test(onboard), 'the email escape hatch is back');
});

t('the sign-in it drops is still offered where the server enforces it', () => {
  // Commenting is the only action that hard-requires a session, and the
  // overlay already asks there. That is what makes dropping it from
  // onboarding safe rather than merely shorter.
  const overlay = fs.readFileSync(path.join(root, 'server', 'overlay.js'), 'utf8');
  assert(/Sign in with GitHub to comment/.test(overlay),
    'the composer no longer offers sign-in, so removing it from onboarding would strand the user');
});

t('the page can open the modal it is served with', () => {
  // server/server.js and the worker inject onboard.js into this slug, and the
  // modal binds to a[href="/start"]. A page without that anchor gets the
  // script and can never show it.
  assert(/href="\/start"/.test(html),
    'no a[href="/start"] on the page, so the injected onboarding modal is dead code here');
  assert(/a\[href="\/start"\]/.test(onboard), 'the modal no longer binds to the CTA');
});

t('does not promise zero setup while hosted signup is closed', () => {
  // wrangler.toml.template ships TDOC_HOSTED_REGISTRATION unset, so
  // /api/hosted/token 403s on tdoc.dev and publishing lands on Cloudflare.
  // "Nothing to set up" was false for every real visitor.
  assert(!/Nothing to set up/.test(text), 'the page still claims there is nothing to set up');
  assert(/Cloudflare/.test(text), 'the page must say where the doc actually gets published');
  assert(/keep it local/i.test(text),
    'ONBOARDING.md supports a local-only path; the page should offer that escape hatch');
  assert(/Cloudflare/.test(onboard) && /keep it local/i.test(onboard),
    'the modal must price the self-host path too; it is where that visitor commits');
});

t('says what to say, not what to type', () => {
  // The premise is that you talk to the agent. A deploy command here would
  // contradict the page it sits on.
  assert(!/npx |wrangler |npm i -g/.test(text),
    'the page must not hand the reader a CLI command to type');
});

t('a failed copy still leaves the visitor holding the line', () => {
  // navigator.clipboard rejects whenever the document is not focused. A
  // button that silently does nothing is worse than no button.
  assert(/execCommand/.test(onboard), 'no fallback when the clipboard API is unavailable');
  assert(/selectNodeContents/.test(onboard),
    'last resort must select the line so the visitor can copy it by hand');
});

t('carries the SEO head', () => {
  assert(/<title>[^<]*tdoc[^<]*<\/title>/i.test(html), 'title does not mention tdoc');
  assert(/rel="canonical"/.test(html), 'missing canonical');
  assert(/property="og:title"/.test(html), 'missing og:title');
});

t('/start serves the doc and fails safe', () => {
  assert(/const START_SLUG = 'tdoc-start'/.test(worker), 'missing START_SLUG');
  const route = worker.match(/if \(p === '\/start' && \(method === 'GET' \|\| method === 'HEAD'\)\) \{[\s\S]*?\n    \}/);
  assert(route, '/start has no GET/HEAD route');
  assert(/landingResponse\(env, req, START_SLUG\)/.test(route[0]),
    '/start must route through landingResponse so it inherits the neutral-page fallback');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
