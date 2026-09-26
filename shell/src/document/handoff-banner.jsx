// Top-of-doc handoff status. Aggregates per-comment handoff_at /
// handoff_delivery (from the notify API) into one strip so individual cards
// stay quiet unless something is wrong.

import React, { useMemo, useState } from 'react';
import { resendNotifyHandoff } from './api.js';
import { sendOneCommentToAgent } from './notify-handoff.jsx';

export function formatHandoffAgo(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function agentAlreadyReplied(comment) {
  return (comment?.replies || []).some(
    (r) => r && (r.author?.kind === 'agent' || r.agent_status),
  );
}

function summarize(comments) {
  const sent = (comments || []).filter((c) => c && !c.deleted && c.handoff_status === 'sent');
  if (!sent.length) return null;
  const failed = sent.filter((c) => c.handoff_delivery?.status === 'failed');
  // Drop threads the agent already answered — waiting strip follows the chips.
  const waiting = sent.filter(
    (c) => c.handoff_delivery?.status !== 'failed' && !agentAlreadyReplied(c),
  );
  if (!failed.length && !waiting.length) return null;
  let latestAt = null;
  for (const c of [...waiting, ...failed]) {
    if (!c.handoff_at) continue;
    if (!latestAt || Date.parse(c.handoff_at) > Date.parse(latestAt)) latestAt = c.handoff_at;
  }
  return { sent, failed, waiting, latestAt };
}

export function HandoffBanner({
  slug,
  comments,
  onOpenPanel,
  onRefresh,
  onToast,
}) {
  const summary = useMemo(() => summarize(comments), [comments]);
  const [busy, setBusy] = useState(false);
  if (!summary) return null;

  const { sent, failed, waiting, latestAt } = summary;
  const ago = latestAt ? formatHandoffAgo(latestAt) : '';
  const failedFirst = failed[0];

  const resendFailed = async () => {
    if (!failedFirst?.handoff_id || busy) return;
    setBusy(true);
    try {
      const body = await resendNotifyHandoff({ slug, handoff_id: failedFirst.handoff_id });
      const stillFailed = body?.delivery?.status === 'failed';
      onToast?.(stillFailed ? 'Resend failed to deliver' : 'Resent', stillFailed);
      await onRefresh?.();
    } catch (err) {
      onToast?.(err.message || 'Could not resend', true);
    } finally {
      setBusy(false);
    }
  };

  const sendAgain = async () => {
    if (!waiting.length || busy) return;
    // One "chase" at a time: reopen the newest unanswered comment as a fresh handoff.
    const target = waiting.slice().sort((a, b) => Date.parse(b.handoff_at || 0) - Date.parse(a.handoff_at || 0))[0];
    if (!target?.id) {
      onOpenPanel?.();
      return;
    }
    setBusy(true);
    try {
      const body = await sendOneCommentToAgent(slug, target.id);
      const stillFailed = body?.delivery?.status === 'failed';
      onToast?.(stillFailed
        ? `Sent again — not delivered${body.delivery?.error ? `: ${body.delivery.error}` : ''}`
        : 'Sent again', stillFailed);
      await onRefresh?.();
    } catch (err) {
      onToast?.(err.message || 'Could not send again', true);
    } finally {
      setBusy(false);
    }
  };

  const line = failed.length
    ? `${failed.length} handoff${failed.length === 1 ? '' : 's'} not delivered${ago ? ` · ${ago}` : ''}`
    : `Waiting on agent · ${waiting.length} comment${waiting.length === 1 ? '' : 's'}${ago ? ` · ${ago}` : ''}`;

  return (
    <div className={`tdoc-handoff-banner${failed.length ? ' is-failed' : ''}`} role="status">
      <span className="tdoc-handoff-banner-text">{line}</span>
      <span className="tdoc-handoff-banner-actions">
        {failed.length ? (
          <button type="button" className="text-btn" disabled={busy} onClick={resendFailed}>
            {busy ? 'Resending…' : 'Resend'}
          </button>
        ) : (
          <button type="button" className="text-btn" disabled={busy} onClick={sendAgain}>
            {busy ? 'Sending…' : 'Send again'}
          </button>
        )}
        <button type="button" className="text-btn" onClick={onOpenPanel}>
          Manage
        </button>
      </span>
    </div>
  );
}
