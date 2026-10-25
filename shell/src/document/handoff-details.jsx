// One place to inspect sent comments and send selected unsent comments.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { deliveryErrorText, readableHandle, resendResultText } from './notify-handoff.jsx';
import { compactHandoffText } from './handoff-status-line.jsx';
import { resendNotifyHandoff } from './api.js';
import { isThreadUnread } from './thread-seen.js';
import { handoffActivityAt, handoffWaitState, shortCommentPreview, summarizeHandoffSurfaces } from './handoff-state.js';

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
  slug, open, onClose, comments, seenMap = {}, currentUser = '', onJump, onRefresh, onToast, onSendReady, onSendElsewhere,
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
  const [selectedIds, setSelectedIds] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  const wasOpen = useRef(false);
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
    <div className="tdoc-handoff-details">
      {sentRows.length ? <>
        <h3 className="tdoc-handoff-details-section-title">Sent to agent</h3>
        <ul className="tdoc-handoff-details-list">
          {sentRows.map(({ comment, state }) => {
            const waitState = state === 'resolved' ? 'resolved' : handoffWaitState(comment, now);
            const stuck = ['failed', 'stale', 'expired'].includes(waitState);
            const label = state === 'resolved' ? '✅ Done' : compactHandoffText(comment, waitState);
            const pillState = label.startsWith('❓') ? 'question' : label.startsWith('🟡') ? 'partial' : waitState;
            const unread = isThreadUnread(comment, seenMap, currentUser);
            const expanded = expandedId === comment.id;
            return (
              <li key={comment.id} className="tdoc-handoff-details-row">
                <div className="tdoc-handoff-details-main">
                  <div className="tdoc-handoff-details-heading">
                    <button type="button" className="tdoc-handoff-details-jump" onClick={() => { onJump?.(comment.id); onClose(); }}>
                      <span className="tdoc-handoff-details-preview">{shortCommentPreview(comment.text)}</span>
                    </button>
                    <span className={`tdoc-handoff-details-state is-${pillState}`}>
                      {label}
                      {stuck ? <>
                        <span aria-hidden="true"> · </span>
                        <button type="button" className="tdoc-handoff-details-resend" disabled={busyId === comment.id} onClick={() => resendOne(comment)}>{busyId === comment.id ? 'Resending…' : 'Resend'}</button>
                      </> : null}
                    </span>
                    {unread ? <span className="tdoc-handoff-details-unread-dot" role="status" aria-label="New agent reply" /> : null}
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
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </> : null}
      {buckets.ready.length ? <section className="tdoc-handoff-ready">
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
      {!sentRows.length && !buckets.ready.length ? <p className="manage-hint">No agent activity yet.</p> : null}
    </div>
  );
}
