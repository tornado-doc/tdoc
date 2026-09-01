// "Create a doc" used to have exactly one path: a prompt to paste into an AI.
// This pins the second one — type a title, get a blank doc, land in edit mode —
// end to end across the two hosts (#356).
//
// The slug helpers are *executed*, not grepped: their whole job is turning
// arbitrary human titles (CJK, emoji, punctuation, 300 characters of it) into
// something that satisfies the slug rule, and a source match cannot tell you
// whether they do.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const worker = read('worker/worker.js');
const server = read('server/server.js');
const shellApi = read('shell/src/document/api.js');
const hub = read('shell/src/docs-hub.jsx') + '\n' + read('shell/src/hooks/use-docs-hub.js');
const form = read('shell/src/create-from-scratch.jsx');
const onboarding = read('shell/src/onboarding-dialog.jsx');
const editorHook = read('shell/src/hooks/use-document-editor.js');

// Lift a function out of a source file by brace matching so it can be run here.
function fnSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} not found`);
  let i = src.indexOf('(', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  while (i < src.length && src[i] !== '{') i++;
  depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const load = (names) => {
  // eslint-disable-next-line no-new-func
  return new Function(`${names.map((n) => fnSource(server, n)).join('\n')}\nreturn { ${names.join(', ')} };`)();
};
const { blankDocSlug, blankDocHtml, titleFromDocument, syncDocumentTitle } =
  load(['blankDocSlug', 'blankDocHtml', 'titleFromDocument', 'syncDocumentTitle']);
const crypto = require('crypto');
const SLUG_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

console.log('create a doc from scratch');

t('a browser-created slug is an opaque id, so it can never collide', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const slug = blankDocSlug(crypto.randomBytes(8));
    assert(SLUG_RULE.test(slug), `${slug} breaks the slug rule`);
    assert(/^d-[a-z0-9]{8}$/.test(slug), `unexpected shape: ${slug}`);
    seen.add(slug);
  }
  assert(seen.size > 1990, `only ${seen.size}/2000 distinct — the id is not random enough`);
  // Look-alikes are excluded: these get read aloud and retyped.
  for (const slug of seen) assert(!/[lo01]/.test(slug.slice(2)), `${slug} contains a look-alike character`);
});

t('short or missing randomness still yields a valid slug', () => {
  for (const bytes of [[], [1, 2], null, undefined]) {
    const slug = blankDocSlug(bytes);
    assert(SLUG_RULE.test(slug), `${JSON.stringify(bytes)} produced ${JSON.stringify(slug)}`);
  }
});

t('the title is read back out of the document heading', () => {
  assert(titleFromDocument('<h1>烘焙是什么</h1>') === '烘焙是什么', 'plain CJK heading');
  assert(titleFromDocument('<h1 data-tdoc-placeholder="Untitled">My <em>notes</em></h1>') === 'My notes',
    'inline markup should be stripped, not kept');
  assert(titleFromDocument('<h1>a &amp; b &lt;c&gt;</h1>') === 'a & b <c>', 'entities should decode');
  assert(titleFromDocument('<h1>  spaced\n  out  </h1>') === 'spaced out', 'whitespace should collapse');
  assert(titleFromDocument('<h1>' + 'x'.repeat(300) + '</h1>').length === 120, 'a runaway heading is capped');
});

t('an empty or missing heading leaves the stored title alone', () => {
  // Returning '' is what makes the caller skip the rename — a doc whose h1 the
  // author cleared must not silently become "".
  assert(titleFromDocument('<h1 data-tdoc-placeholder="Untitled"></h1>') === '', 'empty h1');
  assert(titleFromDocument('<h1><br></h1>') === '', 'a lone <br> is still empty');
  assert(titleFromDocument('<p>no heading here</p>') === '', 'no h1 at all');
  assert(titleFromDocument(null) === '', 'null input');
});

t('<title> follows the heading, and is escaped on the way', () => {
  const out = syncDocumentTitle('<html><head><title>Untitled</title></head><body></body></html>', 'My <notes>');
  assert(out.includes('<title>My &lt;notes&gt;</title>'), `got ${out}`);
  const none = syncDocumentTitle('<html><head></head><body></body></html>', 'x');
  assert(!none.includes('<title>'), 'a document without a <title> should be left as its author wrote it');
});

t('the blank document is blank all the way down, heading included', () => {
  const html = blankDocHtml();
  assert(/<h1 data-tdoc-placeholder="[^"]+"><\/h1>/.test(html), 'the heading must start empty — the author types it');
  assert(/<p data-tdoc-placeholder="[^"]+"><\/p>/.test(html), 'body should be one empty paragraph');
  assert(html.includes('<title>Untitled</title>'), 'a placeholder <title> for the tab, renamed on first save');
  assert(html.includes('html[data-tdoc-editing] [data-tdoc-placeholder]:empty::before'),
    'the placeholder rule must be scoped to editing, or readers of an empty doc see it');
  assert(/<main>/.test(html), 'findEditRoot() looks for main/article before falling back to body');
  // Round trip: the document it writes is one the title reader understands.
  assert(titleFromDocument(html) === '', 'a fresh blank doc has no title yet');
});

t('the worker create route claims a slug, charges quota, and writes v1', () => {
  const start = worker.indexOf("if (p === '/api/doc/create' && method === 'POST') {");
  assert(start >= 0, '/api/doc/create missing from the worker');
  const route = worker.slice(start, worker.indexOf("if (p === '/api/doc/duplicate'", start));
  for (const needle of [
    "json({ error: 'sign_in_required' }, { status: 401 })",
    'hostedAccountCopiesEnabled(env, req)',
    'hostedAccountForGithub(env, session.login)',
    'countHostedDocs(env, actor.account_id, limit)',
    "kind: 'claim_owner'",
    'blankDocHtml()',
    'blankDocSlug(crypto.getRandomValues(new Uint8Array(8)))',
    'prepareDocVersion(html)',
    'env.META.put(`meta:${newSlug}`',
  ]) assert(route.includes(needle), `worker create route missing: ${needle}`);
  assert(route.includes('?edit=1'), 'the new doc must come back pointing at edit mode');
});

t('the local create route stages the doc where the hub cannot list it half-built', () => {
  const start = server.indexOf("if (p === '/api/doc/create' && req.method === 'POST') {");
  assert(start >= 0, '/api/doc/create missing from the local server');
  const route = server.slice(start, server.indexOf("if (p === '/api/doc/versions'", start));
  assert(route.includes('isLocalMutation(req)'), 'local mutations must stay gated');
  assert(/stageDir = path\.join\(ROOT, `\.create-/.test(route),
    'stage under a dot-prefixed name — safeSlug rejects a dot, which is what hides it from the catalog');
  assert(route.includes('fs.renameSync(stageDir, docRoot)'), 'the doc should appear atomically');
  assert(route.includes("fs.rmSync(stageDir, { recursive: true, force: true })"), 'a failed create must not leave a stage behind');
  assert(route.includes('?edit=1'), 'the new doc must come back pointing at edit mode');
});

