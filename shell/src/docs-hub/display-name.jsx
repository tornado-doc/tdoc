import React, { useState } from 'react';
import { AppButton } from '../ui/button.jsx';
import './teams.css';

// Settings -> Profile -> Name. The name on this person's comments, replies,
// team rosters and the account menu, in place of the one their sign-in
// provider sent. Saved by POST /api/me/name; an empty name goes back to the
// provider's. The server trims, collapses spaces, drops control characters
// and refuses markup; this field only mirrors the length cap.

const NAME_MAX = 60;

export function DisplayNameField({ profile, onSaved }) {
  const providerName = profile?.provider_name || '';
  const initial = profile?.display_name || profile?.name || providerName || '';
  const [saved, setSaved] = useState(initial);
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const dirty = value.replace(/\s+/g, ' ').trim() !== saved;

  const save = async (event) => {
    if (event) event.preventDefault();
    if (busy || !dirty) return;
    setBusy(true);
    setStatus('');
    try {
      const r = await fetch('/api/me/name', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus(body.message || (r.status === 429 ? 'Too many changes. Try again later.' : 'Could not save your name.'));
        return;
      }
      setSaved(body.name || '');
      setValue(body.name || '');
      setStatus('Saved.');
      if (onSaved) onSaved(body);
    } catch {
      setStatus('Could not save your name. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="manage-section tm-name-form" onSubmit={save}>
      <label className="field" htmlFor="tm-display-name">Name</label>
      <div className="tm-name-row">
        <input
          id="tm-display-name"
          type="text"
          autoComplete="name"
          maxLength={NAME_MAX}
          placeholder={providerName || 'Your name'}
          value={value}
          onChange={(event) => { setValue(event.target.value); setStatus(''); }}
        />
        <AppButton type="submit" variant="primary" disabled={busy || !dirty}>Save</AppButton>
      </div>
      <p className="manage-hint">
        Shown on your comments and replies, and to your teams.
        {providerName && saved !== providerName ? <> Leave it empty to use <b>{providerName}</b> from your sign-in.</> : null}
      </p>
      {status ? <p className="status" role="status">{status}</p> : null}
    </form>
  );
}

// Settings -> Profile: the name (hosted accounts) and the public profile link.
export function ProfileSettingsCard({ name, profile, onNameSaved }) {
  return (
    <section className="tm-settings-card" id="profile">
      <div className="tm-settings-head"><div><h2>Profile</h2><p>{profile ? 'How you appear on tdoc.' : name}</p></div></div>
      {profile ? <DisplayNameField profile={profile} onSaved={onNameSaved} /> : null}
      <a className="ui-btn ui-btn-secondary ui-btn-m" href={profile?.handle ? `/@${encodeURIComponent(profile.handle)}` : '/me#claim-profile'}>
        {profile?.handle ? 'Open public profile' : 'Claim public profile'}
      </a>
    </section>
  );
}
