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
// Lift a plain top-level function out of a JSX file so it can be run, not just
// grepped. Same brace-matching as test/no-drift.test.js.
function lift(src, name) {
  const start = src.indexOf(`export function ${name}(`);
  assert(start >= 0, `${name} is not exported`);
  let i = src.indexOf('(', start); let depth = 0;
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
  return new Function(`${src.slice(start, i).replace('export ', '')}; return ${name};`)();
}

const gate = read('shell/src/setup-gate.jsx');
const gateCss = read('shell/src/setup-gate.css');
const list = read('shell/src/docs-hub/onboarding-checklist.jsx');
const hub = read('shell/src/docs-hub.jsx');
const shell = read('shell/src/document-shell.jsx');
const hint = read('shell/src/document/step-hint.jsx');
const hintCss = read('shell/src/document/step-hint.css');
const card = read('shell/src/document/comment-card.jsx');
const copy = read('shell/src/onboarding-copy.js');
const api = read('shell/src/document/api.js');
const listCss = read('shell/src/docs-hub.css');
const worker = read('worker/worker.js');
const server = read('server/server.js');

console.log('\nsetup gate + onboarding');

t('the gate is a route on both hosts, not a modal', () => {
  assert(worker.includes("if (p === '/setup' && (method === 'GET' || method === 'HEAD'))"), 'worker serves /setup');
  assert(server.includes("if (p === '/setup' && (req.method === 'GET' || req.method === 'HEAD'))"), 'the local server serves it too');
  assert(worker.includes("page: 'setup'") && server.includes("page: 'setup'"), 'both boot the same page');
});

t('a host that can sign people in does not ask them to say so twice', () => {
  // The CTA was the intent. Rendering a screen whose only content is "Sign in
  // to start" makes them state it again; the gate sends them to the provider
  // and back. The rendered signed-out state survives only where there is no
  // provider to send them to.
  assert(/if \(!sessionPrincipal\(session\) && oidcConfig\(env\)\) \{[\s\S]{0,220}\/api\/auth\/oidc\/login\?return=/.test(worker),
    '/setup redirects a signed-out visitor straight to sign-in');
  assert(gate.includes("Sign-in is not configured on this host."), 'and says so plainly where there is none');
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
  assert(gate.includes("from './onboarding-copy.js'"), 'COPY_FALLBACK and selectContents are imported, not rewritten');
});

t('the landing CTA is the door, and the pop-up stopped opening itself', () => {
  assert(shell.includes("location.href = config.identity && done ? '/me' : '/setup';"), 'unconnected to the gate, connected to their docs');
  assert(!/setOnboardingDoor\('own'\);\s*setOnboardingOpen\(true\)/.test(shell), 'no second journey beside the real one');
});

t('nothing is put in their account for them', () => {
  // A template copied into an "Onboarding" folder used to stand here so the
  // loop could be walked before they had written anything. It was the wrong
  // object twice: nobody argues with a generic page about nobody, and its
  // existence made "Create your first tdoc" tick on a doc we wrote.
  assert(!worker.includes('seedOnboardingDocFor') && !worker.includes('SEED_TEMPLATE_SLUG'), 'no seeder');
  assert(!worker.includes("SEED_FOLDER_NAME"), 'and no folder minted on their behalf');
  const hubRoute = worker.slice(worker.indexOf("if (p === '/me' && method === 'GET')"), worker.indexOf("if (p === '/api/onboarding' && method === 'GET')"));
  assert(!/seed/i.test(hubRoute), 'the docs page writes nothing when it is opened');
  // What the seeding was really for -- a first comment already on the page, so
  // row 3 is a reply and not a blank -- the publish path does anyway.
  assert(worker.includes("const SEED_COMMENT_TEXT = 'First reader here."), "tdoc's question survives");
  assert(/firstHostedPublish[\s\S]{0,600}?seedFirstComment/.test(worker), 'planted on the doc they made');
});

t('the journey follows the first doc published after it started', () => {
  // Keying only on "this account's first doc ever" left anybody who had
  // published before they onboarded with a row that could never tick.
  assert(worker.includes("} else if (firstHostedPublish || (journey.started && !journey.first_doc)) {"),
    'an account with older docs still gets a journey doc');
  assert(worker.includes("'published_first', { first_doc: slug }"), 'and the record names it');
});

t('every checklist row is backed by something real', () => {
  for (const field of ['agent_connected', 'commented', 'revised']) {
    assert(list.includes(field), `${field} backs a row`);
  }
  assert(!/Open your doc/.test(list), 'no row for something nothing records');
  // The seeder stamps published_first itself, so that stamp says a doc exists
  // and nothing about who made it. Ticking "Create your first tdoc" on the doc
  // we handed them would be a lie.
  assert(/id: 'create'[^}]*done: Boolean\(r\.first_doc\)/.test(list), 'creating is the record naming a doc');
  assert(/id: 'comment'[^}]*href: firstDocHref/.test(list) && /id: 'revise'[^}]*href: firstDocHref/.test(list),
    'and the last two rows stand on that same doc');
});

