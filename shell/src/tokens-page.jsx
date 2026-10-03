import React, { useState } from 'react';
import { Laptop } from 'lucide-react';
import { TopBar } from './top-bar.jsx';
import { AppDialog } from './ui/dialog.jsx';
import { ClaudeMark, OpenAIMark, RaftMark } from './agent-marks.jsx';
import './docs-hub.css';

// Devices & agents: every computer or agent the person approved (one
// credential each). Each can publish, edit and delete their docs, so the page
// exists to answer "is there one here I don't recognise?" and remove it.

function when(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Older credentials were approved before devices described themselves; the
// doc they first published is often the only thing that tells them apart.
function deviceName(t) { return t.device || 'Unknown device'; }

function ClientMark({ client }) {
  const c = String(client || '').toLowerCase();
  if (c.includes('claude')) return <ClaudeMark size={18} />;
  if (c.includes('codex')) return <OpenAIMark size={17} />;
  if (c.includes('raft')) return <RaftMark size={18} />;
  return <Laptop size={18} aria-hidden="true" />;
}

export function TokensPage({ boot }) {
  const initial = (Array.isArray(boot.tokens) ? boot.tokens : [])
    .slice()
    .sort((a, b) => String(b.last_used || b.created || '').localeCompare(String(a.last_used || a.created || '')));
  const [tokens, setTokens] = useState(initial);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const revoke = async () => {
    const target = confirm;
    setBusy(true);
    try {
      const r = await fetch('/api/me/tokens/revoke', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: target.id }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setTokens((list) => list.filter((t) => t.id !== target.id));
      setNotice(`Removed ${deviceName(target)}. It can no longer act on your account.`);
    } catch {
      setNotice('Could not remove that device. Reload and try again.');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div className="tdoc-app docs-hub tdoc-devices-page">
      <TopBar identity={boot.identity || null} />
      <main className="wrap">
        <div className="page-hd"><h1>Devices &amp; agents</h1></div>
        <p className="muted" style={{ marginTop: 0 }}>
          Every computer or agent you approved can publish, edit and delete your docs. Remove any you don’t recognise; it will need your approval to come back.
        </p>
        {notice ? <p className="muted" role="status">{notice}</p> : null}
        {tokens.length === 0 ? (
          <p className="empty">Nothing approved yet. Devices and agents appear here when you approve them.</p>
        ) : (
          <section className="pane">
            {tokens.map((t) => (
              <div key={t.id} className="doc-row tdoc-dev-row">
                <span className="tdoc-conn-mark"><ClientMark client={t.client} /></span>
                <div className="doc-info">
                  <span className="doc-title">{deviceName(t)}{t.client ? <span className="tdoc-dev-client">{t.client}</span> : null}</span>
                  <div className="doc-meta">
                    {[
                      t.last_used ? `Last used ${when(t.last_used)}` : 'Not used since approval',
                      `approved ${when(t.created) || 'earlier'}`,
                    ].join(' · ')}
                    {t.doc ? <> · first published <a href={`/d/${encodeURIComponent(t.doc.slug)}`}>{t.doc.title}</a></> : t.label ? <> · first published {t.label}</> : null}
                  </div>
                </div>
                <button type="button" className="tdoc-fbspace-btn tdoc-dev-remove" onClick={() => setConfirm(t)}>Remove</button>
              </div>
            ))}
          </section>
        )}
        <p className="muted tdoc-fbspace-foot">Where comments go when you press Send to agent is set on <a href="/me/connectors">Connectors</a>.</p>
      </main>
      {confirm ? (
        <AppDialog
          open
          onOpenChange={(open) => { if (!open && !busy) setConfirm(null); }}
          title="Remove this device?"
          actions={(
            <>
              <button type="button" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="danger" disabled={busy} onClick={revoke}>Remove</button>
            </>
          )}
        >
          <p>
            <b>{deviceName(confirm)}</b>{confirm.client ? ` (${confirm.client})` : ''}
            {confirm.doc ? <>, which first published “{confirm.doc.title}”,</> : null} will stop working immediately.
            Nothing it already published is removed.
          </p>
        </AppDialog>
      ) : null}
    </div>
  );
}
