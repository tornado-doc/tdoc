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

t('one space switcher: in the top bar, on every page; no second set of pills', () => {
  // Julie, 2026-10-16: switch workspace from the top-right like Notion. The
  // pill row it replaced (2026-10-10) must not come back beside it.
  const hub = fs.readFileSync(path.join(ROOT, 'shell/src/docs-hub.jsx'), 'utf8');
  assert(!/<SpaceBar\b/.test(hub), 'My docs renders the old pill row again');
  assert(/onSpace=\{pickSpace\}/.test(hub), 'My docs does not hand the top-bar switcher its space');
  assert(/<h1>\{team \? team\.name : 'My docs'\}<\/h1>/.test(hub), 'the title is plain text, not a menu');
  const bar = fs.readFileSync(path.join(ROOT, 'shell/src/top-bar.jsx'), 'utf8');
  assert(/<WorkspaceSwitcher\b/.test(bar), 'the top bar has no workspace switcher');
  const sw = fs.readFileSync(path.join(ROOT, 'shell/src/workspace-switcher.jsx'), 'utf8');
  assert(/AppMenu/.test(sw) && /New team/.test(sw), 'the switcher must be an AppMenu ending in New team');
  const teams = fs.readFileSync(path.join(ROOT, 'shell/src/docs-hub/teams.jsx'), 'utf8');
  assert(!/function SpaceBar|className="tm-spaces"/.test(teams), 'the old pill switcher implementation still exists');
  const doc = fs.readFileSync(path.join(ROOT, 'shell/src/document-shell.jsx'), 'utf8');
  assert(/space=\{config\.teamManage\?\.team\?\.id \|\| ''\}/.test(doc), 'a team document does not identify its current workspace');
});

t('a multi-selection can move to a team, only the author\'s own docs, saying what it skipped', () => {
  // Julie, 2026-10-11: Move to team existed only per row.
  const hub = fs.readFileSync(path.join(ROOT, 'shell/src/docs-hub.jsx'), 'utf8');
  assert(/batch-move-team/.test(hub) && /movableToTeam = selectedDocs\.filter\(\(doc\) => doc\.mine\)/.test(hub), 'batch Move to team missing or not limited to own docs');
  assert(/skipped=\{modal\.skipped \|\| 0\}/.test(hub), 'skipped docs are not reported');
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

t('advanced connector setup stays behind progressive disclosure', () => {
  // The agent prompts are long operational instructions. Settings should lead
  // with the normal product action and reveal raw commands only on request.
  const src = fs.readFileSync(path.join(ROOT, 'shell/src/connectors-page.jsx'), 'utf8');
  assert(!/<details className="tdoc-conn-alt" open>/.test(src), 'connector setup prompts expanded by default');
  assert((src.match(/<details className="tdoc-conn-alt">/g) || []).length >= 3, 'connector advanced details are missing');
});

t('document owners can move the open doc between workspaces', () => {
  const toolbar = fs.readFileSync(path.join(ROOT, 'shell/src/document/document-toolbar.jsx'), 'utf8');
  assert(/data-action="move-document"/.test(toolbar) && /Move document…/.test(toolbar), 'document More menu has no move action');
  const shell = fs.readFileSync(path.join(ROOT, 'shell/src/document-shell.jsx'), 'utf8');
  assert(/config\.mode === 'published' && config\.isOwner \? openMoveDocument : null/.test(shell), 'move action is not limited to the published doc owner');
  assert(/await moveDocsToTeam\(\[config\.slug\], target\.id\)/.test(shell), 'move action does not call the shared workspace move API');
  assert(/includePersonal=\{Boolean\(config\.teamManage\?\.team\?\.id\)\}/.test(shell), 'team docs cannot return to My docs');
  const teams = fs.readFileSync(path.join(ROOT, 'shell/src/docs-hub/teams.jsx'), 'utf8');
  assert(/team\.id !== currentTeam/.test(teams), 'move dialog does not hide the current workspace');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
