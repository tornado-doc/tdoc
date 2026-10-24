import React, { useEffect, useRef, useState } from 'react';
import { copyText } from './document/model.js';
import { getOnboarding, postOnboardingEvent, createOnboardingPractice } from './document/api.js';
import { COPY_FALLBACK, selectContents } from './onboarding-copy.js';
import { AgentMarks } from './agent-marks.jsx';
import { AppSelect } from './ui/select.jsx';
import { SegmentedControl } from './ui/segmented-control.jsx';
import { AppDialog } from './ui/dialog.jsx';
import { clearPendingAsk, peekPendingAsk } from './document/my-agent.js';

// Shared with Create a doc: existing interactive-agent authoring remains available.
export const DOC_SUBJECT_PREFIX = 'Use tdoc to write a doc about ';
export const DOC_SUBJECT_SUFFIX = ', publish it, and give me the link';
export const DOC_SUBJECT_PLACEHOLDER = 'what it should be about';
export const docSubjectPrompt = (subject) => `${DOC_SUBJECT_PREFIX}${subject}${DOC_SUBJECT_SUFFIX}`;
export const SETUP_PROMPT = 'curl -fsSL https://raw.githubusercontent.com/tornado-doc/tdoc/main/bin/tdoc-install | bash';
export const DOCTOR_PROMPT = '~/.local/bin/tdoc status';
const POLL_MS = 3000;
const STUCK_MS = 90000;
export const readyLocalAgents = (agents) => (agents || []).filter((a) => a.ready && a.status === 'active');
const keyOf = (a) => `${a.device}/${a.cli}`;
const labelOf = (a) => `${a.cli === 'claude' ? 'Claude Code' : 'Codex'} on ${a.device}`;

