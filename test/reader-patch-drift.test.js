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

t('it defines the scroll wrapper, and the wrapper is what tables get put in', () => {
  // The patch used to make the table its own scroller with display:block. That
  // let thead and tbody size independently and the header stopped lining up
  // with the body — on the landing page, visibly. Tables are wrapped at serve
  // time now and the patch only has to define the wrapper, for documents baked
  // before .tdoc-table-scroll existed.
  const css = literal(worker) || '';
  assert(/\.tdoc-table-scroll\{/.test(css), 'the patch no longer defines the scroll wrapper');
  assert(/overflow-x:\s*auto/.test(css), 'the wrapper no longer scrolls');
  assert(!/display:\s*block/.test(css), 'the display:block table hack is back; it breaks header alignment');
  for (const [name, source] of [['worker/worker.js', worker], ['server/server.js', server]]) {
    assert(/function wrapBareTables\(/.test(source), `${name} does not wrap bare tables`);
    assert(/body = wrapBareTables\(body\);/.test(source), `${name} never calls wrapBareTables`);
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

t('reader.css keeps the wrapper rules and none of the table hack', () => {
  assert(/\.tdoc-table-scroll \{[^}]*overflow-x: auto/.test(reader), 'reader.css lost the scroll wrapper');
  assert(!/display: block !important/.test(reader), 'the display:block table hack is back in reader.css');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
