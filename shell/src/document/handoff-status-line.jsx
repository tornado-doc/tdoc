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

// [lead, tail]: the lead names the agent and is what gives way in a narrow
// card; the tail (where it is, how long ago) always shows.
function handoffStatusParts(comment, state, now) {
  const who = readableHandle(comment?.handoff_to);
  if (state === 'waiting') {
    const d = comment.handoff_delivery;
    const ago = d?.at && !d.deduped
      ? formatHandoffAgo(d.at)
      : (comment.handoff_at ? formatHandoffAgo(comment.handoff_at) : '');
    return [`Delivered to ${who || 'your agent'}`, ago ? ` · ${ago}` : ''];
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
  return handoffStatusParts(comment, state, now).join('');
}

const CHIP_CLASS = {
  waiting: 'is-waiting',
  stale: 'is-stale',
  expired: 'is-stale',
  received: 'is-received',
  failed: 'is-failed',
  replied: 'is-replied',
};

/**
 * Chips for the card's status row. `onResend(comment)` and
 * `onSendElsewhere(comment)` are the owner's; without them the line is
 * read-only (a reader sees where it stands, not the buttons).
 */
export function HandoffStatusChips({ comment, onResend = null, onSendElsewhere = null }) {
  // Tick so "3 min ago" advances, and a quiet handoff turns into "No
  // response" on its own, while the card stays open.
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const verdict = latestAgentVerdict(comment);
  const state = handoffWaitState(comment, now);
  const ticking = isHandoffInFlight(state) || state === 'stale';
  useEffect(() => {
    if (!ticking) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, [ticking]);

  // A reply verdict is more current than the delivery receipt. One comment
  // shows one status, never both "sent" and "asked you" at the same time.
  const displayState = state === 'replied' && (verdict === 'question' || verdict === 'partial' || verdict === 'answered')
    ? verdict : state;
  const who = readableHandle(comment?.handoff_to) || 'Agent';
  const [lead, tail] = displayState === 'question' ? [`${who} asked you`, '']
    : displayState === 'partial' ? [`${who} needs your input`, '']
      : displayState === 'answered' ? [`${who} answered`, '']
        : handoffStatusParts(comment, state, now);
  const text = lead + tail;
  const chipClass = displayState === 'question' ? 'is-question'
    : displayState === 'partial' ? 'is-partial'
      : displayState === 'answered' ? 'is-replied' : CHIP_CLASS[state] || '';
  const status = displayState && displayState !== 'ready' && text ? (
    <span
      className={`tdoc-handoff-chip tdoc-handoff-status-text ${chipClass}`}
      data-handoff-state={displayState}
      title={state === 'failed' ? (deliveryErrorText(comment.handoff_delivery?.error) || undefined) : text}
    >
      <span className="tdoc-handoff-line-text">{lead}</span>
      {tail ? <span className="tdoc-handoff-line-tail">{tail}</span> : null}
    </span>
  ) : null;
  // handoff_status resolved is folded into state === 'replied' — no separate
  // "Agent done" pill (redundant with the reply / this chip).

  const stuck = state === 'stale' || state === 'expired';
  const resend = async () => {
    if (busy || !onResend) return;
    setBusy(true);
    try { await onResend(comment); } finally { setBusy(false); }
  };
  const actions = stuck && (onResend || onSendElsewhere) ? (
    <span key="actions" className="tdoc-handoff-nudge">
      {onResend ? (
        <button type="button" className="text-btn" disabled={busy} onClick={resend}>
          {busy ? 'Resending…' : 'Resend'}
        </button>
      ) : null}
      {onSendElsewhere && state === 'stale' ? (
        <button type="button" className="text-btn" disabled={busy} onClick={() => onSendElsewhere(comment)}>
          Send to another agent
        </button>
      ) : null}
    </span>
  ) : null;

  if (!status) return null;
  return <>{status}{actions}</>;
}
