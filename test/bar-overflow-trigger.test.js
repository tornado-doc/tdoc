// The ⋯ overflow trigger must not open an empty menu.
//
// Every item inside the top bar's ⋯ menu that the shell itself contributes is
// `.tdoc-mobile-overflow-only` — hidden above 700px. A page that passes no
// `overflowActions` (the Docs Hub, the landing) therefore has NOTHING to show
// in that menu at desktop width, and top-bar.jsx marks its trigger
// `tdoc-mobile-overflow-trigger` so chrome.css can hide it there.
//
// That hide was silently losing the cascade: `.tdoc-bar .tdoc-secondary-toggle
// { display: inline-flex }` sits later in chrome.css at the SAME specificity,
// so the button stayed visible and clicking it opened a 170x10 empty white
// sliver. This suite resolves the cascade the way a browser would, instead of
// grepping for a selector string.
//
// Run with: node test/bar-overflow-trigger.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ROOT = path.join(__dirname, '..');
// Comments are stripped first: they contain no braces, so the naive rule
// scanner below would otherwise glue a preceding comment onto a selector.
const css = fs.readFileSync(path.join(ROOT, 'server', 'chrome.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ');
const topBar = fs.readFileSync(path.join(ROOT, 'shell', 'src', 'top-bar.jsx'), 'utf8');

// The element under test: the ⋯ button as top-bar.jsx renders it on a page
// with no desktop overflow actions.
const TRIGGER = ['tdoc-secondary-toggle', 'tdoc-mobile-overflow-trigger'];
const ANCESTORS = ['tdoc-bar', 'tdoc-bar-right'];

// (a, b, c) specificity of a compound/descendant selector built from classes,
// ids and element names — enough for the selectors chrome.css uses here.
function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+(?![\w-]*\()/g) || []).length;
  const types = (selector.replace(/[.#][\w-]+|\[[^\]]+\]|:[\w-]+/g, '').match(/[a-zA-Z][\w-]*/g) || []).length;
  return [ids, classes, types];
}

function beats(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true; // equal specificity → later rule wins, and we walk in order
}

// True when `selector` (a descendant chain of simple compounds) matches the
// trigger element sitting inside ANCESTORS.
function matchesTrigger(selector) {
  const parts = selector.trim().split(/\s+/);
  const target = parts[parts.length - 1];
  const targetClasses = (target.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
  if (!targetClasses.length) return false;
  if (target.includes('#') || target.includes(':') || target.includes('[')) return false;
  if (!targetClasses.every((c) => TRIGGER.includes(c))) return false;
  return parts.slice(0, -1).every((part) => (
    (part.match(/\.[\w-]+/g) || []).every((c) => ANCESTORS.includes(c.slice(1)))
  ));
}

// Resolve `display` for the trigger at a given viewport width, walking the
// stylesheet in source order and keeping the winner.
function resolveDisplay(width) {
  let winner = null;
  const blocks = [];
  // Top level plus each @media block, tagged with the width it applies at.
  const mediaRe = /@media\s*\(([^)]+)\)\s*\{/g;
  let cursor = 0;
  let m;
  while ((m = mediaRe.exec(css))) {
    blocks.push({ css: css.slice(cursor, m.index), applies: true });
    // Find this media block's matching close brace.
    let depth = 1;
    let i = mediaRe.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    const query = m[1].trim();
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const applies = (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
    blocks.push({ css: css.slice(mediaRe.lastIndex, i - 1), applies });
    cursor = i;
    mediaRe.lastIndex = i;
  }
  blocks.push({ css: css.slice(cursor), applies: true });

  for (const block of blocks) {
    if (!block.applies) continue;
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let rule;
    while ((rule = ruleRe.exec(block.css))) {
      const decls = rule[2];
      const display = /(?:^|;)\s*display\s*:\s*([^;!]+)/.exec(decls);
      if (!display) continue;
      const important = /display\s*:[^;]*!important/.test(decls);
      for (const selector of rule[1].split(',')) {
        if (!matchesTrigger(selector)) continue;
        const spec = specificity(selector);
        if (!winner
          || (important && !winner.important)
          || ((important === winner.important) && beats(spec, winner.spec))) {
          winner = { value: display[1].trim(), spec, important, selector: selector.trim() };
        }
      }
    }
  }
  return winner;
}

console.log('bar overflow trigger (the ⋯ never opens an empty menu)');

t('top-bar marks the trigger mobile-only exactly when it has no desktop actions', () => {
  assert(topBar.includes("overflowActions ? '' : ' tdoc-mobile-overflow-trigger'"),
    'the ⋯ trigger no longer opts into the mobile-only class when overflowActions is absent');
});

t('a trigger with no desktop actions is hidden above the 700px breakpoint', () => {
  for (const width of [701, 900, 1200, 1600]) {
    const winner = resolveDisplay(width);
    assert(winner, `no display rule resolved for the ⋯ trigger at ${width}px`);
    assert(winner.value === 'none',
      `at ${width}px the ⋯ trigger resolves to display:${winner.value} via \`${winner.selector}\` — `
      + 'it would open a menu whose every item is .tdoc-mobile-overflow-only');
  }
});

t('the same trigger is still shown at mobile widths', () => {
  for (const width of [320, 430, 700]) {
    const winner = resolveDisplay(width);
    assert(winner, `no display rule resolved for the ⋯ trigger at ${width}px`);
    assert(winner.value !== 'none',
      `at ${width}px the ⋯ trigger resolves to display:none via \`${winner.selector}\` — `
      + 'the mobile overflow menu is the only home for theme / notifications / sign-out');
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