t('a row cannot come before the row it depends on', () => {
  // eslint-disable-next-line no-new-func
  const src = list.slice(list.indexOf('export function onboardingSteps'), list.indexOf("// Notion's rows carry a thumbnail"));
  // eslint-disable-next-line no-new-func
  const steps = new Function(`${src.replace('export ', '')}; return onboardingSteps;`)();
  const ids = (r) => steps(r, '/d/x').filter((s) => s.locked).map((s) => s.id);
  assert(JSON.stringify(ids({})) === JSON.stringify(['create', 'comment', 'revise']),
    `nothing but the connect row is offered to an empty record: ${JSON.stringify(ids({}))}`);
  assert(JSON.stringify(ids({ agent_connected: 'X' })) === JSON.stringify(['comment', 'revise']),
    'a connected agent unlocks making a doc, and nothing past it');
  assert(JSON.stringify(ids({ agent_connected: 'X', first_doc: 'd' })) === JSON.stringify(['revise']),
    'a doc unlocks commenting on it');
  assert(ids({ agent_connected: 'X', first_doc: 'd', commented: 'X' }).length === 0,
    'and a comment unlocks the handoff');
  // You cannot comment on a doc that does not exist, or ask an agent to fix
  // comments nobody has left. A locked row is shown and not offered.
  assert(list.includes('{step.locked || !step.href'), 'a locked row is not a link');
  // A finished row still is one. Where it goes is still worth going: row 1 is
  // how you connect a second machine, row 2 is how you make another doc, and
  // that page was built for exactly the person who has done it once already.
  assert(!/step\.done \|\| step\.locked/.test(list), 'being done does not close the door');
  assert(listCss.includes('.onb-card li.done a:hover .onb-label { text-decoration: line-through underline; }'),
    'and hovering one does not trade its strike for an underline');
  assert(list.includes("step.done ? 'done' : step.locked ? 'locked' : ''"), 'and says so in its class');
  assert(listCss.includes('.onb-card li.locked .onb-label'), 'which the stylesheet greys');
});

t('an unfinished row is a way forward, never a dead line', () => {
  // The person who started setup, left and came back lands here. Without a
  // link, the row naming the thing they have not done offers them nothing.
  assert(/id: 'connect'[^}]*href: '\/setup'/.test(list), 'the connect row leads back to the gate');
  // Making a doc is asking an agent for one, so the row leads to the page that
  // does that -- not to a fork asking which kind of doc they would like.
  assert(/id: 'create'[^}]*href: '\/setup\?step=doc'/.test(list), 'the create row leads to the doc gate');
  assert(!list.includes('onCreate'), 'and not into the hub\'s create chooser');
});

