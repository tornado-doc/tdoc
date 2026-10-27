import { useCallback, useEffect, useMemo, useState } from 'react';
import { canSeeHandoff, summarizeHandoffSurfaces, threadPhase } from './handoff-state.js';
import { isThreadUnread, markThreadSeen, readSeenMap } from './thread-seen.js';

// Both the document and an embedded feedback space consume the same comment
// records. Keep their visibility, phase and unread decisions in one place;
// each surface only supplies its transport and anchor placement.
export function deriveCommentArea({ comments = [], filter = 'all', filterMode = 'resolution',
  selectedId = null, handoffViewer = '', isOwner = false, seenMap = {}, pageUrl = null }) {
  const all = Array.isArray(comments) ? comments : [];
  const byId = new Map(all.map((comment) => [comment.id, comment]));
  const phase = (comment) => filterMode === 'phase'
    ? threadPhase(comment)
    : comment.status === 'applied' ? 'resolved' : 'open';
  const shown = all.filter((comment) => (filterMode !== 'phase' || !comment.deleted) && (filter === 'all'
    || (filterMode === 'resolution' && filter === 'open' && phase(comment) !== 'resolved')
    || phase(comment) === filter));
  const visibleHandoffs = all.filter((comment) => canSeeHandoff(comment, handoffViewer, isOwner));
  const unread = visibleHandoffs.filter((comment) => isThreadUnread(comment, seenMap, handoffViewer));
  return {
    all, byId, shown, shownById: new Map(shown.map((comment) => [comment.id, comment])),
    selected: shown.find((comment) => comment.id === selectedId) || null,
    pageComments: pageUrl ? all.filter((comment) => comment.anchor?.url === pageUrl) : all,
    shownPageComments: pageUrl ? shown.filter((comment) => comment.anchor?.url === pageUrl) : shown,
    resolvedCount: all.filter((comment) => comment.status === 'applied').length,
    openCount: all.filter((comment) => phase(comment) === 'open').length,
    visibleHandoffs,
    handoffBuckets: summarizeHandoffSurfaces(visibleHandoffs),
    unread, unreadCount: unread.length,
  };
}

export function useCommentArea({ comments, slug, selectedId, filter, filterMode,
  handoffViewer, isOwner, pageUrl, autoMarkSelected = true }) {
  const [seenMap, setSeenMap] = useState(() => readSeenMap(slug));
  useEffect(() => { setSeenMap(readSeenMap(slug)); }, [slug]);
  useEffect(() => {
    if (!autoMarkSelected) return;
    const selected = comments?.find((comment) => comment.id === selectedId);
    if (selected && markThreadSeen(slug, selected)) setSeenMap(readSeenMap(slug));
  }, [autoMarkSelected, comments, selectedId, slug]);
  const area = useMemo(() => deriveCommentArea({ comments, filter, filterMode,
    selectedId, handoffViewer, isOwner, seenMap, pageUrl }),
  [comments, filter, filterMode, selectedId, handoffViewer, isOwner, seenMap, pageUrl]);
  const markRead = useCallback((comment) => {
    if (markThreadSeen(slug, comment)) setSeenMap(readSeenMap(slug));
  }, [slug]);
  const markAllRead = useCallback((commentsToMark = area.unread) => {
    let changed = false;
    for (const comment of commentsToMark) changed = markThreadSeen(slug, comment) || changed;
    if (changed) setSeenMap(readSeenMap(slug));
  }, [slug, area.unread]);
  return { ...area, seenMap, markRead, markAllRead };
}
