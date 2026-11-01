import React, { useCallback, useEffect, useState } from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { AppButton } from './ui/button.jsx';
import { CopyPromptButton } from './ui/copy-prompt-button.jsx';
import { CodeBlock } from './ui/code-block.jsx';
import { AGENT_CONNECTORS, CONNECT_AGENT_PROMPT, LOCAL_DAEMON_PROMPT, ConnectorHead, RaftConnectButton, RaftFallbackForm, ProviderMark, deliveryErrorText, localSeenText, providerMeta, readableHandle } from './document/notify-handoff.jsx';
import './docs-hub.css';

// Where this account's comments go when someone presses Send to agent or
// @agent. Every connector can be tested and disconnected here; adding one is
// a card per kind (Raft today, webhooks for anything else).

async function call(path, body) {
  const r = await fetch(path, body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => null);
  // A bare status code is not a sentence (it showed as "HTTP 404" in settings).
  if (!r.ok) throw new Error((b && (b.message || b.error)) || (r.status === 404 ? 'Agents are not available here yet.' : `Something went wrong (${r.status}). Try again.`));
  return b;
}

const keyOf = (t) => ({ provider: t.provider, server_id: t.server_id, agent_sub: t.agent_sub });
const idOf = (t) => `${t.provider}:${t.server_id}:${t.agent_sub}`;

function detailOf(t) {
  if (t.provider === 'webhook') { try { return new URL(t.url).host; } catch (_) { return t.url || ''; } }
  if (t.provider === 'raft') return t.server_slug ? `Raft server ${t.server_slug}` : 'Raft';
  return providerMeta(t).label;
}

async function copy(text) { try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; } }

