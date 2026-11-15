// The handoff line on a comment card: where a "Send to agent" stands, in the
// order it happens --
//   Delivered to <agent> · 2 min ago
//   <agent> is on it · 3 min ago
//   <agent> replied
// and, when nothing comes back, what to do about it: after
// HANDOFF_STALE_MS unacknowledged, "No response for N min" with Resend and
// Send to another agent; once the provider's expiresAt passes unacknowledged,
// "Expired — the agent never picked it up" with Resend. Before this the card
// said "Waiting on agent" for as long as it took, which read the same for an
// agent that was thinking and one that never got the message (Julie,
// 2026-10-13).

import React, { useEffect, useState } from 'react';
import { deliveryErrorText, readableHandle } from './notify-handoff.jsx';
import { formatHandoffAgo } from './handoff-ago.js';
import { handoffWaitMinutes, handoffWaitState, isHandoffInFlight } from '../comments/core/handoff-state.js';
import { handoffProgressLine } from '../comments/core/handoff-progress.js';
import { isFeatureOn } from '../feature-flags.js';

/** Latest agent verdict on a reply, if any (applied / partial / question). */
function latestAgentVerdict(comment) {
  const replies = comment?.replies || [];
  for (let i = replies.length - 1; i >= 0; i -= 1) {
    const status = replies[i]?.agent_status;
    if (status === 'partial' || status === 'question' || status === 'applied' || status === 'answered') return status;
  }
  return null;
}

function displayHandoffState(comment, state) {
  if (state !== 'replied') return state;
  const verdict = latestAgentVerdict(comment);
  return verdict || state;
}

// [lead, tail]: the lead names the agent and is what gives way in a narrow
// card; the tail (where it is, how long ago) always shows.
function handoffStatusParts(comment, state, now) {
  const who = readableHandle(comment?.handoff_to);
  if (state === 'question') return [`${who || 'Agent'} asked you`, ''];
  if (state === 'partial') return [`${who || 'Agent'} needs your input`, ''];
  if (state === 'answered') return [`${who || 'Agent'} answered`, ''];
  if (state === 'waiting') {
    const d = comment.handoff_delivery;
    const ago = d?.at && !d.deduped
      ? formatHandoffAgo(d.at)
      : (comment.handoff_at ? formatHandoffAgo(comment.handoff_at) : '');
    // A local daemon returns queued until it fetches the handoff. Raft's
    // delivered receipt, by contrast, means the agent inbox has it.
    const action = d?.status === 'queued' ? 'Sent to' : 'Delivered to';
    return [`${action} ${who || 'your agent'}`, ago ? ` · ${ago}` : ''];
  }
  if (state === 'stale') return [`No response for ${Math.max(1, handoffWaitMinutes(comment, now))} min`, ''];
  if (state === 'expired') return ['Expired — the agent never picked it up', ''];
  if (state === 'received') {
    const ago = comment.handoff_acked_at ? formatHandoffAgo(comment.handoff_acked_at) : '';
    return [`${who || 'Agent'} is on it`, ago ? ` · ${ago}` : ''];
  }
  if (state === 'failed') return ['Not delivered', ''];
  if (state === 'replied') return [`${who || 'Agent'} replied`, ''];
  return ['', ''];
}

/** The status text for one comment's handoff, or '' when there is none. */
export function handoffStatusText(comment, state, now = Date.now()) {
  return handoffStatusParts(comment, displayHandoffState(comment, state), now).join('');
}

function compactHandoffParts(comment, state) {
  if (state === 'waiting') {
    const delivery = comment?.handoff_delivery;
    return [delivery?.status === 'queued' ? 'Sent' : 'Delivered', ''];
  }
  if (state === 'stale' || state === 'expired') return ['No response', ''];
  if (state === 'received') return ['On it', ''];
  if (state === 'failed') return ['Not delivered', ''];
  if (state === 'question') return ['❓ Asked you', ''];
  if (state === 'partial') return ['🟡 Partial', ''];
  if (state === 'answered' || state === 'applied' || state === 'resolved') return ['✅ Done', ''];
  if (state === 'replied') return ['Agent replied', ''];
  return ['', ''];
}

export function compactHandoffText(comment, state) {
  return compactHandoffParts(comment, displayHandoffState(comment, state)).join('');
}

const CHIP_CLASS = {
  waiting: 'is-waiting',
  stale: 'is-stale',
  expired: 'is-stale',
  received: 'is-received',
  failed: 'is-failed',
  replied: 'is-waiting',
};

