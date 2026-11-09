// "I've looked at this thread since the agent last spoke", per person.
// Unread lives on the pin so it is not trapped inside a folded card.
//
// The server keeps each person's "seen up to" per thread
// (/api/comments/seen), so a reply read in the feedback widget (on the app's
// origin) is read on the space's tdoc page, and the reverse. This browser's
// localStorage is a cache of it: it answers at once, works signed out, and
// carries marks made offline until the server has them (mergeSeenMap).

import { readStored, writeStored } from '../../safe-storage.js';

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

function latestViewerReplyAt(comment, viewerLogin) {
  const viewers = (Array.isArray(viewerLogin) ? viewerLogin : [viewerLogin])
    .map((login) => String(login || '').trim().toLowerCase())
    .filter((login) => login && login !== 'anon');
  if (!viewers.length) return 0;
  let latest = 0;
  for (const reply of comment?.replies || []) {
    if (!reply || reply.author?.kind === 'agent' || reply.author?.kind === 'system' || reply.agent_status) continue;
    if (!viewers.includes(String(reply.author?.login || '').trim().toLowerCase())) continue;
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
export function isThreadUnread(comment, seenMap, viewerLogin = '') {
  if (!comment || comment.deleted || (comment.status === 'applied' && comment.resolved_by)) return false;
  const activity = latestAgentActivityAt(comment);
  if (!activity) return false;
  // The viewer's own reply proves they saw the agent's turn; somebody else's
  // reply does not clear this viewer's unread indicator.
  if (latestViewerReplyAt(comment, viewerLogin) >= activity) return false;
  const seen = Number(seenMap?.[comment.id] || 0);
  return activity > seen;
}

/**
 * Marks the thread seen up to its latest agent activity. The stamp, or false.
 * A thread no agent has spoken in has nothing to read: nothing is written
 * (here or on the server), however often it is opened or polled.
 */
export function markThreadSeen(slug, comment) {
  if (!slug || !comment?.id) return false;
  const activity = latestAgentActivityAt(comment);
  if (!activity) return false;
  const map = readSeenMap(slug);
  const prev = Number(map[comment.id] || 0);
  if (prev >= activity) return false;
  map[comment.id] = activity;
  writeStored(storageKey(slug), JSON.stringify(map));
  return activity;
}

function cleanStamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Folds the server's map into this browser's cache: per thread, the later
 * stamp wins. Returns the merged map and what this browser knows that the
 * server does not yet (`ahead`), to be sent up.
 */
const cappedKey = (slug) => `tdoc.thread-seen-capped.${slug}`;
function readCapped(slug) {
  if (!slug) return {};
  try {
    const parsed = JSON.parse(readStored(cappedKey(slug), '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function mergeSeenMap(slug, remote) {
  const local = readSeenMap(slug);
  const merged = { ...local };
  const ahead = {};
  const server = remote && typeof remote === 'object' && !Array.isArray(remote) ? remote : {};
  let changed = false;
  for (const [id, value] of Object.entries(server)) {
    const stamp = cleanStamp(value);
    if (stamp > cleanStamp(merged[id])) { merged[id] = stamp; changed = true; }
  }
  // Marks the server already said it will not keep (its cap) stay here and
  // are not sent again, unless they have moved on since.
  const capped = readCapped(slug);
  for (const [id, value] of Object.entries(local)) {
    const stamp = cleanStamp(value);
    if (stamp > cleanStamp(server[id]) && stamp > cleanStamp(capped[id])) ahead[id] = stamp;
  }
  if (changed && slug) writeStored(storageKey(slug), JSON.stringify(merged));
  return { map: merged, ahead, changed };
}

/**
 * After a POST, what the server said about the ids that were sent:
 *  - `unknown` (threads the doc does not hold, e.g. deleted): they leave
 *    this cache, so they are never sent again;
 *  - a stamp lower than the one sent (a clock running ahead): the cache
 *    takes it, but only if it still holds the stamp that was sent: a newer
 *    mark made while the POST was on its way is kept.
 * An id the server did not keep because of its cap (`capped`: its record
 * holds the newest 500) stays here and is not sent again.
 */
export function reconcileSeenMap(slug, sent, server, unknown = [], capped = []) {
  if (!slug || !sent) return false;
  const map = readSeenMap(slug);
  const answer = server && typeof server === 'object' && !Array.isArray(server) ? server : {};
  const gone = new Set(Array.isArray(unknown) ? unknown : []);
  // Past the server's cap: kept here, remembered at the stamp sent, so the
  // next pull does not send them again.
  const cut = (Array.isArray(capped) ? capped : []).filter((id) => id in sent);
  if (cut.length) {
    const record = readCapped(slug);
    for (const id of cut) record[id] = cleanStamp(sent[id]);
    writeStored(cappedKey(slug), JSON.stringify(record));
  }
  let changed = false;
  for (const [id, value] of Object.entries(sent)) {
    const mine = cleanStamp(map[id]);
    const asSent = mine === cleanStamp(value);
    if (gone.has(id)) {
      if (id in map && asSent) { delete map[id]; changed = true; }
      continue;
    }
    const theirs = cleanStamp(answer[id]);
    if (theirs && asSent && theirs < mine) { map[id] = theirs; changed = true; }
  }
  if (changed) writeStored(storageKey(slug), JSON.stringify(map));
  return changed;
}
