import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { copyText } from './document/model.js';
import { getAgentStatus, getOnboarding, postOnboardingEvent } from './document/api.js';
import { OnboardingScene } from './onboarding-scene.jsx';

// The onboarding is one pop-up on the landing page, six steps, and from the
// third step on it is the bridge itself: it asks the server every few
// seconds what the person's agent has done and moves forward on its own.
// The doc opens in another tab; this window stays and is the guide.
//
//   1 welcome   what tdoc is, drawn
//   2 signin    in a small window; the page stays
//   3 connect   the line to paste; the code the agent shows, typed here
//   4 doc       the first doc is up: open it, comment on it
//   5 sendback  the second line; the agent reads, writes, publishes v2
//   6 done      the loop, closed; the link to share
//
// Every step is read off the account's onboarding record, never this browser,
// so a second device — or a reload — resumes where the first one stopped.

const RECIPE_URL = 'https://github.com/tornado-doc/tdoc/blob/main/FIRST-DOC.md';
export const FIRST_DOC_RECIPE = `Set up tdoc and make my first doc: ${RECIPE_URL}`;
// The line for a person who already has one. tdoc is installed by then, and
// FIRST-DOC.md would only build the same portrait again, so this one is the
// ordinary way to make a doc, with a blank for what it is about.
export const ANOTHER_DOC_RECIPE = '/tdoc new "<what it is about>" — then publish it and give me the link';
export const HANDOFF_LINE = 'Read my tdoc comments and fix them';
export const EXAMPLE_URL = '/d/what-ai-knows/v/12';
export const AGENT_DEFINITION = 'An AI that runs on your computer and can read and write files.';
export const AGENT_NAMES = 'Claude Code · Codex · Claude Cowork · ChatGPT Work';
export const WAITING = 'Listening for your agent… this usually takes 2–3 minutes.';
export const NOTHING_YET = 'Taking a while? Check whether your agent asked you a question in its own window.';
export const STILL_WAITING = 'Still waiting — did you paste it into your agent?';
export const COPY_FALLBACK = "Couldn't copy automatically — the line is selected above. Copy it, paste it into your agent, and press Enter.";

const POLL_MS = 3000;
const NOTHING_YET_MS = 90 * 1000;
const STILL_WAITING_MS = 5 * 60 * 1000;
const STEPS = ['welcome', 'signin', 'connect', 'doc', 'sendback', 'done'];

// Select the text of an element, for the person to copy by hand when the
// clipboard refused. Never throws: a page that cannot select just shows the
// fallback sentence.
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
  return 'connect';
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
        {copied === true ? 'Copied — now paste it into your agent' : copied === false ? 'Select & copy' : 'Copy the line'}
        {copied === null ? <CopyIcon /> : null}
      </button>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" />
    </svg>
  );
}
function OpenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
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

// Sign in without leaving: a small window runs the provider's page and closes
// itself on /auth/done?popup=1, which posts `tdoc:signed-in` back here. The
// landing then reloads straight into the connect step. A blocked pop-up falls
// back to the full-page redirect the shell has always done.
function openSignInWindow(config) {
  const ret = encodeURIComponent('/auth/done?popup=1');
  const path = config?.oidcAuth
    ? `/api/auth/oidc/login?prompt=login&return=${ret}`
    : config?.webAuth ? `/api/auth/web/login?return=${ret}` : null;
  if (!path) return null;
  const w = 480; const h = 640;
  const left = Math.max(0, Math.round((window.screen.width - w) / 2));
  const top = Math.max(0, Math.round((window.screen.height - h) / 2));
  let win = null;
  try { win = window.open(path, 'tdoc-signin', `width=${w},height=${h},left=${left},top=${top}`); } catch {}
  if (!win) {
    location.href = path.replace(ret, encodeURIComponent('/?onboard=connect'));
    return null;
  }
  return win;
}

