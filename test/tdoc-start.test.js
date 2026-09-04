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
// The dialog and the create-choice component it renders: the recipe itself
// moved into the shared component when Create a doc became two cards (#356),
// so the prompt contract spans both files.
const dialog = ['shell/src/onboarding-dialog.jsx', 'shell/src/create-from-scratch.jsx']
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

t('the tutorial can open the provider-owned onboarding dialog', () => {
  assert(/href="\/start"/.test(html), 'tutorial CTA missing');
  assert(/config\.onboarding/.test(documentShell) && /href === '\/start'/.test(documentShell),
    'frame navigation is not intercepted for onboarding');
  assert(/<OnboardingDialog/.test(documentShell), 'React onboarding dialog is not mounted in the shell');
});

t('the dialog is one reusable Base UI screen, not a paged state machine', () => {
  assert(/<AppDialog/.test(dialog), 'shared dialog primitive missing');
  assert(!/PAGES|stepSignIn|device\/start|device\/poll/.test(dialog), 'old paged or sign-in flow returned');
  // The explanatory <details> block is gone on purpose: the screen is two
  // doors and a definition on hover, and nothing depends on prose being read.
  assert(/Use my own <AgentTerm \/>/.test(dialog) && /Use tdoc's agent — coming soon/.test(dialog), 'the two doors are missing');
  assert(/Read the full tutorial/.test(dialog), 'tutorial handoff missing');
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
  assert(/copyText\(FIRST_DOC_RECIPE\)/.test(dialog), 'copy action is not wired to the recipe');
});

t('the tutorial promises the same private personal AI portrait as FIRST-DOC', () => {
  assert(/personal AI portrait/i.test(text), 'tutorial does not name the current first-doc outcome');
  assert(/What does AI know about me\?/i.test(text), 'tutorial first-doc title is stale');
  assert(/traces you choose to share/i.test(text), 'tutorial omits the portrait privacy boundary');
  assert(!/You get a Game of Life/i.test(text), 'tutorial still promises the old first doc');
});

t('the own-agent door reads the journey record, not a capability probe', () => {
  // The hosted-token probe and the capability-gated hub mention went with the
  // details block. What the door needs to know — has the agent connected, has
  // the first doc landed — is on the account record the server stamps, and
  // the door leaves for that doc on its own.
  assert(!/fetch\('\/api\/hosted\/token'/.test(dialog), 'the old capability probe is back');
  assert(/getOnboarding\(\)/.test(dialog), 'the door does not read the journey record');
  assert(/next\?\.published_first && next\?\.first_doc/.test(dialog), 'the door does not watch for the first doc');
  assert(/location\.href = `\/d\/\$\{encodeURIComponent\(next\.first_doc\)\}\/v\/1`/.test(dialog), 'the door does not leave for the doc');
});

t('self-hosting remains an explicit alternate sentence', () => {
  assert(/Publish it to my own Cloudflare/.test(dialog), 'self-host alternative missing');
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
