import React, { useEffect, useState } from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { CreateChoice, FIRST_DOC_RECIPE } from './create-from-scratch.jsx';
import { createDocument } from './document/api.js';

export { FIRST_DOC_RECIPE };

export function OnboardingDialog({ open, onOpenChange, identity }) {
  const [hosted, setHosted] = useState(false);
  const [createError, setCreateError] = useState(null);

  useEffect(() => {
    if (!open) return;
    fetch('/api/hosted/token', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then((response) => response.json())
      .then((result) => setHosted(Boolean(
        result?.token || result?.error === 'sign_in_required'
      )))
      .catch(() => {});
  }, [open]);

  // This dialog has no toast, so a refusal is reported in place. Only signed-in
  // readers get the blank-doc card at all — creating always needs a session.
  const createHere = async () => {
    setCreateError(null);
    try {
      const made = await createDocument();
      if (!made || !made.url) throw new Error('The server did not return a document');
      location.href = made.url;
      return true;
    } catch (error) {
      setCreateError(error.status === 401
        ? 'Your session expired — sign in again, then create.'
        : (error.message || 'Could not create the doc'));
      return false;
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Make your first doc"
      description="Paste this into your AI. It installs tdoc, writes and publishes a live commentable page, then gives you a link."
      actions={<button type="button" className="primary" onClick={() => onOpenChange(false)}>Done</button>}
    >
      <CreateChoice create={createHere} canCreate={Boolean(identity)} />
      {createError ? <p className="mk-scratch-error">{createError}</p> : null}
      <details className="tdoc-onboarding-details">
        <summary>What does it do?</summary>
        <ol>
          <li>Builds a personal AI portrait from the traces you choose to share.</li>
          <li>You leave comments directly on it.</li>
          <li>Your AI fixes them and publishes a new version.</li>
          <li>You send the link to someone else to review.</li>
          {hosted ? <li>Published docs appear in your hub at tdoc.dev/me.</li> : null}
        </ol>
      </details>
      <p className="muted">
        To self-host, add: <strong>Publish it to my own Cloudflare, not the hosted service.</strong>
      </p>
      <a className="tdoc-onboarding-link" href="/start">Read the full tutorial</a>
    </AppDialog>
  );
}
