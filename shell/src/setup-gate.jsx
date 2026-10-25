import React, { useEffect, useRef, useState } from 'react';
import { copyText } from './document/model.js';
import { getOnboarding, postOnboardingEvent, createOnboardingPractice } from './document/api.js';
import { COPY_FALLBACK, selectContents } from './onboarding-copy.js';
import { AgentMarks, ClaudeMark, OpenAIMark } from './agent-marks.jsx';
import { ChoiceCards } from './ui/choice-cards.jsx';
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
const INSTALL_PROMPT = `${SETUP_PROMPT} -s -- --install-only`;
const CONNECT_PROMPT = '~/.local/bin/tdoc setup';
export const DOCTOR_PROMPT = '~/.local/bin/tdoc status';
const POLL_MS = 3000;
const STUCK_MS = 90000;
export const readyLocalAgents = (agents) => (agents || []).filter((a) => a.ready && a.status === 'active');
const labelOf = (a) => `${a.cli === 'claude' ? 'Claude Code' : 'Codex'} on ${a.device}`;
const RUNTIMES = [
  { value: 'claude', label: 'Claude Code', url: 'https://code.claude.com/docs/en/setup', login: 'claude', icon: <ClaudeMark size={26} /> },
  { value: 'codex', label: 'Codex', url: 'https://developers.openai.com/codex/cli/', login: 'codex', icon: <OpenAIMark size={32} /> },
];

