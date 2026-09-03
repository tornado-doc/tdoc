// #416: the row under a comment grew one control at a time and ended up five
// coloured words in a line — blue for reply and edit because the legacy overlay
// made them links, green for reopen because it matched the resolved chip, red
// for delete. Only the red was ever saying anything.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const ui = read('shell/src/ui/ui.css');
const chrome = read('server/chrome.css');

console.log('the comment action row reads as one row (#416)');

t('one voice for everything you can do to a thread', () => {
  assert(/\.tdoc-margin-comment \.actions button \{[^}]*color: #8a8a8f/.test(ui),
    'the row should share one resting colour');
  // The per-control colours are what made it a rainbow. reply, edit and
  // resolve must no longer each claim one.
  assert(!/button\.tdoc-reply-toggle,\s*\n\.tdoc-margin-comment button\.tdoc-edit-toggle \{ color: var\(--td-accent\)/.test(ui),
    'reply and edit still claim the accent colour');
  assert(!/button\.tdoc-resolve-toggle \{ color: #1a7340/.test(ui), 'resolve still claims green');
});

t('a control announces itself on hover, not at rest', () => {
  assert(/\.tdoc-margin-comment \.actions button:hover,\s*\n\.tdoc-margin-comment \.actions button:focus-visible \{\s*\n\s*color: #1a1a1a/.test(ui),
    'the row should darken on hover and on keyboard focus, not only on hover');
});

t('delete keeps its colour, because it is the one that does not come back', () => {
  assert(/\.actions button\.del \{ color: #c9776f; \}/.test(ui), 'delete lost its colour entirely');
  assert(/\.actions button\.del:hover,\s*\n\.tdoc-margin-comment \.actions button\.del:focus-visible \{ color: #c33; \}/.test(ui),
    'delete should deepen rather than change into a different word');
});

t('delete is spaced off the run, so the gap does the work a colour would', () => {
  assert(/\.tdoc-margin-comment \.actions button\.del \{ margin-left: 6px; \}/.test(chrome),
    'delete should not be the fifth word in a list of five equal ones');
  assert(/\.tdoc-margin-comment \.actions \{[^}]*flex-wrap: wrap/.test(chrome),
    'a 280px card with five controls has to be allowed to wrap');
});

t('11px words get a target bigger than the words', () => {
  const block = ui.slice(ui.indexOf('.tdoc-margin-comment .actions button {'));
  assert(/padding: 5px 3px;\s*\n\s*margin: -5px -3px;/.test(block.slice(0, 400)),
    'grow the hit area and give the space back, so the row is easier to press and looks the same');
});

t('the same treatment reaches a reply, one level down', () => {
  // A reply's actions live inside the card, so the card-scoped selector covers
  // both levels — there is no second rule to keep in step.
  assert(!/\.tdoc-reply .*\.actions button \{/.test(ui) && !/\.tdoc-reply .*\.actions button \{/.test(chrome),
    'a reply-specific copy of this rule is how the two levels drift apart');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
