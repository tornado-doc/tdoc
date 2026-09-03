// Where the comment composer goes when a phone keyboard is up.
//
// A keyboard does two things: it SHRINKS the visual viewport and it SHIFTS it,
// so the visible band no longer starts at y=0. Reading only the shrink put the
// card at a coordinate still inside the layout viewport and no longer inside
// the part you can see — on a phone that reads as the card flying off, and it
// shipped that way once because the check only ever moved the height.
//
// Pure arithmetic, so the keyboard cases are asserted here rather than staged
// in a headless browser that has no keyboard.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'shell/src/document/comment-composer.jsx'), 'utf8');
const model = fs.readFileSync(path.join(root, 'shell/src/document/model.js'), 'utf8');

function grab(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`${name} not found`);
  let i = source.indexOf('{', at), depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (!depth) { i++; break; } }
  }
  return source.slice(at, i);
}

const box = {};
vm.createContext(box);
// `const` inside a vm context does not attach to the context object — only
// function declarations and `var` do — so the constants come across as `var`.
vm.runInContext([
  /const TOP_BAR_HEIGHT = [^;]+;/.exec(model)[0].replace('const', 'var'),
  /const COMPOSER_WIDTH = [^;]+;/.exec(src)[0].replace('const', 'var'),
  /const COMPOSER_HEIGHT = [^;]+;/.exec(src)[0].replace('const', 'var'),
  grab(src, 'composerPosition'),
].join('\n'), box);

const { composerPosition, COMPOSER_HEIGHT } = box;
const within = (pos, viewport) => {
  const top = viewport.offsetTop || 0;
  return pos.top >= top && pos.top + COMPOSER_HEIGHT <= top + viewport.height;
};

console.log('the composer stays in the band the keyboard leaves visible');

const phone = { width: 390, height: 664, offsetTop: 0, offsetLeft: 0 };
const selection = { top: 300, bottom: 320, left: 20 };

t('with no keyboard it sits under the selection', () => {
  const pos = composerPosition(selection, phone);
  assert(pos.top > 320, `expected below the quote, got ${pos.top}`);
  assert(within(pos, phone), 'off screen with no keyboard at all');
});

t('a keyboard that only shrinks the viewport keeps it visible', () => {
  const kb = { ...phone, height: 340 };
  assert(within(composerPosition(selection, kb), kb), 'card left the shrunken viewport');
});

t('a keyboard that also SHIFTS the viewport keeps it visible', () => {
  // The case that shipped broken: height alone was handled, offsetTop was not.
  const kb = { ...phone, height: 340, offsetTop: 90 };
  const pos = composerPosition(selection, kb);
  assert(within(pos, kb), `card at ${pos.top}..${pos.top + COMPOSER_HEIGHT} is outside ${kb.offsetTop}..${kb.offsetTop + kb.height}`);
});

t('it follows the band as the page is pushed further up', () => {
  const first = composerPosition(selection, { ...phone, height: 340, offsetTop: 90 });
  const second = composerPosition(selection, { ...phone, height: 340, offsetTop: 180 });
  assert(second.top > first.top, 'the card did not move with the viewport');
  assert(within(second, { ...phone, height: 340, offsetTop: 180 }), 'card fell out of the shifted band');
});

t('a band shorter than the card still starts inside it', () => {
  const cramped = { ...phone, height: 150, offsetTop: 120 };
  const pos = composerPosition(selection, cramped);
  assert(pos.top >= cramped.offsetTop, `card started above the band at ${pos.top}`);
});

t('it never runs off the right edge, shifted or not', () => {
  const wide = composerPosition({ ...selection, left: 9999 }, phone);
  assert(wide.left + 320 <= phone.width - 4, `card ran past the right edge at ${wide.left}`);
  const shifted = { ...phone, offsetLeft: 40 };
  const pos = composerPosition({ ...selection, left: 9999 }, shifted);
  assert(pos.left + 320 <= shifted.offsetLeft + shifted.width - 4, 'card ran past the shifted right edge');
});

t('the shipped formula really did miss this — guards the diagnosis', () => {
  // What #414 shipped: height was read, offsetTop was not. Kept here so the
  // failure this file exists for stays legible, and so a future simplification
  // that quietly drops offsetTop trips something.
  const shipped = (rect, viewport) => {
    let top = box.TOP_BAR_HEIGHT + (rect.bottom || 0) + 8;
    if (top + COMPOSER_HEIGHT > viewport.height - 8) {
      top = Math.max(box.TOP_BAR_HEIGHT + 4, box.TOP_BAR_HEIGHT + (rect.top || 0) - COMPOSER_HEIGHT - 8);
    }
    return { top: Math.min(top, Math.max(box.TOP_BAR_HEIGHT + 4, viewport.height - COMPOSER_HEIGHT - 8)) };
  };
  // A selection low enough that the card is placed ABOVE it, where the old
  // floor was TOP_BAR_HEIGHT + 4 — a coordinate that sits above a band the
  // keyboard has pushed down to 90. This is the shape seen in the browser:
  // card at 79..234 while only 90..430 was on screen.
  const low = { top: 100, bottom: 300, left: 20 };
  const kb = { ...phone, height: 340, offsetTop: 90 };
  assert(!within(shipped(low, kb), kb),
    'the old formula now passes the shifted-viewport case; this guard is stale');
  assert(within(composerPosition(low, kb), kb), 'the current formula regressed');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