t('the second ask is the same ask, on the same route', () => {
  // Two pages would mean two of everything: two layouts, two polls, two sets
  // of words for "paste this and watch". It is one page with a second line.
  assert(worker.includes("const step = url.searchParams.get('step') === 'doc' ? 'doc' : 'connect';"), 'the worker reads the step');
  assert(server.includes("const step = url.searchParams.get('step') === 'doc' ? 'doc' : 'connect';"), 'and so does the local server');
  assert(worker.includes('          step,') && server.includes("step: step === 'doc' ? 'doc' : 'connect',"), 'both boot it');
  // The tab's name cannot say "first": the server would have to look up
  // whether they have one, and the heading on the page already says which.
  assert(worker.includes("title: step === 'doc' ? 'tdoc - make a doc'") && server.includes("title: step === 'doc' ? 'tdoc - make a doc'"),
    'and neither host promises a first doc in the title');
  assert(gate.includes("const step = wantsDoc && connected ? 'doc' : 'connect';"),
    'and an unconnected visitor is asked to connect first, whichever link they arrived on');
  assert(gate.includes('export const FIRST_DOC_PROMPT = ANOTHER_DOC_RECIPE;'), 'the doc line is the skill\'s own, reused not rewritten');
});

t('the second ask is the one place with a choice in it', () => {
  // Marching everybody through the same portrait is what made the old version
  // feel like a kidnapping to anyone who already knew what they wanted.
  assert(/DOC_CHOICES = \[[\s\S]*?id: 'own'[\s\S]*?id: 'portrait'[\s\S]*?\]/.test(gate), 'two live choices');
  assert(gate.includes('const [choice, setChoice] = useState(null);'), 'and neither is chosen for them');
  // Choosing is the question this screen asks; everything downstream of it
  // waits until it has been answered.
  assert(gate.includes("{step === 'doc' && !choice ? null : ("), 'no instructions before there is something to paste');
  assert(gate.includes("line={step === 'doc' && !choice ? null : prompt}"), 'and the composer beside them types nothing either');
  // A doc that already exists is not a question. The whole ask goes, rather
  // than sitting there under a line saying it is already done.
  assert(gate.includes("{state === 'waiting' && !(step === 'doc' && !choice) ? ("), 'and no wait either');
});

t('a subject typed on the page composes the line, and an empty one does not', () => {
  // Run the real thing rather than grepping it: the prefix and the suffix are
  // the two halves a reader has to trust.
  // eslint-disable-next-line no-new-func
  const compose = new Function(`${gate.match(/export const DOC_SUBJECT_PREFIX[\s\S]*?export const docSubjectPrompt = [^;]+;/)[0].replace(/export /g, '')}; return docSubjectPrompt;`)();
  assert(compose('pricing') === '/tdoc new "pricing" — then publish it and give me the link',
    `the prefix and suffix wrap what they typed: ${compose('pricing')}`);
  assert(gate.includes("const promptReady = step !== 'doc' || choice === 'portrait' || Boolean(subjectTrimmed);"),
    'an untyped subject is not a line anybody should be handed');
  assert(/className=\{`sg-prompt-copy\$\{copied \? ' copied' : ''\}`\}\s*\n\s*onClick=\{copy\}\s*\n\s*disabled=\{!promptReady\}/.test(gate),
    'so Copy is refused until it is one');
});

t('the portrait line drops a preamble that is false by then', () => {
  // FIRST_DOC_RECIPE opens with "Set up tdoc and", which is true on the
  // landing page and a lie on a screen only a connected account can reach.
  assert(gate.includes('export const PORTRAIT_PROMPT = `Make my first doc: ${RECIPE_URL}`;'), 'same recipe, no setup preamble');
  assert(!/docPrompt[\s\S]{0,80}FIRST_DOC_RECIPE/.test(gate) && !gate.includes("import { ANOTHER_DOC_RECIPE, COPY_FALLBACK, FIRST_DOC_RECIPE"),
    'and the landing page\'s line is not what gets copied here');
  assert(copy.includes("export const RECIPE_URL ="), 'the URL itself lives in the shared copy, imported not retyped');
});

