import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { copyText } from './document/model.js';
import { getOnboarding, postOnboardingEvent, createOnboardingPractice } from './document/api.js';
import { COPY_FALLBACK, selectContents } from './onboarding-copy.js';
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
  { value: 'claude', label: 'Claude Code', url: 'https://code.claude.com/docs/en/setup', login: 'claude' },
  { value: 'codex', label: 'Codex', url: 'https://developers.openai.com/codex/cli/', login: 'codex' },
];

export function SetupGate({ boot, preview = null, onClose }) {
  const [open, setOpen] = useState(true);
  const [stage, setStage] = useState(preview?.stage || 'connect');
  const [pendingAsk] = useState(() => preview ? null : peekPendingAsk());
  const [paired, setPaired] = useState(Boolean(preview?.paired));
  const [agents, setAgents] = useState(preview?.local_agents || []);
  const [computers, setComputers] = useState(preview?.local_computers || []);
  const [connectedDevice, setConnectedDevice] = useState('');
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
  const latestComputer = [...detectedComputers].reverse()
    .sort((a, b) => (Date.parse(b.connected_at || b.last_seen) || 0) - (Date.parse(a.connected_at || a.last_seen) || 0))[0];
  const computer = connectedDevice ? detectedComputers.find((c) => c.device === connectedDevice) : latestComputer || detectedComputers[0];
  const runtime = selected || computer?.runtimes?.find((r) => r.state === 'ready')?.cli || 'claude';
  const observed = computer?.runtimes?.find((r) => r.cli === runtime);
  const chosen = available.find((a) => a.device === computer?.device && a.cli === runtime && observed?.state === 'ready') || null;
  const connected = Boolean(computer?.status === 'active');
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

  const manual = stage === 'manual';
  const readyOnComputer = available.filter((a) => a.device === computer?.device && computer?.runtimes?.some((r) => r.cli === a.cli && r.state === 'ready'));
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
    if ((!manual && !runtimeReady) || busy || preview) return;
    if (pendingAsk) { location.assign(`/d/${encodeURIComponent(pendingAsk.slug)}`); return; }
    setBusy(true); setError('');
    try {
      const result = await createOnboardingPractice(manual ? { mode: 'manual' } : { device: chosen.device, cli: chosen.cli });
      if (active.current) location.assign(result.url);
    } catch (e) {
      if (!active.current) return;
      setError(e.message === 'computer_not_ready' ? 'This computer is offline. Wake it up, then try again.' : e.message || 'Could not open your practice doc. Please try again.');
      setBusy(false);
    }
  };

  return (
    <AppDialog open={open} onOpenChange={(next) => { if (!next) close(); }}
      title={manual ? 'Use your AI' : 'Connect a computer'}
      className="ui-setup-modal"
      eyebrow="SET UP TDOC"
      description={manual ? 'Work with your AI by copying a comment into your conversation.' : 'Connect a computer to let your AI pick up comments automatically. The background helper is optional.'}
      actions={<>
        <button type="button" className="ui-setup-later" onClick={manual ? () => { setStage('connect'); setError(''); } : close}>{manual ? 'Back' : 'Later'}</button>
        {!signedIn ? <button type="button" className="primary" onClick={signIn} disabled={!boot?.oidcAuth}>Sign in</button>
          : canReturn ? <button type="button" className="primary" onClick={() => location.assign(`/d/${encodeURIComponent(pendingAsk.slug)}`)}>Back to the doc</button>
          : <button type="button" className="primary" onClick={practice} disabled={busy || (!manual && (!loaded || !runtimeReady))}>{busy ? 'Opening your doc…' : manual ? 'Try a comment' : 'Next'}</button>}
      </>}
    >
      {!signedIn ? <p>{boot?.oidcAuth ? 'Sign in to use tdoc.' : 'Sign-in is not configured on this host.'}</p>
        : manual ? <div className="ui-setup-manual">
          <p className="ui-setup-label">NO BACKGROUND HELPER NEEDED</p>
          <h3>Keep working in your AI conversation.</h3>
          <p>Leave a comment in your private practice doc, then copy its instruction into your AI. It can read the comments and publish a revision at the same link.</p>
          <p>Use a conversation with terminal access, such as Cowork or Grok Bot. In ChatGPT, use a mode with terminal access. Plain chat can help write a doc, but cannot publish a revision by itself.</p>
          <p>You may need to approve tdoc sign-in in your browser. Nothing runs in the background.</p>
          <a href="https://tdoc.dev/SKILL.md" target="_blank" rel="noreferrer">Instructions for your AI ↗</a>
        </div>
          : !loaded ? <p role="status">Checking your computers…</p> : <>
            <div className="ui-setup-toolbar"><p className="ui-setup-label"><span aria-hidden="true">›_</span> CONNECT COMMAND</p><SegmentedControl value={platform} onChange={setPlatform} ariaLabel="Your computer" options={[{ value: 'unix', label: 'macOS / Linux' }, { value: 'windows', label: 'Windows (WSL)' }]} /></div>
            <p className="ui-setup-intro">Install the tdoc CLI on this {platform === 'windows' ? 'Windows (WSL)' : 'macOS or Linux'} machine, then connect it to your account.</p>
            <p className="ui-setup-command-label">1. Install</p>
            <div className="ui-setup-command"><code ref={promptRef}>{INSTALL_PROMPT}</code><button type="button" aria-label={copied === 'install' ? 'Install command copied' : 'Copy install command'} onClick={() => copy(INSTALL_PROMPT, 'install', promptRef)}>{copied === 'install' ? '✓' : '⧉'}</button></div>
            <p className="ui-setup-command-label">2. Setup</p>
            <div className="ui-setup-command"><code ref={connectRef}>{CONNECT_PROMPT}</code><button type="button" aria-label={copied === 'setup' ? 'Setup command copied' : 'Copy setup command'} onClick={() => copy(CONNECT_PROMPT, 'setup', connectRef)}>{copied === 'setup' ? '✓' : '⧉'}</button></div>
            {!connected ? <ol className="ui-setup-steps"><li>Paste the commands above into {platform === 'windows' ? 'your WSL terminal' : 'your terminal'} and press Enter.</li><li>Approve the request when it opens in your browser.</li><li>Your computer shows up here on its own. No need to refresh.</li></ol> : null}
            <div className="ui-setup-status" role="status" aria-live="polite">
              {connected ? <span className="ui-setup-connected"><Check size={14} aria-hidden="true" /> Connected · {computer.device}</span>
                : state === 'stuck' ? <><p>Still waiting? Check Terminal for a sign-in or installation error.</p><code>{DOCTOR_PROMPT}</code><button type="button" onClick={() => copyText(DOCTOR_PROMPT)}>Copy status command</button><p><a href="https://nodejs.org/">Node.js 18+ is required</a></p></>
                  : <><span className="sg-spin" aria-hidden="true" />Waiting for you to run the commands and approve in your browser…</>}
            </div>
            {connected ? <>
              {runtimeReady ? <div className="ui-setup-status ui-setup-connected" role="status"><Check size={14} aria-hidden="true" />{labelOf(chosen)} detected{observed?.version ? ` · ${observed.version}` : ''}</div>
                : <section className="ui-setup-runtime-help" aria-label="Local AI installation">
                  <h3>No AI is ready on this computer yet</h3>
                  <p>Install an AI or finish its sign-in, then run the check below.</p>
                  {RUNTIMES.map((option) => {
                    const found = computer.runtimes?.find((r) => r.cli === option.value);
                    return <details className="ui-setup-runtime" key={option.value}>
                      <summary><span className="ui-setup-runtime-mark">{option.value === 'claude' ? 'CC' : 'CX'}</span><strong>{option.label}</strong><span className="ui-setup-runtime-state">{found?.state === 'not_installed' ? 'Not detected' : found?.state === 'needs_check' ? 'Needs a check' : 'Checking…'}</span><ChevronRight size={14} aria-hidden="true" /></summary>
                      <div><p>{found?.state === 'not_installed' ? <>Install <a href={option.url} target="_blank" rel="noreferrer">{option.label}</a>, then open <code>{option.login}</code> and sign in.</> : <>Open <code>{option.login}</code> and check its sign-in.</>}</p><code>{CONNECT_PROMPT} --cli {option.value}</code><button type="button" onClick={() => copyText(`${CONNECT_PROMPT} --cli ${option.value}`)}>Copy check command</button></div>
                    </details>;
                  })}
                </section>}
              {readyOnComputer.length > 1 ? <label className="ui-setup-ai-select">AI <AppSelect ariaLabel="AI for this doc" value={runtime} onChange={setSelected} options={RUNTIMES.filter((r) => readyOnComputer.some((a) => a.cli === r.value))} /></label> : null}
            </> : null}
            {connectedDevice && !connected ? <p role="status">This computer is offline. Wake it up to check its AI.</p> : null}
            {copyFailed ? <p role="status">{COPY_FALLBACK}</p> : null}
            {canReturn ? <p>Your agent is already linked. You can return to your question and copy it while this computer is offline.</p> : null}
            <button type="button" className="ui-setup-manual-link" onClick={() => { setStage('manual'); setError(''); }}>Use without a background helper →</button>
            <details className="ui-setup-details"><summary>Installation details</summary><p>Setup installs an optional background helper and checks your AI using its existing account. Keep this computer awake to receive tasks automatically.</p><p>Already installed? Run <code>~/.local/bin/tdoc setup</code>. Pause with <code>~/.local/bin/tdoc stop</code>.</p></details>
          </>}
      {error ? <p className="ui-setup-error" role="alert">{error}</p> : null}
    </AppDialog>
  );
}
