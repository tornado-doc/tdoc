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

t('asks for no account and no runtime', () => {
  // /api/hosted/token mints an anonymous account, so the sign-in step bought
  // the visitor nothing. And only Claude Code has a documented `/plugin`
  // line, which per ONBOARDING.md an agent cannot run for you anyway — so the
  // agent reads the guide and installs itself instead of being asked.
  assert(!/device\/start|device\/poll/.test(onboard),
    'onboarding starts a GitHub device flow again; sign-in belongs in the comment composer');
  assert(!/plugin marketplace add/.test(html) && !/plugin marketplace add/.test(onboard),
    'a /plugin line is back; it is Claude Code only and agents cannot run it');
  assert(/ONBOARDING\.md/.test(onboard), 'the paste line must point the agent at the setup guide');
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
    'the modal must price the setup too; it is where the visitor commits');
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
