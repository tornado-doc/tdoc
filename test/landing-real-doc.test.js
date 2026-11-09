// The homepage hero shows a screenshot of a real published tdoc, linking to
// the live doc. It replaced a CSS mock of the product (#964). The screenshot
// is inline because the release payload ships index.html only.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'landing', 'tornado-doc', 'meta.json'), 'utf8'));
const latest = meta.versions[meta.versions.length - 1].n;
const work = fs.readFileSync(path.join(root, 'landing', 'tornado-doc', `v${latest}`, 'index.html'), 'utf8');

console.log('landing real doc');

t('the hero is a real published doc screenshot that links to it', () => {
  const after = work.slice(work.indexOf('<a class="hd-real"'));
  const a = after.match(/<a class="hd-real" href="([^"]+)">([\s\S]*?)<\/a>/);
  assert(a, 'missing the .hd-real link under the demo');
  assert(/^\/d\/[a-z0-9-]+$/.test(a[1]), `the real doc link should be a /d/<slug> path, got ${a[1]}`);
  const img = a[2].match(/<img src="data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+\/=]+)"[^>]*>/);
  assert(img, 'the screenshot must be inline (the release payload ships index.html only)');
  assert(img[2].length < 250000, `the screenshot is ${img[2].length} base64 chars; keep it under 250k`);
  assert(/alt="[^"]{20,}"/.test(a[2]) && /width="\d+" height="\d+"/.test(a[2]), 'the screenshot needs alt text and a size');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
