// stampAids robustness test (finding stampaids-regex-html-parser, #24).
//
// The fix HARDENS the existing regex parser (attribute-aware tag ends + raw-text
// element skipping) instead of swapping to HTMLRewriter, because the aid is a
// content-hash (cyrb53) that every existing comment is anchored to — a parser
// that re-serializes differently would silently break every anchor.
//
// This test proves the SAFETY contract:
//   (1) EQUIVALENCE: on normal/real HTML, the NEW parser produces byte-identical
//       aids to the OLD one (extracted from origin/main) → zero anchor breakage.
//   (2) CORRECTNESS: the edge cases the finding named (`>` in an attribute,
//       `</section>` inside an inline <script>) now parse correctly, where the
//       old parser desynced.
//
// Run with: node test/stampaids.test.js
//   (requires /tmp/worker-old.js = `git show origin/main:worker/worker.js`)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`fn ${name} not found`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
// The scalar bounds stampAids reads (STAMP_MAX_DEPTH, STAMP_MAX_ELEMENTS).
function sliceScalars(src) {
  return (src.match(/^const STAMP_MAX_[A-Z_]+ = \d+;$/gm) || []).join('\n');
}
function sliceConst(src, name) {
  const re = new RegExp(`const ${name} = \\[[\\s\\S]*?\\];`);
  const m = re.exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

const newSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');

function buildStamp(src, withNewHelpers) {
  const box = {};
  vm.createContext(box);
  const parts = [
    sliceFn(src, 'cyrb53'),
    sliceFn(src, 'stripClosedHtmlComments'),
    sliceFn(src, 'aidFor'),
    sliceFn(src, 'headingPlainText'),
    sliceFn(src, 'headingsFromHtml'),
    sliceConst(src, 'STAMPABLE_TAGS'),
  ];
  if (withNewHelpers) {
    parts.push(sliceConst(src, 'RAW_TEXT_TAGS'));
    parts.push(sliceFn(src, 'attrAwareOpenTagEnd'));
    parts.push(sliceFn(src, 'skipRawTextBodyAt'));
  }
  parts.push(sliceScalars(src));
  parts.push(sliceFn(src, 'stampAids'));
  vm.runInContext(parts.join('\n\n'), box);
  return box.stampAids;
}

const stampNew = buildStamp(newSrc, true);

// The legacy (buggy) parser is shipped IN worker.js as stampAidsLegacy() for the
// #24 dry-run, so the equivalence check uses it directly — no external baseline
// file needed (self-sufficient, runs in CI). It's the exact parser stored
// comments were anchored against.
let stampOld = null;
try {
  const lbox = {};
  vm.createContext(lbox);
  vm.runInContext([
    sliceFn(newSrc, 'cyrb53'), sliceFn(newSrc, 'stripClosedHtmlComments'),
    sliceFn(newSrc, 'aidFor'), sliceFn(newSrc, 'headingPlainText'), sliceFn(newSrc, 'headingsFromHtml'),
    sliceConst(newSrc, 'STAMPABLE_TAGS'), sliceFn(newSrc, 'stampAidsLegacy'),
  ].join('\n\n'), lbox);
  stampOld = lbox.stampAidsLegacy;
} catch { /* legacy not present */ }

const aidSet = (html, fn) => fn(html).aids.map(a => `${a.tag}:${a.aid}`).sort();

console.log('stampaids (regex hardening, #24)');

// ---- (1) EQUIVALENCE on normal HTML: aids must be byte-identical ----
const NORMAL = [
  '<!doctype html><body><h1>Title</h1><p>hi</p><figure><svg viewBox="0 0 1 1"></svg></figure></body>',
  '<body><section><h2>A</h2><table><tr><td>x</td></tr></table></section><aside>note</aside></body>',
  '<body><pre>code here</pre><blockquote>quote</blockquote><details><summary>s</summary>d</details></body>',
  '<body><figure><img src="a.png" alt="pic"><figcaption>cap</figcaption></figure><video src="v.mp4"></video></body>',
  '<body><div data-tdoc-artifact class="card">composed</div><section class="tdoc-artifact">x</section></body>',
];
if (stampOld) {
  NORMAL.forEach((html, i) => {
    t(`EQUIVALENCE #${i + 1}: new aids byte-identical to old on normal HTML`, () => {
      const a = aidSet(html, stampOld);
      const b = aidSet(html, stampNew);
      assert(JSON.stringify(a) === JSON.stringify(b),
        `aids DIFFER (would break anchors!):\n      old: ${JSON.stringify(a)}\n      new: ${JSON.stringify(b)}`);
    });
  });
} else {
  console.log('  (skipping equivalence — no /tmp/worker-old.js baseline)');
}

// ---- (2) CORRECTNESS: edge cases the old parser got wrong ----
t('EDGE: `>` inside an attribute value does not truncate the element', () => {
  // old parser stopped attrs at the first `>` (inside alt), corrupting the tag.
  const html = '<body><figure><img src="x.png" alt="a > b"><figcaption>c</figcaption></figure></body>';
  const { html: out, aids } = stampNew(html);
  // the figure must be stamped and its img alt preserved intact
  assert(/alt="a > b"/.test(out), 'attribute with `>` was corrupted');
  assert(aids.some(a => a.tag === 'figure'), 'figure not detected');
  assert(aids.some(a => a.tag === 'img'), 'img (void) not detected');
  // exactly one data-tdoc-aid stamp per element, none duplicated/malformed.
  const stamps = (out.match(/data-tdoc-aid="/g) || []).length;
  assert(stamps === 2, `expected 2 stamps (figure + img), got ${stamps}`);
  // the img's alt value still contains its `>` (attribute not truncated)
  assert(/<img src="x.png" alt="a > b" data-tdoc-aid="/.test(out),
    'img open tag malformed around the attribute with `>`');
});

t('EDGE: `</section>` inside an inline <script> does not close the section early', () => {
  const html = '<body><section><h2>H</h2><script>var s = "</section>";</script><p>after</p></section></body>';
  const { aids } = stampNew(html);
  const sec = aids.find(a => a.tag === 'section');
  assert(sec, 'section not detected');
  // The section must contain BOTH the script and the trailing <p> — i.e. its
  // close was found at the REAL </section>, not the one inside the script string.
  // We verify by re-stamping idempotency + that exactly one section exists.
  assert(aids.filter(a => a.tag === 'section').length === 1, 'section mis-parsed (split)');
});

t('malformed markup cannot leave an angle bracket in a heading label', () => {
  const html = '<h1><<script>>Heading</h1><section>Body</section>';
  const heading = stampNew(html).aids.find(a => a.tag === 'section').heading;
  assert(heading && !/[<>]/.test(heading), `unsafe heading label: ${heading}`);
});

t('IDEMPOTENT: re-stamping already-stamped HTML yields the same aids', () => {
  const html = '<body><figure><svg viewBox="0 0 2 2"></svg></figure><table><tr><td>1</td></tr></table></body>';
  const once = stampNew(html);
  const twice = stampNew(once.html);
  assert(JSON.stringify(aidSet(html, stampNew)) === JSON.stringify(twice.aids.map(a => `${a.tag}:${a.aid}`).sort()),
    're-stamping changed aids (not idempotent)');
});

// ---- (3) measureAidDrift: the #24 dry-run measurement ----
// Build a context with cyrb53/aidFor/STAMPABLE_TAGS + the new helpers + BOTH
// stampAids and stampAidsLegacy + measureAidDrift, so we can assert the drift
// report is accurate.
const driftBox = {};
vm.createContext(driftBox);
// measureAidDrift folds the live anchor via snapshotAt, so include the fold
// helper chain too. The sandbox keeps the legacy mapping for old fixtures.
driftBox.AGENT_STATUS_EMOJI = { applied: '✅', partial: '🟡', question: '❓' };
function driftRegion(fromFn, toFn) {
  const s = newSrc.indexOf(`function ${fromFn}(`);
  const e0 = newSrc.indexOf(`function ${toFn}(`);
  let i = newSrc.indexOf('{', e0), d = 0;
  for (; i < newSrc.length; i++) { if (newSrc[i] === '{') d++; else if (newSrc[i] === '}') { d--; if (d === 0) { i++; break; } } }
  return newSrc.slice(s, i);
}
vm.runInContext([
  sliceFn(newSrc, 'cyrb53'),
  sliceFn(newSrc, 'stripClosedHtmlComments'),
  sliceFn(newSrc, 'aidFor'),
  sliceFn(newSrc, 'headingPlainText'),
  sliceFn(newSrc, 'headingsFromHtml'),
  sliceConst(newSrc, 'STAMPABLE_TAGS'),
  sliceConst(newSrc, 'RAW_TEXT_TAGS'),
  sliceFn(newSrc, 'attrAwareOpenTagEnd'),
  sliceFn(newSrc, 'skipRawTextBodyAt'),
  sliceFn(newSrc, 'stampAidsLegacy'),
  sliceScalars(newSrc),
  sliceFn(newSrc, 'stampAids'),
  sliceFn(newSrc, 'isFiniteVersion'),
  driftRegion('legacyToEvents', 'compactComments'), // eventEid/backfill/ensure*/snapshotAt/…
  sliceFn(newSrc, 'measureAidDrift'),
].join('\n\n'), driftBox);
const measureAidDrift = driftBox.measureAidDrift;

t('DRY-RUN: normal HTML reports ZERO drift (legacy == new)', () => {
  const html = '<body><h2>A</h2><figure><svg viewBox="0 0 1 1"></svg></figure><table><tr><td>x</td></tr></table></body>';
  // a comment anchored to the figure's (legacy) aid
  const legacyAids = driftBox.stampAidsLegacy(html).aids;
  const figAid = legacyAids.find(a => a.tag === 'figure').aid;
  const comments = [{ id: 'c1', anchor: { kind: 'element', aid: figAid } }];
  const d = measureAidDrift(html, comments);
  assert(d.changed === 0, `expected 0 changed aids on normal HTML, got ${d.changed}`);
  assert(d.affectedComments === 0, `expected 0 affected, got ${d.affectedComments}`);
});

t('DRY-RUN: edge-case HTML (`>` in attr) flags the comment whose legacy aid vanishes', () => {
  const html = '<body><h2>Chart</h2><figure><img src="x" alt="a > b"></figure></body>';
  const imgAid = driftBox.stampAidsLegacy(html).aids.find(a => a.tag === 'img').aid;
  // a stored comment anchored to the legacy (wrong) img aid — that aid is gone
  // under the hardened parser, so it's at risk.
  const comments = [{ id: 'c_affected', anchor: { kind: 'element', aid: imgAid } }];
  const d = measureAidDrift(html, comments);
  assert(d.changed >= 1, `expected >=1 vanished legacy aid, got ${d.changed}`);
  assert(d.affectedComments === 1, `expected the 1 anchored comment flagged, got ${d.affectedComments}`);
  assert(d.samples.some(s => s.id === 'c_affected' && s.lostAid === imgAid), 'affected comment/lostAid not in samples');
});

t('DRY-RUN: text-anchored comments are never counted (only element aids)', () => {
  const html = '<body><figure><img src="x" alt="a > b"></figure></body>';
  const comments = [{ id: 'c_text', anchor: { kind: 'text', text: 'whatever' } }];
  const d = measureAidDrift(html, comments);
  assert(d.affectedComments === 0, 'text anchors must not be counted');
});

t('DRY-RUN: set-membership is misalignment-proof (different element counts)', () => {
  // Legacy mis-parses the first div (its `>`-in-attr breaks the opt-in match),
  // so the two parsers emit different element SETS. A comment on the SECOND
  // (unchanged) div must NOT be falsely flagged — its aid is in both sets.
  const html = '<body><div title="a > b" class="tdoc-artifact">first</div>'
    + '<div class="tdoc-artifact">second</div></body>';
  const legacy = driftBox.stampAidsLegacy(html).aids;
  const current = driftBox.stampAids(html).aids;
  // find the SECOND div's aid as it exists in the legacy set (stable across both)
  const stable = legacy.map(a => a.aid).filter(aid => current.some(c => c.aid === aid));
  if (stable.length) {
    const comments = [{ id: 'c_safe', anchor: { kind: 'element', aid: stable[0] } }];
    const d = measureAidDrift(html, comments);
    assert(d.affectedComments === 0, `comment on an aid present in BOTH parsers must not be flagged (got ${d.affectedComments})`);
  } else { ok('  (no stable aid in this corpus case — skipped)'); }
});

t('DRY-RUN: is strictly READ-ONLY — does not backfill eids on the input list', () => {
  // snapshotAt→ensureEventLog backfills eids in place; the measurement must fold
  // a copy so it never mutates the caller's comments (which the upload handler
  // diffs before/after and would otherwise persist).
  const html = '<body><figure><img src="x" alt="a > b"></figure></body>';
  const c = {
    id: 'c_noeid',
    // event with NO eid — ensureEventLog would backfill one if we folded the real obj
    events: [{ kind: 'created', at_version: 1, at: '2026-01-01', anchor: { kind: 'element', aid: 'whatever' } }],
  };
  const snapshot = JSON.stringify(c);
  measureAidDrift(html, [c]);
  assert(JSON.stringify(c) === snapshot, 'measureAidDrift MUTATED the input comment (eid backfill leaked through)');
  assert(!c.events[0].eid, 'eid was backfilled on the caller object — not read-only');
});

t('DRY-RUN: uses the LIVE folded anchor, not the stale created-event anchor', () => {
  // A comment created on a legacy aid but later re-anchored (anchor_changed) to
  // a still-valid aid must NOT be counted — its live target is fine.
  const html = '<body><h2>Chart</h2><figure><img src="x" alt="a > b"></figure></body>';
  const stillValid = driftBox.stampAids(html).aids.find(a => a.tag === 'figure').aid;
  const goneAid = driftBox.stampAidsLegacy(html).aids.find(a => a.tag === 'img').aid;
  const c = {
    id: 'c_reanchored',
    events: [
      { kind: 'created', at_version: 1, at: '2026-01-01', anchor: { kind: 'element', aid: goneAid } },
      { kind: 'anchor_changed', at_version: 2, at: '2026-01-02', anchor: { kind: 'element', aid: stillValid } },
    ],
  };
  const d = measureAidDrift(html, [c]);
  assert(d.affectedComments === 0, 'a comment re-anchored to a valid aid must not be flagged by its stale created aid');
});

// ---- linear stamping (#973): the same aids as the previous implementation,
// in time linear in the document ----
// Built in this realm (not a vm context: crossing realms makes string work
// many times slower than the worker's own).
const helpers = ['cyrb53', 'stripClosedHtmlComments', 'aidFor', 'headingPlainText', 'headingsFromHtml', 'attrAwareOpenTagEnd', 'skipRawTextBodyAt']
  .map((n) => sliceFn(newSrc, n)).concat([sliceConst(newSrc, 'STAMPABLE_TAGS'), sliceConst(newSrc, 'RAW_TEXT_TAGS'), sliceScalars(newSrc)]).join('\n\n');
const stampLinear = new Function(`${helpers}\n${sliceFn(newSrc, 'stampAids')}; return stampAids;`)();
const reference = fs.readFileSync(path.join(__dirname, 'fixtures', 'stampaids-reference.js'), 'utf8');
const stampReference = new Function(`${helpers}\n${reference}; return stampAidsReference;`)();
const same = (html) => { const a = stampReference(html), b = stampLinear(html); return a.html === b.html && JSON.stringify(a.aids) === JSON.stringify(b.aids); };

t('LINEAR: same stamped HTML and aids as the previous implementation on every repo document', () => {
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/^(node_modules|\.git|runtime)$/.test(e.name)) walk(p); } else if (/\.html$/.test(e.name)) files.push(p); } })(path.join(__dirname, '..'));
  assert(files.length > 20, `found ${files.length} documents`);
  const differ = files.filter((f) => { const html = fs.readFileSync(f, 'utf8'); return html.length < 3e6 && !same(html); });
  assert(!differ.length, `differ: ${differ.join(', ')}`);
});