// The agent's steps (flag agentProgress; the feedback widget passes its own
// reading as `progressLine`), or null. One reading for the pill and the list.
function useProgress(comment, progressLine) {
  const showProgress = progressLine === undefined ? isFeatureOn('agentProgress') : Boolean(progressLine);
  const [now, setNow] = useState(() => Date.now());
  const state = handoffWaitState(comment, now);
  const ticking = isHandoffInFlight(state) || state === 'stale';
  useEffect(() => {
    if (!ticking) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, [ticking]);
  const displayState = displayHandoffState(comment, state);
  const progress = showProgress ? handoffProgressLine(comment, displayState, now, readableHandle(comment?.handoff_to)) : null;
  return { now, state, displayState, progress };
}

// "Sent to <agent>" / "<agent> is reading": the name is what shortens.
function StepWords({ parts }) {
  const [before, name, after] = parts;
  return <>
    {before ? <span className="tdoc-handoff-step-fixed">{before}</span> : null}
    <span className="tdoc-handoff-step-name">{name}</span>
    {after ? <span className="tdoc-handoff-step-fixed">{after}</span> : null}
  </>;
}

/**
 * Chips for the card's status row. `onResend(comment)` and
 * `onSendElsewhere(comment)` are the owner's; without them the line is
 * read-only (a reader sees where it stands, not the buttons).
 * While the agent has the comment (flag agentProgress) the pill names the
 * current step in plain words ("Claude is reading", "Claude updated the
 * doc") and, with `onToggleSteps`, is a toggle for the step list under it
 * (HandoffProgressSteps, `stepsId`); its tooltip holds the whole line.
 */
export function HandoffStatusChips({ comment, onResend = null, progressLine, stepsOpen = false, onToggleSteps = null, stepsId }) {
  const [busy, setBusy] = useState(false);
  // Ticks so "3 min ago" advances, and a quiet handoff turns into "No
  // response" on its own, while the card stays open.
  const { now, state, displayState, progress } = useProgress(comment, progressLine);
  // A reply verdict is more current than the delivery receipt. One comment
  // shows one status, never both "sent" and "asked you" at the same time.
  const current = progress ? progress.steps[progress.steps.length - 1] : null;
  const [lead, tail] = current ? [current.label, ''] : compactHandoffParts(comment, displayState);
  const text = lead + tail;
  const chipClass = displayState === 'question' ? 'is-question'
    : displayState === 'partial' ? 'is-partial'
      : (displayState === 'answered' || displayState === 'applied') ? 'is-done' : CHIP_CLASS[state] || '';
  const stuck = state === 'failed' || state === 'stale' || state === 'expired';
  const resend = async () => {
    if (busy || !onResend) return;
    setBusy(true);
    try { await onResend(comment); } finally { setBusy(false); }
  };
  if (!displayState || displayState === 'ready' || !text) return null;
  const title = state === 'failed' ? (deliveryErrorText(comment.handoff_delivery?.error) || undefined) : progress ? progress.text : handoffStatusText(comment, state, now);
  if (current) {
    const toggle = onToggleSteps ? (event) => { event.stopPropagation(); onToggleSteps(); } : undefined;
    return (
      <span
        className={`tdoc-handoff-chip tdoc-handoff-status-text ${chipClass}`}
        data-handoff-state={displayState}
        data-handoff-progress=""
        title={title}
        {...(onToggleSteps ? {
          role: 'button',
          tabIndex: 0,
          'aria-expanded': stepsOpen,
          'aria-controls': stepsOpen ? stepsId : undefined,
          'aria-description': `${progress.text}. ${stepsOpen ? 'Hide' : 'Show'} the steps.`,
          onClick: toggle,
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggle(event);
          },
        } : {})}
      >
        <StepWords parts={current.parts} />
        {onToggleSteps ? (
          <svg className="tdoc-handoff-chip-caret" data-open={stepsOpen ? '' : undefined} viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
    );
  }
  return (
    <span
      className={`tdoc-handoff-chip tdoc-handoff-status-text ${chipClass}`}
      data-handoff-state={displayState}
      title={title}
    >
      <span className="tdoc-handoff-line-text">{lead}</span>
      {tail ? <span className="tdoc-handoff-line-tail">{tail}</span> : null}
      {stuck && onResend ? <>
        <span aria-hidden="true"> · </span>
        <button type="button" className="tdoc-handoff-chip-action" disabled={busy} onClick={(event) => { event.stopPropagation(); resend(); }}>
          {busy ? 'Resending…' : 'Resend'}
        </button>
      </> : null}
    </span>
  );
}

/**
 * The agent's steps under the pill, one short line each: a check for a
 * finished step, a spinner for the current one. Shown only while `open`
 * (the pill toggles it; collapsed by default so the comment stays clean)
 * and while the agent still has the comment.
 */
export function HandoffProgressSteps({ comment, progressLine, open, id }) {
  const { progress } = useProgress(comment, progressLine);
  if (!open || !progress) return null;
  const last = progress.steps.length - 1;
  return (
    <ol className="tdoc-handoff-steps" id={id} aria-label="Agent steps">
      {progress.steps.map((st, i) => (
        <li key={st.key} className="tdoc-handoff-step" data-step={st.key} aria-current={i === last ? 'step' : undefined}>
          {i === last
            ? <span className="tdoc-handoff-step-mark is-current" role="img" aria-label="Now" />
            : (
              <svg className="tdoc-handoff-step-mark is-done" viewBox="0 0 12 12" width="12" height="12" role="img" aria-label="Done">
                <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          <span className="tdoc-handoff-step-words"><StepWords parts={st.parts} /></span>
        </li>
      ))}
    </ol>
  );
}
