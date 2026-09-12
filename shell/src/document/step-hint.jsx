import React, { useState } from 'react';
import { X } from 'lucide-react';
import './step-hint.css';

// The doc-page half of the onboarding checklist. Same object as the card on My
// docs, reduced to the one row that belongs to this doc: four rows and a bar
// there, here the single row you are standing on. The empty tick is what makes
// that legible without a word of explanation -- it is the glyph the checklist's
// unfinished rows already use, so a line floating in the corner reads as a
// to-do and not as a tip.
//
// It is a wayfinder, never a second affordance. Everything it names is already
// on this page: the seeded comment asks for the highlight, and the card
// carries the line for the agent. So the hint says which one is yours now and
// opens it. Putting a copy of that line down here would be the same line on
// screen twice, and the two would drift.
//
// Dismissal is this browser's, like the checklist's collapse: somebody who
// tidies it away on their laptop has told us nothing about their phone.
const HIDE_KEY = 'tdoc.onboarding.hint';

function hidden() {
  try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; }
}
function rememberHidden() {
  try { localStorage.setItem(HIDE_KEY, '1'); } catch {}
}

// Which row this doc is on. `null` means there is nothing to say: the journey
// has not started, this is not its doc, or the loop has already closed -- and
// the exit banner owns the page from there.
export function docStep(record, slug, ownerCommented) {
  if (!record || !record.started) return null;
  if (!record.first_doc || record.first_doc !== slug) return null;
  if (record.revised) return null;
  return ownerCommented ? 'handoff' : 'comment';
}

// The words. The two waiting lines are the card's own, not new ones: the same
// wait said twice in two voices is how a reader starts to wonder whether they
// are the same wait.
const LINES = {
  comment: 'Highlight a sentence you’d argue with.',
  handoff: 'Now tell your agent to fix it.',
  waiting: 'Waiting for your agent…',
  reading: 'Your agent is reading this',
  stuck: 'Still waiting — did you paste it into your agent?',
};

export function DocStepHint({ step, agentState = 'idle', lifted = false, onGo }) {
  const [gone, setGone] = useState(hidden);
  if (!step || gone) return null;
  // Once the line has been copied the row stops being something to do and
  // becomes something to watch, so it stops being a button.
  const watching = step === 'handoff' && agentState !== 'idle';
  const key = watching ? (LINES[agentState] ? agentState : 'waiting') : step;
  const body = (
    <>
      {watching
        ? <span className="tdoc-wait-dot" aria-hidden="true" />
        : <span className="sh-tick" aria-hidden="true" />}
      <span className="sh-text">{LINES[key]}</span>
    </>
  );
  return (
    <div className={`sh-hint${lifted ? ' lifted' : ''}`} role={watching ? 'status' : undefined} aria-live={watching ? 'polite' : undefined}>
      {watching
        ? <span className="sh-row">{body}</span>
        : <button type="button" className="sh-row" onClick={onGo}>{body}</button>}
      <button type="button" className="sh-x" aria-label="Hide" onClick={() => { setGone(true); rememberHidden(); }}>
        <X size={14} />
      </button>
    </div>
  );
}
