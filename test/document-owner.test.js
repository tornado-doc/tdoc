// #395: a tdoc never said whose it was. The only person named on screen was the
// viewer, in their own chip.
//
// The rules that matter here are about ABSENCE: an owner exists only for hosted
// publishes, and everything else must name nobody rather than guess.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const worker = read('worker/worker.js');
const server = read('server/server.js');
const hub = read('shell/src/docs-hub.jsx');
const toolbar = read('shell/src/document/document-toolbar.jsx');
const chromeCss = read('server/chrome.css');

// The hub's rule, lifted and executed rather than eyeballed.
function ownerLabel(doc, viewer) {
  if (!doc.owner) return null;
  return viewer && doc.owner === viewer ? 'me' : doc.owner;
}

console.log('a document says whose it is (#395)');

t('the worker hands the shell an owner, from the one field that records one', () => {
  const start = worker.indexOf('function shellDocumentWorker(');
  const block = worker.slice(start, worker.indexOf('\nfunction ', start + 20));
  assert(/const author = hostedGithubLogin\(docMeta\) \|\| null;/.test(block),
    'the owner must come from the hosted stamp, the only place a person is recorded');
  assert(/\n    author,\n/.test(block), 'author is missing from the boot config');
  // versions[].author only exists for browser edits, so it would be present on
  // some documents and absent on others — a worse answer than naming nobody.
  assert(!/versions\[0\]\.author|item\.author/.test(block),
    'the owner must not be guessed from a version record');
});

t('the whole meta record is passed, not one field at a time', () => {
  assert(/commentWritesEnabled, docMeta, oidc\)/.test(worker), 'the shell builder should take the meta record');
  assert(/canCommentOnDoc\(gate\.access, session, env, gate\.meta\), gate\.meta, /.test(worker),
    'the call site should hand over the record it already loaded');
});

t('the local server declares an owner it can never have', () => {
  const start = server.indexOf("mode: 'local'");
  const block = server.slice(start - 400, start + 600);
  assert(/author: null,/.test(block),
    'declare the field so the shell reads one shape from both hosts');
});

t('a document with nobody recorded names nobody', () => {
  assert(/\{config\.author \? <span className="doc-author">\{config\.author\}<\/span> : null\}/.test(toolbar),
    'the bar must render nothing at all when there is no owner');
  assert(ownerLabel({ owner: '' }, 'serena') === null, 'an empty owner is not a label');
  assert(ownerLabel({}, 'serena') === null, 'a missing owner is not a label');
});

t('your own documents say "me", everyone else is named', () => {
  assert(ownerLabel({ owner: 'serena' }, 'serena') === 'me', 'your own doc should read "me"');
  assert(ownerLabel({ owner: 'julie' }, 'serena') === 'julie', "someone else's doc should name them");
  // "me" is a claim about the viewer, so it needs a viewer.
  assert(ownerLabel({ owner: 'serena' }, '') === 'serena', 'a signed-out reader sees the name, never "me"');
  assert(ownerLabel({ owner: 'serena' }, null) === 'serena', 'no identity means no "me"');
});

t('one rule across the lists, not one per list', () => {
  assert(hub.includes('function ownerLabel(doc, viewer)'), 'the shared rule is gone');
  assert(!/by \$\{doc\.owner\}/.test(hub), 'the Recent list kept its own phrasing');
  assert((hub.match(/ownerLabel\(doc, viewer\)/g) || []).length >= 2,
    'both lists must go through the same rule');
});

t('the title outlives the author when the bar tightens', () => {
  const narrow = chromeCss.slice(chromeCss.indexOf('@media (max-width: 900px)'));
  assert(/\.tdoc-bar \.doc-author \{ display: none; \}/.test(narrow.slice(0, 400)),
    'the author should fold away at the same breakpoint as the identity name');
  assert(/\.tdoc-bar \.doc-author \{[^}]*flex: 0 0 auto/.test(chromeCss),
    'a long login must truncate itself rather than take the title\'s room');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
