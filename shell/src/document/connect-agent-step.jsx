import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import './connect-agent-step.css';
import { getOnboarding, postOnboardingEvent } from './api.js';
import { copyText } from './model.js';
import { CONNECT_AGENT_PROMPT } from './notify-handoff.jsx';

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
    if (!ok) { promptRef.current?.focus(); promptRef.current?.select(); }
  };

  if (hidden) return null;
  return (
    <section className="sh-hint tdoc-tutorial-agent" aria-label="Connect your Raft agent (optional)">
      <div className="sh-inner tdoc-tutorial-agent-inner">
      <header>
        <div>
          <p className="tdoc-tutorial-agent-stage">Final step · Optional</p>
          <h2>{connected ? 'Raft agent connected' : 'Connect your Raft agent'}</h2>
          <p>{connected
            ? 'Use Send to agent on your doc to send comments to Raft.'
            : 'Send comments to Raft without copying them into a chat.'}</p>
        </div>
        {connected ? <Check size={18} aria-label="Connected" /> : null}
      </header>
      {expanded && !connected ? (
        <div className="tdoc-tutorial-agent-setup">
          <label htmlFor="notify-agent-prompt">Paste this into your Raft agent</label>
          <textarea id="notify-agent-prompt" ref={promptRef} readOnly value={CONNECT_AGENT_PROMPT} rows={3} />
          <div className="tdoc-tutorial-agent-actions">
            <button className="sh-go" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy prompt'}</button>
            <span className="loc-hint" role="status">Waiting for your agent to connect…</span>
          </div>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="tdoc-tutorial-agent-actions">
        {connected
          ? <button type="button" className="sh-go" onClick={() => { setHidden(true); onFinished?.(); }}>Finish tutorial</button>
          : <>{!expanded ? <button type="button" className="sh-go" onClick={() => setExpanded(true)}>Connect agent</button> : null}<button type="button" className="sh-go" disabled={busy} onClick={skip}>{busy ? 'Saving…' : 'Skip for now'}</button></>}
      </div>
      </div>
    </section>
  );
}
