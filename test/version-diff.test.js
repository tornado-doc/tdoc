const assert = require('assert/strict');
const { align, textParts, isRewrite } = require('../server/version-diff');
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
// A rewrite shows as blocks; an edit that keeps most of its words stays in place.
const rewrite = (before, after) => isRewrite(textParts(before, after));
assert.equal(rewrite('on March 14', 'on March 21'), false, 'short');
assert.equal(rewrite('written', 'an entirely different and rather longer phrase than before'), true, 'nearly nothing kept');
assert.equal(rewrite('Billing ships first, on March 14, because invoices block two renewals.', 'Billing ships first, on March 21, because invoices block three renewals.'), false, 'a few words in a long sentence');
assert.equal(rewrite('The mobile app waits for the fourth quarter because the team has no designer until then.', 'Hiring decides this: without a designer nothing on phones can start until someone joins.'), true, 'little shared');
assert.equal(rewrite('Alpha one bravo two charlie three delta four echo five foxtrot six', 'Alpha 1 bravo 2 charlie 3 delta 4 echo 5 foxtrot 6'), true, 'scattered: every other word changed');
assert.equal(rewrite('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十', '完全不同的内容在这里写出来让它足够长也和原来没有任何相同的字词句子'), true, 'CJK');
assert.equal(rewrite('今天发布', '明天发布'), false, 'short CJK');
assert.equal(rewrite('a long enough deleted sentence with several plain words in it', ''), true, 'a long deletion');
console.log('PASS version matching: insertions, stable IDs, empty baselines, Unicode and bounded large inputs');
