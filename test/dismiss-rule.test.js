// The dismiss-first rule: while the shell has a card, cluster, or composer
// open, the next click anywhere in the document only dismisses it. Three paths
// broke when that rule first landed, each silently — nothing errored, the
// feature just stopped working. These are source-shape guards, cheap enough to
// run offline; the behavior itself is covered in browser-editing.test.js.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(root, 'shell/src/document-shell.jsx'), 'utf8');
const probe = fs.readFileSync(path.join(root, 'server/frame-probe.js'), 'utf8');

console.log('the dismiss-first rule keeps its exceptions');

t('re-anchoring is excluded from the open state', () => {
  // Move anchor keeps the card open precisely so the author can click the new
  // spot. Counting that as "something is open" ate the click and the anchor
  // silently never moved.
  const send = /tdoc:uiOpen[\s\S]{0,200}/.exec(shell);
  assert(send, 'the shell no longer tells the frame when something is open');
  const region = shell.slice(Math.max(0, shell.indexOf('tdoc:uiOpen') - 300), shell.indexOf('tdoc:uiOpen') + 200);
  assert(/!reanchorId/.test(region), 'uiOpen no longer excludes re-anchor mode; Move anchor will stop landing');
});

t('mousedown paints before it defers the dismissal', () => {
  // An early return above the painting setup stops a drag that starts while a
  // card is open from painting its selection at all.
  const paint = probe.indexOf("data-tdoc-selecting");
  const defer = probe.indexOf('if (shellUiOpen) return;');
  assert(paint > 0 && defer > 0, 'the painting setup or the deferred dismissal is gone');
  assert(paint < defer, 'the dismissal now returns before the selection painting');
});

t('the dismissal happens on mouseup, not mousedown', () => {
  // Clearing on mousedown unmounts the focused composer in the shell, and
  // losing that focus wipes the selection the user is dragging.
  const mouseup = probe.slice(probe.indexOf("addEventListener('mouseup'"), probe.indexOf("addEventListener('touchend'"));
  assert(/swallowClick && !moved/.test(mouseup), 'mouseup no longer distinguishes a dismissing click from a drag');
  assert(/tdoc:cleared/.test(mouseup), 'the dismissal moved back out of mouseup');
});

t('the artifact pill is inside the rule, not exempt from it', () => {
  // The pill is our own UI, so it used to be waved through. While something is
  // open it is outside that card like anything else.
  assert(/!shellUiOpen && e\.target && e\.target\.closest && e\.target\.closest\('\.tdoc-comment-pill'\)/.test(probe),
    'the comment pill is exempt from dismissal again');
  assert(/closest\('\.tdoc-comment-pill, a\[href\]'\)/.test(probe),
    'a swallowed click no longer stops the pill from opening an element comment');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
