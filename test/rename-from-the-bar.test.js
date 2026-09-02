// #383: the title in the bar was not editable. Renaming meant entering edit
// mode, changing the heading, and publishing a version.
//
// Fixing it settled a question the codebase had left open — where a title
// lives — and that question had already produced a bug: #368 made every
// browser save re-read the first h1, which silently renames a document whose
// first h1 is not its title. tdoc.dev has one: tdoc-start is called "tdoc, get
// started" and opens with <h1 class="tagline">Everything tdoc does.</h1>.
//
// A title is a property of the document. Only a document created blank — where
// the author typed the title into a heading we laid down for exactly that
// purpose — keeps taking its title from its heading.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const worker = read('worker/worker.js');
const server = read('server/server.js');
const toolbar = read('shell/src/document/document-toolbar.jsx');
const shell = read('shell/src/document-shell.jsx');
const api = read('shell/src/document/api.js');

console.log('rename from the bar (#383)');

t('only a document created blank takes its title from its heading', () => {
  for (const [name, src] of [['worker', worker], ['server', server]]) {
    assert(/meta\.created_from === 'blank' \? titleFromDocument\(rewritten\) : ''/.test(src),
      `${name}: a save still re-reads the heading of every document`);
  }
  assert(/created_from: 'blank',/.test(worker) && /created_from: 'blank',/.test(server),
    'the create routes must record how the document came to exist');
});

t('renaming is a metadata edit, not a publish', () => {
  const start = worker.indexOf("if (p === '/api/doc/title' && method === 'PATCH')");
  assert(start >= 0, 'the worker has no rename route');
  const route = worker.slice(start, worker.indexOf('// ---- admin delete ----', start));
  assert(route.includes('authorizeOwnerMutation(req, env, slug)'), 'renaming must use the shared owner gate');
  assert(/env\.META\.put\(`meta:\$\{slug\}`, JSON\.stringify\(\{ \.\.\.meta, title: clean \}\)\)/.test(route),
    'the rename must write the title and nothing else');
  assert(!/DOCS\.put|versions|prepareDocVersion/.test(route),
    'renaming must not touch the body or the version list');
  assert(route.includes("json({ error: 'title_required' }"), 'an empty title is not a rename');
  assert(route.includes("error: 'title_too_long'"), 'the title needs a bound');
  assert(route.includes("error: 'invalid_field'"), 'reject unknown fields, as the access patch does');
});

t('the local rename writes the meta file atomically', () => {
  const start = server.indexOf("if (p === '/api/doc/title' && req.method === 'PATCH')");
  assert(start >= 0, 'the local server has no rename route');
  const route = server.slice(start, server.indexOf('// Start from scratch', start));
  assert(route.includes('isLocalMutation(req)'), 'local mutations stay gated');
  assert(/fs\.writeFileSync\(stage[\s\S]*fs\.renameSync\(stage, metaFile\)/.test(route),
    'write beside and rename, so a crash cannot truncate meta.json');
  assert(!/rename_failed'[\s\S]{0,80}message/.test(route), 'do not hand the browser the exception text');
});

t('the title is a control only for whoever owns the document', () => {
  assert(toolbar.includes('function DocumentTitle('), 'the editable title component is missing');
  assert(/if \(!canRename\) return <span className="doc-title">/.test(toolbar),
    'a reader must get plain text, not a disabled control');
  assert(/canRename=\{Boolean\(config\.isOwner\)\}/.test(toolbar), 'renaming is the owner\'s');
});

t('Enter commits, Escape abandons, empty restores', () => {
  const start = toolbar.indexOf('function DocumentTitle(');
  const block = toolbar.slice(start, toolbar.indexOf('export function DocumentBreadcrumbs', start));
  assert(/if \(!next \|\| next === title\) \{ setDraft\(title\); return; \}/.test(block),
    'an empty or unchanged title must restore, never clear the name');
  assert(/event\.key === 'Escape'[\s\S]{0,60}setDraft\(title\); setEditing\(false\);/.test(block),
    'Escape must abandon the edit');
  assert(/onBlur=\{commit\}/.test(block), 'leaving the field should commit, like a spreadsheet cell');
});

t('the new name appears at once and rolls back if the server refuses', () => {
  assert(api.includes("request('/api/doc/title'"), 'the shell API cannot rename');
  const start = shell.indexOf('const renameDoc = async');
  const block = shell.slice(start, shell.indexOf('const toggleStar', start));
  assert(/setTitle\(next\);\s*\n\s*document\.title = next;/.test(block), 'the bar and the tab should update together');
  assert(/catch \(error\) \{\s*\n\s*setTitle\(previous\);/.test(block),
    'a refused rename must roll back — a rename that looks applied and was not is worse than a slow one');
  assert(/showToast\(error\.message \|\| 'Could not rename', true\)/.test(block), 'say so when it fails');
});

t('the list can rename too, through the same route', () => {
  const hub = read('shell/src/docs-hub.jsx');
  const hook = read('shell/src/hooks/use-docs-hub.js');
  assert(/label: 'Rename',/.test(hub), 'Rename is missing from the row menu');
  assert(/doc && \(!doc\.owner \|\| doc\.owner === viewer\) \?/.test(hub),
    'only offer Rename where the server would allow it, rather than serving a 403');
  assert(/initialName=\{modal\.doc\.title \|\| ''\}/.test(hub), 'the dialog should start from the current name');
  assert(/maxLength=\{120\}/.test(hub), 'the list dialog must accept as long a title as the route does');
  // One name prompt, two callers — folders had it first.
  assert(hub.includes('function NameDialog('), 'the shared name dialog is gone');
  assert(!hub.includes('FolderNameDialog'), 'a folder-specific copy came back');
  assert(/saved = await renameDocument\(slug, trimmed\)/.test(hook), 'the list must use the same route');
  assert(/item\.slug === slug \? \{ \.\.\.item, title: saved\.title \}/.test(hook),
    'the row should take the title the server echoed, not the one that was typed');
  assert(/setDocs\(apply\);\s*\n\s*setRecent\(apply\);\s*\n\s*setStarred\(apply\);/.test(hook),
    'every list holding that doc has to move together');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
