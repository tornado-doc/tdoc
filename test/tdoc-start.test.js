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
// Strip to a fixed point. One pass is the js/incomplete-multi-character-
// sanitization pattern: `<<h3>>` comes out the other side as `<h3>`.
const stripTags = (src) => {
  let out = src.replace(/<style[\s\S]*?<\/style>/gi, ' '), prev;
  do { prev = out; out = out.replace(/<[^>]+>/g, ' '); } while (out !== prev);
  return out;
};
const text = stripTags(html);

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

t('the dialog does not sign anyone in (#254)', () => {
  // The sign-in page was kept on the theory that it produced the hosted token
  // and so bought zero-setup publishing. It did not: the token it minted was
  // assigned to st.token and never read anywhere, and `sign_in_required` set
  // the same st.hosted flag without signing in at all — so the page bought a
  // wording variant at the cost of a full OAuth round trip, and left the
  // visitor to authenticate a second time in the CLI anyway.
  assert(!/function stepSignIn/.test(onboard), 'the sign-in page is back');
  assert(!/__tdocSignIn/.test(onboard), 'the dialog signs the visitor in again');
  // The endpoint is still called — unauthenticated, to read whether hosted is
  // open from the error. What must not come back is a credential the dialog
  // then does nothing with.
  assert(!/st\.token/.test(onboard), 'the dialog stores a token it cannot use');
  assert(!/r\.token \? /.test(onboard) || /r\.token \|\| r\.error === 'sign_in_required'/.test(onboard),
    'the probe should read openness, not harvest a token');
  assert(!/device\/start|device\/poll/.test(onboard), 'a device flow is back in the modal');
  // Onboarding is now exactly one sign-in, in the CLI, where the credential
  // is actually needed.
});

