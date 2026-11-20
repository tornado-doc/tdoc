// Stable block ids across versions (server/block-ids.js, flag stableBlockIds):
// segmentation, the version-to-version matcher (insert above, light edit,
// split, merge, duplicates, p -> li, moves), quote location, bounds.
const assert = require('assert/strict');
const parse5 = require('parse5');
const B = require('../server/block-ids');

const page = (body) => `<!doctype html><html><head><title>t</title><style>p{}</style></head><body>${body}</body></html>`;
const build = (body, prev, v) => B.build(page(body), prev, v, parse5);
const ids = (s) => s.blocks.map((b) => b.id);
const idOf = (s, words) => {
  const hit = s.blocks.find((b) => b.t.includes(words));
  assert(hit, `no block with "${words}"`);
  return hit.id;
};

let n = 0;
function test(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }

test('segmentation opens wrappers, skips scripts and tdoc chrome, keeps house blocks whole', () => {
  const blocks = B.segment(page(`
    <div class="wrap"><h1>Title</h1><section><p>One <b>bold</b> line.</p><p>Two</p></section>
    <aside class="note"><p>Inside a note</p></aside><figure><img alt="chart"><figcaption>Cap</figcaption></figure>
    <script>var x = "not text";</script><div id="tdoc-pins">chrome</div><p>   </p></div>`), parse5);
  assert.deepEqual(blocks.map((b) => b.tag), ['h1', 'p', 'p', 'aside', 'figure']);
  assert.equal(blocks[1].t, 'one bold line.');
  assert.deepEqual(blocks[0].path, [0, 0]);
  assert.deepEqual(blocks[1].path, [0, 1, 0], 'a plain section is opened, its path says so');
  assert.equal(blocks[3].t, 'inside a note');
  assert(blocks[4].t.includes('chart') && blocks[4].t.includes('cap'));
});

test('block text keeps paragraph boundaries apart', () => {
  const [ul] = B.segment(page('<ul><li>alpha</li><li>beta</li></ul>'), parse5);
  assert.equal(ul.t, 'alpha beta');
});

test('identical version keeps every id', () => {
  const body = '<h1>T</h1><p>First paragraph here.</p><p>Second paragraph there.</p>';
  const v1 = build(body, null, 1);
  const v2 = build(body, v1, 2);
  assert.deepEqual(ids(v2), ids(v1));
  assert.equal(new Set(ids(v1)).size, 3, 'ids are unique');
});

test('paragraphs inserted above: the commented block keeps its id at its new place', () => {
  const v1 = build('<h1>Plan</h1><p>Billing ships first because invoices block renewals.</p><p>Mobile waits.</p>', null, 1);
  const v2 = build('<h1>Plan</h1><p>A new intro.</p><p>Another new paragraph.</p><p>Billing ships first because invoices block renewals.</p><p>Mobile waits.</p>', v1, 2);
  assert.equal(idOf(v2, 'billing ships'), idOf(v1, 'billing ships'));
  assert.equal(idOf(v2, 'mobile waits'), idOf(v1, 'mobile waits'));
  assert(!ids(v1).includes(idOf(v2, 'a new intro')), 'inserted blocks get new ids');
  assert.deepEqual(v2.blocks[3].path, [3]);
});

test('light edit keeps the id', () => {
  const v1 = build('<p>Intro.</p><p>Billing ships first on March 14 because invoices block two renewals this quarter.</p><p>End.</p>', null, 1);
  const v2 = build('<p>Intro.</p><p>Billing ships first on March 21 because invoices block three renewals this quarter.</p><p>End.</p>', v1, 2);
  assert.equal(idOf(v2, 'march 21'), idOf(v1, 'march 14'));
});

test('light edit and inserts above at once', () => {
  const v1 = build('<h2>Why</h2><p>The team has no designer until the fourth quarter so mobile work waits for hiring.</p>', null, 1);
  const v2 = build('<p>Summary first.</p><h2>Why</h2><p>Note.</p><p>The team has no designer until the third quarter, so mobile work waits for hiring.</p>', v1, 2);
  assert.equal(idOf(v2, 'third quarter'), idOf(v1, 'fourth quarter'));
  assert.equal(idOf(v2, 'why'), idOf(v1, 'why'));
});

test('split: the larger part keeps the id', () => {
  const v1 = build('<p>Head.</p><p>Alpha beta gamma delta epsilon zeta eta theta. Iota kappa lambda.</p><p>Tail.</p>', null, 1);
  const v2 = build('<p>Head.</p><p>Alpha beta gamma delta epsilon zeta eta theta.</p><p>Iota kappa lambda.</p><p>Tail.</p>', v1, 2);
  assert.equal(idOf(v2, 'alpha beta'), idOf(v1, 'alpha beta'));
  assert.notEqual(idOf(v2, 'iota kappa'), idOf(v1, 'alpha beta'));
});

