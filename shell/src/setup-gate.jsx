import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, MessageSquare, Monitor } from 'lucide-react';
import { copyText } from './document/model.js';
import { getOnboarding, postOnboardingEvent, createOnboardingPractice, startConversationSetup, conversationSetupStatus, updateComputer } from './document/api.js';
import { COPY_FALLBACK, selectContents } from './onboarding-copy.js';
import { AppSelect } from './ui/select.jsx';
import { SegmentedControl } from './ui/segmented-control.jsx';
import { AppDialog } from './ui/dialog.jsx';
import { ChoiceLinks } from './ui/choice-links.jsx';
import { clearPendingAsk, peekPendingAsk } from './document/my-agent.js';

// Shared with Create a doc: existing interactive-agent authoring remains available.
export const DOC_SUBJECT_PREFIX = 'Use tdoc to write a doc about ';
export const DOC_SUBJECT_SUFFIX = ', publish it, and give me the link';
export const DOC_SUBJECT_PLACEHOLDER = 'what it should be about';
export const docSubjectPrompt = (subject) => `${DOC_SUBJECT_PREFIX}${subject}${DOC_SUBJECT_SUFFIX}`;
export const SETUP_PROMPT = 'curl -fsSL https://raw.githubusercontent.com/tornado-doc/tdoc/main/bin/tdoc-install | bash';
const INSTALL_PROMPT = `${SETUP_PROMPT} -s -- --install-only`;
const CONNECT_PROMPT = '~/.local/bin/tdoc setup';
export const conversationPrompt = (code) => `Set up tdoc for this AI conversation using https://tdoc.dev/SKILL.md. Prepare the official tools with: ${INSTALL_PROMPT}. Then run ~/.local/bin/tdoc connect ${code} and ask me to approve tdoc sign-in in my browser if needed. Do not create a document or install or start a background helper. Tell me when this conversation is ready to use tdoc.`;
export const AUTOMATIC_PROMPT = `Set up tdoc on this computer for automatic comment updates. Read https://tdoc.dev/SKILL.md and run the official installer: ${SETUP_PROMPT}. It installs the tdoc skill, checks Claude Code or Codex using the existing account, and starts the background helper. Ask me to approve tdoc sign-in in my browser if needed. Do not create a document. Return me to tdoc when setup is ready.`;
export const DOCTOR_PROMPT = '~/.local/bin/tdoc status';
const POLL_MS = 3000;
const STUCK_MS = 90000;
export const readyLocalAgents = (agents) => (agents || []).filter((a) => a.ready && a.status === 'active');
const labelOf = (a) => `${a.cli === 'claude' ? 'Claude Code' : 'Codex'} on ${a.device}`;
const RUNTIMES = [
  { value: 'claude', label: 'Claude Code', url: 'https://code.claude.com/docs/en/setup', login: 'claude' },
  { value: 'codex', label: 'Codex', url: 'https://developers.openai.com/codex/cli/', login: 'codex' },
];

