import React, { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import './step-hint.css';

// The doc-page half of the onboarding checklist. Same object as the card on My
// docs, reduced to the one row that belongs to this doc: four rows and a bar
// there, here the single row you are standing on, carrying its own number so
// the two agree about where you are.
//
// It is a wayfinder, never a second affordance. Everything it names is already
// on this page: the seeded comment asks for the highlight, and the card
// carries the line for the agent. So the hint says which one is yours now and
// opens it. Putting a copy of that line up here would be the same line on
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
export function docStep(record, slug, canHandoff = true) {
  if (!record || !record.started) return null;
  if (!record.first_doc || record.first_doc !== slug) return null;
  if (record.revised) return null;
  // The record, not the comment list. Both were being read as the same fact:
  // the checklist on My docs asks the record whether they have commented, and
  // this row used to ask the page -- is there a comment here signed by the
  // owner? Those answer differently the moment they disagree, and then the
  // list offers "leave a comment on your doc" while the doc it opens is
  // already asking for the handoff. Anything that leaves a comment on the
  // journey's doc stamps the record, so the record is the one that knows; a
  // comment posted in this tab moves it here before the server is asked.
  if (!record.commented) return 'comment';
  // The handoff block lives on the card and only on the latest version, so on
  // an older one the row would name a line that is not on the page -- which is
  // the one thing this row promised never to do.
  return canHandoff ? 'handoff' : null;
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
// The checklist's row numbers. The card on My docs counts four; a row down
// here that did not say which of the four it was made the two look like two
// different lists.
const STEP_NO = { comment: 3, handoff: 4 };
// One label for both rows, because it is one behaviour: open the card that
// carries the next thing. A button that named the destination would have to
// name two.
const GO = 'Show me';
const TICK_MS = 2400;
// What the hint takes off the top of the document, in one place: the card's own
// 48px plus the 10px of air above and below it. The overlay positions every
// comment card from the top of that document, so a number that drifts from
// step-hint.css moves every card on the page by the difference.
export const STEP_HINT_HEIGHT = 68;

export function DocStepHint({ step, agentState = 'idle', banner = false, justFinished = false, hidden: covered = false, onGo, onVisible }) {
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

  // Whether any of the below will draw. The comment cards are positioned from
  // the top of the document, so the overlay has to know that a bar took 48px
  // of it -- and only this component knows whether it drew.
  const showing = !gone && !covered && (ticking || Boolean(shown && !banner));
  useEffect(() => { if (onVisible) onVisible(showing); }, [showing, onVisible]);

  if (!showing) return null;
  // Once the line has been copied the row stops being something to do and
  // becomes something to watch, so it stops offering a button.
  const watching = !ticking && shown === 'handoff' && agentState !== 'idle';
  const key = watching ? (LINES[agentState] ? agentState : 'waiting') : shown;
  const still = ticking || watching;
  return (
    <div
      className={`sh-hint${ticking ? ' ticked' : ''}`}
      role={still ? 'status' : undefined}
      aria-live={still ? 'polite' : undefined}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="sh-inner">
        {ticking ? (
          <span className="sh-tick" aria-hidden="true"><Check size={13} strokeWidth={3.5} /></span>
        ) : watching ? (
          <span className="tdoc-wait-dot" aria-hidden="true" />
        ) : (
          <span className="sh-step" aria-hidden="true">{STEP_NO[shown]}</span>
        )}
        <span className="sh-text">{ticking ? DONE_LINES[finished] : LINES[key]}</span>
        {still ? null : (
          <>
            {/* Only when there is somewhere to go. This row opens the card that
                carries the next thing, and on the comment step that card is
                tdoc's seeded one -- which a CLI-first publisher never gets,
                because seeding is deliberately reserved for somebody who came
                through /setup. The button stayed anyway and did nothing at all:
                measured on tdoc.dev, cards 0 -> 0, scroll 0 -> 0.
                The sentence is the whole instruction on its own. A button that
                does nothing is worse than no button, and worst of all on the
                one step whose job is to teach a gesture. */}
            {onGo ? <button type="button" className="sh-go" onClick={onGo}>{GO}</button> : null}
            <button type="button" className="sh-x" aria-label="Hide" onClick={() => { setGone(true); rememberHidden(); }}>
              <X size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
