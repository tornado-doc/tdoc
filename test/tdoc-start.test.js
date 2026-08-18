// Onboarding page at /start (#157, #142).
//
// The homepage and empty /me both send "Create your first doc" here.
// Hosted default: login is enough. Not a BYOK / self-host walkthrough.
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
const text = html
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ');

const hrefs = [];
{
  const re = /\bhref="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) hrefs.push(m[1]);
}

console.log('onboarding /start (#157)');

t('is a tdoc-shaped page', () => {
  assert(html.includes('<div class="wrap">'), 'missing .wrap content root');
  assert(/<meta name="viewport"/.test(html), 'missing viewport');
  assert(/body\s*\{[^}]*background:\s*#fff/.test(html), 'missing body background');
});

t('runs no author JavaScript', () => {
  assert(!/<script\b/i.test(html), 'page contains a <script> tag; CSP will not run it');
  assert(!/\son[a-z]+\s*=\s*["']/i.test(html), 'page contains an inline event handler');
  assert(!hrefs.some((h) => /^javascript:/i.test(h)), 'page contains a javascript: URL');
});

t('is the hosted first-doc path, not BYOK', () => {
  assert(/Create your first doc/.test(html), 'missing the first-doc heading');
  assert(/tdoc\.dev/.test(text), 'must name tdoc.dev as the host');
  assert(/Login is the whole account/.test(text), 'must say login is enough');
  assert(!/Your Cloudflare|Your Vercel|enable R2|keep it local/i.test(text),
    'must not walk a new user through BYOK / self-host setup');
  assert(!/Nothing to set up/.test(text),
    'do not claim zero setup; the agent still has to install tdoc');
  assert(!/npx |wrangler |npm i -g/.test(text),
    'the page must not hand the reader a CLI command to type');
});

t('teaches the loop on the real published doc', () => {
  assert(hrefs.some((h) => h === 'https://tdoc.dev/d/conway-life/v/2'),
    'step 3 must link the real conway-life doc, not a mockup');
  for (const beat of ['Duplicate the example', 'Sign in with GitHub', 'A new version appears']) {
    assert(html.includes(beat), `missing loop beat: ${beat}`);
  }
});

t('names the agents tdoc works with', () => {
  for (const r of ['Claude Code', 'Codex', 'Cursor', 'Gemini', 'Grok']) {
    assert(html.includes(r), `missing runtime: ${r}`);
  }
  assert(/ONBOARDING\.md/.test(html),
    'install line must point the agent at ONBOARDING.md');
});

t('carries the SEO head', () => {
  assert(/<title>[^<]*tdoc[^<]*<\/title>/i.test(html), 'title does not mention tdoc');
  assert(hrefs.some((h) => h === 'https://tdoc.dev/start'), 'missing canonical href https://tdoc.dev/start');
  assert(/rel="canonical"/.test(html), 'missing canonical');
  assert(/property="og:title"/.test(html), 'missing og:title');
});

t('inlines the tdoc mark (no image placeholder)', () => {
  assert(!html.includes('[image content will be provided separately]'),
    '/start still has a leftover image placeholder');
  assert(/<img class="brand-mark" src="data:image\/png;base64,/.test(html),
    'brand mark must be an inlined PNG like the homepage');
});

t('/start serves the doc and fails safe', () => {
  assert(/const START_SLUG = 'tdoc-start'/.test(worker), 'missing START_SLUG');
  const route = worker.match(/if \(p === '\/start' && \(method === 'GET' \|\| method === 'HEAD'\)\) \{[\s\S]*?\n    \}/);
  assert(route, '/start has no GET/HEAD route');
  assert(/landingResponse\(env, req, START_SLUG\)/.test(route[0]),
    '/start must route through landingResponse so it inherits the neutral-page fallback');
});

t('publish-landing ships tdoc-start with the homepage', () => {
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish-landing.yml'), 'utf8');
  assert(/node bin\/tdoc-start-release/.test(wf),
    'publish-landing must build the /start payload');
  assert(/arg slug tdoc-start/.test(wf),
    'publish-landing must upload the tdoc-start slug');
  assert(/tdoc\.dev\/start/.test(wf),
    'publish-landing must verify https://tdoc.dev/start');
  assert(/Login is the whole account/.test(wf),
    'start verify must look for hosted copy, not the homepage headline');
});

t('tdoc-start-release writes a clean v1', () => {
  const { execFileSync } = require('child_process');
  const script = path.join(root, 'bin', 'tdoc-start-release');
  const outDir = path.join(root, '.release', 'tdoc-start');
  execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  const relMeta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
  const relComments = JSON.parse(fs.readFileSync(path.join(outDir, 'comments.json'), 'utf8'));
  const relHtml = fs.readFileSync(path.join(outDir, 'v1', 'index.html'), 'utf8');
  assert(relMeta.slug === 'tdoc-start', `release slug was ${relMeta.slug}`);
  assert(relMeta.versions.length === 1 && relMeta.versions[0].n === 1,
    `release meta must advertise only v1, got ${JSON.stringify(relMeta.versions)}`);
  assert(Array.isArray(relComments) && relComments.length === 0,
    `release comments.json must be empty, got ${relComments.length} thread(s)`);
  assert(relMeta.access && relMeta.access.visibility === 'public',
    'start page must publish public');
  assert(/Create your first doc/.test(relHtml), 'release HTML lost the first-doc heading');
});

t('empty /me uses the same CTA label and destination', () => {
  const start = worker.indexOf('async function indexHtml(env, session');
  const end = worker.indexOf('// ─────────────────────────────────────────────────────────────────────────', start);
  assert(start >= 0 && end > start, 'indexHtml block missing');
  const index = worker.slice(start, end);
  assert(index.includes('Create your first doc'), '/me empty state missing the first-doc label');
  assert(/href="\/start"/.test(index), '/me empty state must link to /start');
  assert((index.match(/Create your first doc/g) || []).length >= 1, 'missing first-doc CTA');
  // SSR empty catalog and last-delete inject share one string.
  assert(index.includes('emptyCatalogHtml'),
    '/me must build the empty catalog once so last-delete cannot drift');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
