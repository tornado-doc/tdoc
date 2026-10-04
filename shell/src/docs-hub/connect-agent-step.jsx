import React, { useEffect, useRef, useState } from 'react';
import { getOnboarding, postOnboardingEvent } from '../document/api.js';
import { copyText } from '../document/model.js';
import { CONNECT_AGENT_PROMPT } from '../document/notify-handoff.jsx';
import { selectContents } from '../onboarding-copy.js';

// Optional last row of the My docs tutorial. A publishing terminal alone
// does not prove an outbound comment connection.
export function ConnectAgentStep({ onFinished, preview, children }) {
  const [expanded, setExpanded] = useState(Boolean(preview?.connected));
  const [connected, setConnected] = useState(false);
  const [hidden, setHidden] = useState(false);
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
    <>
      <button type="button" className="onb-row onb-agent-row" aria-expanded={expanded}
        aria-label="Step 5: Connect Raft (optional)" onClick={() => setExpanded(value => !value)}>
        {children}
      </button>
      <div className="onb-agent-details">
        {connected ? <>
          <p role="status">Raft connected. You can now send comments to your agent.</p>
          <button type="button" className="new-folder-btn" onClick={() => { setHidden(true); onFinished?.(); }}>Finish tutorial</button>
        </> : <>
          {expanded ? <>
            <p>Paste this into your Raft agent to send comments directly from tdoc.</p>
            <div className="tdoc-handoff-line">
              <code ref={promptRef} tabIndex={0}>{CONNECT_AGENT_PROMPT}</code>
              <button type="button" className="tdoc-handoff-copy" onClick={copy}>{copied ? 'Copied' : 'Copy prompt'}</button>
            </div>
            <p role="status">Waiting for your agent to connect…</p>
          </> : null}
          <button type="button" className="onb-agent-skip" disabled={busy} onClick={skip}>{busy ? 'Saving…' : 'Skip for now'}</button>
        </>}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </>
  );
}
