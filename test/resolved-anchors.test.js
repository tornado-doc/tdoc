#!/usr/bin/env node
// A resolved thread leaves the margin when the Resolved switch is off — and
// used to take its highlight with it, so the sentence read as if nobody had
// ever said anything about it. It keeps a lighter mark now, with no pin, and
// a click on the sentence opens the thread. Source-shape guards; the
// behaviour is in the browser suites.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const shell = read('shell/src/document-shell.jsx');
const probe = read('server/frame-probe.js');
const chrome = read('server/chrome.css');

console.log('a resolved thread still marks its sentence');

t('the shell sends every thread, flagging the ones the margin hides', () => {
  assert(shell.includes("return comments.comments.map((comment) => (shown.has(comment.id) ? comment : { ...comment, hidden: true }));"), 'no hidden flag');
  assert(shell.includes("bridge.send({ type: 'tdoc:anchors', comments: anchorsForFrame });"), 'the frame is not sent the full set');
});
t('the probe paints a hidden thread lightly, with no pin and no seat', () => {
  assert(probe.includes("if (c.hidden) { if (hlResolved && !c.deleted && !approximate) hlResolved.add(r); return; }"), 'hidden text anchors are not painted lightly');
  assert(probe.includes("if (!c.anchor) return c.hidden ? undefined : seat(c);") && probe.includes("if (!r) return c.hidden ? undefined : seat(c);"), 'a hidden thread would take a seat');
  assert(probe.includes("CSS.highlights.set('tdoc-anchor-resolved', hlResolved);"), 'the resolved highlight is never set');
  assert(/::highlight\(tdoc-anchor-resolved\)\{background:' \+ resolved/.test(probe) && chrome.includes('::highlight(tdoc-anchor-resolved)'), 'the resolved highlight has no colour');
});
t('a hidden thread is still a click target', () => {
  // The target is registered before the hidden early-return, so anchorIdAtPoint
  // finds it and the shell opens the card — which is shown whatever the switch says.
  const i = probe.indexOf('_anchorTargets[c.id] = { range: r };');
  const j = probe.indexOf('if (c.hidden) { if (hlResolved', i);
  assert(i > 0 && j > i && j - i < 200, 'the target is registered after the hidden return');
  assert(shell.includes('|| comment.id === openCommentId'), 'the open card is not shown regardless of the switch');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
