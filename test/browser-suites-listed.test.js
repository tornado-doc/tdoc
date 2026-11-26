// Every browser suite (test/*-ui.test.js) is one that CI runs: in run.js's
// BROWSER list (CI's browser jobs) or EXTENDED_BROWSER (--all), or named in
// UNLISTED_UI with the reason it is not run. A suite left out of the lists
// is never run, and goes stale without anyone seeing it fail.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BROWSER, EXTENDED_BROWSER, UNLISTED_UI } = require('./run.js');

let failed = 0;
const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };

console.log('browser suites: each one is run, or says why not');
const suites = fs.readdirSync(__dirname).filter((f) => f.endsWith('-ui.test.js')).sort();
const listed = new Set([...BROWSER, ...EXTENDED_BROWSER]);

t('every test/*-ui.test.js is in BROWSER or EXTENDED_BROWSER, or in UNLISTED_UI with a reason', () => {
  const missing = suites.filter((f) => !listed.has(f) && !Object.prototype.hasOwnProperty.call(UNLISTED_UI, f));
  assert.deepEqual(missing, [], `not run by CI (add to BROWSER in test/run.js, or to UNLISTED_UI with the reason): ${missing.join(', ')}`);
});

t('a suite left out says why, and is not also listed', () => {
  for (const [file, reason] of Object.entries(UNLISTED_UI)) {
    assert.ok(typeof reason === 'string' && reason.trim().length >= 10, `${file}: no reason given`);
    assert.ok(!listed.has(file), `${file} is listed and also left out`);
    assert.ok(suites.includes(file), `${file} is left out but does not exist`);
  }
});

t('every listed browser suite exists, once', () => {
  const all = [...BROWSER, ...EXTENDED_BROWSER];
  const gone = all.filter((f) => !fs.existsSync(path.join(__dirname, f)));
  assert.deepEqual(gone, [], `listed but missing: ${gone.join(', ')}`);
  const twice = all.filter((f, i) => all.indexOf(f) !== i);
  assert.deepEqual(twice, [], `listed twice: ${twice.join(', ')}`);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
if (failed) process.exitCode = 1;
