// The landing page's demo: four tdocs shown in the reader's own chrome.
//
// The whole point is that they are the SAME page the product renders, only the
// subject changes, so this file diffs every stage against the first one and
// fails on any drift between them.
//
// Two rules that are easy to break by accident:
//   - the comment threads are static markup, no animation. Only the artifacts
//     move, and they are sandboxed islands.
//   - the tabs are Safari chrome, not a second row of calls to action.
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

console.log('landing demo tabs');

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

t('every stage renders the reader and the thread the same way', () => {
  let refSk = null, cursor = 0, seen = 0;
  while (true) {
    const i = work.indexOf('<div class="browser"', cursor);
    if (i < 0) break;
    const s = stageOf(work, i);
    const sk = skeleton(s.block);
    seen++;
    if (!refSk) {
      refSk = sk;
      assert(refSk.length > 40, `first stage looks wrong: ${refSk.length} nodes`);
      cursor = s.end;
      continue;
    }
    assert(sk.length === refSk.length,
      `stage ${seen} has ${sk.length} nodes, stage 1 has ${refSk.length}`);
    for (let k = 0; k < refSk.length; k++) {
      assert(sk[k] === refSk[k],
        `stage ${seen} node ${k}: got ${sk[k]}, stage 1 has ${refSk[k]}`);
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

t('the four stages are siblings, not nested', () => {
  // They were nested: each panel opened one more div than it closed, so
  // .p-res sat inside .p-rep and so on. Rotation then animated an ancestor's
  // opacity to 0 and every descendant composited away — the demo went blank
  // after six seconds and on three of the four tabs, and the container grew
  // to 2779px because static panels stack instead of sharing a grid cell.
  const starts = [...work.matchAll(/<div class="uc-panel p-\w+">/g)].map((m) => m.index);
  assert(starts.length === 4, `expected 4 panels, found ${starts.length}`);
  // Measure the nesting depth of each panel inside .uc-panels rather than
  // slicing to a sentinel elsewhere in the section: the old check anchored on
  // a caption, so deleting that caption silently moved the boundary.
  const container = work.indexOf('<div class="uc-panels"');
  assert(container > -1, 'missing .uc-panels container');
  const depths = starts.map((i) => {
    const seg = work.slice(container, i);
    return (seg.match(/<div\b/g) || []).length - (seg.match(/<\/div>/g) || []).length;
  });
  assert(depths.every((d) => d === depths[0]),
    `panels sit at depths ${depths.join(', ')} — they must be siblings`);
  assert(depths[0] === 1,
    `panels must be direct children of .uc-panels, found depth ${depths[0]}`);
});

t('the stage is cropped like a screenshot', () => {
  // The doc keeps going past the frame on purpose. Without the cap the stage
  // ends early and leaves dead space under a short column — and this rule has
  // already been deleted once by an unrelated rewrite of the block it used to
  // sit in, with nothing to catch it.
  assert(/\.doc-tail \{[^}]*max-height:104px/.test(work), 'the trailing prose is no longer capped');
  // Only the tail may truncate: a cut ring or a cut comment card reads broken.
  assert(!/\.stage(-doc)? \{[^}]*max-height/.test(work),
    'capping the stage crops the artifact and the thread; cap .doc-tail instead');
  // The thread must never be the thing that gets cut.
  assert(/\.doc-tail:after \{[^}]*linear-gradient\(transparent,#fff\)/.test(work),
    'the crop needs a fade, or it looks like the content simply stops');
  assert(/\.doc-tail \{ max-height:78px/.test(work), 'no shorter cap on narrow screens');
  // The margin column starves the artifact below ~900; the split has to give.
  assert(/@media \(max-width:900px\) \{\s*\.stage \{ grid-template-columns:1fr; \}/.test(work),
    'the stage must collapse to one column before the artifact is squeezed');
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
    const p = path.join(root, 'landing', 'tornado-doc', `v${latest}`, 'widgets', `${w}.html`);
    assert(fs.existsSync(p), `missing widget file for ${w}`);
    // Not every artifact needs to move. The growth report is a table on
    // purpose — an animation there is decoration competing with the numbers.
    // What matters is that it is a real island, served by the widget route.
    const body = fs.readFileSync(p, 'utf8');
    assert(/<html/i.test(body) && body.length > 200, `${w} is not a real page`);
  }
});

t('the tabs are Safari chrome, and the page is indexable', () => {
  // The tabs are Safari chrome, not a second row of CTAs: the accent colour
  // belongs to the call to action, and a coloured tab competes with it.
  assert(/\.sft\.on \{[^}]*background:#fff/.test(work),
    'the active tab should read as a focused Safari tab, not as a button');
  assert(!/\.sft[^}]*background:var\(--accent\)/.test(work),
    'tabs must not take the CTA colour');
  // Safari divides inactive tabs with hairlines and lifts the focused one.
  assert(/\.sft \+ \.sft:before/.test(work), 'inactive tabs need Safari hairline dividers');
  assert(/\.sft\.on \{[^}]*box-shadow/.test(work), 'the focused tab should lift off the bar');
  // This is the homepage now. The experiment's noindex must not have ridden
  // along with it.
  assert(!/name="robots"[^>]*noindex/.test(work), 'the homepage must not carry noindex');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
