import React, { useState } from 'react';
import { FilePlus2, Sparkles } from 'lucide-react';
import { AGENT_DEFINITION, AGENT_NAMES, OwnAgentDoor } from './onboarding-dialog.jsx';

// "Create a doc" is a fork, not a form: write it yourself, or have your agent
// write it. Two cards, one per answer — the blank doc opens immediately (you
// name it by typing into the page, which is where the title lives anyway), and
// the agent recipe is one step in.
//
// Shared by both entry points, the Docs Hub modal and the landing's onboarding
// dialog, which differ only in how a refusal is reported.
//
// `create` resolves truthy once the browser is on its way to the new document.
// `busy` is deliberately never cleared on success: the page is already leaving,
// and flipping the card back to its resting state underneath reads as a
// no-op.
export function CreateChoice({ create, canCreate = true }) {
  const [view, setView] = useState('choice');
  const [busy, setBusy] = useState(false);

  const startBlank = async () => {
    if (busy) return;
    setBusy(true);
    if (!await create()) setBusy(false);
  };

  if (view === 'recipe') {
    return (
      <div className="mk-recipe">
        {/* The same door the landing opens: the line, the wait read off the
            server, and the move to the doc when it lands. Its close button is
            this view's Back. */}
        <OwnAgentDoor onOpenChange={(open) => { if (!open) setView('choice'); }} closeLabel="Back" />
      </div>
    );
  }

  return (
    <div className="mk-cards">
      {canCreate ? (
        <button type="button" className="mk-card" onClick={startBlank} disabled={busy}>
          <FilePlus2 className="mk-card-icon" size={22} />
          <strong>Start from scratch</strong>
          <span>A blank doc, opened straight into edit mode. Type the title into the page.</span>
          <em>{busy ? 'Creating…' : 'Open a blank doc'}</em>
        </button>
      ) : null}
      <button type="button" className="mk-card" onClick={() => setView('recipe')}>
        <Sparkles className="mk-card-icon" size={22} />
        <strong>Build it with your agent</strong>
        <span className="tdoc-agent-def">{AGENT_DEFINITION} {AGENT_NAMES}</span>
        <span>Copy one line into it. It builds a page about you from traces you choose to share, and publishes it.</span>
        <em>Get the prompt</em>
      </button>
    </div>
  );
}
