// CI: keep width+notify on same tip.
// Doc-level "send to agent" panel. Uses /api/notify/* (Raft is the first
// provider). Single-comment send reuses postNotifyHandoff with one id.

import React, { useCallback, useEffect, useState } from 'react';
import { Terminal, Webhook } from 'lucide-react';
import { AskIcon } from '../ui/ask-icon.jsx';
import { ClaudeMark, OpenAIMark, RaftMark } from '../agent-marks.jsx';
import { AppDialog } from '../ui/dialog.jsx';
import { CopyPromptButton } from '../ui/copy-prompt-button.jsx';
import { AppCombobox } from '../ui/combobox.jsx';
import {
  getRaftConnectAttempt,
  hasAccountSession,
  listNotifyHandoffs,
  listNotifyTargets,
  postNotifyHandoff,
  resendNotifyHandoff,
  setRaftFallbackAgent,
  tdocUrl,
} from './api.js';
import { agentCli, agentDisplayName, orderedAgentChoices, providerMeta, readableHandle, sameTarget, targetKey } from './agent-choices.js';

export { providerMeta, readableHandle };

// What the reader needs: where this goes (provider), not which UUID. Handle is
// secondary detail when we have a readable one.
function recipientPrimary(t) {
  if (t && t.team_agent) return 'Send to team agent';
  const { label } = providerMeta(t);
  return readableHandle(t)
    ? `Send to ${label}`
    : `Send to your ${label} agent`;
}

// One line per agent in the recipient dropdown: who, where, and why it is the
// preselected one, when this doc has evidence for it.
// One row of an agent picker: the name to search by, and on the right why it
// is near the top -- it is this doc's agent, the default, or it was used
// recently. Directory agents that never worked with tdoc carry no note.
// `list` is the picker's whole list: a label repeats where the agent runs
// only when another row would otherwise read the same.
// Every row says whose agent it is -- the team's, or the viewer's own -- and
// the one that wrote the latest version says so (it is the default).
export function recipientOption(t, preselected, list = null) {
  const why = agentDown(t)
    ? (t.provider === 'local' ? localSeenText(t) : `${t.status} in Raft`)
    : t.last_writer ? 'edited last'
      : sameTarget(t, preselected)
        ? 'last handoff on this doc'
        : (t.last_touched ? `used ${sinceText(t.last_touched)}` : '');
  const whose = t.tdoc_ai ? '' : t.team_agent ? 'Team' : 'Mine';
  return { value: targetKey(t), label: agentDisplayName(t, list), hint: [whose, why].filter(Boolean).join(' · '), whose };
}

// Raft's directory says this agent is not running (worker raftDirectoryAgents,
// read with the picker's own list). Sending still works; it just will not be
// picked up until someone starts the agent.
export function agentDown(t) {
  return !!t && (t.status === 'stopped' || t.status === 'inactive');
}

// A local agent is reachable exactly when its daemon has checked in lately;
// the worker stamps last_seen from the daemon's polls (at most every 10 min).
export function localSeenText(t) {
  if (!t || t.provider !== 'local') return '';
  if (!t.last_seen) return 'daemon not seen yet';
  return t.status === 'inactive' ? `daemon not seen since ${sinceText(t.last_seen)}` : `seen ${sinceText(t.last_seen)}`;
}

// "smarter-tdoc-claw", or "your Raft agent" when the handle is unreadable.
function agentLabel(t) {
  if (t && t.team_agent && t.team_agent.name) return t.team_agent.name;
  return readableHandle(t) || `your ${providerMeta(t).label} agent`;
}

