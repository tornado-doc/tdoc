const assert = require('assert/strict');
const { align, textParts } = require('../server/version-diff');
const unit = (text, key = '', kind = 'p') => ({ kind, key, fingerprint: text });
const a = [unit('one'), unit('two'), unit('three')];
assert.deepEqual(align(a, [unit('one'),unit('inserted'),unit('two'),unit('three')]), [
  {before:0,after:0},{before:null,after:1},{before:1,after:2},{before:2,after:3},
]);
assert.deepEqual(align([unit('a','a'),unit('b','b')],[unit('new a','a'),unit('new','c')]),[
  {before:0,after:0},{before:1,after:null},{before:null,after:1},
]);
assert.deepEqual(align([],a),a.map((_,i)=>({before:null,after:i})));
assert.deepEqual(align(a,[]),a.map((_,i)=>({before:i,after:null})));
assert.deepEqual(textParts('written','drafted'),[{kind:'replace',before:'written',after:'drafted'}]);
for (const [before,after] of [['人工编写','AI 起草、人工审核'],['😀 shared hello','😀 shared world'],['abc',''],['','abc'],['same','same']]) {
  const parts=textParts(before,after);
  assert.equal(parts.map(p=>p.before).join(''),before);
  assert.equal(parts.map(p=>p.after).join(''),after);
  if(before===after)assert(parts.every(p=>p.kind==='equal'));
}
const large=Array.from({length:1500},(_,i)=>unit(String(i)));
assert.equal(align(large,large).length,1500);
assert(align(large,large).every(p=>p.before===p.after));
console.log('PASS version matching: insertions, stable IDs, empty baselines, Unicode and bounded large inputs');
