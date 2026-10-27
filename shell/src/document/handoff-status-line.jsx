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
import { handoffWaitMinutes, handoffWaitState, isHandoffInFlight } from './handoff-state.js';

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

/**
 * Chips for the card's status row. `onResend(comment)` and
 * `onSendElsewhere(comment)` are the owner's; without them the line is
 * read-only (a reader sees where it stands, not the buttons).
 */
export function HandoffStatusChips({ comment, onResend = null }) {
  // Tick so "3 min ago" advances, and a quiet handoff turns into "No
  // response" on its own, while the card stays open.
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const state = handoffWaitState(comment, now);
  const ticking = isHandoffInFlight(state) || state === 'stale';
  useEffect(() => {
    if (!ticking) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, [ticking]);

  // A reply verdict is more current than the delivery receipt. One comment
  // shows one status, never both "sent" and "asked you" at the same time.
  const displayState = displayHandoffState(comment, state);
  const [lead, tail] = compactHandoffParts(comment, displayState);
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
  return (
    <span
      className={`tdoc-handoff-chip tdoc-handoff-status-text ${chipClass}`}
      data-handoff-state={displayState}
      title={state === 'failed' ? (deliveryErrorText(comment.handoff_delivery?.error) || undefined) : handoffStatusText(comment, state, now)}
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
