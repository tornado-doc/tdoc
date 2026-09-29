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
  if (!comment || comment.deleted || comment.status === 'applied') return false;
  const activity = latestAgentActivityAt(comment);
  if (!activity) return false;
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
