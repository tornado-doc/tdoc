import React, { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import { CommentIcon } from '../ui/comment-icon.jsx';
import { Drawer } from '@base-ui/react/drawer';
import { CommentCard } from './comment-card.jsx';
import { avatarFor, TOP_BAR_HEIGHT } from './model.js';

function Pin({ cluster, top, left, frameTop, onOpenComment, onOpenCluster }) {
  const single = cluster.items.length === 1 ? cluster.items[0].comment : null;
  const resolved = single?.resolved
    || (!single && cluster.items.every((item) => item.comment.resolved));

  return (
    <button
      type="button"
      className={[
        'tdoc-pin',
        single ? '' : 'tdoc-pin-cluster',
        single?.resolved ? 'tdoc-pin-resolved' : '',
        // A tombstone keeps its pin — that is the way back to the replies
        // under it — but it must not look like a comment somebody is waiting
        // on. Without this a deleted thread is invisible until you click it.
        single?.deleted ? 'tdoc-pin-deleted' : '',
        !single && resolved ? 'tdoc-cluster-allresolved' : '',
      ].filter(Boolean).join(' ')}
      data-id={single?.id}
      data-key={cluster.key}
      style={{ top: Math.max(frameTop + 4, top), left }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => single ? onOpenComment(single.id) : onOpenCluster(cluster.key)}
    >
      {single ? (
        avatarFor(single)
          ? <img src={avatarFor(single)} alt="" />
          : <span className="tdoc-pin-anon" />
      ) : cluster.items.length}
    </button>
  );
}

function ClusterPopover({ cluster, commentsById, top, left, onSelect }) {
  return (
    <div
      className="tdoc-cluster-pop open"
      style={{ top, left }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {cluster.items.map(({ comment }) => (
        <button
          key={comment.id}
          type="button"
          className="tdoc-cluster-row"
          data-id={comment.id}
          onClick={() => onSelect(comment.id)}
        >
          {avatarFor(comment) ? <img src={avatarFor(comment)} alt="" /> : null}
          <span className="tdoc-cluster-snip">
            {commentsById.get(comment.id)?.text?.slice(0, 60)}
          </span>
          {comment.resolved ? <Check size={13} /> : null}
        </button>
      ))}
    </div>
  );
}

export function DesktopCommentLayer({
  clusters,
  commentsById,
  frameScrollY,
  frameTop = TOP_BAR_HEIGHT,
  pinLeft,
  openComment,
  openClusterKey,
  pinIds,
  currentUser,
  isOwner,
  mentionable,
  cardPosition,
  expandReplies,
  onOpenComment,
  onOpenCluster,
  onReply,
  onReact,
  onDelete,
  onReanchor,
}) {
  const openCluster = clusters.find((cluster) => cluster.key === openClusterKey);

  return (
    <>
      {clusters.map((cluster) => {
        const top = frameTop + cluster.y - frameScrollY;
        if (top < frameTop - 20 || top > window.innerHeight - 8) return null;
        return (
          <Pin
            key={cluster.key}
            cluster={cluster}
            top={top}
            frameTop={frameTop}
            left={pinLeft}
            onOpenComment={onOpenComment}
            onOpenCluster={onOpenCluster}
          />
        );
      })}

      {openCluster ? (
        <ClusterPopover
          cluster={openCluster}
          commentsById={commentsById}
          top={Math.max(
            frameTop + 4,
            Math.min(frameTop + openCluster.y - frameScrollY, window.innerHeight - 200),
          )}
          left={Math.max(8, pinLeft - 268)}
          onSelect={onOpenComment}
        />
      ) : null}

      {openComment ? (
        <CommentCard
          comment={openComment}
          currentUser={currentUser}
          isOwner={isOwner}
          mentionable={mentionable}
          unanchored={!pinIds.has(openComment.id)}
          floating
          position={cardPosition}
          expandReplies={expandReplies}
          onReply={onReply}
          onReact={onReact}
          onDelete={onDelete}
          onReanchor={onReanchor}
        />
      ) : null}
    </>
  );
}

export function MobileCommentDrawer({
  open,
  comments,
  pinIds,
  currentUser,
  isOwner,
  mentionable,
  openCommentId,
  expandReplies,
  onOpenChange,
  onReply,
  onReact,
  onDelete,
  onReanchor,
  onNavigate,
}) {
  const drawerRef = useRef(null);

  useEffect(() => {
    if (!open || !openCommentId || !drawerRef.current) return;
    const card = [...drawerRef.current.querySelectorAll('[data-comment-id]')]
      .find((element) => element.dataset.commentId === openCommentId);
    card?.scrollIntoView({ block: 'center' });
  }, [open, openCommentId]);

  if (!comments.length) return null;

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="down">
      <Drawer.Trigger className="tdoc-fab">
        <CommentIcon size={16} />
        <span id="tdoc-fab-count">{comments.length}</span>
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Backdrop className="tdoc-drawer-backdrop" />
        <Drawer.Viewport className="tdoc-drawer-viewport">
          <Drawer.Popup ref={drawerRef} id="tdoc-comment-layer" className="open">
            <Drawer.Title className="tdoc-visually-hidden">Comments</Drawer.Title>
            <Drawer.Close className="tdoc-drawer-handle" aria-label="Close comments" />
            <Drawer.Content className="tdoc-drawer-list">
              {comments.map((comment) => (
                <CommentCard
                  key={comment.id}
                  comment={comment}
                  currentUser={currentUser}
                  isOwner={isOwner}
                  mentionable={mentionable}
                  unanchored={!pinIds.has(comment.id)}
                  expandReplies={openCommentId === comment.id && expandReplies}
                  selected={openCommentId === comment.id}
                  onActivate={onNavigate}
                  onReply={onReply}
                  onReact={onReact}
                  onDelete={onDelete}
                  onReanchor={onReanchor}
                />
              ))}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
