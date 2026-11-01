import React, { useState } from 'react';
import { TopBar } from './top-bar.jsx';
import { useViewerIdentity } from './hooks/use-viewer-identity.js';

// The one edge-page frame: sign-in status, access denials, email opt-out.
// The boot JSON is the whole contract — title, message, optional link-shaped
// actions, and (on a 403) the request-access affordance, which is the only
// stateful thing here: one POST, then the button becomes its own receipt.
// It sits under the same top bar as every app page, so a denial still shows
// which account is looking and how to switch it.
export function StatusPage({ boot }) {
  const [requested, setRequested] = useState('');
  const viewer = useViewerIdentity(boot.identity);

  const requestAccess = async () => {
    setRequested('sending');
    try {
      const response = await fetch('/api/doc/request-access', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: boot.requestAccess.slug }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setRequested('done');
    } catch {
      setRequested('failed');
    }
  };

  // A pending team invite on a team doc's gate: one click joins the team and
  // opens the doc it was opened from.
  const [accepting, setAccepting] = useState('');
  const acceptInvite = async () => {
    setAccepting('sending');
    try {
      const response = await fetch('/api/team/accept', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: boot.acceptInvite.slug }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
      window.location.assign(boot.acceptInvite.next || (body && body.next) || '/me');
    } catch (err) {
      setAccepting(err && err.message === 'team_full' ? 'full' : 'failed');
    }
  };

  const hasActions = Boolean(boot.actions?.length || boot.requestAccess || boot.acceptInvite);

  return (
    <div className="tdoc-app tdoc-edge-page">
      <TopBar identity={viewer.identity} authConfigured={viewer.ready} />
      <main className={`tdoc-status-page${boot.error ? ' error' : ''}`}>
        <h1>{boot.title}</h1>
        <p>{boot.message}</p>
        {boot.note ? <p className="tdoc-status-note">{boot.note}</p> : null}
        {hasActions ? (
          <div className="tdoc-status-actions">
            {boot.acceptInvite ? (
              <button type="button" className="primary" onClick={acceptInvite} disabled={accepting === 'sending'}>
                {accepting === 'sending' ? 'Joining…' : accepting === 'failed' ? 'Accept and open (retry)' : 'Accept and open'}
              </button>
            ) : null}
            {(boot.actions || []).map((action) => (
              <a
                key={action.href}
                className={action.primary ? 'primary' : 'secondary'}
                href={action.href}
                // An off-site step (signing out of github.com) opens beside
                // this page, so the way back into tdoc stays right here.
                {...(action.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                {action.label}
              </a>
            ))}
            {boot.requestAccess ? (
              requested === 'done' ? (
                <span className="tdoc-status-note" role="status">Request sent — the owner has been notified.</span>
              ) : (
                <button type="button" className="secondary" onClick={requestAccess} disabled={requested === 'sending'}>
                  {requested === 'failed' ? 'Request access (retry)' : requested === 'sending' ? 'Requesting…' : 'Request access'}
                </button>
              )
            ) : null}
          </div>
        ) : null}
        {accepting === 'full' ? <p className="tdoc-status-note" role="status">{boot.acceptInvite.team_name} is full. Ask an admin to make room.</p> : null}
        {boot.retry ? (
          <p className="tdoc-status-note"><a href={boot.retry}>Retry this link</a> once you have access.</p>
        ) : boot.error && !hasActions ? <a href="/">Return to tdoc</a> : null}
      </main>
    </div>
  );
}
