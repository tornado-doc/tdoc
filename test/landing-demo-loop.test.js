// The landing page's demo: ONE tdoc in a browser window, playing the whole
// value-prop loop on a 16s CSS clock:
//   select a line -> type a comment -> Comment -> the agent replies
//   "rewriting" -> the old line is struck out -> v2 fades in with the change
//   washed green -> the reply says applied, v1 -> v2.
// It replaced the three-tab rotation (GTM / competitor / design), which only
// showed finished end states and never the loop itself.
//
// Rules that are easy to break by accident:
//   - it is CSS-only: a published tdoc runs no author JavaScript.
//   - every step shares one clock (--T); a step on its own duration drifts.
//   - reduced motion shows the finished v2 state, not a frozen v1.
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
// The demo is the self-contained `.hd` block. Scope every check to it so a
// stray match elsewhere on the page cannot pass a demo assertion.
const demo = work.slice(work.indexOf('<div class="hd" style'), work.indexOf('<!-- /hd demo -->'));
const css = (work.match(/\/\* =+ tdoc demo \(hd-\) =+ \*\/([\s\S]*?)<\/style>/) || [])[1] || '';

console.log('landing demo loop');

t('one window, one doc, one thread', () => {
  assert((demo.match(/<div class="hd-win\b/g) || []).length === 1, 'expected exactly one demo window');
  assert((demo.match(/<div class="hd-doc">/g) || []).length === 1, 'expected one doc');
  assert((demo.match(/<aside class="hd-notes">/g) || []).length === 1, 'expected one comment panel');
  assert(!/<input type="radio" name="hd"/.test(demo), 'the old tab switcher is back');
});

t('the doc shows both versions, v1 and v2', () => {
  for (const v of ['hd-v1', 'hd-v2']) assert(new RegExp(`<div class="${v}">`).test(demo), `missing .${v}`);
  const v1 = demo.slice(demo.indexOf('<div class="hd-v1">'), demo.indexOf('<div class="hd-v2">'));
  const v2 = demo.slice(demo.indexOf('<div class="hd-v2">'), demo.indexOf('<aside'));
  assert(/class="hd-sel"/.test(v1), 'v1 needs the line that gets selected');
  assert(/class="hd-pin"/.test(v1), 'v1 needs the comment pin');
  assert(/class="hd-new"/.test(v2), 'v2 needs the rewritten line');
  const sel = (v1.match(/class="hd-sel">([^<]+)</) || [])[1];
  const quote = (demo.match(/class="hd-quote">([^<]+)</) || [])[1];
  assert(sel && sel === quote, `the comment must quote the selected line (sel "${sel}", quote "${quote}")`);
});

t('the thread is one comment and one agent reply', () => {
  assert((demo.match(/<b>Jesse Pollak<\/b>/g) || []).length === 1, 'expected one human comment');
  assert((demo.match(/<div class="hd-reply">/g) || []).length === 1, 'expected one agent reply');
  assert(/class="[^"]*\bhd-work\b/.test(demo) && /class="hd-done"/.test(demo), 'the reply needs a working and a done state');
  assert(/class="hd-chip"[\s\S]{0,120}?applied/.test(demo), 'the done reply must carry an "applied" chip');
});

t('CSS-only, on one shared clock', () => {
  assert(!/<script\b/i.test(work), 'the page contains a <script>; a published tdoc runs none');
  const anims = [...css.matchAll(/animation:\s*(hd-[\w-]+)\s+([^\s;]+)/g)];
  assert(anims.length >= 10, `expected the loop steps to be animated, found ${anims.length}`);
  for (const [, name, dur] of anims) {
    if (name === 'hd-dot') continue; // the typing dots pulse on their own
    assert(dur === 'var(--T)', `${name} runs on ${dur}, not the shared var(--T) clock`);
    assert(new RegExp(`@keyframes ${name}\\b`).test(css), `missing @keyframes ${name}`);
  }
  assert(/--T:\s*16s/.test(css), 'the clock must be defined on .hd');
});

t('reduced motion shows the finished v2 state', () => {
  const rm = (css.match(/@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n  \}/) || [])[1] || '';
  assert(/animation:\s*none/.test(rm), 'reduced motion must stop the clock');
  assert(/\.hd-v1[^{]*\{opacity:0/.test(rm), 'reduced motion must hide v1');
  assert(/\.hd-v2[^{]*\{opacity:1/.test(rm), 'reduced motion must show v2');
});

t('the artifacts are crafted statics, not live iframes', () => {
  assert(!/<iframe/i.test(work), 'the demo must not frame an iframe');
  assert(/class="hd-bars"/.test(demo), 'v1 needs its crafted bar chart');
  assert(/class="hd-hbars"/.test(demo), 'v2 needs its rewritten cost chart');
});

t('the tab is browser chrome, and the page is indexable', () => {
  assert(/\.hd-tab\s*\{[^}]*background:#fff/.test(work), 'the tab should read as a focused tab');
  assert(!/\.hd-tab[^}]*background:var\(--accent\)/.test(work), 'the tab must not take the CTA colour');
  assert(/#hd-fbars/.test(demo), 'the tab favicon must be the glyph symbol, not emoji');
  assert(!/name="robots"[^>]*noindex/.test(work), 'the homepage must not carry noindex');
});

t('a real published doc sits under the mock and links to it', () => {
  const after = work.slice(work.indexOf('<!-- /hd demo -->'), work.indexOf('</section>', work.indexOf('<!-- /hd demo -->')));
  const a = after.match(/<a class="hd-real" href="([^"]+)">([\s\S]*?)<\/a>/);
  assert(a, 'missing the .hd-real link under the demo');
  assert(/^\/d\/[a-z0-9-]+$/.test(a[1]), `the real doc link should be a /d/<slug> path, got ${a[1]}`);
  const img = a[2].match(/<img src="data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+\/=]+)"[^>]*>/);
  assert(img, 'the screenshot must be inline (the release payload ships index.html only)');
  assert(img[2].length < 80000, `the screenshot is ${img[2].length} base64 chars; keep it under 80k`);
  assert(/alt="[^"]{20,}"/.test(a[2]) && /width="\d+" height="\d+"/.test(a[2]), 'the screenshot needs alt text and a size');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
