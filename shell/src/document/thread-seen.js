// Per-browser "I've looked at this thread since the agent last spoke".
// Unread lives on the pin so it is not trapped inside a folded card.

import { readStored, writeStored } from '../safe-storage.js';

function storageKey(slug) {
  return `tdoc.thread-seen.${slug}`;
}

/** Latest agent reply / agent_status stamp on the thread, ms since epoch. */
export function latestAgentActivityAt(comment) {
  let latest = 0;
  for (const r of comment?.replies || []) {
    if (!r) continue;
    if (!(r.author?.kind === 'agent' || r.agent_status)) continue;
    const t = Date.parse(r.created || '');
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest;
}

function latestHumanActivityAt(comment) {
  let latest = Date.parse(comment?.thread_activity?.human_at || '') || 0;
  if (comment?.author?.kind !== 'agent' && comment?.author?.kind !== 'system') {
    latest = Math.max(latest, Date.parse(comment?.created || '') || 0);
  }
  for (const reply of comment?.replies || []) {
    if (!reply || reply.author?.kind === 'agent' || reply.author?.kind === 'system' || reply.agent_status) continue;
    latest = Math.max(latest, Date.parse(reply.created || '') || 0);
  }
  return latest;
}

export function readSeenMap(slug) {
  if (!slug) return {};
  try {
    const raw = readStored(storageKey(slug), '{}');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** True when an agent has spoken and the viewer has not opened since. */
export function isThreadUnread(comment, seenMap) {
  if (!comment || comment.deleted || (comment.status === 'applied' && comment.resolved_by)) return false;
  const activity = latestAgentActivityAt(comment);
  if (!activity) return false;
  // A person who replied after the agent has already read that turn.
  if (latestHumanActivityAt(comment) >= activity) return false;
  const seen = Number(seenMap?.[comment.id] || 0);
  return activity > seen;
}

export function markThreadSeen(slug, comment) {
  if (!slug || !comment?.id) return false;
  const activity = latestAgentActivityAt(comment) || Date.now();
  const map = readSeenMap(slug);
  const prev = Number(map[comment.id] || 0);
  if (prev >= activity) return false;
  map[comment.id] = activity;
  writeStored(storageKey(slug), JSON.stringify(map));
  return true;
}