t('a host that would refuse the create never offers the form', () => {
  const start = worker.indexOf("page: 'docs-hub'");
  const boot = worker.slice(start - 400, start + 500);
  assert(/capabilities: \{ create: isOwnerSession\(env, s\) \|\| hostedAccountCopiesEnabled\(env, req\) \}/.test(boot),
    'the /me boot must publish the same gate the create route enforces');
  assert(read('server/server.js').includes('star: false, create: true'),
    'the local server always allows creating');
  assert(hub.includes('canCreate={capabilities.create}'), 'the modal must honour the capability');
});

t('the choice is two cards, and neither path is a form', () => {
  assert(shellApi.includes("request('/api/doc/create'"), 'createDocument missing from the shell API');
  assert(form.includes('Start from scratch') && form.includes('Build it with your AI'),
    'both cards must exist');
  assert(form.includes('className="mk-card"'), 'the cards need a stable hook');
  // The blank doc opens on the click. A title field here is the thing this
  // design replaced — the title is typed into the page instead.
  assert(!/<input/.test(form), 'the scratch card must not ask for a title');
  assert(form.includes('FIRST_DOC_RECIPE'), 'the recipe lives behind the second card');
});

t('one component serves both entry points', () => {
  // A second hand-written copy is how the two drift apart.
  assert(!hub.includes('className="mk-card"'), 'the Docs Hub should render the shared component');
  assert(!onboarding.includes('className="mk-card"'), 'the onboarding dialog should render the shared component');
  assert(hub.includes('<CreateChoice create={hub.createDoc} canCreate={capabilities.create} />'),
    'the hub must wire the cards to its hook');
  assert(onboarding.includes('<CreateChoice create={createHere} canCreate={Boolean(identity)} />'),
    'the onboarding dialog must wire the cards');
});

t('the onboarding dialog only offers the blank doc to a signed-in reader', () => {
  assert(onboarding.includes('canCreate={Boolean(identity)}'), 'the scratch card must be gated on identity');
  assert(onboarding.includes('error.status === 401'), 'an expired session needs its own message, not a raw HTTP error');
  assert(read('shell/src/document-shell.jsx').includes('identity={config.identity}'),
    'document-shell must pass identity into the dialog');
  // Signed out, the recipe card is still the whole point of this dialog.
  assert(form.includes('canCreate ? ('), 'the recipe card must survive canCreate=false');
});

t('entering edit mode puts the caret in the document', () => {
  const probe = read('server/frame-probe.js');
  const start = probe.indexOf('function enableEditing(');
  const block = probe.slice(start, probe.indexOf('function disableEditing(', start));
  assert(block.includes('selectionInsideRoot()'), 'an existing selection must be left alone');
  assert(block.includes("querySelector('[data-tdoc-placeholder]')"),
    'the caret should land on the first placeholder line — the heading of a blank doc');
  assert(block.includes('root.focus({ preventScroll: true })'), 'the editor must actually take focus');
});

t('a doc created from scratch opens in edit mode, not read mode', () => {
  assert(editorHook.includes("get('edit') === '1'"), 'the editor never looks at ?edit=1');
  assert(/wantsEdit && config\.canEdit/.test(editorHook),
    'edit-on-arrival must still respect canEdit, or a reader gets an editor that cannot save');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
