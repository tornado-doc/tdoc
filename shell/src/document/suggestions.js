import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decideSuggestion, listSuggestions, suggestEdits } from './api.js';

// AI suggestions in the doc (flag askEditV2). The server keeps each set of
// edits tdoc AI proposed ({ id, edits:[{ id, find, replace, state }] });
// the frame shows the pending ones in place (frame-probe.js tdoc:suggest*)
// and this hook keeps the two in step: which are on screen, which one the
// review bar is on, and what Accept / Reject do. Accept publishes on the
// server (a new version, saved as this person), then the page moves to
// that version (pending suggestions are stored and come back with it).
//
// A suggestion is named in the frame and the review bar by `${set}:${edit}`.
// What comment cards and the comment list need (Fix with AI, Fix all):
// { enabled, fix(comment), fixAll(), fixable, busyIds, pendingFor(id), review(id) }.
export const SuggestContext = createContext(null);

export const suggestionKey = (set, edit) => `${set.id}:${edit.id}`;

export function useSuggestions({ slug, version, enabled, send, onToast, onPublished, onAccepted }) {
  const [sets, setSets] = useState([]);
  const [shown, setShown] = useState({});
  const [activeKey, setActiveKey] = useState(null);
  const [busy, setBusy] = useState(null); // { label, text, commentIds }
  const [deciding, setDeciding] = useState(false);
  // Where the active suggestion ends in the doc (frame tdoc:suggestRect),
  // for the inline Accept / Reject chip the shell draws over the frame.
  const [rect, setRect] = useState(null);
  const published = useRef(0);
  const frameReady = useRef(false);

  const pending = useMemo(() => sets.flatMap((set) => set.edits
    .filter((edit) => edit.state === 'pending')
    .map((edit) => ({ key: suggestionKey(set, edit), set, edit }))), [sets]);
  const pendingSig = pending.map((p) => p.key).join('|');

  // What the frame shows, in reading order; the ones it could not place
  // (the text changed since) are left out of the review.
  const ordered = useMemo(() => pending
    .filter((p) => shown[p.key]?.ok)
    .sort((a, b) => (shown[a.key].docY || 0) - (shown[b.key].docY || 0)), [pending, shown]);

  const showAll = useCallback(() => {
    if (!enabled || !frameReady.current) return;
    send({ type: 'tdoc:suggestShow', items: pending.map((p) => ({ id: p.key, find: p.edit.find, replace: p.edit.replace })) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, send, pendingSig]);

  useEffect(() => { showAll(); }, [showAll]);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    listSuggestions(slug).then((body) => { if (live && Array.isArray(body?.suggestions)) setSets(body.suggestions); }).catch(() => {});
    return () => { live = false; };
  }, [enabled, slug]);

  // The frame's reply to OUR focus request, once, shortly after: the doc's
  // own scripts share the frame's window and could post a position too.
  const asked = useRef(null);
  const focus = useCallback((key, scroll = true) => {
    setActiveKey(key);
    setRect(null);
    asked.current = key ? { key, at: Date.now() } : null;
    if (key) send({ type: 'tdoc:suggestFocus', id: key, scroll });
  }, [send]);

  // Frame messages, for the page's bridge.
  const frameHandlers = useMemo(() => ({
    'tdoc:ready': () => { frameReady.current = true; showAll(); },
    'tdoc:suggestRect': (message) => {
      const want = asked.current;
      if (!want || want.key !== String(message.id) || Date.now() - want.at > 1500) return;
      asked.current = null;
      setRect({ id: want.key, docY: Number(message.docY) || 0, left: Number(message.left) || 0, right: Number(message.right) || 0 });
    },
    'tdoc:suggestShown': (message) => {
      const next = {};
      for (const r of message.results || []) next[r.id] = { ok: r.ok === true, docY: Number(r.docY) || 0 };
      setShown(next);
    },
  }), [showAll]);

  useEffect(() => {
    // Keep the review bar on a suggestion that is still there, or one the
    // frame has yet to report on; one it could not show gives way.
    if (activeKey && ordered.some((p) => p.key === activeKey)) return;
    if (activeKey && pending.some((p) => p.key === activeKey) && !shown[activeKey]) return;
    if (ordered.length) focus(ordered[0].key, false);
    else setActiveKey(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered.map((p) => p.key).join('|'), activeKey, shown]);

  const step = (delta) => {
    if (!ordered.length) return;
    const at = Math.max(0, ordered.findIndex((p) => p.key === activeKey));
    focus(ordered[(at + delta + ordered.length) % ordered.length].key);
  };

  const replaceSet = (next) => setSets((list) => list.map((s) => (s.id === next.id ? next : s)));

  const decide = async (keys, decision) => {
    if (deciding || !keys.length) return;
    setDeciding(true);
    const bySet = new Map();
    for (const key of keys) {
      const p = pending.find((x) => x.key === key);
      if (!p) continue;
      if (!bySet.has(p.set.id)) bySet.set(p.set.id, []);
      bySet.get(p.set.id).push(p.edit.id);
    }
    let lastVersion = 0;
    try {
      for (const [setId, editIds] of bySet) {
        try {
          const body = await decideSuggestion(slug, setId, decision, editIds);
          const done = decision === 'accept' ? body.accepted || [] : body.rejected || [];
          for (const id of done) send({ type: 'tdoc:suggestSettle', id: `${setId}:${id}`, accepted: decision === 'accept' });
          for (const id of body.stale || []) send({ type: 'tdoc:suggestSettle', id: `${setId}:${id}`, accepted: false });
          if (body.stale?.length) onToast?.('Part of the text changed since; that suggestion was dropped. Ask again to regenerate it.', true);
          if (body.version) lastVersion = Math.max(lastVersion, body.version);
          if (body.suggestion) replaceSet(body.suggestion);
        } catch (error) {
          if (error.body?.suggestion) {
            for (const id of error.body.stale || []) send({ type: 'tdoc:suggestSettle', id: `${setId}:${id}`, accepted: false });
            replaceSet(error.body.suggestion);
          }
          onToast?.(error.body?.error === 'original_changed'
            ? 'The original changed since this was suggested. Ask again to regenerate it.'
            : error.message || 'Could not do that', true);
        }
      }
    } finally {
      setDeciding(false);
    }
    if (lastVersion) {
      published.current = Math.max(published.current, lastVersion);
      onToast?.(`Published v${lastVersion}`);
      // Show the version just published: comments are read as of the
      // version on screen, so a fixed comment reads applied only there.
      // Suggestions still pending come back with it (they are stored).
      onAccepted?.(lastVersion);
      setTimeout(() => onPublished?.(lastVersion), 700);
    }
  };

  // Ask tdoc AI. Resolves with the server's answer ({ kind:'answer' } or
  // { kind:'edits', suggestion, dropped }); progress shows on the passage.
  const request = async ({ instruction, scope = { kind: 'doc' }, passage = null, label = 'tdoc AI is editing…' }) => {
    setBusy({ label, text: passage, commentIds: scope.kind === 'comments' ? scope.comment_ids : [] });
    send({ type: 'tdoc:suggestBusy', text: passage, label });
    try {
      const body = await suggestEdits(slug, { instruction, baseVersion: version, scope });
      if (body?.kind === 'edits' && body.suggestion) {
        setSets((list) => [body.suggestion, ...list.filter((s) => s.id !== body.suggestion.id
          && !(scope.kind === 'comments' && (s.comment_ids || []).some((c) => scope.comment_ids.includes(c))))]);
        const first = body.suggestion.edits[0];
        if (first) setTimeout(() => focus(suggestionKey(body.suggestion, first)), 80);
      }
      return body;
    } finally {
      setBusy(null);
      send({ type: 'tdoc:suggestBusy', text: null, label: '' });
    }
  };

  // A person's own agent was handed the request (reply_as 'suggestions'):
  // the status shows on the passage until its propose_edits arrive. Polled,
  // as Agent activity is; given up after ten minutes. `settled` says the
  // agent has spoken or the delivery failed: an agent that only answered is
  // not still working, so the status goes, and the quiet poll goes on in case
  // its edits follow its reply. A second handoff adds to the wait.
  const waiting = useRef(null);
  const awaitAgent = ({ commentId = null, commentIds = null, label, passage = null, settled = null }) => {
    const prior = waiting.current;
    const ids = [...new Set([...(prior?.ids || []), ...(commentIds || (commentId ? [commentId] : []))])];
    const known = prior?.known || new Set(sets.map((x) => x.id));
    const checks = [...(prior?.checks || []), ...(settled ? [settled] : [])];
    if (prior) clearInterval(prior.timer);
    setBusy({ label, text: passage, commentIds: ids });
    send({ type: 'tdoc:suggestBusy', text: passage, label });
    const started = Date.now();
    const quiet = () => {
      setBusy(null);
      send({ type: 'tdoc:suggestBusy', text: null, label: '' });
    };
    const stop = () => {
      if (waiting.current) clearInterval(waiting.current.timer);
      waiting.current = null;
      quiet();
    };
    let spoke = false;
    const timer = setInterval(async () => {
      if (Date.now() - started > 10 * 60 * 1000) { stop(); return; }
      let body = null;
      try { body = await listSuggestions(slug); } catch { return; }
      const list = Array.isArray(body?.suggestions) ? body.suggestions : [];
      // Edits this person's own agent sent since, naming no comment, still
      // belong to this wait: nothing else would show them. Somebody else's
      // are not the answer being waited for. (A minute's grace: the server's clock.)
      const unnamed = (x) => !(x.comment_ids || []).length && x.mine && Date.parse(x.created) >= started - 60000;
      const fresh = list.filter((x) => !known.has(x.id) && (!ids.length || unnamed(x) || (x.comment_ids || []).some((c) => ids.includes(c))));
      if (!fresh.length) {
        if (!spoke && checks.length && checks.every((check) => check())) { spoke = true; quiet(); }
        return;
      }
      stop();
      setSets(list);
      onToast?.('Suggestions are ready to review.');
      const first = fresh[0].edits.find((e) => e.state === 'pending');
      if (first) setTimeout(() => focus(suggestionKey(fresh[0], first)), 120);
    }, 4000);
    waiting.current = { timer, stop, ids, known, checks };
  };
  useEffect(() => () => { if (waiting.current) clearInterval(waiting.current.timer); }, []);

  return {
    awaitAgent,
    stopWaiting: () => waiting.current?.stop(),
    enabled,
    sets,
    pending,
    ordered,
    activeKey,
    active: ordered.find((p) => p.key === activeKey) || null,
    rect: rect && rect.id === activeKey ? rect : null,
    // A click on a suggestion in the frame: only one the review lists.
    pick: (key) => { if (ordered.some((p) => p.key === key)) { focus(key, false); return true; } return false; },
    busy,
    deciding,
    frameHandlers,
    request,
    focus,
    next: () => step(1),
    prev: () => step(-1),
    // The one on screen (`active`, from what the frame could show), never a
    // focus that outran the frame's report: nobody accepts what they did not see.
    accept: (key) => decide([key || ordered.find((p) => p.key === activeKey)?.key].filter(Boolean), 'accept'),
    reject: (key) => decide([key || ordered.find((p) => p.key === activeKey)?.key].filter(Boolean), 'reject'),
    acceptAll: () => decide(ordered.map((p) => p.key), 'accept'),
    rejectAll: () => decide(pending.map((p) => p.key), 'reject'),
    review: (commentId) => {
      const p = ordered.find((x) => x.edit.comment_id === commentId || (x.set.comment_ids || []).includes(commentId));
      if (p) focus(p.key);
    },
    // The comments a pending suggestion would fix.
    commentPending: (commentId) => pending.some((p) => p.edit.comment_id === commentId || (p.set.comment_ids || []).includes(commentId)),
  };
}
