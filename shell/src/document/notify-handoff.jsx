// CI: keep width+notify on same tip.
// Doc-level "send to agent" panel. Uses /api/notify/* (Raft is the first
// provider). Single-comment send reuses postNotifyHandoff with one id.

import React, { useCallback, useEffect, useState } from 'react';
import { RaftMark } from '../agent-marks.jsx';
import { AppDialog } from '../ui/dialog.jsx';
import { SegmentedControl } from '../ui/segmented-control.jsx';
import {
  listNotifyHandoffs,
  listNotifyTargets,
  postNotifyHandoff,
  resendNotifyHandoff,
} from './api.js';

function opaqueAgentId(s) {
  if (!s) return true;
  // Raft `sub` is often a UUID / long hex — fine as a key, useless as a label.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[0-9a-f]{24,}$/i.test(s)) return true;
  return false;
}

function shortAgentName(name) {
  // "handle — bio…" / "handle - bio…" → keep the handle side.
  const cut = name.split(/\s+[—–-]\s+/)[0].trim();
  return (cut || name).slice(0, 48);
}

// Readable agent handle when we have one. Empty is fine — the UI falls back
// to the provider line so we never render "Hand to " with a blank.
function readableHandle(t) {
  if (!t) return '';
  const name = (t.agent_name || '').trim();
  const sub = (t.agent_sub || '').trim();
  if (name && !opaqueAgentId(name)) return shortAgentName(name);
  if (sub && !opaqueAgentId(sub)) return sub;
  return '';
}

function providerMeta(t) {
  const p = String(t?.provider || 'raft').trim().toLowerCase();
  if (p === 'raft') {
    return { key: 'raft', label: 'Raft', mark: 'raft' };
  }
  return { key: p || 'agent', label: p ? p[0].toUpperCase() + p.slice(1) : 'agent', mark: '' };
}

// What the reader needs: where this goes (provider), not which UUID. Handle is
// secondary detail when we have a readable one.
function recipientPrimary(t) {
  const { label } = providerMeta(t);
  return readableHandle(t)
    ? `Send to ${label}`
    : `Send to your ${label} agent`;
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

function ProviderMark({ target, size = 18 }) {
  const meta = providerMeta(target);
  if (meta.mark === 'raft') return <RaftMark size={size} />;
  return <span className="tdoc-notify-provider-fallback" aria-hidden="true">{meta.label.slice(0, 1)}</span>;
}

function RecipientLine({ target }) {
  const handle = readableHandle(target);
  const primary = recipientPrimary(target);
  return (
    <p className="tdoc-notify-recipient" aria-label="Recipient">
      <span className="tdoc-notify-recipient-avatar" aria-hidden="true">
        <ProviderMark target={target} size={18} />
      </span>
      <span className="tdoc-notify-recipient-copy">
        <strong>{primary}</strong>
        {handle ? <span className="tdoc-notify-recipient-handle">{handle}</span> : null}
      </span>
    </p>
  );
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

function noRecipientHint(reason) {
  if (reason === 'no_raft_link' || reason === 'no_agent_bound') {
    // no_agent_bound is the pre-rename wire value; treat it the same.
    return 'This needs a Raft agent linked to your account. Connect one (paste the /setup line into your agent), then come back.';
  }
  return null;
}

function defaultInstruction(commentIds) {
  const n = Array.isArray(commentIds) ? commentIds.filter(Boolean).length : 0;
  return n === 1 ? 'address this comment' : 'address my new comments';
}

function isDefaultInstruction(text) {
  return text === 'address this comment' || text === 'address my new comments';
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
  const [instruction, setInstruction] = useState(() => defaultInstruction(commentIds));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    if (!open) return;
    setSelected(targets.default);
  }, [open, targets.default]);

  useEffect(() => {
    if (!open) return;
    setInstruction(defaultInstruction(commentIds));
    setStatus('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- only reset when the dialog opens

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
  const emptyHint = noRecipientHint(targets.reason);
  const canSubmit = !busy && ids.length > 0 && choices.length > 0 && (selected || targets.default);
  const selectedKey = targetKey(selected || targets.default);
  const sendBlockedTitle = !choices.length
    ? (emptyHint || 'No agent to send to')
    : (!ids.length ? 'No open comments to send' : undefined);

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
              title={sendBlockedTitle}
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
              <RecipientLine target={choices[0]} />
            </section>
          ) : choices.length > 1 ? (
            <section className="manage-section">
              <label className="field">Send via</label>
              <SegmentedControl
                ariaLabel="Recipient"
                value={selectedKey}
                options={choices.map((t) => {
                  const handle = readableHandle(t);
                  const meta = providerMeta(t);
                  return {
                    value: targetKey(t),
                    label: (
                      <span className="tdoc-notify-recipient-opt" title={handle || undefined}>
                        <ProviderMark target={t} size={16} />
                        {handle || meta.label}
                      </span>
                    ),
                  };
                })}
                onChange={(key) => {
                  const next = choices.find((t) => targetKey(t) === key);
                  if (next) setSelected(next);
                }}
              />
            </section>
          ) : !targets.ready ? (
            <p className="manage-hint">Looking up recipients…</p>
          ) : (
            <p className="manage-hint" role="status">
              {emptyHint
                || 'No agent has touched this doc yet. Pick one after an agent publishes or replies.'}
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
            onFocus={(e) => {
              // Default is a starter, not locked copy — select it so the first
              // key replaces instead of forcing a delete-then-type.
              if (isDefaultInstruction(instruction)) e.target.select();
            }}
          />

          <p className="status" role="status">{status || '\u00a0'}</p>
        </>
      )}
    </AppDialog>
  );
}

export async function sendOneCommentToAgent(slug, commentId) {
  return postNotifyHandoff({
    slug,
    comment_ids: [commentId],
    instruction: 'address this comment',
  });
}
