// The homepage hero shows screenshots of real tdoc surfaces (a doc, a sheet,
// a deck, the bookmark on a web app), each linking to the real thing. It replaced a CSS mock of the product (#964). The screenshot
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
  assert(links.length === 4, `expected 4 hero slides (doc, sheet, deck, any web app), got ${links.length}`);
  for (const [, href, body] of links) {
    assert(/^\/d\/[a-z0-9-]+$/.test(href) || href === '/feedback', `a slide should link to a /d/<slug> doc or /feedback, got ${href}`);
    const img = body.match(/<img src="data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+\/=]+)"[^>]*>/);
    assert(img, `${href}: the screenshot must be inline (the release payload ships index.html only)`);
    assert(img[2].length < 250000, `${href}: the screenshot is ${img[2].length} base64 chars; keep it under 250k`);
    assert(/alt="[^"]{20,}"/.test(body) && /width="\d+" height="\d+"/.test(body), `${href}: the screenshot needs alt text and a size`);
  }
  assert(links.map((l) => l[1]).join(' ') === '/d/maui-trip /d/maui-budget /d/maui-deck /feedback', `slides: ${links.map((l) => l[1])}`);
});

// Each demo carries its own call to action, to a route that exists: the
// setup gate's doc step (sign-in first when signed out), My docs, or the
// bookmark page. Never a made-up ?new= flag.
t('each slide has its own CTA to a real route', () => {
  const ctas = [...work.matchAll(/<a class="btn btn-primary hd-go" href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
  assert(JSON.stringify(ctas) === JSON.stringify([
    ['/setup?step=doc', 'Make your doc'], ['/me', 'Make your sheet'],
    ['/setup?step=doc', 'Make your deck'], ['/feedback', 'Add to your site'],
  ]), `CTAs: ${JSON.stringify(ctas)}`);
  const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
  for (const route of ['/setup', '/me', '/feedback']) {
    assert(worker.includes(`p === '${route}'`), `the worker has no ${route} route`);
  }
  assert(/searchParams\.get\('step'\) === 'doc'/.test(worker), '/setup no longer reads ?step=doc');
});

t('side tabs switch slides with CSS only, without jumping the page', () => {
  // Radio + label, not #fragment links: a fragment link scrolls the page to
  // the slide, which reads as the page jumping up (Safari, 2026-11-09).
  assert(!/<a href="#hd-/.test(work), 'a fragment link would scroll the page when a tab is clicked');
  const radios = [...work.matchAll(/<input class="hd-r" type="radio" name="hd-ex" id="(hd-r-[a-z]+)"/g)].map((m) => m[1]);
  const labels = [...work.matchAll(/<label for="(hd-r-[a-z]+)">/g)].map((m) => m[1]);
  assert(radios.length === 4 && radios.join() === labels.join(), `tabs ${labels} do not match radios ${radios}`);
  assert(/id="hd-r-doc" checked/.test(work), 'the first tab starts selected');
  assert(/<label for="hd-r-deck"><b>Slides<\/b>/.test(work), 'the deck tab is labelled Slides');
  for (const [r, x] of [['hd-r-sheet', '1'], ['hd-r-deck', '2'], ['hd-r-bookmark', '3']]) {
    assert(work.includes(`#${r}:checked ~ .hd-stage .hd-track{--at:${x}}`), `${r} does not move the slides`);
  }
});

// Auto-rotation is CSS (author scripts never run in the frame): one keyframe
// pair per radio so choosing a tab restarts the cycle there, a pause on hover
// and keyboard focus, and none of it under reduced motion.
t('the demos rotate with CSS, pause on hover or focus, and stand still for reduced motion', () => {
  assert(!/<script/i.test(work), 'the landing doc must not carry a script');
  const motion = work.indexOf('@media (prefers-reduced-motion:no-preference){');
  assert(motion > 0, 'rotation is not gated on prefers-reduced-motion');
  const gated = work.slice(motion, work.indexOf('@keyframes hd-slide-0'));
  assert(/animation:20s linear infinite;animation-delay:calc\(var\(--off\) \* -5s\)/.test(gated), 'four demos, 5 s each');
  for (const [i, r] of ['doc', 'sheet', 'deck', 'bookmark'].entries()) {
    assert(gated.includes(`#hd-r-${r}:checked ~ .hd-stage .hd-slide{animation-name:hd-slide-${i}}`), `${r}: no slide cycle`);
    assert(gated.includes(`#hd-r-${r}:checked ~ .hd-tabs label{animation-name:hd-tab-${i}}`), `${r}: no tab cycle`);
    assert(work.includes(`@keyframes hd-slide-${i}{`) && work.includes(`@keyframes hd-tab-${i}{`), `${r}: keyframes missing`);
  }
  assert(/\.hd-show:hover :is\(\.hd-slide,\.hd-tabs label\)\{animation-play-state:paused\}/.test(gated), 'hover does not pause');
  assert(/\.hd-show:has\(:focus-visible\) :is\(\.hd-slide,\.hd-tabs label\)\{animation-play-state:paused\}/.test(gated), 'keyboard focus does not pause');
  assert(/<div class="hd-show" data-tdoc-carousel>/.test(work), 'phones cannot swipe the demos');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
