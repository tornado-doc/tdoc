// The dark treatment exists twice, and it has to: the chrome lives in the
// shell document and the author content lives in a sandboxed frame, so each
// document needs its own copy of the invert. They are not built from one
// source — server/chrome.css is a stylesheet Vite bundles, and the frame's
// copy is a string frame-probe.js injects — so the only thing keeping them
// together is this test.
//
// They have drifted before: chrome.css restores .tdoc-emoji to true colour and
// the probe's copy does not, which is why a ❤️ in a document goes purple in
// dark mode while the same emoji in the chrome does not.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e.message || e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e); } }

const ROOT = path.join(__dirname, '..');
// One side is a stylesheet, the other is a minified string literal inside a
// JS file, so `filter: invert(…)` and `filter:invert(…)` are the same rule
// written twice. Compare with whitespace removed, or the test passes for the
// wrong reason — as an earlier version of it did, by checking a substring that
// happened to start after the colon.
const squash = (s) => s.replace(/\s+/g, '');
const chrome = squash(fs.readFileSync(path.join(ROOT, 'server', 'chrome.css'), 'utf8'));
const probe = squash(fs.readFileSync(path.join(ROOT, 'server', 'frame-probe.js'), 'utf8'));

console.log('dark-mode invert parity (shell chrome vs author frame)\n');

t('both copies invert the page with the same transform', () => {
  const rule = squash('html[data-tdoc-theme="dark"]{color-scheme:dark;background:#fff;filter:invert(1) hue-rotate(180deg);');
  if (!chrome.includes(rule)) throw new Error('server/chrome.css no longer opens the dark block with the same declarations');
  if (!probe.includes(rule)) throw new Error('frame-probe.js no longer opens the dark block with the same declarations');
});

t('both copies restore the elements that must not read as negatives', () => {
  // A photograph inverted twice is a photograph; inverted once it is a
  // negative. Whatever the chrome restores, the frame has to restore too, or
  // the same element behaves differently depending on which document it is in.
  for (const el of ['img', 'video', 'canvas', 'iframe']) {
    const marker = squash(`${el}:not([data-tdoc-dark="invert"])`);
    if (!chrome.includes(marker)) throw new Error(`chrome.css stopped restoring <${el}>`);
    if (!probe.includes(marker)) throw new Error(`frame-probe.js does not restore <${el}> — it will render as a negative inside the document`);
  }
});

t('both copies keep form controls in the light scheme', () => {
  // Dark UA styles paint light text onto an author light fill, and the invert
  // then makes the label vanish.
  for (const [name, src] of [['chrome.css', chrome], ['frame-probe.js', probe]]) {
    if (!src.includes('color-scheme:light')) {
      throw new Error(`${name} no longer pins form controls to the light scheme`);
    }
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
