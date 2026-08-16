// tornado-doc landing page (#127) — the doc served at tdoc.dev/.
// Covers the page itself (content + SEO head + CSP-safety) and the worker
// route that makes it the homepage.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'landing', 'tornado-doc', 'v1', 'index.html'), 'utf8');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'landing', 'tornado-doc', 'meta.json'), 'utf8'));
const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');

// Exact-href extraction — not html.includes(url), which CodeQL flags as
// incomplete URL-substring sanitization (js/incomplete-url-substring-sanitization).
const hrefs = [];
{
  const re = /\bhref="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) hrefs.push(m[1]);
}
const metaContent = (key) => {
  const re = new RegExp(`<meta\\s+(?:name|property)="${key}"\\s+content="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
};

console.log('tornado-doc landing (#127)');

t('is a tdoc-shaped page', () => {
  // .wrap is one of the overlay's ARTICLE_ROOT_SEL roots — comment anchoring
  // resolves against it, so losing it silently degrades commenting.
  assert(html.includes('<div class="wrap">'), 'missing .wrap content root');
  assert(/<meta name="viewport"/.test(html), 'missing viewport');
  assert(/body\s*\{[^}]*background:\s*#fff/.test(html), 'missing body background');
});

t('runs no author JavaScript', () => {
  // Published docs run under a nonce-only CSP (cspHeader) — author <script>,
  // inline handlers, and javascript: URLs never execute. A page that needs
  // them would look fine locally in a plain file:// preview and be broken
  // live, so assert the page never depends on them.
  assert(!/<script\b/i.test(html), 'page contains a <script> tag; CSP will not run it');
  assert(!/\son[a-z]+\s*=\s*["']/i.test(html), 'page contains an inline event handler');
  assert(!hrefs.some((h) => /^javascript:/i.test(h)), 'page contains a javascript: URL');
});

t('carries the SEO head', () => {
  assert(/<title>[^<]*tdoc[^<]*<\/title>/i.test(html), 'title does not mention tdoc');
  // Upper bound is Google's snippet truncation (~160 chars) — a longer one is
  // not wrong, it just gets cut mid-sentence in results.
  const desc = metaContent('description');
  assert(desc && desc.length >= 80 && desc.length <= 165, `meta description missing or badly sized (${desc && desc.length})`);
  assert(hrefs.some((h) => h === 'https://tdoc.dev/'), 'missing canonical href https://tdoc.dev/');
  assert(/rel="canonical"/.test(html), 'missing rel=canonical');
});

t('carries share-card tags', () => {
  for (const k of ['og:type', 'og:url', 'og:title', 'og:description', 'og:image']) {
    assert(metaContent(k), `missing ${k}`);
  }
  assert(metaContent('og:url') === 'https://tdoc.dev/', `og:url was ${metaContent('og:url')}`);
  assert(metaContent('twitter:card'), 'missing twitter:card');
});

t('names tdoc and tornado-doc', () => {
  assert(/<h1>tdoc<\/h1>/.test(html), 'missing h1 tdoc');
  assert(html.includes('tornado-doc'), 'does not mention tornado-doc');
  assert(!html.includes('Tornado Dog'), 'old Tornado Dog name still present');
  assert(meta.title === 'tornado-doc', `meta title was ${meta.title}`);
  assert(meta.slug === 'tornado-doc', `meta slug was ${meta.slug}`);
});

t('links to the GitHub repo and install path', () => {
  assert(hrefs.some((h) => h === 'https://github.com/tornado-doc/tdoc'), 'missing GitHub repo href');
  assert(hrefs.some((h) => h === 'https://github.com/tornado-doc/tdoc/blob/main/ONBOARDING.md'), 'missing Install href');
});

t('demos commentable artifacts', () => {
  // The page doubles as the artifact demo (#127): an <svg> and a <pre> are
  // both in the overlay's COMMENTABLE set, so a visitor can comment on them.
  assert(/<svg\b/.test(html), 'missing svg artifact');
  assert(/<pre>/.test(html), 'missing pre artifact');
  assert(/role="img"[^>]*aria-label="|aria-label="[^"]+"[^>]*role="img"/.test(html), 'svg has no aria-label');
});

t('has a compare table that admits a loss', () => {
  // A comparison where the author wins every row reads as an ad and costs more
  // trust than it buys. At least one row must put a competitor ahead.
  assert(/<table/.test(html), 'missing compare table');
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  const lost = rows.filter((r) => {
    const cells = r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (!cells.length) return false;
    return /class="no"/.test(cells[0]);  // first td is tdoc's column
  });
  assert(lost.length >= 1, 'every compare row favours tdoc — keep at least one honest loss');
});

t('carries no unfinished placeholder content', () => {
  // The social-proof quotes and trusted-by logos must be real. This fails
  // while any NEEDS-REAL-DATA marker is left in the page, so a version
  // carrying invented testimonials cannot reach `/`.
  const markers = (html.match(/NEEDS-REAL-DATA/g) || []).length;
  assert(markers === 0, `${markers} NEEDS-REAL-DATA placeholder(s) still in the page — fill them with real content or delete the section before publishing`);
});

console.log('tdoc.dev / route');

t('homepage renders the landing doc, not a hardcoded page', () => {
  assert(/const LANDING_SLUG = 'tornado-doc'/.test(worker), 'missing LANDING_SLUG');
  assert(/if \(p === '\/' && \(method === 'GET' \|\| method === 'HEAD'\)\) return landingResponse\(env, req\)/.test(worker),
    '/ no longer routes through landingResponse');
});

t('homepage fails safe to the neutral page', () => {
  const fn = worker.match(/async function landingResponse[\s\S]*?\n}\n/);
  assert(fn, 'landingResponse not found');
  const body = fn[0];
  // Three ways the doc can be unavailable — unpublished, gated, or throwing.
  // All three must degrade to landingHtml(), never a 404 or a sign-in wall.
  assert(/if \(!latest\) return html\(landingHtml\(\)\)/.test(body), 'no fallback when the doc is unpublished');
  assert(/res\.ok \? res\.response : html\(landingHtml\(\)\)/.test(body), 'no fallback when access is denied');
  assert(/catch \{\s*return html\(landingHtml\(\)\);/.test(body), 'no fallback when lookup throws');
  assert(/meta\.versions\.length - 1\]/.test(body), 'does not resolve the LATEST version');
});

t('doc view and homepage share one render path', () => {
  // Regression guard: the /d/ route used to inline the whole render. If it
  // grows a second copy, the homepage and doc pages drift on access/CSP.
  assert(/async function serveDocVersion\(env, req, slug, version\)/.test(worker), 'missing serveDocVersion');
  const occurrences = (worker.match(/injectOverlay\(raw,/g) || []).length;
  assert(occurrences === 1, `injectOverlay(raw, ...) called ${occurrences} times; expected exactly 1 shared call site`);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
