import React, { useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, SmilePlus } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import { MentionField, MentionText } from './mention-field.jsx';
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
        {/* Legacy placement: under the button, left edges aligned, flipped or
            shifted to stay on screen. positionMethod="fixed" because the card
            it opens from is itself fixed to the viewport. */}
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          positionMethod="fixed"
          className="tdoc-picker-positioner"
        >
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

function ReplyForm({ commentId, onReply, replyingTo, mentionable }) {
  const [text, setText] = useState('');

  const submit = async () => {
    if (!text.trim()) return;
    // onReply resolves false when the shell reported a failure; keep the draft.
    if (await onReply(commentId, text) !== false) setText('');
  };

  return (
    <div className="tdoc-reply-form open" data-parent-id={commentId}>
      {replyingTo ? <div className="tdoc-reply-to">Replying to @{replyingTo}</div> : null}
      <MentionField
        placeholder="Reply… (@ to notify someone)"
        value={text}
        people={mentionable}
        onChange={setText}
        onSubmit={submit}
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

// Mirrors the worker's canMutate(): delete and re-anchor are the author's or
// the doc owner's, nobody else's. Without this the buttons rendered for every
// reader and the server's 403 (`not_author`) was the only thing stopping them
// — a toast where there should have been no affordance at all.
function mayMutate(item, currentUser, isOwner) {
  return Boolean(
    isOwner
    || (currentUser
      && currentUser !== 'anon'
      && item.author?.login
      && item.author.login === currentUser),
  );
}

function hasReactions(item) {
  return Object.values(item.reactions || {}).some((users) => users?.length);
}

function formatCreated(created) {
  return created
    ? new Date(created).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    : '';
}

// A reply's parent is another comment id: the thread root when parent_id is
// absent (every reply written before threads nested) or another reply when the
// conversation went deeper. The server has always stored the chain — see the
// `reply_added` fold, which defaults parent_id to the root comment.
function childrenOf(replies, parentId, rootId) {
  return replies.filter((reply) => (reply.parent_id || rootId) === parentId);
}

// A comment or reply whose text was taken down but whose slot still holds a
// thread together (#354). Everything that acts on the words is gone with them
// — no reply, no react, no delete, no re-anchor — but the name and the place
// stay, so the answers under it still read as answers to someone.
function Tombstone({ item, children }) {
  return (
    <>
      <Author author={item.author} />
      <div className="text tdoc-deleted-text">Comment deleted</div>
      <div className="meta">
        <span>{formatCreated(item.created)}</span>
      </div>
      {children}
    </>
  );
}

// A reply carries the same affordances as the comment it hangs under: react,
// reply, and delete-your-own. Between the overlay rewrite and the React port
// these were "deferred", which left every answer in a thread a dead end.
function ReplyCard({
  reply,
  replies,
  rootId,
  depth,
  currentUser,
  isOwner,
  mentionable,
  replyTarget,
  onReplyTarget,
  onReply,
  onReact,
  onDelete,
}) {
  const kids = childrenOf(replies, reply.id, rootId);
  const reacted = hasReactions(reply);
  const author = reply.author?.login || reply.author?.name || '';
  const kidCards = kids.length ? (
    <div className="tdoc-reply-kids">
      {kids.map((kid) => (
        <ReplyCard
          key={kid.id}
          reply={kid}
          replies={replies}
          rootId={rootId}
          depth={depth + 1}
          currentUser={currentUser}
          isOwner={isOwner}
          mentionable={mentionable}
          replyTarget={replyTarget}
          onReplyTarget={onReplyTarget}
          onReply={onReply}
          onReact={onReact}
          onDelete={onDelete}
        />
      ))}
    </div>
  ) : null;

  if (reply.deleted) {
    return (
      <div className="tdoc-reply tdoc-deleted" data-comment-id={reply.id} data-depth={depth}>
        <Tombstone item={reply}>{kidCards}</Tombstone>
      </div>
    );
  }

  return (
    <div className="tdoc-reply" data-comment-id={reply.id} data-depth={depth}>
      <Author author={reply.author} />
      <div className="text"><MentionText text={reply.text} mentions={reply.mentions} /></div>
      {reacted ? <Reactions item={reply} me={currentUser} onReact={onReact} /> : null}

      <div className="meta">
        <span>{formatCreated(reply.created)}</span>
        <span className="actions">
          {reacted ? null : (
            <ReactionPicker onPick={(emoji) => onReact(reply.id, emoji)} />
          )}
          <button
            type="button"
            className="tdoc-reply-toggle"
            onClick={() => onReplyTarget(replyTarget === reply.id ? null : reply.id)}
          >
            Reply
          </button>
          {mayMutate(reply, currentUser, isOwner) ? (
            <button type="button" className="del" onClick={() => onDelete(reply.id)}>
              delete
            </button>
          ) : null}
        </span>
      </div>

      {replyTarget === reply.id ? (
        <ReplyForm commentId={reply.id} onReply={onReply} replyingTo={author} mentionable={mentionable} />
      ) : null}

      {kidCards}
    </div>
  );
}

export function CommentCard({
  comment,
  currentUser,
  isOwner = false,
  mentionable = [],
  unanchored,
  floating = false,
  position,
  expandReplies = false,
  selected = false,
  onActivate,
  onReply,
  onReact,
  onDelete,
  onReanchor,
}) {
  const [repliesOpen, setRepliesOpen] = useState(expandReplies);
  const [replyTarget, setReplyTarget] = useState(null);
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
  }, [floating, position, repliesOpen, replyTarget, comment]);
  const reactionCount = hasReactions(comment);
  const canMutate = mayMutate(comment, currentUser, isOwner);
  const createdAt = formatCreated(comment.created);
  const replies = comment.replies || [];
  // Orphans — their parent reply was deleted — still show under the root
  // rather than vanishing with it.
  const known = new Set(replies.map((reply) => reply.id).concat([comment.id]));
  const rootReplies = childrenOf(replies, comment.id, comment.id)
    .concat(replies.filter((reply) => reply.parent_id && !known.has(reply.parent_id)));

  const className = [
    'tdoc-margin-comment',
    'active',
    floating ? 'tdoc-floating-open' : '',
    selected ? 'tdoc-current-comment' : '',
    comment.status === 'applied' ? 'tdoc-resolved' : '',
    unanchored ? 'tdoc-unanchored' : '',
    comment.deleted ? 'tdoc-deleted' : '',
  ].filter(Boolean).join(' ');

  // The thread block is the same whether the comment above it is still there
  // or is a tombstone — the replies are why the tombstone exists.
  const threadBlock = replies.length ? (
    <>
      <button
        type="button"
        className={`tdoc-replies-toggle${repliesOpen ? ' open' : ''}`}
        onClick={() => setRepliesOpen((open) => !open)}
      >
        <ChevronRight className="chev" size={10} />
        {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
      </button>
      <div className={`tdoc-replies${repliesOpen ? ' open' : ''}`}>
        {rootReplies.map((reply) => (
          <ReplyCard
            key={reply.id}
            reply={reply}
            replies={replies}
            rootId={comment.id}
            depth={1}
            currentUser={currentUser}
            isOwner={isOwner}
            mentionable={mentionable}
            replyTarget={replyTarget}
            onReplyTarget={setReplyTarget}
            onReply={onReply}
            onReact={onReact}
            onDelete={onDelete}
          />
        ))}
      </div>
    </>
  ) : null;

  if (comment.deleted) {
    return (
      <article
        ref={cardRef}
        className={className}
        data-comment-id={comment.id}
        style={floating ? { ...position, top: clampedTop ?? position.top } : undefined}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Tombstone item={comment}>{threadBlock}</Tombstone>
      </article>
    );
  }

  return (
    <article
      ref={cardRef}
      className={className}
      data-comment-id={comment.id}
      style={floating ? { ...position, top: clampedTop ?? position.top } : undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        if (!onActivate) return;
        if (event.target instanceof Element
          && event.target.closest('button, a, input, textarea, select, [role="button"]')) return;
        onActivate(comment.id);
      }}
    >
      {canMutate ? (
        <div className="tdoc-anchor-actions">
          <button className="tdoc-reanchor-btn" type="button" onClick={() => onReanchor(comment.id)}>
            <span className={unanchored ? 'tdoc-reanchor-unanchored' : 'tdoc-reanchor-anchored'}>
              {unanchored ? 'unanchored - click to re-anchor' : '↻ move anchor'}
            </span>
          </button>
        </div>
      ) : null}

      {comment.status === 'applied' ? (
        <span className="tdoc-resolved-chip">
          ✓ fixed{comment.applied_in ? ` · v${comment.applied_in}` : ''}
        </span>
      ) : null}

      <Author author={comment.author} />
      <div className="text"><MentionText text={comment.text} mentions={comment.mentions} /></div>
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
            onClick={() => setReplyTarget((open) => (open === comment.id ? null : comment.id))}
          >
            Reply
          </button>
          {canMutate ? (
            <button type="button" className="del" onClick={() => onDelete(comment.id)}>
              delete
            </button>
          ) : null}
        </span>
      </div>

      {threadBlock}

      {replyTarget === comment.id ? (
        <ReplyForm commentId={comment.id} onReply={onReply} mentionable={mentionable} />
      ) : null}
    </article>
  );
}
