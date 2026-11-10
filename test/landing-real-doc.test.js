// The homepage hero shows screenshots of real tdoc surfaces (a doc, a sheet,
// the bookmark on a web app), each linking to the real thing. It replaced a CSS mock of the product (#964). The screenshot
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

t('the hero is a row of real screenshots, each linking to the real thing', () => {
  const links = [...work.matchAll(/<a class="hd-real" href="([^"]+)">([\s\S]*?)<\/a>/g)];
  assert(links.length === 3, `expected 3 hero slides (doc, sheet, any web app), got ${links.length}`);
  for (const [, href, body] of links) {
    assert(/^\/d\/[a-z0-9-]+$/.test(href) || href === '/feedback', `a slide should link to a /d/<slug> doc or /feedback, got ${href}`);
    const img = body.match(/<img src="data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+\/=]+)"[^>]*>/);
    assert(img, `${href}: the screenshot must be inline (the release payload ships index.html only)`);
    assert(img[2].length < 250000, `${href}: the screenshot is ${img[2].length} base64 chars; keep it under 250k`);
    assert(/alt="[^"]{20,}"/.test(body) && /width="\d+" height="\d+"/.test(body), `${href}: the screenshot needs alt text and a size`);
  }
  assert(links[0][1] === '/d/maui-trip', 'the first slide is the Maui doc');
});

t('side tabs switch slides with CSS only, without jumping the page', () => {
  // Radio + label, not #fragment links: a fragment link scrolls the page to
  // the slide, which reads as the page jumping up (Safari, 2026-11-09).
  assert(!/<a href="#hd-/.test(work), 'a fragment link would scroll the page when a tab is clicked');
  const radios = [...work.matchAll(/<input class="hd-r" type="radio" name="hd-ex" id="(hd-r-[a-z]+)"/g)].map((m) => m[1]);
  const labels = [...work.matchAll(/<label for="(hd-r-[a-z]+)">/g)].map((m) => m[1]);
  assert(radios.length === 3 && radios.join() === labels.join(), `tabs ${labels} do not match radios ${radios}`);
  assert(/id="hd-r-doc" checked/.test(work), 'the first tab starts selected');
  for (const [r, x] of [['hd-r-sheet', '1'], ['hd-r-bookmark', '2']]) {
    assert(work.includes(`#${r}:checked ~ .hd-stage .hd-track{--at:${x}}`), `${r} does not move the slides`);
  }
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
