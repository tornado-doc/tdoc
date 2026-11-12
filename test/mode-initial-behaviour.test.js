// Behavioural check of the initial-mode decision and the ?edit=1 cleanup:
// the hook's initializer and helpers are evaluated against a fake browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const root = path.join(__dirname, '..');
const hook = fs.readFileSync(path.join(root, 'shell/src/hooks/use-document-editor.js'), 'utf8');
const store = fs.readFileSync(path.join(root, 'shell/src/document/draft-store.js'), 'utf8');

function sliceFn(src, start) {
  const at = src.indexOf(start);
  if (at < 0) throw new Error(`missing ${start}`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2);
}

const initStart = hook.indexOf('useState(() => {', hook.indexOf('const [mode, setMode]'));
const initBody = hook.slice(initStart + 'useState('.length, hook.indexOf('\n  });\n', initStart) + 4);

const program = [
  sliceFn(hook, 'function urlWantsEdit()'),
  sliceFn(hook, 'function dropEditParam()'),
  sliceFn(hook, 'function modeStorageKey(config)'),
  sliceFn(hook, 'function getStoredMode(config)'),
  "const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;",
  sliceFn(store, 'function storageKey(key)'),
  sliceFn(store, 'function readLocalRecord(key)'),
  sliceFn(store, 'function draftBodyExpired(record').replace(/^export /, ''),
  sliceFn(store, 'function hasLocalDraftBody(key').replace(/^export /, ''),
  sliceFn(store, 'function draftKey(config)').replace(/^export /, ''),
  sliceFn(store, 'function legacyDraftKey(config)').replace(/^export /, ''),
  `function initialMode(config) {
     const storeKey = draftKey(config);
     const legacyKey = legacyDraftKey(config);
     return (${initBody})();
   }`,
  'this.initialMode = initialMode; this.dropEditParam = dropEditParam;',
].join('\n');

function browser(href, stored = {}) {
  const data = new Map(Object.entries(stored));
  const url = new URL(href);
  const replaced = [];
  const location = {};
  Object.defineProperty(location, 'href', { get: () => url.href });
  Object.defineProperty(location, 'search', { get: () => url.search });
  const sandbox = {
    URL, URLSearchParams, location,
    localStorage: { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) },
    history: { state: null, replaceState: (s, _t, next) => { replaced.push(next); const n = new URL(next, url.origin); url.search = n.search; url.hash = n.hash; url.pathname = n.pathname; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(program, sandbox);
  return { sandbox, url, replaced };
}

const editor = { slug: 'plan', version: 3, canEdit: true, canComment: true, identity: { login: 'julie' } };

console.log('initial mode and ?edit=1 cleanup');

t('a stored Edit opens Comment, not Edit', () => {
  const { sandbox } = browser('https://tdoc.dev/d/plan/v/3', { 'tdoc-mode:plan:julie': 'edit' });
  assert(sandbox.initialMode(editor) === 'comment', `got ${sandbox.initialMode(editor)}`);
});

t('a stored Edit opens Read for a reader who cannot comment', () => {
  const { sandbox } = browser('https://tdoc.dev/d/plan/v/3', { 'tdoc-mode:plan:julie': 'edit' });
  const mode = sandbox.initialMode({ ...editor, canComment: false });
  assert(mode === 'read', `got ${mode}`);
});

t('a stored Read or Comment is still restored', () => {
  const r = browser('https://tdoc.dev/d/plan/v/3', { 'tdoc-mode:plan:julie': 'read' });
  assert(r.sandbox.initialMode(editor) === 'read', 'read not restored');
  const c = browser('https://tdoc.dev/d/plan/v/3', { 'tdoc-mode:plan:julie': 'comment' });
  assert(c.sandbox.initialMode(editor) === 'comment', 'comment not restored');
});

t('a stored Edit with an unsaved draft still reopens Edit (draft recovery)', () => {
  const draft = JSON.stringify({ bodyHtml: '<p>wip</p>', bodyUpdatedAt: Date.now(), updatedAt: Date.now() });
  const { sandbox } = browser('https://tdoc.dev/d/plan/v/3', { 'tdoc-mode:plan:julie': 'edit', 'tdoc-draft:plan:julie': draft });
  assert(sandbox.initialMode(editor) === 'edit', `got ${sandbox.initialMode(editor)}`);
});

t('an expired draft does not bring Edit back', () => {
  const old = Date.now() - 31 * 24 * 3600_000;
  const draft = JSON.stringify({ bodyHtml: '<p>wip</p>', bodyUpdatedAt: old, updatedAt: old });
  const { sandbox } = browser('https://tdoc.dev/d/plan/v/3', { 'tdoc-mode:plan:julie': 'edit', 'tdoc-draft:plan:julie': draft });
  assert(sandbox.initialMode(editor) === 'comment', `got ${sandbox.initialMode(editor)}`);
});

t('?edit=1 opens Edit, and is then removed keeping other params and the hash', () => {
  const { sandbox, url, replaced } = browser('https://tdoc.dev/d/plan/v/1?edit=1&x=2#h-intro');
  assert(sandbox.initialMode(editor) === 'edit', 'should open Edit');
  sandbox.dropEditParam();
  assert(replaced.length === 1, 'replaceState not called once');
  assert(url.href === 'https://tdoc.dev/d/plan/v/1?x=2#h-intro', `got ${url.href}`);
  // A reload of the cleaned URL is a normal visit.
  assert(sandbox.initialMode(editor) === 'comment', 'reload must not reopen Edit');
});

t('?edit=1 without edit rights does not open Edit', () => {
  const { sandbox } = browser('https://tdoc.dev/d/plan/v/1?edit=1');
  assert(sandbox.initialMode({ ...editor, canEdit: false }) === 'comment', 'reader got Edit');
});

t('a URL without edit is left alone', () => {
  const { sandbox, replaced } = browser('https://tdoc.dev/d/plan/v/1?x=2');
  sandbox.dropEditParam();
  assert(replaced.length === 0, 'replaceState must not run');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