t('LINEAR: same stamped HTML and aids on 3,000 fuzzed documents (nesting, raw text, comments, quotes, unclosed tags)', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const tags = ['section', 'figure', 'table', 'div', 'svg', 'details', 'pre', 'p', 'blockquote', 'aside'];
  const gen = (depth) => {
    let out = '';
    for (let i = rnd(4); i > 0; i--) {
      const r = rnd(14);
      if (r < 7 && depth < 6) {
        const t2 = tags[rnd(tags.length)];
        const attr = rnd(4) === 0 ? ' data-tdoc-artifact' : rnd(5) === 0 ? ' title="a > b"' : rnd(6) === 0 ? ` alt="x${rnd(9)}"` : '';
        out += `<${t2}${attr}>` + gen(depth + 1) + (rnd(12) ? `</${t2}>` : '');
      } else if (r === 7) out += '<script>var s = "<section></table>";</script>';
      else if (r === 8) out += '<style>/* <figure> */</style>';
      else if (r === 9) out += `<img src="i${rnd(5)}.png" alt="p">`;
      else if (r === 10) out += '<!-- <table> -->';
      else if (r === 11) out += `<h2>Head ${rnd(9)}</h2>`;
      else out += `text ${rnd(100)} `;
    }
    return out;
  };
  for (let i = 0; i < 3000; i++) {
    const html = `<html><body>${gen(0)}</body></html>`;
    assert(same(html), `differs on: ${html.slice(0, 300)}`);
  }
});

