// The doc frame's half of stable block ids (flag stableBlockIds): a comment
// whose words are gone carries anchor_block from the server, and the frame
// finds that block in the live page (selection/anchors/block.js) by the path
// the server counted on the stored HTML (server/block-ids.js), checked by tag
// and opening words; injected tdoc elements and scripts do not shift it, and
// a path that misses falls back to the tag and words. The server's place()
// and the frame's finder are run on the same page here, so the two
// countings cannot drift apart unnoticed.
// Run with: node test/block-anchor-frame.test.js
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const parse5 = require('parse5');
const { parseHtml } = require('./helpers/mini-dom');
const B = require('../server/block-ids');

const src = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'comments', 'selection', 'anchors', 'block.js'), 'utf8')
  .replace(/^export\s+function/gm, 'function') + '\nthis.findBlockElement = findBlockElement;';
const ctx = {};
vm.runInNewContext(src, ctx);
const { findBlockElement } = ctx;

let n = 0;
function test(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }

const V1 = '<!doctype html><html><head><style>p{}</style></head><body><div class="wrap"><h1>Plan</h1><p>Billing ships <b>first</b> because invoices block two renewals.</p><p>Mobile waits.</p></div></body></html>';
const V2 = '<!doctype html><html><head><style>p{}</style></head><body><div class="wrap"><h1>Plan</h1><p>New intro.</p><ul><li>Another</li></ul><p>Billing ships <b>first</b> because invoices now block three renewals.</p><p>Mobile waits.</p></div></body></html>';
const s1 = B.build(V1, null, 1, parse5);
const s2 = B.build(V2, s1, 2, parse5);
const anchor = { text: 'invoices block two renewals' };
const id = s1.blocks[B.locate(s1, anchor)].id;
const placed = B.place(s2, id, anchor.text);

test('server and frame agree on the block, by path', () => {
  const body = parseHtml(V2).querySelector('body');
  const el = findBlockElement(placed, body);
  assert(el, 'not found');
  assert.match(el.textContent, /now block three/);
  assert.equal(placed.quote_found, false);
});

test('injected scripts and tdoc elements in the live page do not shift the path', () => {
  const live = V2.replace('<div class="wrap">', '<script>1</script><div id="tdoc-pins"></div><div class="wrap"><style>x{}</style><span data-tdoc-provider="x">p</span>');
  const el = findBlockElement(placed, parseHtml(live).querySelector('body'));
  assert(el && /now block three/.test(el.textContent));
});

test('a path that misses falls back to the tag and the opening words', () => {
  const live = V2.replace('<div class="wrap">', '<div class="banner">Injected by a script</div><div class="wrap">');
  const el = findBlockElement(placed, parseHtml(live).querySelector('body'));
  assert(el && /now block three/.test(el.textContent));
});

test('nothing when neither the path nor the words fit', () => {
  const other = parseHtml('<html><body><p>Unrelated.</p></body></html>').querySelector('body');
  assert.equal(findBlockElement(placed, other), null);
  assert.equal(findBlockElement(null, other), null);
});

console.log(`block-anchor-frame: ${n} passed`);
