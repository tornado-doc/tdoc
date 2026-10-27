import React from 'react';
import { avatarFor } from './model.js';
import { canSeeHandoff, handoffPinBadge, handoffWaitState, isHandoffInFlight } from './handoff-state.js';
import { isThreadUnread } from './thread-seen.js';

const BADGE_TEXT = { question: '❓', done: '✅', partial: '🟡', warning: '⚠' };
const BADGE_LABEL = { question: 'Agent asked you', done: 'Agent done', partial: 'Partially done', warning: 'Agent handoff needs attention' };

export function commentPinState(comment, { seenMap = {}, handoffViewer, isOwner = false, now = Date.now() } = {}) {
  const canSee = comment && canSeeHandoff(comment, handoffViewer, isOwner);
  const wait = canSee ? handoffWaitState(comment, now) : null;
  const badge = canSee ? handoffPinBadge(comment, now) : null;
  const waiting = isHandoffInFlight(wait);
  const unread = Boolean(canSee && !waiting && isThreadUnread(comment, seenMap, handoffViewer));
  return { badge, waiting, unread, title: BADGE_LABEL[badge] || (waiting ? 'Agent is working' : unread ? 'New agent reply' : comment?.text || 'tdoc comment') };
}

export function CommentPinFace({ comment, state, clusterCount = null }) {
  if (!comment) return clusterCount;
  const avatar = avatarFor(comment.author || comment);
  return <>
    {avatar ? <img src={avatar} alt="" /> : <span className="tdoc-pin-anon" />}
    {state?.badge ? <span className={`tdoc-pin-handoff-badge is-${state.badge}`} aria-hidden="true">{BADGE_TEXT[state.badge]}</span> : null}
    {state?.unread ? <span className="tdoc-pin-unread-dot" aria-hidden="true" /> : null}
  </>;
}
