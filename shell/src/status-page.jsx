import React, { useState } from 'react';

// The one edge-page frame: sign-in status, access denials, email opt-out.
// The boot JSON is the whole contract — title, message, optional link-shaped
// actions, and (on a 403) the request-access affordance, which is the only
// stateful thing here: one POST, then the button becomes its own receipt.
export function StatusPage({ boot }) {
  const [requested, setRequested] = useState('');

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

  const hasActions = Boolean(boot.actions?.length || boot.requestAccess);

  return (
    <main className={`tdoc-status-page${boot.error ? ' error' : ''}`}>
      <img src="/tdoc_logo.svg" width="44" height="44" alt="" />
      <h1>{boot.title}</h1>
      <p>{boot.message}</p>
      {hasActions ? (
        <div className="tdoc-status-actions">
          {(boot.actions || []).map((action) => (
            <a key={action.href} className={action.primary ? 'primary' : 'secondary'} href={action.href}>
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
      {boot.retry ? (
        <p className="tdoc-status-note"><a href={boot.retry}>Retry this link</a> once you have access.</p>
      ) : boot.error && !hasActions ? <a href="/">Return to tdoc</a> : null}
    </main>
  );
}
