import { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import { commentsMarkdown } from '../core/agent-markdown.js';
import { isListedThread, isResolvedThread } from '../core/comment-query.js';
import { copyText } from '../../document/model.js';
import { useCommentShortcuts } from './keyboard.js';

// "Copy for agent" (flag copyForAgent), the same on every comment surface:
// a thread's ⋯ menu (CommentCard) copies that thread, the list's ⋯ menu
// (CommentPanel) copies every open thread and hides / shows the markers,
// and the keys C and H do the same while the list or a thread is open
// (keyboard.js). The Markdown is comments/core/agent-markdown.js.
//
// A surface calls useCopyForAgent with what is its own (its page, its
// links, its toast, its markers) and provides the result; a card or list
// with no provider above it shows nothing new.
const DOUBLE_MS = 250;
export const CopyForAgentContext = createContext(null);
export const useCopyForAgentActions = () => useContext(CopyForAgentContext);

// Open threads, in the order the list shows them, then any the filter hides.
export function openThreads(area) {
  const isOpen = (c) => isListedThread(c) && !c.deleted && !isResolvedThread(c);
  const shown = (area?.shown || []).filter(isOpen);
  const seen = new Set(shown.map((c) => c.id));
  return shown.concat((area?.all || []).filter((c) => isOpen(c) && !seen.has(c.id)));
}

export function useCopyForAgent({
  enabled = true,
  area,
  // The thread the keyboard copies: selected in the list, or open on the page.
  selectedId = null,
  title = '',
  pageUrl = '',
  linkFor = null,
  // (text, bad) => void: the surface's toast.
  say,
  // Markers (pins) on this surface: { hidden, toggle }, or null where it has none.
  markers = null,
  // The keys are live only while the comment layer is open on the page.
  keysEnabled = false,
}) {
  const live = useRef({});
  live.current = { area, selectedId, title, pageUrl, linkFor, say, markers };
  // One press, one action: in the feedback widget a menu row's press can
  // arrive twice (its popup layer is a root of its own), which would copy
  // twice or hide and show the markers again. The same action within
  // DOUBLE_MS of itself is that same press.
  const last = useRef({ key: '', at: 0 });
  const fresh = (key) => {
    const now = Date.now();
    if (last.current.key === key && now - last.current.at < DOUBLE_MS) return false;
    last.current = { key, at: now };
    return true;
  };

  const write = useCallback(async (threads, scope, done) => {
    const { title: t, pageUrl: url, linkFor: link, say: tell } = live.current;
    if (!threads.length) { tell?.('No open comments to copy'); return false; }
    const ok = await copyText(commentsMarkdown(threads, { title: t, pageUrl: url, linkFor: link, scope }));
    tell?.(ok ? done : 'Could not copy', !ok);
    return ok;
  }, []);
  const copyThread = useCallback((comment) => (fresh(`thread:${comment?.id}`) ? write(comment ? [comment] : [], '', 'Copied for agent') : false), [write]);
  const copyOpen = useCallback(() => {
    if (!fresh('open')) return false;
    const threads = openThreads(live.current.area);
    return write(threads, 'open', `Copied ${threads.length} open ${threads.length === 1 ? 'comment' : 'comments'} for agent`);
  }, [write]);
  const copySelectedOrOpen = useCallback(() => {
    const { area: a, selectedId: id } = live.current;
    const picked = id && a?.byId?.get(id);
    return picked && !picked.deleted ? copyThread(picked) : copyOpen();
  }, [copyThread, copyOpen]);
  const toggleMarkers = useCallback(() => {
    const m = live.current.markers;
    if (!m || !fresh('markers')) return;
    m.toggle();
    live.current.say?.(m.hidden ? 'Comment markers shown' : 'Comment markers hidden');
  }, []);

  useCommentShortcuts({
    copy: copySelectedOrOpen,
    markers: markers ? toggleMarkers : null,
  }, { enabled: enabled && keysEnabled });

  const hasMarkers = Boolean(markers);
  const markersHidden = Boolean(markers?.hidden);
  return useMemo(() => (enabled ? {
    copyThread, copyOpen,
    markers: hasMarkers ? { hidden: markersHidden, toggle: toggleMarkers } : null,
  } : null), [enabled, copyThread, copyOpen, hasMarkers, markersHidden, toggleMarkers]);
}