t('forking is drawn and deliberately not wired', () => {
  // Its whole value was a first doc in ten seconds with no agent, and the
  // seeding delivers exactly that, earlier and with no click. The only
  // forkable template today is the one already in their Onboarding folder.
  assert(/DOC_CHOICES[\s\S]{0,400}?\]/.test(gate) && !gate.includes("id: 'fork'"), 'no fork choice ships');
  assert(!worker.includes('seedOnboardingDocFor'), 'and nothing is forked into their account behind their back either');
  assert(gate.includes('second thing to fork'), 'and the reason is written down, not lost');
});

t('nothing is drawn before the server has answered once', () => {
  // An empty record reads as "not connected", so a page asked for the doc step
  // paints the connect step for a beat first. Same class of flicker as the one
  // the old wizard had: a guess rendered while the answer is in flight.
  assert(gate.includes('const [loaded, setLoaded] = useState(false);') && gate.includes('if (!cancelled) setLoaded(true);'),
    'the first poll is what opens the page');
  assert(gate.includes("{signedIn && !loaded ? null : ("), 'the heading waits for it');
  assert(gate.includes("{signedIn && !loaded ? null : signedIn ? ("), 'and so does the column under it');
  assert(gate.includes("const scene = signedIn && !loaded ? null"), 'the scene beside them waits too');
});

t('both steps are one layout with a status line under it', () => {
  // Swapping the doc step into a second, emptier face when its doc arrived
  // made a page out of a sentence: whoever landed on it was told their first
  // tdoc is live and offered nothing to do, and whoever wanted another one had
  // to find their way back to the question.
  assert(!gate.includes('docDone') && !gate.includes('const asking'), 'no second face');
  assert(gate.includes("{step === 'doc' ? (\n                  <div className=\"sg-choices\""), 'the ask stays on the doc step');
  assert(gate.includes("{state === 'done' ? (\n                    <div className=\"sg-status done\">"), 'and the line below it changes');
  assert(/sg-primary\$\{state === 'done' \? '' : ' off'\}/.test(gate), 'one button, off until the step is done — the same as connect');
  // Read once, not live: the heading must not rename itself from "your first"
  // to "another" in front of somebody watching their first arrive.
  assert(gate.includes("if (step === 'doc' && loaded && arrivedWith.current === null) {"), 'what they arrived with is read once');
  assert(gate.includes("const another = step === 'doc' && arrivedWith.current === true;"), 'and that is what names the page');
});

t('the doc step waits for a doc that was not there a moment ago', () => {
  // The record cannot answer this one. Both of its doc stamps are written
  // once, so a SECOND doc moves nothing on it -- which left "Make another
  // tdoc" opening already done, never moving, and pointing its button at the
  // doc before last.
  assert(gate.includes("const arrived = Boolean(ownDoc && ownDoc !== knownDoc.current);"), 'a doc that was not here when the page opened');
  assert(gate.includes("? (arrived ? 'done' : 'waiting')"), 'is what the step turns on');
  // The catalog is the reliable half; the record counts too, so a journey put
  // into a state by hand moves this page the way a real publish does.
  assert(gate.includes("const ownDoc = newestDoc || record?.first_doc || null;"), 'either half can name the doc');
  assert(gate.includes("if (step === 'doc' && loaded && knownDoc.current === undefined) knownDoc.current = ownDoc;"),
    'what they arrived with is read once, after the first answer');
  // A first doc is any doc at all, because there was nothing there before.
  assert(worker.includes('async function newestDocFor(env, accountId)') && server.includes('function newestDocLocal()'), 'both hosts can name it');
  assert(worker.includes("if (url.searchParams.get('docs') === '1') {") && server.includes("if (url.searchParams.get('docs') === '1') {"),
    'behind a parameter, so the connect gate never pays for the walk');
  assert(gate.includes('getOnboarding(wantsDoc ? { docs: 1 } : undefined)'), 'and only this step asks');
});

