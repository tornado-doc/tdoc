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

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'reader.css'), 'utf8');

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

// RETIRED with the overlay monolith: wrapScrollableTables()/preserveSvgAspect()
// were JS that mutated AUTHOR DOM at overlay boot — the injection-layer class of
// behavior model B removes (main's #284 reverted a table treatment for exactly
// this reason). Docs are self-contained now; the reader.css that ships (baked
// at creation / legacy serve-time fallback) keeps the CSS-only defenses.

t('wide-table scroll wrapper CSS survives for docs that use it', () => {
  assert(src.includes('.tdoc-table-scroll'), 'missing .tdoc-table-scroll wrapper class');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
