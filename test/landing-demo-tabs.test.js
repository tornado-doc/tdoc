// The landing page's demo: three tdocs shown in the reader's own browser
// chrome. It is a refined STATIC mock now (no live widget iframes) — the point
// is to sell the value-prop loop (comment -> agent rewrites -> reply -> new
// version), not to faithfully rebuild the product. See the `hd-` component in
// landing/tornado-doc/vN/index.html.
//
// Rules that are easy to break by accident:
//   - three windows, each its own browser chrome, all commented by Jesse
//     Pollak but answered by a DIFFERENT agent (Claude / Codex / Grok).
//   - the demo auto-rotates the three until a tab is clicked, then pins one.
//   - it is CSS-only: a published tdoc runs no author JavaScript.
//   - the comment threads are static markup; nothing there animates.
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
const demo = work.slice(work.indexOf('<div class="hd" style'), work.indexOf('<p class="hd-cap"'));

console.log('landing demo tabs');

t('three windows, each in its own browser chrome', () => {
  const wins = [...demo.matchAll(/<div class="hd-win hd-w[123]">/g)];
  assert(wins.length === 3, `expected 3 windows, found ${wins.length}`);
  assert((demo.match(/<div class="hd-bar">/g) || []).length === 3, 'each window needs its own chrome bar');
  assert((demo.match(/<div class="hd-canvas">/g) || []).length === 3, 'each window needs a doc canvas');
  // Doc and thread are siblings in the canvas, not nested (a nested aside
  // collapses the two-column grid to one — the v2/v3 bug on the old demo).
  for (const cls of ['hd-doc', 'hd-notes']) {
    assert((demo.match(new RegExp(`class="${cls}`, 'g')) || []).length === 3, `expected 3 .${cls}`);
  }
});

t('every commenter is Jesse Pollak, and the three agents differ', () => {
  const humans = (demo.match(/<b>Jesse Pollak<\/b>/g) || []).length;
  assert(humans === 3, `expected 3 Jesse Pollak comments, found ${humans}`);
  const agents = [...demo.matchAll(/<div class="hd-reply">[\s\S]*?<b>([^<]+)<\/b>/g)].map((m) => m[1]);
  assert(agents.length === 3, `expected 3 agent replies, found ${agents.length}`);
  assert(new Set(agents).size === 3, `agents must all differ, got ${agents}`);
  for (const a of ['Claude', 'Codex', 'Grok']) {
    assert(agents.includes(a), `missing a ${a} reply`);
  }
  assert((demo.match(/class="hd-chip b"[\s\S]{0,80}?applied/g) || []).length === 3,
    'each agent reply must carry an "applied" chip');
});

t('the demo is CSS-only and the threads are static', () => {
  assert(!/<script\b/i.test(work), 'the page contains a <script>; a published tdoc runs none');
  assert(/<input type="radio" name="hd"/.test(demo), 'the tab switcher is not CSS radio');
  const threads = demo.match(/<aside class="hd-notes">[\s\S]*?<\/aside>/g) || [];
  assert(threads.length === 3, `expected 3 threads, found ${threads.length}`);
  for (const th of threads) {
    assert(!/animation|transition|@keyframes/i.test(th), 'a comment thread is animating; threads must be static');
  }
});

t('it auto-rotates the three, and clicking a tab pins one', () => {
  for (const k of ['hcyc1', 'hcyc2', 'hcyc3']) {
    assert(new RegExp('@keyframes ' + k).test(work), `missing rotation keyframe ${k}`);
  }
  assert(/\.hd:not\(:has\(input:checked\)\)/.test(work), 'rotation must stop once a tab is chosen');
  assert(/#hd1:checked~\.hd-w1[\s\S]{0,120}animation:\s*none/.test(work),
    'clicking a tab must pin its window and cancel the rotation');
  assert(/@supports not selector\(:has\(\*\)\)/.test(work),
    'without :has support the demo must still show a window, not an empty frame');
  assert(/prefers-reduced-motion[\s\S]{0,260}animation:\s*none/.test(work),
    'reduced motion must pin one window instead of rotating');
});

t('the artifacts are crafted statics, not live iframes', () => {
  assert(!/<iframe/i.test(work), 'the demo must not frame an iframe; it is a static mock now');
  assert(/class="hd-bars"/.test(demo), 'the GTM window needs its crafted bar chart');
  assert(/class="hd-scatter"/.test(demo), 'the competitor window needs its crafted quadrant');
  assert(/class="hd-stack"/.test(demo), 'the design window needs its crafted context-window bar');
});

t('the tabs are browser chrome, and the page is indexable', () => {
  assert(/\.hd-tab\.on\s*\{[^}]*background:#fff/.test(work), 'the active tab should read as a focused tab');
  assert(!/\.hd-tab[^}]*background:var\(--accent\)/.test(work), 'tabs must not take the CTA colour');
  assert(/#hd-fbars/.test(demo) && /#hd-fscan/.test(demo) && /#hd-fcode/.test(demo),
    'tab favicons must be the glyph symbols, not emoji');
  assert(!/name="robots"[^>]*noindex/.test(work), 'the homepage must not carry noindex');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
