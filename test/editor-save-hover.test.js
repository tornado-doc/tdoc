// A button must never paint its background the same colour as its text.
//
// The editor toolbar's ghost buttons go white on hover, which is right: they
// sit on a tinted bar and carry dark text. `.primary` — Save — carries WHITE
// text, and the generic hover outranks it by two pseudo-classes, so hovering
// Save painted it white on white and the control vanished under the cursor.
//
// Grepping for a selector cannot catch that: both rules existed and both were
// correct in isolation. This resolves the cascade the way a browser does —
// specificity first, source order to break a tie — and asserts the invariant
// the bug violated. Same approach as bar-overflow-trigger.test.js, for the
// same class of bug.
//
// Run with: node test/editor-save-hover.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ROOT = path.join(__dirname, '..');
// Comments carry no braces, so the rule scanner below would glue one onto the
// selector that follows it.
const css = fs.readFileSync(path.join(ROOT, 'shell', 'src', 'shell.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ');

function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?![\w-]*\()|:not\([^)]*\)/g) || []).length;
  const types = (selector.replace(/[.#][\w-]+|\[[^\]]+\]|:[\w-]+(\([^)]*\))?/g, '').match(/[a-zA-Z][\w-]*/g) || []).length;
  return [ids, classes, types];
}

function beatsOrTies(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true; // a tie goes to the later rule, and we walk in source order
}

// Every top-level rule, in source order. @media blocks are skipped: this
// button's colours are not width-dependent, and a rule inside one would only
// apply at a width the toolbar is not being asked about here.
function rules() {
  const out = [];
  const noMedia = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ' ');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(noMedia))) {
    const decls = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    for (const sel of m[1].split(',')) out.push({ selector: sel.trim(), decls });
  }
  return out;
}

// The element under test, as editor-toolbar.jsx renders it:
//   .tdoc-editor-toolbar > .tdoc-editor-commit > button.primary   (hovered, enabled)
const ANCESTORS = ['tdoc-editor-toolbar', 'tdoc-editor-commit'];
function matchesHoveredSave(selector) {
  const parts = selector.split(/\s+/).filter(Boolean);
  const target = parts[parts.length - 1];
  if (!/^button/.test(target) && !/^\.primary/.test(target)) return false;
  const classes = (target.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
  if (!classes.every((c) => c === 'primary')) return false;          // not some other button
  // Strip :not(...) first, or `:not(:disabled)` reads as the disabled state
  // and the rule that fixes the bug is the one the test throws away.
  const state = target.replace(/:not\([^)]*\)/g, '');
  if (/:disabled|:active|:focus/.test(state)) return false;            // a different state
  return parts.slice(0, -1).every((part) => (
    (part.match(/\.[\w-]+/g) || []).every((c) => ANCESTORS.includes(c.slice(1)))
  ));
}

// Resolve one property for the hovered Save button.
function resolve(prop) {
  let winner = null;
  for (const rule of rules()) {
    if (!matchesHoveredSave(rule.selector)) continue;
    if (!(prop in rule.decls)) continue;
    const spec = specificity(rule.selector);
    if (!winner || beatsOrTies(spec, winner.spec)) winner = { spec, value: rule.decls[prop], selector: rule.selector };
  }
  return winner;
}

console.log('editor Save button — hover');

t('the toolbar still has a generic hover and a primary button [test is looking at the right file]', () => {
  const all = rules().map((r) => r.selector);
  assert(all.some((s) => /\.tdoc-editor-toolbar button:hover/.test(s)), 'the generic hover rule is gone — retarget this test');
  assert(all.some((s) => /\.tdoc-editor-toolbar button\.primary(?!:)/.test(s)), 'the primary button rule is gone — retarget this test');
});

t('hovering Save does not paint it the colour of its own label [the bug]', () => {
  const bg = resolve('background') || resolve('background-color');
  const fg = resolve('color');
  assert(bg, 'nothing sets a background on the hovered Save button');
  assert(fg, 'nothing sets a colour on the hovered Save button');
  assert(bg.value !== fg.value,
    `hovered Save resolves to background ${bg.value} on text ${fg.value} — an invisible button.\n`
    + `      background from: ${bg.selector}\n      color from:      ${fg.selector}`);
});

t('the hover that wins is the primary button’s own, not the ghost buttons’', () => {
  const bg = resolve('background') || resolve('background-color');
  assert(/\.primary/.test(bg.selector),
    `the winning background comes from "${bg.selector}", which does not name .primary — `
    + 'the generic hover is outranking the primary button again');
  assert(/hover/.test(bg.selector), `the winning background is not a hover rule: "${bg.selector}"`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
