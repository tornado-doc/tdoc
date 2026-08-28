import React, { useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, SmilePlus } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import { avatarFor, QUICK_REACTIONS } from './model.js';

function Author({ author }) {
  if (!author) {
    return <div className="author"><span className="anon">anonymous</span></div>;
  }

  const avatar = avatarFor(author);
  return (
    <div className={`author${author.kind === 'agent' ? ' tdoc-agent-author' : ''}`}>
      {avatar ? <img src={avatar} alt="" /> : null}
      <span className="login">{author.name || author.login || 'anonymous'}</span>
    </div>
  );
}

function ReactionPicker({ onPick }) {
  return (
    <Popover.Root>
      <Popover.Trigger className="tdoc-react-add" title="Add reaction">
        <SmilePlus size={14} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={5} className="tdoc-picker-positioner">
          <Popover.Popup className="tdoc-emoji-picker react-picker">
            {QUICK_REACTIONS.map((emoji) => (
              <Popover.Close
                key={emoji}
                className={emoji === 'LGTM' ? 'tdoc-emoji-text' : undefined}
                data-emoji={emoji}
                onClick={() => onPick(emoji)}
              >
                {emoji}
              </Popover.Close>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Reactions({ item, me, onReact }) {
  const reactions = Object.entries(item.reactions || {})
    .filter(([, users]) => users?.length);

  return (
    <div className="tdoc-reactions" data-target-id={item.id}>
      {reactions.map(([emoji, users]) => (
        <button
          key={emoji}
          type="button"
          className={[
            'tdoc-react-chip',
            users.includes(me) ? 'mine' : '',
            users.some((user) => /agent|codex|claude/i.test(user)) ? 'agent' : '',
          ].filter(Boolean).join(' ')}
          onClick={() => onReact(item.id, emoji)}
        >
          <span className="tdoc-emoji">{emoji}</span> {users.length}
        </button>
      ))}
      <ReactionPicker onPick={(emoji) => onReact(item.id, emoji)} />
    </div>
  );
}

function ReplyForm({ commentId, onReply }) {
  const [text, setText] = useState('');

  const submit = async () => {
    if (!text.trim()) return;
    // onReply resolves false when the shell reported a failure; keep the draft.
    if (await onReply(commentId, text) !== false) setText('');
  };

  return (
    <div className="tdoc-reply-form open" data-parent-id={commentId}>
      <textarea
        placeholder="Reply…"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit();
        }}
      />
      <div className="tdoc-reply-form-foot">
        <span className="hint" />
        <button className="tdoc-reply-submit" type="button" onClick={submit}>
          Reply
        </button>
      </div>
    </div>
  );
}

export function CommentCard({
  comment,
  currentUser,
  unanchored,
  floating = false,
  position,
  expandReplies = false,
  onReply,
  onReact,
  onDelete,
  onReanchor,
}) {
  const [repliesOpen, setRepliesOpen] = useState(expandReplies);
  const [replyOpen, setReplyOpen] = useState(false);
  const cardRef = useRef(null);
  const [clampedTop, setClampedTop] = useState(null);

  // Legacy positionCard(): keep the whole card on screen, measured after
  // render so an expanded thread or an open reply form never runs off the
  // bottom of the viewport.
  useLayoutEffect(() => {
    if (!floating || !position || !cardRef.current) return;
    const limit = window.innerHeight - cardRef.current.offsetHeight - 8;
    const next = Math.max(52, Math.min(position.top, limit));
    setClampedTop(next === position.top ? null : next);
  }, [floating, position, repliesOpen, replyOpen, comment]);
  const reactionCount = Object.values(comment.reactions || {})
    .some((users) => users?.length);
  const createdAt = comment.created
    ? new Date(comment.created).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    : '';

  const className = [
    'tdoc-margin-comment',
    'active',
    floating ? 'tdoc-floating-open' : '',
    comment.status === 'applied' ? 'tdoc-resolved' : '',
    unanchored ? 'tdoc-unanchored' : '',
  ].filter(Boolean).join(' ');

  return (
    <article
      ref={cardRef}
      className={className}
      data-comment-id={comment.id}
      style={floating ? { ...position, top: clampedTop ?? position.top } : undefined}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="tdoc-anchor-actions">
        <button className="tdoc-reanchor-btn" type="button" onClick={() => onReanchor(comment.id)}>
          <span className={unanchored ? 'tdoc-reanchor-unanchored' : 'tdoc-reanchor-anchored'}>
            {unanchored ? 'unanchored - click to re-anchor' : '↻ move anchor'}
          </span>
        </button>
      </div>

      {comment.status === 'applied' ? (
        <span className="tdoc-resolved-chip">
          ✓ fixed{comment.applied_in ? ` · v${comment.applied_in}` : ''}
        </span>
      ) : null}

      <Author author={comment.author} />
      <div className="text">{comment.text}</div>
      {reactionCount ? (
        <Reactions item={comment} me={currentUser} onReact={onReact} />
      ) : null}

      <div className="meta">
        <span>v{comment.version || 1}{createdAt ? ` · ${createdAt}` : ''}</span>
        <span className="actions">
          {!reactionCount ? (
            <ReactionPicker onPick={(emoji) => onReact(comment.id, emoji)} />
          ) : null}
          <button
            type="button"
            className="tdoc-reply-toggle"
            onClick={() => setReplyOpen((open) => !open)}
          >
            Reply
          </button>
          <button type="button" className="del" onClick={() => onDelete(comment.id)}>
            delete
          </button>
        </span>
      </div>

      {comment.replies?.length ? (
        <>
          <button
            type="button"
            className={`tdoc-replies-toggle${repliesOpen ? ' open' : ''}`}
            onClick={() => setRepliesOpen((open) => !open)}
          >
            <ChevronRight className="chev" size={10} />
            {comment.replies.length} {comment.replies.length === 1 ? 'reply' : 'replies'}
          </button>
          <div className={`tdoc-replies${repliesOpen ? ' open' : ''}`}>
            {comment.replies.map((reply) => (
              <div key={reply.id} className="tdoc-reply" data-comment-id={reply.id}>
                <Author author={reply.author} />
                <div className="text">{reply.text}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {replyOpen ? <ReplyForm commentId={comment.id} onReply={onReply} /> : null}
    </article>
  );
}
