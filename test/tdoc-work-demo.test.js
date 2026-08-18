// The experimental work-angle landing page (landing/tdoc-work).
//
// Its demo is four tdocs shown in the reader's own chrome. The whole point is
// that they are the SAME page the product renders, only the subject changes —
// so this file diffs each stage's structure against the reference stage on the
// live landing page and fails on any drift.
//
// Two rules that are easy to break by accident:
//   - the comment threads are static markup, no animation. Only the artifacts
//     move, and they are sandboxed islands.
//   - this experiment must never reach tdoc.dev.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const work = fs.readFileSync(path.join(root, 'landing', 'tdoc-work', 'v1', 'index.html'), 'utf8');
const refMeta = JSON.parse(fs.readFileSync(path.join(root, 'landing', 'tornado-doc', 'meta.json'), 'utf8'));
const refLatest = refMeta.versions[refMeta.versions.length - 1].n;
const ref = fs.readFileSync(path.join(root, 'landing', 'tornado-doc', `v${refLatest}`, 'index.html'), 'utf8');

console.log('tdoc-work demo (experiment)');

// tag+class sequence, ignoring text and attribute values
function skeleton(html) {
  const out = [];
  const re = /<(\w+)([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1];
    if (['svg', 'use', 'path', 'symbol', 'br'].includes(tag)) continue;
    const cm = /class="([^"]*)"/.exec(m[2]);
    const cls = cm ? cm[1].split(/\s+/).filter(Boolean).sort().join(' ') : '';
    out.push(cls ? `${tag}.${cls}` : tag);
  }
  return out;
}
// What must match one to one is the reader's chrome and the comment thread —
// the parts tdoc renders identically for every document. The doc BODY is the
// document itself and is expected to differ: a growth report has more
// paragraphs than a Conway explainer, and demanding an equal paragraph count
// would be demanding that every tdoc say the same thing.
function stageOf(html, from) {
  const i = html.indexOf('<div class="tbar">', from);
  const j = html.indexOf('</aside>', i);
  let block = html.slice(i, j);
  // Collapse the whole doc body to a marker. Prose before AND after the
  // artifact is the document talking; the scaffolding around it is the part
  // that has to match.
  block = block.replace(/<div class="doc">[\s\S]*?(?=<aside class="stage-notes">)/,
                        '<div class="doc">DOCBODY');
  return { block, end: j };
}

t('every stage renders the reader and the thread exactly like the real page', () => {
  const refSk = skeleton(stageOf(ref, 0).block);
  assert(refSk.length > 40, `reference stage looks wrong: ${refSk.length} nodes`);
  // The chrome is allowed to differ; the tdoc is not.
  assert(!/class="browser"/.test(stageOf(ref, 0).block), 'comparison should start at the reader bar');
  let cursor = 0, seen = 0;
  while (true) {
    const i = work.indexOf('<div class="browser"', cursor);
    if (i < 0) break;
    const s = stageOf(work, i);
    const sk = skeleton(s.block);
    seen++;
    assert(sk.length === refSk.length,
      `stage ${seen} has ${sk.length} nodes, reference has ${refSk.length}`);
    for (let k = 0; k < refSk.length; k++) {
      assert(sk[k] === refSk[k],
        `stage ${seen} node ${k}: got ${sk[k]}, reference has ${refSk[k]}`);
    }
    cursor = s.end;
  }
  assert(seen === 4, `expected 4 stages, found ${seen}`);
});

t('every commenter is Jesse Pollak, and the agents differ', () => {
  const commenters = [...work.matchAll(/<div class="mc-login">([^<]+)<\/div>/g)].map(m => m[1]);
  assert(commenters.length === 4, `expected 4 top-level commenters, found ${commenters.length}`);
  assert(commenters.every(c => c === 'Jesse Pollak'), `not all Jesse: ${[...new Set(commenters)]}`);
  const agents = [...work.matchAll(/mc-author[\s\S]{0,240}?<span class="mc-login">([^<]+)<\/span>/g)].map(m => m[1]);
  assert(new Set(agents).size === 4, `agents should all differ, got ${agents}`);
  for (const a of ['Claude', 'Codex', 'Grok', 'Cursor']) {
    assert(agents.includes(a), `missing a ${a} reply`);
  }
});