export function SetupGate({ boot, preview = null, startAt = 'intro', onClose }) {
  const [open, setOpen] = useState(true);
  const [stage, setStage] = useState(preview?.stage || startAt);
  const [pendingAsk] = useState(() => preview ? null : peekPendingAsk());
  const [paired, setPaired] = useState(Boolean(preview?.paired));
  const [agents, setAgents] = useState(preview?.local_agents || []);
  const [computers, setComputers] = useState(preview?.local_computers || []);
  const [loaded, setLoaded] = useState(Boolean(preview));
  const [selected, setSelected] = useState('');
  const [attempt, setAttempt] = useState(preview ? { code: 'a'.repeat(32) } : null);
  const [retry, setRetry] = useState(0);
  const [completedPath, setCompletedPath] = useState(preview?.path || 'manual');
  const instructionRef = useRef(null);
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
  const computer = latestComputer || detectedComputers[0];
  const readyOnComputer = available.filter((a) => a.device === computer?.device && computer?.runtimes?.some((r) => r.cli === a.cli && r.state === 'ready'));
  const runtime = readyOnComputer.some((a) => a.cli === selected) ? selected : readyOnComputer[0]?.cli || selected || 'claude';
  const observed = computer?.runtimes?.find((r) => r.cli === runtime);
  const chosen = available.find((a) => a.device === computer?.device && a.cli === runtime && observed?.state === 'ready') || null;
  const connected = Boolean(computer?.status === 'active');
  const runtimeReady = Boolean(chosen && computer?.status === 'active');
  const state = connected ? 'done' : elapsed > STUCK_MS ? 'stuck' : 'waiting';

  const manual = stage === 'manual';
  const intro = stage === 'intro';
  const done = stage === 'done';
  useEffect(() => {
    if (!signedIn || preview || manual || done) return undefined;
    let cancelled = false;
    let timer;
    const tick = async () => {
      try {
        const result = await getOnboarding(stage === 'connect' ? { daemon: true } : undefined);
        if (cancelled) return;
        if (stage === 'connect') { setAgents(result?.local_agents || []); setComputers(result?.local_computers || []); }
        setPaired(Boolean(result?.paired)); setError(''); setLoaded(true); setElapsed(Date.now() - started.current);
      } catch {
        if (!cancelled && !intro) { setAgents([]); setComputers([]); setError('Could not check the connection. Retrying…'); }
      }
      if (!cancelled && !intro) timer = window.setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [signedIn, preview, stage, manual, intro, done]);

  useEffect(() => {
    if (!manual || !signedIn || preview) return undefined;
    let cancelled = false; let timer;
    setAttempt(null); setError('');
    const poll = async (code) => {
      try {
        const result = await conversationSetupStatus(code);
        if (cancelled) return;
        if (result.ready) { setCompletedPath('manual'); setStage('done'); return; }
        setError('');
      } catch (e) {
        if (cancelled) return;
        if (e.status === 410) { setError('This instruction expired. Get a new one and paste it into your AI.'); setAttempt(null); return; }
        setError('Could not check setup. Retrying…');
      }
      if (!cancelled) timer = window.setTimeout(() => poll(code), POLL_MS);
    };
    startConversationSetup().then(result => {
      if (!cancelled) { setAttempt(result); poll(result.code); }
    }).catch(() => { if (!cancelled) setError('Could not prepare setup. Please try again.'); });
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [manual, signedIn, preview, retry]);

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
    if (ok === false) { const details = ref.current?.closest('details'); if (details) details.open = true; selectContents(ref.current); }
    if (!preview) postOnboardingEvent('copy_clicked').catch(() => {});
  };
  const choosePath = (path) => {
    setStage(path); setError(''); setCopied(''); setCopyFailed(false);
    if (!preview && path !== 'intro') postOnboardingEvent('door_own_agent').catch(() => {});
    if (path === 'connect' && !preview) {
      setLoaded(false); setAgents([]); setComputers([]); started.current = Date.now(); setElapsed(0);
    }
    setAttempt(preview ? { code: 'a'.repeat(32) } : null);
  };
  const copyInstruction = () => copy(manual ? conversationPrompt(attempt?.code || '') : AUTOMATIC_PROMPT, 'instruction', instructionRef);
  const finishConnection = async () => {
    if (!runtimeReady || busy) return;
    setBusy(true); setError('');
    try {
      if (!preview) await updateComputer({ device: chosen.device, cli: chosen.cli, action: 'default' });
      if (active.current) { setCompletedPath('connect'); setStage('done'); }
    } catch (e) { if (active.current) setError(e.message || 'Could not finish setup. Please try again.'); }
    finally { if (active.current) setBusy(false); }
  };
  const tutorial = () => {
    if (completedPath === 'connect') practice();
    else if (!preview) location.assign('/me?tutorial=1');
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
      title={done ? 'You’re ready' : intro ? 'How will you use tdoc?' : manual ? 'Connect your AI' : 'Connect a computer'}
      className="ui-setup-modal" focusTitle={intro || done}
      eyebrow="SET UP TDOC"
      description={done ? 'Setup is complete. You can start using tdoc.' : intro ? 'Start in your AI conversation, or connect for automatic updates.' : manual ? 'Ask your AI to set up tdoc, then approve sign-in.' : 'Ask your AI to connect this computer.'}
      actions={<>
        {done ? <>
          <button type="button" disabled={busy} onClick={tutorial}>{busy ? 'Opening tutorial…' : 'Try the tutorial'}</button>
          <button type="button" className="primary" onClick={close}>Go to my docs</button>
        </> : <>
          <button type="button" className="ui-setup-later" disabled={busy} onClick={intro ? close : () => choosePath('intro')}>{intro ? 'Later' : 'Back'}</button>
          {!signedIn ? <button type="button" className="primary" onClick={signIn} disabled={!boot?.oidcAuth}>Sign in</button>
            : canReturn ? <button type="button" className="primary" onClick={() => location.assign(`/d/${encodeURIComponent(pendingAsk.slug)}`)}>Back to the doc</button>
              : !intro ? <button type="button" className="primary" onClick={!manual && runtimeReady ? finishConnection : copyInstruction} disabled={busy || (manual ? !attempt : !loaded)}>{busy ? 'Finishing…' : !manual && runtimeReady ? 'Finish setup' : copied === 'instruction' ? 'Copy again' : 'Copy instruction'}</button> : null}
        </>}

      </>}
    >
      {!signedIn ? <p>{boot?.oidcAuth ? 'Sign in to use tdoc.' : 'Sign-in is not configured on this host.'}</p>
        : intro ? <ChoiceLinks ariaLabel="How to use tdoc" onChoose={choosePath} options={[
          { value: 'manual', label: 'Use with your AI', icon: <MessageSquare size={24} />, description: 'Connect tdoc to your existing AI conversation.', detail: 'ChatGPT Work, Cowork, Grok Bot, Claude Code or Codex' },
          { value: 'connect', label: 'Connect for automatic updates', icon: <Monitor size={24} />, description: 'Let your local AI pick up comments automatically.', detail: 'Claude Code or Codex on your computer' },
        ]} />
          : done ? <div className="ui-setup-manual">
            <p className="ui-setup-connected"><Check size={18} aria-hidden="true" />{completedPath === 'connect' ? `${computer?.device || 'Your computer'} is connected for automatic updates.` : 'Your AI has connected to your tdoc account.'}</p>
            <p>{completedPath === 'connect' ? 'The tdoc skill is available and your AI has passed its connection check.' : 'The tdoc tools and skill are ready for this conversation. No background helper was started.'}</p>
            <p>You can create your first doc now, or try a short tutorial.</p>
            <a href="/me?view=settings#computers">Manage your computers and AI in Settings</a>
          </div>
          : manual ? <div className="ui-setup-manual">
            <p>Paste the instruction into your AI. It will prepare the tdoc tools and skill, then ask you to approve your account.</p>
            <p className="ui-setup-intro">Use ChatGPT Work, Cowork, Grok Bot, Claude Code or Codex with command access.</p>
            {copied === 'instruction' || copyFailed ? <p role="status">{copyFailed ? COPY_FALLBACK : 'Copied. Paste it into your AI.'} Waiting for setup to finish…</p> : !attempt ? <p role="status">Preparing your instruction…</p> : null}
            <details className="ui-setup-details"><summary>View instruction</summary><div className="ui-setup-instruction"><p ref={instructionRef}>{conversationPrompt(attempt?.code || '(preparing…)')}</p></div></details>
            {!attempt && error ? <button type="button" onClick={() => { setCopied(''); setCopyFailed(false); setRetry(value => value + 1); }}>Get a new instruction</button> : null}
            <p className="ui-setup-intro">This connects your AI only. Creating a doc comes next, whenever you’re ready.</p>
          </div>
          : !loaded ? <p role="status">Checking your computers…</p> : <>
            <details className="ui-setup-details"><summary>View instruction</summary><div className="ui-setup-instruction"><p ref={instructionRef}>{AUTOMATIC_PROMPT}</p></div></details>
            {!connected ? <>
              <p>Paste one instruction into Claude Code or Codex on this computer, then approve sign-in in your browser.</p>
              <p className="ui-setup-intro">Your AI installs the tdoc skill and connects a background helper for automatic comment updates.</p>
              <details className="ui-setup-details"><summary>Use Terminal instead</summary>
                <div className="ui-setup-toolbar"><p className="ui-setup-label">YOUR COMPUTER</p><SegmentedControl value={platform} onChange={setPlatform} ariaLabel="Your computer" options={[{ value: 'unix', label: 'macOS / Linux' }, { value: 'windows', label: 'Windows (WSL)' }]} /></div>
                <p className="ui-setup-command-label">1. Install the tdoc skill and tools</p>
                <div className="ui-setup-command"><code ref={promptRef}>{INSTALL_PROMPT}</code><button type="button" aria-label={copied === 'install' ? 'Install command copied' : 'Copy install command'} onClick={() => copy(INSTALL_PROMPT, 'install', promptRef)}>{copied === 'install' ? '✓' : '⧉'}</button></div>
                <p className="ui-setup-command-label">2. Connect and check your AI</p>
                <div className="ui-setup-command"><code ref={connectRef}>{CONNECT_PROMPT}</code><button type="button" aria-label={copied === 'setup' ? 'Setup command copied' : 'Copy setup command'} onClick={() => copy(CONNECT_PROMPT, 'setup', connectRef)}>{copied === 'setup' ? '✓' : '⧉'}</button></div>
                <p>Paste both commands into {platform === 'windows' ? 'your WSL terminal' : 'your terminal'}, then approve sign-in in your browser.</p>
              </details>
            </> : null}
            <div className="ui-setup-status" role="status" aria-live="polite">
              {connected ? <span className="ui-setup-connected"><Check size={14} aria-hidden="true" /> Connected · {computer.device}</span>
                : state === 'stuck' ? <><p>Still waiting? Ask your AI to check the setup and tdoc sign-in.</p><button type="button" onClick={() => copyText(DOCTOR_PROMPT)}>Copy status command</button></>
                  : <><span className="sg-spin" aria-hidden="true" />{copied === 'instruction' ? 'Paste it into your AI, then approve sign-in.' : 'Waiting for your AI to connect…'}</>}
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
              {readyOnComputer.length > 1 ? <label className="ui-setup-ai-select">AI <AppSelect ariaLabel="AI for automatic updates" value={runtime} onChange={setSelected} options={RUNTIMES.filter((r) => readyOnComputer.some((a) => a.cli === r.value))} /></label> : null}
            </> : null}
            {computer && !connected ? <p role="status">{computer.status === 'paused' ? <>Automatic updates are paused. <a href="/me?view=settings#computers">Resume in Settings</a>.</> : 'This computer is offline. Wake it up to check its AI.'}</p> : null}
            {copyFailed ? <p role="status">{COPY_FALLBACK}</p> : null}
            {canReturn ? <p>Your agent is already linked. You can return to your question and copy it while this computer is offline.</p> : null}
            <details className="ui-setup-details"><summary>Installation details</summary><p>The installer adds the tdoc skill and tools. Setup connects your account, checks your AI using its existing account, and starts the optional background helper. Keep this computer awake to receive tasks automatically.</p><p>Already installed? Run <code>~/.local/bin/tdoc setup</code>. Pause with <code>~/.local/bin/tdoc stop</code>.</p></details>
          </>}
      {error ? <p className="ui-setup-error" role="alert">{error}</p> : null}
    </AppDialog>
  );
}