function sinceText(iso) {
  const ms = Date.now() - Date.parse(iso || '');
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function ProviderMark({ target, size = 18 }) {
  if (target && target.tdoc_ai) return <AskIcon size={size} />;
  const meta = providerMeta(target);
  if (meta.mark === 'raft') return <RaftMark size={size} />;
  if (meta.mark === 'webhook') return <Webhook size={size} aria-hidden="true" />;
  if (meta.mark === 'local') {
    // A local agent wears its program's mark; an unknown CLI, a terminal.
    const cli = agentCli(target);
    if (cli === 'claude') return <ClaudeMark size={size} />;
    if (cli === 'codex') return <OpenAIMark size={size} />;
    return <Terminal size={size} aria-hidden="true" />;
  }
  return <span className="tdoc-notify-provider-fallback" aria-hidden="true">{meta.label.slice(0, 1)}</span>;
}

function RecipientLine({ target }) {
  const handle = agentDisplayName(target);
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
  if (c === 'agent_run_failed') return 'the local agent run failed (see ~/.tdoc/daemon/daemon.log on that computer); Resend queues it again';
  const m = c.match(/^webhook_(\d{3})$/);
  if (m) return `the webhook answered ${m[1]}`;
  return c;
}

// The toast after Resend. Raft drops a resend it already holds (same event
// id), and saying "Resent" then would promise a second nudge that never went.
export function resendResultText(body) {
  const d = body?.delivery;
  if (d?.status === 'failed') return `Resend failed${d.error ? `: ${deliveryErrorText(d.error)}` : ''}`;
  if (d?.deduped) return 'Already queued in Raft — not sent twice';
  return 'Resent';
}

// What a person pastes into their own agent when none is linked to their
// tdoc account yet: the agent runs the link ceremony (bin/tdoc-connect-agent).
export const CONNECT_AGENT_PROMPT = 'Connect yourself to my tdoc account so I can hand you comments from tdoc: use the tdoc skill and run bin/tdoc-connect-agent.';

// Ways an agent can be reached from tdoc. Raft is the only one today; the
// next connector is one more entry here (name, what it is, how to connect),
// and the Send to agent panel lists whatever is in it when nothing is
// connected yet.
// What a person pastes into Claude Code or Codex on their own computer: the
// agent starts the daemon (bin/tdoc-daemon), which registers that computer.
export const LOCAL_DAEMON_PROMPT = 'Set up the tdoc agent daemon on this computer so Claude Code or Codex picks up comments I send to it, now and after login, without Raft: use the tdoc skill and run bin/tdoc-daemon install (on Linux, run bin/tdoc-daemon start in a terminal instead).';

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
    id: 'local',
    name: 'Local agent',
    blurb: 'Claude Code or Codex on your own computer. A small daemon picks up comments while it runs; nothing to host.',
    action: { label: 'Set up', href: '/me?view=settings#agents' },
    prompt: LOCAL_DAEMON_PROMPT,
  },
  {
    id: 'webhook',
    name: 'Webhook',
    blurb: 'Any bot or service that can receive an HTTPS POST. No Raft needed.',
    action: { label: 'Add a webhook', href: '/me?view=settings#agents' },
  },
];

