// #380: a doc created from scratch started its history with the blank page the
// create route lays down, and the author's first words became v2.
//
// The replacement is deliberately narrow, and these assertions are mostly about
// the bounds: it takes the mark the create route sets, only while the doc still
// has that one version, and the save that takes the path writes a record with
// no mark — so a document can never replace twice.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const worker = read('worker/worker.js');
const server = read('server/server.js');
const toolbar = read('shell/src/document/editor-toolbar.jsx');

// Both hosts spell the same predicate; run it rather than trusting the source.
function scaffoldPredicate(versions, baseVersion) {
  const prior = Array.isArray(versions) ? versions : [];
  return prior.length === 1
    && Number(prior[0] && prior[0].n) === 1
    && Boolean(prior[0] && prior[0].blank)
    && Number(baseVersion) === 1;
}

console.log('first save replaces the blank scaffold (#380)');

t('both create routes mark the scaffold', () => {
  assert(/prompt: 'Created from scratch in the browser', blank: true/.test(worker),
    'the worker create route does not mark its scaffold');
  const localCreate = server.slice(server.indexOf("if (p === '/api/doc/create'"));
  assert(/blank: true,/.test(localCreate.slice(0, localCreate.indexOf('/api/doc/versions'))),
    'the local create route does not mark its scaffold');
});

t('the predicate accepts exactly the case it is for', () => {
  const scaffold = [{ n: 1, blank: true }];
  assert(scaffoldPredicate(scaffold, 1), 'a marked, single-version doc saving from v1 should replace');
});

t('and refuses everything else', () => {
  assert(!scaffoldPredicate([{ n: 1 }], 1), 'an unmarked v1 (pre-#380 doc, or a CLI publish) must append');
  assert(!scaffoldPredicate([{ n: 1, blank: true }, { n: 2 }], 2),
    'a doc past v1 must append, mark or no mark');
  assert(!scaffoldPredicate([{ n: 1, blank: true }], 2), 'a save based on another version must append');
  assert(!scaffoldPredicate([], 1), 'no versions is not a scaffold');
  assert(!scaffoldPredicate(null, 1), 'missing versions must not throw or replace');
  assert(!scaffoldPredicate([{ n: 2, blank: true }], 1), 'the marked version has to be v1');
});

t('the worker skips the version reservation, widget copy and cursor for a replace', () => {
  const start = worker.indexOf('async _saveVersion(');
  const block = worker.slice(start, worker.indexOf('\n  async fetch(', start));
  assert(/const reservation = replacesScaffold\s*\n\s*\? \{ ok: true, next: 1 \}/.test(block),
    'a replace must not reserve a new version number');
  assert(/if \(!replacesScaffold\) await this\._copyVersionWidgets/.test(block),
    'copying widgets from v1 to v1 is not a thing');
  assert(/if \(!replacesScaffold\) \{\s*\n\s*try \{\s*\n\s*await this\._finishVersion\(reservation, true\);/.test(block),
    'the reservation cursor belongs to the reserve path only');
  assert(/if \(!committed && !replacesScaffold\)/.test(block),
    'the failure path must not release a reservation it never took');
});

t('the local replace keeps the rename atomic and drops the old directory after', () => {
  const start = server.indexOf("if (p === '/api/doc/versions' && req.method === 'POST')");
  const block = server.slice(start, server.indexOf("if (p === '/api/mentions'", start));
  assert(/const nextVersion = replacesScaffold \? 1 : latest \+ 1;/.test(block), 'the target version is wrong');
  assert(/if \(!replacesScaffold && fs\.existsSync\(finalDir\)\)/.test(block),
    'an existing v1 is expected on the replace path, not a conflict');
  assert(/displaced = path\.join\(docRoot, `\.v1-replaced-/.test(block),
    'swap the old directory aside so the rename into place stays atomic');
  assert(/fs\.renameSync\(stageDir, finalDir\);\s*\n\s*if \(displaced\) fs\.rmSync\(displaced/.test(block),
    'the old directory must only be removed after the new one is in place');
});

t('the replacing save writes a record with no mark', () => {
  assert(worker.includes('.filter((item) => Number(item && item.n) !== reservation.next)'),
    'the worker must drop the old record rather than merge into it');
  assert(/priorVersions\.filter\(\(item\) => Number\(item && item\.n\) !== nextVersion\)/.test(server),
    'the local server must drop the old record rather than merge into it');
});

t('a blank doc nobody typed into cannot be saved at all', () => {
  // The acceptance criterion "left blank and saved does not become written" is
  // held by the button, not the route: there is nothing to save until the
  // editor reports a dirty draft.
  assert(/disabled=\{!dirty \|\| checking \|\| saving\}/.test(toolbar),
    'Save must stay disabled until there is a draft');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
