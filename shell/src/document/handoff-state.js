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

/** True if an agent posted (or stamped agent_status) after handoff_at. */
export function agentRepliedAfterHandoff(comment) {
  const handoffMs = ts(comment?.handoff_at);
  if (!handoffMs) {
    return (comment?.replies || []).some(
      (r) => r && (isAgentAuthor(r.author) || r.agent_status),
    );
  }
  return (comment?.replies || []).some((r) => {
    if (!r || !(isAgentAuthor(r.author) || r.agent_status)) return false;
    const at = ts(r.created);
    // Missing created: treat as after handoff so we do not keep "waiting".
    return !at || at >= handoffMs;
  });
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

  if (status === 'note' || !comment.handoff_at) return 'ready';

  if (delivery === 'failed') return 'failed';

  const humanMs = lastHumanAt(comment);
  const handoffMs = ts(comment.handoff_at);
  // Newer human input than the last handoff → ready to send again.
  if (humanMs && handoffMs && humanMs > handoffMs) return 'ready';

  const answered = agentRepliedAfterHandoff(comment) || status === 'resolved';
  if (answered) return 'replied';

  // Ack means the agent inbox accepted it; still waiting for a reply.
  if (comment.handoff_acked_at) return 'received';

  return 'waiting';
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
  );
}

export function shortCommentPreview(text, max = 72) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  if (!one) return '(empty)';
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}
