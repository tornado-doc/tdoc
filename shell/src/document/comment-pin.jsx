import React from 'react';
import { avatarFor, avatarInitial } from './model.js';
import { canSeeHandoff, handoffPinBadge, handoffWaitState, isHandoffInFlight } from './handoff-state.js';
import { isThreadUnread } from './thread-seen.js';

const BADGE_TEXT = { question: '❓', done: '✅', partial: '🟡', warning: '⚠' };
const BADGE_LABEL = { question: 'Agent asked you', done: 'Agent done', partial: 'Partially done', warning: 'Agent handoff needs attention' };
// Pin faces are also rendered while older document stylesheets may still be
// cached. Keep the image bounded by the component as well as chrome.css.
const PIN_FACE_SIZE = { width: 24, height: 24, maxWidth: 24, maxHeight: 24 };

export function commentPinState(comment, { seenMap = {}, handoffViewer, isOwner = false, now = Date.now() } = {}) {
  const canSee = comment && canSeeHandoff(comment, handoffViewer, isOwner);
  const wait = canSee ? handoffWaitState(comment, now) : null;
  const badge = canSee ? handoffPinBadge(comment, now) : null;
  const waiting = isHandoffInFlight(wait);
  const unread = Boolean(canSee && !waiting && isThreadUnread(comment, seenMap, handoffViewer));
  return { badge, waiting, unread, title: BADGE_LABEL[badge] || (waiting ? 'Agent is working' : unread ? 'New agent reply' : comment?.text || 'tdoc comment') };
}

// `comment` is the frame's pin row ({ id, login, avatar_url, kind }); `author`
// is the full comment's author when the shell has it, for the name's initial.
export function CommentPinFace({ comment, author = null, state, clusterCount = null }) {
  if (!comment) return clusterCount;
  const who = author || comment.author || comment;
  const avatar = avatarFor(who);
  return <>
    {avatar ? <img src={avatar} alt="" width="24" height="24" style={PIN_FACE_SIZE} />
      : who.login || who.name ? <span className="tdoc-avatar-fallback" aria-hidden="true">{avatarInitial(who)}</span>
        : <span className="tdoc-pin-anon" />}
    {state?.badge ? <span className={`tdoc-pin-handoff-badge is-${state.badge}`} aria-hidden="true">{BADGE_TEXT[state.badge]}</span> : null}
    {state?.unread ? <span className="tdoc-pin-unread-dot" aria-hidden="true" /> : null}
  </>;
}
