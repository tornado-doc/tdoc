#!/usr/bin/env node
// Hidden threads must leave no frame affordance. Browser coverage lives in
// resolved-visibility-ui.test.js; these guards retain the anchor fallback contracts.
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

console.log('resolved visibility and anchor fallback contracts');

t('the shell sends the same visible set to the frame and the margin', () => {
  assert(shell.includes("bridge.send({ type: 'tdoc:anchors', comments: shownComments });"), 'the frame bypasses comment visibility');
  assert(shell.includes('comments={shownComments}'), 'the margin bypasses comment visibility');
});
t('hidden threads are excluded before any targets or highlights are registered', () => {
  const start = probe.indexOf('(comments || []).forEach(function (c)');
  const skip = probe.indexOf('if (!c || c.hidden) return;', start);
  const target = probe.indexOf('_anchorTargets[c.id]', start);
  assert(skip > start && skip < target, 'hidden thread can register an anchor');
  assert(!probe.includes('hlResolved'), 'hidden resolved highlights remain');
});

t('a comment whose words were rewritten marks the block that replaced them', () => {
  // Every applied comment's sentence changes in the next version; without
  // this, v2 showed a pin beside an unmarked paragraph.
  assert(probe.includes("best = { at: i + lb, len: lb, side: 'before' }") && probe.includes("best = { at: j, len: la, side: 'after' }") && probe.includes('candidate.tdocSide = best.side;'), 'the neighbourhood match does not say which side the words were on');
  assert(probe.includes('function blockForMoved(r)') && probe.includes("if (!block || block.matches(CONTENT_ROOT_SEL)) return null;"), 'no block finder, or it can paint the whole document');
  assert(probe.includes("if (approximate && hlMoved && !c.deleted) { var mv = blockForMoved(r); if (mv) hlMoved.add(mv); }") && probe.includes("CSS.highlights.set('tdoc-anchor-moved', hlMoved);"), 'the replaced block is not painted');
  assert(chrome.includes('::highlight(tdoc-anchor-moved)'), 'no style for the moved mark');
});

t('lost seats are stepped so a rewrite pile does not collapse to one Y', () => {
  assert(probe.includes('seatY - seated * seatStep') && probe.includes('var seated = 0'),
    'lost seats must step up the page instead of sharing one seatY');
  assert(probe.includes('function findSurvivingFragment'),
    'partial rewrites should try a surviving fragment of the original text before seating');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
