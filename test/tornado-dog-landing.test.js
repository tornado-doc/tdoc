// tornado-doc landing page (#127). Keep this a one-screen tdoc, not a site.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const htmlPath = path.join(__dirname, '..', 'landing', 'tornado-doc', 'v1', 'index.html');
const metaPath = path.join(__dirname, '..', 'landing', 'tornado-doc', 'meta.json');
const html = fs.readFileSync(htmlPath, 'utf8');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

console.log('tornado-doc landing (#127)');

t('is a tdoc-shaped page', () => {
  assert(html.includes('<div class="wrap">'), 'missing .wrap');
  assert(/<meta name="viewport"/.test(html), 'missing viewport');
  assert(/body\s*\{\s*background:\s*#fff/.test(html), 'missing body background');
});

t('names tornado-doc and tdoc', () => {
  assert(html.includes('<h1>tornado-doc</h1>'), 'missing h1 tornado-doc');
  assert(!html.includes('Tornado Dog'), 'old Tornado Dog name still present');
  assert(html.includes('tdoc'), 'does not mention tdoc');
  assert(meta.title === 'tornado-doc', `meta title was ${meta.title}`);
  assert(meta.slug === 'tornado-doc', `meta slug was ${meta.slug}`);
});

t('links to the GitHub repo', () => {
  assert(html.includes('https://github.com/tornado-doc/tdoc'), 'missing GitHub URL');
});

t('stays a short page', () => {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert(text.length < 600, `page text too long (${text.length} chars)`);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