test('merge: the largest source keeps its id', () => {
  const v1 = build('<p>Head.</p><p>Alpha beta gamma delta epsilon zeta eta.</p><p>Theta iota.</p><p>Tail.</p>', null, 1);
  const v2 = build('<p>Head.</p><p>Alpha beta gamma delta epsilon zeta eta. Theta iota.</p><p>Tail.</p>', v1, 2);
  assert.equal(idOf(v2, 'alpha beta'), idOf(v1, 'alpha beta'));
});

test('duplicate identical blocks keep their own ids in order', () => {
  const v1 = build('<p>Same words.</p><p>Middle one.</p><p>Same words.</p>', null, 1);
  assert.notEqual(v1.blocks[0].id, v1.blocks[2].id);
  const v2 = build('<p>Inserted.</p><p>Same words.</p><p>Middle one.</p><p>Same words.</p>', v1, 2);
  assert.equal(v2.blocks[1].id, v1.blocks[0].id);
  assert.equal(v2.blocks[3].id, v1.blocks[2].id);
});

test('p -> li with the same text keeps the id (tag ignored when text is equal)', () => {
  const v1 = build('<p>Intro.</p><p>Ship billing first.</p><p>End.</p>', null, 1);
  const v2 = build('<p>Intro.</p><ul><li>Ship billing first.</li></ul><p>End.</p>', v1, 2);
  assert.equal(v2.blocks[1].tag, 'ul');
  assert.equal(v2.blocks[1].id, v1.blocks[1].id);
});

test('moved block keeps its id', () => {
  const v1 = build('<p>One alpha.</p><p>Two beta.</p><p>Three gamma delta epsilon.</p>', null, 1);
  const v2 = build('<p>Three gamma delta epsilon.</p><p>One alpha.</p><p>Two beta.</p>', v1, 2);
  assert.equal(idOf(v2, 'three gamma'), idOf(v1, 'three gamma'));
  assert.equal(idOf(v2, 'one alpha'), idOf(v1, 'one alpha'));
});

test('a rewrite gets a new id', () => {
  const v1 = build('<p>Billing ships first because invoices block renewals.</p>', null, 1);
  const v2 = build('<p>Completely different words about hiring a designer next year.</p>', v1, 2);
  assert.notEqual(v2.blocks[0].id, v1.blocks[0].id);
});

test('ids chain over several versions and rebuild deterministically', () => {
  const v1 = build('<p>Keep me around please.</p>', null, 1);
  const v2 = build('<p>New.</p><p>Keep me around please.</p>', v1, 2);
  const v3 = build('<p>New.</p><p>Newer.</p><p>Keep me around, please!</p>', v2, 3);
  assert.equal(idOf(v3, 'keep me'), v1.blocks[0].id);
  assert.deepEqual(build('<p>New.</p><p>Newer.</p><p>Keep me around, please!</p>', v2, 3), v3);
});

test('editor hint (keep) wins over the matcher', () => {
  const v1 = build('<p>Alpha.</p><p>Beta.</p>', null, 1);
  const v2 = B.build(page("<p>Entirely rewritten.</p><p>Beta.</p>"), v1, 2, parse5, { keep: { 0: v1.blocks[0].id } });
  assert.equal(v2.blocks[0].id, v1.blocks[0].id);
});

test('locate: a quote, its repeat told apart by context, a quote across blocks, words reworded', () => {
  const s = build('<p>The cat sat. Then the dog ran.</p><p>Later the dog ran again.</p><p>Final words here, all four.</p>', null, 1);
  assert.equal(B.locate(s, { text: 'the dog ran' , context_before: 'Later ', context_after: ' again.' }), 1);
  assert.equal(B.locate(s, { text: 'the dog ran', context_before: 'The cat sat. Then ', context_after: '.' }), 0);
  assert.equal(B.locate(s, { text: 'ran again.\nFinal words' }), 1);
  assert.equal(B.locate(s, { text: 'Final   WORDS' }), 2);
  assert.equal(B.locate(s, { text: 'here four final words' }), 2, 'most of its words');
  assert.equal(B.locate(s, { text: 'here final words' }), -1, 'under 4 words: no fuzzy guess');
  const twins = build('<p>alpha beta gamma delta one</p><p>alpha beta gamma delta two</p>', null, 1);
  assert.equal(B.locate(twins, { text: 'delta gamma beta alpha' }), -1, 'a tie is no answer');
  assert.equal(B.locate(twins, { text: 'delta gamma beta alpha', context_after: 'two' }), 1, 'context words break the tie');
  assert.equal(B.locate(s, { text: 'nothing like it' }), -1);
  assert.equal(B.locate(null, { text: 'x' }), -1);
});

