import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { copyText } from './document/model.js';
import { getAgentStatus, getOnboarding, postOnboardingEvent } from './document/api.js';
import { OnboardingScene } from './onboarding-scene.jsx';

// The onboarding is one pop-up on the landing page, six steps, and from the
// second step on it is the bridge itself: it asks the server every few
// seconds what the person's agent has done and moves forward on its own.
// The doc opens in another tab; this window stays and is the guide. Each
// step is a headline, one line, and one button — nothing to read.
//
//   1 welcome   what tdoc is, drawn
//   2 paste     the line for the agent (sign-in first, if there is none);
//               once copied, the page waits for the agent. The agent's first
//               move is to connect: FIRST-DOC.md has it run
//               `tdoc-publish --signin-only` before reading anything, which
//               prints a code and opens tdoc.dev/activate with it filled in.
//               A first-time account can also type that code here. An account
//               that has connected a terminal before (`paired`) never sees a
//               code again — the CLI keeps its credential — so the page shows
//               the agent writing instead.
//   3 doc       the doc is up: open it, comment on it
//   4 sendback  the second line; the agent reads, writes, publishes v2
//   5 done      the loop, closed; the link to share
//   Each screen is one headline and one button; the status line under a
//   waiting step is the only other text.
//
// Every step is read off the account's onboarding record, never this browser,
// so a second device — or a reload — resumes where the first one stopped.

const RECIPE_URL = 'https://github.com/tornado-doc/tdoc/blob/main/FIRST-DOC.md';
export const FIRST_DOC_RECIPE = `Set up tdoc and make my first doc: ${RECIPE_URL}`;
// The line for a person who already has one: tdoc is installed by then, and
// FIRST-DOC.md would only build the same portrait again.
export const ANOTHER_DOC_RECIPE = '/tdoc new "<what it is about>" — then publish it and give me the link';
export const HANDOFF_LINE = 'Read my tdoc comments and fix them';
export const EXAMPLE_URL = '/d/what-ai-knows/v/12';
export const AGENT_DEFINITION = 'An AI that runs on your computer and can read and write files.';
export const AGENT_NAMES = 'Claude Code · Codex · Claude Cowork · ChatGPT Work';
export const WAITING = 'Listening for your agent…';
export const NOTHING_YET = 'Taking a while? Check your agent’s window.';
export const STILL_WAITING = 'Still waiting. Did you paste it?';
export const COPY_FALLBACK = 'Copy the selected line by hand.';

const POLL_MS = 3000;
const NOTHING_YET_MS = 90 * 1000;
const STILL_WAITING_MS = 5 * 60 * 1000;
const STEPS = ['welcome', 'paste', 'doc', 'sendback', 'done'];

