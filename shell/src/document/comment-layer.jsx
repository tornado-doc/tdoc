import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { CommentIcon } from '../ui/comment-icon.jsx';
import { Drawer } from '@base-ui/react/drawer';
import { CommentCard } from './comment-card.jsx';
import { CommentThreadList } from './comment-thread-list.jsx';
import { CommentPinFace, commentPinState } from './comment-pin.jsx';
import { avatarFor, TOP_BAR_HEIGHT } from './model.js';

function Pin({
  cluster, top, left, frameTop, commentsById, seenMap, currentUser, handoffViewer = currentUser, isOwner, hoveredAnchorId, now, onOpenComment, onOpenCluster,
}) {
  const single = cluster.items.length === 1 ? cluster.items[0].comment : null;
  const resolved = single?.resolved
    || (!single && cluster.items.every((item) => item.comment.resolved));
  const live = single && commentsById ? commentsById.get(single.id) : null;
  const state = single ? commentPinState(live || single, { seenMap, handoffViewer, isOwner, now }) : null;

  return (
    <button
      type="button"
      className={[
        'tdoc-pin',
        single ? '' : 'tdoc-pin-cluster',
        single?.resolved && (!live?.handoff_at || live?.resolved_by) ? 'tdoc-pin-resolved' : '',
        // A tombstone keeps its pin — that is the way back to the replies
        // under it — but it must not look like a comment somebody is waiting
        // on. Without this a deleted thread is invisible until you click it.
        single?.deleted ? 'tdoc-pin-deleted' : '',
        !single && resolved ? 'tdoc-cluster-allresolved' : '',
        state?.waiting ? 'is-waiting-handoff' : '',
        state?.unread ? 'is-unread-handoff' : '',
        hoveredAnchorId && cluster.items.some((item) => item.comment.id === hoveredAnchorId) ? 'tdoc-pin-anchor-hover' : '',
      ].filter(Boolean).join(' ')}
      data-id={single?.id}
      data-key={cluster.key}
      title={state?.title}
      style={{ top: Math.max(frameTop + 4, top), left }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => single ? onOpenComment(single.id) : onOpenCluster(cluster.key)}
    >
      <CommentPinFace comment={single} state={state} clusterCount={cluster.items.length} />
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
  seenMap = {},
  hoveredAnchorId = null,
  frameScrollY,
  frameTop = TOP_BAR_HEIGHT,
  pinLeft,
  openComment,
  openClusterKey,
  pinIds,
  currentUser,
  handoffViewer = currentUser,
  isOwner,
  mentionable,
  demo = false,
  cardPosition,
  expandReplies,
  canSendToAgent = false,
  agentSetupHref = null,
  onOpenComment,
  onOpenCluster,
  onReply,
  onReact,
  onDelete,
  onResolve,
  onEdit,
  onReanchor,
  handoff = null,
  onResendHandoff = null,
  onSendHandoffElsewhere = null,
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
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
            commentsById={commentsById}
            seenMap={seenMap}
            currentUser={currentUser}
            handoffViewer={handoffViewer}
            isOwner={isOwner}
            hoveredAnchorId={hoveredAnchorId}
            now={now}
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
          handoffViewer={handoffViewer}
          isOwner={isOwner}
          mentionable={mentionable}
          demo={demo}
          unanchored={!pinIds.has(openComment.id)}
          floating
          position={cardPosition}
          expandReplies={expandReplies}
          canSendToAgent={canSendToAgent}
          agentSetupHref={agentSetupHref}
          onReply={onReply}
          onReact={onReact}
          onDelete={onDelete}
          onResolve={onResolve}
          onEdit={onEdit}
          onReanchor={onReanchor}
          handoff={handoff}
          onResendHandoff={onResendHandoff}
          onSendHandoffElsewhere={onSendHandoffElsewhere}
        />
      ) : null}
    </>
  );
}

export function MobileCommentDrawer({
  // The Open / Resolved / All control, above the list.
  filter = null,
  open,
  comments,
  openCount = comments.length,
  unread = false,
  pinIds,
  seenMap = {},
  currentUser,
  handoffViewer = currentUser,
  isOwner,
  mentionable,
  demo = false,
  openCommentId,
  expandReplies,
  canSendToAgent = false,
  agentSetupHref = null,
  onOpenChange,
  onStartComment = null,
  onAskAi = null,
  onReply,
  onReact,
  onDelete,
  onResolve,
  onEdit,
  onReanchor,
  onNavigate,
  handoff = null,
  onResendHandoff = null,
  onSendHandoffElsewhere = null,
}) {
  const drawerRef = useRef(null);

  // Tapping a highlight opens the drawer at THAT comment. The drawer mounts
  // and animates in after this effect first runs, so look for the card for a
  // few frames instead of once (it was often not there yet, and the list
  // opened at the top).
  useEffect(() => {
    if (!open || !openCommentId) return undefined;
    let frames = 0;
    let raf = 0;
    const find = () => {
      const root = drawerRef.current;
      const card = root && [...root.querySelectorAll('[data-comment-id]')]
        .find((element) => element.dataset.commentId === openCommentId);
      if (card) { card.scrollIntoView({ block: 'center' }); return; }
      if (frames++ < 30) raf = requestAnimationFrame(find);
    };
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, [open, openCommentId]);

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="down">
      <Drawer.Trigger className="tdoc-fab" aria-label={openCount ? `${openCount} open comments${unread ? ', new agent reply' : ''}` : 'Open comments'}>
        <CommentIcon size={16} />
        {openCount > 0 ? <span id="tdoc-fab-count">{openCount}</span> : null}
        {unread ? <span className="tdoc-fab-unread-dot" aria-hidden="true" /> : null}
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Backdrop className="tdoc-drawer-backdrop" />
        <Drawer.Viewport className="tdoc-drawer-viewport">
          <Drawer.Popup ref={drawerRef} id="tdoc-comment-layer" className="open">
            <Drawer.Title className="tdoc-visually-hidden">Comments</Drawer.Title>
            <Drawer.Close className="tdoc-drawer-handle" aria-label="Close comments" />
            <Drawer.Content className="tdoc-drawer-list">
              {filter ? <div className="tdoc-comment-filter-row">{filter}</div> : null}
              {!comments.length ? <div className="tdoc-drawer-empty">
                <p>No comments here yet.</p>
                <div className="tdoc-drawer-empty-actions">
                  {onStartComment ? <button type="button" onClick={() => { onOpenChange(false); onStartComment(); }}>Leave a comment</button> : null}
                  {onAskAi ? <button type="button" onClick={() => { onOpenChange(false); onAskAi(); }}>Ask AI</button> : null}
                </div>
              </div> : null}
              <CommentThreadList
                comments={comments}
                selectedId={openCommentId}
                expandReplies={expandReplies}
                isAnchored={(comment) => pinIds.has(comment.id)}
                isUnread={(comment) => commentPinState(comment, { seenMap, handoffViewer, isOwner }).unread}
                onNavigate={onNavigate}
                cardProps={{
                  currentUser, handoffViewer, isOwner, mentionable, demo,
                  canSendToAgent, agentSetupHref, onReply, onReact, onDelete,
                  onResolve, onEdit, onReanchor, handoff, onResendHandoff,
                  onSendHandoffElsewhere,
                }}
              />
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
