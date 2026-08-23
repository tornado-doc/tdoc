// The browser bundles must actually parse.
//
// Learned the hard way: a backtick inside a CSS comment in overlay.js closed
// the template literal holding the entire stylesheet, and the file stopped
// being valid JavaScript. Every other suite reads these files as TEXT — they
// grep them for selectors and function names — so all 35 stayed green while
// the overlay was dead on arrival in the browser, taking the bar, dark mode,
// commenting and sign-in with it. It shipped to production.
//
// A syntax check is cheap and catches the whole class.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }

const root = path.join(__dirname, '..');
console.log('browser bundles parse');

// Everything the worker injects into a page.
for (const rel of ['server/overlay.js', 'server/chrome.js', 'server/frame-probe.js', 'server/onboard.js', 'server/signin.js']) {
  t(`${rel} is valid JavaScript`, () => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    // Compile without running: catches syntax errors, touches no globals.
    new vm.Script(src, { filename: rel });
  });
}

// The worker is an ES module, and vm.SourceTextModule needs a flag the test
// runner does not pass. Neutralise the one piece of module syntax it uses and
// parse the rest as a script — an unbalanced literal anywhere in the file
// still fails, which is the whole point.
const asScript = (src) => src
  .replace(/^export default /gm, 'const __default = ')
  .replace(/^export (class|function|const|let|var) /gm, '$1 ');

t('worker/worker.js is valid JavaScript', () => {
  const src = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
  new vm.Script(asScript(src), { filename: 'worker/worker.js' });
});

t('the bundled worker is valid JavaScript', () => {
  const bundled = path.join(root, 'worker', '_worker.bundled.js');
  if (!fs.existsSync(bundled)) {
    console.log('    (no bundle on disk; run bin/tdoc-bundle to check it too)');
    return;
  }
  // The bundle inlines the three files above as string literals. If one of
  // them was unbalanced, the bundle is where it detonates.
  new vm.Script(asScript(fs.readFileSync(bundled, 'utf8')), { filename: '_worker.bundled.js' });
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
