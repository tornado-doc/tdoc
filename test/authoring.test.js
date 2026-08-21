// authoring/ contract guard.
//
// The point of authoring/ is that generation cannot quietly stop going
// through it. A prose rule set that nothing references is a file nobody
// reads, and that failure is silent: docs keep generating, just without
// the contract. These tests convert "the reference was dropped" and "the
// vendored copy was edited in place" into build failures.
//
// What this CANNOT test: whether a model actually obeys voice.md at
// generation time. The offline suite has no model. It tests that the
// contract is wired in and intact — necessary, not sufficient.
//
// Run with: node test/authoring.test.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

console.log('authoring/ contract');

t('all three slots exist', () => {
  for (const p of ['authoring/README.md', 'authoring/voice.md',
                   'authoring/style/README.md', 'authoring/structure/README.md']) {
    assert(exists(p), `missing ${p}`);
  }
});

t('style/ and structure/ are still empty mount points', () => {
  // Adding entries is fine — but it must be a deliberate change that also
  // teaches SKILL.md how to select one, not a stray file. This test is the
  // reminder to do both.
  for (const dir of ['authoring/style', 'authoring/structure']) {
    const entries = fs.readdirSync(path.join(root, dir));
    assert(entries.length === 1 && entries[0] === 'README.md',
      `${dir} gained ${entries.filter(e => e !== 'README.md').join(', ')} — ` +
      `if that is intended, teach SKILL.md how a doc selects one, then update this test`);
  }
});

t('SKILL.md makes voice.md required reading before generating', () => {
  const s = read('SKILL.md');
  assert(/authoring\/voice\.md/.test(s), 'SKILL.md never references authoring/voice.md');
  assert(/## Authoring contract/.test(s), 'SKILL.md lost the top-level Authoring contract section');
});

t('the reference sits on BOTH generation paths (/tdoc new and /tdoc edit)', () => {
  const s = read('SKILL.md');
  const section = (start, end) => {
    const a = s.indexOf(start);
    assert(a !== -1, `section not found: ${start}`);
    const b = end ? s.indexOf(end, a) : s.length;
    return s.slice(a, b === -1 ? s.length : b);
  };
  const nw = section('### `/tdoc new', '### `bin/tdoc-new');
  const ed = section('### `/tdoc edit', '### `/tdoc fork');
  assert(/authoring\/voice\.md/.test(nw), '/tdoc new no longer reads authoring/voice.md');
  assert(/authoring\/voice\.md/.test(ed), '/tdoc edit no longer reads authoring/voice.md');
});

t('HTML generation rules point at the prose contract', () => {
  const s = read('SKILL.md');
  const i = s.indexOf('## HTML generation rules');
  assert(i !== -1, 'HTML generation rules section is gone');
  const sect = s.slice(i, s.indexOf('\n## ', i + 10));
  assert(/authoring\/voice\.md/.test(sect),
    'HTML generation rules no longer reference authoring/voice.md');
});

t('voice.md defers to the vendored rule set instead of forking it', () => {
  const v = read('authoring/voice.md');
  assert(/vendor\/no-ai-slop\.md/.test(v), 'voice.md does not point at the vendored rules');
  // The banned-word lists must have exactly one home. A second copy in
  // voice.md would drift from upstream the first time it is updated.
  assert(!/^Banned outright:/m.test(v),
    'voice.md duplicates the banned-word list — it must cite vendor/no-ai-slop.md as the authority');
});

t('voice.md fences off spans the prose rules must not rewrite', () => {
  const v = read('authoring/voice.md');
  // A prose rule applied to an error string or an API name corrupts it.
  for (const term of ['code', 'identifiers', 'quoted', 'data']) {
    assert(new RegExp(term, 'i').test(v), `voice.md does not fence off ${term}`);
  }
});

t('vendored no-ai-slop copy is present and unmodified', () => {
  assert(exists('authoring/vendor/no-ai-slop.md'), 'vendored copy missing');
  const body = read('authoring/vendor/no-ai-slop.md');
  assert(body.length > 2000, 'vendored copy looks truncated');
  const actual = crypto.createHash('sha256').update(body).digest('hex');
  const readme = read('authoring/README.md');
  const m = /Content sha256 of that file: `([0-9a-f]{64})`/.exec(readme);
  assert(m, 'authoring/README.md does not record the vendored sha256');
  assert(actual === m[1],
    `vendored copy was edited in place (sha ${actual.slice(0, 12)} vs recorded ${m[1].slice(0, 12)}).\n` +
    '    Adapt tdoc behavior in authoring/voice.md, not by editing the vendored file.\n' +
    '    If this is a genuine upstream refresh, update the sha and the pinned commit in README.');
});

t('MIT attribution ships with the vendored copy', () => {
  assert(exists('authoring/vendor/LICENSE-no-ai-slop'), 'upstream LICENSE not vendored');
  const lic = read('authoring/vendor/LICENSE-no-ai-slop');
  assert(/MIT License/.test(lic), 'vendored LICENSE is not the MIT text');
  assert(/Copyright \(c\)/.test(lic), 'vendored LICENSE has no copyright line');
  assert(/upstream|no-ai-slop/i.test(read('authoring/README.md')), 'README does not credit upstream');
});

t('upstream commit is pinned so a refresh is a deliberate diff', () => {
  const readme = read('authoring/README.md');
  assert(/\b[0-9a-f]{40}\b/.test(readme), 'README does not pin an upstream commit sha');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
