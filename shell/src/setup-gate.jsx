import React, { useEffect, useRef, useState } from 'react';
import { copyText } from './document/model.js';
import { getOnboarding, postOnboardingEvent, createOnboardingPractice } from './document/api.js';
import { COPY_FALLBACK, selectContents } from './onboarding-copy.js';
import { AgentMarks } from './agent-marks.jsx';
import { AppSelect } from './ui/select.jsx';
import { SegmentedControl } from './ui/segmented-control.jsx';
import { ConnectReplay, PracticeReplay } from './setup-gate/replay.jsx';
import { DebugBar } from './debug-bar.jsx';

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

export function SetupGate({ boot, preview = null }) {
  const [record, setRecord] = useState(preview?.record || null);
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
          setRecord(result?.record || {});
          setAgents(result?.local_agents || []);
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
    setBusy(true); setError('');
    try {
      const result = await createOnboardingPractice({ device: chosen.device, cli: chosen.cli });
      location.assign(result.url);
    } catch (e) {
      setError(e.message === 'computer_not_ready' ? 'This computer is offline. Wake it up, then try again.' : e.message || 'Could not open your practice doc. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="sg-split">
      <section className="sg-pane-form">
        <a className="sg-brand" href="/me" title="My docs" aria-label="My docs"><img src="/tdoc_logo.svg" alt="" width="28" height="28" data-tdoc-dark="invert" /></a>
        <div className="sg-mid"><div className="sg-col">
          <p className="sg-eyebrow"><span className="sg-step-n">{connected ? 2 : 1}</span>Connect · Choose your AI · Try a comment</p>
          <h1 className="sg-h1">{connected ? 'Choose your AI' : 'Connect your computer'}</h1>
          {!signedIn ? <>
            <p>Use the AI on your computer to revise docs from your comments.</p>
            <button type="button" className="sg-primary" onClick={signIn} disabled={!boot?.oidcAuth}>Sign in</button>
            <p className="sg-account">{boot?.oidcAuth ? 'New here? Signing in creates your account.' : 'Sign-in is not configured on this host.'}</p>
          </> : !loaded ? <p role="status">Checking your computers…</p> : connected ? <>
            <p>Your computer is connected. Choose the AI that will work on your practice doc.</p>
            <AppSelect ariaLabel="Your connected AI" value={keyOf(chosen)} onChange={setSelected} options={available.map((a) => ({ value: keyOf(a), label: labelOf(a) }))} disabled={busy} />
            <div className="sg-status done" role="status"><b>{error.startsWith('This computer is offline') ? 'Connection needs attention' : `Connected · ${labelOf(chosen)}`}</b></div>
            <ol className="sg-steps"><li>Open your private practice doc.</li><li>Select a sentence and leave a comment.</li><li>Send it to your AI and watch a new version arrive.</li></ol>
            <button type="button" className="sg-primary" onClick={practice} disabled={busy}>{busy ? 'Opening your doc…' : 'Try a comment'}</button>
            <p className="sg-account">Your AI runs a new document task using its existing account. Your current chat stays yours.</p>
            <a className="sg-account" href="/me?view=settings#agents">Manage connected computers</a>
          </> : <>
            <p>Install tdoc once. Then send comments to your AI without copying them back to a chat.</p>
            <SegmentedControl value={platform} onChange={setPlatform} ariaLabel="Your computer" options={[{ value: 'unix', label: 'macOS / Linux' }, { value: 'windows', label: 'Windows (WSL)' }]} />
            <div className="sg-prompt"><p className="sg-prompt-text" ref={promptRef}>{SETUP_PROMPT}</p><button type="button" className={`sg-prompt-copy${copied ? ' copied' : ''}`} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
            <p className="sg-works"><span>Works with</span><AgentMarks size={21} /><span className="sg-sr">Claude Code and Codex</span></p>
            <ol className="sg-steps"><li>Paste into {platform === 'windows' ? 'your WSL terminal' : 'Terminal'} on the computer where you use your AI.</li><li>Approve the sign-in in your browser.</li><li>tdoc checks your AI and connects this page automatically.</li></ol>
            <p className="sg-account">Installs a background service and the tdoc skill. Uses your AI account for a small connection check. Runs while your computer is awake and you are signed in.</p>
            <div className="sg-status-slot" aria-live="polite">
              <div className={`sg-status${state === 'stuck' ? ' stuck' : ''}`}>
                {state === 'stuck' ? <><div>Still waiting? Check Terminal for a sign-in or installation error.</div><div className="sg-doctor"><code>{DOCTOR_PROMPT}</code><button type="button" onClick={() => copyText(DOCTOR_PROMPT)}>Copy status command</button></div><a href="https://nodejs.org/">Node.js 18+ is required</a></> : <><span className="sg-spin" aria-hidden="true" />{copyFailed ? COPY_FALLBACK : 'Waiting for your computer…'}</>}
              </div>
            </div>
            <p className="sg-account">Already installed? Run <code>~/.local/bin/tdoc setup</code>. Pause with <code>~/.local/bin/tdoc stop</code>.</p>
          </>}
          {error ? <p className="sg-status stuck" role="alert">{error}</p> : null}
          {signedIn ? <p className="sg-account"><a href="/me">Later</a></p> : null}
        </div></div>
      </section>
      {boot?.debug ? <DebugBar record={record} surface="connect" onState={() => location.reload()} /> : null}
      <aside className="sg-pane-art"><div className="sg-stage"><div className="sg-scene run">{connected ? <PracticeReplay agent={chosen?.cli === 'claude' ? 'Claude Code' : 'Codex'} /> : <ConnectReplay prompt={SETUP_PROMPT} terminal />}</div></div></aside>
    </div>
  );
}
