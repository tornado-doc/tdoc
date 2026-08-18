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
function stageOf(html, from) {
  const i = html.indexOf('<div class="browser"', from);
  const j = html.indexOf('</aside>', i);
  return { block: html.slice(i, j), end: j };
}

t('every stage matches the real landing page stage, one to one', () => {
  const refSk = skeleton(stageOf(ref, 0).block);
  assert(refSk.length > 40, `reference stage looks wrong: ${refSk.length} nodes`);
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
    assert(/<script\b/.test(fs.readFileSync(p, 'utf8')), `${w} is not actually live`);
  }
});

t('the experiment cannot reach tdoc.dev', () => {
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish-landing.yml'), 'utf8');
  assert(!/tdoc-work/.test(wf), 'the publish workflow now ships the experiment to production');
  assert(/noindex/.test(work), 'the experiment should not be indexed while it is an experiment');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
