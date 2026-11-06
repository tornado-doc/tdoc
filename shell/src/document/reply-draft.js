// A reply being typed, one per thread, for every surface that draws a
// CommentCard. It lives outside the card because the card does not outlive
// what people do around it: an agent's answer moves a thread to another tab,
// a tap outside closes it, a list is read again, a page reloads.
//
// Kept in this tab's sessionStorage, in memory where storage is refused, under
// the thread and the account. A comment id is unique across docs (c_<time>_<random>),
// so the doc needs no part of the key and no surface has to pass it. Written
// synchronously for the reason draft-store.js is: the newest keystroke must be
// there if the page goes away the next moment.

const PREFIX = 'tdoc-reply-draft:';
const memory = new Map();
const listeners = new Set();

const storage = () => {
  try { return window.sessionStorage; } catch { return null; }
};
const keyOf = (threadId, account) => `${PREFIX}${threadId}:${account || 'anon'}`;

// { text, parentId, prefilled }: `parentId` is the comment or reply it answers;
// `prefilled` the tag the box started with, which alone is not a reply.
export function readReplyDraft(threadId, account) {
  const key = keyOf(threadId, account);
  let raw = memory.get(key) ?? null;
  if (raw === null) {
    try { raw = storage()?.getItem(key) ?? null; } catch { raw = null; }
  }
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    return record && typeof record.text === 'string' && record.text ? record : null;
  } catch {
    return null;
  }
}

function drop(key) {
  memory.delete(key);
  try { storage()?.removeItem(key); } catch {}
}

export function writeReplyDraft(threadId, account, record) {
  const key = keyOf(threadId, account);
  if (!record?.text) { drop(key); return; }
  const raw = JSON.stringify(record);
  try {
    storage().setItem(key, raw);
    memory.delete(key);
  } catch {
    memory.set(key, raw);
  }
}

// The reply went. Only the text that was sent is cleared: words typed while it
// was on its way are a new draft (the same rule as draft-store.js clearDraftBody).
export function clearReplyDraft(threadId, account, sentText) {
  const current = readReplyDraft(threadId, account);
  if (current && sentText !== undefined && current.text !== sentText) return false;
  drop(keyOf(threadId, account));
  listeners.forEach((listener) => listener());
  return true;
}

// Whether anyone in this tab left words on this thread. Only keeps a card from
// leaving the list (comment-area.js); the text itself goes by readReplyDraft.
export function hasReplyDraft(threadId) {
  const prefix = `${PREFIX}${threadId}:`;
  for (const key of memory.keys()) if (key.startsWith(prefix)) return true;
  try {
    const store = storage();
    for (let i = 0; i < (store?.length || 0); i += 1) {
      if (store.key(i)?.startsWith(prefix)) return true;
    }
  } catch {}
  return false;
}

// Hears a draft being posted away, for the list that held its card in place.
export function subscribeReplyDrafts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
