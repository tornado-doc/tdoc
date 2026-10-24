import React, { useEffect, useState } from 'react';
import { Laptop } from 'lucide-react';
import { AppDialog } from './ui/dialog.jsx';
import { ClaudeMark, OpenAIMark, RaftMark } from './agent-marks.jsx';
import { WorkspaceChecklist, workspaceSummary } from './workspace-checklist.jsx';
import './docs-hub.css';

// Devices & agents: every computer or agent the person approved (one
// credential each). Each acts as the person in the workspaces it reaches --
// all of them, or the ones left ticked when it was allowed -- so the page
// answers "is there one here I don't recognise?" and "what can each one
// see?", and lets the person change the workspaces or remove it.

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

const byRecent = (list) => list.slice().sort((a, b) => String(b.last_used || b.created || '').localeCompare(String(a.last_used || a.created || '')));

export function DevicesBody({ tokens: given, workspaces: givenWorkspaces }) {
  const [tokens, setTokens] = useState(() => byRecent(Array.isArray(given) ? given : []));
  // My docs and each team: what a connection can be given.
  const [workspaces, setWorkspaces] = useState(Array.isArray(givenWorkspaces) ? givenWorkspaces : []);
  // { token, picked } while the Change dialog is open.
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (Array.isArray(given)) return;
    fetch('/api/me/tokens', { credentials: 'same-origin' })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((body) => {
        setTokens(byRecent(body.tokens || []));
        if (Array.isArray(body.workspaces)) setWorkspaces(body.workspaces);
      })
      .catch(() => setNotice('Could not load agent access. Reload and try again.'));
  }, [given]);

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

  // The server answers with what the connection now reaches (null: all of
  // them); its very next request runs under that.
  const saveWorkspaces = async () => {
    const { token: target, picked } = editing;
    setBusy(true);
    try {
      const r = await fetch('/api/me/tokens/workspaces', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: target.id, workspaces: picked }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      const next = body.workspaces === undefined ? picked : body.workspaces;
      setTokens((list) => list.map((t) => (t.id === target.id ? { ...t, workspaces: next } : t)));
      setNotice(`Saved. ${deviceName(target)} can now reach ${Array.isArray(next) ? workspaceSummary(workspaces, next) : 'all your workspaces'}.`);
      setEditing(null);
    } catch {
      setNotice('Could not change that connection. Reload and try again.');
    } finally {
      setBusy(false);
    }
  };

  // Someone with no team has one workspace and nothing to choose: no line,
  // no Change button (the access model: they never see the ticks).
  const choosing = workspaces.length > 1;
  const reach = (t) => (Array.isArray(t.workspaces) ? workspaceSummary(workspaces, t.workspaces) : 'All workspaces');

  const revokeAll = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/me/tokens/revoke-all', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      setTokens([]);
      setNotice(`Removed ${body.revoked || 0} approved device${body.revoked === 1 ? '' : 's'}. They can no longer act on your account.`);
    } catch {
      setNotice('Could not remove all access. Reload and try again.');
    } finally {
      setBusy(false);
      setConfirmAll(false);
    }
  };

  return (
    <>
        <div className="tdoc-access-intro">
          <p className="muted">
            Every computer or agent you approved can open, publish and edit docs as you, in the workspaces it can reach. Remove any you don’t recognise; it will need your approval to come back.
          </p>
          {tokens.length ? <button type="button" className="tdoc-fbspace-btn tdoc-dev-remove" onClick={() => setConfirmAll(true)}>Remove all access</button> : null}
        </div>
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
                  {choosing || Array.isArray(t.workspaces) ? (
                    <div className="doc-meta tdoc-dev-reach">Can reach: <b>{reach(t)}</b></div>
                  ) : null}
                </div>
                <div className="tdoc-dev-actions">
                  {choosing ? (
                    <button
                      type="button"
                      className="tdoc-fbspace-btn"
                      onClick={() => setEditing({ token: t, picked: Array.isArray(t.workspaces) ? t.workspaces.filter((id) => workspaces.some((w) => w.id === id)) : workspaces.map((w) => w.id) })}
                    >
                      Change
                    </button>
                  ) : null}
                  <button type="button" className="tdoc-fbspace-btn tdoc-dev-remove" onClick={() => setConfirm(t)}>Remove</button>
                </div>
              </div>
            ))}
          </section>
        )}

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

      {editing ? (
        <AppDialog
          open
          onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}
          title="Which workspaces can it reach?"
          actions={(
            <>
              <button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className="primary" disabled={busy || !editing.picked.length} onClick={saveWorkspaces}>Save</button>
            </>
          )}
        >
          <p>
            <b>{deviceName(editing.token)}</b>{editing.token.client ? ` (${editing.token.client})` : ''} can open, publish and edit docs in the workspaces you tick. The change applies to its next request.
          </p>
          <WorkspaceChecklist
            workspaces={workspaces}
            picked={editing.picked}
            onChange={(picked) => setEditing((e) => ({ ...e, picked }))}
            disabled={busy}
            label="Workspaces this connection can reach"
          />
          {!editing.picked.length ? <p className="muted tdoc-dev-pick-hint">Tick at least one. To stop it entirely, remove it instead.</p> : null}
        </AppDialog>
      ) : null}

      {confirmAll ? (
        <AppDialog
          open
          onOpenChange={(open) => { if (!open && !busy) setConfirmAll(false); }}
          title="Remove all device access?"
          actions={(
            <>
              <button type="button" disabled={busy} onClick={() => setConfirmAll(false)}>Cancel</button>
              <button type="button" className="danger" disabled={busy} onClick={revokeAll}>Remove all</button>
            </>
          )}
        >
          <p>All {tokens.length} approved computers and agents will stop working immediately. Nothing already published will be removed. Each device will need your approval before it can act on your account again.</p>
        </AppDialog>
      ) : null}
    </>
  );
}
