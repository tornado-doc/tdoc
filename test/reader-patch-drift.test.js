// The serve-time reader patch exists in two runtimes — the Worker and the local
// server — and they cannot share a module. A rule that reaches phones on
// tdoc.dev but not on `tdoc serve` (or the reverse) is worse than no rule, so
// the two literals are held byte-identical here.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server/server.js'), 'utf8');
const reader = fs.readFileSync(path.join(root, 'server/reader.css'), 'utf8');

const literal = (source) => {
  const match = /const READER_PATCH_CSS = '([^']*)';/.exec(source);
  return match && match[1];
};

console.log('the serve-time reader patch stays in sync');

t('both runtimes carry it', () => {
  assert(literal(worker), 'worker/worker.js has no READER_PATCH_CSS');
  assert(literal(server), 'server/server.js has no READER_PATCH_CSS');
});

t('the two literals are byte-identical', () => {
  assert(literal(worker) === literal(server),
    `worker and local server disagree:\n  worker: ${literal(worker)}\n  server: ${literal(server)}`);
});

t('it is the narrow-viewport table rule, and it spares wrapped tables', () => {
  const css = literal(worker) || '';
  assert(/@media \(max-width:\s*700px\)/.test(css), 'the patch is no longer scoped to narrow viewports');
  assert(/overflow-x:\s*auto/.test(css), 'the patch no longer makes the table scrollable');
  // The author's own `table{min-width:880px}` is what breaks the phone, so this
  // rule has to outrank it — a :where() version loses to the declaration it
  // exists to defeat.
  assert(/min-width:\s*0\s*!important/.test(css), 'the patch no longer overrides an author min-width');
  assert(!/:where\(/.test(css), 'the patch went back to zero specificity');
  assert(/not\(\.tdoc-table-scroll\s*>\s*table\)/.test(css),
    'the patch no longer spares tables the author already wrapped');
});

t('both injection sites guard against a second copy', () => {
  for (const [name, source] of [['worker/worker.js', worker], ['server/server.js', server]]) {
    assert(source.includes(`id="tdoc-reader-patch"`) && /indexOf\('id="tdoc-reader-patch"'\) === -1/.test(source),
      `${name} injects the patch without checking for one already there`);
  }
});

t('the patch anchors on the opening <head>, not the closing one', () => {
  // The baked reader CSS quotes `</head>` inside a comment, so a first-match
  // replace on the closing tag drops the style INSIDE that comment, where it
  // parses as text and does nothing at all.
  for (const [name, source] of [['worker/worker.js', worker], ['server/server.js', server]]) {
    const site = source.slice(source.indexOf('id="tdoc-reader-patch"'));
    const window_ = site.slice(0, 600);
    assert(/replace\(\/<head\[\^>\]\*>\/i/.test(window_),
      `${name} no longer anchors the patch on the opening <head>`);
  }
});

t('newly baked documents get the same rule from reader.css', () => {
  // The patch reaches documents baked before it existed; reader.css is what
  // downloads and self-contained copies carry.
  assert(/@media \(max-width: 700px\)/.test(reader), 'reader.css lost the narrow-viewport table rule');
  assert(/not\(\.tdoc-table-scroll > table\)/.test(reader), 'reader.css no longer spares wrapped tables');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
