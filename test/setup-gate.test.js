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
const replay = read('shell/src/setup-gate/replay.jsx');
const bar = read('shell/src/debug-bar.jsx');
const template = read('worker/wrangler.toml.template');
const deploy = read('.github/workflows/deploy-tdoc-dev.yml');
const windowElement = read('shell/src/setup-gate/codex-window.jsx');
const windowCss = read('shell/src/setup-gate/codex-window.css');
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
const cli = read('bin/tdoc-publish');
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

t('a picture is never dimmed, and a logo is never in a box', () => {
  // Fading the finished rows says "this no longer counts" about the only part
  // of the list somebody has actually done; fading the locked ones repeats
  // what their grey label already says. The strike and the filled tick carry
  // the state.
  assert(!/\.onb-thumb \{ opacity|\.onb-thumb \{[^}]*opacity|li\.(done|locked) \.onb-thumb \{ opacity/.test(listCss),
    'no state dims a picture');
  // Notion frames a thumbnail only when the thing it shows has a frame of its
  // own: its calendar and its templates are screenshots, its Gmail and Outlook
  // are bare logos. A logo in a box is a card inside a card.
  assert(listCss.includes('padding: 0; background: transparent; border: 0;'), 'the two marks sit on nothing');
  assert(/\.onb-thumb \{[\s\S]{0,200}border: 1px solid var\(--td-line/.test(listCss), 'and the document fragments keep their frame');
});

t('every thumbnail shows the thing its own step produces', () => {
  // Notion's read because each contains something already recognisable and no
  // two look alike. Four identically framed boxes of grey bars is one smudge
  // repeated, which is what these were.
  // Notion runs the app logos in a checklist thumbnail at about half the
  // thumbnail's height, and the slot below is 58px. At 16 they were a smudge
  // beside three full-size thumbnails.
  const marks = list.match(/<AgentMarks size=\{(\d+)\} \/>/);
  assert(marks, 'row 1: the agents\' own marks');
  assert(Number(marks[1]) >= 28, `row 1: the marks are Notion-sized, not ${marks[1]}px`);
  assert(list.includes('<em>Use tdoc to…</em>'), 'row 2: the line you paste');
  assert(list.includes('<mark>') && list.includes('className="t-card"'), 'row 3: a marked sentence and the card beside it');
  assert(list.includes('Applied in v2'), 'row 4: the chip a fixed thread carries, in the product\'s own words');
  // Real words, not grey bars. Bars are a wireframe of a document; a document
  // scaled down is small text, which is why Notion's thumbnails are
  // screenshots. Every string here is one the product itself says.
  assert(list.includes('{heading}'), 'and the doc in them is their own doc');
  assert(list.includes('firstDoc?.title'), 'by its real title');
  assert(!listCss.includes('.t-line'), 'no grey bars standing in for text');
  // Two of them run off the right edge rather than sitting in a box inside a
  // box, which is how Notion lets its calendar and its templates crop.
  assert(listCss.includes('right: -12px') && listCss.includes('right: -14px'), 'and two of them are cropped by the edge');
  assert(listCss.includes('width: 100px; height: 62px;') && listCss.includes('grid-template-columns: 18px 1fr 100px;'),
    'the row reserves exactly what the thumbnail takes');
  // The picture sets the row's height, so the row adds almost nothing of its
  // own: one line of text beside four lines' worth of picture reads as a list
  // with holes in it.
  assert(listCss.includes('padding: 4px 0; text-decoration: none;'), 'and adds almost no air of its own');
  // A box that is not a whole number of its own lines cuts the last line
  // through the middle of the letters, which reads as a fault, not a crop.
  assert(listCss.includes('font: 700 8px/10px') && listCss.includes('height: 10px;'), 'every text box is whole lines');
});

t('the mark rides the bar', () => {
  // Notion puts its duck on the marker for the same reason: a bar alone is a
  // measurement, and a thing standing on it is somebody's progress.
  assert(list.includes('className="onb-mark"') && list.includes('src="/tdoc_logo.svg"'), 'the product\'s own mark, not a dot');
  assert(list.includes('data-tdoc-dark="invert"'), 'and it follows the page into dark mode');
  // Positioned across the track minus its own width, so it never hangs off
  // either end: at zero its left edge sits on the start, at full its right
  // edge sits on the finish.
  assert(list.includes('* 26}px)`'), 'the puck is inset by its own width across the range');
  assert(listCss.includes('.onb-mark {') && listCss.includes('width: 26px; height: 26px;'), 'and the stylesheet agrees on that width');
  assert(!/\.onb-bar \{[^}]*overflow: hidden/.test(listCss), 'the track does not clip what stands on it');
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
  // Every row opens the page for its own step, finished or not: that page is
  // where the step's state is written, and a finished one should say so.
  assert(/id: 'create'[^}]*href: '\/setup\?step=doc'/.test(list), 'the create row leads to its own page, always');
  const rows = list.match(/\{ id: '[a-z]+', label:[^\n]*\},/g) || [];
  assert(rows.length === 4 && rows.every((row) => row.includes('href:')),
    'every row carries an href — no row is a dead line while its neighbours are links');
  // That page exists to watch a FIRST doc arrive. Somebody who has one and
  // wants another is served by Create a doc, at the top of this same page.
  assert(!gate.includes('Make another tdoc'), 'the gate no longer offers a second doc');
  assert(!list.includes('onCreate'), 'and the row does not reach into the hub\'s menu');
});

t('the second ask is the same ask, on the same route', () => {
  // Two pages would mean two of everything: two layouts, two polls, two sets
  // of words for "paste this and watch". It is one page with a second line.
  assert(worker.includes("const step = url.searchParams.get('step') === 'doc' ? 'doc' : 'connect';"), 'the worker reads the step');
  assert(server.includes("const step = url.searchParams.get('step') === 'doc' ? 'doc' : 'connect';"), 'and so does the local server');
  assert(worker.includes('          step,') && server.includes("step: step === 'doc' ? 'doc' : 'connect',"), 'both boot it');
  // One title for both steps, on both hosts. `?step=doc` is a request, not a
  // fact -- the page falls back to step 1 for anybody who has not connected
  // yet, and a tab reading "make a doc" over a screen headed "Connect your
  // agent" is the URL talking over the product. Telling them apart needs the
  // account's record, which this route renders before reading.
  assert(worker.includes("title: 'tdoc - set up',") && server.includes("title: 'tdoc - set up',"),
    'neither host lets the URL name a step the page may not be on');
  assert(!worker.includes("title: step === 'doc'") && !server.includes("title: step === 'doc'"),
    'and neither picks the title from the query string');
  assert(gate.includes("const step = wantsDoc && connected ? 'doc' : 'connect';"),
    'and an unconnected visitor is asked to connect first, whichever link they arrived on');
  assert(gate.includes('export const FIRST_DOC_PROMPT = ANOTHER_DOC_RECIPE;'), 'the doc line is the skill\'s own, reused not rewritten');
});

t('opening the gate is beginning, whatever the browser reports', () => {
  // `started` was stamped by the page, and only when somebody pressed Copy. A
  // person who selected the line and hit cmd-C connected their agent,
  // published, and then found no checklist on My docs at all -- it renders on
  // `started`. The door is the honest signal, and the server is standing in it.
  assert(/const who = await sessionAccountId\(env, session\);\s*\n\s*if \(who\) await stampOnboardingFor\(env, who, 'started'\);/.test(worker),
    'a signed-in visit to /setup starts the journey');
  // That fixed the half of the walk that goes through the door. The other half
  // never opens it -- agent connects and publishes over the CLI, /me is the
  // first page seen -- so the card counts a first hosted publish as evidence
  // too, and `started` is one signal among them rather than the only one.
  assert(/record\.started \|\| record\.published_first/.test(list),
    'and the card renders on that, or on a first publish that never passed it');
  // And no further: a CLI-first publisher who never loads this page must not
  // start, or tdoc's question lands on the first doc of somebody who never
  // asked to be onboarded.
  assert(worker.includes("if (!(record && record.started && !record.seeded_comment)) return;"), 'the seeded question still waits for a journey');
  assert(!/if \(step && step !== 'started'/.test(worker), 'and no step quietly implies one');
});

t('the wait is timed from the page, not from a button', () => {
  // The page cannot see a paste, and cannot see a selection copied by hand
  // either. Timing the doctor line from a click meant the one person most
  // likely to be stuck -- the one who never pressed Copy -- was the one it
  // never appeared for.
  assert(gate.includes('const waitingSince = useRef(null);') && !gate.includes('copiedAt'), 'the clock is the page\'s');
  assert(gate.includes("if (loaded && signedIn && state !== 'done' && !waitingSince.current) waitingSince.current = Date.now();"),
    'and it starts when the waiting does');
  assert(gate.includes('if (waitingSince.current) setElapsed(Date.now() - waitingSince.current);'), 'the poll reads it');
  assert(!/copied \? \(step === 'doc'/.test(gate) && !gate.includes("'Waiting for you to paste the prompt.'"),
    'and the status stops claiming to know whether they pasted');
});

t('the second ask is the one place with a choice in it', () => {
  // Marching everybody through the same portrait is what made the old version
  // feel like a kidnapping to anyone who already knew what they wanted.
  assert(/DOC_CHOICES = \[[\s\S]*?id: 'own'[\s\S]*?id: 'portrait'[\s\S]*?\]/.test(gate), 'two live choices');
  assert(gate.includes('const [choice, setChoice] = useState(null);'), 'and neither is chosen for them');
  // Choosing is the question this screen asks; everything downstream of it
  // waits until it has been answered.
  assert(gate.includes("{step === 'doc' && !choice ? null : ("), 'no instructions before there is something to paste');
  // The replay is a recording of pasting THIS line, so it cannot run before
  // there is one -- not for a visitor with no account to paste into, and not
  // before they have said what the doc is about.
  // Before there is a line, the same desk is shown with no app open -- which
  // is true, and is the same desk. A different window in a different style
  // here was two windows in one product.
  assert(gate.includes("? <ConnectReplay prompt={null} />"),
    'and the picture beside them types nothing either — nor for somebody with no account to use it');
  assert(replay.includes('const idle = !prompt;'), 'no line, no app open');
  // A doc that already exists is not a question. The whole ask goes, rather
  // than sitting there under a line saying it is already done.
  assert(gate.includes("{state === 'waiting' && !(step === 'doc' && !choice) ? ("), 'and no wait either');
});

t('a subject typed on the page composes the line, and an empty one does not', () => {
  // Run the real thing rather than grepping it: the prefix and the suffix are
  // the two halves a reader has to trust.
  // eslint-disable-next-line no-new-func
  const compose = new Function(`${gate.match(/export const DOC_SUBJECT_PREFIX[\s\S]*?export const docSubjectPrompt = [^;]+;/)[0].replace(/export /g, '')}; return docSubjectPrompt;`)();
  // A sentence, not a slash command: the line is pasted into a conversation
  // with an agent, and the skill's own front matter says a plain request is
  // enough -- "no need for the word tdoc". Naming it is still worth doing, so
  // an agent with many skills does not have to guess which one this is.
  assert(compose('pricing') === 'Use tdoc to write a doc about pricing, publish it, and give me the link',
    `the prefix and suffix wrap what they typed: ${compose('pricing')}`);
  assert(!gate.includes("'/tdoc new"), 'and no slash command is handed to anybody');
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
  assert(list.includes("done: Boolean(r.first_doc)"), 'and row 2 reads the same field the gate does');
});

t('the doc step answers on arrival', () => {
  // It briefly asked a harder question -- "did a doc appear since this page
  // opened" -- because it also had to serve somebody making their SECOND one,
  // and a record whose doc stamps are written once cannot see a second doc.
  // That job moved to Create a doc, so the hard question went with it.
  assert(gate.includes("const ownDoc = record?.first_doc || null;"), 'the journey names the doc');
  assert(gate.includes("? (ownDoc ? 'done' : 'waiting')"), 'and having one is what done means');
  // Which is what lets row 2 open this page after it is finished and be told
  // so, rather than being asked again for something it already has.
  assert(!gate.includes('newestDoc') && !gate.includes('known.current'), 'no catalog, no memory of what was here before');
  assert(!gate.includes("getOnboarding(wantsDoc"), 'and the poll is back to two reads');
});

t('a deleted seed doc does not leave rows pointing at a 404', () => {
  assert(list.includes('(docs || []).find((d) => d && d.slug === first)'), 'the link is only offered while the doc is still there');
  assert(hub.includes('docs={hub.docs}'), 'the hub hands its list over');
});

t('the doc carries one row of the checklist, and only where it belongs', () => {
  const step = lift(hint, 'docStep');
  const started = { started: 'X', first_doc: 'seed' };
  const commented = { ...started, commented: 'X' };
  assert(step(null, 'seed', true) === null, 'nothing before there is a journey');
  assert(step({}, 'seed', true) === null, 'nor before it starts');
  assert(step(started, 'other', true) === null, 'and nothing on a doc that is not the journey\'s');
  assert(step(started, 'seed', true) === 'comment', 'the untouched doc asks for the highlight');
  assert(step(commented, 'seed', true) === 'handoff', 'their own words move it to the agent');
  assert(step({ ...commented, revised: 'X' }, 'seed', true) === null, 'and the closed loop hands the page to the exit banner');
  // The record says which step; the page says whether it can honour it. A row
  // naming a line that is not on this page is the one thing it promised never
  // to do -- so on an older version, where the handoff block does not render,
  // it says nothing rather than pointing at nothing.
  assert(step(commented, 'seed', false) === null, 'and it never names a line that is not here');
});

t('one record answers "have they commented", not two', () => {
  // The checklist on My docs asks the record. This row used to ask the page --
  // is there a comment here signed by the owner? Two sources of one fact
  // disagree the moment anything moves one and not the other, and then the
  // list offers "leave a comment on your doc" while the doc it opens is
  // already asking for the handoff. Anything that comments on the journey's
  // doc stamps the record, so the record is the one that knows.
  assert(/if \(!record\.commented\) return 'comment';/.test(hint), 'the row reads the record');
  assert(list.includes('Boolean(r.commented || r.revised)'), 'and so does the checklist');
  // The stamp is a round trip, and the whole time somebody is looking at what
  // they just wrote is inside it.
  assert(shell.includes('const markCommented = ()') && shell.includes('commented: new Date().toISOString()'),
    'a comment posted in this tab moves the record before the server is asked');
  assert(shell.includes('markCommented();\n    closeComposer();') && shell.includes('{ markCommented(); reportMentions(value); }'),
    'both ways of saying something -- a comment of their own, and the reply the seeded card asks for');
});

t('the hint is a wayfinder, never a second copy of the line', () => {
  // The same line for the agent in two places on one screen is two things to
  // drift apart. The hint says which card is yours now and opens it.
  assert(!hint.includes('handoffLine') && !hint.includes('copyText'), 'the hint carries no line and no clipboard');
  assert(shell.includes('const hintStep = docStep(onboardingRecord, config.slug, handoffOnPage);'), 'the shell decides the row');
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
  assert(hint.includes('{still ? null : ('), 'and neither a wait nor a tick offers a button');
  // The card already says these. Said twice in two voices, a reader starts to
  // wonder whether they are two different waits.
  for (const line of ['Waiting for your agent…', 'Your agent is reading this', 'Still waiting — did you paste it into your agent?']) {
    assert(hint.includes(line) && card.includes(line), `"${line}" is the card's own wording`);
  }
});

t('whatever owns the screen owns it', () => {
  // On a phone the comment drawer takes the screen, and the corner row was
  // staying mounted underneath: present to a screen reader, invisible to
  // everyone else.
  assert(/const showing = [^;]*!covered/.test(hint), 'the row steps aside');
  assert(shell.includes('hidden={narrow && drawerOpen}'), 'when the drawer has the phone');
});

t('the step is the first thing on the page, not the last', () => {
  // It used to float in the bottom-left corner, which is where a page puts the
  // things it does not mean: a toast, a cookie bar, a "copied" flash. Anything
  // in that corner is ignorable by training, and it was being ignored -- on a
  // page whose whole job was to teach one gesture. So it sits where a banner
  // sits, first under the chrome and above the document.
  assert(!hintCss.includes('position: fixed'), 'it is not floating in a corner');
  assert(/<OldVersionNotice/.test(shell), 'it is docked under the chrome');
  // A card, not a bar. Tinting the full width is the crudest way to be noticed
  // and it costs the page its composure: the strip is then mostly two fields of
  // flat colour with nothing in them, because the words sit in the middle where
  // the document is.
  assert(/\.sh-inner \{[^}]*max-width: 720px;[^}]*border-radius: 14px;/s.test(hintCss), 'the blue is a card the width of the document');
  assert(/\.sh-hint \{(?:(?!\}).)*\}/s.test(hintCss) && !/\.sh-hint \{[^}]*background:/s.test(hintCss),
    'and the strip behind it is not painted');
  assert(hintCss.includes('background: var(--td-accent-tint, #e8eeff);'), 'in the same blue the live row on My docs wears');
  assert(/<OldVersionNotice[\s\S]*?showExitBanner[\s\S]*?<DocStepHint/.test(shell), 'above the document in the flow');
  // A whole pill that happens to be clickable is not an invitation. A button
  // shaped like the product's other buttons is -- and a number says "you are
  // three of four through something" where an empty circle said "an unchecked
  // box, maybe later".
  assert(hint.includes('className="sh-go"') && hintCss.includes('.sh-go {'), 'the click target is a button');
  assert(hint.includes('const STEP_NO = {') && hint.includes('className="sh-step"'), 'and the row says which step it is');
  assert(hintCss.includes('font: 600 14px/1.3'), 'the line reads at the weight of something being asked');
});

t('a row that finishes ticks where it stands', () => {
  // Doing the thing and watching the to-do vanish is not the same as watching
  // it get done, and this is the page where it happened.
  assert(hint.includes('const DONE_LINES = {'), 'a finished row has words of its own');
  assert(hint.includes('const [finished, setFinished] = useState('), 'and it is held in state');
  // Read off the ref at render it would lose its name: the ref has already
  // moved on, and the row finishes as a bare "Done."
  assert(hint.includes('DONE_LINES[finished]'), 'the struck row still says which row it was');
  assert(hintCss.includes('.sh-hint.ticked .sh-text { color: var(--td-muted, #6b6a66); text-decoration: line-through; }'), 'struck through');
  assert(/\.sh-tick \{[^}]*background: var\(--td-accent/.test(hintCss), 'with the tick filled in');
  // The last step produces no state change to tick on: v2 arriving navigates
  // this page to the new version, so the component watching is already gone.
  assert(hint.includes("useState(justFinished ? 'handoff' : null)"), 'so the arrival ticks it on the way in');
  assert(shell.includes("justFinished={arrival === 'revised'}"), 'and the shell says when that arrival is');
});

t('the banner and a pending row never share the page', () => {
  // Two voices with different news. The banner owns the top once the loop has
  // closed; a row mid-tick is the exception, because that is this page's own
  // answer to what just happened.
  assert(/const showing = [^;]*ticking \|\| Boolean\(shown && !banner\)/.test(hint), 'a pending row steps aside');
  assert(shell.includes('banner={showExitBanner}'), 'and the shell tells it when the banner is up');
});

t('the gesture is spelled out', () => {
  // "Highlight a sentence" names it in the product's own vocabulary, which is
  // no help to somebody who has not made a highlight yet. The literal version
  // says what to do with a mouse and what will happen when they do.
  assert(hint.includes("comment: 'Select any sentence to comment on it.'"), 'the literal gesture, and what it produces');
  // One label for both rows, because it is one behaviour: open the card that
  // carries the next thing. A button naming its destination would name two.
  assert(hint.includes("const GO = 'Show me';"), 'and one way in');
});

t('the document frame has a name, not a tooltip', () => {
  // `title` on an iframe is an accessible name AND a native tooltip, and the
  // tooltip sat over the top bar whenever the pointer rested on the document.
  assert(shell.includes('aria-label="Document content"') && !shell.includes('title="Document content"'),
    'the name is what was wanted');
});

t('the hint keeps out of the way of everything else on the doc', () => {
  // In flow, so it pushes the document down rather than covering a word of it
  // -- and every comment card is placed from the top of that document, so the
  // overlay has to be told the bar took its height. One number, exported, or
  // the whole margin sits 48px off.
  assert(hint.includes('export const STEP_HINT_HEIGHT = 68;'), 'the height has one home');
  // The card's 48 plus the 10 of air above and below it.
  assert(/\.sh-inner \{[^}]*height: 48px;/s.test(hintCss) && /\.sh-hint \{[^}]*padding: 10px 20px;/s.test(hintCss),
    'and the stylesheet adds up to it');
  assert(shell.includes('(hintBar ? STEP_HINT_HEIGHT : 0)'), 'the overlay counts it');
  assert(hint.includes('onVisible(showing)') && shell.includes('onVisible={setHintBar}'),
    'and only the row itself knows whether it drew');
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
  assert(/if \(!walking \|\| done === steps\.length\) return null;/.test(list),
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

t('revoking an account\'s terminals does not read every token on the host', () => {
  // There is no account-to-token index and a token's key is its own hash, so
  // "which of these are this account's" meant fetching every token record one
  // at a time. On a host with a few hundred that took the replay button past
  // 45 seconds -- it shows a spinner and looks like a hang, which is the same
  // thing as broken for the person pressing it.
  assert(worker.includes('metadata: { account_id: record.account_id },'), 'the account rides on the key metadata');
  assert(worker.includes('let owner = k.metadata && k.metadata.account_id;'), 'and the listing answers the question');
  // Completeness is not traded for speed: a key written before this still gets
  // read, so revocation stays total. That set only shrinks.
  assert(/if \(!owner\) \{\s*\n\s*try \{ owner = \(JSON\.parse\(await env\.META\.get\(k\.name\)\)/.test(worker),
    'a key that predates the metadata is still read');
});

t('a session carries its account, so a new doc looks like theirs', () => {
  // A session is stamped with its account at sign-in, but an account that does
  // not exist yet cannot be stamped -- and one is only born when somebody first
  // publishes or creates something. So somebody who signed in and then made
  // their first doc had no account id on their session until they signed in
  // again, and `isDocOwnerSession` compares `session.account_id` FIRST: their
  // own document did not look like theirs, and My docs was empty for every new
  // account that came through the provider door.
  const fn = worker.slice(worker.indexOf('async function getSession'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert(body.includes('if (!session.account_id)'), 'only when it is missing');
  assert(body.includes('await sessionAccountId(env, session)'), 'the session resolves its own account');
  // Resolved once here rather than in each place that asks: the ownership test
  // is synchronous and cannot look it up, which is why it could only read what
  // the session already carried.
  assert(worker.includes('const acct = session && session.account_id;'), 'the ownership test still reads it from the session');
  assert((worker.match(/isDocOwnerSession\(/g) || []).length >= 8, 'and there are many askers, all now reading a filled-in value');
});

t('an account is found in the registry it was written to', () => {
  // `hostedAccountForEmail` writes `account-email:<addr>`; `lookupHostedAccount`
  // reads `hosted-account:` and `hosted-github:`. Two different keys, so an
  // account born through the provider door could be minted and then not be
  // found by the very next request -- and everything keyed on the account id,
  // the onboarding record most of all, silently belonged to nobody until a
  // first publish happened to write the other index.
  const fn = worker.slice(worker.indexOf('async function sessionAccountId'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert(body.includes('lookupHostedAccount'), 'the handle registry first');
  assert(body.includes('account-email:${email}'), 'then the email registry, which is where a provider-born account lives');
  assert(body.indexOf('lookupHostedAccount') < body.indexOf('account-email:'), 'in that order');
  assert(worker.includes('await env.META.put(`account-email:${email}`'), 'and that is the key the mint writes');
});

t('a brand-new account is the one state it must not refuse', () => {
  // An account record is only written when somebody first publishes or
  // creates something, so a tester who has just signed in and done nothing
  // else has no account id -- and the route answered 401 "sign_in_required"
  // to somebody plainly signed in, which is wrong and unactionable: signing in
  // again produces the same account with the same absence.
  //
  // It also refused exactly the state onboarding most needs simulating from.
  // The point of the internal bar is to stand at the beginning of the journey,
  // and the beginning is an account that has done nothing.
  const route = worker.slice(worker.indexOf("p === '/api/onboarding/state'"));
  assert(/let accountId = await sessionAccountId\(env, session\);/.test(route), 'it looks the account up');
  assert(route.indexOf('hostedAccountForEmail(env, session && session.email') < route.indexOf('let body = {}'),
    'and mints one on first use, the way creating a doc does');
  assert(!/if \(!accountId\) return json\(\{ error: 'sign_in_required' \}/.test(route),
    'rather than telling a signed-in person to sign in');
  // A store that cannot be reached is a different answer from a person who is
  // not signed in.
  assert(route.includes("{ error: 'hosted_account_unavailable' }, { status: 503 }"), 'and says so when the store is down');
});

t('the allow-list takes the shape the settings page gives it', () => {
  // The variable is edited in a multi-line box, so a list of addresses arrives
  // with newlines in it. sed cannot put a newline in a replacement
  // (unterminated `s') and TOML cannot hold one in a basic string, so the next
  // deploy after somebody used the box would have failed -- and the reader
  // only split on commas, so even a value that survived matched nobody. A list
  // that silently matches nobody looks exactly like one that was never set.
  assert(deploy.includes("tr '\\r\\n' ',,'"), 'the deploy flattens newlines before substituting');
  assert(/ACCOUNTS="\$\(printf/.test(deploy) && deploy.includes('s/PLACEHOLDER_DEBUG_ACCOUNTS/${ACCOUNTS}/g'),
    'and substitutes the flattened value');
  assert(worker.includes('.split(/[\\s,;]+/)'), 'and the reader takes commas, newlines, semicolons or spaces');
});

t('a page offers only the states it can show', () => {
  // All six everywhere made most of the bar noise: the landing page looks the
  // same at every step of the journey, so five of its six buttons changed
  // nothing a tester could see, and pressing one on a document meant guessing
  // which of them that document reacts to. A button whose result you cannot
  // read is worse than no button.
  const states = (name) => {
    const m = bar.match(new RegExp(`${name}: (\\[[^\\]]*\\]|DEBUG_STATES)`));
    return m ? m[1] : null;
  };
  assert(states('landing') === '[]', 'the landing page is the same page at every step');
  assert(states('connect') === "['new', 'started', 'connected']", 'the gate shows waiting and connected');
  assert(states('doc') === "['connected', 'published']", 'the second ask shows waiting and published');
  assert(states('document') === "['published', 'commented', 'revised']", 'a doc shows its row: comment, handoff, gone');
  assert(states('hub') === 'DEBUG_STATES', 'and the checklist has a face for all six');
  // Each surface says which one it is.
  assert(gate.includes("surface={step === 'doc' ? 'doc' : 'connect'}"), 'the gate names its step');
  assert(shell.includes("surface={config.isLanding ? 'landing' : 'document'}"), 'a document names itself');
  assert(hub.includes('surface="hub"') && worker.includes('debug: await isDebugAccount(env, s),'),
    'and the hub, where the checklist is');
  // Whatever the page can show, the record's current value is always printed:
  // "you are at revised, and these are the ones this page can show you".
  assert(bar.includes('record: {recordName(record)}'), 'the current state is always named');
});

t('letting a tester in does not need Cloudflare credentials', () => {
  // The list lived only in KV, which can only be written by somebody holding
  // Cloudflare credentials -- so "let Julie test too" was a terminal session
  // for one person rather than a field on a settings page, and the deploy that
  // already knows who runs this could not help.
  assert(worker.includes('function debugAccountList(env)'), 'the deploy can name them');
  assert(template.includes('TDOC_DEBUG_ACCOUNTS = "PLACEHOLDER_DEBUG_ACCOUNTS"'), 'through a var on the worker');
  assert(deploy.includes('TDOC_DEV_DEBUG_ACCOUNTS: ${{ vars.TDOC_DEV_DEBUG_ACCOUNTS }}'),
    'filled from a repository VARIABLE, not a secret -- an email is not a credential');
  assert(deploy.includes('s/PLACEHOLDER_DEBUG_ACCOUNTS/${ACCOUNTS}/g'), 'and substituted like the others');
  // An unset variable leaves the placeholder in the toml, and a placeholder is
  // not a name -- otherwise the literal string would be an allow-listed
  // "email" on every deploy that forgot to set it.
  assert(worker.includes("fromEnv.includes('PLACEHOLDER_') ? '' : fromEnv"), 'an unset variable allows nobody');
  // Additive, because a change sometimes cannot wait for a deploy.
  assert(worker.includes("env.META.get('debug-accounts')"), 'and the KV key still works');
  // It cannot come from TDOC_OWNER: that is the deploy's GitHub login, and an
  // account that signed in through the provider has an email and no login.
  assert(!/isDebugAccount[\s\S]{0,400}TDOC_OWNER/.test(worker), 'not inferred from the owner login');
});

t('replay is new again, not just a blank record', () => {
  // Testing onboarding means being new more than once, and three things
  // survive a record reset. Each makes the next walk a different walk.
  assert(bar.includes("postState({ state: 'new', unpair: true, purge: true })"),
    'the credential and the doc go with the record');
  // It deletes a document -- bytes, comments and the slug -- through the
  // product's own delete. Exactly right on a test account, unrecoverable on
  // any other, so it takes two presses and the first one names the doc.
  assert(bar.includes('if (!armed) {') && bar.includes('`delete ${doc}?`'),
    'the first press names what the second will destroy');
  assert(bar.includes('setTimeout(() => setArmed(false), 4000)'),
    'and a press left behind by a wandering finger disarms itself');
  // It lived inside the gate, so a walk could only be restarted from step 1 --
  // and step 1 is not where a walk starts. Everything between the landing page
  // and the gate (the call to action, the sign-in, the first sight of the
  // product) was untestable, and /setup stamps `started` on sight, so a replay
  // that landed there could never show what `new` looks like.
  assert(shell.includes('{config.debug ? (') && shell.includes('<DebugBar'),
    'the bar is on every document, the landing page included');
  assert(worker.includes('debug: await isDebugAccount(env, session) }'),
    'and the server tells the document who is allow-listed');
  assert(bar.includes('location.reload();'), 'a replay stays where it was pressed');
  // The credential is the one that matters: `account-terminal:` is a marker,
  // and the token it stands for is what actually keeps a CLI connected. Leave
  // it and step 1 can never be walked again -- the one step that cannot be
  // exercised locally at all.
  assert(worker.includes("if (body.unpair === true) {") && worker.includes("prefix: 'hosted-token:'"),
    'unpair takes the credential, not the marker');
  assert(worker.includes('if (body.purge === true && prior && prior.first_doc) {'), 'purge takes the journey\'s doc');
  assert(worker.includes('meta.hosted.account_id === accountId'), 'and only one this account owns');
  // The product already knows how to delete a doc. A second, thinner version
  // is how one of them ends up leaving the DO populated.
  assert(worker.includes('async function deleteDocEverywhere(env, slug) {')
    && (worker.match(/deleteDocEverywhere\(env, /g) || []).length >= 2,
    'both callers delete a doc the same way');
  // The dismissals live in the browser. Every key here is somebody saying
  // "not now" about a piece of the onboarding, and each silently removes that
  // piece from every later walk -- so the list has to be the real constants.
  const keys = ['tdoc.onboarding.hint', 'tdoc.onboarding.collapsed', 'tdoc.onboarding.open', 'tdoc-handoff-open'];
  for (const key of keys) {
    assert(bar.includes(`'${key}'`), `replay does not clear ${key}`);
    const owner = [hint, list, shell].some((src) => src.includes(`'${key}'`));
    assert(owner, `${key} is not a key anything actually writes`);
  }
  assert(bar.includes("export const REPLAY_LOCAL_PREFIX = 'tdoc.handoff.';") && shell.includes('`tdoc.handoff.${config.slug}`'),
    'and the per-doc waits go by prefix, so a replay need not know which docs the last walk made');
});

t('a config file is a claim, not a fact', () => {
  // Replay revokes the credential server-side. Nothing told the CLI: it held a
  // file saying it was signed in, `--signin-only` reported "already signed in",
  // and every later publish 401'd with the server's JSON printed at somebody.
  // The same hole swallows any revocation -- an account reset, a terminal taken
  // away -- not just a test reset.
  assert(worker.includes("p === '/api/hosted/whoami'"), 'a credential can be checked');
  assert(worker.includes("return json({ error: 'invalid_token' }, { status: 401 });"), 'and a dead one says so');
  assert(cli.includes('if [ -f "$CONFIG_FILE" ] && hosted_credential_valid; then'), 'signin-only checks before believing');
  assert(cli.includes('rm -f "$CONFIG_FILE"'), 'and a stale file is dropped rather than kept');
  // Being offline is not a revoked token: only a clear 401/403 may throw a
  // working credential away.
  assert(/case "\$http" in\s*\n\s*401\|403\) return 1 ;;\s*\n\s*\*\) return 0 ;;/.test(cli),
    'anything that is not a clear rejection keeps the credential');
  assert(cli.includes("grep -qE 'invalid_token|sign_in_required|token_required'"), 'and a publish that hits one says what to do');
});

t('a finished gate stops asking, and the column fits a laptop', () => {
  // The poll asks the server what the agent has done. Once it has done it the
  // question stops being a question, and the page was still asking it every
  // three seconds for as long as the tab stayed open.
  assert(gate.includes('if (!settled.current) timer = window.setTimeout(tick, POLL_MS);'), 'the loop ends when the answer arrives');
  assert(gate.includes("settled.current = state === 'done';"), 'and it reads the current state, not the one the effect closed over');
  // The tallest this column gets -- the second ask with a subject typed into
  // it -- was measured 32px past the bottom of an 800px window, which put the
  // only button on the screen out of sight. A vh clamp cannot buy that back:
  // the overflow is one fixed column against a shrinking window.
  assert(/@media \(max-height: 870px\) \{[^}]*\.sg-mid \{ padding-top: 26px; \}/s.test(gateCss),
    'a short window gets the top margin back');
});

t('one window, drawn from a real one', () => {
  // There was a copy of the window per scene, which is how the second one
  // ended up bouncing an app in a dock on a screen where no app is launched.
  // A scene hands it a title and a stream of turns; every part of the chrome
  // belongs to the window.
  assert(!replay.includes('function DocWindow'), 'no second window');
  assert((replay.match(/<CodexWindow/g) || []).length === 2, 'both scripts use the same one');
  // `Window` is a name that does not go undefined when its definition is
  // deleted -- it quietly resolves to the DOM's own global and React tries to
  // construct it. Which is what happened.
  assert(!/<Window[\s/>]/.test(replay), 'and nothing is called Window');
  // Measured against a real one rather than remembered: controls on both sides
  // with the thread's name centred between them, the conversation a column
  // down the middle, the human's turn a dark bubble on the right, the
  // assistant's plain text with no bubble, a tool call collapsed behind one
  // grey line, and a composer that is there whether or not anything was sent.
  assert(/\.cw-title \{[^}]*text-align: center;/s.test(windowCss), 'the title is centred between the controls');
  assert(/\.cw-col \{[^}]*width: 78%;[^}]*margin: 0 auto;/s.test(windowCss), 'the conversation is a column, not the full width');
  assert(/\.cw-ask \{[^}]*justify-content: flex-end;/s.test(windowCss), 'the human is on the right');
  assert(!/\.cw-answer \{[^}]*background:/s.test(windowCss), 'and the assistant has no bubble');
  assert(windowElement.includes('{open ? <pre className="cw-tool">'), 'a tool call shows its output only when opened');
  assert(/\.cw \{[^}]*display: flex; flex-direction: column;/s.test(windowCss)
    && windowElement.includes('<Composer typing={typing} />'), 'the composer is the window\'s, not a turn\'s');
  // And the window hands it the line still in flight. A paste that appears
  // straight away as a sent bubble skips the one gesture this scene teaches:
  // `Composer` took this prop from the day it was written and was never given
  // it, so the field only ever held its placeholder.
  assert(/<Composer typing=\{typing\} \/>/.test(windowElement)
    && /typing=\{[^}]*phase\(t, T\.paste\)[^}]*\}/.test(replay),
    'and what is being pasted goes into it, before it is sent');
});

t('the dock only launches on the script that has a launch in it', () => {
  // The bounce and the running-dot are the connect script's own beat -- the
  // click that opens the app. The doc script has no such beat: the window is
  // already open and the person is typing into it. Overriding `wake` alone
  // left the icon jumping at 1650ms of a timeline it was not on, drifting
  // against the typing because that script's length moves with the line.
  assert(replay.includes('function Dock({ t, wake: fixed, launch = true })'), 'the beat is a parameter');
  assert(replay.includes('const press = launch ? phase(t, T.dockPress) : 0;'), 'and it is the only thing that presses the icon');
  assert(replay.includes('<Dock t={t} wake={1} launch={false} />'), 'the doc replay opens no app');
});

t('every replay is wound up before it is started', () => {
  // A clock with no length is a stopped clock: `% undefined` is NaN, every
  // style derived from it is dropped by the browser as invalid, and the scene
  // holds its t=0 frame for ever. Step 1 shipped like that for exactly as long
  // as it took to run the journey by hand -- an empty desk with an approval
  // card floating on it -- because the hook grew a `total` for the doc step and
  // this call site was not updated. Neither the hook nor a default can catch
  // that; only counting the call sites can.
  const calls = replay.match(/useClock\([^)]*\)/g) || [];
  assert(calls.length >= 2, `expected a clock per scene, found ${calls.length}`);
  for (const call of calls) {
    if (call.startsWith('useClock(running')) continue;
    assert(call.split(',').length >= 2, `${call} starts a clock with no length`);
  }
  assert(replay.includes('useClock(!reduced && !idle, REPLAY_MS)'), 'the connect replay runs for REPLAY_MS, and not at all with no line');
  // The doc replay is also gated on the reader having stopped typing: the
  // composer mirrors the field keystroke for keystroke, and the take is held
  // until the line settles. Sending on a timer posted a half-typed subject and
  // published a doc about it mid-word.
  assert(/useClock\(!reduced && settled, s\.total, line,/.test(replay),
    'and the doc replay only once the line has stopped changing, restarting on every keystroke');
  assert(/const SETTLE_MS = \d+;/.test(replay) && /setTimeout\(\(\) => setSettled\(true\), SETTLE_MS\)/.test(replay),
    'settling is a timer on the line, not a beat in the script');
  // And a line is not the same as a subject. Until one is typed the prompt is
  // composed from the field's PLACEHOLDER -- a complete sentence nobody wrote
  // -- and the take played it in full, publishing a doc about "what it should
  // be about" while the field was still empty. The Copy button already refuses
  // that same line.
  assert(/if \(!line \|\| !ready\) return undefined;/.test(replay),
    'no take until there is a subject, not merely a line');
  assert(/<DocReplay prompt=\{prompt\} slug=\{replaySlug\} ready=\{promptReady\} \/>/.test(gate),
    'and the gate passes the same readiness the Copy button uses');
  assert(/typing=\{!ready \? null :/.test(replay),
    'nor is the placeholder line typed into the composer');
  // Nor left on screen from the clock's resting frame. A stopped clock parks
  // at `total - 2200` -- the published-and-done still, which is right for
  // `prefers-reduced-motion` and wrong for a take that has not started: it
  // showed a finished document about the placeholder next to an empty field.
  // The two stops mean opposite things, so the caller says where to rest.
  assert(/useClock\(running, total, restart, restingAt\)/.test(replay), 'the clock takes a resting frame');
  assert(/setT\(restingAt === undefined \? total - 2200 : restingAt\)/.test(replay),
    'and uses it, defaulting to the finished still');
  assert(/useClock\(!reduced && settled, s\.total, line, reduced \? undefined : 0\)/.test(replay),
    'the doc take rests at the beginning unless motion is the thing being avoided');
  assert(!/\btype: \[t0/.test(replay), 'and nothing re-types what the reader already typed');
});

t('the one button on the gate is never below the fold', () => {
  // Every row in this column has a height that cannot be argued with -- 537px
  // of it at the tallest ask -- so the only room to find on a short window is
  // the air: the gaps, the top margin, and the strip the internal bar reserves.
  const base = gateCss.indexOf('.sg-col { width: 100%');
  const collapse = gateCss.indexOf('@media (max-height: 870px)');
  assert(base > 0 && collapse > 0, 'both rules exist');
  // This was wrong once: the collapse sat ABOVE the base rule, so the base's
  // own `gap: 18px` -- same specificity, later in the file -- won at every
  // height, and a media query that was supposed to tighten the column measured
  // 18px on the window it was written for.
  assert(base < collapse, 'the base rule comes first, or the overrides do nothing');
  for (const h of [870, 790, 710]) {
    assert(gateCss.includes(`@media (max-height: ${h}px)`), `a step at ${h}px`);
  }
  const dbg = read('shell/src/debug-bar.css');
  assert(/@media \(max-height: 710px\) \{ \.sg-split:has\(\.sg-debug\)/.test(dbg),
    'and the internal strip yields too, rather than pushing the button off');
});

t('the checklist shows up for a walk that never opened /setup', () => {
  // The journey this product is built around does not go through /setup: the
  // reader pastes a line into their agent, the agent connects and publishes
  // over the CLI, and /me is the first page they open. `started` is stamped by
  // a signed-in visit to /setup, so on that walk it is never set -- and gating
  // the card on it hid the progress of somebody two steps in.
  assert(/record\.started \|\| record\.published_first \|\| record\.first_doc/.test(list),
    'a first hosted publish is evidence the walk began');
  // Not `agent_connected` on its own: somebody who has been publishing for
  // months also signs a new terminal in. It counts only when the account is
  // still empty, which is the one case it cannot be a returning user.
  assert(/record\.agent_connected && !\(docs \|\| \[\]\)\.length/.test(list),
    'a new terminal alone only counts on an account with nothing in it');
  assert(!/if \(!record \|\| !record\.started \|\|/.test(list), 'and a page view is no longer the gate');
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
