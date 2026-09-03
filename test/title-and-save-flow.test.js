// #367: three things the blank-doc flow exposed on tdoc.dev.
//
//   1. shellDocumentWorker named every hosted document after its slug, because
//      `let title = slug` was never reassigned. Invisible while slugs were
//      agent-picked words; loud once a slug could be `d-gy9vxdmy`.
//   2. save() navigated while the draft was still marked dirty, so the
//      beforeunload guard put a browser "Leave site?" confirm in front of every
//      single save.
//   3. Save publishes, and nothing said so.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const worker = read('worker/worker.js');
const editorHook = read('shell/src/hooks/use-document-editor.js');
const toolbar = read('shell/src/document/editor-toolbar.jsx');
const shell = read('shell/src/document-shell.jsx');
const frameProbe = read('server/frame-probe.js');

console.log('hosted title + save flow (#367)');

t('the worker names a document by its own title, with the slug as fallback', () => {
  const start = worker.indexOf('function shellDocumentWorker(');
  const block = worker.slice(start, worker.indexOf('\nfunction ', start + 20));
  assert(/function shellDocumentWorker\([^)]*docMeta, oidc\)/.test(worker),
    'shellDocumentWorker never receives the document record the title comes from');
  assert(!/let title = slug;/.test(block), 'the title is still hardcoded to the slug');
  assert(/const title = typeof docTitle === 'string' && docTitle\.trim\(\) \? docTitle\.trim\(\) : slug;/.test(block),
    'a doc whose meta has no title must still fall back to the slug, not render blank');
});

t('the render call passes the record it just loaded', () => {
  assert(/canCommentOnDoc\(gate\.access, session, env, gate\.meta\), gate\.meta, /.test(worker),
    'gate.meta is in scope at the call site and must be handed to the shell');
});

t('the save navigation is exempt from the unsaved-work warning', () => {
  assert(editorHook.includes('const leavingForSave = useRef(false);'), 'the exemption flag is gone');
  assert(/if \(leavingForSave\.current\) return;/.test(editorHook),
    'beforeunload must stand down for the save\'s own navigation');
  const save = editorHook.slice(editorHook.indexOf('const save = useCallback'));
  assert(save.indexOf('leavingForSave.current = true;') < save.indexOf('location.href ='),
    'the flag has to be set before the navigation, not after');
  // Closing a tab mid-edit must still warn — the guard is conditional, not gone.
  assert(/event\.preventDefault\(\);\s*\n\s*event\.returnValue = '';/.test(editorHook),
    'the unsaved-work warning was removed instead of being made conditional');
});

t('a save leaves you where you were: still editing, on the new version', () => {
  const save = editorHook.slice(editorHook.indexOf('const save = useCallback'));
  assert(/searchParams\.set\('edit', '1'\)/.test(save),
    'saving must hand the author back an editor, not read mode');
  assert(/new URL\(result\.url, location\.origin\)/.test(save),
    'compose the URL rather than appending ?edit=1, so a response with a query still works');
  // ?edit=1 is honoured only when the reader can actually edit, so this cannot
  // hand an editor to someone who has nothing to save to.
  assert(/(?:urlWantsEdit\(\)|wantsEdit) && config\.canEdit/.test(editorHook),
    'the canEdit gate on ?edit=1 is gone');
});

t('a draft restores only after the published bytes are known, and per doc', () => {
  assert(shell.includes("'tdoc:editBaseline'"), 'the shell never listens for the published HTML');
  assert(editorHook.includes('considerDraft'), 'a matching fingerprint is the silent path; a mismatch has to prompt');
  assert(editorHook.includes('staleDraft'), 'the prompt for a draft whose base moved is gone');
  assert(read('shell/src/document/draft-store.js').includes('${config.slug}:${author}'),
    'the cache key must be per document, not per version and not global');
});

t('each edit is handed to synchronous draft storage before debounce settles', () => {
  assert(frameProbe.includes("post({ type: 'tdoc:editDraft', bodyHtml: immediateHtml })"),
    'the frame leaves the newest keystroke inside the debounce window');
  assert(shell.includes("'tdoc:editDraft'"), 'the shell does not receive immediate recovery snapshots');
  assert(editorHook.includes('editDraft(message)'), 'immediate recovery snapshots are not persisted');
  assert(read('shell/src/document/draft-store.js').includes('writeLocalRecord(key, value);'),
    'draft persistence does not synchronously mirror before IndexedDB');
});

t('the first save explains that it publishes, and can be told to stop', () => {
  assert(toolbar.includes('export function SaveNoticeDialog('), 'the notice dialog is missing');
  assert(toolbar.includes('Saving publishes a new version'), 'the notice does not say what saving does');
  assert(/earlier versions stay reachable/.test(toolbar), 'the notice should say old versions survive');
  assert(toolbar.includes('tdoc-save-remember'), 'no "don\'t show again" control');
  assert(/localStorage\.setItem\(SAVE_NOTICE_KEY, '1'\)/.test(toolbar), 'the choice is not persisted');
});

t('storage that throws or forgets is read as "not dismissed"', () => {
  const fn = toolbar.slice(toolbar.indexOf('export function saveNoticeDismissed('));
  assert(/try \{[\s\S]*localStorage\.getItem\(SAVE_NOTICE_KEY\) === '1'[\s\S]*\} catch \{\s*return false;/.test(fn),
    'a private-mode throw must not decide the answer');
});

t('Save goes through the notice, and the notice runs the real save', () => {
  assert(shell.includes('onSave={requestSave}'), 'the toolbar still calls save directly');
  assert(/if \(saveNoticeDismissed\(\)\) \{\s*\n\s*editor\.save\(\);/.test(shell),
    'a dismissed notice must not add a click to every save');
  assert(/<SaveNoticeDialog[\s\S]*onConfirm=\{editor\.save\}/.test(shell),
    'confirming the notice must actually save');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
