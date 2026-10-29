// Onboarding contracts: /start remains framework-free author HTML while the
// provider-owned modal is a reusable React dialog in the outer shell.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const root = path.join(__dirname, '..');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'landing', 'tdoc-start', 'meta.json'), 'utf8'));
const latest = meta.versions[meta.versions.length - 1].n;
const html = fs.readFileSync(path.join(root, 'landing', 'tdoc-start', `v${latest}`, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
// The create-choice cards and the shared copy they pull their wording from.
// The pop-up that used to hold the recipe is gone; the prompt contract is what
// these two say between them.
const dialog = ['shell/src/create-from-scratch.jsx', 'shell/src/onboarding-copy.js', 'shell/src/setup-gate.jsx']
  .map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const documentShell = fs.readFileSync(path.join(root, 'shell', 'src', 'document-shell.jsx'), 'utf8');
const probe = fs.readFileSync(path.join(root, 'server', 'frame-probe.js'), 'utf8');
const recipe = fs.readFileSync(path.join(root, 'FIRST-DOC.md'), 'utf8');
const toolbar = fs.readFileSync(path.join(root, 'shell', 'src', 'document', 'document-toolbar.jsx'), 'utf8');
const chromeCss = fs.readFileSync(path.join(root, 'server', 'chrome.css'), 'utf8');
const uiCss = fs.readFileSync(path.join(root, 'shell', 'src', 'ui', 'ui.css'), 'utf8');
const stripTags = (source) => source.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
const text = stripTags(html);

console.log('React onboarding /start');

t('the published tutorial stays framework-free and runs no author JavaScript', () => {
  assert(!/<script\b/i.test(html), 'tutorial contains a script tag');
  assert(!/\son[a-z]+\s*=\s*["']/i.test(html), 'tutorial contains an inline event handler');
});

t('/start uses the shared published-doc path and neutral fallback', () => {
  assert(/const START_SLUG = 'tdoc-start'/.test(worker), 'START_SLUG missing');
  const route = worker.match(/if \(p === '\/start'[\s\S]*?landingResponse\(env, req, START_SLUG\)/);
  assert(route, '/start does not use landingResponse');
  assert(/if \(!latest\) return neutralLandingResponse\(env\)/.test(worker), 'neutral fallback missing');
});

t('the local /start alias reuses the latest tdoc-start document route', () => {
  const route = server.match(/if \(p === '\/start'[\s\S]*?Location: `\/d\/tdoc-start\/v\/\$\{latest\}`/);
  assert(route, 'local /start does not redirect to the existing tutorial route');
  assert(/Array\.isArray\(meta\.versions\)/.test(route[0]), 'local /start does not resolve the latest tutorial version');
  assert(/req\.method === 'GET' \|\| req\.method === 'HEAD'/.test(route[0]), 'local /start is not GET/HEAD safe');
});

t('Copy the line copies the line, and opens no pop-up', () => {
  // It used to be a link to /start, which bounced a signed-out visitor to the
  // sign-in wall: a button that did something other than what it said.
  assert(!/href="\/start"[^>]*>Copy the line/.test(html), 'Copy the line is a link again');
  assert(/<button[^>]*data-tdoc-copy="#first-line"[^>]*data-tdoc-copy-done="Copied"[^>]*>Copy the line<\/button>/.test(html),
    'Copy the line is not wired to the copy trigger');
  assert(/<span id="first-line">Set up tdoc and make my first doc: https:\/\/github\.com\/tornado-doc\/tdoc\/blob\/main\/FIRST-DOC\.md<\/span>/.test(html),
    'the copied element is not exactly the line');
  assert(/\.term-bd \{[^}]*user-select:all/.test(html) && /click the line above to select it/.test(text),
    'no hand-copy fallback when the clipboard refuses');
  assert(/config\.onboarding/.test(documentShell) && /href === '\/start'/.test(documentShell),
    'frame navigation is not intercepted for onboarding');
  // The five-step wizard this used to mount is gone. Setup is a route and the
  // onboarding is a checklist, so nothing on a document opens a journey.
  assert(!/OnboardingDialog|OnboardingWizard/.test(documentShell), 'no onboarding dialog is mounted in the shell');
});

t('mobile onboarding actions keep names and 44px touch targets', () => {
  assert(/aria-label="Publish"/.test(toolbar) && /aria-label="Share"/.test(toolbar), 'icon-only document actions lost their names');
  assert(/\.tdoc-bar button \{ min-width: 44px; min-height: 44px/.test(chromeCss), 'mobile toolbar targets are undersized');
  assert(/\.tdoc-modal button[\s\S]*min-height: 44px/.test(uiCss), 'mobile dialog actions are undersized');
  assert(/tdoc-onboarding-link[\s\S]*min-height: 44px/.test(uiCss), 'mobile tutorial link is undersized');
});

t('the short prompt points to FIRST-DOC and never embeds a credential', () => {
  assert(/FIRST-DOC\.md/.test(dialog), 'FIRST-DOC link missing');
  assert(!/token\s*(is|=)|Authorization|Bearer/.test(dialog), 'credential leaked into the prompt');
  assert(dialog.includes('export const SETUP_PROMPT = FIRST_DOC_LINE;'), '/setup and /start hand out different lines');
  assert(dialog.includes('FIRST_DOC_LINE = `Set up tdoc and make my first doc: ${RECIPE_URL}`')
    && html.includes('Set up tdoc and make my first doc: https://github.com/tornado-doc/tdoc/blob/main/FIRST-DOC.md'),
    'the /start line is not FIRST_DOC_LINE');
  assert(/copyText\(prompt\)/.test(dialog) && /PORTRAIT_PROMPT = `Make my first doc: \$\{RECIPE_URL\}`/.test(dialog),
    'copy is wired to the line the gate composed');
});

t('a newcomer is told what to have before pasting', () => {
  assert(/Before you start/.test(text), 'no Before you start box');
  assert(/href="https:\/\/code\.claude\.com\/docs\/en\/overview"/.test(html), 'no Claude Code install link');
  assert(/Open\s+Terminal/.test(text) && /<code>claude<\/code>/.test(html), 'does not say where to paste');
  assert(/nodejs\.org/.test(html) && !/brew install/.test(html), 'Node is not offered as the nodejs.org installer');
  assert(!/claude\.ai or ChatGPT chat/.test(text), 'still says the chats are unsupported');
  assert(/Claude[\s\S]*ChatGPT[\s\S]*No terminal needed/.test(text) && html.includes('href="/start?connect=1"'), 'does not offer Connect in one click for the chat apps');
});

t('commenting sign-in names every method, not only GitHub', () => {
  assert(!/GitHub sign in/.test(text) && !/signs you in with GitHub once/.test(text), 'still GitHub-only copy');
  assert(/email, Google, or GitHub/.test(text), 'missing email, Google, or GitHub');
});

t('the tutorial promises the same private personal AI portrait as FIRST-DOC', () => {
  assert(/personal AI portrait/i.test(text), 'tutorial does not name the current first-doc outcome');
  assert(/What does AI know about me\?/i.test(text), 'tutorial first-doc title is stale');
  assert(/traces you choose to share/i.test(text), 'tutorial omits the portrait privacy boundary');
  assert(!/You get a Game of Life/i.test(text), 'tutorial still promises the old first doc');
});

t('the gate reads the journey record, not a capability probe', () => {
  assert(!/fetch\('\/api\/hosted\/token'/.test(dialog), 'the old capability probe is back');
  assert(/getOnboarding\(\)/.test(dialog), 'the gate does not read the journey record');
  // Only the record moves the page: no step is advanced by a click.
  assert(/const connected = Boolean\(paired \|\| record\?\.agent_connected/.test(dialog), 'the gate does not move with the record');
});

t('self-hosting remains an explicit alternate in the recipe and the tutorial', () => {
  // The pop-up carries no reading; the alternative lives where the agent and
  // the curious look — FIRST-DOC.md and /start.
  assert(/own Cloudflare/i.test(recipe) && /wrangler login/.test(recipe), 'recipe no longer covers self-hosting');
});

t('product dialogs cannot become author comment targets', () => {
  assert(/<iframe[\s\S]*src=\{boot\.frameSrc\}/.test(documentShell), 'isolated author frame missing');
  assert(probe.includes("type: 'tdoc:selection'"), 'selection protocol missing from frame probe');
  assert(!dialog.includes('tdoc:selection'), 'provider dialog participates in author selection protocol');
});

t('the tutorial is a full guide with navigation and SEO', () => {
  assert((html.match(/<h3>/g) || []).length >= 6, 'tutorial lost sections');
  assert(/class="back" href="\/"/.test(html), 'back link missing');
  assert(/<title>[^<]*tdoc[^<]*<\/title>/i.test(html), 'title missing tdoc');
  assert(/rel="canonical"/.test(html) && /property="og:title"/.test(html), 'SEO head incomplete');
  for (const topic of [/comment/i, /version/i, /share/i, /tdoc\.dev\/me|hub/i]) {
    assert(topic.test(text), `tutorial no longer covers ${topic}`);
  }
});

t('the current portrait recipe preserves privacy and collision handling', () => {
  for (const pattern of [
    /What does AI know about me/i,
    /Never copy conversation text into the page/,
    /--visibility private/,
    /what-ai-knows-<name>/,
    /409|slug_taken/,
    /Do not ask for a token/i,
  ]) assert(pattern.test(recipe), `recipe contract missing: ${pattern}`);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
