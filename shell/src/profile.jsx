import React, { useState } from 'react';
import { TopBar } from './top-bar.jsx';
import { AppDialog } from './ui/dialog.jsx';
import './docs-hub.css';

function ProfileDialog({ title, children, confirmLabel, onConfirm, onClose, actions }) {
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={title}
      actions={actions || (
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          {onConfirm ? (
            <button type="button" className="primary" onClick={onConfirm}>{confirmLabel}</button>
          ) : null}
        </>
      )}
    >
      {children}
    </AppDialog>
  );
}

export function Profile({ boot }) {
  const login = boot.handle || boot.login || '';
  const githubLogin = boot.github_login || '';
  const mine = Boolean(boot.mine);
  const [docs, setDocs] = useState(() => (Array.isArray(boot.docs) ? boot.docs : []));
  const [bio, setBio] = useState(() => (typeof boot.bio === 'string' ? boot.bio : ''));
  const [catalog, setCatalog] = useState(() => (Array.isArray(boot.catalog) ? boot.catalog : []));
  const [modal, setModal] = useState(null);
  const [bioDraft, setBioDraft] = useState(bio);
  const [busy, setBusy] = useState(false);
  const avatar = githubLogin
    ? `https://github.com/${encodeURIComponent(githubLogin)}.png?size=96`
    : '';

  const refreshDocsFromCatalog = (nextCatalog) => {
    const pinned = nextCatalog.filter((row) => row.on_profile);
    setDocs(pinned.map((row) => ({
      slug: row.slug,
      title: row.title,
      url: `/d/${encodeURIComponent(row.slug)}`,
    })));
  };

  const togglePin = async (slug, pinned) => {
    setBusy(true);
    try {
      const r = await fetch('/api/me/profile/pin', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, pinned }),
      });
      if (!r.ok) return false;
      const next = catalog.map((row) => (
        row.slug === slug ? { ...row, on_profile: pinned } : row
      ));
      setCatalog(next);
      refreshDocsFromCatalog(next);
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveBio = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/me/profile', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bio: bioDraft }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return;
      setBio(typeof body.bio === 'string' ? body.bio : bioDraft.trim());
      setModal(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tdoc-app docs-hub">
      <TopBar identity={boot.identity || null} />
      <main className="wrap">
        <div className="page-hd profile-hd">
          {avatar ? (
            <img className="profile-avatar" src={avatar} alt="" width={40} height={40} />
          ) : null}
          <div className="profile-id">
            <h1 className="profile-handle">@{login}</h1>
            {bio ? <p className="profile-bio">{bio}</p> : null}
            <p className="loc-hint">
              {docs.length} {docs.length === 1 ? 'pick' : 'picks'}
              {mine ? (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => { setBioDraft(bio); setModal('bio'); }}
                  >
                    {bio ? 'Edit bio' : 'Add bio'}
                  </button>
                </>
              ) : null}
            </p>
          </div>
          {mine ? (
            <button
              type="button"
              className="new-folder-btn"
              onClick={() => setModal('picks')}
            >
              Add a pick
            </button>
          ) : null}
        </div>
        {docs.length === 0 ? (
          <p className="empty">
            {mine ? 'No public picks yet. Add one from your docs.' : 'No public picks yet.'}
          </p>
        ) : (
          <section className="pane">
            <div className="doc-list">
              {docs.map((doc) => (
                <a
                  key={doc.slug}
                  className="doc-row"
                  href={doc.url || `/d/${encodeURIComponent(doc.slug)}/v/${doc.latest || 1}`}
                >
                  <div className="doc-info">
                    <span className="doc-title">{doc.title || doc.slug}</span>
                    <div className="doc-meta">{doc.slug}</div>
                  </div>
                </a>
              ))}
            </div>
          </section>
        )}
      </main>

      {modal === 'bio' ? (
        <ProfileDialog
          title="Profile bio"
          confirmLabel={busy ? 'Saving…' : 'Save'}
          onConfirm={saveBio}
          onClose={() => setModal(null)}
        >
          <p className="manage-hint">Optional. Up to 280 characters.</p>
          <textarea
            rows={4}
            maxLength={280}
            value={bioDraft}
            onChange={(event) => setBioDraft(event.target.value)}
            placeholder="What you write about…"
          />
        </ProfileDialog>
      ) : null}

      {modal === 'picks' ? (
        <ProfileDialog
          title="Public picks"
          onClose={() => setModal(null)}
          actions={<button type="button" onClick={() => setModal(null)}>Done</button>}
        >
          <p className="manage-hint">Choose docs to show on this profile. Visitors still need link access to open them.</p>
          {!catalog.length ? (
            <p className="muted">No docs in your catalog yet.</p>
          ) : (
            <div className="move-list">
              {catalog.map((row) => (
                <label key={row.slug} className="profile-pick-row">
                  <input
                    type="checkbox"
                    checked={Boolean(row.on_profile)}
                    disabled={busy}
                    onChange={(event) => togglePin(row.slug, event.target.checked)}
                  />
                  <span>
                    <b>{row.title || row.slug}</b>
                    <em>{row.slug}</em>
                  </span>
                </label>
              ))}
            </div>
          )}
        </ProfileDialog>
      ) : null}
    </div>
  );
}
