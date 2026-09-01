import { useCallback, useEffect, useState } from 'react';
import {
  createComment,
  listComments,
  removeComment,
  toggleReaction,
  updateCommentAnchor,
  updateCommentText,
} from '../document/api.js';
import { anchorFromSelection } from '../document/model.js';

export function useComments({ slug, version, onChange, onUnauthorized }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await listComments(slug, version);
      const safeComments = Array.isArray(next) ? next : [];
      setComments(safeComments);
      onChange?.(safeComments);
      return safeComments;
    } finally {
      setLoading(false);
    }
  }, [onChange, slug, version]);

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
    return mutate(() => createComment({
        slug,
        version,
        text: text.trim(),
        anchor: anchorFromSelection(selection),
      }));
  }, [mutate, slug, version]);

  const addReply = useCallback(async (parentId, text) => {
    return mutate(() => createComment({ slug, version, text: text.trim(), parent_id: parentId }));
  }, [mutate, slug, version]);

  const edit = useCallback(async (id, text) => {
    return mutate(() => updateCommentText({ slug, version, id, text: text.trim() }));
  }, [mutate, slug, version]);

  const react = useCallback(async (commentId, emoji) => {
    return mutate(() => toggleReaction({ slug, version, comment_id: commentId, emoji }));
  }, [mutate, slug, version]);

  const remove = useCallback(async (id) => {
    return mutate(() => removeComment(slug, version, id));
  }, [mutate, slug, version]);

  const moveAnchor = useCallback(async (id, selectionOrAnchor) => {
    const anchor = selectionOrAnchor.kind === 'none'
      ? selectionOrAnchor
      : anchorFromSelection(selectionOrAnchor);
    return mutate(() => updateCommentAnchor({ slug, version, id, anchor }));
  }, [mutate, slug, version]);

  return {
    comments,
    loading,
    refresh,
    addComment,
    addReply,
    edit,
    react,
    remove,
    moveAnchor,
  };
}
