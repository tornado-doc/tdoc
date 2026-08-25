// Reader overflow invariants (tables + diagrams).
//
// Overlay default table styles used a -14px left margin to optically align
// padded cells with prose. Inside any overflow-x:auto wrapper (the author
// skill tells agents to wrap tables) that margin clips the first column —
// seen on published docs as "CAPABILITY" rendering as "APABILITY".
// display:block on <table> also discarded real table layout.
//
// These are provider CSS/JS contracts in overlay.js, not author-HTML luck.
//
// Run with: node test/reader-overflow.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'overlay.js'), 'utf8');

console.log('reader-overflow (tables + diagrams stay unclipped)');

t('overlay table style has no negative horizontal margin', () => {
  assert(!/body table[^}]*margin:\s*[^;]*-\d+px/.test(src),
    'table rule still uses a negative margin (clips inside overflow wrappers)');
  assert(src.includes(':where(body table) { border-collapse: separate; border-spacing: 3px; margin: 0 0 18px; font-size: 16px; }'),
    'default table margin must be 0 0 18px with no left pull');
});

t('overlay never display:block a document table', () => {
  assert(!/body table\) \{ display: block; overflow-x: auto; \}/.test(src),
    'display:block on table is back (breaks table layout)');
});

t('wide tables scroll via a wrapper, not the table element', () => {
  assert(src.includes('.tdoc-table-scroll'), 'missing .tdoc-table-scroll wrapper class');
  assert(src.includes('function wrapScrollableTables('), 'missing wrapScrollableTables()');
  assert(src.includes("wrap.className = 'tdoc-table-scroll'"), 'wrapper is not applied to document tables');
});

t('document SVGs use overflow:visible so viewBox content is not cropped', () => {
  assert(/body img, body svg, body canvas, body video[\s\S]*?overflow: visible/.test(src),
    'doc svg/img rule must set overflow: visible');
  assert(src.includes('function preserveSvgAspect('), 'missing preserveSvgAspect()');
});

t('layout helpers run at overlay boot', () => {
  assert(/wrapScrollableTables\(\);\s*preserveSvgAspect\(\);\s*refreshComments\(\);/.test(src),
    'boot must wrap tables and pin svg aspect before refreshComments');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