export function ConnectorsBody({ team = null, returnTo = '/me?view=settings#agents' }) {
  const [targets, setTargets] = useState(null);
  const [accountDefault, setAccountDefault] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [connectors, setConnectors] = useState([]);
  const [available, setAvailable] = useState([]);
  const [results, setResults] = useState({});
  const [confirm, setConfirm] = useState(null);
  const [notice, setNotice] = useState('');
  const [hookUrl, setHookUrl] = useState('');
  const [hookName, setHookName] = useState('');
  const [made, setMade] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('connected') === 'raft') { setNotice('Raft server connected. Agents on it now get comments on the docs they write.'); setSetupOpen(true); }
    else if (q.get('error')) setNotice(`Could not connect: ${q.get('error').replace(/_/g, ' ')}.`);
  }, []);
  const load = useCallback(async () => {
    try {
      const b = await call('/api/me/connectors');
      setTargets(b.targets || []);
      setAccountDefault(b.default || null);
      setConnectors(b.connectors || []);
      setAvailable(b.available || []);
    } catch (err) { setNotice(err.message); setTargets([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const test = async (t) => {
    setResults((r) => ({ ...r, [idOf(t)]: 'Sending…' }));
    try {
      const b = await call('/api/me/connectors/test', keyOf(t));
      const d = b.delivery || {};
      const accepted = t.provider === 'raft' ? 'Accepted by Raft ✓' : 'Delivered ✓';
      setResults((r) => ({ ...r, [idOf(t)]: d.status === 'delivered' ? accepted : `Not delivered: ${deliveryErrorText(d.error) || 'unknown'}` }));
    } catch (err) { setResults((r) => ({ ...r, [idOf(t)]: err.message })); }
  };

  const remove = async () => {
    const c = confirm;
    setBusy(true);
    try {
      await call('/api/me/connectors/remove', c.kind === 'raft' || c.kind === 'local' ? { provider: c.kind, server_id: c.server_id } : keyOf(c.target));
      setNotice(`Disconnected ${c.title}.`);
      await load();
    }
    catch (err) { setNotice(err.message); }
    finally { setBusy(false); setConfirm(null); }
  };

  const addHook = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const b = await call('/api/me/connectors/webhook', { url: hookUrl, label: hookName });
      setMade(b); setHookUrl(''); setHookName(''); await load();
    } catch (err) { setNotice(err.message); }
    finally { setBusy(false); }
  };

  const raftReady = (available.find((a) => a.id === 'raft') || {}).ready;
  const raftConnectors = connectors.filter((x) => x.kind === 'raft');
  const defaultOn = (c) => (accountDefault && accountDefault.provider === 'raft' && accountDefault.server_id === c.server_id ? accountDefault : null);
  const savedDefault = async (t) => {
    setNotice(`${readableHandle(t) || 'That agent'} is your default agent: it gets comments on docs no agent has worked on yet.`);
    setSetupOpen(false);
    await load();
  };
  // Right after Connect with Raft, choosing the default agent is the last
  // step of connecting: without one, Send to agent has nobody to send to.
  const needsDefault = targets !== null && !accountDefault && raftConnectors.length > 0;
  const doCopy = async (what, text) => { if (await copy(text)) { setCopied(what); setTimeout(() => setCopied(''), 1800); } };

  return (
    <>
        <p className="muted tdoc-conn-intro">
          {team ? `Only workspace admins can send ${team.name}'s comments to the agents connected here.` : "Each doc's comments go to the agent you last picked for it in Send to agent, or else the agent that last worked on it. Docs with neither go to your default agent."}
        </p>
        {notice ? <p className="muted" role="status">{notice}</p> : null}

        <h2 className="tdoc-conn-h">Connected</h2>
        {targets === null ? <p className="muted">Loading…</p> : !connectors.length ? (
          <p className="empty">Nothing connected yet. Add one below.</p>
        ) : (
          <div className="tdoc-connectors">
            {connectors.map((c) => {
              const isRaft = c.kind === 'raft';
              const isLocal = c.kind === 'local';
              const sample = isRaft || isLocal ? (defaultOn(c) || (c.agents || [])[0]) : c.target;
              const title = isRaft ? `Raft · ${c.server_slug || 'server'}` : isLocal ? `This computer · ${c.device}` : (readableHandle(c.target) || 'Webhook');
              // A local device is connected while its daemon checks in.
              const localUp = isLocal && (c.agents || []).some((a) => a.status === 'active');
              return (
                <section key={c.id} className="tdoc-connector tdoc-conn-card">
                  <div className="tdoc-conn-card-head">
                    <span className="tdoc-connector-logo"><ProviderMark target={isRaft || isLocal ? { provider: c.kind } : c.target} size={22} /></span>
                    <div className="tdoc-conn-card-title">
                      <strong>{title}</strong>
                      <span className="tdoc-connector-badge">{isLocal ? (localUp ? 'Daemon running' : 'Daemon not running') : 'Connected'}</span>
                    </div>
                    <div className="tdoc-conn-card-actions">
                      <AppButton
                        disabled={!sample}
                        title={sample ? 'Send a test notification' : 'Choose an agent below before sending a test'}
                        onClick={() => { if (sample) test(sample); }}
                      >
                        Send test
                      </AppButton>
                      <AppButton className="tdoc-dev-remove" onClick={() => setConfirm({ ...c, title })}>Disconnect</AppButton>
                    </div>
                  </div>
                  <dl className="tdoc-conn-facts">
                    {isRaft ? (
                      <>
                        <div><dt>Default agent</dt><dd>{defaultOn(c) ? (readableHandle(defaultOn(c)) || defaultOn(c).agent_sub) : (accountDefault ? 'On another connector' : 'Not set yet — choose one below; Send to agent needs it')}</dd></div>
                        <div><dt>Routing</dt><dd>Any agent on this server gets the comments on docs it wrote.</dd></div>
                        <div><dt>Delivery</dt><dd>tdoc shows when Raft accepts a handoff, then when the agent replies.</dd></div>
                      </>
                    ) : isLocal ? (
                      <>
                        <div><dt>Agents</dt><dd>{(c.agents || []).map((a) => a.cli).join(', ')}</dd></div>
                        <div><dt>Last seen</dt><dd>{localSeenText((c.agents || [])[0]) || 'not yet'}</dd></div>
                        <div><dt>Delivery</dt><dd>Comments wait here until the daemon on that computer polls (every minute while it runs), then the CLI edits the doc and replies.</dd></div>
                      </>
                    ) : (
                      <div><dt>Endpoint</dt><dd>{detailOf(c.target)}</dd></div>
                    )}
                    {sample && results[idOf(sample)] ? <div><dt>Last test</dt><dd>{results[idOf(sample)]}</dd></div> : null}
                  </dl>
                  {isRaft ? (
                    <RaftFallbackForm key={`${c.server_id}:${(defaultOn(c) || {}).agent_sub || ''}`} server={c} known={c.agents || []} current={defaultOn(c)} onSaved={savedDefault} inCard />
                  ) : null}
                </section>
              );
            })}
          </div>
        )}

        <h2 className="tdoc-conn-h">Add a connector</h2>
        <div className="tdoc-connectors">
          {/* Browse: one card per kind of connector, the featured one first.
              Raft is the only agent platform today; webhooks cover the rest. */}
          {AGENT_CONNECTORS.map((conn) => (
            <section key={conn.id} className={`tdoc-connector${conn.featured ? ' is-featured' : ''}`}>
              <ConnectorHead connector={conn} />
              {conn.id === 'raft' ? (raftReady ? (
                <>
                  {connectors.some((x) => x.kind === 'raft') ? (
                    <p className="muted tdoc-conn-note">
                      ✓ Connected to {connectors.filter((x) => x.kind === 'raft').map((x) => x.server_slug || 'a server').join(', ')}. Connect another only if some of your agents live on a different Raft server.
                    </p>
                  ) : null}
                  <RaftConnectButton startHref={`/api/me/connectors/raft/start?return=${encodeURIComponent(returnTo)}`} label={connectors.some((x) => x.kind === 'raft') ? 'Connect another Raft server' : 'Connect with Raft'} />
                  <details className="tdoc-conn-alt">
                    <summary>Or let an agent connect itself</summary>
                    <CodeBlock text={CONNECT_AGENT_PROMPT} />
                  </details>
                </>
              ) : <p className="muted tdoc-conn-note">Raft is not configured on this host.</p>) : null}
              {conn.id === 'local' ? (
                <>
                  <p className="muted tdoc-conn-note">Needs the tdoc skill signed in on that computer (<code className="tdoc-inline-code">tdoc-publish --signin-only</code>). Then, in a terminal or from the agent itself:</p>
                  <CodeBlock wrap={false} text={`bash "$SKILL_DIR/bin/tdoc-daemon" install          # macOS: runs now and at login
bash "$SKILL_DIR/bin/tdoc-daemon" uninstall        # turns it off
bash "$SKILL_DIR/bin/tdoc-daemon" start            # in a terminal (Linux)
bash "$SKILL_DIR/bin/tdoc-daemon" install-launchd  # only prints a LaunchAgent plist`} />
                  <details className="tdoc-conn-alt">
                    <summary>Or let the agent set it up</summary>
                    <CodeBlock text={LOCAL_DAEMON_PROMPT} />
                  </details>
                  <p className="muted tdoc-conn-note">Comments are untrusted input to that agent: the daemon runs the CLI with a conservative permission mode and tells it to touch only the doc. Only you, through the Send to agent button, can queue work for it.</p>
                </>
              ) : null}
              {conn.id === 'webhook' ? (
                <>
                  <form className="tdoc-conn-form" onSubmit={addHook}>
                    <label>
                      <span>Endpoint URL</span>
                      <input type="url" required placeholder="https://your-bot.example.com/tdoc" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
                    </label>
                    <label>
                      <span>Name <em>optional</em></span>
                      <input type="text" placeholder="My bot" value={hookName} onChange={(e) => setHookName(e.target.value)} maxLength={60} />
                    </label>
                    <AppButton type="submit" variant="primary" className="primary" disabled={busy || !hookUrl}>Add webhook</AppButton>
                  </form>
                  <details className="tdoc-conn-alt">
                    <summary>What tdoc sends</summary>
                    <p className="muted tdoc-conn-note">A JSON POST, signed with the secret you get when you add it.</p>
                    <CodeBlock wrap={false} copy={false} text={`POST <your URL>
X-Tdoc-Signature: sha256=<HMAC-SHA256(secret, body)>

{
  "type": "tdoc.handoff",
  "slug": "q3-plan",
  "comment_ids": ["c_…"],
  "instruction": "address my new comments",
  "url": "https://tdoc.dev/d/q3-plan"
}`} />
                  </details>
                </>
              ) : null}
            </section>
          ))}
          <p className="muted tdoc-conn-note">More connectors are coming.</p>
        </div>

      {confirm ? (
        <AppDialog
          open
          onOpenChange={(o) => { if (!o && !busy) setConfirm(null); }}
          title="Disconnect this connector?"
          actions={(<>
            <AppButton disabled={busy} onClick={() => setConfirm(null)}>Cancel</AppButton>
            <AppButton variant="danger" className="danger" disabled={busy} onClick={remove}>Disconnect</AppButton>
          </>)}
        >
          <p><b>{confirm.title}</b> will stop receiving comments from tdoc{confirm.kind === 'raft' ? ' — every agent on this server, including on docs they wrote' : ''}. You can connect it again any time.</p>
        </AppDialog>
      ) : null}

      {setupOpen && needsDefault ? (
        <AppDialog
          open
          onOpenChange={() => {}}
          title="Choose your default agent"
          description="Last step of connecting Raft. Each doc's comments go to the agent you last picked for it, or the agent that last worked on it; docs with neither go to this one. You can change it here any time."
        >
          {raftConnectors.map((c) => (
            <RaftFallbackForm key={c.server_id} server={c} known={c.agents || []} onSaved={savedDefault} />
          ))}
          {/* Not a second button beside Save: skipping is the quiet way out. */}
          <button type="button" className="tdoc-quiet-link" onClick={() => setSetupOpen(false)}>Choose later</button>
        </AppDialog>
      ) : null}

      {made ? (
        <AppDialog
          open
          onOpenChange={(o) => { if (!o) setMade(null); }}
          title="Webhook added"
          description="Copy the signing secret now — it is shown only once."
          actions={<AppButton variant="primary" className="primary" onClick={() => setMade(null)}>Done</AppButton>}
        >
          <div className="tdoc-connector">
            <code className="tdoc-conn-secret">{made.secret}</code>
            <CopyPromptButton label="Copy secret" copied={copied === 'secret'} onCopy={() => doCopy('secret', made.secret)} />
            <p className="manage-hint">Use Send test on the row above to check it arrives.</p>
          </div>
        </AppDialog>
      ) : null}
    </>
  );
}
