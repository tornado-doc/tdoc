// One place to inspect sent comments and send selected unsent comments.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { deliveryErrorText, readableHandle, resendResultText } from './notify-handoff.jsx';
import { compactHandoffText } from './handoff-status-line.jsx';
import { resendNotifyHandoff } from './api.js';
import { isThreadUnread } from './thread-seen.js';
import { handoffActivityAt, handoffWaitState, shortCommentPreview, summarizeHandoffSurfaces } from './handoff-state.js';
import { observeVisibleRead } from './visible-read.js';

function latestAgentReply(comment) {
  return [...(comment.replies || [])].reverse().find((reply) =>
    !reply.deleted && (reply.author?.kind === 'agent' || reply.agent_status));
}

function eventTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function history(comment) {
  const events = [];
  if (comment.handoff_at) events.push(['Sent', comment.handoff_at]);
  if (comment.handoff_delivery?.status === 'delivered') events.push(['Delivered', comment.handoff_delivery.at || comment.handoff_at]);
  if (comment.handoff_acked_at) events.push(['On it', comment.handoff_acked_at]);
  const reply = latestAgentReply(comment);
  if (reply) events.push([compactHandoffText(comment, 'replied') || 'Agent replied', reply.created]);
  return events;
}

export function HandoffDetailsPanel({
  slug, open, onClose, comments, seenMap = {}, handoffViewer = '', showReady = true, onJump, onRefresh, onToast, onSendReady, onSendElsewhere, onMarkRead, onMarkAllRead, onReply, onViewChanges, autoRead = false,
}) {
  const buckets = useMemo(() => summarizeHandoffSurfaces(comments), [comments]);
  const sentRows = useMemo(() => {
    const rows = [];
    for (const state of ['failed', 'waiting', 'received', 'replied']) {
      for (const comment of buckets[state]) rows.push({ comment, state });
    }
    for (const comment of comments || []) {
      if (!comment.deleted && comment.status === 'applied' && comment.handoff_at) rows.push({ comment, state: 'resolved' });
    }
    return rows.sort((a, b) => handoffActivityAt(b.comment) - handoffActivityAt(a.comment));
  }, [buckets, comments]);
  const [busyId, setBusyId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [replyDrafts, setReplyDrafts] = useState({});
  const [replyBusy, setReplyBusy] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  const wasOpen = useRef(false);
  const panelRef = useRef(null);
  const readRef = useRef({ seenMap, handoffViewer, onMarkRead });
  readRef.current = { seenMap, handoffViewer, onMarkRead };
  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => {
    if (open && !wasOpen.current) setSelectedIds(buckets.ready.map((comment) => comment.id));
    wasOpen.current = open;
  }, [open, buckets.ready]);
  const selected = selectedIds.filter((id) => buckets.ready.some((comment) => comment.id === id));
  const hasUnread = (comments || []).some((comment) => isThreadUnread(comment, seenMap, handoffViewer));
  useEffect(() => {
    if (!open || !autoRead || !onMarkRead || !panelRef.current) return undefined;
    const byId = new Map(sentRows.map(({ comment }) => [comment.id, comment]));
    const stops = [...panelRef.current.querySelectorAll('.tdoc-handoff-details-row[data-comment-id]')]
      .map((row) => {
        const comment = byId.get(row.dataset.commentId);
        if (!comment || !isThreadUnread(comment, readRef.current.seenMap, readRef.current.handoffViewer)) return null;
        return observeVisibleRead(row, () => {
          const current = readRef.current;
          if (isThreadUnread(comment, current.seenMap, current.handoffViewer)) current.onMarkRead?.(comment);
        });
      }).filter(Boolean);
    return () => stops.forEach((stop) => stop());
  }, [open, autoRead, sentRows]);

  const resendOne = async (comment) => {
    if (!comment?.handoff_id || busyId) return;
    setBusyId(comment.id);
    try {
      const body = await resendNotifyHandoff({ slug, handoff_id: comment.handoff_id });
      onToast?.(resendResultText(body), body?.delivery?.status === 'failed');
      await onRefresh?.();
    } catch (err) {
      onToast?.(err.message || 'Could not resend', true);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div ref={panelRef} className="tdoc-handoff-details">
      {sentRows.length || hasUnread ? <>
        <div className="tdoc-handoff-details-header">
          <h3 className="tdoc-handoff-details-section-title">{sentRows.length ? 'Sent to agent' : 'Agent replies'}</h3>
          {hasUnread && onMarkAllRead ? <button type="button" className="tdoc-handoff-details-mark-all" onClick={() => onMarkAllRead()}>Mark all as read</button> : null}
        </div>
        {sentRows.length ? <ul className="tdoc-handoff-details-list">
          {sentRows.map(({ comment, state }) => {
            const waitState = state === 'resolved' ? 'resolved' : handoffWaitState(comment, now);
            const stuck = ['failed', 'stale', 'expired'].includes(waitState);
            const label = state === 'resolved' ? '✅ Done' : compactHandoffText(comment, waitState);
            const pillState = label.startsWith('❓') ? 'question' : label.startsWith('🟡') ? 'partial' : waitState;
            const unread = isThreadUnread(comment, seenMap, handoffViewer);
            const expanded = expandedId === comment.id;
            return (
              <li key={comment.id} className="tdoc-handoff-details-row" data-comment-id={comment.id}>
                <div className="tdoc-handoff-details-main">
                  <div className="tdoc-handoff-details-heading">
                    <button type="button" className="tdoc-handoff-details-jump" onClick={() => { onJump?.(comment.id); onClose(); }}>
                      <span className="tdoc-handoff-details-preview">{shortCommentPreview(comment.text)}</span>
                    </button>
                    <span className={`tdoc-handoff-details-state is-${pillState}`}>
                      {label}
                      {stuck && comment.handoff_resend_allowed !== false ? <>
                        <span aria-hidden="true"> · </span>
                        <button type="button" className="tdoc-handoff-details-resend" disabled={busyId === comment.id} onClick={() => resendOne(comment)}>{busyId === comment.id ? 'Resending…' : 'Resend'}</button>
                      </> : null}
                    </span>
                    {unread && onMarkRead ? (autoRead
                      ? <span className="tdoc-handoff-details-unread-dot" role="status" aria-label="New agent reply" />
                      : <button type="button" className="tdoc-handoff-details-unread-dot" aria-label="Mark as read" title="Mark as read" onClick={() => onMarkRead(comment)} />) : null}
                  </div>
                  <div className="tdoc-handoff-details-meta">
                    <span className="tdoc-handoff-details-recipient">To {readableHandle(comment.handoff_to) || 'agent'}</span>
                    <button type="button" className="tdoc-handoff-details-expand" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : comment.id)}>
                      {expanded ? 'Hide details' : 'Details'}
                    </button>
                  </div>
                  {expanded ? (
                    <div className="tdoc-handoff-details-history">
                      {history(comment).map(([event, at], index) => <div key={`${event}-${index}`}>{event}{eventTime(at) ? ` · ${eventTime(at)}` : ''}</div>)}
                      {latestAgentReply(comment)?.text ? <div>{shortCommentPreview(latestAgentReply(comment).text)}</div> : null}
                      {comment.handoff_delivery?.status === 'failed' ? <div>Delivery failed: {deliveryErrorText(comment.handoff_delivery.error) || 'Unknown reason'}</div> : null}
                        {stuck && onSendElsewhere ? <button type="button" className="tdoc-handoff-details-elsewhere" onClick={() => onSendElsewhere(comment)}>Send to another agent</button> : null}
                        {state === 'resolved' && comment.applied_in && onViewChanges ? <button type="button" className="tdoc-handoff-details-elsewhere" onClick={onViewChanges}>Updated to v{comment.applied_in} · View changes</button> : null}
                    </div>
                  ) : null}
                  {pillState === 'question' && onReply ? <form className="tdoc-handoff-details-reply-form" onSubmit={async (event) => {
                      event.preventDefault();
                      const text = String(replyDrafts[comment.id] || '').trim();
                      if (!text || replyBusy) return;
                      setReplyBusy(comment.id);
                      try {
                        if (await onReply(comment, text)) setReplyDrafts((drafts) => ({ ...drafts, [comment.id]: '' }));
                      } finally { setReplyBusy(null); }
                    }}>
                      <input aria-label={`Reply to agent about ${shortCommentPreview(comment.text)}`} placeholder="Answer your agent…"
                        value={replyDrafts[comment.id] || ''} onChange={(event) => setReplyDrafts((drafts) => ({ ...drafts, [comment.id]: event.target.value }))} />
                      <button type="submit" disabled={!String(replyDrafts[comment.id] || '').trim() || Boolean(replyBusy)}>{replyBusy === comment.id ? 'Sending…' : 'Reply'}</button>
                  </form> : null}
                </div>
              </li>
            );
          })}
        </ul> : null}
      </> : null}
      {showReady && buckets.ready.length ? <section className="tdoc-handoff-ready">
        <h3>Ready to send</h3>
        {buckets.ready.map((comment) => <label key={comment.id} className="tdoc-handoff-ready-row">
          <input type="checkbox" checked={selected.includes(comment.id)} onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...ids, comment.id] : ids.filter((id) => id !== comment.id))} />
          <span>{shortCommentPreview(comment.text)}</span>
        </label>)}
        {selected.length && onSendReady ? (
          <button type="button" className="tdoc-handoff-ready-send" onClick={() => onSendReady(selected)}>
            Send {selected.length} {selected.length === 1 ? 'comment' : 'comments'}
          </button>
        ) : null}
      </section> : null}
      {!sentRows.length && !(showReady && buckets.ready.length) && !hasUnread ? <p className="manage-hint">No agent activity yet.</p> : null}
    </div>
  );
}
