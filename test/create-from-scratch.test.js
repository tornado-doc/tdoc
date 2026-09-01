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
const { slugifyTitle, nextCreateSlug, blankDocHtml } = load(['slugifyTitle', 'nextCreateSlug', 'blankDocHtml']);
const SLUG_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

console.log('create a doc from scratch');

t('a plain title becomes the obvious slug', () => {
  // Mixed titles keep their ASCII words: the CJK run collapses to a separator
  // rather than swallowing the words around it.
  assert(slugifyTitle('Hook 与本地 Daemon') === 'hook-daemon', `got ${slugifyTitle('Hook 与本地 Daemon')}`);
  assert(slugifyTitle('My First Doc') === 'my-first-doc');
  assert(slugifyTitle("Serena's notes!!") === 'serenas-notes');
});

t('a title with no ASCII at all still yields a valid slug', () => {
  for (const title of ['烘焙是什么', '🎂🎂🎂', '。。。', '——']) {
    const slug = slugifyTitle(title);
    assert(SLUG_RULE.test(slug), `${title} → ${JSON.stringify(slug)} breaks the slug rule`);
    assert(slug === 'doc', `${title} should fall back to "doc", got ${slug}`);
  }
});

t('a very long title is truncated without a trailing dash', () => {
  const slug = slugifyTitle('a '.repeat(200));
  assert(SLUG_RULE.test(slug), `long title produced ${JSON.stringify(slug)}`);
  assert(slug.length <= 48, `expected <= 48 chars, got ${slug.length}`);
  assert(!slug.endsWith('-'), 'slug must not end on a dash');
});

t('de-duplication counts up and never breaks the slug rule', () => {
  assert(nextCreateSlug('notes', 1) === 'notes', 'first candidate is the bare base');
  assert(nextCreateSlug('notes', 2) === 'notes-2');
  assert(nextCreateSlug('notes', 99) === 'notes-99');
  const long = 'a'.repeat(64);
  for (const n of [1, 2, 10, 99]) {
    const candidate = nextCreateSlug(long, n);
    assert(candidate && SLUG_RULE.test(candidate), `n=${n} produced ${JSON.stringify(candidate)}`);
    assert(candidate.length <= 64, `n=${n} exceeded 64 chars`);
  }
  assert(nextCreateSlug('', 1) === null, 'an empty base has no candidate');
  assert(nextCreateSlug('notes', 0) === null, 'n starts at 1');
});

t('the blank document escapes the title instead of trusting it', () => {
  const html = blankDocHtml('</title><script>alert(1)</script>');
  assert(!html.includes('<script>'), 'title injected raw markup');
  assert(html.includes('&lt;script&gt;'), 'title should be escaped');
  const quoted = blankDocHtml('a "quoted" title');
  assert(quoted.includes('&quot;quoted&quot;'), 'double quotes must be escaped');
});

t('the blank document is genuinely blank, with an editor-only placeholder', () => {
  const html = blankDocHtml('Notes');
  assert(html.includes('<h1>Notes</h1>'), 'the typed title becomes the heading');
  assert(/<p data-tdoc-placeholder="[^"]+"><\/p>/.test(html), 'body should be one empty paragraph');
  assert(html.includes('html[data-tdoc-editing] [data-tdoc-placeholder]:empty::before'),
    'the placeholder rule must be scoped to editing, or readers of an empty doc see it');
  assert(/<main>/.test(html), 'findEditRoot() looks for main/article before falling back to body');
});

t('the worker create route claims a slug, charges quota, and writes v1', () => {
  const start = worker.indexOf("if (p === '/api/doc/create' && method === 'POST') {");
  assert(start >= 0, '/api/doc/create missing from the worker');
  const route = worker.slice(start, worker.indexOf("if (p === '/api/doc/duplicate'", start));
  for (const needle of [
    "json({ error: 'sign_in_required' }, { status: 401 })",
    "json({ error: 'title_required' }, { status: 400 })",
    'hostedAccountCopiesEnabled(env, req)',
    'hostedAccountForGithub(env, session.login)',
    'countHostedDocs(env, actor.account_id, limit)',
    "kind: 'claim_owner'",
    'blankDocHtml(rawTitle)',
    'slugifyTitle(rawTitle)',
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
  assert(hub.includes('capabilities.create ?'), 'the modal must honour the capability');
});

t('both entry points offer the form, and neither loses the recipe', () => {
  assert(shellApi.includes("request('/api/doc/create'"), 'createDocument missing from the shell API');
  assert(form.includes('Start from scratch'), 'the shared form lost its heading');
  assert(form.includes('mk-scratch-go'), 'the create button needs a stable hook');
  // One form, two callers — a second hand-written copy is how the two drift.
  // The markup, not the prose: `Start from scratch` also appears in comments.
  assert(!hub.includes('mk-scratch-row'), 'the Docs Hub should render the shared form, not its own copy');
  assert(!onboarding.includes('mk-scratch-row'), 'the onboarding dialog should render the shared form, not its own copy');
  assert(hub.includes('<CreateFromScratch create={hub.createDoc} />'), 'the hub must wire the form to its hook');
  assert(onboarding.includes('<CreateFromScratch create={createHere} />'), 'the onboarding dialog must wire the form');
  assert(hub.includes('FIRST_DOC_RECIPE') && onboarding.includes('FIRST_DOC_RECIPE'),
    'the paste-into-your-AI recipe must stay on both');
});

t('the onboarding dialog only offers the form to a signed-in reader', () => {
  assert(/\{identity \? \(/.test(onboarding), 'the form must be gated on identity');
  assert(onboarding.includes("error.status === 401"), 'a expired session needs its own message, not a raw HTTP error');
  assert(read('shell/src/document-shell.jsx').includes('identity={config.identity}'),
    'document-shell must pass identity into the dialog');
});

t('a doc created from scratch opens in edit mode, not read mode', () => {
  assert(editorHook.includes("get('edit') === '1'"), 'the editor never looks at ?edit=1');
  assert(/wantsEdit && config\.canEdit/.test(editorHook),
    'edit-on-arrival must still respect canEdit, or a reader gets an editor that cannot save');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
