// AGENT.md is the durable product rule for agents. Keep it one line; do not
// reintroduce ARCHITECTURE.md as a second source of truth.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const expected =
  'Remote storage is source of truth. Local HTML is disposable. Local skill is authoring/scaffold.\n';

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

console.log('agent.md source-of-truth rule');

t('AGENT.md exists and is exactly the one-line rule', () => {
  const body = fs.readFileSync(path.join(root, 'AGENT.md'), 'utf8');
  assert(body === expected, `AGENT.md must be exactly one line + newline.\nGot:\n${JSON.stringify(body)}`);
});

t('ARCHITECTURE.md is removed (no second architecture doc)', () => {
  assert(!fs.existsSync(path.join(root, 'ARCHITECTURE.md')), 'ARCHITECTURE.md must not exist');
});

t('README does not link to ARCHITECTURE.md', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert(!readme.includes('ARCHITECTURE.md'), 'README still references ARCHITECTURE.md');
  assert(readme.includes('AGENT.md'), 'README should point agents at AGENT.md');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
