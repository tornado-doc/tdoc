// /setup and the onboarding that follows it. The gate asks one thing; the docs
// page carries the rest. These pin the journey's shape, not its wording.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0; let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
function assert(cond, message) { if (!cond) throw new Error(message); }

const gate = read('shell/src/setup-gate.jsx');
const gateCss = read('shell/src/setup-gate.css');
const list = read('shell/src/docs-hub/onboarding-checklist.jsx');
const hub = read('shell/src/docs-hub.jsx');
const shell = read('shell/src/document-shell.jsx');
const worker = read('worker/worker.js');
const server = read('server/server.js');

console.log('\nsetup gate + onboarding');

t('the gate is a route on both hosts, not a modal', () => {
  assert(worker.includes("if (p === '/setup' && (method === 'GET' || method === 'HEAD'))"), 'worker serves /setup');
  assert(server.includes("if (p === '/setup' && (req.method === 'GET' || req.method === 'HEAD'))"), 'the local server serves it too');
  assert(worker.includes("page: 'setup'") && server.includes("page: 'setup'"), 'both boot the same page');
});

t('only the record moves the gate, and `paired` counts', () => {
  // An account whose agent already holds a token waits forever if the page
  // reads only the record's own stamps: nothing re-stamps a connection that
  // already happened, and clearing the record puts anyone in that state.
  assert(gate.includes('const connected = Boolean(paired || record?.agent_connected || record?.published_first);'),
    'paired is what this page is asking about');
  assert(gate.includes('const POLL_MS = 3000'), 'it asks the server, it does not wait for a reload');
});

t('the prompt names the command that pairs', () => {
  // ONBOARDING.md only reaches the connection inside its first-doc step, which
  // this page does not ask for — so the line has to name it.
  assert(/signin-only/.test(gate), 'installing is not connecting');
});

t('a refused clipboard says so instead of doing nothing', () => {
  assert(gate.includes('selectContents(promptRef.current)') && gate.includes('COPY_FALLBACK'),
    'the line is left selected and the status says why');
});

t('the gate reuses the wizard’s copy, it does not fork it', () => {
  assert(gate.includes("from './onboarding-dialog.jsx'"), 'COPY_FALLBACK and selectContents are imported, not rewritten');
});

t('the landing CTA is the door, and the pop-up stopped opening itself', () => {
  assert(shell.includes("location.href = config.identity && done ? '/me' : '/setup';"), 'unconnected to the gate, connected to their docs');
  assert(!/setOnboardingDoor\('own'\);\s*setOnboardingOpen\(true\)/.test(shell), 'no second journey beside the real one');
});

t('seeding is idempotent and owned by the person', () => {
  assert(worker.includes('async function seedOnboardingDocFor(env, session, accountId)'), 'the seeder exists');
  assert(/if \(!record \|\| record\.seeded \|\| !record\.agent_connected\) return null;/.test(worker),
    'it runs once, and only after an agent connected');
  assert(worker.indexOf("await stampOnboardingFor(env, accountId, 'seeded')") < worker.indexOf('const srcMeta = await loadDocMeta(env, SEED_TEMPLATE_SLUG)'),
    'the stamp is claimed before the work, so two loads cannot each mint a doc');
  assert(worker.includes("visibility: 'private'"), 'the seeded doc is theirs alone');
});

t('the seeded doc lands in an ordinary folder', () => {
  assert(worker.includes("const SEED_FOLDER_NAME = 'Onboarding'"), 'named');
  assert(worker.includes('await saveFolderState(env, key, state)'), 'written through the hub’s own folder state, so it renames and deletes like any other');
});

t('the seeded comment is the one the publish path already plants', () => {
  assert(worker.includes('text: SEED_COMMENT_TEXT, mentions: [], anchor: seedCommentAnchor(html)'),
    'same words, same anchoring, no second version of either');
});

t('every checklist row is a stamp the server writes', () => {
  for (const field of ['agent_connected', 'published_first', 'commented', 'revised']) {
    assert(list.includes(field), `${field} backs a row`);
  }
  assert(!/Open your doc/.test(list), 'no row for something nothing records');
});

t('an unfinished row is a way forward, never a dead line', () => {
  // The person who started setup, left and came back lands here. Without a
  // link, the row naming the thing they have not done offers them nothing.
  assert(/id: 'connect'[^}]*href: '\/setup'/.test(list), 'the connect row leads back to the gate');
});

t('a deleted seed doc does not leave rows pointing at a 404', () => {
  assert(list.includes('(docs || []).some((d) => d && d.slug === first)'), 'the link is only offered while the doc is still there');
  assert(hub.includes('docs={hub.docs}'), 'the hub hands its list over');
});

t('the checklist is for the middle of the journey', () => {
  assert(list.includes('if (!record || !record.started || done === steps.length) return null;'),
    'nothing before it starts, nothing after it ends');
  assert(list.includes("const STORE_KEY = 'tdoc.onboarding.collapsed'"), 'collapsing is a per-browser preference, not an account fact');
  assert(list.includes('onb-chip'), 'hidden, it parks rather than vanishing');
});

t('internal state switching is allowlisted, narrow and server-built', () => {
  assert(worker.includes("await env.META.get('debug-accounts')"), 'the list is KV data, not build config');
  assert(worker.includes("if (p === '/api/onboarding/state' && method === 'POST')"), 'one route');
  assert(/if \(!sameOrigin\(req, url\)\) return json\(\{ error: 'forbidden' \}, \{ status: 403 \}\);[\s\S]{0,400}isDebugAccount/.test(worker),
    'same-origin and allowlisted');
  assert(worker.includes('const next = debugRecord(state, new Date().toISOString(), prior && prior.first_doc);'),
    'the record is built server-side; the client names a state, never a field');
});

t('nothing in the column a person reads is smaller than 12.5px', () => {
  const column = gateCss.slice(gateCss.indexOf('the left pane'), gateCss.indexOf('the right pane'));
  const sizes = (column.match(/font(?:-size)?:[^;]*?([0-9.]+)px/g) || [])
    .map((m) => parseFloat(m.match(/([0-9.]+)px/)[1]));
  const small = sizes.filter((n) => n > 0 && n < 12.5);
  assert(!small.length, `sub-12.5px type on the gate: ${small.join(', ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