t('a deleted seed doc does not leave rows pointing at a 404', () => {
  assert(list.includes('(docs || []).some((d) => d && d.slug === first)'), 'the link is only offered while the doc is still there');
  assert(hub.includes('docs={hub.docs}'), 'the hub hands its list over');
});

t('the doc carries one row of the checklist, and only where it belongs', () => {
  const step = lift(hint, 'docStep');
  const started = { started: 'X', first_doc: 'seed' };
  assert(step(null, 'seed', false) === null, 'nothing before there is a journey');
  assert(step({}, 'seed', false) === null, 'nor before it starts');
  assert(step(started, 'other', false) === null, 'and nothing on a doc that is not the journey\'s');
  assert(step(started, 'seed', false) === 'comment', 'the untouched doc asks for the highlight');
  assert(step(started, 'seed', true) === 'handoff', 'their own words move it to the agent');
  assert(step({ ...started, revised: 'X' }, 'seed', true) === null, 'and the closed loop hands the page to the exit banner');
});

t('the hint is a wayfinder, never a second copy of the line', () => {
  // The same line for the agent in two places on one screen is two things to
  // drift apart. The hint says which card is yours now and opens it.
  assert(!hint.includes('handoffLine') && !hint.includes('copyText'), 'the hint carries no line and no clipboard');
  assert(shell.includes('const hintStep = docStep(onboardingRecord, config.slug, ownerCommented, handoffEnabled);'), 'the shell decides the row');
  assert(/goToStep = useCallback\(\(want\) => \{[\s\S]{0,400}setOpenCommentId/.test(shell), 'and going there opens a card');
  // The checklist rows land through the same function, so the corner row and
  // the row on My docs can never drift into two ideas of where a step goes.
  assert(shell.includes("goToStep(arrival === 'fix' ? 'handoff' : 'comment');"), 'a row from My docs lands the same way');
  assert(list.includes("`${firstDocHref}?step=comment`") && list.includes("`${firstDocHref}?step=fix`"),
    'and each row says which thing it came for');
  assert(shell.includes("localStorage.setItem(HANDOFF_OPEN_KEY, '1')"), 'with the line already open when they land on it');
});

t('a row being watched stops being a button', () => {
  // "Waiting for your agent" that can be clicked invites a second paste.
  assert(hint.includes("const watching = !ticking && shown === 'handoff' && agentState !== 'idle';"), 'a copied line is a wait, not a task');
  assert(hint.includes("{still\n        ? <span className=\"sh-row\">{body}</span>"), 'and neither a wait nor a tick is clickable');
  // The card already says these. Said twice in two voices, a reader starts to
  // wonder whether they are two different waits.
  for (const line of ['Waiting for your agent…', 'Your agent is reading this', 'Still waiting — did you paste it into your agent?']) {
    assert(hint.includes(line) && card.includes(line), `"${line}" is the card's own wording`);
  }
});

t('a row that finishes ticks where it stands', () => {
  // Doing the thing and watching the to-do vanish is not the same as watching
  // it get done, and this is the page where it happened.
  assert(hint.includes('const DONE_LINES = {'), 'a finished row has words of its own');
  assert(hint.includes('const [finished, setFinished] = useState('), 'and it is held in state');
  // Read off the ref at render it would lose its name: the ref has already
  // moved on, and the row finishes as a bare "Done."
  assert(hint.includes('{DONE_LINES[finished]}'), 'the struck row still says which row it was');
  assert(hintCss.includes('.sh-hint.ticked .sh-text { color: var(--td-muted, #6b6a66); text-decoration: line-through; }'), 'struck through');
  assert(hintCss.includes('.sh-tick.on {'), 'with the tick filled in');
  // The last step produces no state change to tick on: v2 arriving navigates
  // this page to the new version, so the component watching is already gone.
  assert(hint.includes("useState(justFinished ? 'handoff' : null)"), 'so the arrival ticks it on the way in');
  assert(shell.includes("justFinished={arrival === 'revised'}"), 'and the shell says when that arrival is');
});

t('the banner and a pending row never share the page', () => {
  // Two voices with different news. The banner owns the top once the loop has
  // closed; a row mid-tick is the exception, because that is this page's own
  // answer to what just happened.
  assert(hint.includes('if (banner && !ticking) return null;'), 'a pending row steps aside');
  assert(shell.includes('banner={showExitBanner}'), 'and the shell tells it when the banner is up');
});

t('the gesture is spelled out, and drawn', () => {
  // "Highlight a sentence" names it in the product's own vocabulary, which is
  // no help to somebody who has not made a highlight yet.
  assert(hint.includes("comment: 'Select any sentence to comment on it.'"), 'the literal gesture, and what it produces');
  assert(hint.includes("shown === 'comment' ? <span className=\"sh-thumb\""), 'only the row nobody has done carries a picture of it');
  assert(hintCss.includes('.sh-mark {') && hintCss.includes('#fff7d0'), 'a sentence marked in the anchor colour');
  assert(hintCss.includes('.sh-card {') && hintCss.includes('border: 1.5px solid var(--td-accent'), 'and the box that opens when you mark one');
});

t('the document frame has a name, not a tooltip', () => {
  // `title` on an iframe is an accessible name AND a native tooltip, and the
  // tooltip sat over the top bar whenever the pointer rested on the document.
  assert(shell.includes('aria-label="Document content"') && !shell.includes('title="Document content"'),
    'the name is what was wanted');
});

t('the hint keeps out of the way of everything else on the doc', () => {
  assert(hintCss.includes('.sh-hint.lifted { bottom: 83px; }'), 'it rides up when the footer slides in');
  assert(shell.includes('lifted={Boolean(bridge.layout.footerVisible)}'), 'and the shell tells it when');
  assert(/editor\.mode === 'edit' \? null : \(\s*<DocStepHint/.test(shell), 'it is gone while the doc is being written');
  const small = (hintCss.match(/font[^;]*?(\d+(?:\.\d+)?)px/g) || [])
    .map((m) => Number((m.match(/(\d+(?:\.\d+)?)px/) || [])[1]))
    .filter((n) => n && n < 12.5);
  assert(small.length === 0, `nothing under 12.5px: ${small.join(', ')}`);
});

t('hiding the hint is this browser\'s business, like the checklist\'s collapse', () => {
  assert(hint.includes("const HIDE_KEY = 'tdoc.onboarding.hint';") && hint.includes('localStorage'),
    'the dismissal is local, not a stamp on the account');
  assert(!hint.includes('postOnboardingEvent'), 'and tidying it away says nothing about the journey');
});

t('the first arrival sees the whole shape, without a modal', () => {
  // A pop-up here would be the second thing to open itself within a minute of
  // the gate. The list is simply open until it is closed, and remembers that.
  assert(list.includes('return v === null ? true :'), 'open by default, closed only once they say so');
  const effects = hub.match(/useEffect\([\s\S]*?\n  \}/g) || [];
  assert(!effects.some((e) => /setModal\s*\(/.test(e)), 'no dialog opens itself when the page loads');
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
  assert(worker.includes('const next = debugRecord(state, new Date().toISOString(), doc);'),
    'the record is built server-side; the client names a state, never a field');
  // The built states have to stand on a doc this person actually owns: a reset
  // wipes the record's own, and a hardcoded slug would point rows 3 and 4 at
  // somebody else's document.
  assert(worker.includes("const doc = (prior && prior.first_doc) || await newestDocFor(env, accountId);"), 'their newest doc stands in');
  // The pairing marker moves with the state, or `new`, `started` and
  // `connected` are one state to the gate: `paired` is half of what it calls
  // connected and is otherwise only ever written.
  assert(worker.includes('if (next && next.agent_connected) {') && worker.includes('await env.META.delete(key);'),
    'the switcher can put an account back before it paired');
  assert(worker.includes('the token lives'), 'and says out loud that the credential is untouched');
  assert(worker.includes('const doc = firstDoc || null;') && server.includes('const doc = firstDoc || null;'),
    'and neither host invents one');
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
