// AGENTS.md is the durable product rule for agents (auto-loaded by agent hosts).
// Keep it short; do not reintroduce ARCHITECTURE.md as a second source of truth.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const expected =
  'Remote storage is source of truth. Local HTML is disposable. Local skill is authoring/scaffold.\n' +
  'Published reader invariants are provider-enforced in overlay/worker code and tests, not left only to author HTML or prompts.\n';

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

console.log('agents.md source-of-truth rule');

t('AGENTS.md exists and is exactly the short source-of-truth rule', () => {
  const body = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert(body === expected, `AGENTS.md must be exactly the guarded short rule.\nGot:\n${JSON.stringify(body)}`);
});

t('AGENT.md (singular) is not used — hosts auto-read AGENTS.md', () => {
  assert(!fs.existsSync(path.join(root, 'AGENT.md')), 'use AGENTS.md not AGENT.md');
});

t('ARCHITECTURE.md is removed (no second architecture doc)', () => {
  assert(!fs.existsSync(path.join(root, 'ARCHITECTURE.md')), 'ARCHITECTURE.md must not exist');
});

t('README does not link to ARCHITECTURE.md and points at AGENTS.md', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert(!readme.includes('ARCHITECTURE.md'), 'README still references ARCHITECTURE.md');
  assert(readme.includes('AGENTS.md'), 'README should point agents at AGENTS.md');
});

t('SKILL.md retains author HTML + access policy contracts', () => {
  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  assert(skill.includes('Author HTML compatibility contract'), 'missing author HTML contract in SKILL.md');
  assert(skill.includes('Access policy (published docs'), 'missing access policy contract in SKILL.md');
  assert(skill.includes(':where()'), 'author-wins :where() invariant missing from SKILL.md');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
