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
  assert(titleFromDocument('<h1>a &amp; b &lt;c&gt;</h1>') === 'a & b c', 'entities decode, then angle brackets are dropped');
  assert(titleFromDocument('<h1>  spaced\n  out  </h1>') === 'spaced out', 'whitespace should collapse');
  assert(titleFromDocument('<h1>' + 'x'.repeat(300) + '</h1>').length === 120, 'a runaway heading is capped');
});

t('a heading can never smuggle markup into the title', () => {
  // One pass of <[^>]*> is not a sanitizer: nested brackets survive it, and the
  // entity decode below it can hand back the character it just removed.
  for (const evil of [
    '<h1><<script>>alert(1)<</script>></h1>',
    '<h1><scr<x>ipt>alert(1)</scr<x>ipt></h1>',
    '<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>',
    '<h1>&amp;lt;img src=x onerror=alert(1)&amp;gt;</h1>',
  ]) {
    const out = titleFromDocument(evil);
    assert(!/[<>]/.test(out), `angle bracket survived: ${JSON.stringify(out)}`);
    assert(!/script/i.test(out) || !/[<>]/.test(out), `markup survived: ${JSON.stringify(out)}`);
  }
  // And what it produces is safe to hand straight to the <title> writer.
  const round = syncDocumentTitle('<html><head><title>x</title></head><body></body></html>',
    titleFromDocument('<h1><<script>>hi<</script>></h1>'));
  assert(!/<script/i.test(round), 'a crafted heading reached <title> as markup');
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
    'sessionLogin(session)\n        ? await hostedAccountForGithub(env, session.login, session && session.email',
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
  assert(form.includes('<FirstDocRecipe />'), 'the recipe lives behind the second card');
});

t('the cards live in the Docs Hub, and the recipe has one implementation', () => {
  assert(hub.includes('<CreateChoice create={hub.createDoc} canCreate={capabilities.create} />'),
    'the hub must wire the cards to its hook');
  // A second hand-written copy is how the two drift apart.
  assert(!hub.includes('className="mk-card"'), 'the Docs Hub should render the shared component');
  assert(form.includes('<FirstDocRecipe />'), 'the AI card should render the shared recipe, not its own copy');
  assert(!form.includes('tdoc-recipe-wrap'), 'the recipe markup belongs to one component');
  assert(onboarding.includes('export function FirstDocRecipe('), 'the shared recipe lost its home');
});

t('the onboarding dialog is onboarding, not a doc launcher (#371)', () => {
  // The landing dialog exists to get tdoc installed and a first doc published
  // through the reader's own agent. A blank-doc card answers a question a
  // first-time visitor has not asked yet.
  assert(!onboarding.includes('CreateChoice'), 'the onboarding dialog must not offer the cards');
  assert(!onboarding.includes('createDocument'), 'the onboarding dialog must not create documents');
  // The recipe lives behind the "Use my own agent" door now — still the one
  // rendering, still the whole of what that door hands over.
  assert(onboarding.includes('<FirstDocRecipe onCopied='), 'the recipe is what the own-agent door hands over');
  // The dialog takes the config (its left door needs to know whether there
  // is a session) and the shell's sign-in, and nothing else.
  const mount = read('shell/src/document-shell.jsx').match(/<OnboardingDialog[\s\S]*?\/>/);
  assert(mount && /config=\{config\}/.test(mount[0]) && /onSignIn=\{signIn\}/.test(mount[0]),
    'the dialog needs the config and the sign-in');
  assert(!/identity=/.test(mount[0]), 'the dialog reads identity off config, not as its own prop');
  // The hub's own card still respects the host capability.
  assert(form.includes('canCreate ? ('), 'the recipe card must survive canCreate=false');
});

