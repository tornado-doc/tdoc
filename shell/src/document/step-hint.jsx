import React, { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
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
//
// "Highlight a sentence" named the gesture in the product's own vocabulary,
// which is no help to somebody who has not made a highlight yet. The literal
// version says what to do with a mouse and what will happen when they do.
const LINES = {
  comment: 'Select any sentence to comment on it.',
  handoff: 'Now tell your agent to fix it.',
  waiting: 'Waiting for your agent…',
  reading: 'Your agent is reading this',
  stuck: 'Still waiting — did you paste it into your agent?',
};
// What a row says once it is behind them. Present tense would be a lie by the
// time it is struck through.
const DONE_LINES = {
  comment: 'Commented.',
  handoff: 'Your agent published v2.',
};
const TICK_MS = 2400;

export function DocStepHint({ step, agentState = 'idle', lifted = false, banner = false, justFinished = false, onGo }) {
  const [gone, setGone] = useState(hidden);
  // A row that is finished while somebody is looking at the page ticks where
  // it stands before it goes. Doing the thing and watching the to-do vanish is
  // not the same as watching it get done, and this is the page where it
  // happened -- making them walk back to My docs to see the tick is making
  // them go and check the receipt for something they just did.
  const [shown, setShown] = useState(step);
  // The last row cannot tick on a state change, because the last step does not
  // produce one: v2 arriving navigates this page to the new version, so the
  // component that was watching is gone by the time the record moves. The
  // arrival says it instead, and the row ticks on the way in.
  // The row being struck through, or null. Held in state rather than read off
  // the ref at render: the ref has already moved on by then, and the row would
  // lose its name and finish as a bare "Done."
  const [finished, setFinished] = useState(justFinished ? 'handoff' : null);
  const previous = useRef(justFinished ? null : step);
  useEffect(() => {
    if (!justFinished) return undefined;
    const timer = window.setTimeout(() => setFinished(null), TICK_MS);
    return () => window.clearTimeout(timer);
    // Once, on the arrival that brought v2 in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (step === previous.current) return undefined;
    const just = previous.current;
    previous.current = step;
    // Only forwards. A row appearing (nothing -> comment) is not a completion.
    if (!just || !DONE_LINES[just]) { setShown(step); return undefined; }
    setFinished(just);
    const timer = window.setTimeout(() => { setFinished(null); setShown(step); }, TICK_MS);
    return () => window.clearTimeout(timer);
  }, [step]);
  const ticking = Boolean(finished);

  if (gone) return null;
  // The banner owns the top of the page once the loop has closed, so a pending
  // row underneath it would be a second voice with older news. A row in the
  // middle of ticking is the exception: that is this page's own answer.
  if (banner && !ticking) return null;
  if (!shown && !ticking) return null;
  // Once the line has been copied the row stops being something to do and
  // becomes something to watch, so it stops being a button.
  const watching = !ticking && shown === 'handoff' && agentState !== 'idle';
  const key = watching ? (LINES[agentState] ? agentState : 'waiting') : shown;
  const body = ticking ? (
    <>
      <span className="sh-tick on" aria-hidden="true"><Check size={11} strokeWidth={3.5} /></span>
      <span className="sh-text">{DONE_LINES[finished]}</span>
    </>
  ) : (
    <>
      {watching
        ? <span className="tdoc-wait-dot" aria-hidden="true" />
        : <span className="sh-tick" aria-hidden="true" />}
      <span className="sh-text">{LINES[key]}</span>
      {/* Only the row nobody knows how to do carries a picture of it: a
          sentence marked, and the box that opens when you mark one. */}
      {shown === 'comment' ? <span className="sh-thumb" aria-hidden="true"><i className="sh-mark" /><i className="sh-card" /></span> : null}
    </>
  );
  const still = ticking || watching;
  return (
    <div className={`sh-hint${lifted ? ' lifted' : ''}${ticking ? ' ticked' : ''}`} role={still ? 'status' : undefined} aria-live={still ? 'polite' : undefined}>
      {still
        ? <span className="sh-row">{body}</span>
        : <button type="button" className="sh-row" onClick={onGo}>{body}</button>}
      {ticking ? null : (
        <button type="button" className="sh-x" aria-label="Hide" onClick={() => { setGone(true); rememberHidden(); }}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
