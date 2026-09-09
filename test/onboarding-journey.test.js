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

t('one pop-up, five steps, and the first one is a drawing', () => {
  assert(dialog.includes('title="Create a free doc"') && dialog.includes('hideTitle'), 'the screen is named after the button that opened it, for assistive tech');
  assert(dialog.includes("const STEPS = ['welcome', 'paste', 'doc', 'sendback', 'done'];"), 'five steps, in order');
  assert(dialog.includes("<OnboardingScene />") && read('shell/src/onboarding-scene.jsx').includes('Your agent') && read('shell/src/onboarding-scene.jsx').includes('Your browser'), 'the loop is drawn as two windows, not written');
  assert(dialog.includes("export const AGENT_NAMES = 'Claude Code · Codex · Claude Cowork · ChatGPT Work'"), 'all four names');
  assert(dialog.includes("export const AGENT_DEFINITION = 'An AI that runs on your computer and can read and write files.'"), 'the definition');
  assert(!/tdoc-term-tip|role="tooltip"/.test(dialog), 'no tooltip');
  assert(!/Use tdoc's agent|waitlist/.test(dialog), 'no second door: there is one way in');
  assert(!/Start from scratch|Advanced|Read the full tutorial/.test(dialog), 'the onboarding never offers a blank doc, and carries no reading');
  // Sign-in is the site's own; the page leaves for it and returns to the paste step.
  assert(dialog.includes("onSignIn?.('/?onboard=paste')") && !dialog.includes("'tdoc-signin'"), 'sign-in is the existing one, not a second');
  assert(shell.includes("&& new URLSearchParams(location.search).get('onboard'))"), 'the shell reopens the wizard after the redirect, at any step');
  // Every step can be left.
  // Leaving is the × in the corner. Nothing on the floor says Skip or Done:
  // beside Back, with no Next, a Skip read as "next" and quietly closed the
  // whole thing.
  assert(dialog.includes('className="tdoc-wiz-close" onClick={onClose} aria-label="Close"') && !/>Done</.test(dialog), 'leaving is the corner ×');
  // Skip is not leaving: it goes to the last screen and stamps tour_seen so
  // the landing stops reopening the pop-up.
  assert(dialog.includes("onClick={skipToEnd}>Skip</button>") && dialog.includes("const skipToEnd = () => setView('end');"), 'Skip goes to the question');
  assert(dialog.includes('Skip the walk-through?<br />You can come back any time.') && dialog.includes('onClick={confirmSkip}>Skip it, go to my docs</button>') && dialog.includes('onClick={() => setView(null)}>Keep going</button>'), 'the question, with its two answers');
  assert(/const confirmSkip = \(\) => \{\s*postOnboardingEvent\('tour_seen'\)[\s\S]*location\.href = '\/me';/.test(dialog), 'only a yes is remembered, and goes to their docs');
  // Looking back never moves the journey: `step` is the record's, `view` is
  // the person's, and the record's next move clears the view.
  assert(dialog.includes("const shown = view && STEPS.includes(view) && STEPS.indexOf(view) < STEPS.indexOf(step) ? view : step;") && dialog.includes("onClick={back}>Back</button>") && dialog.includes("onClick={forward}>Continue</button>"), 'a step can be looked at again, and left again, from the bottom row');
  // The frame never moves: a fixed-height sheet, a two-line headline slot, the
  // body in the middle, the buttons on the floor — and a step with no primary
  // keeps the floor where it is.
  assert(/\.ui-dialog-popup\.tdoc-wiz-modal \{[^}]*height: min\(640px, calc\(100vh - 32px\)\);/.test(read('shell/src/ui/ui.css')) && read('shell/src/ui/ui.css').includes('.tdoc-wiz .tdoc-wiz-h1 { min-height: 2.3em; }') && read('shell/src/ui/ui.css').includes('.tdoc-wiz-primary-ghost { height: 48px; }'), 'the sheet, the headline slot and the floor are fixed');
  assert(dialog.includes('{primary || <div className="tdoc-wiz-primary-ghost" aria-hidden="true" />}'), 'a step without a primary keeps the floor');
  assert(dialog.includes('<div className="tdoc-wiz-body">{body}</div>') && dialog.includes('className="tdoc-wiz-nav-row"'), 'headline, body, floor');
  // A person who is done sees that they are, and gets their docs or the walk again.
  // The floor and the dots, as rules — one place, pinned:
  assert(dialog.includes("const index = atEnd ? STEPS.length : STEPS.indexOf(shown) + 1;"), 'the end screen is the last dot, whatever the record says');
  assert(dialog.includes("{index > 1 ? <button type=\"button\" className=\"tdoc-wiz-link\" onClick={back}>Back</button> : <span />}"), 'Back on every screen after the first');
  assert(/index < liveIndex\s*\? <button type="button" className="tdoc-wiz-link" onClick=\{forward\}>Continue<\/button>\s*: <button type="button" className="tdoc-wiz-link" onClick=\{skipToEnd\}>Skip<\/button>/.test(dialog), 'Continue while looking back, Skip on the live step');
  assert(dialog.includes("onClick={() => setView(i + 1 === liveIndex ? null : s)}") && dialog.includes("i + 1 <= liveIndex"), 'reached dots are clickable; the live dot returns to the live step');
  assert(dialog.includes("const finished = step === 'done' && shared && view === null;") && dialog.includes('You’ve done the loop.') && dialog.includes('href="/me">Go to my docs</a>') && dialog.includes(">Walk through it again</button>"), 'the finished screen');
  assert(dialog.includes('useEffect(() => { setView(null); }, [step]);'), 'a step that moves on is shown the moment it does');
  assert(dialog.includes('useEffect(() => { lineReset(); }, [step, lineReset]);'), 'a copy survives looking back and the skip question');
  // Under 700px every modal button grows to 44px; the dots are buttons and
  // became coins (seen on tdoc.dev in a 560px pane). They stay dots.
  assert(/\.tdoc-modal \.tdoc-wiz \.tdoc-wiz-dots button \{\s*min-width: 0;\s*min-height: 0;/.test(read('shell/src/ui/ui.css')), 'the dots are exempt from the 44px floor');
  assert(!/tdoc-wiz-sub/.test(dialog), 'no subtitles: a headline, a button, and a status line at most');
  // Every wizard button rule outranks chrome.css's `.tdoc-modal button`, which
  // painted them white on white (round-5 screenshots: blank buttons).
  const css = read('shell/src/ui/ui.css');
  assert(css.includes('.tdoc-wiz button.tdoc-wiz-primary, .tdoc-wiz a.tdoc-wiz-primary {') && css.includes('.tdoc-wiz button.tdoc-wiz-secondary {') && css.includes('.tdoc-wiz button.tdoc-wiz-link, .tdoc-wiz a.tdoc-wiz-link {'), 'wizard buttons outrank the modal button rule');
});

t('bridge 1 is read off the server, and the code from the terminal is typed under the line', () => {
  assert(dialog.includes("postOnboardingEvent('door_own_agent')"), 'reaching the paste step is the first stamp');
  assert(dialog.includes('const POLL_MS = 3000'), '3s while waiting');
  assert(dialog.includes('export function stepFromRecord(record)') && /if \(record\.revised\) return 'done';\s*if \(record\.commented\) return 'sendback';\s*if \(record\.published_first\) return 'doc';\s*if \(record\.agent_connected\) return 'doc';\s*return 'paste';/.test(dialog), 'the step is the record, forward only');
  assert(dialog.includes("export const WAITING = 'Listening for your agent…'"), 'copy flips to listening');
  assert(dialog.includes("export const NOTHING_YET = 'Taking a while? Check your agent’s window.'"), 'a nudge before the timeout');
  assert(dialog.includes("export const STILL_WAITING = 'Still waiting. Did you paste it?'"), 'the timeout asks the one question');
  assert(dialog.includes('COPY_FALLBACK') && dialog.includes('selectContents(codeRef.current)'), 'a refused clipboard leaves the line selected and says so');
  // The pairing code a terminal shows is typed in this window, against the
  // same two routes /activate uses — lookup names the terminal, approve binds it.
  assert(dialog.includes("postJson('/api/cli/pair/lookup', { user_code: code })") && dialog.includes("postJson('/api/cli/pair/approve', { user_code: code })"), 'pairing reuses the activate routes');
  assert(dialog.includes('Connect {pair.label ? <strong>{pair.label}</strong> : \'this terminal\'} to your account?'), 'the terminal is named before it is bound');
  assert(dialog.includes('placeholder="Code from your agent"') && dialog.includes("} else if (lineCopy.copied !== null) {"), 'the code is typed under the line, once it is copied, on the same screen');
  // The page follows the CLI's pairing: a terminal that has connected before
  // keeps its credential and never shows a code, so the page waits for the
  // doc instead; a first-time agent connects FIRST, before reading anything.
  assert(dialog.includes("} else if (lineCopy.copied !== null && (connected || paired)) {") && dialog.includes('setPaired(Boolean(result?.paired));'), 'a paired account is not asked for a code');
  assert(worker.includes("paired = Boolean(await env.META.get(`account-terminal:${accountId}`));") && server.includes('paired: Boolean(process.env.TDOC_E2E_PAIRED)'), 'both hosts say whether a terminal has connected');
  const firstDoc = read('FIRST-DOC.md');
  assert(firstDoc.includes('## Step 1b — connect first, before reading anything') && firstDoc.includes('bash "$SKILL_DIR/bin/tdoc-publish" --signin-only'), 'the agent connects before it reads');
  assert(firstDoc.includes('**From the paste to the link: five minutes.**') && firstDoc.includes('at most four figures'), 'the first doc has a clock');
  assert(dialog.includes('Highlight a sentence.<br />Say what you think.') && dialog.includes("openDoc(1, 'welcome')"), 'the doc step is the comment, and the doc opens in a new tab');
  assert(dialog.includes("openDoc(latest || 2, 'revised')"), 'v2 opens and says why it arrived');
  assert(api.includes("return request('/api/onboarding');") && api.includes("'/api/onboarding/event'") && api.includes('/api/doc/agent-status?'), 'the three calls');
});

t('the hub has the same door as the landing, not a bare recipe', () => {
  // Round-3 tester came in through /me: the "Build it with your agent" card
  // showed the line and nothing after it — no wait, no arrival, no seed.
  const cards = read('shell/src/create-from-scratch.jsx');
  assert(cards.includes('<OwnAgentDoor onOpenChange={(open) => { if (!open) setView(\'choice\'); }} closeLabel="Back" />'), 'the card opens the shared door');
  assert(!cards.includes('FirstDocRecipe'), 'no second rendering of the recipe');
  assert(cards.includes('<span className="tdoc-agent-def">{AGENT_DEFINITION} {AGENT_NAMES}</span>'), 'the card defines "agent" where the word is');
  assert(dialog.includes("export function OwnAgentDoor({ onOpenChange, closeLabel = 'Back', config = null })") && dialog.includes('initialStep="paste" embedded'), 'the hub opens the wizard at the paste step');
  assert(/\.mk-card \.tdoc-agent-def \{/.test(read('shell/src/ui/ui.css')), 'the hub card defines the word where it is');
  // A refused clipboard on the fix line: selected, said, and still waiting.
  assert(shell.includes("requestAnimationFrame(() => selectContents(document.querySelector('.tdoc-handoff-line code')));") && shell.includes("      setHandoffPref(true);\n      requestAnimationFrame"), 'the block opens, then the line is left selected');
  assert(shell.includes("setHandoff({ state: 'waiting', copiedAt: Date.now(), copyFailed: !ok });"), 'the wait starts either way');
  assert(card.includes("handoff.copyFailed ? 'Select & copy' : 'Copied'") && card.includes('{COPY_FALLBACK}'), 'the card says what to do');
});

t('bridge 2 lives on the card: the line, the copy, then what the server saw', () => {
  assert(dialog.includes("export const handoffLine = (docUrl) => `Read all comments on ${docUrl} and fix them`;"), 'the one instruction, addressed to a doc');
  assert(shell.includes("const handoffText = handoffLine(`${location.origin}/d/${encodeURIComponent(config.slug)}`);"), 'the card line names this doc');
  assert(shell.includes('const HANDOFF_POLL_MS = 3000'), '3s while waiting');
  assert(shell.includes("postOnboardingEvent('fix_copy_clicked', config.slug)"), 'copy is an event');
  assert(/setHandoff\(\(current\) => \(current\.state === 'waiting' \? \{ \.\.\.current, state: 'reading' \} : current\)\)/.test(shell), 'the read stamp flips waiting → reading');
  assert(/latest > Number\(config\.version\)[\s\S]*location\.href = `\/d\/\$\{encodeURIComponent\(config\.slug\)\}\/v\/\$\{latest\}\?revised=1`/.test(shell), 'a new version moves the page, and says why it arrived');
  assert(shell.includes("postOnboardingEvent('timeout_shown', config.slug)"), 'the timeout is logged');
  assert(shell.includes('const handoffEnabled = Boolean(config.isOwner && !config.isLanding && Number(config.version) === latestVersion)'), "only on the owner's own doc, and only its latest version");
  assert(card.includes("handoff = null,") && card.includes("className={handoff.open ? 'tdoc-handoff open' : 'tdoc-handoff'}"), 'the card renders it, open or closed');
  // Closed is one row — the name and Copy; the line and the sentence are behind the chevron.
  assert(card.includes('Let your agent fix it') && card.includes("{handoff.open ? (\n              <div className=\"tdoc-handoff-line\">\n                <code>{handoff.line}</code>\n                {copyButton}") && card.includes('{!handoff.open ? copyButton : null}'), 'the line shows only when open');
  assert(card.includes("{handoff.open || handoff.state !== 'idle' ? (") && card.includes('Paste this into your agent. It reads all comments on this doc, replies to each, and publishes the next version.'), 'the sentence shows when open; the wait shows either way');
  assert(shell.includes("const onboardingDoc = Boolean(onboardingRecord?.first_doc && onboardingRecord.first_doc === config.slug && !onboardingRecord.shared);") && shell.includes('const handoffOpen = handoffTouched ? handoffPref : (onboardingDoc || handoffPref);'), 'open on the onboarding doc; elsewhere the last choice holds');
  assert(shell.includes("localStorage.setItem(HANDOFF_OPEN_KEY, next ? '1' : '0')"), 'the choice is remembered');
  assert(card.includes("Waiting for your agent…") && card.includes('Your agent is reading this') && !card.includes("handoff.state === 'replied'") && card.includes('Still waiting — did you paste it into your agent?'), 'the four states — no doc-level "replied" on a thread');
  assert(shell.includes('handoffEnabled && ownerCommented ?'), 'the handoff appears after the owner has commented, not on the seeded card that asks for it');
  assert(shell.includes('Number(config.version) === latestVersion'), 'only on the latest version');
  assert(shell.includes("if (value?.id) setOpenCommentId(value.id);"), 'a posted comment opens its card — the next instruction lives there');
  assert(shell.includes("v/${latest}?revised=1"), 'a new version is arrived at as one');
  assert((layer.match(/handoff=\{handoff\}/g) || []).length === 2, 'threaded through both the desktop layer and the phone drawer');
});

t('the exit is a line on a revised doc, owed until the link is copied', () => {
  assert(/`Your agent answered \$\{answered\} \$\{answered === 1 \? 'comment' : 'comments'\} in v\$\{version\}\. Send it to a real reader:`/.test(shell), 'the line says what happened and what to do');
  assert(!shell.includes('Now get a real one'), 'no line a stranger has to decode');
  assert(/\.tdoc-onboard-banner \{\s*position: relative;/.test(read('shell/src/ui/ui.css')), 'in the flow, never floating over the card');
  assert(/handoffEnabled && Number\(config\.version\) >= 2\s*&& onboardingRecord && onboardingRecord\.started && \(!onboardingRecord\.shared \|\| sharedNow\)/.test(shell), 'v2+, journey started, not yet shared (or shared just now)');
  assert(shell.includes("postOnboardingEvent('share_link_copied', config.slug)"), 'copying is the stamp');
  assert(shell.includes('(showExitBanner ? 36 : 0)'), 'the frame moves down under it');
  // Round-4: copying the link used to unmount the banner, shift the frame and
  // close the card — the doc looked comment-free the moment it was shared.
  assert(shell.includes("(!onboardingRecord.shared || sharedNow)") && shell.includes("'Link copied — send it to someone.'"), 'the banner stays as the confirmation');
  assert(shell.includes('className="tdoc-onboard-banner" role="status" onPointerDown={(event) => event.stopPropagation()}'), 'the banner does not close the card');
  // A reply on the seeded card is the gesture too; the answered thread that
  // opens on v2 is the person's own.
  assert(shell.includes("(c.replies || []).some((r) => r.author?.login === me)"), 'replying to the seed counts as commenting');
  assert(shell.includes("list.find((c) => c.status === 'applied' && mine && c.author?.login === mine)"), 'v2 opens their own answered thread first');
});

t('the two arrivals open the right card and say what happened', () => {
  assert(/params\.get\('welcome'\) \? 'welcome' : params\.get\('revised'\) \? 'revised' : null/.test(shell), 'welcome and revised are read once');
  assert(shell.includes('history.replaceState('), 'and taken off the URL');
  assert(/c\.author\?\.login === 'tdoc'\)[\s\S]*setOpenCommentId\(seed\.id\)/.test(shell), 'welcome opens the seeded card');
  assert(shell.includes('is live.`'), 'and says the doc is live');
  assert(/arrival === 'revised'[\s\S]*c\.status === 'applied'[\s\S]*setOpenCommentId\(resolved\.id\)/.test(shell), 'revised opens a resolved card');
  assert(shell.includes("if (new URLSearchParams(location.search).get('revised')) return true;"), 'with resolved threads shown, or v2 looks like nothing happened');
  const landingBar = read('shell/src/document/document-toolbar.jsx');
  assert(landingBar.includes('className="tdoc-your-doc"') && shell.includes('<LandingActions stars={config.stars} yourDoc={yourDoc} />'),
    'the landing page shows a way back to your doc');
  assert(server.includes('oldVersion: (!isLanding && Number(version) < Number(latestVersion))'), 'local preview shows the newer-version strip too');
  for (const [src, label] of [[worker, 'worker'], [server, 'server']]) {
    assert(!src.includes('replied_at'), `${label}: agent-status carries no doc-level replied stamp`);
    assert(src.includes('title:'), `${label}: agent-status carries the title`);
  }
});

t('resuming reads the record, not localStorage', () => {
  assert(/record\?\.started && !record\?\.shared && !record\?\.tour_seen && !record\?\.waitlist[\s\S]*setOnboardingDoor\('own'\);\s*setOnboardingOpen\(true\)/.test(shell),
    'a started, unfinished journey reopens the wizard on the landing page');
  assert(!dialog.includes('localStorage'), 'the dialog keeps no local state');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
