// AGENTS.md is the durable product rule for agents (auto-loaded by agent hosts).
// It is NOT frozen byte-for-byte: intentional, human-reviewed edits are fine.
// The guard is that it stays MINIMAL and does not grow into a second source of
// truth — keep the core invariants, keep it short, don't reintroduce a separate
// ARCHITECTURE doc. Adding a one-line pointer is allowed; pasting a doc is not.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// Core invariants that must always remain (substring, not exact match).
const coreInvariants = [
  'Remote storage is source of truth. Local HTML is disposable. Local skill is authoring/scaffold.',
  'Published reader invariants are provider-enforced in overlay/worker code and tests, not left only to author HTML or prompts.',
];
const MAX_LINES = 6;   // minimal by construction; a doc paste would blow this
const MAX_BYTES = 1200;

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

console.log('agents.md source-of-truth rule');

t('AGENTS.md keeps the core rules and stays minimal', () => {
  const body = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  for (const rule of coreInvariants) {
    assert(body.includes(rule), `AGENTS.md must keep the core rule:\n${rule}`);
  }
  const lines = body.split('\n').filter(l => l.trim() !== '');
  assert(lines.length <= MAX_LINES,
    `AGENTS.md must stay minimal (<= ${MAX_LINES} non-empty lines); got ${lines.length}. Keep edits intentional, not a second doc.`);
  assert(body.length <= MAX_BYTES,
    `AGENTS.md must stay minimal (<= ${MAX_BYTES} bytes); got ${body.length}.`);
  assert(!/ARCHITECTURE\.md/.test(body),
    'do not reintroduce ARCHITECTURE.md as a second source of truth');
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
  assert(skill.includes('tdoc-agent-reply'), 'agent replies must go through tdoc-agent-reply so runtime logos auto-detect');
});

t('plugin-mode SKILL.md matches the root SKILL.md', () => {
  const rootSkill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const pluginSkill = fs.readFileSync(path.join(root, 'skills', 'tdoc', 'SKILL.md'), 'utf8');
  assert(rootSkill === pluginSkill, 'skills/tdoc/SKILL.md drifted from SKILL.md — run: cp SKILL.md skills/tdoc/SKILL.md');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
