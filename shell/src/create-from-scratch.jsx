import React, { useState } from 'react';

// The direct half of "Create a doc": a title, and a blank document opened in
// edit mode. One component for both entry points — the Docs Hub modal and the
// landing's onboarding dialog — because they only differ in how a failure is
// reported, not in what the form is.
//
// `create` receives the trimmed title and resolves truthy once the browser is
// on its way to the new document. `busy` is deliberately never cleared on
// success: the page is already navigating, and flipping the button back to
// "Create" underneath it reads as if nothing happened.
export function CreateFromScratch({ create }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    if (!await create(value)) setBusy(false);
  };

  return (
    <div className="mk-scratch">
      <strong>Start from scratch</strong>
      <p className="mk-scratch-hint">A blank doc, opened straight into edit mode.</p>
      <div className="mk-scratch-row">
        <input
          type="text"
          maxLength="120"
          placeholder="Title"
          aria-label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
        />
        <button
          type="button"
          className="primary mk-scratch-go"
          disabled={!title.trim() || busy}
          onClick={submit}
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </div>
  );
}
