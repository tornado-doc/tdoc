import React, { useState } from 'react';
import { TerminalSquare } from 'lucide-react';
import { TopBar } from './top-bar.jsx';
import { AppDialog } from './ui/dialog.jsx';
import './docs-hub.css';

function when(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Older credentials were minted before terminals described themselves, so
// the doc they first published is often the only thing that tells them apart.
function tokenName(t) {
  if (t.device && t.client) return `${t.device} · ${t.client}`;
  return t.device || t.client || 'Unnamed terminal';
}

export function TokensPage({ boot }) {
  const [tokens, setTokens] = useState(Array.isArray(boot.tokens) ? boot.tokens : []);
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
      setNotice(`Revoked ${tokenName(target)}. It can no longer act on your account.`);
    } catch {
      setNotice('Could not revoke that terminal. Reload and try again.');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div className="tdoc-app docs-hub">
      <TopBar identity={boot.identity || null} />
      <main className="wrap">
        <div className="page-hd">
          <h1>Connected terminals</h1>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Every CLI or agent you approved holds its own credential, and each one can publish, edit and delete any of
          your documents. Revoke any you don’t recognise; it will need your approval again to reconnect.
        </p>
        {notice ? <p className="muted" role="status">{notice}</p> : null}
        {tokens.length === 0 ? (
          <p className="empty">No connected terminals.</p>
        ) : (
          <section className="pane">
            {tokens.map((t) => {
              const meta = [
                `Approved ${when(t.created) || 'at an unknown time'}`,
                t.last_used ? `last used ${when(t.last_used)}` : null,
              ].filter(Boolean).join(' · ');
              return (
                <div key={t.id} className="doc-row">
                  <TerminalSquare size={18} style={{ flexShrink: 0, color: 'var(--td-muted)' }} aria-hidden="true" />
                  <div className="doc-info">
                    <span className="doc-title">{tokenName(t)}</span>
                    <div className="doc-meta">
                      {meta}
                      {t.doc ? (
                        <> · first published <a href={`/d/${encodeURIComponent(t.doc.slug)}`}>{t.doc.title}</a></>
                      ) : t.label ? <> · first published {t.label}</> : null}
                    </div>
                  </div>
                  <button type="button" onClick={() => setConfirm(t)}>Revoke</button>
                </div>
              );
            })}
          </section>
        )}
      </main>
      {confirm ? (
        <AppDialog
          open
          onOpenChange={(open) => { if (!open && !busy) setConfirm(null); }}
          title="Revoke this terminal?"
          actions={(
            <>
              <button type="button" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="danger" disabled={busy} onClick={revoke}>Revoke</button>
            </>
          )}
        >
          <p>
            <b>{tokenName(confirm)}</b>
            {confirm.doc ? <> (first published “{confirm.doc.title}”)</> : null} will stop working immediately.
            Nothing it already published is removed.
          </p>
        </AppDialog>
      ) : null}
    </div>
  );
}
