import { useCallback, useEffect, useRef, useState } from 'react';

// How every comment surface keeps its threads current: load, then read again
// every 15 s while the tab is visible, at once when the tab comes back, and
// on the Refresh button. Never while somebody is typing (`paused`): a list
// that moves under a half-written reply loses the person's place. Hidden
// tabs make no requests.
//
// The transport is injected: the doc page passes use-comments.js's refresh
// (GET /api/comments with the cookie), the feedback widget its call() over
// the feedback token. `load` resolves when the new list is in.
export const FEED_POLL_MS = 15_000;

// Somebody typing in a comment box (a reply, an edit, the composer) holds
// the poll for a few seconds after each keystroke. Events from the widget's
// shadow root are read at their real target.
const TYPING_HOLD_MS = 4000;
const COMMENT_BOX = '.tdoc-popup, .tdoc-margin-comment, [data-comment-id], .tdoc-thread, #tdoc-comment-layer, #tdoc-feedback-root';
let typedAt = 0;
let typingWatchers = 0;
function onTyping(event) {
  const target = (event.composedPath && event.composedPath()[0]) || event.target;
  if (!target || typeof target.closest !== 'function') return;
  const editable = target.isContentEditable || target.localName === 'textarea' || target.localName === 'input';
  if (editable && target.closest(COMMENT_BOX)) typedAt = Date.now();
}
function watchTyping() {
  if (typingWatchers++ === 0) document.addEventListener('input', onTyping, true);
  return () => { if (--typingWatchers === 0) document.removeEventListener('input', onTyping, true); };
}
export function isTypingInComments(now = Date.now()) {
  return now - typedAt < TYPING_HOLD_MS;
}

function pollMs() {
  const pinned = typeof window !== 'undefined' ? Number(window.__TDOC_COMMENT_POLL_MS) : 0;
  return pinned > 0 ? pinned : FEED_POLL_MS;
}

// `idleMax` (the doc page): a quiet list backs off, doubling up to idleMax,
// and is read every interval again as soon as `fingerprint(list)` changes,
// the tab comes back, Refresh is pressed, or `active` (a handoff in flight)
// says something is on its way.
export function useCommentFeed({ load, enabled = true, paused = false, interval = null, idleMax = 0, fingerprint = null, active = false }) {
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  // One read at a time; a click while one is in flight joins it.
  const refresh = useCallback(async () => {
    if (busy.current) return busy.current;
    const run = (async () => {
      setRefreshing(true);
      try { return await Promise.resolve().then(() => loadRef.current?.()); }
      finally { busy.current = null; setRefreshing(false); }
    })();
    busy.current = run;
    return run;
  }, []);

  useEffect(() => watchTyping(), []);

  const fingerprintRef = useRef(fingerprint);
  fingerprintRef.current = fingerprint;
  const activeRef = useRef(active);
  activeRef.current = active;
  const delay = useRef(0);
  const last = useRef(null);
  // A handoff going out (or settling) restarts the clock at the base pace:
  // the poll below is rescheduled at once, not after a backed-off wait.
  useEffect(() => { delay.current = 0; }, [active]);

  useEffect(() => {
    if (!enabled || paused) return undefined;
    const base = interval || pollMs();
    let timer = null;
    let stopped = false;
    let running = false;
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(tick, delay.current || base);
    };
    async function tick() {
      timer = null;
      if (document.visibilityState !== 'visible' || isTypingInComments()) { schedule(); return; }
      running = true;
      let list = null;
      try { list = await refresh(); } catch {}
      running = false;
      if (idleMax && fingerprintRef.current && !activeRef.current) {
        const now = fingerprintRef.current(list);
        delay.current = now === last.current ? Math.min((delay.current || base) * 2, idleMax) : base;
        last.current = now;
      } else delay.current = base;
      schedule();
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      delay.current = base;
      if (running) return;
      if (timer) clearTimeout(timer);
      timer = null;
      tick();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled, paused, interval, idleMax, active, refresh]);

  // Refresh pressed: back to the base pace.
  const refreshNow = useCallback(() => { delay.current = 0; return refresh(); }, [refresh]);

  return { refresh: refreshNow, refreshing };
}
