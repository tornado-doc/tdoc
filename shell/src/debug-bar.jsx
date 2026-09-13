import React, { useRef, useState } from 'react';
import './debug-bar.css';

// The internal bar, on every page a walk passes through.
//
// It lived inside the gate, which meant a walk could only be restarted from
// step 1 -- and step 1 is not where a walk starts. A new reader arrives at the
// landing page, and everything between that page and the gate (the call to
// action, the sign-in, the first sight of the product) is part of what is
// being tested. Replaying from the gate skipped all of it.
//
// Shown only to an account the server has allow-listed (`boot.debug`, from the
// `debug-accounts` key in KV). The list is comma-separated, so more than one
// person can hold it.

export const DEBUG_STATES = ['new', 'started', 'connected', 'published', 'commented', 'revised'];

// What a replay has to clear in this browser. Each of these is somebody saying
// "not now" about a piece of the onboarding, and each of them silently removes
// that piece from every later walk.
export const REPLAY_LOCAL_KEYS = [
  'tdoc.onboarding.hint',        // the step row docked on a doc, X'd away
  'tdoc.onboarding.collapsed',   // the checklist, parked as a chip
  'tdoc.onboarding.open',        // the checklist, showing one step or all
  'tdoc-handoff-open',           // the line for the agent, folded shut
];
// And one per doc: `tdoc.handoff.<slug>` remembers that a line was copied and
// the page is waiting for an agent. A prefix, so a replay does not have to
// know which docs the last walk made.
export const REPLAY_LOCAL_PREFIX = 'tdoc.handoff.';

function postState(body) {
  return fetch('/api/onboarding/state', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

export function DebugBar({ record, onState }) {
  const [busy, setBusy] = useState('');
  // Replay's first press, waiting for its second.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef(0);
  const doc = record && record.first_doc;

  return (
    <div className="sg-debug" role="group" aria-label="Internal testing">
      <span className="sg-debug-tag">Internal</span>
      {DEBUG_STATES.map((name) => (
        <button
          key={name}
          type="button"
          disabled={Boolean(busy)}
          onClick={async () => {
            setBusy(name);
            await postState({ state: name });
            if (onState) await onState(name);
            setBusy('');
          }}
        >{busy === name ? '…' : name}</button>
      ))}
      <button
        type="button"
        className={`sg-debug-replay${armed ? ' armed' : ''}`}
        disabled={Boolean(busy)}
        onClick={async () => {
          // Two presses, and the first one says what will be destroyed by
          // name. This deletes a document -- bytes, comments and the slug --
          // through the product's own delete, which is exactly right on a test
          // account and unrecoverable on any other. It disarms itself, so a
          // press left behind by a wandering finger does not sit there waiting
          // to be completed by the next one.
          if (!armed) {
            setArmed(true);
            window.clearTimeout(armTimer.current);
            armTimer.current = window.setTimeout(() => setArmed(false), 4000);
            return;
          }
          window.clearTimeout(armTimer.current);
          setArmed(false);
          setBusy('replay');
          await postState({ state: 'new', unpair: true, purge: true });
          // The dismissals live here, not on the server.
          try {
            for (const key of REPLAY_LOCAL_KEYS) localStorage.removeItem(key);
            for (const key of Object.keys(localStorage)) {
              if (key.startsWith(REPLAY_LOCAL_PREFIX)) localStorage.removeItem(key);
            }
          } catch {}
          // Back to wherever this was pressed, which on the landing page is
          // where a new reader actually starts. Sending every replay to the
          // gate was what made the beginning of the walk untestable -- and
          // /setup stamps `started` on sight, so a replay that lands there can
          // never show what `new` looks like.
          location.reload();
        }}
      >{busy === 'replay' ? '…' : armed ? (doc ? `delete ${doc}?` : 'replay?') : 'replay'}</button>
      <span className="sg-debug-now">record: {recordName(record)}</span>
    </div>
  );
}

// The furthest step the record has reached, named the way the buttons are.
export function recordName(record) {
  if (!record || !Object.keys(record).length) return 'new';
  if (record.revised) return 'revised';
  if (record.commented) return 'commented';
  if (record.published_first) return 'published';
  if (record.agent_connected) return 'connected';
  if (record.started) return 'started';
  return 'new';
}
