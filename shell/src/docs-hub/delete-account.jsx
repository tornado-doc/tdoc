import React, { useEffect, useState } from 'react';
import { AppButton } from '../ui/button.jsx';
import { AppDialog } from '../ui/dialog.jsx';
import './teams.css';

// Settings -> Delete account, the last card on the personal Settings page.
// The dialog asks the server what deleting would do (GET), shows anything
// that blocks it with a link to fix it, and deletes only once the person has
// typed their login (or address). The server checks all of it again.

export function DeleteAccountCard() {
  const [open, setOpen] = useState(false);
  return (
    <section className="tm-settings-card" id="delete-account" aria-labelledby="delete-account-heading">
      <div className="tm-settings-head">
        <div>
          <h2 id="delete-account-heading">Delete account</h2>
          <p>Signs you out everywhere, disconnects your own agents and AI apps, and moves your docs to Trash. After 30 days they are erased for good.</p>
        </div>
      </div>
      <AppButton variant="danger" className="danger" onClick={() => setOpen(true)}>Delete account…</AppButton>
      {open ? <DeleteAccountDialog onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

function DeleteAccountDialog({ onClose }) {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/me/account/delete', { credentials: 'same-origin' })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.message || 'Could not check this account. Reload and try again.');
        if (live) setPlan(data);
      })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);

  const blockers = (plan && plan.blockers) || [];
  const confirm = (plan && plan.confirm) || '';
  const matches = !!confirm && typed.trim().toLowerCase() === confirm.toLowerCase();
  const canDelete = !!plan && !blockers.length && matches && !busy;

  const remove = async () => {
    if (!canDelete) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/me/account/delete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: typed.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (data.blockers) setPlan((p) => ({ ...p, blockers: data.blockers }));
        throw new Error(data.message || `Could not delete the account (HTTP ${r.status}).`);
      }
      location.assign('/?notice=account-deleted');
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const days = (plan && plan.retention_days) || 30;
  const teamsGone = (plan && plan.teams_deleted) || [];
  const teamsLeft = (plan && plan.teams_left) || [];
  return (
    <AppDialog
      open
      onOpenChange={(next) => { if (!next && !busy) onClose(); }}
      title="Delete account"
      actions={(
        <>
          <AppButton onClick={onClose} disabled={busy}>Cancel</AppButton>
          <AppButton variant="danger" className="danger" disabled={!canDelete} onClick={remove}>
            {busy ? 'Deleting…' : 'Delete account'}
          </AppButton>
        </>
      )}
    >
      {!plan && !error ? <p className="muted">Checking your account…</p> : null}
      {plan && blockers.length ? (
        <div className="manage-section" data-testid="delete-account-blockers">
          <p>Your account cannot be deleted yet:</p>
          {blockers.map((b) => (
            <p key={`${b.kind}:${b.team && b.team.id}`} className="danger">
              {b.message}{' '}
              <a href={b.url}>{b.kind === 'paid_team' ? 'Open billing' : 'Open team settings'}</a>
            </p>
          ))}
        </div>
      ) : null}
      {plan && !blockers.length ? (
        <>
          <p>
            You are signed out everywhere and every agent and app you connected is disconnected (team agents stay with
            their team). Your docs go to Trash and are
            erased for good after {days} days, with your profile. Comments you left on other people&apos;s docs stay,
            shown as &quot;Deleted user&quot;.
          </p>
          {teamsGone.length ? (
            <p className="muted">You are the only member of {teamsGone.map((t) => t.name).join(', ')}: {teamsGone.length === 1 ? 'it is' : 'they are'} deleted too, {teamsGone.length === 1 ? 'its' : 'their'} docs to Trash.</p>
          ) : null}
          {teamsLeft.length ? (
            <p className="muted">You leave {teamsLeft.map((t) => t.name).join(', ')}. Team docs stay with the team.</p>
          ) : null}
          <div className="manage-section">
            <label className="field" htmlFor="delete-account-confirm">
              Type <b>{confirm}</b> to confirm
            </label>
            <input
              id="delete-account-confirm"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') remove(); }}
              autoFocus
            />
          </div>
        </>
      ) : null}
      {error ? <p className="danger" role="alert">{error}</p> : null}
    </AppDialog>
  );
}
