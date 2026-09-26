// Per-comment handoff details: status + short preview + jump to the card.
// Replaces the old "Manage" entry that was an alias for Send to agent.

import React, { useMemo, useState } from 'react';
import { AppDialog } from '../ui/dialog.jsx';
import { postNotifyHandoff, resendNotifyHandoff } from './api.js';
import { formatHandoffAgo } from './handoff-ago.js';
import {
  shortCommentPreview,
  summarizeHandoffSurfaces,
} from './handoff-state.js';

const STATE_LABEL = {
  ready: 'Ready to send',
  failed: 'Not delivered',
  waiting: 'Waiting on agent',
  replied: 'Agent replied',
};

function rowMeta(comment, state) {
  if (state === 'waiting' || state === 'failed') {
    const ago = comment.handoff_at ? formatHandoffAgo(comment.handoff_at) : '';
    return ago || null;
  }
  return null;
}

export function HandoffDetailsPanel({
  slug,
  open,
  onClose,
  comments,
  onJump,
  onRefresh,
  onToast,
}) {
  const buckets = useMemo(() => summarizeHandoffSurfaces(comments), [comments]);
  const rows = useMemo(() => {
    // In-flight first, then ready, then replied — matches what the banner cares about.
    const order = ['failed', 'waiting', 'ready', 'replied'];
    const out = [];
    for (const state of order) {
      for (const c of buckets[state]) out.push({ comment: c, state });
    }
    return out;
  }, [buckets]);
  const [busyId, setBusyId] = useState(null);

  const sendOne = async (comment) => {
    if (!comment?.id || busyId) return;
    setBusyId(comment.id);
    try {
      const body = await postNotifyHandoff({
        slug,
        comment_ids: [comment.id],
        instruction: 'address this comment',
      });
      const failed = body?.delivery?.status === 'failed';
      onToast?.(failed
        ? `Sent — not delivered${body.delivery?.error ? `: ${body.delivery.error}` : ''}`
        : 'Sent to agent', failed);
      await onRefresh?.();
    } catch (err) {
      onToast?.(err.message || 'Could not send', true);
    } finally {
      setBusyId(null);
    }
  };

  const resendOne = async (comment) => {
    if (!comment?.handoff_id || busyId) return;
    setBusyId(comment.id);
    try {
      const body = await resendNotifyHandoff({ slug, handoff_id: comment.handoff_id });
      const failed = body?.delivery?.status === 'failed';
      onToast?.(failed ? 'Resend failed to deliver' : 'Resent', failed);
      await onRefresh?.();
    } catch (err) {
      onToast?.(err.message || 'Could not resend', true);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Handoff details"
      description={rows.length
        ? `${rows.length} comment${rows.length === 1 ? '' : 's'} on this surface`
        : 'Nothing in flight or waiting to send.'}
      actions={<button type="button" onClick={onClose}>Close</button>}
    >
      {rows.length ? (
        <ul className="tdoc-handoff-details-list">
          {rows.map(({ comment, state }) => {
            const meta = rowMeta(comment, state);
            const busy = busyId === comment.id;
            return (
              <li key={comment.id} className="tdoc-handoff-details-row">
                <button
                  type="button"
                  className="tdoc-handoff-details-jump"
                  onClick={() => {
                    onJump?.(comment.id);
                    onClose();
                  }}
                >
                  <span className={`tdoc-handoff-details-state is-${state}`}>
                    {STATE_LABEL[state] || state}
                    {meta ? ` · ${meta}` : ''}
                  </span>
                  <span className="tdoc-handoff-details-preview">
                    {shortCommentPreview(comment.text)}
                  </span>
                </button>
                <span className="tdoc-handoff-details-actions">
                  {state === 'failed' ? (
                    <button
                      type="button"
                      className="text-btn"
                      disabled={busy}
                      onClick={() => resendOne(comment)}
                    >
                      {busy ? 'Resending…' : 'Resend'}
                    </button>
                  ) : null}
                  {state === 'ready' ? (
                    <button
                      type="button"
                      className="text-btn"
                      disabled={busy}
                      onClick={() => sendOne(comment)}
                    >
                      {busy ? 'Sending…' : 'Send'}
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="manage-hint">No handoff activity on open comments.</p>
      )}
    </AppDialog>
  );
}

