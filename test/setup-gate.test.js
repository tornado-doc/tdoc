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
const dialog = read('shell/src/onboarding-dialog.jsx');
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

t('every checklist row is backed by something real', () => {
  for (const field of ['agent_connected', 'commented', 'revised']) {
    assert(list.includes(field), `${field} backs a row`);
  }
  assert(!/Open your doc/.test(list), 'no row for something nothing records');
  // The seeder stamps published_first itself, so that stamp says a doc exists
  // and nothing about who made it. Ticking "Create your first tdoc" on the doc
  // we handed them would be a lie.
  assert(list.includes("const madeTheirOwn = (docs || []).some((d) => d && d.slug && d.slug !== r.first_doc);"),
    'creating is owning a doc that is not the seeded one');
  assert(/id: 'create'[^}]*done: madeTheirOwn/.test(list), 'and that is what the row reads');
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
  assert(dialog.includes("export const RECIPE_URL ="), 'the URL itself is still the wizard\'s, imported not retyped');
});

t('forking is drawn and deliberately not wired', () => {
  // Its whole value was a first doc in ten seconds with no agent, and the
  // seeding delivers exactly that, earlier and with no click. The only
  // forkable template today is the one already in their Onboarding folder.
  assert(/DOC_CHOICES[\s\S]{0,400}?\]/.test(gate) && !gate.includes("id: 'fork'"), 'no fork choice ships');
  assert(worker.includes("const SEED_TEMPLATE_SLUG = 'what-ai-knows';"), 'because that template is the seeded one');
  assert(gate.includes('second thing to fork'), 'and the reason is written down, not lost');
});

t('the doc step waits for a doc they made, not the one we seeded', () => {
  // published_first is stamped by the seeder itself, so no record field flips
  // when they finally make one of their own. The server has to look.
  assert(worker.includes('async function newestOwnDoc(env, accountId, exceptSlug)'), 'the worker can name that doc');
  assert(worker.includes("if (!slug || slug === exceptSlug) continue;"), 'and it excludes the seeded one');
  assert(server.includes('function newestOwnDocLocal(exceptSlug)'), 'the local server twins it');
  assert(gate.includes("const state = step === 'doc'\n    ? (ownDoc ? 'done' : 'waiting')"), 'the step turns on that doc alone');
  assert(gate.includes('const onward = step === \'doc\' && ownDoc ? `/d/${encodeURIComponent(ownDoc)}` : \'/me\';'),
    'and ends by opening it');
});

t('the catalog walk is paid for only by the page that needs it', () => {
  // The connect gate polls this route every three seconds. Scanning every doc
  // in the catalog on that poll would be a real cost for an answer it never
  // reads.
  assert(worker.includes("if (url.searchParams.get('docs') === '1') {"), 'the worker only walks when asked');
  assert(server.includes("if (url.searchParams.get('docs') === '1') {"), 'and the local server matches');
  assert(gate.includes('getOnboarding(wantsDoc ? { docs: 1 } : undefined)'), 'only the doc step asks');
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
  assert(shell.includes('const hintStep = docStep(onboardingRecord, config.slug, ownerCommented);'), 'the shell decides the row');
  assert(/goToStep = useCallback\(\(\) => \{[\s\S]{0,400}setOpenCommentId/.test(shell), 'and going there opens a card');
  assert(shell.includes("localStorage.setItem(HANDOFF_OPEN_KEY, '1')"), 'with the line already open when they land on it');
});

t('a row being watched stops being a button', () => {
  // "Waiting for your agent" that can be clicked invites a second paste.
  assert(hint.includes("const watching = step === 'handoff' && agentState !== 'idle';"), 'a copied line is a wait, not a task');
  assert(hint.includes("{watching\n        ? <span className=\"sh-row\">{body}</span>"), 'and a wait is not clickable');
  // The card already says these. Said twice in two voices, a reader starts to
  // wonder whether they are two different waits.
  for (const line of ['Waiting for your agent…', 'Your agent is reading this', 'Still waiting — did you paste it into your agent?']) {
    assert(hint.includes(line) && card.includes(line), `"${line}" is the card's own wording`);
  }
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