// A connector card's head: its logo, its name, Recommended on the featured
// one. Shared by the dialog and the Agents page, so both browse the same list.
// The one way to start a Raft connection, wherever it is offered: Raft's
// mark on Raft's black, so it reads as "sign in with Raft" at a glance.
//
// With `onConnected` it runs in a popup and keeps this dialog's state live:
// waiting while the popup is open, then connected or failed, with no reload.
// The popup cannot be trusted to report back — Raft's sign-in page severs the
// opener (Cross-Origin-Opener-Policy), which also makes popup.closed read true
// at once — so the dialog polls the attempt it started (worker
// /api/me/connectors/raft/attempt) and, where that is out of reach (the
// feedback overlay has no account session), the caller's `isConnected`.
const RAFT_CONNECT_POLL_MS = 1500;
const RAFT_CONNECT_TIMEOUT_MS = 10 * 60 * 1000;
function newAttemptId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function RaftConnectButton({ label = 'Connect with Raft', onConnected = null, isConnected = null, startHref = '/api/me/connectors/raft/start' }) {
  const [phase, setPhase] = useState('idle');
  const [message, setMessage] = useState('');
  const stopRef = React.useRef(null);
  useEffect(() => () => { if (stopRef.current) stopRef.current(); }, []);
  const connect = (event) => {
    if (!onConnected) return;
    event.preventDefault();
    if (phase === 'waiting') return;
    const attempt = newAttemptId();
    const popup = window.open(
      tdocUrl(`${startHref}${startHref.includes('?') ? '&' : '?'}popup=1&attempt=${attempt}`),
      'tdoc-raft-connect',
      'popup,width=560,height=720,resizable=yes,scrollbars=yes',
    );
    if (!popup) {
      setPhase('failed');
      setMessage('Your browser blocked the Raft sign-in window. Allow popups for tdoc, then try again.');
      return;
    }
    setPhase('waiting');
    setMessage('');
    const started = Date.now();
    let timer = null;
    let done = false;
    let channel = null;
    const stop = () => {
      done = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', hint);
      try { if (channel) channel.close(); } catch { /* ignore */ }
      stopRef.current = null;
    };
    const check = async () => {
      if (done) return;
      let status = 'unknown';
      let why = '';
      try {
        const body = await getRaftConnectAttempt(attempt);
        status = body.status;
        why = body.message || '';
      } catch { /* no account session here: fall back to isConnected */ }
      if (status !== 'connected' && status !== 'failed' && isConnected) {
        try { if (await isConnected()) status = 'connected'; } catch { /* keep waiting */ }
      }
      if (done) return;
      if (status === 'connected') {
        stop();
        setPhase('connected');
        try { await onConnected(); } catch { setMessage('Raft is connected, but this window could not refresh. Close and reopen Send to agent.'); }
        return;
      }
      if (status === 'failed') {
        stop();
        setPhase('failed');
        setMessage(why || 'Raft did not connect.');
        return;
      }
      if (Date.now() - started > RAFT_CONNECT_TIMEOUT_MS) {
        stop();
        setPhase('failed');
        setMessage('Raft sign-in timed out.');
        return;
      }
      timer = window.setTimeout(check, RAFT_CONNECT_POLL_MS);
    };
    // The popup's own word, when it gets through, only means "check now".
    const hint = (msg) => {
      if (msg.data?.type !== 'tdoc:raft-connected') return;
      window.clearTimeout(timer);
      check();
    };
    window.addEventListener('message', hint);
    try {
      channel = new BroadcastChannel('tdoc-raft-connect');
      channel.onmessage = hint;
    } catch { /* not supported: polling alone */ }
    stopRef.current = stop;
    timer = window.setTimeout(check, RAFT_CONNECT_POLL_MS);
  };
  const cancel = () => {
    if (stopRef.current) stopRef.current();
    setPhase('idle');
    setMessage('');
  };
  const waiting = phase === 'waiting';
  return (
    <>
      <a className="tdoc-raft-btn" href="/api/me/connectors/raft/start" onClick={connect} aria-disabled={waiting || undefined}>
        <RaftMark size={18} />
        <span>{waiting ? 'Waiting for Raft…' : phase === 'failed' ? 'Try again' : phase === 'connected' ? 'Connected' : label}</span>
      </a>
      {waiting ? (
        <p className="manage-hint" role="status">
          Finish signing in in the Raft window. This updates by itself.
          {' '}<button type="button" className="text-btn" onClick={cancel}>Cancel</button>
        </p>
      ) : null}
      {phase === 'failed' ? <p className="status" role="status">Not connected: {message}</p> : null}
      {phase === 'connected' ? <p className="manage-hint" role="status">{message || 'Raft connected.'}</p> : null}
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
// `known` are the agents on this server: the ones that worked with tdoc, then
// the rest of Raft's directory for it (once the server's tdoc App installation
// grants the Agent permission). Anyone not listed is typed by handle.
// A handle typed into the search that matches nobody listed is offered as its
// own row (only then: a partial match is a search, not a new name), so an agent the directory does not show can still be named.
const TYPED_AGENT = '__typed__:';
const HANDLE_RE = /^@?[^\s@]{1,80}$/;
// `inCard`: an edit inside a connected card on /me/agents, indented under the
// card's title like its facts; the card already states the current default,
// so the field is labelled as the change it is.
export function RaftFallbackForm({ server, known = [], current = null, onSaved, inCard = false }) {
  const [pick, setPick] = useState(() => (current && current.agent_sub) || (known[0] && known[0].agent_sub) || '');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const listed = known.map((a) => ({
    value: a.agent_sub,
    label: readableHandle(a) || a.agent_sub,
    hint: current && current.agent_sub === a.agent_sub ? 'default' : (a.last_touched ? `used ${sinceText(a.last_touched)}` : ''),
  }));
  const typed = query.trim().replace(/^@/, '');
  const typedRow = typed && HANDLE_RE.test(typed) && !listed.some((o) => o.label.toLowerCase().includes(typed.toLowerCase()))
    ? [{ value: `${TYPED_AGENT}${typed}`, label: `@${typed}`, hint: 'not in the list; use this handle' }]
    : [];
  const pickedTyped = pick.startsWith(TYPED_AGENT) ? pick.slice(TYPED_AGENT.length) : '';
  // Typing a new handle and pressing Save, without picking its row first,
  // saves that handle: what is in the box is what gets saved.
  const handle = pickedTyped || (typedRow.length ? typed : '');
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = await setRaftFallbackAgent(handle
        ? { server_id: server.server_id, agent_name: handle }
        : { server_id: server.server_id, agent_sub: pick });
      if (onSaved) await onSaved(body.target);
    } catch (err) {
      setError(err.status === 400 ? 'Use the agent\'s Raft handle, one word, like @my-agent.' : (err.message || 'Could not save'));
    } finally {
      setBusy(false);
    }
  };
  const label = inCard ? 'Change default agent' : `Default agent on ${server.server_slug || 'this server'}`;
  return (
    <form className={`tdoc-conn-pick${inCard ? ' tdoc-conn-pick--card' : ''}`} onSubmit={save}>
      {/* One picker whether or not Raft shared the server's list: without
          one it is the same box, and what is typed is offered as the handle. */}
      <label>
        <span>{label}</span>
        <AppCombobox
          ariaLabel={`Default agent on ${server.server_slug || 'this server'}`}
          placeholder={known.length ? 'Search or type a handle' : 'Type the agent\'s Raft handle'}
          empty={known.length ? 'No agent by that name' : 'Type the agent\'s handle, as it appears in Raft'}
          value={pick}
          onChange={setPick}
          onQuery={setQuery}
          options={pickedTyped && !typedRow.length
            ? [...listed, { value: pick, label: `@${pickedTyped}`, hint: 'not in the list; use this handle' }]
            : [...listed, ...typedRow]}
        />
      </label>
      <button type="submit" className="tdoc-fbspace-btn primary" disabled={busy || (!pick && !handle) || (!handle && current && current.agent_sub === pick)}>{busy ? 'Saving…' : 'Save'}</button>
      {!known.length ? (
        // Not a dropdown with nothing in it: say why there is no list.
        <p className="manage-hint tdoc-conn-pick-note">Raft hasn&apos;t shared the agent list for {server.server_slug || 'this server'} with tdoc yet, so type the agent&apos;s handle.</p>
      ) : null}
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
          : <a className="tdoc-connector-action" href={tdocUrl('/me?view=settings#agents')} target="_blank" rel="noreferrer">Choose an agent in workspace settings</a>}
        <p className="manage-hint">Or have the agent run the connect prompt itself:</p>
        <code>{CONNECT_AGENT_PROMPT}</code>
      </div>
    </AppDialog>
  );
}

