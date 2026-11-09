// The shared selection modules (shell/src/comments/selection/) bundle into
// the doc frame's script without a bundler (server/selection-bundle.js), and
// their pure parts behave. Run with: node test/selection-bundle.test.js
const assert = require('assert');
const vm = require('vm');
const selectionBundle = require('../server/selection-bundle.js');
const frameProbeSource = require('../server/frame-probe-source.js');

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass += 1; };

const src = selectionBundle();
new vm.Script(src);
const sandbox = { setTimeout, clearTimeout };
vm.runInNewContext(`${src}; this.TdocSelection = TdocSelection;`, sandbox);
const S = sandbox.TdocSelection;
for (const name of ['describeElement', 'findElement', 'selectorFor', 'regionOf', 'regionRect', 'enclosingFor', 'collectTextNodes', 'findTextRange', 'captureTextAnchor', 'containerFor', 'containerKey', 'slideId', 'findContainer', 'createPickGesture', 'rangeBetweenPoints', 'registerAnchorAdapter', 'adapterFor']) {
  assert.strictEqual(typeof S[name], 'function', `${name} is not bundled`);
}
ok('the bundle parses and exposes every shared function as TdocSelection');

assert.ok(frameProbeSource().startsWith('var TdocSelection = (function () {'), 'the frame script does not lead with the bundle');
new vm.Script(frameProbeSource());
ok('the frame script carries the bundle ahead of the probe and parses');

assert.strictEqual(S.containerKey(null), 'document');
assert.strictEqual(S.containerKey({ kind: 'document' }), 'document');
assert.strictEqual(S.containerKey({ kind: 'product', url: 'https://app/x' }), 'page:https://app/x');
assert.strictEqual(S.containerKey({ kind: 'element', container: { kind: 'slide', id: 'h:abc' } }), 'slide:h:abc');
assert.strictEqual(S.containerKey({ kind: 'sheet-range', sheet: 'Q3' }), 'sheet:Q3');
assert.strictEqual(S.containerKey({ kind: 'element', selector: 'td', sheet: { table: 'Budget', row: 'r7', key: 'amount' } }), 'sheet:Budget');
assert.strictEqual(S.containerKey({ kind: 'text', text: 'x' }), 'body');
ok('containerKey: document, page, slide, sheet tab, body');

assert.strictEqual(S.stableHash('Bravo'), S.stableHash('Bravo'));
assert.notStrictEqual(S.stableHash('Bravo'), S.stableHash('Alpha'));
ok('stable slide hashes');

// A sheet's adapter drops in by kind or by match, without touching anchors/.
const sheet = { match: (a) => a.kind === 'sheet-range', resolve: () => 'cell', rectOf: () => null };
S.registerAnchorAdapter('sheet-range', sheet);
assert.strictEqual(S.adapterFor({ kind: 'sheet-range', sheet: 'Q3', range: 'A1:B2' }), sheet);
assert.strictEqual(S.adapterFor({ kind: 'element' }), null);
assert.throws(() => S.registerAnchorAdapter('x', {}));
ok('anchor adapters register by kind (a sheet-range adapter drops in)');

// The pick gesture: a click, a drag on text, a drag elsewhere, a touch swipe.
const calls = [];
const gesture = S.createPickGesture({
  areaSelect: true, textSelect: true,
  elementAt: (x) => ({ id: `el${x}`, contains: () => true, parentElement: null }),
  startsOnText: (x) => x < 100,
  onElement: (el) => calls.push(['element', el.id]),
  onText: (a, b) => calls.push(['text', a.x, b.x]),
  onBox: (box) => calls.push(['box', box.width]),
});
const ev = (x, extra = {}) => ({ clientX: x, clientY: 10, pointerId: 1, pointerType: 'mouse', ...extra });
gesture.down(ev(50)); gesture.up(ev(51));
gesture.down(ev(50)); gesture.move(ev(80)); gesture.up(ev(80));
gesture.down(ev(200)); gesture.move(ev(260)); gesture.up(ev(260));
gesture.down(ev(200, { pointerType: 'touch' })); gesture.move(ev(260, { pointerType: 'touch' })); assert.strictEqual(gesture.up(ev(260, { pointerType: 'touch' })), 'scroll');
gesture.down(ev(200)); assert.strictEqual(gesture.cancel(), true); assert.strictEqual(gesture.pressing(), false);
assert.deepStrictEqual(calls, [['element', 'el50'], ['text', 50, 80], ['box', 60]]);
ok('pick gesture: click picks, drag on text quotes, drag elsewhere boxes, a touch swipe scrolls, Esc cancels');

console.log(`\n${pass} passed`);
