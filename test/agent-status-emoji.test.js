// Regression test for "comments vanish and posting 500s from v2 onward".
//
// Root cause: #296 deleted `const AGENT_STATUS_EMOJI` from worker.js but left
// the two references in snapshotAt(). The line only runs when a fold produces
// an agent verdict (a marked_applied / marked_open event at or below the
// requested version), so v1 folded fine and every v>=2 read threw
// `ReferenceError: AGENT_STATUS_EMOJI is not defined` → 500 on GET and POST
// /api/comments. Live docs looked like they had lost their comments.
//
// The existing fold tests missed it because they INJECT AGENT_STATUS_EMOJI into
// the VM sandbox. This one takes the definition from worker.js itself, so a
// deleted constant fails here instead of in production.
//
// Run with: node test/agent-status-emoji.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, err) { console.log(`  ✗ ${name}\n    ${err}`); fail++; }
function t(name, fn) { try { fn(); ok(name); } catch (e) { bad(name, e.message); } }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');

function sliceFn(name) {
  const start = workerSrc.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in worker.js`);
  let i = workerSrc.indexOf('{', start);
  let depth = 0;
  for (; i < workerSrc.length; i++) {
    if (workerSrc[i] === '{') depth++;
    else if (workerSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return workerSrc.slice(start, i);
}

// The constant comes from the SOURCE, not from the sandbox — that is the point.
const emojiDecl = /^const AGENT_STATUS_EMOJI = \{.*\};$/m.exec(workerSrc);

t('worker.js defines AGENT_STATUS_EMOJI (snapshotAt references it)', () => {
  assert(emojiDecl, 'AGENT_STATUS_EMOJI is referenced by snapshotAt but never declared in worker.js');
});

const deps = [
  'isFiniteVersion', 'eventEid', 'backfillEids', 'dedupEvents',
  'ensureEventLog', 'legacyToEvents', 'snapshotAt', 'snapshotList',
].map(sliceFn).join('\n\n');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${emojiDecl ? emojiDecl[0] : ''}\n\n${deps}`, sandbox);

// A comment created on v1 and marked applied by the agent on v2 — the exact
// shape that took every v>=2 read down.
function appliedOnV2() {
  return {
    id: 'c_applied',
    author: { login: 'tester' },
    created: '2026-01-01T00:00:00Z',
    created_in: 1,
    events: [
      { kind: 'created', at_version: 1, at: '2026-01-01T00:00:00Z', anchor: { kind: 'text', text: 'x' }, text: 'hi' },
      { kind: 'marked_applied', at_version: 2, at: '2026-01-02T00:00:00Z', applied_in: 2, by: 'tdoc-agent', agent_status: 'applied' },
    ],
  };
}

t('folding at v1 keeps the comment open (verdict event is out of scope)', () => {
  const snap = sandbox.snapshotAt(appliedOnV2(), 1);
  assert(snap, 'v1 snapshot missing');
  assert(snap.status === 'open', `expected open at v1, got ${snap.status}`);
});

t('folding at v2 renders the ✅ verdict instead of throwing', () => {
  const snap = sandbox.snapshotAt(appliedOnV2(), 2);
  assert(snap, 'v2 snapshot missing');
  assert(snap.status === 'applied', `expected applied at v2, got ${snap.status}`);
  assert(Array.isArray(snap.reactions['✅']), 'agent verdict emoji not synthesized at v2');
  assert(snap.reactions['✅'].includes('tdoc-agent'), 'verdict emoji not attributed to the agent');
});

t('the whole list still folds at the latest version (GET /api/comments path)', () => {
  const list = sandbox.snapshotList([appliedOnV2()], Infinity);
  assert(list.length === 1, `expected 1 comment, got ${list.length}`);
  assert(list[0].reactions['✅'], 'latest fold lost the verdict emoji');
});

t('partial and question verdicts fold too', () => {
  for (const [status, emoji] of [['partial', '🟡'], ['question', '❓']]) {
    const c = appliedOnV2();
    c.events[1].agent_status = status;
    const snap = sandbox.snapshotAt(c, 2);
    assert(snap.reactions[emoji], `${status} verdict did not render ${emoji}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