function ConnectAgentView({ onClose, onConnected, isConnected }) {
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
              ? <RaftConnectButton onConnected={onConnected} isConnected={isConnected} />
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
        <p className="manage-hint">Manage connections any time in <a href="/me?view=settings#agents">workspace settings</a>.</p>
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
    // Not asked yet (a closed dialog) is not "unavailable": that state used
    // to carry over into the first render after opening and showed "Notify
    // is not available on this host yet" until the list arrived.
    if (!enabled || !slug) {
      setState((s) => ({ ...s, ready: false, available: false, reason: null }));
      return;
    }
    setState((s) => ({ ...s, ready: false }));
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

function TeamDaemonView({ reason, onClose }) {
  const admin = reason === 'no_team_daemon';
  return (
    <AppDialog
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={admin ? 'Set up an always-on agent' : reason === 'no_team_agent' ? 'No team agent yet' : 'A team admin sends this'}
      actions={<button type="button" onClick={onClose}>Close</button>}
    >
      {admin ? (
        <>
          <p>Connect Claude Code or Codex on your computer without Raft. Once its daemon is running, it appears here for team documents.</p>
          <details className="tdoc-conn-alt" open>
            <summary>Ask the agent to set it up</summary>
            <code>{LOCAL_DAEMON_PROMPT}</code>
            <CopyPromptButton text={LOCAL_DAEMON_PROMPT} />
          </details>
          <p className="manage-hint">You can also set it up under Workspace Settings → Always-on agent.</p>
        </>
      ) : reason === 'no_team_agent'
        ? <p>This team has no agent to send comments to. A team admin can add one in the team&apos;s settings, under Agents; then every member can send it comments from team docs.</p>
        : <p>For safety, only a workspace admin can run an agent on their computer from a team document.</p>}
    </AppDialog>
  );
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
  // { provider, agent_name } of an agent that did not pick these up: the
  // picker opens on someone else ("Send to another agent" on a card).
  avoid = null,
}) {
  const targets = useNotifyTargets(slug, open);
  const [selected, setSelected] = useState(null);
  const [instruction, setInstruction] = useState(() => defaultInstruction(commentIds));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  // The outcome of the last Send: { ok, text }. After a failure the primary
  // button reads Retry.
  const [result, setResult] = useState(null);
  const [recent, setRecent] = useState([]);

  // An unrelated account connection is not this document's default. Let the
  // person choose unless this document's publisher or handoff names one.
  useEffect(() => {
    if (!open) return;
    const all = [targets.default, ...targets.candidates].filter(Boolean);
    const skip = (t) => avoid && avoid.agent_name && t.provider === (avoid.provider || t.provider)
      && String(t.agent_name || '').toLowerCase() === String(avoid.agent_name).toLowerCase();
    setSelected(avoid ? all.find((t) => !skip(t)) || null : targets.default || null);
  }, [open, targets.default, targets.candidates, avoid]);

  useEffect(() => {
    if (!open) return;
    setInstruction(defaultInstruction(commentIds));
    setStatus('');
    setResult(null);
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

  // The same list, in the same order, the @ picker offers (agent-choices.js).
  const choices = orderedAgentChoices(targets);

  const ids = Array.isArray(commentIds) ? commentIds.filter(Boolean) : [];
  const boundHint = noAgentBoundReason(targets.reason);
  const chosen = selected || targets.default;
  const selectedKey = targetKey(chosen);
  const last = recent[0];
  const lastFailed = last?.delivery?.status === 'failed';
  // Nothing new: the button never sits there doing nothing. If the last batch
  // went to someone else, the action is to hand that batch to the agent picked
  // here instead; if it already went to this one, there is no action.
  const lastIds = Array.isArray(last?.comment_ids) ? last.comment_ids.filter(Boolean) : [];
  const reassign = !ids.length && lastIds.length > 0 && !!chosen && !sameTarget(last.recipient, chosen);
  const batch = ids.length ? ids : (reassign ? lastIds : []);
  const canSubmit = !busy && batch.length > 0 && choices.length > 0 && !!chosen;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setStatus('');
    setResult(null);
    const to = agentLabel(chosen);
    try {
      const body = await postNotifyHandoff({
        slug,
        comment_ids: batch,
        instruction: instruction.trim(),
        recipient: chosen || undefined,
      });
      const failed = body?.delivery?.status === 'failed';
      if (body?.reason === 'agent_has_last_word') {
        setResult({ ok: true, text: `Nothing sent: an agent already replied to ${batch.length === 1 ? 'this comment' : 'these comments'}.` });
      } else if (failed) {
        setResult({ ok: false, text: `Not delivered to ${to}${body.delivery?.error ? `: ${deliveryErrorText(body.delivery.error)}` : ''}.` });
      } else {
        const n = body.sent || batch.length;
        setResult({ ok: true, text: `Sent ${n} comment${n === 1 ? '' : 's'} to ${to} ✓` });
      }
      if (onSent) onSent(body);
      try {
        const next = await listNotifyHandoffs(slug, 5);
        setRecent(Array.isArray(next.handoffs) ? next.handoffs : []);
      } catch { /* ignore */ }
    } catch (err) {
      setResult({ ok: false, text: `Not sent to ${to}: ${err.message || 'something went wrong'}.` });
    } finally {
      setBusy(false);
    }
  };

  const resend = async (handoffId) => {
    setBusy(true);
    setStatus('');
    try {
      const body = await resendNotifyHandoff({ slug, handoff_id: handoffId });
      setStatus(resendResultText(body));
      if (onSent) onSent(body);
    } catch (err) {
      setStatus(err.message || 'Could not resend');
    } finally {
      setBusy(false);
    }
  };

  const unavailable = targets.ready && !targets.available;

  // Nobody to send to: the panel's job becomes getting one connected, instead
  // of a Send button that cannot go anywhere. A connected server whose Raft
  // directory lists agents is not this case: those are offered below.
  const refreshAll = async () => { await targets.refresh(); if (onTargetsChanged) await onTargetsChanged(); };
  if (open && targets.ready && targets.available && (targets.reason === 'team_admin_only' || targets.reason === 'no_team_daemon' || targets.reason === 'no_team_agent')) {
    return <TeamDaemonView reason={targets.reason} onClose={onClose} />;
  }
  if (open && targets.ready && targets.available && !choices.length) {
    if (targets.raftServers.length) {
      return <RaftConnectedNoAgentView servers={targets.raftServers} onClose={onClose} onSaved={refreshAll} />;
    }
    return (
      <ConnectAgentView
        onClose={onClose}
        onConnected={refreshAll}
        isConnected={async () => {
          const body = await listNotifyTargets(slug);
          return Boolean(body.default || (body.candidates || []).length || (body.raft_servers || []).length);
        }}
      />
    );
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Send to agent"
      description={!targets.ready
        ? 'Finding your agents…'
        : unavailable
        ? 'Notify is not available on this host yet.'
        : ids.length
          ? `${ids.length === 1 ? '1 comment' : `${ids.length} comments`} for ${chosen && chosen.team_agent ? 'the team agent' : 'your agent'} to fix. It replies on each one here.`
          : lastIds.length
            ? `No new comments. The last ${lastIds.length === 1 ? 'one' : `${lastIds.length}`} went to ${agentLabel(last.recipient)}${sinceText(last.at) ? ` ${sinceText(last.at)}` : ''}.`
            : 'No new comments to send.'}
      actions={(
        <>
          <button type="button" onClick={onClose}>{batch.length > 0 ? 'Cancel' : 'Close'}</button>
          {!unavailable && batch.length > 0 ? (
            <button type="button" className="primary" disabled={!canSubmit} onClick={submit}>
              {busy ? `Sending to ${agentLabel(chosen)}…` : result && !result.ok ? 'Retry' : reassign ? `Send ${lastIds.length === 1 ? 'it' : 'them'} to ${agentLabel(chosen)}` : `Send to ${agentLabel(chosen)}`}
            </button>
          ) : null}
        </>
      )}
    >
      {unavailable ? null : (
        <div className="tdoc-send">
          {/* Only a failed last send earns a line of its own: a delivered one
              is already in the description, and a count of it said nothing. */}
          {lastFailed ? (
            <p className="tdoc-send-notice tdoc-notify-error">
              The last send to {agentLabel(last.recipient)} was not delivered.
              {last.handoff_id && last.handoff_resend_allowed !== false ? (
                <button type="button" className="text-btn" disabled={busy} onClick={() => resend(last.handoff_id)}>Resend</button>
              ) : null}
            </p>
          ) : null}

          {choices.length > 0 ? (
            <div className="tdoc-send-field">
              <label className="tdoc-send-label" htmlFor="tdoc-notify-recipient">
                {!ids.length && lastIds.length > 0 ? 'Hand it to another agent' : 'Agent'}
              </label>
              <AppCombobox
                id="tdoc-notify-recipient"
                ariaLabel="Agent"
                placeholder="Search agents"
                empty="No agent by that name"
                value={selectedKey}
                onChange={(key) => {
                  const next = choices.find((t) => targetKey(t) === key);
                  if (next) setSelected(next);
                }}
                options={choices.map((t) => recipientOption(t, targets.default, choices))}
              />
              {!targets.default ? <p className="tdoc-send-hint">Choose who should receive this document&apos;s comments.</p> : null}
            </div>
          ) : (
            <p className="tdoc-send-hint" title={boundHint || undefined}>
              {boundHint || 'No agent has touched this doc yet. Pick one after an agent publishes or replies.'}
            </p>
          )}

          {/* Raft says the chosen agent is not running. A warning, not a
              block: the person may be about to start it. */}
          {chosen && agentDown(chosen) && batch.length > 0 ? (
            <p className="tdoc-send-notice tdoc-send-warn" role="status">
              {agentLabel(chosen)} is {chosen.status} in Raft — it won&apos;t receive this
            </p>
          ) : null}

          {batch.length > 0 ? (
            <div className="tdoc-send-field">
              <label className="tdoc-send-label" htmlFor="tdoc-notify-instruction">Note for the agent <span>optional</span></label>
              <textarea
                id="tdoc-notify-instruction"
                className="tdoc-notify-instruction"
                rows={2}
                maxLength={500}
                placeholder="Anything it should know…"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onFocus={(e) => {
                  // Default is a starter, not locked copy — select it so the first
                  // key replaces instead of forcing a delete-then-type.
                  if (isDefaultInstruction(instruction)) e.target.select();
                }}
              />
            </div>
          ) : null}

          {/* Said only when there is something to say: an empty line held
              open for it left a hole above the buttons. */}
          {result || status ? (
            <p className={`tdoc-send-result${result && !result.ok ? ' tdoc-notify-error' : result && result.ok ? ' is-ok' : ''}`} role="status">
              {result ? result.text : status}
            </p>
          ) : null}
        </div>
      )}
    </AppDialog>
  );
}

// `recipient`: the agent the comment tagged after @; without one the worker
// sends to this doc's default, as the @agent button does.
export async function sendOneCommentToAgent(slug, commentId, recipient = null) {
  return postNotifyHandoff({
    slug,
    comment_ids: [commentId],
    instruction: 'address this comment',
    recipient: recipient || undefined,
  });
}
