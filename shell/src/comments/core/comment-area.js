import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canSeeHandoff, handoffWaitState, isHandoffInFlight, summarizeHandoffSurfaces } from './handoff-state.js';
import { isThreadUnread, markThreadSeen, mergeSeenMap, readSeenMap, reconcileSeenMap } from './thread-seen.js';
import { DEFAULT_FILTER, DEFAULT_SORT, normalizeFilter, normalizeSort, queryThreads } from './comment-query.js';
import { hasReplyDraft, subscribeReplyDrafts } from '../../document/reply-draft.js';
import { isFeatureOn } from '../../feature-flags.js';
import { getThreadSeen, postThreadSeen } from '../../document/api.js';
import { readStored, writeStored } from '../../safe-storage.js';

// The doc page, its phone drawer, the feedback space page and the feedback
// widget consume the same comment records. Their visibility, counts, order,
// unread and read decisions live here (and in comment-query.js); each
// surface only supplies its transport and anchor placement.

// Unread, one rule for the list, the pins, the badges and Mark all as read:
// an agent spoke after the viewer last looked, the viewer may see the
// handoff, and the agent is not still at work on it.
export function isUnreadFor(comment, { seenMap = {}, handoffViewer = '', isOwner = false, now = Date.now() } = {}) {
  if (!comment || !canSeeHandoff(comment, handoffViewer, isOwner)) return false;
  if (isHandoffInFlight(handoffWaitState(comment, now))) return false;
  return isThreadUnread(comment, seenMap, handoffViewer);
}

export function deriveCommentArea({ comments = [], filter = DEFAULT_FILTER, sort = DEFAULT_SORT, search = '', positionOf = null,
  selectedId = null, handoffViewer = '', isOwner = false, seenMap = {}, pageUrl = null, keep = null }) {
  const all = Array.isArray(comments) ? comments : [];
  const byId = new Map(all.map((comment) => [comment.id, comment]));
  const { shown, counts } = queryThreads(all, { filter, sort, search, keep, positionOf, viewer: handoffViewer });
  const visibleHandoffs = all.filter((comment) => canSeeHandoff(comment, handoffViewer, isOwner));
  const now = Date.now();
  const unread = visibleHandoffs.filter((comment) => isUnreadFor(comment, { seenMap, handoffViewer, isOwner, now }));
  return {
    all, byId, shown, shownById: new Map(shown.map((comment) => [comment.id, comment])),
    selected: shown.find((comment) => comment.id === selectedId) || null,
    pageComments: pageUrl ? all.filter((comment) => comment.anchor?.url === pageUrl) : all,
    shownPageComments: pageUrl ? shown.filter((comment) => comment.anchor?.url === pageUrl) : shown,
    counts,
    // "N open" = not resolved, on every surface.
    openCount: counts.open,
    resolvedCount: counts.resolved,
    // Not resolved, and the last word is somebody else's.
    waitingCount: counts.waitingOnYou,
    visibleHandoffs,
    handoffBuckets: summarizeHandoffSurfaces(visibleHandoffs),
    unread, unreadCount: unread.length,
  };
}

// The filter and sort a person chose, remembered per doc / feedback space.
const filterKey = (slug) => `tdoc.comment-filter.${slug}`;
const sortKey = (slug) => `tdoc.comment-sort.${slug}`;

export function readCommentFilter(slug) {
  return slug ? normalizeFilter(readStored(filterKey(slug), DEFAULT_FILTER)) : DEFAULT_FILTER;
}

// `initialFilter` shows that filter on arrival without making it the choice
// (a doc an agent just revised opens on All).
export function useCommentListPrefs(slug, { initialFilter = null } = {}) {
  const [filter, setFilterState] = useState(() => (initialFilter ? normalizeFilter(initialFilter) : readCommentFilter(slug)));
  const firstSlug = useRef(slug);
  const [sort, setSortState] = useState(() => (slug ? normalizeSort(readStored(sortKey(slug), DEFAULT_SORT)) : DEFAULT_SORT));
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (firstSlug.current === slug) return;
    firstSlug.current = slug;
    setFilterState(readCommentFilter(slug));
    setSortState(slug ? normalizeSort(readStored(sortKey(slug), DEFAULT_SORT)) : DEFAULT_SORT);
  }, [slug]);
  // `remember: false` shows a filter without making it the choice (a link
  // that reveals a resolved thread).
  const setFilter = useCallback((next, { remember = true } = {}) => {
    const value = normalizeFilter(next);
    setFilterState(value);
    if (remember && slug) writeStored(filterKey(slug), value);
  }, [slug]);
  const setSort = useCallback((next) => {
    const value = normalizeSort(next);
    setSortState(value);
    if (slug) writeStored(sortKey(slug), value);
  }, [slug]);
  return { filter, setFilter, sort, setSort, search, setSearch };
}

// Read state lives on the server per person (/api/comments/seen), cached in
// this browser. `syncSeen` is false where there is nobody to keep it for
// (signed out, the homepage demo).
const SEEN_PULL_MS = 5000;
const SEEN_BATCH_MS = 1500;
const defaultSeenTransport = { load: getThreadSeen, save: postThreadSeen };

