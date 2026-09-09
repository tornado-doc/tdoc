#!/usr/bin/env node
// A comment posted twice — a double ⌘+Enter, a click after the key, a retry
// on a slow write — is one comment. Both hosts answer the second POST with
// the first record; the composer refuses a second submit while one is in
// flight; an IME's Enter is not a submit.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const worker = read('worker/worker.js');
const server = read('server/server.js');
const composer = read('shell/src/document/comment-composer.jsx');
const field = read('shell/src/document/mention-field.jsx');

function lift(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} is not defined`);
  let i = src.indexOf('(', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  while (i < src.length && src[i] !== '{') i++;
  depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, i)}; return ${name};`)();
}

console.log('the same words twice within seconds is one comment');

const at = '2026-09-09T02:27:00.000Z';
const me = { login: 'serena', name: 'Serena' };
const first = { id: 'c_1', author: me, text: '可以更加critical一点', anchor: { kind: 'text', text: 'You kept four assistants' }, created: '2026-09-09T02:26:59.200Z', replies: [] };

for (const [label, src] of [['worker', worker], ['server', server]]) {
  const duplicateComment = lift(src, 'duplicateComment');
  t(`${label}: the second POST of the same words on the same spot is the first comment`, () => {
    const dup = duplicateComment([first], { author: me, text: '可以更加critical一点 ', anchor: { kind: 'text', text: 'You kept four assistants' }, at });
    assert(dup && dup.id === 'c_1', 'not found');
  });
  t(`${label}: a different spot, a different person, or a different sentence is a new comment`, () => {
    assert(duplicateComment([first], { author: me, text: '可以更加critical一点', anchor: { kind: 'text', text: 'Which assistants' }, at }) === null, 'spot');
    assert(duplicateComment([first], { author: { login: 'sam' }, text: '可以更加critical一点', anchor: first.anchor, at }) === null, 'person');
    assert(duplicateComment([first], { author: me, text: 'critical', anchor: first.anchor, at }) === null, 'sentence');
  });
  t(`${label}: the window closes after fifteen seconds`, () => {
    assert(duplicateComment([first], { author: me, text: first.text, anchor: first.anchor, at: '2026-09-09T02:27:20.000Z' }) === null, 'late twin treated as duplicate');
  });
  t(`${label}: a reply twice under the same parent is one reply`, () => {
    const thread = { ...first, replies: [{ id: 'r_1', parent_id: 'c_1', author: me, text: 'what', created: '2026-09-09T02:26:59.900Z' }] };
    assert(duplicateComment([thread], { author: me, text: 'what', parent_id: 'c_1', at }).id === 'r_1', 'reply not found');
    assert(duplicateComment([thread], { author: me, text: 'what', parent_id: 'c_other', at }) === null, 'other parent');
  });
}

t('both hosts check before they write', () => {
  assert(worker.includes("const dup = duplicateComment(priorList, { author, text: commentText, anchor, parent_id, at: created });") && worker.includes('duplicate_of: dup.id'), 'worker');
  assert(server.includes("const dup = duplicateComment(comments, { author: e2eIdentity(), text, anchor, parent_id, at: created });") && server.includes('duplicate_of: dup.id'), 'server');
});
t('the composer submits once at a time, and says so', () => {
  assert(composer.includes('if (busy || !text.trim()) return;') && composer.includes("{busy ? 'Posting…' : 'Comment'}") && composer.includes('disabled={busy}'), 'no busy guard');
});
t("an IME's Enter is not a submit", () => {
  assert(field.includes('if (event.isComposing || event.keyCode === 229) return;'), 'no composition guard');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
