import React, { useEffect, useRef, useState } from 'react';
import { AppButton } from './ui/button.jsx';
import { ConnectAiApps, CONNECT_AI_APPS } from './connect-ai-apps.jsx';
import { isFeatureOn } from './feature-flags.js';
import { Check, Copy, Loader2, Monitor } from 'lucide-react';
import { copyText } from './document/model.js';
import { getOnboarding, postOnboardingEvent, createOnboardingPractice, startConversationSetup, conversationSetupStatus, updateComputer, getSetupConnectors, testSetupConnector } from './document/api.js';
import { COPY_FALLBACK, selectContents } from './onboarding-copy.js';
import { AppSelect } from './ui/select.jsx';
import { AppDialog } from './ui/dialog.jsx';
import { AIPicker, AI_PRODUCTS } from './ui/ai-picker.jsx';
import { clearPendingAsk, peekPendingAsk } from './document/my-agent.js';

// Shared with Create a doc: existing interactive-agent authoring remains available.
export const DOC_SUBJECT_PREFIX = 'Use tdoc to write a doc about ';
export const DOC_SUBJECT_SUFFIX = ', publish it, and give me the link';
export const DOC_SUBJECT_PLACEHOLDER = 'what it should be about';
export const docSubjectPrompt = (subject) => `${DOC_SUBJECT_PREFIX}${subject}${DOC_SUBJECT_SUFFIX}`;
export const SETUP_PROMPT = 'curl -fsSL https://raw.githubusercontent.com/tornado-doc/tdoc/main/bin/tdoc-install | bash';
const CONNECT_PROMPT = '~/.local/bin/tdoc setup';
export const conversationPrompt = (code, product = 'your AI') => `Set up tdoc for ${product}: follow "Connect a conversation" in https://tdoc.dev/SKILL.md\n~/.local/bin/tdoc connect ${code}`;
export const AUTOMATIC_PROMPT = `Set up tdoc on this computer for automatic comment updates:\n${SETUP_PROMPT}`;
export const DOCTOR_PROMPT = '~/.local/bin/tdoc status';
export const platformPrompt = (code, product) => `${conversationPrompt(code, product)}\nThen connect its task receiver with bin/tdoc-connect-agent (Raft) or bin/tdoc-connect-webhook. Do not install a daemon.`;
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
  const [productId, setProductId] = useState(preview?.product || 'chatgpt');
  const product = AI_PRODUCTS.find(p => p.value === productId) || AI_PRODUCTS[0];
  const [platformTargets, setPlatformTargets] = useState([]);
  const [platformTarget, setPlatformTarget] = useState(null);
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
  const [mcpApp, setMcpApp] = useState('claude');
  const mcpProduct = CONNECT_AI_APPS.find(app => app.id === mcpApp)?.product || 'claude_web';
  // The computer route is two screens, as in Raft: connect the computer, then pick its runtime.
  const [pickRuntime, setPickRuntime] = useState(Boolean(preview?.pickRuntime));
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

  const platformRoute = stage === 'platform';
  const manual = stage === 'manual' || platformRoute;
  const intro = stage === 'intro';
  const mcpIntro = intro && isFeatureOn('remoteMcp');
  const done = stage === 'done';
  // Like Raft: once the computer shows up, move on to Choose your AI by itself.
  // The first check after opening this step is the baseline: a computer that
  // was already connected then does not count as newly connected.
  const wasConnected = useRef(null);
  useEffect(() => {
    if (stage !== 'connect' || !loaded) { wasConnected.current = null; return; }
    if (error) return;
    if (connected && wasConnected.current === false) setPickRuntime(true);
    wasConnected.current = connected;
  }, [connected, stage, loaded, error]);
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
        if (result.ready) {
          if (platformRoute) {
            const connectors = await getSetupConnectors();
            if (cancelled) return;
            const targets = (connectors.targets || []).filter(t => t.provider === (productId === 'raft' ? 'raft' : 'webhook'));
            setPlatformTargets(targets);
            setPlatformTarget(old => targets.find(t => t.server_id === old?.server_id && t.agent_sub === old?.agent_sub) || targets[0] || null);
            if (!targets.length) setError('Your account is connected. Ask your agent to finish connecting its task receiver.');
            else setError('');
          } else { setCompletedPath('manual'); setStage('done'); return; }
        } else setError('');
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
  }, [manual, platformRoute, productId, signedIn, preview, retry]);

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
  const choosePath = (path) => {
    setStage(path); setError(''); setCopied(''); setCopyFailed(false); setPickRuntime(false);
    if (!preview && path !== 'intro') postOnboardingEvent('door_own_agent').catch(() => {});
    if (path === 'connect' && !preview) {
      setLoaded(false); setAgents([]); setComputers([]); started.current = Date.now(); setElapsed(0);
    }
    setAttempt(preview ? { code: 'a'.repeat(32) } : null);
  };
  const instructionBase = platformRoute ? platformPrompt(attempt?.code || '', product.label) : manual ? conversationPrompt(attempt?.code || '', product.label) : AUTOMATIC_PROMPT;
  const releaseRef = /^[a-f0-9]{40}$/.test(boot?.setupRef || '') ? boot.setupRef : 'main';
  const host = typeof location === 'undefined' ? 'https://tdoc.dev' : location.origin;
  // Off tdoc.dev (a preview) the conversation prompt only swaps the SKILL.md host:
  // that host's skill carries the pinned install and connect details. The
  // computer route runs the installer directly, so it pins the revision here.
  const pinnedSetup = `curl -fsSL https://raw.githubusercontent.com/tornado-doc/tdoc/${releaseRef}/bin/tdoc-install | TDOC_INSTALL_REF=${releaseRef} TDOC_HOSTED_BASE=${host} bash`;
  const instruction = instructionBase.replaceAll('https://tdoc.dev/SKILL.md', `${host}/SKILL.md`)
    .replace(SETUP_PROMPT, releaseRef === 'main' ? SETUP_PROMPT : pinnedSetup);
  const copyInstruction = () => copy(instruction, 'instruction', instructionRef);
  // One command: the installer connects this computer right after installing.
  const connectCommand = releaseRef === 'main' ? SETUP_PROMPT : pinnedSetup;
  const setupCommand = host === 'https://tdoc.dev' ? CONNECT_PROMPT : `TDOC_HOSTED_BASE=${host} ${CONNECT_PROMPT}`;
  const connectRef = useRef(null); const setupRef = useRef(null);
  const runtimeOptions = RUNTIMES.filter(r => (computer?.runtimes || []).some(x => x.cli === r.value && x.state !== 'not_installed'));
  const chooseProduct = (id) => {
    setProductId(id); setSelected(id === 'claude' || id === 'codex' ? id : '');
    setPlatformTargets([]); setPlatformTarget(null); choosePath(AI_PRODUCTS.find(p => p.value === id)?.route || 'manual');
  };
  const verifyPlatform = async () => {
    if (!platformTarget || busy) return;
    setBusy(true); setError('');
    try {
      const result = await testSetupConnector(platformTarget);
      if (result.delivery?.status !== 'delivered') throw new Error('Your platform did not receive the test. Try again.');
      if (active.current) { setCompletedPath('platform'); setStage('done'); }
    } catch (e) { if (active.current) setError(e.message || 'Could not check your platform. Try again.'); }
    finally { if (active.current) setBusy(false); }
  };
  const finishConnection = async () => {
    if (!runtimeReady || busy) return;
    setBusy(true); setError('');
    try {
      if (!preview) await updateComputer({ device: chosen.device, cli: chosen.cli, action: 'default' });
      if (active.current) { setCompletedPath('connect'); setStage('done'); }
    } catch (e) { if (active.current) setError(e.message || 'Could not finish setup. Please try again.'); }
    finally { if (active.current) setBusy(false); }
  };
  const tutorial = async (manualProduct) => {
    if (busy || preview) return;
    if (pendingAsk) { location.assign(`/d/${encodeURIComponent(pendingAsk.slug)}`); return; }
    setBusy(true); setError('');
    try {
      const target = manualProduct ? { mode: 'manual' } : completedPath === 'connect' ? { device: chosen?.device, cli: chosen?.cli }
        : completedPath === 'platform' ? { mode: 'platform', recipient: platformTarget } : { mode: 'manual' };
      const result = await createOnboardingPractice({ ...target, product: manualProduct || (completedPath === 'connect' ? chosen.cli : productId) });
      if (active.current) location.assign(result.url);
    } catch (e) {
      if (active.current) { setError(e.message === 'computer_not_ready' ? 'Wake your computer, then try again.' : 'Could not open your tutorial. Try again.'); setBusy(false); }
    }
  };

  const computerRoute = stage === 'connect';
  const head = !signedIn ? { eyebrow: 'Set up Tdoc', title: 'Sign in', description: 'Sign in to connect your AI.' }
    : intro ? { eyebrow: 'Set up Tdoc', title: 'Which AI do you use?', description: 'Tdoc sends your comments to this AI, and it edits your doc.' }
      : done ? { eyebrow: 'Set up Tdoc', title: 'You’re connected', description: `${completedPath === 'connect' && chosen ? labelOf(chosen) : product.label} is ready for your comments.` }
        : computerRoute && pickRuntime ? { eyebrow: 'Set up Tdoc', title: 'Choose your AI', description: `The AI on ${computer?.device || 'this computer'} that edits your docs.` }
          : computerRoute ? { eyebrow: 'Set up Tdoc', title: 'Connect a computer', description: 'A computer is where your AI runs. Tdoc sends it your comments, even when the AI is closed.' }
            : { eyebrow: 'Set up Tdoc', title: `Connect ${product.label}`, description: platformRoute ? `Your ${product.label} agent connects Tdoc to your account and receives your comments.` : `${product.label} connects to your Tdoc account and edits your docs when you ask.` };
  const back = done || intro ? null : computerRoute && pickRuntime ? { label: 'Not this computer? Start over', go: () => setPickRuntime(false) } : { label: 'Choose another AI', go: () => choosePath('intro') };
  // Terminal commands stay on one line, as in Raft; the AI instruction keeps its two lines.
  const cmd = (label, text, name, ref) => <div className={`ui-setup-cmd${name === 'instruction' ? '' : ' is-line'}`} key={name}>
    <p className="ui-setup-cmd-label">{label}</p>
    <div className="ui-setup-cmd-row">
      <code ref={ref} className="ui-setup-instruction">{text || 'Preparing…'}</code>
      <AppButton type="button" className="ui-setup-cmd-copy" aria-label={`Copy ${name}`} title={copied === name ? 'Copied' : 'Copy'} disabled={!text} onClick={() => copy(text, name, ref)}>
        {copied === name ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      </AppButton>
    </div>
  </div>;
  const status = (text, ready = false) => <p role="status" className="ui-setup-status">{ready ? <Check size={14} aria-hidden="true" /> : <Loader2 size={14} aria-hidden="true" className="ui-setup-spin" />}{text}</p>;

  return (
    <AppDialog open={open} onOpenChange={next => { if (!next) close(); }}
      eyebrow={intro ? undefined : head.eyebrow} title={mcpIntro ? 'Connect your AI' : head.title} description={intro ? 'Choose the app you work in.' : head.description}
      className={`ui-setup-modal${intro ? ' ui-setup-entry' : ''}${mcpIntro ? ' ui-setup-entry-mcp' : ''}`} focusTitle
      actions={<>
        {back ? <AppButton type="button" variant="quiet" className="ui-setup-later ui-setup-link" disabled={busy} onClick={back.go}>{back.label}</AppButton>
          : <AppButton type="button" variant="quiet" className="ui-setup-later ui-setup-link" disabled={busy} onClick={close}>Skip</AppButton>}
        {!signedIn ? <AppButton type="button" variant="primary" onClick={signIn} disabled={!boot?.oidcAuth}>Sign in</AppButton>
          : done ? <AppButton type="button" variant="primary" disabled={busy} onClick={() => tutorial()}>{busy ? 'Opening…' : 'Continue'}</AppButton>
            : canReturn ? <AppButton type="button" variant="primary" onClick={() => location.assign(`/d/${encodeURIComponent(pendingAsk.slug)}`)}>Back to the doc</AppButton>
              : mcpIntro ? <AppButton disabled={busy || Boolean(preview)} onClick={() => tutorial(mcpProduct)}>{busy ? 'Opening…' : 'Try a comment'}</AppButton>
                : intro ? null
                : computerRoute && !pickRuntime ? <AppButton type="button" variant="primary" disabled={!connected} onClick={() => setPickRuntime(true)}>Next</AppButton>
                  : computerRoute ? <AppButton type="button" variant="primary" disabled={busy || !runtimeReady} onClick={finishConnection}>{busy ? 'Checking…' : 'Continue'}</AppButton>
                    : <AppButton type="button" variant="primary" disabled={busy || !(platformRoute && platformTarget)} onClick={verifyPlatform}>{busy ? 'Checking…' : platformRoute && platformTarget ? 'Check connection' : 'Next'}</AppButton>}
      </>}
    >
      {!signedIn ? <p>{boot?.oidcAuth ? 'Sign in to connect your AI.' : 'Sign-in is unavailable on this host.'}</p>
        : mcpIntro ? <>
          <ConnectAiApps compact showCli={false} selectedApp={mcpApp} onAppChange={app => setMcpApp(app.id)} />
          <AppButton variant="quiet" className="ui-setup-computer-fallback" onClick={() => chooseProduct(mcpProduct === 'codex' ? 'codex' : 'claude')}>Connect a computer instead</AppButton>
        </> : intro ? <AIPicker onChoose={chooseProduct} />
          : done ? <div className="ui-setup-ready"><Check size={36} aria-hidden="true" /><p>Try a comment. Watch your AI make the change.</p></div>
            : computerRoute && pickRuntime ? <div className="ui-setup-split">
              <div className="ui-setup-split-visual">
                <Monitor size={64} strokeWidth={1.5} aria-hidden="true" />
                <strong>{computer?.device || 'This computer'}</strong>
                <span>{connected ? 'Connected' : computer?.status === 'paused' ? 'Paused' : 'Offline'}</span>
              </div>
              <div className="ui-setup-split-form">
                <label className="ui-setup-field-label" htmlFor="ui-setup-runtime">Runtime <span aria-hidden="true">*</span></label>
                <AppSelect id="ui-setup-runtime" ariaLabel="AI for automatic updates" value={runtime} onChange={setSelected} options={runtimeOptions.length ? runtimeOptions : RUNTIMES} />
                <p className="ui-setup-field-help">The AI runtime that edits your docs on this computer.</p>
                {observed?.state !== 'ready' ? <>
                  <p className="ui-setup-field-help">Sign in to {RUNTIMES.find(r => r.value === runtime)?.label} on this computer, then run this again:</p>
                  {cmd('Check', `${setupCommand} --cli ${runtime}`, 'check', setupRef)}
                </> : null}
                {status(runtimeReady ? `${labelOf(chosen)} is ready.` : !connected ? 'Wake your computer to continue.' : `Waiting for ${RUNTIMES.find(r => r.value === runtime)?.label} to be ready…`, runtimeReady)}
              </div>
            </div>
              : <div className="ui-setup-connection">
                <p className="ui-setup-label">{computerRoute ? 'Connect command' : 'Instruction'}</p>
                {computerRoute ? cmd('Paste into Terminal', connectCommand, 'command', connectRef) : cmd(platformRoute ? `Send to your ${product.label} agent` : `Paste into a new ${product.label} chat`, manual && !attempt ? '' : instruction, 'instruction', instructionRef)}
                <ol className="ui-setup-steps">
                  {computerRoute ? <>
                    <li>Paste the command above into Terminal and press Enter.</li>
                    <li>Approve the request when it opens in your browser.</li>
                    <li>Your computer shows up here on its own. No need to refresh.</li>
                  </> : <>
                    <li>{platformRoute ? `Send the instruction above to your ${product.label} agent.` : `Paste the instruction above into a new ${product.label} chat.`}</li>
                    <li>Approve the request when it opens in your browser.</li>
                    <li>{product.label} shows up here on its own. No need to refresh.</li>
                  </>}
                </ol>
                {platformRoute && platformTargets.length > 1 ? <label className="ui-setup-ai-select">Agent <AppSelect ariaLabel="Platform agent" value={platformTarget ? `${platformTarget.server_id}:${platformTarget.agent_sub}` : ''} options={platformTargets.map(t => ({ value: `${t.server_id}:${t.agent_sub}`, label: [t.agent_name || t.agent_sub, t.server_slug].filter(Boolean).join(' · ') }))} onChange={id => setPlatformTarget(platformTargets.find(t => `${t.server_id}:${t.agent_sub}` === id))} /></label> : null}
                {copyFailed ? <p role="status" className="ui-setup-status">{COPY_FALLBACK}</p>
                  : computerRoute ? status(connected ? `${computer.device} is connected.` : computer?.status === 'paused' ? 'Updates are paused. Resume them in Settings.' : 'Waiting for you to run the command and approve it in your browser…', connected)
                    : status(platformTarget ? 'Linked. Check that it can receive a task.' : manual && !attempt ? 'Preparing your instruction…' : 'Waiting for you to paste the instruction and approve it in your browser…', Boolean(platformTarget))}
                {!attempt && error && manual ? <AppButton type="button" onClick={() => setRetry(value => value + 1)}>Try again</AppButton> : null}
                {computerRoute && state === 'stuck' ? <AppButton type="button" onClick={() => copyText(DOCTOR_PROMPT)}>Copy connection check</AppButton> : null}
              </div>}
      {error ? <p className="ui-setup-error" role="alert">{error}</p> : null}
    </AppDialog>
  );
}
