// Dark-mode switch contract (overlay.js). #120
//
// One bar button. Preference lives in localStorage after the user switches.
// Default is light, unless the doc declares data-tdoc-default-theme="dark"
// (a dark-first style opening dark before any choice). No prefers-color-scheme
// auto-follow either way.
//
// Run with: node test/dark-mode.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// Theme wiring lives in the shell client; the invert CSS lives in the probe.
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'shell.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'server', 'frame-probe.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'server', 'chrome.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'server', 'chrome.css'), 'utf8');

console.log('dark-mode (#120 bar switch + localStorage)');

t('bar has #tdoc-theme-btn', () => {
  assert(src.includes('id="tdoc-theme-btn"'), 'theme button missing from bar HTML');
});

t('theme is stored under tdoc-theme', () => {
  assert(src.includes("KEY='tdoc-theme'"), 'theme storage key missing');
  assert(src.includes("localStorage.setItem(KEY,dark?'dark':'light')"), 'does not persist on switch');
  assert(src.includes("localStorage.getItem(KEY)==='dark'"), 'does not restore stored theme');
});

t('applies html[data-tdoc-theme]', () => {
  assert(src.includes("setAttribute('data-tdoc-theme', t)"), 'does not set data-tdoc-theme');
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
  // The frame inverts wholesale; media un-inverts via the probe theme CSS.
  assert(/img:not\(\[data-tdoc-dark="invert"\]\)/.test(src),
    'dark CSS must re-invert photos/media back to native colors');
  // Reaction glyphs (chrome.js reactionGlyph): color emoji wrap in .tdoc-emoji
  // so the chrome dark CSS can re-invert them; LGTM stays plain text.
  assert(src.includes('function reactionGlyph'), 'missing glyph helper');
  assert(src.includes('class="tdoc-emoji"'), 'reaction glyphs must wrap in .tdoc-emoji');
  assert(src.includes("QUICK_TEXT_REACTIONS.indexOf(s) >= 0 ? safe"),
    'LGTM must stay text so invert keeps it readable');
  assert(src.includes('reactionGlyph(emoji)'), 'reaction chips must use reactionGlyph');
  assert(src.includes('tdoc-emoji-text'), 'LGTM picker row must stay unwrapped text');
});

t('default is light — dark only if storage says dark or the doc declares it', () => {
  // The shell applies the hint in its tdoc:ready handler (probe reports it).
  const i = src.indexOf("d.defaultTheme === 'dark'");
  assert(i >= 0, 'default-theme hint handling not found');
  const body = src.slice(i - 400, i + 400);
  // A saved choice still wins outright (the hint only applies with no pref).
  assert(/getItem\('tdoc-theme'\)/.test(body) && /!storedTheme/.test(body),
    'a stored dark/light preference must win first');
  // The probe reports the doc-declared default (data-tdoc-default-theme).
  assert(/data-tdoc-default-theme/.test(src),
    'no stored pref → fall back to the doc-declared default theme');
  // The hint never persists a preference.
  assert(!/setItem/.test(body), 'the hint must not persist a preference');
});

t('does not auto-follow the OS theme', () => {
  assert(!src.includes('prefers-color-scheme'), 'must not follow prefers-color-scheme');
});

t('toggle writes storage then paints', () => {
  assert(src.includes('tdoc-theme-btn').valueOf());
  assert(src.includes("wire('#tdoc-theme-btn','click'"), 'no click handler on #tdoc-theme-btn');
  assert(src.includes("localStorage.setItem(KEY,dark?'dark':'light')"), 'click does not persist');
  assert(src.includes("apply(dark?'dark':'light')"), 'click does not paint');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