export function SetupGate({ boot, preview = null, onClose }) {
  const [open, setOpen] = useState(true);
  const [stage, setStage] = useState(preview?.stage || 'connect');
  const [pendingAsk] = useState(() => preview ? null : peekPendingAsk());
  const [paired, setPaired] = useState(Boolean(preview?.paired));
  const [agents, setAgents] = useState(preview?.local_agents || []);
  const [loaded, setLoaded] = useState(Boolean(preview));
  const [selected, setSelected] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [elapsed, setElapsed] = useState(preview?.elapsed || 0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState('unix');
  const promptRef = useRef(null);
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  const started = useRef(Date.now());
  const signedIn = Boolean(boot?.identity);
  const available = readyLocalAgents(agents);
  const chosen = available.find((a) => keyOf(a) === selected) || available[0] || null;
  // Neither a historical token nor an installed CLI proves the computer can run jobs.
  const connected = Boolean(chosen);
  const state = connected ? 'done' : elapsed > STUCK_MS ? 'stuck' : 'waiting';

  useEffect(() => {
    if (!signedIn || preview) return undefined;
    let cancelled = false;
    let timer;
    const tick = async () => {
      try {
        const result = await getOnboarding({ daemon: true });
        if (!cancelled) {
          setAgents(result?.local_agents || []);
          setPaired(Boolean(result?.paired));
          setError((previous) => previous === 'Could not check the connection. Retrying…' ? '' : previous);
        }
      } catch { if (!cancelled) setError('Could not check the connection. Retrying…'); }
      if (cancelled) return;
      setLoaded(true);
      setElapsed(Date.now() - started.current);
      // Keep checking after connection: sleep, disconnect and expiry can change readiness.
      timer = window.setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [signedIn, preview]);

  const choose = stage === 'choose' && connected;
  // A paired reader can return and copy a question even while their helper is offline.
  // This never marks a computer ready or enables Next for a new author.
  const canReturn = Boolean(pendingAsk && paired);
  const close = () => {
    active.current = false;
    if (pendingAsk) clearPendingAsk();
    setOpen(false);
    if (onClose) onClose();
    else if (!preview) location.assign('/me');
  };
  const signIn = () => {
    if (!preview) location.href = '/api/auth/oidc/login?prompt=login&return=%2Fsetup';
  };
  const copy = async () => {
    const ok = await copyText(SETUP_PROMPT);
    setCopied(ok !== false); setCopyFailed(ok === false);
    if (ok === false) selectContents(promptRef.current);
    if (!preview) postOnboardingEvent('copy_clicked').catch(() => {});
  };
  const practice = async () => {
    if (!chosen || busy || preview) return;
    if (pendingAsk) { location.assign(`/d/${encodeURIComponent(pendingAsk.slug)}`); return; }
    setBusy(true); setError('');
    try {
      const result = await createOnboardingPractice({ device: chosen.device, cli: chosen.cli });
      if (active.current) location.assign(result.url);
    } catch (e) {
      if (!active.current) return;
      setError(e.message === 'computer_not_ready' ? 'This computer is offline. Wake it up, then try again.' : e.message || 'Could not open your practice doc. Please try again.');
      setBusy(false);
    }
  };

  return (
    <AppDialog open={open} onOpenChange={(next) => { if (!next) close(); }}
      title={choose ? 'Choose your AI' : 'Connect a computer'}
      className="ui-setup-modal"
      description={choose ? 'Choose the AI that will work on your docs.' : 'Connect the computer where you use Claude Code or Codex.'}
      actions={<>
        <button type="button" className="ui-setup-later" onClick={choose ? () => setStage('connect') : close}>{choose ? 'Back' : 'Later'}</button>
        {!signedIn ? <button type="button" className="primary" onClick={signIn} disabled={!boot?.oidcAuth}>Sign in</button>
          : canReturn ? <button type="button" className="primary" onClick={() => location.assign(`/d/${encodeURIComponent(pendingAsk.slug)}`)}>Back to the doc</button>
          : choose ? <button type="button" className="primary" onClick={practice} disabled={busy}>{busy ? 'Opening your doc…' : pendingAsk ? 'Back to the doc' : 'Try a comment'}</button>
            : <button type="button" className="primary" disabled={!loaded || !connected} onClick={() => setStage('choose')}>Next</button>}
      </>}
    >
      <p className="ui-setup-eyebrow">{choose ? 'Step 2 of 2' : 'Step 1 of 2'}</p>
      {!signedIn ? <p>{boot?.oidcAuth ? 'Sign in to connect this computer.' : 'Sign-in is not configured on this host.'}</p>
        : !loaded ? <p role="status">Checking your computers…</p>
          : choose ? <>
            <AppSelect ariaLabel="Your connected AI" value={keyOf(chosen)} onChange={setSelected} options={available.map((a) => ({ value: keyOf(a), label: labelOf(a) }))} disabled={busy} />
            <p className="ui-setup-connected" role="status">{error.startsWith('This computer is offline') ? 'Connection needs attention' : `Connected · ${labelOf(chosen)}`}</p>
            <p>{pendingAsk ? 'Your question will be waiting when you return.' : 'Next, select a sentence in your private practice doc and leave a comment.'}</p>
          </> : <>
            <SegmentedControl value={platform} onChange={setPlatform} ariaLabel="Your computer" options={[{ value: 'unix', label: 'macOS / Linux' }, { value: 'windows', label: 'Windows (WSL)' }]} />
            <p className="ui-setup-label">Install and connect</p>
            <div className="ui-setup-command"><code ref={promptRef}>{SETUP_PROMPT}</code><button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
            <ol className="ui-setup-steps"><li>Paste into {platform === 'windows' ? 'your WSL terminal' : 'Terminal'} and press Enter.</li><li>Approve the request in your browser.</li><li>Your computer appears here automatically.</li></ol>
            <div className="ui-setup-status" role="status" aria-live="polite">
              {connected ? <span className="ui-setup-connected">Connected · {chosen.device}</span>
                : state === 'stuck' ? <><p>Still waiting? Check Terminal for a sign-in or installation error.</p><code>{DOCTOR_PROMPT}</code><button type="button" onClick={() => copyText(DOCTOR_PROMPT)}>Copy status command</button><p><a href="https://nodejs.org/">Node.js 18+ is required</a></p></>
                  : <><span className="sg-spin" aria-hidden="true" />{copyFailed ? COPY_FALLBACK : 'Waiting for your computer…'}</>}
            </div>
            {canReturn ? <p>Your agent is already linked. You can return to your question and copy it while this computer is offline.</p> : null}
            <details className="ui-setup-details"><summary>Installation details</summary><p>Installs tdoc in the background and checks your AI using its existing account. Keep this computer awake to receive tasks.</p><p>Already installed? Run <code>~/.local/bin/tdoc setup</code>. Pause with <code>~/.local/bin/tdoc stop</code>.</p><p className="sg-works"><AgentMarks size={21} /><span className="sg-sr">Claude Code and Codex</span></p></details>
          </>}
      {error ? <p className="ui-setup-error" role="alert">{error}</p> : null}
    </AppDialog>
  );
}
