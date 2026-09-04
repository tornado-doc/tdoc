// The onboarding journey (design: tdoc.dev/d/tdoc-onboarding-journey/v/4).
//
// Five beats, one gesture, three bridges, no daemon. The landing page and its
// CTA are untouched: the CTA opens one screen with two doors. The left door
// needs an account and ends in a waiting state the SERVER drives — it sees the
// agent mint a token, read the comments, publish — so the page can say "your
// agent is reading this" because it is. Every step is a timestamp on the
// account, never a flag in localStorage, and every action the page saw is one
// event row the funnel is read from.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const worker = read('worker/worker.js');
const server = read('server/server.js');
const dialog = read('shell/src/onboarding-dialog.jsx');
const shell = read('shell/src/document-shell.jsx');
const card = read('shell/src/document/comment-card.jsx');
const layer = read('shell/src/document/comment-layer.jsx');
const toolbar = read('shell/src/document/editor-toolbar.jsx');
const api = read('shell/src/document/api.js');

// Lift a top-level function out of a source file so its behaviour can be run,
// not just grepped. Same brace-matching as test/no-drift.test.js.
function lift(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} is not defined`);
  let i = src.indexOf('(', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  while (i < src.length && src[i] !== '{') i++;
  depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, i)}; return ${name};`)();
}

console.log('the onboarding journey');

t('a step is a timestamp that is stamped once and never overwritten', () => {
  const stamp = lift(worker, 'stampOnboarding');
  const first = stamp({}, 'started', '2026-09-04T00:00:00Z');
  assert(first.started === '2026-09-04T00:00:00Z', 'first stamp lands');
  const again = stamp(first, 'started', '2026-09-05T00:00:00Z');
  assert(again.started === '2026-09-04T00:00:00Z', 'a second stamp must not move the first');
  const withDoc = stamp(again, 'published_first', '2026-09-04T00:05:00Z', { first_doc: 'my-doc' });
  assert(withDoc.first_doc === 'my-doc', 'extra fields ride along');
  const kept = stamp(withDoc, 'revised', '2026-09-04T00:10:00Z', { first_doc: 'other' });
  assert(kept.first_doc === 'my-doc', 'an extra field is first-writer-wins too');
  assert(kept !== withDoc, 'the record is copied, not mutated');
});

t('the page may report only the actions the funnel knows, and each maps to at most one step', () => {
  const stepOf = lift(worker, 'onboardingActionStep');
  assert(stepOf('door_own_agent') === 'started', 'choosing the left door starts the journey');
  assert(stepOf('waitlist') === 'waitlist', 'the right door is the waitlist');
  assert(stepOf('share_link_copied') === 'shared', 'copying the link is the exit');
  assert(stepOf('tour_seen') === 'tour_seen', 'the tour flag lives on the account, not in localStorage');
  for (const passive of ['example_opened', 'copy_clicked', 'fix_copy_clicked', 'timeout_shown']) {
    assert(stepOf(passive) === null, `${passive} is logged but stamps nothing`);
  }
  assert(stepOf('published_first') === undefined, 'a page cannot stamp a step the server owns');
  assert(stepOf('') === undefined && stepOf('drop table') === undefined, 'unknown actions are rejected');
});

