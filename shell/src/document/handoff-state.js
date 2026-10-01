// Handoff-surface classifier for badge / banner / details / pin.
// Orthogonal to comment.status / resolution — those stay on the card.
// Spec: design v12 §10 (no msg-axis "done" on this surface).

function isAgentAuthor(author) {
  return author && (author.kind === 'agent' || author.kind === 'system');
}

function ts(iso) {
  const n = Date.parse(iso || '');
  return Number.isFinite(n) ? n : 0;
}

/** Latest human-authored stamp on the thread (root or reply). */
export function lastHumanAt(comment) {
  if (!comment) return 0;
  let latest = 0;
  if (!isAgentAuthor(comment.author)) latest = Math.max(latest, ts(comment.created));
  for (const r of comment.replies || []) {
    if (!r || isAgentAuthor(r.author)) continue;
    latest = Math.max(latest, ts(r.created));
  }
  return latest;
}

/** Latest agent reply / agent_status stamp on the thread. */
export function lastAgentAt(comment) {
  if (!comment) return 0;
  let latest = 0;
  for (const r of comment.replies || []) {
    if (!r || !(isAgentAuthor(r.author) || r.agent_status)) continue;
    const at = ts(r.created);
    // Missing created: treat as "now enough" so we do not keep waiting forever.
    latest = Math.max(latest, at || Number.MAX_SAFE_INTEGER);
  }
  return latest === Number.MAX_SAFE_INTEGER ? Date.now() : latest;
}

/** True if an agent posted (or stamped agent_status) after handoff_at. */
export function agentRepliedAfterHandoff(comment) {
  const handoffMs = ts(comment?.handoff_at);
  const agentMs = lastAgentAt(comment);
  if (!agentMs) return false;
  if (!handoffMs) return true;
  return agentMs >= handoffMs;
}

/**
 * Classify one comment for handoff surfaces.
 * @returns {'ready'|'failed'|'waiting'|'received'|'replied'|null}
 */
export function handoffSurfaceState(comment) {
  if (!comment || comment.deleted) return null;
  // Msg-axis closed comments leave this surface (details follows showResolved).
  if (comment.status === 'applied') return null;

  const status = comment.handoff_status || 'note';
  const delivery = comment.handoff_delivery?.status;

  // Whoever spoke last decides, before any handoff bookkeeping: an agent's
  // word last means it is the person's turn — never "ready" to send again,
  // even when it was never formally handed off (an agent that answered from
  // a pull left handoff_status at note, and those threads were re-sent and
  // answered twice).
  const lastHuman = lastHumanAt(comment);
  const lastAgent = lastAgentAt(comment);
  if (lastAgent && lastAgent >= lastHuman) return 'replied';

  if (status === 'note' || !comment.handoff_at) return 'ready';

  if (delivery === 'failed') return 'failed';

  const humanMs = lastHumanAt(comment);
  const handoffMs = ts(comment.handoff_at);
  const agentMs = lastAgentAt(comment);

  // One agent reply covers the whole thread (root + self-replies). Only go
  // back to ready if a human wrote again AFTER that reply.
  if (status === 'resolved' || (agentMs && agentMs >= handoffMs)) {
    if (humanMs && agentMs && humanMs > agentMs) return 'ready';
    if (status === 'resolved' || (agentMs && (!humanMs || agentMs >= humanMs))) {
      return 'replied';
    }
  }

  // Newer human input than the last handoff, and agent has not caught up.
  if (humanMs && handoffMs && humanMs > handoffMs) return 'ready';

  // Ack means the agent inbox accepted it; still waiting for a reply.
  if (comment.handoff_acked_at) return 'received';

  return 'waiting';
}

/**
 * Where a thread stands for the person reading the list:
 *   open     — waiting on the agent side (a person spoke last)
 *   replied  — an agent spoke last; the person's turn
 *   resolved — closed
 * Who spoke last decides, not the agent's status label.
 */
export function threadPhase(comment) {
  if (!comment || comment.deleted) return null;
  if (comment.status === 'applied') return 'resolved';
  const agent = lastAgentAt(comment);
  return agent && agent >= lastHumanAt(comment) ? 'replied' : 'open';
}

/** In-flight = still expecting agent work (includes ack-without-reply). */
export function isHandoffInFlight(state) {
  return state === 'waiting' || state === 'received';
}

export function summarizeHandoffSurfaces(comments) {
  const buckets = {
    ready: [], failed: [], waiting: [], received: [], replied: [],
  };
  for (const c of comments || []) {
    const state = handoffSurfaceState(c);
    if (state) buckets[state].push(c);
  }
  return buckets;
}

/** Sort key for details: newest handoff / human activity first. */
export function handoffActivityAt(comment) {
  if (!comment) return 0;
  return Math.max(
    ts(comment.handoff_at),
    ts(comment.handoff_acked_at),
    lastHumanAt(comment),
    lastAgentAt(comment),
  );
}

export function shortCommentPreview(text, max = 72) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  if (!one) return '(empty)';
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}
