// Product UI is built from the shared primitives in shell/src/ui/, never
// re-invented per surface (AGENTS.md "Shell / product UI"). This holds the
// rules a reviewer kept having to restate:
//   - no native <select>: the OS draws its open list, so it can never look
//     like tdoc. Use AppSelect (ui/select.jsx).
//   - the Send to agent dialog (document + feedback overlay) and the Agents
//     page pick agents with AppSelect.
// agents-page-ui.test.js checks the rendered result in a browser.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

const ROOT = path.join(__dirname, '..');
function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(rel));
    else if (/\.jsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}
// Internal tooling that is not product UI.
const NATIVE_SELECT_ALLOWED = new Set(['shell/src/onboarding-preview.jsx']);

console.log('UI primitives');

t('no native <select> in product UI (use AppSelect from shell/src/ui/select.jsx)', () => {
  const offenders = [...sources('shell/src'), ...sources('feedback/src')]
    .filter((file) => !NATIVE_SELECT_ALLOWED.has(file))
    .filter((file) => /<select[\s>]/.test(fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\/.*$/gm, '')));
  assert(!offenders.length, `native <select> in: ${offenders.join(', ')}`);
});

t('agent pickers use AppSelect', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shell/src/document/notify-handoff.jsx'), 'utf8');
  assert(/import \{ AppSelect \} from '\.\.\/ui\/select\.jsx'/.test(src), 'notify-handoff.jsx does not import AppSelect');
  assert((src.match(/<AppSelect\b/g) || []).length >= 2, 'the default-agent form and the Send to agent recipient must both be AppSelect');
});

t('AppSelect draws its open list with the menu popup, above dialogs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shell/src/ui/select.jsx'), 'utf8');
  assert(/ui-menu-popup/.test(src) && /ui-menu-item/.test(src), 'AppSelect must reuse the AppMenu popup and rows');
  const css = fs.readFileSync(path.join(ROOT, 'shell/src/ui/ui.css'), 'utf8');
  const z = css.match(/\.ui-select-positioner\s*\{\s*z-index:\s*(\d+)/);
  assert(z && Number(z[1]) > 1000001, 'the select list must stack above dialogs (z-index > 1000001)');
});

t('shared form styles live where every surface loads them', () => {
  // The feedback overlay loads only chrome.css and ui.css.
  const ui = fs.readFileSync(path.join(ROOT, 'shell/src/ui/ui.css'), 'utf8');
  assert(/\.tdoc-conn-pick\s*\{/.test(ui), '.tdoc-conn-pick must be in ui.css, not a page stylesheet');
  const feedback = fs.readFileSync(path.join(ROOT, 'feedback/src/main.jsx'), 'utf8');
  assert(/ui\/ui\.css\?inline/.test(feedback) && /chrome\.css\?inline/.test(feedback), 'feedback overlay stopped loading the shared sheets');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