t('the seed comment anchors to the first paragraph the reader can see', () => {
  const anchorFor = lift(worker, 'seedCommentAnchor');
  const a = anchorFor('<h1>Title</h1><p class="meta">A &amp; B &mdash; <b>bold</b> claim here</p><p>second</p>');
  assert(a && a.kind === 'text', 'a text anchor');
  assert(a.text === 'A & B &mdash; bold claim here', `tags dropped, entities the resolver sees decoded: ${a.text}`);
  assert(anchorFor('<p>hi</p>') === null, 'a paragraph too short to highlight is not an anchor');
  assert(anchorFor('<div>no paragraphs</div>') === null, 'no paragraph, no anchor — the comment still posts unanchored');
  assert(worker.includes("const SEED_COMMENT_TEXT = 'First reader here. Which claim on this page would you defend least? Highlight it and say so.'"),
    'the seed comment asks for the one gesture the page teaches');
  assert(/SEED_COMMENT_AUTHOR = \{ login: 'tdoc', name: 'tdoc'/.test(worker), 'signed as tdoc, not as a person');
});

t('the three routes exist on both hosts', () => {
  for (const [src, label] of [[worker, 'worker'], [server, 'server']]) {
    assert(src.includes("'/api/onboarding'"), `${label}: GET /api/onboarding`);
    assert(src.includes("'/api/onboarding/event'"), `${label}: POST /api/onboarding/event`);
    assert(src.includes("'/api/doc/agent-status'"), `${label}: GET /api/doc/agent-status`);
  }
  const evt = worker.slice(worker.indexOf("p === '/api/onboarding/event'"), worker.indexOf("p === '/api/doc/agent-status'"));
  assert(evt.includes("if (step === undefined) return json({ error: 'unknown_action' }, { status: 400 })"), 'unknown actions are a 400');
  assert(evt.includes("action !== 'waitlist' && action !== 'example_opened'"), 'only waitlist and example are open to a visitor with no account');
  assert(evt.includes("step === 'waitlist' ? { started:"), 'the waitlist door also starts the journey');
});

t('the server stamps what the agent does: token, read, reply, publish', () => {
  assert(/account-terminal:\$\{account\.account_id\}[\s\S]{0,400}stampOnboardingFor\(env, account\.account_id, 'agent_connected'\)/.test(worker),
    'minting a terminal token stamps agent_connected beside account-terminal');
  const get = worker.slice(worker.indexOf("if (p === '/api/comments' && method === 'GET')"), worker.indexOf("if (p === '/api/mentions' && method === 'GET')"));
  assert(get.includes("url.searchParams.get('version') === 'all'"), 'version=all — the shape only tdoc-pull asks for — marks the doc read');
  assert(get.includes('markAgentRead(env, slug)'), 'the read is per doc, so the card on that doc can flip');
  assert(get.includes("stampOnboardingFor(agentAuth.actor.account_id, 'comments_read')") === false
    && get.includes("'comments_read'"), 'a Bearer read stamps comments_read on the account');
  const upload = worker.slice(worker.indexOf("if (p === '/api/upload' && method === 'POST')"), worker.indexOf("if (p === '/api/doc/access' && method === 'PATCH')"));
  assert(/if \(firstHostedPublish\) \{[\s\S]*'published_first', \{ first_doc: slug \}/.test(upload), 'the first hosted publish stamps published_first with the slug');
  assert(/firstHostedPublish[\s\S]*kind: 'create'[\s\S]*author: SEED_COMMENT_AUTHOR[\s\S]*text: SEED_COMMENT_TEXT/.test(upload), 'and seeds the first comment');
  assert(/else if \(verNum >= 2\) \{\s*await stampOnboardingFor\(env, auth\.actor\.account_id, 'revised'\)/.test(upload), 'a second version stamps revised');
  assert(upload.indexOf("'published_first'") > upload.indexOf("productEvent(env, 'publish_succeeded'"), 'stamps happen after the write succeeded, never before');
  const post = worker.slice(worker.indexOf("if (p === '/api/comments' && method === 'POST')"), worker.indexOf("if (p === '/api/comments' && method === 'PATCH')"));
  assert(/res\.status === 200 && isDocOwner[\s\S]*'commented'[\s\S]*'tagged'/.test(post), "the owner's own comment and their first tag are steps");
  const local = server.slice(server.indexOf("if (p === '/api/comments' && req.method === 'POST')"), server.indexOf("if (p === '/api/agent/reply'"));
  assert(local.includes("stampOnboardingLocal('commented')"), 'local twin stamps commented');
  assert(server.includes("if (url.searchParams.get('version') === 'all') { try { markAgentReadLocal(slug); } catch {} }"), 'local twin marks the read');
});

t('a visitor with no session still sees a way to comment, and it is the sign-in', () => {
  assert(/cfg\.signInToComment = !identity && !isLanding && !!versionWritesEnabled\s*&& accessFromMeta\(docMeta \|\| \{\}\)\.commenting !== 'off'/.test(worker),
    'the flag is on when the doc takes comments and this visitor has no session');
  assert(server.includes('signInToComment: false'), 'local preview is anonymous by design and may always comment');
  assert(toolbar.includes("(option.value === 'comment' && (canComment || signInToComment))"), 'the Comment option shows for the visitor');
  assert(toolbar.includes("? 'Sign in to comment'"), 'and says what it will do');
  assert(toolbar.includes('? onSignIn?.()'), 'and opens the sign-in rather than the mode');
  assert(shell.includes('signInToComment={Boolean(config.signInToComment)}') && shell.includes('onSignIn={signIn}'), 'the shell wires it');
});

t('one screen, two doors, the definition on hover, the example beside them', () => {
  assert(dialog.includes('title="Create a free doc"'), 'the screen is named after the button that opened it');
  assert(dialog.includes('<strong>Use my own <AgentTerm /></strong>'), 'left door');
  assert(dialog.includes("<strong>Use tdoc's agent — coming soon</strong>"), 'right door');
  assert(!/coding agent/.test(dialog) || !/(no|without|don.t have) coding agent/i.test(dialog), 'the right door never says "no coding agent"');
  assert(dialog.includes("export const AGENT_NAMES = 'Claude Code · Codex · Claude Cowork · ChatGPT Work'"), 'all four names');
  assert(dialog.includes("export const AGENT_DEFINITION = 'An AI that runs on your computer and can read and write files.'"), 'the definition');
  assert(dialog.includes('className="tdoc-term-tip" role="tooltip"'), 'shown as a tooltip, on demand');
  assert(dialog.includes("export const EXAMPLE_URL = '/d/what-ai-knows/v/12'") && dialog.includes('See an example'), 'See an example');
  assert(dialog.includes("postOnboardingEvent('waitlist')"), 'the right door records the waitlist');
  assert(dialog.includes("onSignIn?.('/?onboard=own')"), 'the left door signs in and returns to itself');
  assert(shell.includes("new URLSearchParams(location.search).get('onboard') === 'own'"), 'the shell reopens the door after the redirect');
});

t('bridge 1 is read off the server and leaves for the doc on its own', () => {
  assert(dialog.includes("export const TWO_WINDOWS = 'Two windows: you read and comment here. Your agent writes and fixes.'"), 'the one concept, once');
  assert(dialog.includes("postOnboardingEvent('door_own_agent')"), 'reaching the door is the first stamp');
  assert(dialog.includes('const POLL_MS = 3000'), '3s while waiting');
  assert(/next\?\.published_first && next\?\.first_doc[\s\S]*location\.href = `\/d\/\$\{encodeURIComponent\(next\.first_doc\)\}\/v\/1`/.test(dialog), 'the page goes to the first doc when it arrives');
  assert(dialog.includes("export const WAITING = 'Waiting for your agent…'"), 'copy flips to waiting');
  assert(dialog.includes("export const STILL_WAITING = 'Still waiting — did you paste it into your agent?'"), 'the timeout asks the one question');
  assert(dialog.includes("'Your agent is connected. Publishing your first doc…'"), 'agent_connected has its own line');
  assert(api.includes("return request('/api/onboarding');") && api.includes("'/api/onboarding/event'") && api.includes('/api/doc/agent-status?'), 'the three calls');
});

t('bridge 2 lives on the card: the line, the copy, then what the server saw', () => {
  assert(shell.includes("const HANDOFF_LINE = 'Read my tdoc comments and fix them'"), 'the one instruction');
  assert(shell.includes('const HANDOFF_POLL_MS = 3000'), '3s while waiting');
  assert(shell.includes("postOnboardingEvent('fix_copy_clicked', config.slug)"), 'copy is an event');
  assert(/setHandoff\(\(current\) => \(current\.state === 'waiting' \? \{ \.\.\.current, state: 'reading' \} : current\)\)/.test(shell), 'the read stamp flips waiting → reading');
  assert(/latest > Number\(config\.version\)[\s\S]*location\.href = `\/d\/\$\{encodeURIComponent\(config\.slug\)\}\/v\/\$\{latest\}`/.test(shell), 'a new version moves the page');
  assert(shell.includes("postOnboardingEvent('timeout_shown', config.slug)"), 'the timeout is logged');
  assert(shell.includes('const handoffEnabled = Boolean(config.isOwner && !config.isLanding)'), "only on the owner's own doc");
  assert(card.includes("handoff = null,") && card.includes('className="tdoc-handoff"'), 'the card renders it');
  assert(card.includes("Waiting for your agent…") && card.includes('Your agent is reading this') && card.includes('Still waiting — did you paste it into your agent?'), 'the four states');
  assert((layer.match(/handoff=\{handoff\}/g) || []).length === 2, 'threaded through both the desktop layer and the phone drawer');
});

t('the exit is a line on a revised doc, owed until the link is copied', () => {
  assert(shell.includes("const EXIT_LINE = 'Now get a real one. Tag someone and send them the link.'"), 'the line');
  assert(/handoffEnabled && Number\(config\.version\) >= 2\s*&& onboardingRecord && onboardingRecord\.started && !onboardingRecord\.shared/.test(shell), 'v2+, journey started, not yet shared');
  assert(shell.includes("postOnboardingEvent('share_link_copied', config.slug)"), 'copying is the stamp');
  assert(shell.includes('(showExitBanner ? 36 : 0)'), 'the frame moves down under it');
});

t('resuming reads the record, not localStorage', () => {
  assert(/record\?\.started && !record\?\.published_first && !record\?\.waitlist[\s\S]*setOnboardingDoor\('own'\);\s*setOnboardingOpen\(true\)/.test(shell),
    'a started, unfinished journey reopens the door on the landing page');
  assert(!dialog.includes('localStorage'), 'the dialog keeps no local state');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