test('place: path, tag, head and whether the quote survives', () => {
  const s = build('<div class="wrap"><p>Hello  World.</p></div>', null, 1);
  const p = B.place(s, s.blocks[0].id, 'hello world');
  assert.deepEqual(p.path, [0, 0]);
  assert.equal(p.tag, 'p');
  assert.equal(p.head, 'helloworld.');
  assert.equal(p.quote_found, true);
  assert.equal(B.place(s, s.blocks[0].id, 'goodbye').quote_found, false);
  assert.equal(B.place(s, 'nope', 'x'), null);
});

test('CJK text matches by bigrams', () => {
  const v1 = build('<p>我们先发布账单功能，因为发票问题阻碍了两次续约。</p>', null, 1);
  const v2 = build('<p>新的开头。</p><p>我们先发布账单功能，因为发票问题阻碍了三次续约。</p>', v1, 2);
  assert.equal(v2.blocks[1].id, v1.blocks[0].id);
});

test('bounds: too big is no sidecar, many blocks stay fast', () => {
  assert.equal(B.segment('x'.repeat(B.MAX_HTML + 1), parse5), null);
  const many = (k) => Array.from({ length: 2000 }, (_, i) => `<p>Paragraph number ${i} says ${i % 7 ? 'something' : 'nothing'} ${k}.</p>`).join('');
  const t0 = Date.now();
  const v1 = build(many('a'), null, 1);
  const v2 = build(`<p>Inserted.</p>${many('a')}`, v1, 2);
  const ms = Date.now() - t0;
  assert.equal(v2.blocks[1].id, v1.blocks[0].id);
  assert(ms < 5000, `2000 blocks took ${ms} ms`);
  console.log(`    (2000-block build + match: ${ms} ms)`);
});

test('one work budget bounds every fuzzy step: many similar gaps cannot run away', () => {
  // Crafted: every block near-equal to every other (same long token set,
  // one word changed), no exact anchors, so each step would compare all
  // pairs. Work stays within the budget; what is left is new.
  const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
  const doc = (k) => Array.from({ length: 1500 }, (_, i) => `<p>${words} ${k}${i}</p>`).join('');
  const t0 = Date.now();
  const v1 = build(doc('a'), null, 1);
  const v2 = build(doc('b'), v1, 2);
  const ms = Date.now() - t0;
  assert(v2.work <= B.WORK_BUDGET, `work ${v2.work}`);
  assert(ms < 3000, `took ${ms} ms`);
  const few = (s) => s.blocks.slice(0, 300).map((b) => ({ tag: b.tag, t: b.t }));
  const res = B.match(few(v1), few(v2), 5000);
  assert(res.work <= 5000 && res.exhausted, `small budget: work ${res.work}`);
  console.log(`    (crafted 1500x1500 near-equal blocks: ${ms} ms, work ${v2.work})`);
});

test('many small fuzzy gaps share the one budget', () => {
  const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
  const doc = (k) => Array.from({ length: 1000 }, (_, i) => `<p>anchor ${i}</p><p>${words} ${k}${i}</p><p>${words} ${k}x${i}</p>`).join('');
  const t0 = Date.now();
  const v1 = build(doc('a'), null, 1);
  const v2 = build(doc('b'), v1, 2);
  const ms = Date.now() - t0;
  assert(v2.work <= B.WORK_BUDGET, `work ${v2.work}`);
  assert(ms < 3000, `took ${ms} ms`);
  assert.equal(v2.blocks[0].id, v1.blocks[0].id, 'exact anchors still match');
  console.log(`    (1000 fuzzy gaps: ${ms} ms, work ${v2.work})`);
});

test('size-ratio prefilter: very different lengths are never compared', () => {
  const res = B.match([{ tag: 'p', t: 'a b c d e f g h i j k l m n o p q r s t' }], [{ tag: 'p', t: 'a b' }]);
  assert.equal(res.mn[0], -1);
  assert(res.work <= 5, `cells only, no Jaccard: ${res.work}`);
});

test('a restore also matches the restored version\'s ids', () => {
  const v1 = build('<p>Old paragraph that was removed later on.</p><p>Stays.</p>', null, 1);
  const v2 = build('<p>Stays.</p>', v1, 2);
  const v3 = B.build(page('<p>Old paragraph that was removed later on.</p><p>Stays.</p>'), v2, 3, parse5, { also: v1 });
  assert.equal(v3.blocks[0].id, v1.blocks[0].id);
  assert.equal(v3.blocks[1].id, v2.blocks[0].id);
});

console.log(`block-ids: ${n} passed`);