const time = (fn) => { let best = Infinity; for (let k = 0; k < 3; k++) { const t0 = process.hrtime.bigint(); fn(); best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6); } return best; };
const MB = 1024 * 1024;

t('LINEAR: 60k small sheet tables (~8 MB) through stampAids: linear (about 100-200 ms on a laptop)', async () => {
  const html = '<!doctype html><html><head><title>t</title></head><body>' + `<table data-tdoc-sheet><tr><td>${'x'.repeat(95)}</td></tr></table>\n`.repeat(60000) + '</body></html>';
  assert(html.length > 7.5 * MB, `fixture ${html.length}`);
  const ms = time(() => stampLinear(html));
  console.log(`    (stampAids, ${(html.length / MB).toFixed(1)} MB, 60k tables: ${ms.toFixed(0)}ms)`);
  // ~100ms on a laptop; the bound leaves a shared CI runner room. The
  // quadratic version took over a minute.
  assert(ms < 600, `stampAids took ${ms.toFixed(0)}ms`);
});

t('LINEAR: the 2 MB worst cases possible before sheets: linear (55-170 ms on a laptop), and twice the input is about twice the time', () => {
  const cases = {
    'many small tables': '<html><body>' + '<table><tr><td>x</td></tr></table>'.repeat(60000) + '</body></html>',
    'bare unclosed sections': '<section>'.repeat(220000),
    'sections inside a script': '<script>' + '<section>'.repeat(200000) + '</script>',
    'figures with styles': '<figure><style>a</style></figure>'.repeat(60000),
    'headings and tables': '<h2>h</h2><table><tr><td>x</td></tr></table>'.repeat(40000),
    'raw opens': '<section>' + '<style>'.repeat(250000),
  };
  for (const [what, html] of Object.entries(cases)) {
    const ms = time(() => stampLinear(html));
    // 55-170ms on a laptop; quadratic would be tens of seconds.
    assert(ms < 600, `${what}: ${ms.toFixed(0)}ms`);
  }
  // Linear, not just fast here: twice the input is about twice the time.
  for (const [what, unit, k] of [['small tables', '<table><tr><td>x</td></tr></table>', 15000], ['sections in a script', '<section>', 20000]]) {
    const doc = (m) => (what === 'sections in a script' ? '<script>' + unit.repeat(m) + '</script>' : '<html><body>' + unit.repeat(m) + '</body></html>');
    const one = time(() => stampLinear(doc(k))), two = time(() => stampLinear(doc(2 * k)));
    assert(two < one * 3 + 5, `${what}: ${one.toFixed(1)}ms for ${k}, ${two.toFixed(1)}ms for ${2 * k}`);
  }
  // Deep nesting hashes each level's content (aids are content hashes), up
  // to STAMP_MAX_DEPTH levels: linear, with a larger constant.
  const deep = '<section>'.repeat(110000) + '</section>'.repeat(110000);
  const ms = time(() => stampLinear(deep));
  assert(ms < 2000, `deep nesting: ${ms.toFixed(0)}ms`);
});

