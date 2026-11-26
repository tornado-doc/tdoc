import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { inviteQuestion } from '../core/invite-question.js';

// Ask before a mention adds someone to a doc (flag confirmMentionInvite). The
// server answers a post that says confirm_invites: 'ask' with 409
// { error: 'confirm_invites', would_invite } when the doc's owner names
// someone who cannot read it yet; nothing is written. The box that is posting
// (the composer or a reply box) then shows one line, and the post goes again
// with exactly the people confirmed, or none.
export const InviteConfirmContext = createContext(null);

// `post(send)`: send(confirm) makes the request; confirm is undefined with the
// flag off (the request as it always was), 'ask', then a list. Resolves to the
// server's answer, or null when the person closed the box instead.
export function useInviteConfirm(enabled) {
  const [pending, setPending] = useState(null);
  const current = useRef(null);
  const settle = useCallback((choice) => {
    const p = current.current;
    current.current = null;
    setPending(null);
    if (p) p.resolve(choice);
  }, []);
  const post = useCallback(async (send) => {
    if (!enabled) return send(undefined);
    try {
      return await send('ask');
    } catch (error) {
      const who = error?.status === 409 && error.body?.error === 'confirm_invites' ? error.body.would_invite : null;
      if (!Array.isArray(who) || !who.length) throw error;
      if (current.current) current.current.resolve(null);
      const choice = await new Promise((resolve) => {
        current.current = { who, resolve };
        setPending({ who });
      });
      if (!choice) return null;
      return send(choice === 'add' ? who : []);
    }
  }, [enabled]);
  return useMemo(() => ({ pending, settle, post, cancel: () => settle(null) }), [pending, settle, post]);
}

// Asking now, in the box that is posting (`busy`)?
export function useInviteAsking(busy) {
  const ctx = useContext(InviteConfirmContext);
  return Boolean(busy && ctx?.pending);
}

// The line itself, in the box that is posting: said aloud, with the focus on
// Add & post. Esc takes the question back (nothing posts, the words stay, the
// focus goes back to them) and nothing else: the box stays open. A box that
// goes away while it asks takes the question with it.
export function InviteConfirmRow({ busy, fieldRef = null }) {
  const ctx = useContext(InviteConfirmContext);
  const asking = Boolean(busy && ctx?.pending);
  const settle = ctx?.settle;
  const add = useRef(null);
  useEffect(() => (asking ? () => settle(null) : undefined), [asking, settle]);
  useEffect(() => {
    if (!asking) return undefined;
    add.current?.focus({ preventScroll: true });
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      settle(null);
      fieldRef?.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [asking, settle, fieldRef]);
  if (!asking) return null;
  return (
    <div className="tdoc-invite-confirm" role="group" aria-label="Add to this doc">
      <span className="tdoc-invite-confirm-text" role="status" aria-live="polite">{inviteQuestion(ctx.pending.who)}</span>
      <span className="tdoc-invite-confirm-actions">
        <button ref={add} type="button" className="ui-btn ui-btn-primary ui-btn-s" onClick={() => settle('add')}>Add &amp; post</button>
        <button type="button" className="ui-btn ui-btn-secondary ui-btn-s" onClick={() => settle('skip')}>Post without adding</button>
      </span>
    </div>
  );
}