t('a hint steps aside for the caret, but not for the one we place', () => {
  const html = blankDocHtml();
  assert(html.includes('html[data-tdoc-editing] [data-tdoc-placeholder][data-tdoc-caret]:empty::before'),
    'the caret-line rule is missing, so a hint sits under the cursor you just placed');
  assert(/\[data-tdoc-placeholder\]:empty \{\s*min-height/.test(html),
    'an empty block is 0px tall — without a floor the placeholder line cannot be clicked into');
  const probe = read('server/frame-probe.js');
  assert(probe.includes('var caretHintsArmed = false;'), 'the arming flag is gone');
  assert(/caretHintsArmed = false;\n    markCaretLine\(\);/.test(probe),
    'entering edit mode must re-disarm, or the caret it places blanks the guidance on the first paint');
  assert(probe.includes("addEventListener('mousedown', armCaretHints, true)")
    && probe.includes("addEventListener('keydown', armCaretHints, true)"),
    'the reader moving the caret themselves is what arms the marking');
  const clean = probe.slice(probe.indexOf('function cleanEditorAttributes('));
  assert(clean.includes("querySelectorAll('[data-tdoc-caret]')"),
    'the caret marker is editor chrome and must be stripped before a version is stored');
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

t('the bar names a document by its title, never by its slug', () => {
  const toolbar = read('shell/src/document/document-toolbar.jsx');
  const start = toolbar.indexOf('export function DocumentBreadcrumbs(');
  const block = toolbar.slice(start, toolbar.indexOf('\nexport function', start + 20));
  // The title moved into DocumentTitle when it became renameable (#383); what
  // must not come back is the slug standing in for a name.
  assert(block.includes('<DocumentTitle title={title}'), 'the title must still lead the bar');
  assert(toolbar.includes('className="doc-title"'), 'the title lost its hook');
  assert(!toolbar.includes('crumb-slug'), 'the slug crumb is back in the bar');
  // The version menu still needs the slug to build hrefs — that is a URL, not
  // a label; what must not return is the slug rendered as the document's name.
  assert(!/>\{config\.slug\}</.test(toolbar), 'the slug is being rendered as text again');
  const css = read('server/chrome.css');
  assert(!css.includes('crumb-slug'), 'dead slug-crumb styling left behind');
  assert(!/\.tdoc-bar \.crumb \{/.test(css), 'dead .crumb styling left behind');
});

t('a doc created from scratch opens in edit mode, not read mode', () => {
  assert(editorHook.includes("get('edit') === '1'"), 'the editor never looks at ?edit=1');
  assert(/(?:urlWantsEdit\(\)|wantsEdit) && config\.canEdit/.test(editorHook),
    'edit-on-arrival must still respect canEdit, or a reader gets an editor that cannot save');
});

t('a doc created from scratch shares the CLI default: no stored access policy', () => {
  // A CLI publish stores no `access`, so accessFromMeta falls back to the
  // legacy defaults — public, with version history visible to anyone holding
  // the link. Creating in the browser used to stamp the product defaults into
  // meta instead (unlisted + owner-only history), so two docs with the same
  // content behaved differently depending on where they were born, and a
  // shared link silently showed one version instead of all of them.
  const scratch = worker.slice(
    worker.indexOf("prompt: 'Created from scratch in the browser'") - 400,
    worker.indexOf("prompt: 'Created from scratch in the browser'") + 400,
  );
  assert(!/access:\s*normalizeAccess/.test(scratch),
    'creating from scratch stamps an access policy again; a CLI publish stores none');

  // The duplicate path is deliberately NOT the same: on tdoc.dev a reader may
  // duplicate someone else's doc, and a copy carrying a public policy would
  // republish it. hosted-oob-behavior asserts a copy defaults unlisted.
  const duplicate = worker.slice(
    worker.indexOf('duplicated_by: session.login') - 200,
    worker.indexOf('duplicated_by: session.login') + 600,
  );
  assert(/access:\s*normalizeAccess\({}, { legacy: false }\)/.test(duplicate),
    'a duplicate must keep its own conservative default, not inherit or drop it');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