t('is one screen, with nothing to page through (#254)', () => {
  // Three pages existed because the first one asked a question. With the
  // sign-in gone, page two was the only page carrying anything, and page
  // three just restated the line already on screen.
  assert(!/var PAGES = \[/.test(onboard), 'the dialog is paged again');
  assert(!/st\.page/.test(onboard), 'page state is back');
  assert(!/showNext/.test(onboard), 'the in-place expansion is back');
  // Self-hosting stays reachable — a sentence to add, not a button to weigh
  // against the primary path on the way in.
  assert(/tdo-alt/.test(onboard), 'the self-host route is gone entirely');
  assert(!/tdo-skip/.test(onboard), 'the self-host fork is back as a competing button');
});

t('Copy sits inside the prompt box', () => {
  // A button under the dialog reads as "copy the dialog", which is exactly
  // how it looked.
  assert(/\.tdo-linewrap\{position:relative/.test(onboard) && /\.tdo-copy\{position:absolute/.test(onboard),
    'the copy button must be positioned inside the prompt box');
  const paste = onboard.slice(onboard.indexOf('function stepPaste'), onboard.indexOf('function stepNext'));
  assert(/wrap\.appendChild\(cp\)/.test(paste), 'the copy button must live in the box, not the footer');
});

t('the detail is collapsed on the page that has a job to do', () => {
  // Someone who already gets it should be one click from Copy. The last page
  // is different: its list IS the content, so that one opens.
  assert(/<summary>What does it do\?<\/summary>/.test(onboard),
    'the lesson is no longer behind a disclosure');
  const paste = onboard.slice(onboard.indexOf('function stepPaste'), onboard.indexOf('function stepNext'));
  assert(!/learn\.open = true/.test(paste), 'the paste page disclosure must start closed');
});


t('the self-host path changes the line and the recipe knows what to do', () => {
  // Someone who explicitly skipped hosting must not get the hosted default
  // anyway. The line says which host; the recipe carries the steps.
  // The mechanism moved (#254): it used to be a button on screen one that
  // mutated the copied line. It is now a sentence the visitor adds themselves,
  // so choosing it is still explicit but it is no longer a fork anyone has to
  // resolve before they know what tdoc is.
  assert(/tdo-alt/.test(onboard), 'the self-host route is gone entirely');
  assert(/Publish it to my own Cloudflare/.test(onboard),
    'the self-host line does not tell the agent where to publish');
  const recipe = fs.readFileSync(path.join(root, 'FIRST-DOC.md'), 'utf8');
  assert(/own Cloudflare/i.test(recipe) && /wrangler login/.test(recipe),
    'the recipe does not cover the self-host branch');
  assert(/walks them into a sign-in wall/.test(recipe),
    'the recipe must still withhold tdoc.dev/me from a self-host publisher');
});

t('the prompt survives the page it was copied from', () => {
  // Taking the line away right after telling someone to go paste it is the one
  // moment they still need it.
  // With one screen (#254) the line cannot be paged away from, and Copy is
  // always on it — which is what this was protecting.
  const screen = onboard.slice(onboard.indexOf('function stepPaste'), onboard.indexOf('function render'));
  assert(/tdo-line/.test(screen), 'the screen no longer shows the prompt');
  assert(/copyOnly/.test(screen), 'the screen has no way to copy it again');
  assert(!/var PAGES/.test(onboard), 'the line can be paged away from again');
});

t('the dialogs are not commentable surfaces', () => {
  // Selecting text inside a dialog was raising a comment pill on the page
  // behind it, because the overlay treated product chrome as author content.
  const overlay = fs.readFileSync(path.join(root, 'server', 'overlay.js'), 'utf8');
  const m = overlay.match(/const UI_CONTAINERS = '[^']*'/);
  assert(m, 'UI_CONTAINERS not found');
  assert(/\.tdo-bg/.test(m[0]) && /\.tds-bg/.test(m[0]),
    'the onboarding and sign-in dialogs must be listed as overlay UI');
});

t('signing in updates the page it was started from', () => {
  // The flow can now be launched from the onboarding dialog, not just the bar,
  // so success has to reach the bar and the comments either way. One
  // announcement from the shared module; no second implementation.
  const signin = fs.readFileSync(path.join(root, 'server', 'signin.js'), 'utf8');
  assert(/tdoc:signedin/.test(signin), 'the shared flow announces nothing on success');
  const overlay = fs.readFileSync(path.join(root, 'server', 'overlay.js'), 'utf8');
  assert(/addEventListener\('tdoc:signedin'/.test(overlay),
    'the overlay does not refresh when sign-in happened elsewhere');
});

t('the device code can be copied', () => {
  // Retyping a six character code from a dialog is the kind of small friction
  // that loses people mid-flow. Shared module, so every surface gets it.
  const signin = fs.readFileSync(path.join(root, 'server', 'signin.js'), 'utf8');
  assert(/tds-copy/.test(signin), 'no copy button on the device code');
  assert(/Press \\u2318C|Press Ctrl\+C/.test(signin),
    'no fallback when the clipboard is unavailable');
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

t('the first doc is the reader\'s own portrait, and the recipe carries it', () => {
  // The doc is written fresh from FIRST-DOC.md each time, so there is no
  // fixture to drift. That file has to keep specifying the whole thing.
  const recipe = fs.readFileSync(path.join(root, 'FIRST-DOC.md'), 'utf8');
  assert(/What does AI know about me/i.test(recipe),
    'the recipe no longer builds the what-AI-knows doc');
  assert(/widget island/i.test(recipe),
    'the recipe must say computation goes in a widget island, or CSP will kill it');
  // The scan is announced, never silent, and never quotes what it read.
  assert(/I'm going to look at the traces/.test(recipe),
    'the recipe must say the scan line before scanning');
  assert(/Never copy conversation text into the page/.test(recipe),
    'the recipe must forbid quoting transcripts — they carry pasted keys');
  // It is a portrait, not an activity log, and it is not published unasked.
  assert(/Name a trait, then prove it/.test(recipe),
    'the recipe must ask for traits rather than activity readings');
  assert(/Do not publish this one automatically/.test(recipe),
    'the recipe must withhold publication until the human says yes');
  // It has to work for someone who does not write code, and for an empty machine.
  assert(/the reader may not write code/i.test(recipe),
    'the recipe must handle readers with no coding projects');
  assert(/If there is no history/.test(recipe),
    'the recipe must handle a machine with nothing to scan');
  for (const beat of ['comment', 'next version', 'answers']) {
    assert(new RegExp(beat, 'i').test(recipe), `the loop is no longer taught: ${beat}`);
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
  // The check survives without the sign-in page (#254): the probe is
  // unauthenticated, because the answer is in the error rather than the token.
  assert(/function probeHosted/.test(code), 'nothing establishes whether hosted is open');
  assert(!/__tdocSignIn/.test(code), 'the probe should not require signing anyone in');
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
  // The modal must still price the setup, because that is where the visitor
  // commits. The local-only escape hatch lives on the /start page and in the
  // recipe instead: the dialog was trimmed to one line and one button on
  // purpose, and a second way out competed with the button.
  assert(/Cloudflare/.test(onboard), 'the modal no longer says where the doc gets published');
  const recipe = fs.readFileSync(path.join(root, 'FIRST-DOC.md'), 'utf8');
  assert(/keep it local/i.test(text) || /keep it local/i.test(recipe),
    'the local-only path is now unreachable from both the page and the recipe');
});

t('says what to say, not what to type', () => {
  // The premise is that you talk to the agent. A deploy command here would
  // contradict the page it sits on.
  assert(!/npx |wrangler |npm i -g/.test(text),
    'the page must not hand the reader a CLI command to type');
});

t('the page is the manual, not a copy of the dialog', () => {
  // /start used to repeat the dialog almost word for word. It is the full tour
  // now, and the dialog links to it — so the two must not converge again.
  // Capture the text directly rather than stripping tags off the match. A
  // one-pass tag strip is the js/incomplete-multi-character-sanitization
  // pattern — `<<h3>>` survives it — and there is nothing here to strip.
  const headings = [...html.matchAll(/<h3>([^<]*)<\/h3>/g)].map(m => m[1]);
  assert(headings.length >= 6, `the tour lost sections: only ${headings.length} left`);
  for (const topic of [/comment/i, /version/i, /[Ss]hare/, /tdoc\.dev\/me|hub/i]) {
    assert(headings.some(h => topic.test(h)) || topic.test(text),
      `the tour no longer covers ${topic}`);
  }
  const onboardLink = /tdo-tut/.test(onboard) && /href = '\/start'/.test(onboard);
  assert(onboardLink, 'the dialog no longer hands off to the full tutorial');
  // A /start link inside the dialog must navigate, not re-open the dialog.
  assert(/closest\('\.tdo-bg'\)/.test(onboard),
    'clicks inside the dialog are still captured by its own CTA handler');
});

t('a failed copy still leaves the visitor holding the line', () => {
  // navigator.clipboard rejects whenever the document is not focused. A
  // button that silently does nothing is worse than no button.
  assert(/execCommand/.test(onboard), 'no fallback when the clipboard API is unavailable');
  assert(/selectNodeContents/.test(onboard),
    'last resort must select the line so the visitor can copy it by hand');
});

t('can be left without the browser Back button', () => {
  // This is a full page people arrive at directly: from the dialog, a shared
  // link, or search. The footer link is a long scroll away, so the way out
  // sits at the top left where a way out belongs.
  assert(/class="back" href="\/"/.test(html), 'no back link to the landing page');
  const head = html.slice(html.indexOf('<section class="hero"'), html.indexOf('</section>'));
  assert(/class="back"/.test(head), 'the back link must be at the top of the page, not buried');
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

// ---- the site must not teach the pre-publish-first flow (#236 S6) ----

t('/start names tdoc.dev, not a Cloudflare account, as the destination', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'landing', 'tdoc-start', 'v1', 'index.html'), 'utf8');
  const from = html.indexOf('Where does it get published');
  const fold = html.slice(from, html.indexOf('</details>', from));
  assert(!/free Cloudflare account you own/.test(fold),
    '/start still names a Cloudflare account as the default destination');
  assert(!/enable R2|About five minutes/.test(fold),
    '/start still walks people through Cloudflare setup for the default path');
  assert(/tdoc\.dev/.test(fold), '/start should name tdoc.dev');
  // Self-hosting and local-only are demoted, not deleted.
  assert(/my own Cloudflare/.test(fold), 'self-hosting should still be reachable');
  assert(/keep it local/.test(fold), 'local-only should still be reachable');
});

t('the /me create-doc modal does not teach a manual Publish step', () => {
  // /tdoc new publishes on its own since #239; telling people to hit Publish
  // sends them looking for a button that is not part of the flow any more.
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
  const from = src.indexOf('class="mk-bd"');
  const modal = src.slice(from, src.indexOf('</ol>', from));
  assert(!/Hit <b>Publish<\/b>/.test(modal), '/me modal still says to hit Publish');
  assert(/publishes it, and hands you the link/.test(modal),
    '/me modal should say the link comes back on its own');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
