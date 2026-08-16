// Dark-mode switch contract (overlay.js). #120
//
// One bar button. Preference lives in localStorage after the user switches.
// Default is light. No prefers-color-scheme auto-follow.
//
// Run with: node test/dark-mode.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'overlay.js'), 'utf8');

console.log('dark-mode (#120 bar switch + localStorage)');

t('bar has #tdoc-theme-btn', () => {
  assert(src.includes('id="tdoc-theme-btn"'), 'theme button missing from bar HTML');
});

t('theme is stored under tdoc-theme', () => {
  assert(src.includes("const THEME_KEY = 'tdoc-theme'"), 'THEME_KEY missing');
  assert(src.includes('localStorage.setItem(THEME_KEY, theme)'), 'does not persist on switch');
  assert(src.includes('localStorage.getItem(THEME_KEY)'), 'does not restore stored theme');
});

t('applies html[data-tdoc-theme]', () => {
  assert(src.includes("setAttribute('data-tdoc-theme', theme)"), 'does not set data-tdoc-theme');
  assert(src.includes('html[data-tdoc-theme="dark"]'), 'no dark CSS');
});

t('dark mode is a page invert, not a per-color palette', () => {
  assert(src.includes('invert(1) hue-rotate(180deg)'), 'missing invert transform');
  assert(!src.includes('--td-ground: #111111'), 'old per-token dark palette came back');
});

t('dark mode keeps form-control labels visible under invert', () => {
  assert(src.includes('color-scheme: dark'), 'html still sets color-scheme dark');
  assert(
    /html\[data-tdoc-theme="dark"\] button[\s\S]*?color-scheme:\s*light/.test(src),
    'buttons must stay color-scheme light so UA does not paint light text on a light chip'
  );
  assert(
    /html\[data-tdoc-theme="dark"\] input[\s\S]*?color-scheme:\s*light/.test(src),
    'inputs must stay color-scheme light too'
  );
});

t('dark mode restores native emoji colors (not inverted)', () => {
  assert(
    /html\[data-tdoc-theme="dark"\][\s\S]*?\.tdoc-emoji/.test(src),
    'dark CSS must re-invert .tdoc-emoji like photos'
  );
  assert(src.includes('function renderReactionGlyph'), 'missing glyph helper');
  assert(src.includes('class="tdoc-emoji"'), 'reaction glyphs must wrap in .tdoc-emoji');
  assert(
    src.includes('if (QUICK_TEXT_REACTIONS.includes(s)) return safe;'),
    'LGTM must stay text so invert keeps it readable'
  );
  assert(
    src.includes('${renderReactionGlyph(emoji)}'),
    'reaction chips must use renderReactionGlyph'
  );
  assert(
    src.includes('QUICK_EMOJIS.map(e => `<button data-emoji="${e}">${renderReactionGlyph(e)}</button>`'),
    'emoji picker buttons must wrap color emoji'
  );
  assert(
    src.includes('QUICK_TEXT_REACTIONS.map(t => `<button class="tdoc-emoji-text" data-emoji="${t}">${t}</button>`'),
    'LGTM picker row must stay unwrapped text'
  );
});

t('default is light — only dark if storage says dark', () => {
  assert(
    /getItem\(THEME_KEY\) === 'dark' \? 'dark' : 'light'/.test(src),
    'readStoredTheme no longer defaults to light'
  );
});

t('does not auto-follow the OS theme', () => {
  assert(!src.includes('prefers-color-scheme'), 'must not follow prefers-color-scheme');
});

t('toggle writes storage then paints', () => {
  assert(src.includes('tdoc-theme-btn').valueOf());
  assert(/tdoc-theme-btn'\)\.onclick/.test(src), 'no click handler on #tdoc-theme-btn');
  assert(src.includes('persistTheme(next)'), 'click does not persist');
  assert(src.includes('paintTheme(next)'), 'click does not paint');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
