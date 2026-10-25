// One header everywhere (Julie, 2026-10-24: /feedback had no avatar in the
// top right; pages did not use the same header component). Source rules that
// keep it that way:
//   - every page the worker boots as an app page is one main.jsx renders,
//     and every one of them (but the design preview) renders the shared
//     <TopBar>, so the logo, the avatar and the account menu are one piece
//     of code;
//   - the avatar chip lives in top-bar.jsx and nowhere else;
//   - the worker draws no header of its own (the /feedback pages used to).
// Run with: node test/app-header.test.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'shell', 'src');
const read = (p) => fs.readFileSync(p, 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

console.log('app header: one TopBar on every app page');

const main = read(path.join(SRC, 'main.jsx'));
const worker = read(path.join(ROOT, 'worker', 'worker.js'));

// page name -> component, from the router in main.jsx
const routes = new Map();
for (const m of main.matchAll(/appBoot\.page === '([a-z-]+)'\) page = (?:<Suspense[^>]*>)?(?:<>)?<([A-Z][A-Za-z]+)/g)) routes.set(m[1], m[2]);
// The fall-through is the neutral landing.
const fallback = /\n  else page = <([A-Z][A-Za-z]+)/.exec(main);
if (fallback) routes.set('neutral-landing', fallback[1]);
// component -> file, from main.jsx's imports
const files = new Map();
for (const m of main.matchAll(/import \{ ([A-Za-z, ]+) \} from '\.\/([a-z-]+\.jsx)'/g)) {
  for (const name of m[1].split(',').map((s) => s.trim())) files.set(name, m[2]);
}
// Design review only: no session, no account.
const NO_BAR = new Set(['onboarding-preview']);

t('every page the worker boots is one main.jsx routes', () => {
  const booted = new Set([...worker.matchAll(/page: '([a-z-]+)'/g)].map((m) => m[1]));
  assert(booted.size >= 10 && routes.size >= 12, `only found ${booted.size} worker pages, ${routes.size} routes`);
  const missing = [...booted].filter((p) => !routes.has(p));
  assert(!missing.length, `worker boots pages main.jsx does not route (they would fall through to the neutral landing): ${missing.join(', ')}`);
});

t('every routed app page renders the shared TopBar', () => {
  const without = [];
  for (const [page, component] of routes) {
    if (NO_BAR.has(page)) continue;
    const file = files.get(component);
    assert(file, `no import found for ${component}`);
    const src = read(path.join(SRC, file));
    if (!/import \{ TopBar \} from '\.\/top-bar\.jsx'/.test(src) || !/<TopBar\b/.test(src)) without.push(`${page} (${file})`);
  }
  assert(!without.length, `app pages without the shared top bar: ${without.join(', ')}`);
});

t('the avatar chip and account menu exist only in top-bar.jsx', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(jsx?|css)$/.test(entry.name) && entry.name !== 'top-bar.jsx' && /className="[^"]*tdoc-account-trigger/.test(read(p))) offenders.push(path.relative(SRC, p));
    }
  };
  walk(SRC);
  assert(!offenders.length, `a second account chip: ${offenders.join(', ')}`);
});

t('the worker draws no header of its own', () => {
  assert(!/<header\b/.test(worker), 'worker.js renders a <header>');
  assert(!/fb-bar|feedbackTopBar/.test(worker), 'the /feedback hand-rolled bar is back');
});

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
