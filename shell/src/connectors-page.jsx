import React, { useCallback, useEffect, useState } from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { CONNECT_AGENT_PROMPT, ProviderMark, providerMeta, readableHandle } from './document/notify-handoff.jsx';
import './docs-hub.css';

// Where this account's comments go when someone presses Send to agent or
// @agent. Every connector can be tested and disconnected here; adding one is
// a card per kind (Raft today, webhooks for anything else).

async function call(path, body) {
  const r = await fetch(path, body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new Error((b && (b.message || b.error)) || `HTTP ${r.status}`);
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

export function ConnectorsBody() {
  const [targets, setTargets] = useState(null);
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

  const load = useCallback(async () => {
    try {
      const b = await call('/api/me/connectors');
      setTargets(b.targets || []);
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
      setResults((r) => ({ ...r, [idOf(t)]: d.status === 'delivered' ? 'Delivered ✓' : `Not delivered: ${d.error || 'unknown'}` }));
    } catch (err) { setResults((r) => ({ ...r, [idOf(t)]: err.message })); }
  };

  const remove = async () => {
    const c = confirm;
    setBusy(true);
    try {
      await call('/api/me/connectors/remove', c.kind === 'raft' ? { provider: 'raft', server_id: c.server_id } : keyOf(c.target));
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
  const doCopy = async (what, text) => { if (await copy(text)) { setCopied(what); setTimeout(() => setCopied(''), 1800); } };

  return (
    <>
        <p className="muted" style={{ marginTop: 0 }}>
          Where tdoc sends comments when you press Send to agent or @agent. The agent that wrote a doc gets its comments first; the top one here is the default for everything else.
        </p>
        {notice ? <p className="muted" role="status">{notice}</p> : null}

        <h2 className="tdoc-conn-h">Connected</h2>
        {targets === null ? <p className="muted">Loading…</p> : !connectors.length ? (
          <p className="empty">Nothing connected yet. Add one below.</p>
        ) : (
          <section className="pane">
            {connectors.map((c) => {
              const isRaft = c.kind === 'raft';
              const sample = isRaft ? (c.agents || [])[0] : c.target;
              const title = isRaft ? `Raft · ${c.server_slug || 'server'}` : (readableHandle(c.target) || 'Webhook');
              const names = isRaft ? (c.agents || []).map((a) => readableHandle(a) || a.agent_sub) : [];
              const isDefault = targets[0] && sample && idOf(targets[0]) === idOf(sample);
              const detail = isRaft
                ? `${names.length ? `Linked: ${names.join(', ')}` : 'No agent linked yet'} · any agent on this server gets comments on the docs it writes`
                : detailOf(c.target);
              return (
                <div key={c.id} className="doc-row tdoc-conn-row">
                  <span className="tdoc-conn-mark"><ProviderMark target={isRaft ? { provider: 'raft' } : c.target} size={20} /></span>
                  <div className="doc-info">
                    <span className="doc-title">{title}{isDefault ? <span className="tdoc-conn-default">default</span> : null}</span>
                    <div className="doc-meta">{detail}{sample && results[idOf(sample)] ? ` · ${results[idOf(sample)]}` : ''}</div>
                  </div>
                  {sample ? <button type="button" className="tdoc-fbspace-btn" onClick={() => test(sample)}>Send test</button> : null}
                  <button type="button" className="tdoc-fbspace-btn" onClick={() => setConfirm({ ...c, title })}>Disconnect</button>
                </div>
              );
            })}
          </section>
        )}

        <h2 className="tdoc-conn-h">Add a connector</h2>
        <div className="tdoc-connectors">
          <section className="tdoc-connector">
            <div className="tdoc-connector-head"><strong>Raft agent</strong><span className="muted">An agent on a Raft server where the tdoc app is installed.</span></div>
            {raftReady ? null : <p className="muted tdoc-conn-note">Raft is not configured on this host.</p>}
            <p className="muted tdoc-conn-note">Paste this into the agent; it connects itself:</p>
            <code>{CONNECT_AGENT_PROMPT}</code>
            <button type="button" className="tdoc-fbspace-btn primary" onClick={() => doCopy('raft', CONNECT_AGENT_PROMPT)}>{copied === 'raft' ? 'Copied' : 'Copy prompt'}</button>
          </section>

          <section className="tdoc-connector">
            <div className="tdoc-connector-head"><strong>Webhook</strong><span className="muted">Any bot or service that can receive an HTTPS POST. No Raft needed.</span></div>
            <form className="tdoc-conn-form" onSubmit={addHook}>
              <input type="url" required placeholder="https://your-bot.example.com/tdoc" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
              <input type="text" placeholder="Name (optional)" value={hookName} onChange={(e) => setHookName(e.target.value)} maxLength={60} />
              <button type="submit" className="tdoc-fbspace-btn primary" disabled={busy || !hookUrl}>Add webhook</button>
            </form>
            <p className="muted tdoc-conn-note">tdoc POSTs JSON (<span className="tdoc-inline-code">type: "tdoc.handoff"</span>, the doc, comment ids, instruction) with <span className="tdoc-inline-code">X-Tdoc-Signature: sha256=…</span>, an HMAC-SHA256 of the body with your signing secret.</p>
          </section>
        </div>

      {confirm ? (
        <AppDialog
          open
          onOpenChange={(o) => { if (!o && !busy) setConfirm(null); }}
          title="Disconnect this connector?"
          actions={(<>
            <button type="button" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
            <button type="button" className="danger" disabled={busy} onClick={remove}>Disconnect</button>
          </>)}
        >
          <p><b>{confirm.title}</b> will stop receiving comments from tdoc{confirm.kind === 'raft' ? ' — every agent on this server, including on docs they wrote' : ''}. You can connect it again any time.</p>
        </AppDialog>
      ) : null}

      {made ? (
        <AppDialog
          open
          onOpenChange={(o) => { if (!o) setMade(null); }}
          title="Webhook added"
          description="Copy the signing secret now — it is shown only once."
          actions={<button type="button" className="primary" onClick={() => setMade(null)}>Done</button>}
        >
          <div className="tdoc-connector">
            <code className="tdoc-conn-secret">{made.secret}</code>
            <button type="button" className="tdoc-fbspace-btn" onClick={() => doCopy('secret', made.secret)}>{copied === 'secret' ? 'Copied' : 'Copy secret'}</button>
            <p className="manage-hint">Use Send test on the row above to check it arrives.</p>
          </div>
        </AppDialog>
      ) : null}
    </>
  );
}
