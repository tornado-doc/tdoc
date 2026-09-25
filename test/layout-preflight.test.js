// Actual Raft failure: fitting the page does not imply readable columns or SVG.
const assert = require('assert/strict');
const path = require('path');
const { checkLayout } = require('./helpers/check-layout');
const bad = path.join(__dirname, 'fixtures/raft-layout-regression.html');

(async () => {
  const reports = await checkLayout(bad);
  assert.equal(reports.length, 6);
  const narrow = reports.find(r => r.width === 1440 && r.mode === 'narrow');
  const wide = reports.find(r => r.width === 1440 && r.mode === 'wide');
  assert(narrow.tableLayout.adjustments.length > 0, 'provider must report protecting squeezed cells');
  assert(!narrow.errors.some(e => e.includes('compressed table column')));
  assert(narrow.errors.some(e => e.includes('small rendered text')));
  assert(wide.errors.some(e => e.includes('outside SVG')));
  assert(!wide.errors.some(e => e.includes('compressed table column')));
  console.log('  ✓ shared provider protects original Raft table; bad SVG is still detected by the development audit');

})().catch(error => { console.error(error); process.exitCode = 1; });
