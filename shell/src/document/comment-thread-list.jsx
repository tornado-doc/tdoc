import React from 'react';
import { CommentCard } from './comment-card.jsx';

// The same thread card and action contract in the document drawer and an
// embedded feedback list. The caller supplies only anchor/navigation details.
export function CommentThreadList({ comments, cardProps, isAnchored, selectedId,
  expandReplies = false, onNavigate, isUnread = null, onSeen = null, beforeCard = null, itemClassName = '' }) {
  return comments.map((comment) => {
    const card = (
      <CommentCard
        {...cardProps}
        comment={comment}
        unanchored={isAnchored ? !isAnchored(comment) : false}
        expandReplies={selectedId === comment.id && expandReplies}
        selected={selectedId === comment.id}
        unread={isUnread ? isUnread(comment) : false}
        onSeen={onSeen}
        onActivate={onNavigate}
      />
    );
    return itemClassName || beforeCard
      ? <div className={itemClassName || undefined} key={comment.id}>{beforeCard?.(comment)}{card}</div>
      : <React.Fragment key={comment.id}>{card}</React.Fragment>;
  });
}
