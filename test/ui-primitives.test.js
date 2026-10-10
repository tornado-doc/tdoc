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

t('agent pickers are searchable (AppCombobox)', () => {
  // A Raft server lists dozens of agents; Julie (2026-10-06): the picker is a
  // search box you can type in, not a list to scroll.
  const src = fs.readFileSync(path.join(ROOT, 'shell/src/document/notify-handoff.jsx'), 'utf8');
  assert(/import \{ AppCombobox \} from '\.\.\/ui\/combobox\.jsx'/.test(src), 'notify-handoff.jsx does not import AppCombobox');
  assert((src.match(/<AppCombobox\b/g) || []).length >= 2, 'the default-agent form and the Send to agent recipient must both be AppCombobox');
  const combo = fs.readFileSync(path.join(ROOT, 'shell/src/ui/combobox.jsx'), 'utf8');
  assert(/ui-menu-popup/.test(combo) && /ui-select-positioner/.test(combo) && /tdoc-select/.test(combo),
    'AppCombobox must look like AppSelect closed and open the same menu popup above dialogs');
});

t('spaces are visible pills above the title, not a dropdown hidden in it', () => {
  // Julie, 2026-10-10: a first-time person does not find their team behind a
  // title that is secretly a menu.
  const hub = fs.readFileSync(path.join(ROOT, 'shell/src/docs-hub.jsx'), 'utf8');
  assert(/<SpaceBar\b/.test(hub) && !/SpaceSwitcher/.test(hub), 'My docs must render SpaceBar');
  assert(/<h1>\{team \? team\.name : 'My docs'\}<\/h1>/.test(hub), 'the title is plain text again');
  const teams = fs.readFileSync(path.join(ROOT, 'shell/src/docs-hub/teams.jsx'), 'utf8');
  assert(/role="tablist"/.test(teams) && /New team/.test(teams), 'every space and New team are in view');
});

t('AppSelect draws its open list with the menu popup, above dialogs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'shell/src/ui/select.jsx'), 'utf8');
  assert(/ui-menu-popup/.test(src) && /ui-menu-item/.test(src), 'AppSelect must reuse the AppMenu popup and rows');
  const css = fs.readFileSync(path.join(ROOT, 'shell/src/ui/ui.css'), 'utf8');
  const z = css.match(/\.ui-select-positioner\s*\{\s*z-index:\s*(\d+)/);
  assert(z && Number(z[1]) > 1000001, 'the select list must stack above dialogs (z-index > 1000001)');
});

t('no `font: <size>/<lh> inherit` shorthand in shared sheets (it is invalid, so the whole rule is dropped)', () => {
  // `inherit` cannot stand in for the family inside the shorthand; browsers
  // discard the declaration and the control falls back to the UA font.
  for (const file of ['shell/src/ui/ui.css', 'shell/src/docs-hub.css']) {
    const bad = fs.readFileSync(path.join(ROOT, file), 'utf8').match(/font:\s*[^;]*\/[^;]*\binherit\s*;/g);
    assert(!bad, `${file}: ${bad && bad.join(' | ')} — write font-family: inherit plus size/weight/line-height`);
  }
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
