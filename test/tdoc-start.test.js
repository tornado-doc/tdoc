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
const dialog = fs.readFileSync(path.join(root, 'shell', 'src', 'onboarding-dialog.jsx'), 'utf8');
const documentShell = fs.readFileSync(path.join(root, 'shell', 'src', 'document-shell.jsx'), 'utf8');
const probe = fs.readFileSync(path.join(root, 'server', 'frame-probe.js'), 'utf8');
const recipe = fs.readFileSync(path.join(root, 'FIRST-DOC.md'), 'utf8');
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
  assert(/What does it do\?/.test(dialog), 'collapsed detail missing');
  assert(/Read the full tutorial/.test(dialog), 'tutorial handoff missing');
});

t('the short prompt points to FIRST-DOC and never embeds a credential', () => {
  assert(/FIRST-DOC\.md/.test(dialog), 'FIRST-DOC link missing');
  assert(!/token\s*(is|=)|Authorization|Bearer/.test(dialog), 'credential leaked into the prompt');
  assert(/copyText\(RECIPE\)/.test(dialog), 'copy action is not wired to the recipe');
});

t('hosted availability only controls whether the hub is mentioned', () => {
  assert(/fetch\('\/api\/hosted\/token'/.test(dialog), 'hosted capability probe missing');
  assert(/result\?\.token \|\| result\?\.error === 'sign_in_required'/.test(dialog), 'hosted probe semantics changed');
  assert(/hosted \? <li>Published docs appear in your hub at tdoc\.dev\/me/.test(dialog), 'hub mention is not capability-gated');
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