t('the comment threads are static', () => {
  // Only the artifacts may move. A transition or keyframe on any comment part
  // means the mock is animating something the real reader does not.
  const stage = stageOf(work, 0).block;
  assert(!/animation|@keyframes|transition/i.test(stage),
    'a comment stage carries animation; threads must be static markup');
  // The switcher is CSS radio, not script — this page runs no author JS.
  assert(!/<script\b/i.test(work), 'the page contains a <script>; CSP will not run it');
  assert(/input type="radio" name="uc"/.test(work), 'the use-case switcher is not CSS radio');
});

t('the demo cycles all four use cases, and clicking pins one', () => {
  // One demo on a loop only ever sells one use case. Untouched it rotates;
  // clicking a tab stops it where it was put.
  for (const k of ['cyc1', 'cyc2', 'cyc3', 'cyc4']) {
    assert(new RegExp('@keyframes ' + k).test(work), `missing rotation keyframe ${k}`);
  }
  assert(/:not\(:has\(input:checked\)\)/.test(work),
    'rotation must stop once a tab is chosen');
  assert(/@supports not selector\(:has\(\*\)\)/.test(work),
    'without :has support the page must still show a demo, not an empty frame');
  assert(/prefers-reduced-motion[\s\S]{0,200}animation:none/.test(work),
    'reduced motion must pin one use case instead of rotating');
  // Rotation is the panel swapping. The threads inside stay static.
  assert(!/animation/.test(stageOf(work, 0).block), 'a comment stage animates');
});

t('the stage is cropped like a screenshot', () => {
  // The doc keeps going past the frame on purpose. Without the cap the stage
  // ends early and leaves dead space under a short column — and this rule has
  // already been deleted once by an unrelated rewrite of the block it used to
  // sit in, with nothing to catch it.
  assert(/\.stage \{[^}]*max-height:560px/.test(work), 'the stage is no longer capped');
  assert(/\.stage:after \{[^}]*linear-gradient\(transparent,#fff\)/.test(work),
    'the crop needs a fade, or it looks like the content simply stops');
  assert(/max-height:520px/.test(work), 'no shorter cap on narrow screens');
});

t('the artifacts are real sandboxed islands', () => {
  const frames = [...work.matchAll(/<iframe[^>]*class="[^"]*\blife\b[^>]*>/g)].map(m => m[0]);
  assert(frames.length === 4, `expected 4 artifacts, found ${frames.length}`);
  for (const f of frames) {
    assert(/sandbox="allow-scripts"/.test(f), `artifact missing sandbox: ${f.slice(0, 80)}`);
    assert(!/allow-same-origin/.test(f), 'artifact must not get allow-same-origin');
  }
  const widgets = [...work.matchAll(/\/widget\/(\w+)"/g)].map(m => m[1]);
  assert(new Set(widgets).size === 4, `each stage needs its own artifact, got ${widgets}`);
  for (const w of widgets) {
    const p = path.join(root, 'landing', 'tdoc-work', 'v1', 'widgets', `${w}.html`);
    assert(fs.existsSync(p), `missing widget file for ${w}`);
    // Not every artifact needs to move. The growth report is a table on
    // purpose — an animation there is decoration competing with the numbers.
    // What matters is that it is a real island, served by the widget route.
    const body = fs.readFileSync(p, 'utf8');
    assert(/<html/i.test(body) && body.length > 200, `${w} is not a real page`);
  }
});

t('the experiment cannot reach tdoc.dev', () => {
  // The tabs are Safari chrome, not a second row of CTAs: the accent colour
  // belongs to the call to action, and a coloured tab competes with it.
  assert(/\.sft\.on \{[^}]*background:#fff/.test(work),
    'the active tab should read as a focused Safari tab, not as a button');
  assert(!/\.sft[^}]*background:var\(--accent\)/.test(work),
    'tabs must not take the CTA colour');
  // Safari divides inactive tabs with hairlines and lifts the focused one.
  assert(/\.sft \+ \.sft:before/.test(work), 'inactive tabs need Safari hairline dividers');
  assert(/\.sft\.on \{[^}]*box-shadow/.test(work), 'the focused tab should lift off the bar');
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish-landing.yml'), 'utf8');
  assert(!/tdoc-work/.test(wf), 'the publish workflow now ships the experiment to production');
  assert(/noindex/.test(work), 'the experiment should not be indexed while it is an experiment');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
