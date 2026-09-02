import React, { useEffect, useState } from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { copyText } from './document/model.js';

const RECIPE_URL = 'https://github.com/tornado-doc/tdoc/blob/main/FIRST-DOC.md';
export const FIRST_DOC_RECIPE = `Set up tdoc and make my first doc: ${RECIPE_URL}`;

// The one rendering of the first-doc recipe. Shown here as the whole of
// onboarding, and behind the "Build it with your AI" card in the Docs Hub.
export function FirstDocRecipe() {
  const [copied, setCopied] = useState(false);

  return (
    <div className="tdoc-recipe-wrap">
      <code>{FIRST_DOC_RECIPE}</code>
      <button
        type="button"
        className={copied ? 'done' : undefined}
        onClick={() => copyText(FIRST_DOC_RECIPE).then(setCopied)}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// First-time onboarding, and only that. This dialog's job is to get tdoc
// installed and the reader's first doc published through their own agent, so it
// offers the recipe and nothing else. The blank-doc card lives in the Docs Hub,
// where the reader already has tdoc and is starting their next document; here
// it would answer a question a first-time visitor has not asked yet, and
// compete with the single instruction this page exists to deliver (#371).
export function OnboardingDialog({ open, onOpenChange }) {
  const [hosted, setHosted] = useState(false);

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

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Make your first doc"
      description="Paste this into your AI. It installs tdoc, writes and publishes a live commentable page, then gives you a link."
      actions={<button type="button" className="primary" onClick={() => onOpenChange(false)}>Done</button>}
    >
      <FirstDocRecipe />
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
