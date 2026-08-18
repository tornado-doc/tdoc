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

t('asks for no sign-in of its own', () => {
  // It led for exactly one commit, on the theory that it bought the hosted
  // token. It does not: #156 adds hosted_github_signin to bin/tdoc-publish, so
  // the CLI signs in and mints for itself. Asking here made the visitor
  // authenticate twice for one account.
  assert(!/stepSignIn|tdo-skip/.test(onboard), 'the sign-in step is back in onboarding');
  assert(!/device\/start|device\/poll/.test(onboard), 'a device flow is back in the modal');
  const overlay = fs.readFileSync(path.join(root, 'server', 'overlay.js'), 'utf8');
  assert(/Sign in with GitHub to comment/.test(overlay),
    'the composer must still offer sign-in where the server actually enforces it');
});

t('the detail is collapsed, not stacked above the button', () => {
  // Someone who already gets it should be one click from Copy. The rest is
  // there for whoever wants to know what they are setting loose.
  assert(/<summary>What does it do\?<\/summary>/.test(onboard),
    'the lesson is no longer behind a disclosure');
  assert(/document\.createElement\('details'\)/.test(onboard),
    'use a native <details> so it works without extra script and stays accessible');
  assert(!/learn\.open = true|open>/.test(onboard), 'the disclosure must start closed');
});

t('the paste line stays one short sentence', () => {
  // Everything it used to spell out lives in FIRST-DOC.md now. A prompt the
  // visitor has to read before pasting is a prompt they edit or abandon.
  const m = onboard.match(/function line\(\) \{[\s\S]*?\n  \}/);
  assert(m, 'line() not found');
  assert(m[0].length < 220, `the paste line is growing again: ${m[0].length} chars of builder`);
  assert(/FIRST-DOC\.md/.test(onboard), 'the line must point the agent at the first-doc recipe');
});

t('no credential is ever pasted into a prompt', () => {
  // The token used to ride in the line because minting was browser-only.
  // Since #156 the CLI signs in and mints for itself, and a secret in a
  // pasted prompt lands in the agent's history and possibly its logs.
  const m = onboard.match(/function line\(\) \{[\s\S]*?\n  \}/);
  assert(!/st\.token/.test(m[0]), 'the paste line splices a token again');
  assert(!/hosted token is/.test(onboard), 'the token phrase is back in the prompt');
});

t('the first doc is a Game of Life lesson, and the recipe carries it', () => {
  // The doc is written fresh from FIRST-DOC.md each time, so there is no
  // fixture to drift. That file has to keep teaching the loop.
  const recipe = fs.readFileSync(path.join(root, 'FIRST-DOC.md'), 'utf8');
  assert(/Game of Life/.test(recipe), 'the recipe no longer builds the Game of Life doc');
  assert(/widget island/i.test(recipe),
    'the recipe must say the artifact goes in a widget island, or CSP will kill it');
  for (const beat of ['comments', 'fix', 'new version', 'reply', 'friend']) {
    assert(new RegExp(beat, 'i').test(recipe), `the tutorial no longer covers: ${beat}`);
  }
  assert(/ONBOARDING\.md/.test(recipe), 'the recipe must hand install back to ONBOARDING.md');
  assert(/[Dd]o not ask for a token/.test(recipe),
    'the recipe must tell the agent not to ask the human for a token');
});

t('points at the hub only when there is a hosted account behind it', () => {
  // /me is per-user only once #156 lands, and only for someone holding a
  // hosted account. Naming it for a self-host visitor walks them into the
  // operator catalog's sign-in wall (#131). Guarded in both places it appears.
  const code = onboard.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert(/st\.hosted \? '[^']*tdoc\.dev\/me/.test(code),
    'the lesson names the hub without checking that hosted publishing is open');
  const recipe = fs.readFileSync(path.join(root, 'FIRST-DOC.md'), 'utf8');
  assert(/only if/i.test(recipe) && /tdoc\.dev\/me/.test(recipe),
    'the recipe must make the hub conditional on having published to hosted tdoc');
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
