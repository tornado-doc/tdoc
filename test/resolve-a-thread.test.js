// #357: the rendering for a resolved thread has existed since the event log was
// written — green pin ring, ✓ chip, cluster class — and the only thing that
// could ever set it was an agent posting a verdict. There was no route a human
// session could call and no button anywhere.
//
// The event kinds already existed too, and their event id is `status:<version>`
// — one status slot per version — so resolve and reopen converge however two
// people interleave them. Nothing about the fold needed inventing; what needed
// deciding was who may press it, what the chip says when a person did, and
// where a resolved thread goes.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const worker = read('worker/worker.js');
const server = read('server/server.js');
const card = read('shell/src/document/comment-card.jsx');
const shell = read('shell/src/document-shell.jsx');
const toolbar = read('shell/src/document/document-toolbar.jsx');
const api = read('shell/src/document/api.js');

console.log('a person can resolve a thread (#357)');

t('a person resolving goes through the same gate as deleting', () => {
  const start = worker.indexOf("if (typeof body.resolved === 'boolean')");
  assert(start >= 0, 'the worker has no resolve branch');
  const branch = worker.slice(start, worker.indexOf("if (!slug || !id || !anchor)", start));
  assert(branch.includes('canMutate(target, s, env, docMeta)'),
    'resolve must reuse canMutate — the owner, or whoever wrote the comment');
  assert(branch.includes("kind: 'set_status'"), 'the write must go through the serialized op');
  assert(branch.includes('coerceBodyVersion(version, target.created_in || 1)'),
    'status is per version, like every other comment event');
});

t('the status op writes one event per version, so it converges', () => {
  const start = worker.indexOf("case 'set_status': {");
  assert(start >= 0, 'the DO has no set_status op');
  const op = worker.slice(start, worker.indexOf("case 'react': {", start));
  assert(/kind: 'marked_applied'[\s\S]*human: true/.test(op), 'resolve must mark itself as a person');
  assert(/kind: 'marked_open'[\s\S]*human: true/.test(op), 'reopen must mark itself as a person');
  // The eid is what makes this a toggle rather than an accumulating log.
  assert(/case 'marked_applied':\s*\n\s*case 'marked_open':\s*\n\s*return `status:\$\{e\.at_version\}`/.test(worker),
    'both status kinds must share one event id per version');
});

t('a person resolving does not leave an emoji in their name', () => {
  const start = worker.indexOf("case 'marked_applied':");
  const block = worker.slice(start, worker.indexOf("case 'deleted':", start));
  assert(/snap\._agentVerdict = e\.human \? null : \(e\.agent_status \|\| 'applied'\)/.test(block),
    'the ✅/🟡/❓ reaction is the agent verdict, and a human decision is not one');
  assert(/snap\.resolved_by = e\.human \? \(e\.by \|\| ''\) : ''/.test(block),
    'the card needs to know a person resolved it, and which person');
  // Every event written before people could resolve lacks `human`, so the
  // agent path has to stay the default.
  assert(!/e\.human === false/.test(block), 'do not require the flag to be present on legacy events');
});

t('the chip says who decided, because they are different claims', () => {
  assert(/comment\.resolved_by\s*\n?\s*\? `✓ resolved by @\$\{comment\.resolved_by\}`/.test(card),
    'a person resolving should not read as "fixed"');
  assert(/: `✓ fixed\$\{comment\.applied_in \? ` · v\$\{comment\.applied_in\}` : ''\}`/.test(card),
    "an agent's verdict keeps the wording it had");
});

t('resolve sits with the thread actions, behind canMutate', () => {
  assert(/className="tdoc-resolve-toggle"/.test(card), 'no resolve control');
  assert(/\{comment\.status === 'applied' \? 'reopen' : 'resolve'\}/.test(card),
    'the same control has to offer the way back');
  const start = card.indexOf('className="tdoc-resolve-toggle"');
  assert(card.slice(start - 200, start).includes('canMutate ? ('), 'resolve must be gated like delete');
});

t('a resolved thread leaves the margin, except the one being looked at', () => {
  const start = shell.indexOf('const shownComments = useMemo');
  const block = shell.slice(start, shell.indexOf('), [', start) + 120);
  assert(/comment\.status !== 'applied'/.test(block), 'resolved threads should not be sent as anchors');
  assert(/comment\.id === openCommentId/.test(block),
    'the open card would otherwise sit over a pin that is no longer there');
  assert(/comment\.id === deepTarget/.test(block),
    'a notification link must reach the thread it points at');
  // The map the open card reads from must still hold everything.
  assert(/const commentsById = useMemo\(\s*\n\s*\(\) => new Map\(comments\.comments/.test(shell),
    'hiding is about the margin, not about forgetting the comment exists');
});

t('the way back is in the ⋯ menu, and says how many', () => {
  assert(/data-action="show-resolved"/.test(toolbar), 'no Show resolved item');
  assert(/showResolved \? 'Hide resolved' : `Show resolved \(\$\{resolvedCount\}\)`/.test(toolbar),
    'the item should say how many are hidden, and toggle back');
  assert(/\{resolvedCount \? \(/.test(toolbar), 'do not offer it when nothing is resolved');
  assert(/localStorage\.setItem\(RESOLVED_KEY/.test(shell), 'the choice should survive a reload');
  assert(/try \{ return localStorage\.getItem\(RESOLVED_KEY\) === '1'; \} catch \{ return false; \}/.test(shell),
    'storage that throws must mean "quiet margin", not a crash');
});

t('resolving closes the card it was pressed on', () => {
  const start = shell.indexOf('const resolveComment = async');
  const block = shell.slice(start, shell.indexOf('\n  const ', start + 20));
  assert(/if \(resolved && !showResolved\) setOpenCommentId\(null\)/.test(block),
    'the card has to go with the thread, or it is pinned to nothing');
});

t('the local server records the same thing the fold produces', () => {
  const start = server.indexOf("if (typeof body.resolved === 'boolean')");
  assert(start >= 0, 'the local server cannot resolve');
  const block = server.slice(start, server.indexOf("// Editing a comment's text", start));
  assert(/top\.status = 'applied'/.test(block) && /top\.resolved_by =/.test(block),
    'local writes the folded fields, since it has no event log');
  assert(/delete top\.applied_in;\s*\n\s*delete top\.resolved_by;/.test(block),
    'reopening must clear what resolving set');
});

t('the shell asks for it the same way everywhere', () => {
  assert(api.includes("export function setCommentResolved"), 'no API call');
  assert(/body: JSON\.stringify\(\{ slug, version, id, resolved \}\)/.test(api), 'the route reads these four');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
