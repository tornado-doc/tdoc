// CI: keep width+notify on same tip.
// Doc-level "send to agent" panel. Uses /api/notify/* (Raft is the first
// provider). Single-comment send reuses postNotifyHandoff with one id.

import React, { useCallback, useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import { AppDialog } from '../ui/dialog.jsx';
import { SegmentedControl } from '../ui/segmented-control.jsx';
import {
  listNotifyHandoffs,
  listNotifyTargets,
  postNotifyHandoff,
  resendNotifyHandoff,
} from './api.js';

function targetLabel(t) {
  if (!t) return '';
  // Prefer the short stable handle; provider display names are often long bios.
  const sub = (t.agent_sub || '').trim();
  const name = (t.agent_name || '').trim();
  return sub || name || 'agent';
}

function targetKey(t) {
  if (!t) return '';
  return `${t.provider}:${t.server_id}:${t.agent_sub}`;
}

function sameTarget(a, b) {
  if (!a || !b) return false;
  return a.provider === b.provider
    && a.server_id === b.server_id
    && a.agent_sub === b.agent_sub;
}

export function useNotifyTargets(slug, enabled) {
  const [state, setState] = useState({
    ready: false,
    available: false,
    default: null,
    candidates: [],
    fallback: null,
    reason: null,
  });

  const refresh = useCallback(async () => {
    if (!enabled || !slug) {
      setState((s) => ({ ...s, ready: true, available: false, reason: null }));
      return;
    }
    try {
      const body = await listNotifyTargets(slug);
      setState({
        ready: true,
        available: true,
        default: body.default || null,
        candidates: Array.isArray(body.candidates) ? body.candidates : [],
        fallback: body.fallback || null,
        reason: body.reason || null,
      });
    } catch (err) {
      // 404 = worker stub not shipped yet; hide the panel rather than alarm.
      setState({
        ready: true,
        available: err.status !== 404,
        default: null,
        candidates: [],
        fallback: null,
        reason: null,
      });
    }
  }, [slug, enabled]);

  useEffect(() => { refresh(); }, [refresh]);
  return { ...state, refresh };
}

function noAgentBoundReason(reason) {
  return reason === 'no_agent_bound'
    ? 'No agent is following this doc yet, so there is nowhere to send.'
    : null;
}

export function NotifyHandoffPanel({
  slug,
  open,
  onClose,
  commentIds,
  onSent,
}) {
  const targets = useNotifyTargets(slug, open);
  const [selected, setSelected] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    if (!open) return;
    setSelected(targets.default);
    setInstruction('');
    setStatus('');
  }, [open, targets.default]);

  useEffect(() => {
    if (!open || !targets.available) return undefined;
    let cancelled = false;
    listNotifyHandoffs(slug, 5)
      .then((body) => {
        if (!cancelled) setRecent(Array.isArray(body.handoffs) ? body.handoffs : []);
      })
      .catch(() => { if (!cancelled) setRecent([]); });
    return () => { cancelled = true; };
  }, [open, slug, targets.available]);

  const choices = [];
  if (targets.default) choices.push(targets.default);
  for (const c of targets.candidates) {
    if (!choices.some((x) => sameTarget(x, c))) choices.push(c);
  }
  if (targets.fallback && !choices.some((x) => sameTarget(x, targets.fallback))) {
    choices.push(targets.fallback);
  }

  const ids = Array.isArray(commentIds) ? commentIds.filter(Boolean) : [];
  const boundHint = noAgentBoundReason(targets.reason);
  const canSubmit = !busy && ids.length > 0 && choices.length > 0 && (selected || targets.default);
  const selectedKey = targetKey(selected || targets.default);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setStatus('');
    try {
      const body = await postNotifyHandoff({
        slug,
        comment_ids: ids,
        instruction: instruction.trim(),
        recipient: selected || undefined,
      });
      const failed = body?.delivery?.status === 'failed';
      setStatus(failed
        ? `Sent ${body.sent || ids.length} — not delivered${body.delivery?.error ? `: ${body.delivery.error}` : ''}`
        : `Sent ${body.sent || ids.length} to agent`);
      if (onSent) onSent(body);
      try {
        const next = await listNotifyHandoffs(slug, 5);
        setRecent(Array.isArray(next.handoffs) ? next.handoffs : []);
      } catch { /* ignore */ }
    } catch (err) {
      setStatus(err.message || 'Could not send');
    } finally {
      setBusy(false);
    }
  };

  const resend = async (handoffId) => {
    setBusy(true);
    setStatus('');
    try {
      const body = await resendNotifyHandoff({ slug, handoff_id: handoffId });
      const failed = body?.delivery?.status === 'failed';
      setStatus(failed ? 'Resend failed to deliver' : 'Resent');
      if (onSent) onSent(body);
    } catch (err) {
      setStatus(err.message || 'Could not resend');
    } finally {
      setBusy(false);
    }
  };

  const last = recent[0];
  const lastFailed = last?.delivery?.status === 'failed';
  const unavailable = targets.ready && !targets.available;

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Send to agent"
      description={unavailable
        ? 'Notify is not available on this host yet.'
        : (ids.length === 1
          ? 'Sending 1 comment. One recipient per handoff.'
          : `Sending ${ids.length || 0} open comments. One recipient per handoff.`)}
      actions={(
        <>
          <button type="button" onClick={onClose}>Close</button>
          {!unavailable ? (
            <button
              type="button"
              className="primary"
              disabled={!canSubmit}
              title={!choices.length ? (boundHint || 'No agent to send to') : undefined}
              onClick={submit}
            >
              {busy ? 'Sending…' : 'Send'}
            </button>
          ) : null}
        </>
      )}
    >
      {unavailable ? null : (
        <>
          {last ? (
            <p className="manage-hint">
              Last handoff: {(last.comment_ids || []).length} comment{(last.comment_ids || []).length === 1 ? '' : 's'}
              {lastFailed ? ' · not delivered' : ''}
              {lastFailed && last.handoff_id ? (
                <>
                  {' · '}
                  <button type="button" className="text-btn" disabled={busy} onClick={() => resend(last.handoff_id)}>
                    Resend
                  </button>
                </>
              ) : null}
            </p>
          ) : null}

          {choices.length === 1 ? (
            <section className="manage-section">
              <p className="tdoc-notify-recipient" aria-label="Recipient">
                <span className="tdoc-notify-recipient-avatar" aria-hidden="true">
                  <Bot size={16} strokeWidth={2} />
                </span>
                <span>
                  Hand to
                  {' '}
                  <strong title={(choices[0].agent_name || '').trim() || undefined}>
                    {targetLabel(choices[0])}
                  </strong>
                </span>
              </p>
            </section>
          ) : choices.length > 1 ? (
            <section className="manage-section">
              <label className="field">Recipient</label>
              <SegmentedControl
                ariaLabel="Recipient"
                value={selectedKey}
                options={choices.map((t) => ({
                  value: targetKey(t),
                  label: (
                    <span className="tdoc-notify-recipient-opt" title={(t.agent_name || '').trim() || undefined}>
                      <Bot size={14} strokeWidth={2} aria-hidden="true" />
                      {targetLabel(t)}
                    </span>
                  ),
                }))}
                onChange={(key) => {
                  const next = choices.find((t) => targetKey(t) === key);
                  if (next) setSelected(next);
                }}
              />
            </section>
          ) : (
            <p className="manage-hint" title={boundHint || undefined}>
              {boundHint || 'No agent has touched this doc yet. Pick one after an agent publishes or replies.'}
            </p>
          )}

          <label className="field" htmlFor="tdoc-notify-instruction">Instruction</label>
          <textarea
            id="tdoc-notify-instruction"
            className="tdoc-notify-instruction"
            rows={2}
            maxLength={500}
            placeholder="A line for the agent…"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />

          <p className="status" role="status">{status || '\u00a0'}</p>
        </>
      )}
    </AppDialog>
  );
}

export async function sendOneCommentToAgent(slug, commentId) {
  return postNotifyHandoff({ slug, comment_ids: [commentId], instruction: '' });
}
