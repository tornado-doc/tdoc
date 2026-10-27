const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const root = path.join(__dirname, '..');
const editorHook = fs.readFileSync(path.join(root, 'shell/src/hooks/use-document-editor.js'), 'utf8');

console.log('mode persistence (localStorage)');

t('mode storage key and helpers exist', () => {
  assert(editorHook.includes('tdoc-mode:${config.slug}:${config.identity?.login'), 'mode must be keyed by document and viewer');
  assert(editorHook.includes('function getStoredMode(config)'), 'getStoredMode helper missing');
  assert(editorHook.includes('function storeMode(config, mode)'), 'storeMode helper missing');
  assert(!editorHook.includes("localStorage.getItem('tdoc-mode')"), 'old global mode must not affect another document');
});

t('getStoredMode is wrapped in try/catch for privacy mode', () => {
  const fnStart = editorHook.indexOf('function getStoredMode(config)');
  const fnEnd = editorHook.indexOf('function storeMode(', fnStart);
  const fn = editorHook.slice(fnStart, fnEnd);
  assert(/try \{[\s\S]*localStorage\.getItem\(modeStorageKey\(config\)\)[\s\S]*\} catch/.test(fn),
    'getStoredMode must catch localStorage throws in privacy mode');
  assert(fn.includes('return null'), 'getStoredMode must return null on error');
});

t('storeMode is wrapped in try/catch for privacy mode', () => {
  const fnStart = editorHook.indexOf('function storeMode(config, mode)');
  const fnEnd = editorHook.indexOf('export function useDocumentEditor', fnStart);
  const fn = editorHook.slice(fnStart, fnEnd);
  assert(/try \{[\s\S]*localStorage\.setItem\(modeStorageKey\(config\), mode\)[\s\S]*\} catch/.test(fn),
    'storeMode must catch localStorage throws in privacy mode');
});

t('URL ?edit=1 takes precedence over stored mode', () => {
  const modeInit = editorHook.slice(
    editorHook.indexOf('const [mode, setMode] = useState'),
    editorHook.indexOf('const [dirty, setDirty]')
  );
  const editUrlIndex = modeInit.indexOf("get('edit') === '1'");
  const storedIndex = modeInit.indexOf('getStoredMode(config)');
  assert(editUrlIndex >= 0 && storedIndex >= 0, 'both URL check and stored check must exist');
  assert(editUrlIndex < storedIndex, '?edit=1 must be checked before stored mode');
});

t('stored edit mode requires canEdit permission', () => {
  assert(/stored === 'edit' && config\.canEdit/.test(editorHook),
    'stored edit mode must be gated on canEdit');
});

t('stored comment mode requires canComment permission', () => {
  assert(/stored === 'comment' && \(config\.canComment \|\| config\.signInToComment\)/.test(editorHook),
    'stored comment mode must be gated on canComment');
});

t('stored read mode remains Read for a reader who can comment', () => {
  assert(/if \(stored === 'read'\) return 'read'/.test(editorHook),
    'Read preference should remain available when Comment also allows copy');
});

t('mode is persisted on change via storeMode', () => {
  const changeModeStart = editorHook.indexOf('const changeMode = useCallback');
  const changeModeEnd = editorHook.indexOf('const requestDocument = useCallback');
  const changeMode = editorHook.slice(changeModeStart, changeModeEnd);
  assert(changeMode.includes('setMode(nextMode)'), 'changeMode must call setMode');
  assert(changeMode.includes('storeMode(config, nextMode)'), 'changeMode must persist mode to localStorage');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
