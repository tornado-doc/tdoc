// A comment shows the moment its POST answers, on every surface (the doc
// page, slides, sheets, the feedback widget, the feedback space page).
//
// POST /api/comments answers with the comment as stored: a new thread's
// snapshot, or a reply with the thread it joined. That answer is merged into
// the list the surface already holds; the full re-read of the comments, an
// agent handoff and the @ list refresh follow in the background and replace
// it. Waiting for them held the composer on "Posting…" after the comment was
// already saved, for as long as the slowest of them took (Julie, 2026-11-11).

// Fields of the POST answer that are about the request, not the comment.
const RESPONSE_ONLY = ['mention_outcome', 'duplicate_of', 'thread_id', 'parent_id'];

function stripResponse(made) {
  const out = { ...made };
  for (const key of RESPONSE_ONLY) delete out[key];
  return out;
}

// `made` is the POST answer; `parentId` the reply's parent when it is one.
// Pure: returns a new list, or the same list when there is nothing to add
// (no id, or a comment the list already has, e.g. a duplicate post).
export function withPostedComment(list, made, parentId = null) {
  const comments = Array.isArray(list) ? list : [];
  if (!made || typeof made !== 'object' || !made.id) return comments;
  const id = made.duplicate_of || made.id;
  const parent = parentId || made.parent_id || null;
  if (!parent) {
    if (comments.some((c) => c && c.id === id)) return comments;
    return [...comments, { replies: [], reactions: {}, status: 'open', ...stripResponse(made), id }];
  }
  // A reply joins its thread's root: the server says which (thread_id); a
  // reply to a reply has the root as its thread.
  const rootId = made.thread_id
    || (comments.find((c) => c && (c.id === parent || (c.replies || []).some((r) => r && r.id === parent))) || {}).id;
  let changed = false;
  const next = comments.map((c) => {
    if (!c || c.id !== rootId) return c;
    const replies = Array.isArray(c.replies) ? c.replies : [];
    if (replies.some((r) => r && r.id === id)) return c;
    changed = true;
    return { ...c, replies: [...replies, { ...stripResponse(made), id, parent_id: parent }] };
  });
  return changed ? next : comments;
}
