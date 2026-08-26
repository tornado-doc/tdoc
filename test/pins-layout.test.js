// Pins layout tests (v0.8.0 pins-in-margin feature).
//
// The 0.8.0 release replaced the margin card-stack with pins whose placement is
// decided by a pure clustering/spreading/overflow algorithm: layoutPins() in
// server/overlay.js. That math had ZERO automated coverage — a regression in
// the thresholds or the overflow-fold would ship green. This VM-extracts the
// pure function (same pattern as overlay-pure.test.js) and pins its invariants:
//   - same-line comments (within SAME_LINE_GAP) merge into one cluster
//   - comments just outside SAME_LINE_GAP spread (>= PIN_MIN_GAP apart)
//   - multiple comments on ONE tall element distribute down it; on a SHORT
//     element they cluster
//   - the overflow-fold guarantees no placed pin exceeds articleTop+articleHeight
//
// Run with: node test/pins-layout.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'chrome.js'), 'utf8');
function sliceFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`fn ${name} not found in overlay.js`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const box = {};
vm.createContext(box);
vm.runInContext(sliceFn('layoutPins'), box);
const { layoutPins } = box;

// The real constants from overlay.js (PIN_SIZE=28 → PIN_MIN_GAP=32, SAME_LINE_GAP=12).
const CONSTS = { PIN_SIZE: 28, PIN_MIN_GAP: 32, SAME_LINE_GAP: 12 };
const GEO = { articleTop: 0, articleHeight: 10000 }; // roomy by default
// Build a placeable row (mirrors commentY output shape).
const row = (id, y, extra = {}) => ({ c: { id }, y, el: null, elTop: 0, elHeight: 0, ...extra });

console.log('pins-layout (v0.8.0 pins core)');

// ---- same-line clustering ----
t('two comments within SAME_LINE_GAP merge into ONE cluster', () => {
  const placed = layoutPins([row('a', 100), row('b', 108)], GEO, CONSTS); // 8px apart < 12
  assert(placed.length === 1, `expected 1 cluster, got ${placed.length}`);
  assert(placed[0].items.length === 2, 'both comments should be in the cluster');
});

t('two comments just OUTSIDE SAME_LINE_GAP stay separate and spread >= PIN_MIN_GAP', () => {
  const placed = layoutPins([row('a', 100), row('b', 120)], GEO, CONSTS); // 20px apart > 12
  assert(placed.length === 2, `expected 2 clusters, got ${placed.length}`);
  const gap = placed[1].y - placed[0].y;
  assert(gap >= CONSTS.PIN_MIN_GAP, `pins must be >= PIN_MIN_GAP apart, got ${gap}`);
});

t('overlapping-but-not-same-line pins are pushed down to PIN_MIN_GAP', () => {
  // 100 and 118: 18px apart (> SAME_LINE_GAP so separate, < PIN_MIN_GAP so must spread)
  const placed = layoutPins([row('a', 100), row('b', 118)], GEO, CONSTS);
  assert(placed.length === 2, 'should be two separate pins');
  assert(placed[1].y - placed[0].y >= CONSTS.PIN_MIN_GAP, 'second pin pushed down to min gap');
});

// ---- same-element spread vs cluster ----
t('multiple comments on ONE TALL element distribute down it (individual pins)', () => {
  const el = {}; // identity token for "same element"
  const rows = [
    row('a', 200, { el, elTop: 200, elHeight: 300 }),
    row('b', 200, { el, elTop: 200, elHeight: 300 }),
    row('c', 200, { el, elTop: 200, elHeight: 300 }),
  ];
  const placed = layoutPins(rows, GEO, CONSTS);
  assert(placed.length === 3, `tall element should spread to 3 pins, got ${placed.length}`);
});

t('multiple comments on a SHORT element cluster into one badge', () => {
  const el = {};
  const rows = [
    row('a', 200, { el, elTop: 200, elHeight: 20 }), // usable < PIN_MIN_GAP → no spread
    row('b', 200, { el, elTop: 200, elHeight: 20 }),
  ];
  const placed = layoutPins(rows, GEO, CONSTS);
  assert(placed.length === 1, `short element should cluster, got ${placed.length}`);
  assert(placed[0].items.length === 2, 'both comments in one cluster');
});

// ---- overflow-fold invariant ----
t('OVERFLOW: no placed pin exceeds articleTop+articleHeight (tail folds in)', () => {
  const tight = { articleTop: 0, articleHeight: 100 }; // only ~3 pins fit at 32px gap
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(row('c' + i, i * 40)); // 10 pins, way past 100px
  const placed = layoutPins(rows, tight, CONSTS);
  const limit = tight.articleTop + tight.articleHeight;
  for (const cl of placed) {
    assert(cl.y <= limit, `pin at y=${cl.y} exceeds bottom limit ${limit}`);
  }
  // every comment is still accounted for (folded into a cluster, never dropped)
  const total = placed.reduce((n, cl) => n + cl.items.length, 0);
  assert(total === 10, `all 10 comments must be placed, got ${total}`);
});

t('empty input yields no clusters', () => {
  assert(layoutPins([], GEO, CONSTS).length === 0, 'empty rows → no pins');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
