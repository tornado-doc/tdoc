const assert = require('assert');
const md = require('../server/edit-markdown.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; }
}

console.log('edit-markdown input rules');

t('block prefixes fire only on the completing character', () => {
  assert.deepStrictEqual(md.matchBlock('##', ' '), { kind: 'heading', level: 2 });
  assert.deepStrictEqual(md.matchBlock('#', ' '), { kind: 'heading', level: 1 });
  assert.deepStrictEqual(md.matchBlock('###', ' '), { kind: 'heading', level: 3 });
  assert.strictEqual(md.matchBlock('####', ' '), null);
  assert.strictEqual(md.matchBlock('##', '#'), null);
  assert.strictEqual(md.matchBlock('hello ##', ' '), null);
});

t('lists, quotes, and hr complete at block start', () => {
  assert.deepStrictEqual(md.matchBlock('-', ' '), { kind: 'ul' });
  assert.deepStrictEqual(md.matchBlock('*', ' '), { kind: 'ul' });
  assert.deepStrictEqual(md.matchBlock('1.', ' '), { kind: 'ol' });
  assert.deepStrictEqual(md.matchBlock('12.', ' '), { kind: 'ol' });
  assert.deepStrictEqual(md.matchBlock('>', ' '), { kind: 'quote' });
  assert.deepStrictEqual(md.matchBlock('--', '-'), { kind: 'hr' });
  assert.deepStrictEqual(md.matchBlock('---', '\n'), { kind: 'hr' });
  assert.strictEqual(md.matchBlock('--', ' '), null);
  assert.strictEqual(md.matchBlock('1', ' '), null);
});

t('inline marks prefer ** over * and reject empty inner', () => {
  assert.deepStrictEqual(md.matchInline('hello **world**'), { tag: 'strong', inner: 'world', from: 6 });
  assert.deepStrictEqual(md.matchInline('hello *world*'), { tag: 'em', inner: 'world', from: 6 });
  assert.deepStrictEqual(md.matchInline('use `code`'), { tag: 'code', inner: 'code', from: 4 });
  assert.strictEqual(md.matchInline('**'), null);
  assert.strictEqual(md.matchInline('****'), null);
  assert.strictEqual(md.matchInline('hello *'), null);
});

t('a sentence that happens to contain # or - is not a prefix', () => {
  assert.strictEqual(md.matchBlock('See #', ' '), null);
  assert.strictEqual(md.matchBlock('score 1.', ' '), null);
  assert.strictEqual(md.matchBlock('wait -', ' '), null);
});

t('escapeHtml is what insertHTML uses for the inner span', () => {
  assert.strictEqual(md.escapeHtml('<x & "y">'), '&lt;x &amp; &quot;y&quot;&gt;');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
