import React, { useEffect, useRef, useState } from 'react';
import { CommentIcon } from '../ui/comment-icon.jsx';
import { SegmentedControl } from '../ui/segmented-control.jsx';
import { AskIcon } from '../ui/ask-icon.jsx';
import { Drawer } from '@base-ui/react/drawer';
import { CommentCard } from './comment-card.jsx';
import { CommentThreadList } from './comment-thread-list.jsx';
import { CommentPinFace, commentPinState } from './comment-pin.jsx';
import { avatarFor, isDocumentComment, TOP_BAR_HEIGHT } from './model.js';

function Pin({
  cluster, top, left, frameTop, commentsById, seenMap, currentUser, handoffViewer = currentUser, isOwner, hoveredAnchorId, now, onOpenComment, onOpenCluster,
}) {
  const single = cluster.items.length === 1 ? cluster.items[0].comment : null;
  const documentPin = cluster.items.every((item) => item.comment.document);
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
        documentPin ? 'tdoc-pin-document' : '',
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
      title={documentPin ? `${cluster.items.length} comment${cluster.items.length === 1 ? '' : 's'} on this document` : state?.title}
      aria-label={documentPin ? `${cluster.items.length} comment${cluster.items.length === 1 ? '' : 's'} on this document` : undefined}
      style={{ top: Math.max(frameTop + 4, top), left: documentPin ? Math.min(left, window.innerWidth - 50) : left }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => single ? onOpenComment(single.id) : onOpenCluster(cluster.key)}
    >
      {documentPin && !single ? <span className="tdoc-document-pin-faces" aria-hidden="true">
        {cluster.items.slice(0, 3).map(({ comment }, index) => {
          const avatar = avatarFor(comment);
          return avatar ? <img key={comment.id} src={avatar} alt="" style={{ zIndex: 3 - index }} />
            : <span key={comment.id} className="tdoc-pin-anon" style={{ zIndex: 3 - index }} />;
        })}
      </span> : <CommentPinFace comment={single} state={state} clusterCount={cluster.items.length} />}
    </button>
  );
}

function ClusterPopover({ cluster, commentsById, top, left, cardProps }) {
  return (
    <div
      className="tdoc-cluster-pop tdoc-cluster-cards open"
      style={{ top, left, maxHeight: Math.max(160, window.innerHeight - top - 16) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <CommentThreadList comments={cluster.items.map(({ comment }) => commentsById.get(comment.id) || comment)} cardProps={cardProps} />
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
  const cardProps = {
    currentUser, handoffViewer, isOwner, mentionable, demo, canSendToAgent,
    agentSetupHref, onReply, onReact, onDelete, onResolve, onEdit, onReanchor,
    handoff, onResendHandoff, onSendHandoffElsewhere,
  };

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
          top={Math.max(frameTop + 4, Math.min(frameTop + openCluster.y - frameScrollY, window.innerHeight - 240))}
          left={Math.max(8, pinLeft - 300)}
          cardProps={cardProps}
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

const HOWTO_KEY = 'tdoc-howto-comment-dismissed';

// The empty drawer teaches the one gesture that matters (select, then
// Comment) until the reader says they have it; Ask AI stays one tap away.
function EmptyCommentsHowTo({ onAskAi }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(HOWTO_KEY) === '1'; } catch { return false; }
  });
  const dismiss = () => {
    try { localStorage.setItem(HOWTO_KEY, '1'); } catch {}
    setDismissed(true);
  };
  return (
    <div className="tdoc-drawer-empty">
      {dismissed ? <p>No comments here yet. Select any text to comment.</p> : (
        <>
          <div className="tdoc-howto-demo" aria-hidden="true">
            <span className="tdoc-howto-line">Billing ships <mark>first, in March</mark></span>
            <span className="tdoc-howto-line short" />
            <span className="tdoc-howto-pill"><CommentIcon size={11} /> Comment</span>
          </div>
          <p>Select any text, then tap <strong>Comment</strong>.</p>
        </>
      )}
      <div className="tdoc-drawer-empty-actions">
        {onAskAi ? <button type="button" className="tdoc-link-btn" onClick={onAskAi}>or Ask AI</button> : null}
      </div>
      {dismissed ? null : <button type="button" className="tdoc-howto-dismiss" onClick={dismiss}>Got it, don’t show again</button>}
    </div>
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
  hideFab = false,
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
  // Unified entry: the same drawer also holds the Ask AI panel, one tab away.
  askAi = null,
  tab = 'comments',
  onTab = null,
}) {
  const drawerRef = useRef(null);
  const showAsk = Boolean(askAi) && tab === 'ask';

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
    <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="down" snapPoints={[0.7, 1]} defaultSnapPoint={0.7}>
      <Drawer.Trigger className={`tdoc-fab${hideFab ? ' is-hidden' : ''}`} aria-label={openCount ? `${openCount} open comments${unread ? ', new agent reply' : ''}` : 'Open comments'}>
        <CommentIcon size={16} />
        {askAi ? <AskIcon className="tdoc-fab-ai" size={11} /> : null}
        {openCount > 0 ? <span id="tdoc-fab-count">{openCount}</span> : null}
        {unread ? <span className="tdoc-fab-unread-dot" aria-hidden="true" /> : null}
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Backdrop className="tdoc-drawer-backdrop" />
        <Drawer.Viewport className="tdoc-drawer-viewport">
          <Drawer.Popup ref={drawerRef} id="tdoc-comment-layer" className="open">
            <Drawer.Title className="tdoc-visually-hidden">Comments</Drawer.Title>
            <Drawer.Close className="tdoc-drawer-handle" aria-label="Close comments" />
            {askAi ? <div className="tdoc-drawer-tabs">
              <SegmentedControl
                ariaLabel="Comments or Ask AI"
                value={tab}
                onChange={onTab}
                options={[
                  { value: 'comments', label: openCount ? `Comments · ${openCount}` : 'Comments' },
                  { value: 'ask', label: <>Ask AI{unread ? <span className="tdoc-tab-dot" aria-label="new agent reply" /> : null}</> },
                ]}
              />
            </div> : null}
            {showAsk ? <div className="tdoc-drawer-ask">{askAi}</div> : (
            <Drawer.Content className="tdoc-drawer-list">
              {filter ? <div className="tdoc-comment-filter-row">{filter}</div> : null}
              {!comments.length ? <EmptyCommentsHowTo
                onAskAi={askAi && onTab ? () => onTab('ask') : onAskAi ? () => { onOpenChange(false); onAskAi(); } : null}
              /> : null}
              <CommentThreadList
                comments={comments}
                selectedId={openCommentId}
                expandReplies={expandReplies}
                isAnchored={(comment) => isDocumentComment(comment) || pinIds.has(comment.id)}
                isUnread={(comment) => commentPinState(comment, { seenMap, handoffViewer, isOwner }).unread}
                onNavigate={onNavigate}
                cardProps={{
                  currentUser, handoffViewer, isOwner, mentionable, demo,
                  canSendToAgent, agentSetupHref, onReply, onReact, onDelete,
                  onResolve, onEdit, onReanchor, handoff, onResendHandoff,
                  onSendHandoffElsewhere,
                }}
              />
            </Drawer.Content>)}
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
