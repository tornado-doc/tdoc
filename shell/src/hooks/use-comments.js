import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createComment,
  listComments,
  removeComment,
  setCommentResolved,
  toggleReaction,
  updateCommentAnchor,
  updateCommentText,
} from '../document/api.js';
import { anchorFromSelection } from '../document/model.js';

function demoId() {
  return `demo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function demoAuthor(identity) {
  return identity || { login: 'you', name: 'You' };
}

export function useComments({ slug, version, onChange, onUnauthorized, demo = false, identity = null }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  // The list as of the last refresh, readable the moment an await resolves.
  // `comments` is state: it has not re-rendered yet at that point, and a
  // delete needs to know what it left behind — a comment that still holds
  // replies survives as a tombstone, one that holds nothing is gone.
  const latest = useRef([]);

  const applyLocal = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(latest.current) : updater;
    latest.current = next;
    setComments(next);
    onChange?.(next);
    return next;
  }, [onChange]);

  const refresh = useCallback(async () => {
    if (demo) {
      setLoading(false);
      return latest.current;
    }
    try {
      const next = await listComments(slug, version);
      const safeComments = Array.isArray(next) ? next : [];
      latest.current = safeComments;
      setComments(safeComments);
      onChange?.(safeComments);
      return safeComments;
    } finally {
      setLoading(false);
    }
  }, [demo, onChange, slug, version]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  // Returns the server's response for the mutation itself — the caller needs
  // it for POST /api/comments, which reports what became of each @mention.
  const mutate = useCallback(async (operation) => {
    try {
      const result = await operation();
      await refresh();
      return result;
    } catch (error) {
      if (error.status === 401 && onUnauthorized) return onUnauthorized();
      throw error;
    }
  }, [onUnauthorized, refresh]);

  const addComment = useCallback(async (selection, text) => {
    if (demo) {
      const comment = {
        id: demoId(),
        version,
        text: text.trim(),
        author: demoAuthor(identity),
        status: 'open',
        created: new Date().toISOString(),
        anchor: anchorFromSelection(selection),
        replies: [],
      };
      applyLocal((list) => [...list, comment]);
      return comment;
    }
    return mutate(() => createComment({
        slug,
        version,
        text: text.trim(),
        anchor: anchorFromSelection(selection),
      }));
  }, [applyLocal, demo, identity, mutate, slug, version]);

  const addReply = useCallback(async (parentId, text) => {
    if (demo) {
      const reply = {
        id: demoId(),
        text: text.trim(),
        author: demoAuthor(identity),
        created: new Date().toISOString(),
        parent_id: parentId,
      };
      applyLocal((list) => list.map((c) => {
        if (c.id === parentId) {
          return { ...c, replies: [...(c.replies || []), reply] };
        }
        // Reply-to-reply: parent is a reply under this root.
        if ((c.replies || []).some((r) => r.id === parentId)) {
          return { ...c, replies: [...(c.replies || []), reply] };
        }
        return c;
      }));
      return reply;
    }
    return mutate(() => createComment({ slug, version, text: text.trim(), parent_id: parentId }));
  }, [applyLocal, demo, identity, mutate, slug, version]);

  const edit = useCallback(async (id, text) => {
    if (demo) {
      const trimmed = text.trim();
      applyLocal((list) => list.map((c) => {
        if (c.id === id) return { ...c, text: trimmed };
        const replies = (c.replies || []).map((r) => (r.id === id ? { ...r, text: trimmed } : r));
        return replies === c.replies ? c : { ...c, replies };
      }));
      return { ok: true };
    }
    return mutate(() => updateCommentText({ slug, version, id, text: text.trim() }));
  }, [applyLocal, demo, mutate, slug, version]);

  const react = useCallback(async (commentId, emoji) => {
    if (demo) {
      const me = demoAuthor(identity).login;
      applyLocal((list) => list.map((c) => {
        const bump = (item) => {
          const reactions = { ...(item.reactions || {}) };
          const users = [...(reactions[emoji] || [])];
          const i = users.indexOf(me);
          if (i >= 0) users.splice(i, 1);
          else users.push(me);
          if (users.length) reactions[emoji] = users;
          else delete reactions[emoji];
          return { ...item, reactions };
        };
        if (c.id === commentId) return bump(c);
        const replies = (c.replies || []).map((r) => (r.id === commentId ? bump(r) : r));
        return replies === c.replies ? c : { ...c, replies };
      }));
      return { ok: true };
    }
    return mutate(() => toggleReaction({ slug, version, comment_id: commentId, emoji }));
  }, [applyLocal, demo, identity, mutate, slug, version]);

  const setResolved = useCallback(async (id, resolved) => {
    if (demo) {
      applyLocal((list) => list.map((c) => (
        c.id === id ? { ...c, status: resolved ? 'resolved' : 'open' } : c
      )));
      return { ok: true };
    }
    return mutate(() => setCommentResolved({ slug, version, id, resolved }));
  }, [applyLocal, demo, mutate, slug, version]);

  const remove = useCallback(async (id) => {
    if (demo) {
      applyLocal((list) => {
        const next = [];
        for (const c of list) {
          if (c.id === id) {
            if ((c.replies || []).some((r) => !r.deleted && String(r.text || '').trim())) {
              next.push({ ...c, text: '', deleted: true });
            }
            continue;
          }
          const replies = (c.replies || [])
            .map((r) => (r.id === id ? { ...r, text: '', deleted: true } : r))
            .filter((r) => !r.deleted || (c.replies || []).some((o) => o.parent_id === r.id && !o.deleted));
          next.push(replies === c.replies ? c : { ...c, replies });
        }
        return next;
      });
      return { ok: true };
    }
    return mutate(() => removeComment(slug, version, id));
  }, [applyLocal, demo, mutate, slug, version]);

  const moveAnchor = useCallback(async (id, selectionOrAnchor) => {
    const anchor = selectionOrAnchor.kind === 'none'
      ? selectionOrAnchor
      : anchorFromSelection(selectionOrAnchor);
    if (demo) {
      applyLocal((list) => list.map((c) => (c.id === id ? { ...c, anchor } : c)));
      return { ok: true };
    }
    return mutate(() => updateCommentAnchor({ slug, version, id, anchor }));
  }, [applyLocal, demo, mutate, slug, version]);

  return {
    comments,
    latest,
    loading,
    refresh,
    addComment,
    addReply,
    edit,
    react,
    setResolved,
    remove,
    moveAnchor,
  };
}
