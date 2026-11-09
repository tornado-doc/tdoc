// One definition of which threads a comment list shows, in what order, and
// what its counts say. The doc page, its phone drawer, the feedback widget
// and the feedback space's own page all read the same comment records; they
// differ only in how they fetch them (use-comment-feed.js) and where they put
// an anchor. Pure: no DOM, no React.
import { lastAgentAt, lastHumanAt } from './handoff-state.js';
import { containerKey } from '../selection/anchors/container.js';

// Open (default): not resolved. Replied: not resolved, and an agent spoke
// last. Resolved. All. Open is the default everywhere: resolved threads are
// out of the way until somebody asks for them.
export const COMMENT_FILTERS = Object.freeze(['open', 'replied', 'resolved', 'all']);
export const DEFAULT_FILTER = 'open';
export const COMMENT_SORTS = Object.freeze(['position', 'newest', 'oldest']);
export const DEFAULT_SORT = 'position';

export function normalizeFilter(value) {
  return COMMENT_FILTERS.includes(value) ? value : DEFAULT_FILTER;
}
export function normalizeSort(value) {
  return COMMENT_SORTS.includes(value) ? value : DEFAULT_SORT;
}

const ts = (iso) => {
  const n = Date.parse(iso || '');
  return Number.isFinite(n) ? n : 0;
};
const keysOf = (viewer) => (Array.isArray(viewer) ? viewer : [viewer])
  .map((key) => String(key || '').trim().toLowerCase())
  .filter((key) => key && key !== 'anon');

export function isResolvedThread(comment) {
  return Boolean(comment) && comment.status === 'applied';
}

function liveReplies(comment) {
  return (comment?.replies || []).filter((reply) => reply && !reply.deleted && String(reply.text || '').trim());
}

// The deleted-thread rule, the same on every surface: a deleted comment that
// still holds replies stays (a tombstone is the way back to those replies);
// one that holds nothing is not a thread any more.
export function isListedThread(comment) {
  if (!comment) return false;
  return !comment.deleted || liveReplies(comment).length > 0;
}

// Who spoke last decides Replied, not the agent's status label.
export function agentSpokeLast(comment) {
  if (!comment) return false;
  const agent = lastAgentAt(comment);
  return Boolean(agent && agent >= lastHumanAt(comment));
}

export function matchesFilter(comment, filter) {
  if (!isListedThread(comment)) return false;
  switch (normalizeFilter(filter)) {
    case 'all': return true;
    case 'resolved': return isResolvedThread(comment);
    case 'replied': return !isResolvedThread(comment) && agentSpokeLast(comment);
    default: return !isResolvedThread(comment);
  }
}

// The newest word in the thread (the comment or a live reply), with who
// said it. An agent's status stamp counts as the agent's word.
export function lastWord(comment) {
  if (!comment) return null;
  let last = comment.deleted ? null : { at: ts(comment.created), author: comment.author || null };
  for (const reply of comment.replies || []) {
    if (!reply || reply.deleted) continue;
    const at = ts(reply.created);
    if (!last || at >= last.at) last = { at, author: reply.agent_status && reply.author?.kind !== 'agent' ? { kind: 'agent' } : reply.author || null };
  }
  return last;
}

// Not resolved, and the last word is not the viewer's. With no viewer (signed
// out) nothing is theirs, so every open thread waits on them.
export function isWaitingOn(comment, viewer) {
  if (!isListedThread(comment) || isResolvedThread(comment)) return false;
  const keys = keysOf(viewer);
  const word = lastWord(comment);
  if (!word) return false;
  if (word.author?.kind === 'agent' || word.author?.kind === 'system') return true;
  const login = String(word.author?.login || '').trim().toLowerCase();
  return !(login && keys.includes(login));
}

// "N open" means not resolved, everywhere. `waitingOnYou` is the separate
// count of open threads whose last word is somebody else's.
export function countThreads(comments, viewer = null) {
  const counts = { open: 0, replied: 0, resolved: 0, all: 0, waitingOnYou: 0 };
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!isListedThread(comment)) continue;
    counts.all += 1;
    if (isResolvedThread(comment)) { counts.resolved += 1; continue; }
    counts.open += 1;
    if (agentSpokeLast(comment)) counts.replied += 1;
    if (viewer != null && isWaitingOn(comment, viewer)) counts.waitingOnYou += 1;
  }
  return counts;
}

// Search: free text (comment and replies), author (login or name of anyone
// in the thread) and @agent (an agent that answered, or was handed it).
// Every given field must match; an empty query matches everything.
export function parseSearch(query) {
  if (query && typeof query === 'object') return query;
  const out = { text: '', author: '', agent: '' };
  const words = [];
  for (const word of String(query || '').trim().split(/\s+/).filter(Boolean)) {
    const m = /^(author|from|by|agent):(.+)$/i.exec(word);
    if (m) {
      const field = m[1].toLowerCase() === 'agent' ? 'agent' : 'author';
      out[field] = m[2].replace(/^@/, '');
    } else words.push(word);
  }
  out.text = words.join(' ');
  return out;
}

