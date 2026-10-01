import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import './connect-agent-step.css';
import { getOnboarding, postOnboardingEvent } from './api.js';
import { copyText } from './model.js';
import { CONNECT_AGENT_PROMPT } from './notify-handoff.jsx';
import { TutorialStepRow } from './step-hint.jsx';
import { selectContents } from '../onboarding-copy.js';

// The tutorial ends on its revised document. This optional account connection
// enables outbound comments; a publishing terminal alone does not prove it.
export function ConnectAgentStep({ record, onFinished, preview }) {
  const [expanded, setExpanded] = useState(Boolean(preview?.connected));
  const [connected, setConnected] = useState(false);
  const [hidden, setHidden] = useState(Boolean(record?.notify_setup_skipped));
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const promptRef = useRef(null);

  useEffect(() => {
    if (hidden) return undefined;
    let cancelled = false;
    let timer;
    const check = async () => {
      try {
        const result = preview
          ? { notify_connected: preview.connected, record: {} }
          : await getOnboarding({ notify: true });
        if (cancelled) return;
        if (result.anonymous) throw new Error('Sign in again to check your connection.');
        setError('');
        if (result.notify_connected) {
          // Existing connections need no onboarding. Connections made while
          // this step is open get an explicit success state.
          setConnected(true);
          if (!expanded) { setHidden(true); onFinished?.(); }
          return;
        }
        if (result.record?.notify_setup_skipped) { setHidden(true); onFinished?.(); return; }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not check your connection.');
      }
      if (!cancelled && expanded && !preview) timer = setTimeout(check, 3000);
    };
    check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [expanded, hidden, preview, onFinished]);

  const skip = async () => {
    setBusy(true);
    try {
      if (!preview) await postOnboardingEvent('notify_setup_skipped');
      setHidden(true);
      onFinished?.();
    } catch (err) {
      setError(err.message || 'Could not save. Try again.');
    } finally { setBusy(false); }
  };

  const copy = async () => {
    const ok = await copyText(CONNECT_AGENT_PROMPT);
    setCopied(ok);
    if (!ok) { promptRef.current?.focus(); selectContents(promptRef.current); }
  };

  if (hidden) return null;
  return (
    <section className="tdoc-tutorial-agent" aria-label="Step 5: Connect Raft (optional)">
      <div className="sh-hint">
        <TutorialStepRow number={5} optional label={connected ? 'Raft connected' : 'Connect Raft'}
          marker={connected ? <span className="sh-tick" aria-label="Connected"><Check size={13} strokeWidth={3.5} /></span> : null}>
          {connected
            ? <button type="button" className="sh-go" aria-label="Finish tutorial" onClick={() => { setHidden(true); onFinished?.(); }}>Finish</button>
            : <>
              <button type="button" className="sh-go" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide' : 'Show me'}</button>
              <button type="button" className="sh-x sh-skip" aria-label="Skip for now" disabled={busy} onClick={skip}>{busy ? 'Saving…' : 'Skip'}</button>
            </>}
        </TutorialStepRow>
      </div>
      {expanded && !connected ? (
        <div className="tdoc-tutorial-agent-details">
          <p>Paste this into your Raft agent to send comments directly from tdoc.</p>
          <div className="tdoc-handoff-line">
            <code ref={promptRef} tabIndex={0}>{CONNECT_AGENT_PROMPT}</code>
            <button className="tdoc-handoff-copy" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy prompt'}</button>
          </div>
          <p role="status">Waiting for your agent to connect…</p>
        </div>
      ) : null}
      {error ? <p className="tdoc-tutorial-agent-details" role="alert">{error}</p> : null}
    </section>
  );
}
