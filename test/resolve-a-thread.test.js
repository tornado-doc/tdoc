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

t('resolution records its author without synthesizing reactions', () => {
  const start = worker.indexOf("case 'marked_applied':");
  const block = worker.slice(start, worker.indexOf("case 'deleted':", start));
  assert(!block.includes('_agentVerdict'), 'resolution still stages a synthetic reaction');
  assert(/snap\.resolved_by = e\.human \? \(e\.by \|\| ''\) : ''/.test(block),
    'the card needs to know a person resolved it, and which person');
  // Every event written before people could resolve lacks `human`, so the
  // agent path has to stay the default.
  assert(!/e\.human === false/.test(block), 'do not require the flag to be present on legacy events');
});

t('the chip says who decided, because they are different claims', () => {
  assert(card.includes("comment.handoff_at && !comment.resolved_by && (demo || canSeeHandoff(comment, handoffViewer, isOwner)) ? '✅ Done'"),
    'an agent handoff resolved by the agent should show Done');
  assert(/comment\.resolved_by\s*\n?\s*\? `✓ resolved by @\$\{comment\.resolved_by\}`/.test(card),
    'a person resolving should not read as "fixed"');
  assert(/: `✓ fixed\$\{comment\.applied_in \? ` · v\$\{comment\.applied_in\}` : ''\}`/.test(card),
    'a resolved comment without a handoff retains its prior wording');
});

t('resolve sits with the thread actions, behind canMutate', () => {
  assert(/className="tdoc-resolve-toggle"/.test(card), 'no resolve control');
  // Now an icon in the card header, so the way back is carried by its label
  // rather than by its text. Same control, same both-ways requirement.
  assert(/comment\.status === 'applied' \? 'Reopen' : 'Resolve'/.test(card),
    'the same control has to offer the way back');
  const start = card.indexOf('className="tdoc-resolve-toggle"');
  assert(card.slice(start - 200, start).includes('canMutate ? ('), 'resolve must be gated like delete');
});

// Julie, 2026-10-27: no ✓ on Serena's threads. The client gate has to agree
// with the worker's canMutate(): isDocOwnerSession (sent as isOwner), or the
// author among actorKeys(session) -- lowercased, linked accounts included.
t('the resolve gate matches the worker: owner, or the author under any linked key, any case', () => {
  const start = card.indexOf('export function mayMutate(');
  const body = card.slice(start, card.indexOf('\n}\n', start) + 2).replace(/^export /, '');
  const mayMutate = new Function(`${body}; return mayMutate;`)();
  const serena = { author: { login: 'Serena-Q' } };
  assert(mayMutate(serena, 'julie', true) === true, 'the doc owner (or team admin) cannot resolve');
  assert(mayMutate(serena, 'julie', false, ['julie', 'email:julie@x.ai']) === false, 'a stranger can resolve');
  assert(mayMutate(serena, 'serena-q', false) === true, 'case differs from the stored login');
  assert(mayMutate(serena, 'email:serena@befreed.ai', false, ['email:serena@befreed.ai', 'serena-q']) === true,
    'an author signed in through a linked account cannot resolve');
  assert(mayMutate({ author: { login: 'email:Serena@BeFreed.ai' } }, 'email:serena@befreed.ai', false) === true,
    'an email-keyed author cannot resolve');
  assert(mayMutate({ author: {} }, 'anon', false, ['anon']) === false, 'an authorless record is resolvable');
  assert(mayMutate(serena, 'anon', false, 'anon') === false, 'anon matched');
  assert(card.includes('const canMutate = mayMutate(comment, currentUser, isOwner, handoffViewer);'),
    'the card must pass the viewer\'s linked keys');
  const fbspace = read('shell/src/feedback-space.jsx');
  assert(fbspace.includes('identity.linked_actor_keys') && /page: 'feedback-space'[\s\S]{0,1200}linked_actor_keys: actorKeys\(viewer\)/.test(worker),
    'the feedback space page must send and use the linked keys');
});

t('resolved visibility governs selection without deleting stored comments', () => {
  const model = read('shell/src/document/comment-area.js');
  assert(model.includes("filterMode === 'resolution' && filter === 'open' && phase(comment) !== 'resolved'"),
    'resolved threads should not be sent as anchors');
  assert(!/comment\.id === (openCommentId|deepTarget)/.test(model),
    'selection or a notification link must not bypass the visibility switch');
  assert(shell.includes('const openComment = commentArea.selected;')
    && model.includes('selected: shown.find((comment) => comment.id === selectedId)'),
    'the card must obey the same visible set as the frame');
  // Hidden records remain available for status changes and explicit reveals.
  assert(shell.includes('const commentsById = commentArea.byId;')
    && model.includes('const byId = new Map(all.map((comment) => [comment.id, comment]));'),
    'hiding must not discard the stored comment');
});

t('resolved visibility is a filter in the comments area (Open / Resolved / All), All by default', () => {
  const seg = read('shell/src/ui/segmented-control.jsx');
  assert(seg.includes('role="radiogroup"') && seg.includes('role="radio"'),
    'the filter should lean on the primitive for its semantics, not fake them');
  assert(/className="tdoc-comment-filter"/.test(shell), 'there is no comments filter');
  assert(/label: `Resolved \(\$\{resolvedCount\}\)`/.test(shell), 'the filter should say how many are resolved');
  assert(/const commentFilterControl = comments\.comments\.length \? \(/.test(shell), 'the filter should appear when there are comments to filter');
  assert(!/<AppSwitch\s*\n\s*id="tdoc-show-resolved"/.test(shell), 'the bar switch is back');
  // Show all threads by default; only an explicitly saved choice narrows them.
  assert(/return v === '0' \? 'open' : v === 'resolved' \? 'resolved' : 'all';\s*\n\s*\} catch \{ return 'all'; \}/.test(shell),
    'default All, including when storage is unavailable');
  assert(/localStorage\.setItem\(RESOLVED_KEY/.test(shell), 'the choice should survive a reload');
});

t('on a phone the filter heads the comments drawer, and ⋯ no longer carries it', () => {
  assert(/filter=\{commentFilterControl\}/.test(shell), 'the drawer does not get the filter');
  assert(/tdoc-comment-filter-row/.test(read('shell/src/document/comment-layer.jsx')), 'the drawer does not show it');
  assert(!/data-action="show-resolved"/.test(toolbar), 'the ⋯ row is back beside the filter');
});

t('resolving closes the card it was pressed on', () => {
  const start = shell.indexOf('const resolveComment = async');
  const block = shell.slice(start, shell.indexOf('\n  const ', start + 20));
  assert(/if \(\(resolved && commentFilter === 'open'\) \|\| \(!resolved && commentFilter === 'resolved'\)\) setOpenCommentId\(null\)/.test(block),
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