// Select the text of an element, for the person to copy by hand when the
// clipboard refused. Never throws.
export function selectContents(element) {
  try {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {}
}

// Where the journey stands, from the record alone. Forward only: the record
// never un-stamps, and a person who reopens the page lands on the step whose
// stamp is missing.
export function stepFromRecord(record) {
  if (!record || !record.started) return 'welcome';
  if (record.revised) return 'done';
  if (record.commented) return 'sendback';
  if (record.published_first) return 'doc';
  if (record.agent_connected) return 'doc';
  return 'paste';
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

// The code a terminal shows: 8 characters, shown as XXXX-XXXX. Same cleaning
// as /activate, so a code pasted with or without the dash both land.
function cleanCode(raw) {
  const v = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v;
}

// One copy behaviour for every line the journey hands over. On a refused
// clipboard the line is left selected so a manual copy is one keystroke away,
// and the button says so. `copied` is null | true | false.
function useCopyLine(onCopied) {
  const [copied, setCopied] = useState(null);
  const codeRef = useRef(null);
  const copy = async (line) => {
    const ok = await copyText(line);
    if (!ok && codeRef.current) selectContents(codeRef.current);
    setCopied(ok);
    onCopied?.(ok);
  };
  // Stable, so an effect keyed on it runs when a step changes — not on
  // every render, which reset the copy the moment it happened.
  const reset = useCallback(() => setCopied(null), []);
  return { copied, codeRef, copy, reset };
}
function copyLabel(copied) {
  return copied === true ? 'Copied. Now paste it.' : copied === false ? 'Select & copy' : 'Copy';
}

// The line and its Copy as one block, for surfaces without a fixed floor.
export function FirstDocRecipe({ line = FIRST_DOC_RECIPE, onCopied }) {
  const { copied, codeRef, copy } = useCopyLine(onCopied);
  return (
    <div className="tdoc-wiz-copy">
      <code ref={codeRef} className="tdoc-wiz-line">{line}</code>
      <button type="button" className={`tdoc-wiz-primary${copied ? ' done' : ''}`} onClick={() => copy(line)}>
        {copyLabel(copied)}
      </button>
    </div>
  );
}

function Row({ state, children }) {
  return (
    <div className={`tdoc-wiz-row ${state}`}>
      <span className="tdoc-wiz-mark" aria-hidden="true">
        {state === 'done' ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>
        ) : state === 'live' ? <span className="tdoc-wait-dot" /> : null}
      </span>
      <span>{children}</span>
    </div>
  );
}

function Listening({ children }) {
  return (
    <div className="tdoc-wiz-listen" role="status" aria-live="polite">
      <span className="tdoc-wait-dot" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function OnboardingWizard({ config, initialStep = null, embedded = false, onClose, onSignIn }) {
  const signedIn = Boolean(config?.identity);
  const [record, setRecord] = useState(null);
  const [paired, setPaired] = useState(false);
  const [step, setStep] = useState(() => (initialStep && STEPS.includes(initialStep) ? initialStep : 'welcome'));
  // Looking back. `step` is where the journey IS (the record moves it); `view`
  // is a past step the person asked to see again. Null means "show the live
  // step". Going forward past the live step, or reaching it, clears the view,
  // so the record's next move is seen the moment it happens.
  const [view, setView] = useState(null);
  const [status, setStatus] = useState(null); // agent-status of the first doc
  const [copiedAt, setCopiedAt] = useState(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [linkCopied, setLinkCopied] = useState(false);
  // pairing: idle → looking → confirm → approving → connected | error
  const [code, setCode] = useState('');
  const [pair, setPair] = useState({ state: 'idle', label: '', error: '' });
  const resumed = useRef(false);
  const lineCopy = useCopyLine((ok) => { setCopiedAt(Date.now()); setCopyFailed(!ok); });

  const slug = record?.first_doc || null;
  const latest = Number(status?.latest_version) || 0;

  // Each copy is its own wait: the send-back step must not inherit the
  // paste step's copy and show its rows before the person has pressed Copy.
  useEffect(() => { setCopiedAt(null); setCopyFailed(false); setElapsed(0); }, [step]);
  // A copy belongs to its step, not to the view: looking back, or the skip
  // question, and returning finds the line still copied and the code field
  // still there. Only the record moving on clears it.
  const lineReset = lineCopy.reset;
  useEffect(() => { lineReset(); }, [step, lineReset]);
  useEffect(() => { setView(null); }, [step]);
  const connected = Boolean(record?.agent_connected || record?.published_first || pair.state === 'connected');

  // The record decides the step, on the first answer and on every later one
  // — forward only, and never off the welcome screen.
  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const result = await getOnboarding();
        if (cancelled) return;
        const next = result?.record || {};
        setRecord(next);
        setPaired(Boolean(result?.paired));
        const target = stepFromRecord(next);
        if (!resumed.current) {
          resumed.current = true;
          // Opened by the top bar's sign-in return for an account that has
          // already finished or skipped: nothing to show — close, quietly.
          if (initialStep === 'welcome' && (next.shared || next.tour_seen)) { onClose?.(); return; }
          if (next.started && (!initialStep || STEPS.indexOf(target) > STEPS.indexOf(initialStep))) setStep(target);
        } else {
          setStep((current) => (current !== 'welcome' && STEPS.indexOf(target) > STEPS.indexOf(current) ? target : current));
        }
        if (next.first_doc) {
          const s = await getAgentStatus(next.first_doc).catch(() => null);
          if (!cancelled && s) setStatus(s);
        }
      } catch {}
      if (cancelled) return;
      if (copiedAt) setElapsed(Date.now() - copiedAt);
      timer = window.setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [signedIn, initialStep, copiedAt]);

  // Sign-in is the site's own: the page leaves for it and comes back to the
  // paste step, which is where a signed-in person starts anyway.
  const start = () => {
    if (!signedIn) { onSignIn?.('/?onboard=paste'); return; }
    postOnboardingEvent('door_own_agent').catch(() => {});
    setStep('paste');
  };
  useEffect(() => {
    if (step === 'paste' && signedIn && record && !record.started) postOnboardingEvent('door_own_agent').catch(() => {});
  }, [step, signedIn, record]);

  const copyFirstLine = async () => {
    await lineCopy.copy(FIRST_DOC_RECIPE);
    postOnboardingEvent('copy_clicked').catch(() => {});
  };
  const copyFixLine = async () => {
    await lineCopy.copy(HANDOFF_LINE);
    postOnboardingEvent('fix_copy_clicked', slug).catch(() => {});
  };

  const lookupCode = async () => {
    setPair({ state: 'looking', label: '', error: '' });
    const { status: st, data } = await postJson('/api/cli/pair/lookup', { user_code: code });
    if (st === 200 && data?.ok) setPair({ state: 'confirm', label: data.label || '', error: '' });
    else if (st === 401) setPair({ state: 'error', label: '', error: 'Sign in first, then type the code.' });
    else setPair({ state: 'error', label: '', error: "That code isn't waiting. Check the terminal." });
  };
  const approveCode = async () => {
    setPair((current) => ({ ...current, state: 'approving' }));
    const { status: st, data } = await postJson('/api/cli/pair/approve', { user_code: code });
    if (st === 200 && data?.ok) { setPair({ state: 'connected', label: '', error: '' }); setStep('doc'); }
    else setPair({ state: 'error', label: '', error: 'Could not connect. Ask your agent for a fresh code.' });
  };

  const openDoc = (n, arrival) => {
    if (!slug) return;
    window.open(`/d/${encodeURIComponent(slug)}/v/${n}?${arrival}=1`, '_blank', 'noopener');
  };
  const copyShareLink = async () => {
    if (!slug) return;
    const ok = await copyText(`${location.origin}/d/${encodeURIComponent(slug)}/v/${latest || 2}`);
    setLinkCopied(ok);
    if (ok) postOnboardingEvent('share_link_copied', slug).catch(() => {});
  };

  // What is on screen, and the rules the floor and the dots follow:
  //   step   — where the record says the journey IS (forward only)
  //   view   — null (the live step), a past step being looked at, or 'end'
  //   shown  — the step rendered: `view` when it is a past step, else `step`
  //   index  — the dot: the end screen is always the last dot
  // Floor, left:  Back on every screen after the first (to the previous shown step)
  // Floor, right: Continue while looking at a past step (toward the live step);
  //               Skip on the live step (to the end screen, stamping tour_seen)
  // Corner ×:     leave. Nothing on the floor closes the pop-up.
  // Dots:         one per step; those already reached are clickable — the live
  //               dot returns to the live step, an earlier one looks back.
  const shown = view && STEPS.includes(view) && STEPS.indexOf(view) < STEPS.indexOf(step) ? view : step;
  const liveIndex = STEPS.indexOf(step) + 1;
  const shared = Boolean(record?.shared);
  const finished = step === 'done' && shared && view === null;
  const atEnd = finished || view === 'end';
  const index = atEnd ? STEPS.length : STEPS.indexOf(shown) + 1;
  const back = () => { if (index > 1) setView(STEPS[index - 2]); };
  const forward = () => { const next = STEPS[index]; setView(next && STEPS.indexOf(next) < STEPS.indexOf(step) ? next : null); };
  const waitLine = copyFailed ? COPY_FALLBACK
    : elapsed > STILL_WAITING_MS ? STILL_WAITING
      : elapsed > NOTHING_YET_MS ? NOTHING_YET : WAITING;

  // Skip is not leaving: it asks. The last screen puts the question — skip
  // the walk-through? — and only a yes stamps the record (so the landing
  // stops reopening the pop-up) and goes to their docs. Leaving is the × in
  // the corner.
  const skipToEnd = () => setView('end');
  const confirmSkip = () => {
    postOnboardingEvent('tour_seen').catch(() => {});
    location.href = '/me';
  };

  // The frame never moves: the headline sits under the header, the middle
  // holds this step's one thing, and the buttons sit on the floor. The bottom
  // row is for moving between screens — Back; Continue while looking back;
  // Skip, to the end.
  const foot = (primary, extra = null) => (
    <div className="tdoc-wiz-foot">
      {extra}
      {primary || <div className="tdoc-wiz-primary-ghost" aria-hidden="true" />}
      <div className="tdoc-wiz-nav-row">
        {index > 1 ? <button type="button" className="tdoc-wiz-link" onClick={back}>Back</button> : <span />}
        {index < liveIndex
          ? <button type="button" className="tdoc-wiz-link" onClick={forward}>Continue</button>
          : shown === 'done' ? <span />
            : <button type="button" className="tdoc-wiz-link" onClick={skipToEnd}>Skip</button>}
      </div>
    </div>
  );

  let title = null;
  let body = null;
  let footer = null;

  // The last screen. Reached by finishing (the loop closed, the link copied)
  // or by Skip. It offers the two things left to do — their docs, or the walk
  // again as a tour (views only; the record does not move).
  if (atEnd && shared) {
    title = <>You’ve done the loop.<br />Every doc works this way.</>;
    body = <OnboardingScene done />;
    footer = (
      <div className="tdoc-wiz-foot">
        <button type="button" className="tdoc-wiz-secondary" onClick={() => setView('welcome')}>Walk through it again</button>
        <a className="tdoc-wiz-primary" href="/me">Go to my docs</a>
        <div className="tdoc-wiz-nav-row"><span /><span /></div>
      </div>
    );
  } else if (atEnd) {
    title = <>Skip the walk-through?<br />You can come back any time.</>;
    body = <OnboardingScene />;
    footer = (
      <div className="tdoc-wiz-foot">
        <button type="button" className="tdoc-wiz-secondary" onClick={() => setView(null)}>Keep going</button>
        <button type="button" className="tdoc-wiz-primary" onClick={confirmSkip}>Skip it, go to my docs</button>
        <div className="tdoc-wiz-nav-row"><span /><span /></div>
      </div>
    );
  } else if (shown === 'welcome') {
    title = <>Your agent writes it.<br />You comment. It fixes.</>;
    body = <OnboardingScene />;
    footer = foot(<button type="button" className="tdoc-wiz-primary" onClick={start}>Get started</button>);
  } else if (shown === 'paste') {
    // One screen: the line, then — once it is copied — the code the agent
    // shows, typed underneath. Nothing the person has seen goes away.
    // The step says what to open, by name — the four agents are the one list
    // the page keeps — and then what to do there.
    title = <>Open your agent.<br />Paste this in.</>;
    const agents = (
      <div className="tdoc-wiz-agents" aria-label="Agents this works with">
        {AGENT_NAMES.split(' · ').map((name) => <span key={name}>{name}</span>)}
      </div>
    );
    const copiedLine = (
      <code ref={lineCopy.codeRef} className={`tdoc-wiz-line${lineCopy.copied ? ' copied' : ''}`}>
        {FIRST_DOC_RECIPE}
        {lineCopy.copied ? <span className="tdoc-wiz-copied" aria-label="Copied">Copied</span> : null}
      </code>
    );
    if (pair.state === 'confirm') {
      body = (
        <>
          {agents}
          {copiedLine}
          <p className="tdoc-wiz-confirm">Connect {pair.label ? <strong>{pair.label}</strong> : 'this terminal'} to your account?</p>
        </>
      );
      footer = foot(
        <button type="button" className="tdoc-wiz-primary" onClick={approveCode}>Connect</button>,
        <button type="button" className="tdoc-wiz-link" onClick={() => setPair({ state: 'idle', label: '', error: '' })}>Not mine</button>,
      );
    } else if (lineCopy.copied !== null && (connected || paired)) {
      // A terminal already connected to this account never shows a code
      // again (the CLI keeps its credential), so there is nothing to type:
      // the agent is installing and writing, and the page says so.
      body = (
        <>
          {agents}
          {copiedLine}
          <div className="tdoc-wiz-rows">
            <Row state="done">Agent connected</Row>
            <Row state="live">Writing your doc — about 5 minutes</Row>
            <Row state="todo">Published</Row>
          </div>
        </>
      );
      footer = foot(null, lineCopy.copied === false ? <Listening>{COPY_FALLBACK}</Listening> : null);
    } else if (lineCopy.copied !== null) {
      // First time: the agent's first move is to connect. It opens tdoc.dev's
      // activate page with the code filled in — approving it there is the
      // usual path — and the code can be typed here instead.
      body = (
        <>
          {agents}
          {copiedLine}
          <Listening>{pair.state === 'error' ? pair.error : 'Your agent will ask to connect — approve it in the tab it opens, or type its code here.'}</Listening>
          <input
            className="tdoc-wiz-code"
            value={code}
            onChange={(event) => { setCode(cleanCode(event.target.value)); if (pair.state === 'error') setPair({ state: 'idle', label: '', error: '' }); }}
            onKeyDown={(event) => { if (event.key === 'Enter' && code.length === 9) lookupCode(); }}
            placeholder="Code from your agent"
            spellCheck="false"
            autoCapitalize="characters"
            autoComplete="off"
            aria-label="Pairing code from your agent"
          />
        </>
      );
      footer = foot(
        <button type="button" className="tdoc-wiz-primary" disabled={code.length !== 9 || pair.state === 'looking' || pair.state === 'approving'} onClick={lookupCode}>
          {pair.state === 'looking' ? 'Checking…' : 'Connect'}
        </button>,
        lineCopy.copied === false ? <Listening>{COPY_FALLBACK}</Listening> : null,
      );
    } else {
      body = <>{agents}{copiedLine}</>;
      footer = foot(<button type="button" className="tdoc-wiz-primary" onClick={copyFirstLine}>Copy</button>);
    }
  } else if (shown === 'doc') {
    if (record?.published_first) {
      title = <>Highlight a sentence.<br />Say what you think.</>;
      body = <Listening>Waiting for your first comment…</Listening>;
      footer = foot(<button type="button" className="tdoc-wiz-primary" onClick={() => openDoc(1, 'welcome')}>Open your doc</button>);
    } else {
      title = 'Your agent is writing.';
      body = (
        <div className="tdoc-wiz-rows">
          <Row state="done">Agent connected</Row>
          <Row state="live">Writing your doc — about 5 minutes</Row>
          <Row state="todo">Published</Row>
        </div>
      );
      footer = foot(null);
    }
  } else if (shown === 'sendback') {
    title = 'Now let your agent fix it.';
    body = (
      <>
        <code ref={lineCopy.codeRef} className="tdoc-wiz-line">{HANDOFF_LINE}</code>
        {lineCopy.copied ? (
          <div className="tdoc-wiz-rows">
            <Row state={status?.read_at ? 'done' : 'live'}>Reading your comments</Row>
            <Row state={latest >= 2 ? 'done' : status?.read_at ? 'live' : 'todo'}>Writing v2</Row>
            <Row state={latest >= 2 ? 'done' : 'todo'}>Published</Row>
          </div>
        ) : null}
      </>
    );
    footer = foot(
      <button type="button" className={`tdoc-wiz-primary${lineCopy.copied ? ' done' : ''}`} onClick={copyFixLine}>{copyLabel(lineCopy.copied)}</button>,
      lineCopy.copied === false ? <Listening>{COPY_FALLBACK}</Listening> : null,
    );
  } else if (shown === 'done') {
    title = 'That’s the loop.';
    body = <OnboardingScene done />;
    footer = foot(
      <button type="button" className="tdoc-wiz-primary" onClick={() => openDoc(latest || 2, 'revised')}>Open v{latest || 2}</button>,
      <button type="button" className={`tdoc-wiz-secondary${linkCopied ? ' done' : ''}`} onClick={copyShareLink}>{linkCopied ? 'Link copied' : 'Copy link'}</button>,
    );
  }

  return (
    <div className={`tdoc-wiz${embedded ? ' embedded' : ''}`} data-step={shown} data-live-step={step}>
      <div className="tdoc-wiz-head">
        {embedded ? <span /> : <span className="tdoc-wiz-mark-word">tdoc</span>}
        <div className="tdoc-wiz-head-right">
          <div className="tdoc-wiz-dots" role="tablist" aria-label={`Step ${index} of ${STEPS.length}`}>
            {STEPS.map((s, i) => {
              const cls = i + 1 < index ? 'past' : i + 1 === index ? 'now' : 'ahead';
              return i + 1 <= liveIndex
                ? <button key={s} type="button" role="tab" aria-selected={i + 1 === index} aria-label={`Step ${i + 1}`} className={cls} onClick={() => setView(i + 1 === liveIndex ? null : s)} />
                : <span key={s} className={cls} />;
            })}
          </div>
          {onClose ? (
            <button type="button" className="tdoc-wiz-close" onClick={onClose} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          ) : null}
        </div>
      </div>
      <h2 className="tdoc-wiz-h1">{title}</h2>
      <div className="tdoc-wiz-body">{body}</div>
      {footer}
    </div>
  );
}

// The Docs Hub's "Build it with your agent" card opens the same journey,
// from the paste step, inside the hub's own dialog.
export function OwnAgentDoor({ onOpenChange, closeLabel = 'Back', config = null }) {
  return (
    <div className="tdoc-own-door">
      <OnboardingWizard config={config || { identity: { login: 'you' } }} initialStep="paste" embedded onClose={() => onOpenChange(false)} />
    </div>
  );
}

// First-time onboarding, and only that. Behind the landing page's own CTA —
// the page itself is unchanged. `initialDoor` is the step a redirect returns
// to (`?onboard=paste` after the sign-in); the old `own` value lands there too.
export function OnboardingDialog({ open, onOpenChange, config, onSignIn, initialDoor = null }) {
  const initialStep = initialDoor === 'own' ? 'paste' : initialDoor;
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create a free doc"
      hideTitle
      className="tdoc-wiz-modal"
      actions={null}
    >
      {open ? (
        <OnboardingWizard
          config={config}
          initialStep={initialStep}
          onSignIn={onSignIn}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </AppDialog>
  );
}