export function OnboardingWizard({ config, initialStep = null, embedded = false, onClose, onSignIn }) {
  const signedIn = Boolean(config?.identity);
  const [record, setRecord] = useState(null);
  const [step, setStep] = useState(() => (initialStep && STEPS.includes(initialStep) ? initialStep : 'welcome'));
  const [status, setStatus] = useState(null); // agent-status of the first doc
  const [copiedAt, setCopiedAt] = useState(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [signinWaiting, setSigninWaiting] = useState(false);
  const [another, setAnother] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  // pairing: idle → looking → confirm → approving → connected | error
  const [code, setCode] = useState('');
  const [pair, setPair] = useState({ state: 'idle', label: '', error: '' });
  const resumed = useRef(false);

  const go = useCallback((next) => setStep(next), []);
  const slug = record?.first_doc || null;
  const latest = Number(status?.latest_version) || 0;
  const docTitle = status?.title || slug || 'your doc';

  // The record decides the step, on the first answer and on every later one
  // — forward only, and never off the two screens that come before it.
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
          if (!initialStep && next.started) setStep(target);
          if (initialStep && STEPS.indexOf(target) > STEPS.indexOf(initialStep) && next.started) setStep(target);
        } else {
          setStep((current) => (STEPS.indexOf(target) > STEPS.indexOf(current) && current !== 'welcome' && current !== 'signin' ? target : current));
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

  // The sign-in window reports back; the page reloads into the connect step
  // with a session cookie it did not have.
  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== location.origin) return;
      if (event.data?.type !== 'tdoc:signed-in') return;
      location.assign('/?onboard=connect');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const start = () => {
    if (!signedIn) { go('signin'); return; }
    postOnboardingEvent('door_own_agent').catch(() => {});
    go('connect');
  };
  const signIn = () => {
    if (!config?.oidcAuth && !config?.webAuth) { onSignIn?.('/?onboard=connect'); return; }
    const win = openSignInWindow(config);
    if (win) setSigninWaiting(true);
  };
  useEffect(() => {
    if (step === 'connect' && signedIn && record && !record.started) postOnboardingEvent('door_own_agent').catch(() => {});
  }, [step, signedIn, record]);

  const onCopiedLine = (ok) => {
    setCopiedAt(Date.now());
    setCopyFailed(!ok);
    postOnboardingEvent('copy_clicked').catch(() => {});
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
    else setPair({ state: 'error', label: '', error: "That code isn't waiting. Check the terminal — it expires after a few minutes." });
  };
  const approveCode = async () => {
    setPair((current) => ({ ...current, state: 'approving' }));
    const { status: st, data } = await postJson('/api/cli/pair/approve', { user_code: code });
    if (st === 200 && data?.ok) setPair({ state: 'connected', label: '', error: '' });
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

  const index = STEPS.indexOf(step) + 1;
  const connected = Boolean(record?.agent_connected || record?.published_first || pair.state === 'connected');
  const waitLine = copiedAt === null
    ? null
    : copyFailed ? COPY_FALLBACK
      : elapsed > STILL_WAITING_MS ? STILL_WAITING
        : elapsed > NOTHING_YET_MS ? NOTHING_YET : WAITING;

  return (
    <div className={`tdoc-wiz${embedded ? ' embedded' : ''}`} data-step={step}>
      <div className="tdoc-wiz-head">
        {embedded ? <span /> : <span className="tdoc-wiz-mark-word">tdoc</span>}
        <div className="tdoc-wiz-dots" aria-label={`Step ${index} of ${STEPS.length}`}>
          {STEPS.map((s, i) => <span key={s} className={i + 1 < index ? 'past' : i + 1 === index ? 'now' : ''} />)}
        </div>
      </div>

      {step === 'welcome' ? (
        <>
          <h2 className="tdoc-wiz-h1">Your agent writes it.<br />You comment. It fixes.</h2>
          <p className="tdoc-wiz-sub">A doc that lives between you and your coding agent.</p>
          <OnboardingScene />
          <div className="tdoc-wiz-actions">
            <button type="button" className="tdoc-wiz-primary" onClick={start}>Get started</button>
            <a className="tdoc-wiz-link" href={EXAMPLE_URL} target="_blank" rel="noopener noreferrer" onClick={() => postOnboardingEvent('example_opened').catch(() => {})}>See an example first</a>
          </div>
        </>
      ) : null}

      {step === 'signin' ? (
        <>
          <h2 className="tdoc-wiz-h1">Sign in to keep your docs.</h2>
          <p className="tdoc-wiz-sub">Your agent publishes to your account. Nothing to install here.</p>
          <div className="tdoc-wiz-actions">
            <button type="button" className="tdoc-wiz-primary" onClick={signIn}>{signinWaiting ? 'Sign in again' : 'Sign in'}</button>
            <p className="tdoc-wiz-note">Google, GitHub or email — in a small window. This page stays.</p>
            {signinWaiting ? <Listening>Waiting for the sign-in window…</Listening> : null}
            <button type="button" className="tdoc-wiz-link" onClick={() => go('welcome')}>Back</button>
          </div>
        </>
      ) : null}

      {step === 'connect' ? (
        <>
          <h2 className="tdoc-wiz-h1">Paste one line into your agent.</h2>
          <p className="tdoc-wiz-sub">{AGENT_NAMES.replace(/ · /g, ', ')} — any coding agent on your computer.</p>
          <FirstDocRecipe onCopied={onCopiedLine} />
          {copiedAt !== null ? (
            <div className="tdoc-wiz-rows">
              <Listening>{waitLine}</Listening>
              {connected ? <Row state="done">Agent connected</Row> : null}
              {record?.published_first ? <Row state="done">Doc published</Row> : connected ? <Row state="live">Writing your doc…</Row> : null}
            </div>
          ) : (
            <p className="tdoc-wiz-note">It installs tdoc and writes your first doc. Usually 2–3 minutes.<br />This window follows along — keep it open.</p>
          )}
          <details className="tdoc-onboarding-details">
            <summary>Advanced</summary>
            <p className="muted">To publish to your own Cloudflare instead of tdoc.dev, add to the line: <strong>Publish it to my own Cloudflare, not the hosted service.</strong></p>
            <a className="tdoc-onboarding-link" href="/start">Read the full tutorial</a>
          </details>
          {!connected ? (
            <div className="tdoc-wiz-pair">
              {pair.state === 'confirm' ? (
                <>
                  <p className="tdoc-wiz-pair-title">Connect {pair.label ? <strong>{pair.label}</strong> : 'this terminal'} to your account?</p>
                  <div className="tdoc-wiz-pair-actions">
                    <button type="button" className="tdoc-wiz-primary small" onClick={approveCode}>Connect</button>
                    <button type="button" className="tdoc-wiz-link" onClick={() => setPair({ state: 'idle', label: '', error: '' })}>Not mine</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="tdoc-wiz-pair-title">When your agent shows a code, type it here.</p>
                  <div className="tdoc-wiz-pair-actions">
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
                    <button type="button" className="tdoc-wiz-primary small" disabled={code.length !== 9 || pair.state === 'looking' || pair.state === 'approving'} onClick={lookupCode}>
                      {pair.state === 'looking' ? 'Checking…' : 'Connect'}
                    </button>
                  </div>
                  {pair.state === 'error' ? <p className="tdoc-wiz-error" role="alert">{pair.error}</p> : null}
                </>
              )}
            </div>
          ) : null}
        </>
      ) : null}

      {step === 'doc' ? (
        <>
          <h2 className="tdoc-wiz-h1">Your doc is ready.</h2>
          <p className="tdoc-wiz-sub">Open it, highlight any sentence, and say what you think.</p>
          <div className="tdoc-wiz-rows">
            <Row state="done">Agent connected</Row>
            <Row state="done">Doc written</Row>
            <Row state="done">Published to your account</Row>
          </div>
          <div className="tdoc-wiz-actions">
            <button type="button" className="tdoc-wiz-primary" onClick={() => openDoc(1, 'welcome')}>Open {docTitle}<OpenIcon /></button>
            <Listening>Waiting for your first comment…</Listening>
            <p className="tdoc-wiz-note">It opens in a new tab. Come back here when you’ve commented.</p>
          </div>
        </>
      ) : null}

      {step === 'sendback' ? (
        <>
          <h2 className="tdoc-wiz-h1">Send your comments back.</h2>
          <p className="tdoc-wiz-sub">Your agent reads every comment, replies, and publishes a new version.</p>
          <FirstDocRecipe line={HANDOFF_LINE} onCopied={onCopiedFix} />
          {copiedAt !== null ? (
            <div className="tdoc-wiz-rows">
              {copyFailed ? <Listening>{COPY_FALLBACK}</Listening> : null}
              <Row state={status?.read_at ? 'done' : 'live'}>Reading your comments</Row>
              <Row state={latest >= 2 ? 'done' : status?.read_at ? 'live' : 'todo'}>Writing v{(latest || 1) + (latest >= 2 ? 0 : 1)}</Row>
              <Row state={latest >= 2 ? 'done' : 'todo'}>Published</Row>
            </div>
          ) : null}
        </>
      ) : null}

      {step === 'done' ? (
        <>
          <h2 className="tdoc-wiz-h1">That’s the loop.</h2>
          <p className="tdoc-wiz-sub">v{latest || 2} of {docTitle} is up. Every round works the same way.</p>
          {another ? (
            <>
              <p className="tdoc-wiz-pair-title">Fill in the blank, then paste the line into your agent.</p>
              <FirstDocRecipe line={ANOTHER_DOC_RECIPE} />
              <div className="tdoc-wiz-actions"><button type="button" className="tdoc-wiz-link" onClick={() => setAnother(false)}>Back</button></div>
            </>
          ) : (
            <>
              <OnboardingScene done />
              <div className="tdoc-wiz-actions">
                <button type="button" className="tdoc-wiz-primary" onClick={() => openDoc(latest || 2, 'revised')}>Open v{latest || 2}<OpenIcon /></button>
                <button type="button" className={`tdoc-wiz-secondary${linkCopied ? ' done' : ''}`} onClick={copyShareLink}>{linkCopied ? 'Link copied — send it to someone' : 'Copy the link to share'}</button>
                <button type="button" className="tdoc-wiz-link" onClick={() => setAnother(true)}>Make another doc</button>
              </div>
            </>
          )}
        </>
      ) : null}

      {onClose && step !== 'welcome' ? (
        <button type="button" className="tdoc-wiz-close" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      ) : null}
    </div>
  );
}

// The Docs Hub's "Build it with your agent" card opens the same journey,
// from the connect step, inside the hub's own dialog.
export function OwnAgentDoor({ onOpenChange, closeLabel = 'Back', config = null }) {
  return (
    <div className="tdoc-own-door">
      <OnboardingWizard config={config || { identity: { login: 'you' } }} initialStep="connect" embedded />
      <button type="button" className="tdoc-wiz-link" onClick={() => onOpenChange(false)}>{closeLabel}</button>
    </div>
  );
}

// First-time onboarding, and only that. Behind the landing page's own CTA —
// the page itself is unchanged. `initialDoor` is the step a redirect returns
// to (`?onboard=connect` after the sign-in window closes); the old `own`
// value still lands on the connect step.
export function OnboardingDialog({ open, onOpenChange, config, onSignIn, initialDoor = null }) {
  const initialStep = initialDoor === 'own' ? 'connect' : initialDoor;
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
