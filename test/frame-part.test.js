// What the doc frame says it picked (feedbackDocFramePick) is rebuilt before
// the widget stores it: known keys only, one line, cut, numbers finite, and
// small enough for the server's ANCHOR_MAX_BYTES (8192) with the outer
// context around it.
// Run with: node test/frame-part.test.js
const assert = require('assert/strict');

(async () => {
  const { cleanFrameAnchor, cleanRect, fitFrameAnchor, FRAME_ANCHOR_BUDGET } = await import('../shell/src/comments/selection/anchors/frame-part.js');
  let failed = 0;
  const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); } };
  const big = (n) => 'w '.repeat(n);
  const huge = {
    selector: `#a\n${big(2000)}`, tag: 'p'.repeat(100), text: big(5000), accessible_name: big(500), label: `L\n\n${big(300)}`,
    container: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, big(400)])),
    quote: { text: big(5000), context_before: big(1000), context_after: big(1000), occurrence: 2.5, occurrences: 3 },
    region: { container_text: big(2000), rel: { x: 1, y: 'no', width: NaN, height: 3, extra: 'x' }, frac: { x: Infinity },
      elements: Array.from({ length: 20 }, () => Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`e${i}`, big(300)]))) },
    evil: '<script>', __proto__: { polluted: true },
  };

  t('a frame part never exceeds its budget, however much the frame sends', () => {
    const out = cleanFrameAnchor(huge);
    const size = JSON.stringify(out).length;
    assert.ok(size <= FRAME_ANCHOR_BUDGET, `frame part is ${size} bytes`);
    // With the outer context and the top-level text and label it stays under the server's cap.
    assert.ok(size + 3000 < 8192);
  });
  t('cut in order: what is under a box first, then the container', () => {
    const out = cleanFrameAnchor(huge);
    assert.deepEqual(out.region.elements, []);
    assert.equal(out.container, undefined);
    assert.ok(out.quote.text.length > 0 && out.selector.startsWith('#a'));
  });
  t('known keys only; one line; numbers finite', () => {
    const out = cleanFrameAnchor(huge);
    assert.equal(out.evil, undefined);
    assert.equal(({}).polluted, undefined);
    for (const v of [out.selector, out.text, out.label, out.quote.text]) assert.ok(!/\s{2,}|\n/.test(v), `not one line: ${v.slice(0, 40)}`);
    assert.deepEqual(out.region.rel, { x: 1, y: 0, width: 0, height: 3 });
    assert.deepEqual(out.region.frac, { x: 0, y: 0, width: 0, height: 0 });
    assert.equal(out.quote.occurrence, null);
    assert.equal(out.tag.length, 40);
  });
  t('a small part is kept as it is', () => {
    const small = { selector: '#p1', tag: 'p', text: 'First paragraph', accessible_name: '' };
    assert.deepEqual(cleanFrameAnchor(small), small);
    assert.deepEqual(fitFrameAnchor({ ...small }), small);
  });
  t('nothing to find it by: no part', () => {
    assert.equal(cleanFrameAnchor({ tag: 'p' }), null);
    assert.equal(cleanFrameAnchor('x'), null);
  });
  t('rects: numbers only', () => {
    assert.deepEqual(cleanRect({ left: '1', top: 2, width: -5, height: Infinity, x: 9 }), { left: 0, top: 2, width: 0, height: 0 });
  });

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