export function useCommentArea({ comments, slug, selectedId, filter = DEFAULT_FILTER, sort = DEFAULT_SORT, search = '',
  positionOf = null, handoffViewer, isOwner, pageUrl, flagOn = isFeatureOn, syncSeen = false,
  seenTransport = defaultSeenTransport }) {
  // autoReadComments is read here, so no surface can skip it: on, a thread
  // is read once its card has been in view (onSeen); off, when it is opened.
  const autoRead = Boolean(flagOn('autoReadComments'));
  const [seenMap, setSeenMap] = useState(() => readSeenMap(slug));
  useEffect(() => { setSeenMap(readSeenMap(slug)); }, [slug]);

  const transport = useRef(seenTransport);
  transport.current = seenTransport;
  // Marks go up in one POST: at once for a click (open, Mark as read, Mark
  // all), gathered for SEEN_BATCH_MS for read-when-seen, where a scroll marks
  // card after card. A page going away sends what is waiting.
  const pending = useRef({});
  const timer = useRef(null);
  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const entries = pending.current;
    pending.current = {};
    const save = transport.current.save;
    if (!syncSeen || !slug || !save || !Object.keys(entries).length) return;
    Promise.resolve(save(slug, entries)).then((body) => {
      if (!body?.seen) return;
      // What the server said about what was sent: a thread it does not hold
      // leaves the cache, a stamp from a clock running ahead is lowered.
      const reconciled = reconcileSeenMap(slug, entries, body.seen, body.unknown);
      const { changed } = mergeSeenMap(slug, body.seen);
      if (reconciled || changed) setSeenMap(readSeenMap(slug));
    }).catch(() => {});
  }, [slug, syncSeen]);
  const push = useCallback((entries, { batch = false } = {}) => {
    if (!syncSeen || !slug || !entries || !Object.keys(entries).length) return;
    Object.assign(pending.current, entries);
    if (!batch) { flush(); return; }
    if (!timer.current) timer.current = setTimeout(flush, SEEN_BATCH_MS);
  }, [slug, syncSeen, flush]);
  useEffect(() => {
    const away = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', away);
    return () => { document.removeEventListener('visibilitychange', away); flush(); };
  }, [flush]);
  // Pull the server's map with the comments: on load and on every poll, at
  // most every few seconds. What this browser marked while the server could
  // not hear it goes up.
  // A pull in flight is not dropped when the comments arrive under it (that
  // is the usual order on load); only a doc change or unmount drops it.
  const lastPull = useRef(0);
  const live = useRef(slug);
  useEffect(() => {
    live.current = slug;
    lastPull.current = 0;
    return () => { live.current = null; };
  }, [slug, syncSeen]);
  useEffect(() => {
    if (!syncSeen || !slug) return;
    const now = Date.now();
    if (now - lastPull.current < SEEN_PULL_MS) return;
    lastPull.current = now;
    Promise.resolve(transport.current.load(slug)).then((body) => {
      if (live.current !== slug || !body) return;
      const { changed, ahead } = mergeSeenMap(slug, body.seen);
      if (changed) setSeenMap(readSeenMap(slug));
      push(ahead);
    }).catch(() => {});
  }, [comments, slug, syncSeen, push]);

  const mark = useCallback((list, options) => {
    const entries = {};
    for (const comment of list) {
      const stamp = markThreadSeen(slug, comment);
      if (stamp) entries[comment.id] = stamp;
    }
    if (!Object.keys(entries).length) return false;
    setSeenMap(readSeenMap(slug));
    push(entries, options);
    return true;
  }, [slug, push]);

  useEffect(() => {
    if (autoRead) return;
    const selected = comments?.find((comment) => comment.id === selectedId);
    if (selected) mark([selected]);
  }, [autoRead, comments, selectedId, mark]);
  // A card with a reply being typed stays where it is when the thread's phase
  // changes under it (an agent answers, someone resolves): it leaves when the
  // reply is posted or the viewer changes tab, and its draft goes with the
  // thread either way (reply-draft.js).
  const [draftsPosted, setDraftsPosted] = useState(0);
  useEffect(() => subscribeReplyDrafts(() => setDraftsPosted((n) => n + 1)), []);
  const lastShown = useRef({ filter, ids: new Set() });
  const area = useMemo(() => {
    const before = lastShown.current.filter === filter ? lastShown.current.ids : new Set();
    const next = deriveCommentArea({ comments, filter, sort, search, positionOf, selectedId, handoffViewer, isOwner, seenMap, pageUrl,
      keep: (comment) => before.has(comment.id) && hasReplyDraft(comment.id) });
    lastShown.current = { filter, ids: new Set(next.shown.map((comment) => comment.id)) };
    return next;
  }, [comments, filter, sort, search, positionOf, selectedId, handoffViewer, isOwner, seenMap, pageUrl, draftsPosted]);
  const markRead = useCallback((comment) => mark([comment]), [mark]);
  const markSeen = useCallback((comment) => mark([comment], { batch: true }), [mark]);
  // Mark all as read: one rule everywhere. It is offered whenever something
  // is unread, and it marks exactly what the unread count counts.
  const markAllRead = useCallback((commentsToMark = area.unread) => mark(commentsToMark), [mark, area.unread]);
  return {
    ...area, autoRead, seenMap, markRead, markAllRead,
    // For CommentThreadList / CommentCard: read when seen, only with the flag.
    onSeen: autoRead ? markSeen : null,
    showMarkAll: area.unreadCount > 0,
  };
}
