import React, { useEffect, useRef, useState } from 'react';
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
//   2 paste     the line for the agent (sign-in first, if there is none)
//   Each screen is one headline and one button; the status line under a
//   waiting step is the only other text.
//   3 code      the code the agent shows, typed here
//   4 doc       the doc is up: open it, comment on it
//   5 sendback  the second line; the agent reads, writes, publishes v2
//   6 done      the loop, closed; the link to share
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
const STEPS = ['welcome', 'paste', 'code', 'doc', 'sendback', 'done'];

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

// One line and its Copy. On a refused clipboard the line is left selected so
// a manual copy is one keystroke away, and the button says so.
export function FirstDocRecipe({ line = FIRST_DOC_RECIPE, onCopied }) {
  const [copied, setCopied] = useState(null); // null | true | false
  const codeRef = useRef(null);
  const copy = async () => {
    const ok = await copyText(line);
    if (!ok && codeRef.current) selectContents(codeRef.current);
    setCopied(ok);
    onCopied?.(ok);
  };
  return (
    <div className="tdoc-wiz-copy">
      <code ref={codeRef} className="tdoc-wiz-line">{line}</code>
      <button type="button" className={`tdoc-wiz-primary${copied ? ' done' : ''}`} onClick={copy}>
        {copied === true ? 'Copied. Now paste it.' : copied === false ? 'Select & copy' : 'Copy'}
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

  const slug = record?.first_doc || null;
  const latest = Number(status?.latest_version) || 0;

  // Each copy is its own wait: the send-back step must not inherit the
  // paste step's copy and show its rows before the person has pressed Copy.
  useEffect(() => { setCopiedAt(null); setCopyFailed(false); setElapsed(0); }, [step]);
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
        const target = stepFromRecord(next);
        if (!resumed.current) {
          resumed.current = true;
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

  const onCopiedLine = (ok) => {
    setCopiedAt(Date.now());
    setCopyFailed(!ok);
    postOnboardingEvent('copy_clicked').catch(() => {});
    if (ok) window.setTimeout(() => setStep((current) => (current === 'paste' ? 'code' : current)), 900);
  };
  const onCopiedFix = (ok) => {
    setCopiedAt(Date.now());
    setCopyFailed(!ok);
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

  const shown = view && STEPS.indexOf(view) < STEPS.indexOf(step) ? view : step;
  const index = STEPS.indexOf(shown) + 1;
  const liveIndex = STEPS.indexOf(step) + 1;
  const back = () => { if (index > 1) setView(STEPS[index - 2]); };
  const forward = () => { const next = STEPS[index]; setView(next && STEPS.indexOf(next) < STEPS.indexOf(step) ? next : null); };
  const waitLine = copyFailed ? COPY_FALLBACK
    : elapsed > STILL_WAITING_MS ? STILL_WAITING
      : elapsed > NOTHING_YET_MS ? NOTHING_YET : WAITING;
  const skip = onClose ? <button type="button" className="tdoc-wiz-link" onClick={onClose}>{shown === 'done' ? 'Done' : 'Skip'}</button> : null;

  return (
    <div className={`tdoc-wiz${embedded ? ' embedded' : ''}`} data-step={shown} data-live-step={step}>
      <div className="tdoc-wiz-head">
        <div className="tdoc-wiz-head-left">
          {index > 1 ? (
            <button type="button" className="tdoc-wiz-nav" onClick={back} aria-label="Previous step">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
            </button>
          ) : null}
          {embedded ? null : <span className="tdoc-wiz-mark-word">tdoc</span>}
        </div>
        <div className="tdoc-wiz-head-right">
          <div className="tdoc-wiz-dots" role="tablist" aria-label={`Step ${index} of ${STEPS.length}`}>
            {STEPS.map((s, i) => (
              i + 1 <= liveIndex
                ? <button key={s} type="button" role="tab" aria-selected={i + 1 === index} aria-label={`Step ${i + 1}`} className={i + 1 < index ? 'past' : i + 1 === index ? 'now' : 'ahead'} onClick={() => setView(i + 1 === liveIndex ? null : s)} />
                : <span key={s} />
            ))}
          </div>
          {index < liveIndex ? (
            <button type="button" className="tdoc-wiz-nav" onClick={forward} aria-label="Next step">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
            </button>
          ) : null}
        </div>
      </div>

      {shown === 'welcome' ? (
        <>
          <h2 className="tdoc-wiz-h1">Your agent writes it.<br />You comment. It fixes.</h2>
          <OnboardingScene />
          <div className="tdoc-wiz-actions">
            <button type="button" className="tdoc-wiz-primary" onClick={start}>Get started</button>
            {skip}
          </div>
        </>
      ) : null}

      {shown === 'paste' ? (
        <>
          <h2 className="tdoc-wiz-h1">Paste this into your agent.</h2>
          <FirstDocRecipe onCopied={onCopiedLine} />
          <div className="tdoc-wiz-actions">
            {copyFailed ? <Listening>{COPY_FALLBACK}</Listening> : null}
            {skip}
          </div>
        </>
      ) : null}

      {shown === 'code' ? (
        <>
          <h2 className="tdoc-wiz-h1">Type the code your agent shows.</h2>
          {pair.state === 'confirm' ? (
            <div className="tdoc-wiz-actions">
              <p className="tdoc-wiz-confirm">Connect {pair.label ? <strong>{pair.label}</strong> : 'this terminal'} to your account?</p>
              <button type="button" className="tdoc-wiz-primary" onClick={approveCode}>Connect</button>
              <button type="button" className="tdoc-wiz-link" onClick={() => setPair({ state: 'idle', label: '', error: '' })}>Not mine</button>
            </div>
          ) : (
            <div className="tdoc-wiz-actions">
              <input
                className="tdoc-wiz-code"
                value={code}
                onChange={(event) => { setCode(cleanCode(event.target.value)); if (pair.state === 'error') setPair({ state: 'idle', label: '', error: '' }); }}
                onKeyDown={(event) => { if (event.key === 'Enter' && code.length === 9) lookupCode(); }}
                placeholder="XXXX-XXXX"
                spellCheck="false"
                autoCapitalize="characters"
                autoComplete="off"
                aria-label="Pairing code from your agent"
              />
              <button type="button" className="tdoc-wiz-primary" disabled={code.length !== 9 || pair.state === 'looking' || pair.state === 'approving'} onClick={lookupCode}>
                {pair.state === 'looking' ? 'Checking…' : 'Connect'}
              </button>
              {pair.state === 'error' ? <p className="tdoc-wiz-error" role="alert">{pair.error}</p> : <Listening>{waitLine}</Listening>}
              {skip}
            </div>
          )}
        </>
      ) : null}

      {shown === 'doc' ? (
        record?.published_first ? (
          <>
            <h2 className="tdoc-wiz-h1">Highlight a sentence.<br />Say what you think.</h2>
            <div className="tdoc-wiz-actions">
              <button type="button" className="tdoc-wiz-primary" onClick={() => openDoc(1, 'welcome')}>Open your doc</button>
              <Listening>Waiting for your first comment…</Listening>
              {skip}
            </div>
          </>
        ) : (
          <>
            <h2 className="tdoc-wiz-h1">Your agent is writing.</h2>
            <div className="tdoc-wiz-actions">
              <Row state="done">Agent connected</Row>
              <Row state="live">Writing your doc</Row>
              <Row state="todo">Published</Row>
              {skip}
            </div>
          </>
        )
      ) : null}

      {shown === 'sendback' ? (
        <>
          <h2 className="tdoc-wiz-h1">Now let your agent fix it.</h2>
          <FirstDocRecipe line={HANDOFF_LINE} onCopied={onCopiedFix} />
          <div className="tdoc-wiz-actions">
            {copiedAt !== null && !copyFailed ? (
              <div className="tdoc-wiz-rows">
                <Row state={status?.read_at ? 'done' : 'live'}>Reading your comments</Row>
                <Row state={latest >= 2 ? 'done' : status?.read_at ? 'live' : 'todo'}>Writing v2</Row>
                <Row state={latest >= 2 ? 'done' : 'todo'}>Published</Row>
              </div>
            ) : null}
            {copyFailed ? <Listening>{COPY_FALLBACK}</Listening> : null}
            {skip}
          </div>
        </>
      ) : null}

      {shown === 'done' ? (
        <>
          <h2 className="tdoc-wiz-h1">That’s the loop.</h2>
          <OnboardingScene done />
          <div className="tdoc-wiz-actions">
            <button type="button" className="tdoc-wiz-primary" onClick={() => openDoc(latest || 2, 'revised')}>Open v{latest || 2}</button>
            <button type="button" className={`tdoc-wiz-secondary${linkCopied ? ' done' : ''}`} onClick={copyShareLink}>{linkCopied ? 'Link copied' : 'Copy link'}</button>
            {skip}
          </div>
        </>
      ) : null}
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
