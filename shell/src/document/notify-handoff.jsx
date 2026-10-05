// CI: keep width+notify on same tip.
// Doc-level "send to agent" panel. Uses /api/notify/* (Raft is the first
// provider). Single-comment send reuses postNotifyHandoff with one id.

import React, { useCallback, useEffect, useState } from 'react';
import { Webhook } from 'lucide-react';
import { RaftMark } from '../agent-marks.jsx';
import { AppDialog } from '../ui/dialog.jsx';
import { CopyPromptButton } from '../ui/copy-prompt-button.jsx';
import {
  hasAccountSession,
  listNotifyHandoffs,
  listNotifyTargets,
  postNotifyHandoff,
  resendNotifyHandoff,
  setRaftFallbackAgent,
  tdocUrl,
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
export function readableHandle(t) {
  if (!t) return '';
  const name = (t.agent_name || '').trim();
  const sub = (t.agent_sub || '').trim();
  if (name && !opaqueAgentId(name)) return shortAgentName(name);
  if (sub && !opaqueAgentId(sub)) return sub;
  return '';
}

export function providerMeta(t) {
  const p = String(t?.provider || 'raft').trim().toLowerCase();
  if (p === 'raft') {
    return { key: 'raft', label: 'Raft', mark: 'raft' };
  }
  if (p === 'webhook') {
    return { key: 'webhook', label: 'Webhook', mark: 'webhook' };
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

// One line per agent in the recipient dropdown: who, where, and why it is the
// preselected one (last worked on this doc, or the account default).
function recipientOptionLabel(t, preselected) {
  const { label } = providerMeta(t);
  const who = readableHandle(t) || `${label} agent`;
  const where = t.provider === 'raft' && t.server_slug ? ` · ${t.server_slug}` : (t.provider === 'raft' ? '' : ` · ${label}`);
  const why = sameTarget(t, preselected)
    ? (t.source === 'doc' ? ' (last worked on this doc)' : ' (default)')
    : '';
  return `${who}${where}${why}`;
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

export function ProviderMark({ target, size = 18 }) {
  const meta = providerMeta(target);
  if (meta.mark === 'raft') return <RaftMark size={size} />;
  if (meta.mark === 'webhook') return <Webhook size={size} aria-hidden="true" />;
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

// Delivery errors in words a person can act on. The codes come from the
// providers (worker NOTIFY_PROVIDERS); "request_404" told nobody anything.
export function deliveryErrorText(code) {
  const c = String(code || '');
  if (!c) return '';
  if (c === 'no_recipient') return 'no agent is connected';
  if (c === 'provider_not_configured') return 'Raft is not set up on this host';
  if (c === 'target_missing_server_slug') return "this agent's Raft server is unknown; connect it again";
  if (/^request_40[13]$/.test(c)) return 'Raft refused; the tdoc app may not be installed on that server';
  if (c === 'request_404') return "Raft couldn't find that agent on its server";
  if (/^token_/.test(c)) return "Raft didn't grant access to that agent";
  if (/^event_/.test(c)) return "Raft didn't accept the message";
  if (c === 'webhook_timeout') return "the webhook didn't answer within 8 seconds";
  if (c === 'webhook_secret_missing') return 'this webhook needs to be added again';
  const m = c.match(/^webhook_(\d{3})$/);
  if (m) return `the webhook answered ${m[1]}`;
  return c;
}

// What a person pastes into their own agent when none is linked to their
// tdoc account yet: the agent runs the link ceremony (bin/tdoc-connect-agent).
export const CONNECT_AGENT_PROMPT = 'Connect yourself to my tdoc account so I can hand you comments from tdoc: use the tdoc skill and run bin/tdoc-connect-agent.';

// Ways an agent can be reached from tdoc. Raft is the only one today; the
// next connector is one more entry here (name, what it is, how to connect),
// and the Send to agent panel lists whatever is in it when nothing is
// connected yet.
export const AGENT_CONNECTORS = [
  {
    id: 'raft',
    featured: true,
    name: 'Raft agent',
    blurb: 'Sign in with Raft once; every agent on that server gets the comments on the docs it writes.',
    action: { label: 'Connect with Raft', href: '/api/me/connectors/raft/start' },
    prompt: CONNECT_AGENT_PROMPT,
  },
  {
    id: 'webhook',
    name: 'Webhook',
    blurb: 'Any bot or service that can receive an HTTPS POST. No Raft needed.',
    action: { label: 'Add a webhook', href: '/me/agents?tab=send' },
  },
];

// A connector card's head: its logo, its name, Recommended on the featured
// one. Shared by the dialog and the Agents page, so both browse the same list.
// The one way to start a Raft connection, wherever it is offered: Raft's
// mark on Raft's black, so it reads as "sign in with Raft" at a glance.
export function RaftConnectButton({ label = 'Connect with Raft', onConnected = null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connect = (event) => {
    if (!onConnected) return;
    event.preventDefault();
    if (busy) return;
    setError('');
    const popup = window.open(
      tdocUrl('/api/me/connectors/raft/start?popup=1'),
      'tdoc-raft-connect',
      'popup,width=560,height=720,resizable=yes,scrollbars=yes',
    );
    if (!popup) {
      setError('Allow the Raft sign-in popup, then try again.');
      return;
    }
    setBusy(true);
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', receive);
      window.clearInterval(closedTimer);
      setBusy(false);
      try { await onConnected(); } catch { setError('Connected, but this document could not refresh. Close and reopen Send to agent.'); }
    };
    const receive = (message) => {
      if (message.source !== popup || message.data?.type !== 'tdoc:raft-connected') return;
      finish();
    };
    window.addEventListener('message', receive);
    const closedTimer = window.setInterval(() => {
      if (!popup.closed) return;
      finish();
    }, 500);
  };
  return (
    <>
      <a className="tdoc-raft-btn" href="/api/me/connectors/raft/start" onClick={connect} aria-disabled={busy || undefined}>
        <RaftMark size={18} />
        <span>{busy ? 'Connecting…' : label}</span>
      </a>
      {error ? <p className="status" role="status">{error}</p> : null}
    </>
  );
}

export function ConnectorHead({ connector }) {
  return (
    <div className="tdoc-connector-head">
      <span className="tdoc-connector-logo"><ProviderMark target={{ provider: connector.id }} size={22} /></span>
      <span className="tdoc-connector-title">
        <strong>{connector.name}</strong>
        {connector.featured ? <span className="tdoc-connector-badge">Recommended</span> : null}
        <span className="muted">{connector.blurb}</span>
      </span>
    </div>
  );
}

// A Raft server is connected but tdoc knows no agent on it yet (none has
// published or replied with this account). Raft delivers by handle, so ask
// for one instead of offering Connect with Raft again.
//
// `known` are the agents tdoc has seen on this server (they published or
// replied with this account): picked from a dropdown. Raft has no roster API
// tdoc can read, so anyone else is typed by handle.
const OTHER_AGENT = '__other__';
export function RaftFallbackForm({ server, known = [], current = null, onSaved }) {
  const [pick, setPick] = useState(() => (current && current.agent_sub) || (known[0] && known[0].agent_sub) || OTHER_AGENT);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const typing = pick === OTHER_AGENT || !known.length;
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = await setRaftFallbackAgent(typing
        ? { server_id: server.server_id, agent_name: name.trim() }
        : { server_id: server.server_id, agent_sub: pick });
      setName('');
      if (onSaved) await onSaved(body.target);
    } catch (err) {
      setError(err.status === 400 ? 'Use the agent\'s Raft handle, one word, like @my-agent.' : (err.message || 'Could not save'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="tdoc-conn-form" onSubmit={save}>
      {known.length ? (
        <label>
          <span>Default agent on {server.server_slug || 'this server'}</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            {known.map((a) => <option key={a.agent_sub} value={a.agent_sub}>{readableHandle(a) || a.agent_sub}</option>)}
            <option value={OTHER_AGENT}>Another agent…</option>
          </select>
        </label>
      ) : null}
      {typing ? (
        <label>
          <span>{known.length ? 'Its Raft handle' : `Default agent on ${server.server_slug || 'this server'} (its Raft handle)`}</span>
          <input type="text" required placeholder="@agent-handle" value={name} onChange={(e) => setName(e.target.value)} maxLength={81} />
        </label>
      ) : null}
      <button type="submit" className="tdoc-fbspace-btn primary" disabled={busy || (typing && !name.trim()) || (!typing && current && current.agent_sub === pick)}>{busy ? 'Saving…' : 'Save'}</button>
      {error ? <p className="status" role="status">{error}</p> : null}
    </form>
  );
}

function RaftConnectedNoAgentView({ servers, onClose, onSaved }) {
  const slugs = servers.map((sv) => sv.server_slug || 'a server').join(', ');
  const canEdit = hasAccountSession();
  return (
    <AppDialog
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Which agent should get these?"
      description={`Raft is connected (${slugs}), but no agent on it has worked with tdoc yet, so there is nobody to send to. Name the agent that should get comments; agents that publish or reply later take over their own docs automatically.`}
      actions={<button type="button" onClick={onClose}>Close</button>}
    >
      <div className="tdoc-connectors">
        {canEdit
          ? servers.map((sv) => <RaftFallbackForm key={sv.server_id} server={sv} onSaved={onSaved} />)
          : <a className="tdoc-connector-action" href={tdocUrl('/me/agents?tab=send')} target="_blank" rel="noreferrer">Choose an agent on the Agents page</a>}
        <p className="manage-hint">Or have the agent run the connect prompt itself:</p>
        <code>{CONNECT_AGENT_PROMPT}</code>
      </div>
    </AppDialog>
  );
}

function ConnectAgentView({ onClose, onConnected }) {
  return (
    <AppDialog
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Connect an agent"
      description="Nothing is connected yet, so there is nowhere to send these. Connect once; after that Send to agent and @agent hand comments straight to it."
      actions={<button type="button" onClick={onClose}>Close</button>}
    >
      <div className="tdoc-connectors">
        {AGENT_CONNECTORS.map((c) => (
          <section key={c.id} className="tdoc-connector">
            <ConnectorHead connector={c} />
            {c.id === 'raft'
              ? <RaftConnectButton onConnected={onConnected} />
              : <a className="tdoc-connector-action" href={c.action.href}>{c.action.label}</a>}
            {c.prompt ? (
              <details open>
                <summary className="manage-hint">Or paste this into your agent</summary>
                <code>{c.prompt}</code>
                <CopyPromptButton text={c.prompt} />
              </details>
            ) : null}
          </section>
        ))}
        <p className="manage-hint">Manage connections any time on the <a href="/me/agents?tab=send">Agents</a> page.</p>
      </div>
    </AppDialog>
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
    raftServers: [],
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
        raftServers: Array.isArray(body.raft_servers) ? body.raft_servers : [],
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
        raftServers: [],
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
  onTargetsChanged,
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
        ? `Sent ${body.sent || ids.length} — not delivered${body.delivery?.error ? `: ${deliveryErrorText(body.delivery.error)}` : ''}`
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

  // Nobody connected: the panel's job becomes getting one connected, instead
  // of a Send button that cannot go anywhere.
  if (open && targets.ready && targets.available && (targets.reason === 'no_agent_bound' || !choices.length)) {
    if (targets.raftServers.length) {
      return (
        <RaftConnectedNoAgentView
          servers={targets.raftServers}
          onClose={onClose}
          onSaved={async () => { await targets.refresh(); if (onTargetsChanged) await onTargetsChanged(); }}
        />
      );
    }
    return (
      <ConnectAgentView
        onClose={onClose}
        onConnected={async () => { await targets.refresh(); if (onTargetsChanged) await onTargetsChanged(); }}
      />
    );
  }

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
              <RecipientLine target={choices[0]} />
            </section>
          ) : choices.length > 1 ? (
            <section className="manage-section">
              <RecipientLine target={selected || targets.default} />
              <label className="field" htmlFor="tdoc-notify-recipient">Send to</label>
              <select
                id="tdoc-notify-recipient"
                value={selectedKey}
                onChange={(e) => {
                  const next = choices.find((t) => targetKey(t) === e.target.value);
                  if (next) setSelected(next);
                }}
              >
                {choices.map((t) => (
                  <option key={targetKey(t)} value={targetKey(t)}>{recipientOptionLabel(t, targets.default)}</option>
                ))}
              </select>
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