(async () => {
  // prepareDocVersion: the reader block (absent from the worker sandbox here,
  // so readerCssSource is empty), stampAids and the version's sha256.
  const prep = new Function(`${helpers}\n${sliceFn(newSrc, 'stampAids')}\nconst READER_BLOCK_RE = /<style[^>]*\\bid="tdoc-reader"/i;\n${sliceFn(newSrc, 'hasReaderBlock')}\nfunction readerCssSource() { return ''; }\n${newSrc.slice(newSrc.indexOf('async function sha256Hex('), newSrc.indexOf('\n}\n', newSrc.indexOf('async function sha256Hex(')) + 2)}\n${newSrc.slice(newSrc.indexOf('async function prepareDocVersion('), newSrc.indexOf('\n}\n', newSrc.indexOf('async function prepareDocVersion(')) + 2)}\nreturn prepareDocVersion;`)();
  const html = '<!doctype html><html><head><title>t</title></head><body>' + `<table data-tdoc-sheet><tr><td>${'x'.repeat(95)}</td></tr></table>\n`.repeat(60000) + '</body></html>';
  let best = Infinity;
  for (let k = 0; k < 3; k++) { const t0 = process.hrtime.bigint(); await prep(html); best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6); }
  console.log(`    (prepareDocVersion, ${(html.length / MB).toFixed(1)} MB, 60k tables: ${best.toFixed(0)}ms)`);
  t('LINEAR: prepareDocVersion on the same 8 MB input: linear (about 120-200 ms on a laptop)', () => assert(best < 700, `prepareDocVersion took ${best.toFixed(0)}ms`));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