const lower = (value) => String(value || '').toLowerCase();
const personMatches = (author, needle) => Boolean(author) && (lower(author.login).includes(needle) || lower(author.name).includes(needle));
const agentNames = (comment) => {
  const names = [];
  for (const reply of comment.replies || []) {
    if (!reply || !(reply.author?.kind === 'agent' || reply.agent_status)) continue;
    names.push(reply.author?.login, reply.author?.name);
  }
  const to = comment.handoff_to;
  if (to) names.push(to.agent_name, to.name, to.label, to.login, to.team_agent?.name);
  return names.filter(Boolean).map(lower);
};

export function matchesSearch(comment, query) {
  const { text = '', author = '', agent = '' } = parseSearch(query);
  if (!comment) return false;
  if (text) {
    const needle = lower(text);
    const hay = [comment.text, comment.anchor?.text, comment.anchor?.label, ...(comment.replies || []).map((r) => r && !r.deleted && r.text)];
    if (!hay.some((value) => lower(value).includes(needle))) return false;
  }
  if (author) {
    const needle = lower(author);
    if (!personMatches(comment.author, needle) && !(comment.replies || []).some((r) => r && personMatches(r.author, needle))) return false;
  }
  if (agent) {
    const needle = lower(agent).replace(/^@/, '');
    if (!agentNames(comment).some((name) => name.includes(needle))) return false;
  }
  return true;
}

export function searchThreads(comments, query) {
  const q = parseSearch(query);
  if (!q.text && !q.author && !q.agent) return Array.isArray(comments) ? comments.slice() : [];
  return (comments || []).filter((comment) => matchesSearch(comment, q));
}

// Where a thread lives: the whole document, a page of an app, a slide, later
// a sheet tab: one key per container (selection/anchors/container.js), the
// same one the slide view counts "N comments on this slide" by.
export function defaultContainerOf(comment) {
  return containerKey(comment?.anchor);
}

// Position inside a container: whatever the surface measures (a pin's y in
// the document, an element's place on the page), as [y, x] or a number.
// Threads with no position follow the placed ones, oldest first.
function positionKey(position) {
  if (position == null) return null;
  if (typeof position === 'number') return Number.isFinite(position) ? [position, 0] : null;
  if (Array.isArray(position)) return position.every(Number.isFinite) ? position : null;
  if (typeof position === 'object' && Number.isFinite(position.y)) return [position.y, Number(position.x) || 0];
  return null;
}

export function sortThreads(comments, sort = DEFAULT_SORT, { positionOf = null } = {}) {
  const list = (Array.isArray(comments) ? comments : []).map((comment, index) => ({ comment, index, at: ts(comment?.created) }));
  const mode = normalizeSort(sort);
  const byTime = (a, b) => (a.at - b.at) || (a.index - b.index);
  if (mode === 'newest') list.sort((a, b) => (b.at - a.at) || (a.index - b.index));
  else if (mode === 'oldest') list.sort(byTime);
  else {
    for (const row of list) row.pos = positionKey(positionOf ? positionOf(row.comment) : null);
    list.sort((a, b) => {
      if (a.pos && b.pos) return (a.pos[0] - b.pos[0]) || (a.pos[1] - b.pos[1]) || byTime(a, b);
      if (a.pos) return -1;
      if (b.pos) return 1;
      return byTime(a, b);
    });
  }
  return list.map((row) => row.comment);
}

// Groups in first-seen order, with `first` (e.g. "document", or this page)
// pulled to the top. Each group keeps the order it was given.
export function groupBy(comments, containerOf = defaultContainerOf, { first = null } = {}) {
  const groups = new Map();
  if (first != null) groups.set(first, []);
  for (const comment of comments || []) {
    const key = containerOf(comment);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(comment);
  }
  return [...groups.entries()].map(([key, items]) => ({ key, items }));
}

// The whole query: filter (with `keep` holding a card someone is typing in),
// search, sort. Counts are over every listed thread, not the shown ones, so a
// filter's number says what choosing it would show.
export function queryThreads(comments, {
  filter = DEFAULT_FILTER, sort = DEFAULT_SORT, search = '', keep = null, positionOf = null, viewer = null,
} = {}) {
  const all = Array.isArray(comments) ? comments : [];
  const filtered = all.filter((comment) => matchesFilter(comment, filter) || (keep && isListedThread(comment) && keep(comment)));
  const searched = searchThreads(filtered, search);
  return { shown: sortThreads(searched, sort, { positionOf }), counts: countThreads(all, viewer) };
}

// The filter control's choices, with counts, the same on every surface.
const FILTER_LABELS = { open: 'Open', replied: 'Replied', resolved: 'Resolved', all: 'All' };
export function filterOptions(counts = {}) {
  return COMMENT_FILTERS.map((value) => ({
    value, count: counts[value] || 0, label: `${FILTER_LABELS[value]} (${counts[value] || 0})`,
  }));
}

export const SORT_OPTIONS = Object.freeze([
  { value: 'position', label: 'Position' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
]);