export function SetupGate({ boot, preview = null, onClose }) {
  const [open, setOpen] = useState(true);
  const [stage, setStage] = useState(preview?.stage || 'connect');
  const [pendingAsk] = useState(() => preview ? null : peekPendingAsk());
  const [paired, setPaired] = useState(Boolean(preview?.paired));
  const [agents, setAgents] = useState(preview?.local_agents || []);
  const [computers, setComputers] = useState(preview?.local_computers || []);
  const [selectedComputer, setSelectedComputer] = useState('');
  const [loaded, setLoaded] = useState(Boolean(preview));
  const [selected, setSelected] = useState('');
  const [copied, setCopied] = useState('');
  const [copyFailed, setCopyFailed] = useState(false);
  const [elapsed, setElapsed] = useState(preview?.elapsed || 0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState('unix');
  const promptRef = useRef(null);
  const connectRef = useRef(null);
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  const started = useRef(Date.now());
  const signedIn = Boolean(boot?.identity);
  const available = readyLocalAgents(agents);
  // Older helpers expose only agents. Do not infer missing installations from
  // that incomplete list; the next setup run supplies the full inventory.
  const detectedComputers = [...computers];
  for (const agent of agents) {
    if (!detectedComputers.some((c) => c.device === agent.device)) detectedComputers.push({ device: agent.device, status: agent.status, runtimes: agents.filter((a) => a.device === agent.device).map((a) => ({ cli: a.cli, state: a.ready ? 'ready' : 'needs_check' })) });
  }
  const computer = detectedComputers.find((c) => c.device === selectedComputer)
    || (selectedComputer ? null : detectedComputers.find((c) => c.status === 'active' && available.some((a) => a.device === c.device)) || detectedComputers.find((c) => c.status === 'active') || detectedComputers[0]);
  const runtime = selected || computer?.runtimes?.find((r) => r.state === 'ready')?.cli || 'claude';
  const observed = computer?.runtimes?.find((r) => r.cli === runtime);
  const chosen = available.find((a) => a.device === computer?.device && a.cli === runtime && observed?.state === 'ready') || null;
  const connected = detectedComputers.some((c) => c.status === 'active');
  const runtimeReady = Boolean(chosen && computer?.status === 'active');
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
          setComputers(result?.local_computers || []);
          setPaired(Boolean(result?.paired));
          setError((previous) => previous === 'Could not check the connection. Retrying…' ? '' : previous);
        }
      } catch { if (!cancelled) { setAgents([]); setComputers([]); setError('Could not check the connection. Retrying…'); } }
      if (cancelled) return;
      setLoaded(true);
      setElapsed(Date.now() - started.current);
      // Keep checking after connection: sleep, disconnect and expiry can change readiness.
      timer = window.setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [signedIn, preview]);

  const choose = stage === 'choose';
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
  const copy = async (command, name, ref) => {
    const ok = await copyText(command);
    setCopied(ok === false ? '' : name); setCopyFailed(ok === false);
    if (ok === false) selectContents(ref.current);
    if (!preview) postOnboardingEvent('copy_clicked').catch(() => {});
  };
  const practice = async () => {
    if (!runtimeReady || busy || preview) return;
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
      eyebrow="SET UP TDOC"
      description={choose ? 'Choose the AI that will work on your docs.' : 'A computer is the machine your AI runs on. Keep at least one online to work on your docs.'}
      actions={<>
        <button type="button" className="ui-setup-later" onClick={choose ? () => setStage('connect') : close}>{choose ? 'Back' : 'Later'}</button>
        {!signedIn ? <button type="button" className="primary" onClick={signIn} disabled={!boot?.oidcAuth}>Sign in</button>
          : canReturn ? <button type="button" className="primary" onClick={() => location.assign(`/d/${encodeURIComponent(pendingAsk.slug)}`)}>Back to the doc</button>
          : choose ? <button type="button" className="primary" onClick={practice} disabled={busy || !runtimeReady}>{busy ? 'Opening your doc…' : pendingAsk ? 'Back to the doc' : 'Try a comment'}</button>
            : <button type="button" className="primary" disabled={!loaded || !connected} onClick={() => setStage('choose')}>Next</button>}
      </>}
    >
      {!signedIn ? <p>{boot?.oidcAuth ? 'Sign in to connect this computer.' : 'Sign-in is not configured on this host.'}</p>
        : !loaded ? <p role="status">Checking your computers…</p>
          : choose ? <>
            <AppSelect ariaLabel="Connected computer" value={computer?.device || ''} onChange={(device) => { setSelectedComputer(device); setSelected(''); setError(''); }} options={detectedComputers.map((c) => ({ value: c.device, label: `${c.device}${c.status === 'active' ? '' : ' · Offline'}` }))} disabled={busy || !detectedComputers.length} />
            <p className="ui-setup-intro">Detected on {computer?.device || 'your connected computer'}. Uses your existing AI account.</p>
            <ChoiceCards ariaLabel="Local AI runtimes" value={runtime} onChange={(cli) => { setSelectedComputer(computer?.device || ''); setSelected(cli); setError(''); }} disabled={busy} options={RUNTIMES.map((option) => {
              const found = computer?.runtimes?.find((r) => r.cli === option.value);
              const online = computer?.status === 'active';
              const verified = found?.state === 'ready' && available.some((a) => a.device === computer.device && a.cli === option.value);
              return { ...option, description: found?.version ? `Version ${found.version}` : option.value === 'claude' ? 'Your local Claude Code CLI' : 'Your local Codex CLI', status: !online ? 'Offline' : verified ? 'Ready' : found?.state === 'not_installed' ? 'Not installed' : found ? 'Needs a check' : 'Not detected' };
            })} />
            <div className="ui-setup-runtime-help" role="status" aria-live="polite">
              {computer?.status !== 'active' ? <p>This computer is offline. Wake it up to check its AI.</p>
                : runtimeReady ? <p className="ui-setup-connected">Ready · {labelOf(chosen)}</p>
                  : <><p>{observed?.state === 'not_installed' ? <>Install <a href={RUNTIMES.find((r) => r.value === runtime).url} target="_blank" rel="noreferrer">{RUNTIMES.find((r) => r.value === runtime).label}</a> on {computer.device}.</> : <>Open <code>{RUNTIMES.find((r) => r.value === runtime).login}</code> on {computer.device} and check its sign-in.</>}</p><p>Then run <code>{CONNECT_PROMPT} --cli {runtime}</code>. This page updates automatically.</p><button type="button" onClick={() => copyText(`${CONNECT_PROMPT} --cli ${runtime}`)}>Copy check command</button></>}
            </div>
            {runtimeReady ? <p className="ui-setup-intro">{pendingAsk ? 'Your question will be waiting when you return.' : 'Next, try a comment in your private practice doc.'}</p> : null}
          </> : <>
            <div className="ui-setup-toolbar"><p className="ui-setup-label"><span aria-hidden="true">›_</span> CONNECT COMMAND</p><SegmentedControl value={platform} onChange={setPlatform} ariaLabel="Your computer" options={[{ value: 'unix', label: 'macOS / Linux' }, { value: 'windows', label: 'Windows (WSL)' }]} /></div>
            <p className="ui-setup-intro">Install the tdoc CLI on this {platform === 'windows' ? 'Windows (WSL)' : 'macOS or Linux'} machine, then connect it to your account.</p>
            <p className="ui-setup-command-label">1. Install</p>
            <div className="ui-setup-command"><code ref={promptRef}>{INSTALL_PROMPT}</code><button type="button" aria-label={copied === 'install' ? 'Install command copied' : 'Copy install command'} onClick={() => copy(INSTALL_PROMPT, 'install', promptRef)}>{copied === 'install' ? '✓' : '⧉'}</button></div>
            <p className="ui-setup-command-label">2. Setup</p>
            <div className="ui-setup-command"><code ref={connectRef}>{CONNECT_PROMPT}</code><button type="button" aria-label={copied === 'setup' ? 'Setup command copied' : 'Copy setup command'} onClick={() => copy(CONNECT_PROMPT, 'setup', connectRef)}>{copied === 'setup' ? '✓' : '⧉'}</button></div>
            <ol className="ui-setup-steps"><li>Paste the commands above into {platform === 'windows' ? 'your WSL terminal' : 'your terminal'} and press Enter.</li><li>Approve the request when it opens in your browser.</li><li>Your computer shows up here on its own. No need to refresh.</li></ol>
            <div className="ui-setup-status" role="status" aria-live="polite">
              {connected ? <span className="ui-setup-connected">Connected · {detectedComputers.find((c) => c.status === 'active').device}</span>
                : state === 'stuck' ? <><p>Still waiting? Check Terminal for a sign-in or installation error.</p><code>{DOCTOR_PROMPT}</code><button type="button" onClick={() => copyText(DOCTOR_PROMPT)}>Copy status command</button><p><a href="https://nodejs.org/">Node.js 18+ is required</a></p></>
                  : <><span className="sg-spin" aria-hidden="true" />{copyFailed ? COPY_FALLBACK : 'Waiting for you to run the commands and approve in your browser…'}</>}
            </div>
            {canReturn ? <p>Your agent is already linked. You can return to your question and copy it while this computer is offline.</p> : null}
            <details className="ui-setup-details"><summary>Installation details</summary><p>Installs tdoc in the background and checks your AI using its existing account. Keep this computer awake to receive tasks.</p><p>Already installed? Run <code>~/.local/bin/tdoc setup</code>. Pause with <code>~/.local/bin/tdoc stop</code>.</p><p className="sg-works"><AgentMarks size={21} /><span className="sg-sr">Claude Code and Codex</span></p></details>
          </>}
      {error ? <p className="ui-setup-error" role="alert">{error}</p> : null}
    </AppDialog>
  );
}
