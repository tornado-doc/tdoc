import React, { useState } from 'react';
import { TopBar } from './top-bar.jsx';
import { AppDialog } from './ui/dialog.jsx';
import './docs-hub.css';

const CURATE_WARN_KEY = 'tdoc.curateWarned';
const PICK_VIEW_KEY = 'tdoc.profilePickView';

function needsCurateWarn() {
  try { return localStorage.getItem(CURATE_WARN_KEY) !== '1'; } catch { return true; }
}

function markCurateWarned() {
  try { localStorage.setItem(CURATE_WARN_KEY, '1'); } catch { /* ignore */ }
}

function readPickView() {
  try {
    const v = localStorage.getItem(PICK_VIEW_KEY);
    return v === 'compact' ? 'compact' : 'preview';
  } catch {
    return 'preview';
  }
}

function writePickView(view) {
  try { localStorage.setItem(PICK_VIEW_KEY, view); } catch { /* ignore */ }
}

function day(iso) {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '';
}

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

function ProfileAvatar({ githubLogin, avatarUrl, name, handle }) {
  const [broken, setBroken] = useState(false);
  const src = !broken && (avatarUrl
    || (githubLogin ? `https://github.com/${encodeURIComponent(githubLogin)}.png?size=160` : ''));
  if (src) {
    return (
      <img
        className="profile-avatar"
        src={src}
        alt=""
        width={40}
        height={40}
        onError={() => setBroken(true)}
      />
    );
  }
  const letter = String(name || handle || '?').replace(/^@/, '').slice(0, 1).toUpperCase();
  if (letter && letter !== '?') {
    return <span className="profile-avatar profile-avatar-fallback" aria-hidden="true">{letter}</span>;
  }
  return (
    <img
      className="profile-avatar profile-avatar-logo"
      src="/tdoc_logo.svg"
      alt=""
      width={40}
      height={40}
      data-tdoc-dark="invert"
    />
  );
}

// Plain bio text with http(s) URLs turned into links. No markdown — just
// make the obvious thing clickable.
const BIO_URL = /https?:\/\/[^\s<]+[^\s<.,:;!?)]/g;

function BioText({ text }) {
  const value = String(text || '');
  if (!value) return null;
  const nodes = [];
  let last = 0;
  let match;
  BIO_URL.lastIndex = 0;
  while ((match = BIO_URL.exec(value))) {
    if (match.index > last) nodes.push(value.slice(last, match.index));
    const href = match[0];
    nodes.push(
      <a key={`${match.index}-${href}`} href={href} target="_blank" rel="noopener noreferrer">
        {href}
      </a>,
    );
    last = match.index + href.length;
  }
  if (last < value.length) nodes.push(value.slice(last));
  return <p className="profile-bio">{nodes}</p>;
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
  const [handleDraft, setHandleDraft] = useState(login);
  const [handleStatus, setHandleStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickView, setPickView] = useState(readPickView);
  const identity = boot.identity || null;

  const setView = (view) => {
    setPickView(view);
    writePickView(view);
  };

  const refreshDocsFromCatalog = (nextCatalog) => {
    const pinned = nextCatalog.filter((row) => row.on_profile);
    setDocs(pinned.map((row) => ({
      slug: row.slug,
      title: row.title,
      visibility: row.visibility,
      published: row.published || row.created || '',
      excerpt: row.excerpt || '',
      image: row.image || '',
      url: `/d/${encodeURIComponent(row.slug)}`,
    })));
  };

  const togglePin = async (slug, pinned, { confirmed = false } = {}) => {
    if (pinned && !confirmed && needsCurateWarn()) {
      setModal({ type: 'curate-warn', slug });
      return false;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/me/profile/pin', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, pinned }),
      });
      if (!r.ok) return false;
      const body = await r.json().catch(() => ({}));
      if (pinned) markCurateWarned();
      const next = catalog.map((row) => (
        row.slug === slug
          ? {
            ...row,
            on_profile: pinned,
            visibility: body.visibility || (pinned ? 'public' : row.visibility),
          }
          : row
      ));
      setCatalog(next);
      refreshDocsFromCatalog(next);
      // Reload so new picks get server-side excerpts.
      if (pinned) location.reload();
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

  const saveHandle = async () => {
    if (busy) return;
    setBusy(true);
    setHandleStatus('');
    try {
      const r = await fetch('/api/me/handle', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: handleDraft }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setHandleStatus(
          body.error === 'handle_taken' ? 'That handle is taken.'
            : body.error === 'reserved_handle' ? 'That name is reserved.'
            : body.error === 'invalid_handle' ? 'Use letters, numbers, and hyphens.'
            : body.error ? `Could not save (${body.error}).`
            : 'Could not save handle.',
        );
        return;
      }
      if (body.url) location.assign(body.url);
      else location.reload();
    } catch {
      setHandleStatus('Could not save handle.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tdoc-app docs-hub">
      <TopBar identity={identity} />
      <main className="wrap">
        <div className="page-hd profile-hd">
          <ProfileAvatar
            githubLogin={githubLogin}
            avatarUrl={identity && identity.avatar_url}
            name={identity && identity.name}
            handle={login}
          />
          <div className="profile-id">
            <h1 className="profile-handle">@{login}</h1>
            {bio ? <BioText text={bio} /> : null}
            <p className="loc-hint">
              {docs.length} {docs.length === 1 ? 'pick' : 'picks'}
              {docs.length > 0 ? (
                <>
                  {' · '}
                  <span className="profile-view-toggle" role="group" aria-label="Pick layout">
                    <button
                      type="button"
                      className={`text-btn${pickView === 'compact' ? ' is-active' : ''}`}
                      aria-pressed={pickView === 'compact'}
                      onClick={() => setView('compact')}
                    >
                      Compact
                    </button>
                    <span aria-hidden="true"> / </span>
                    <button
                      type="button"
                      className={`text-btn${pickView === 'preview' ? ' is-active' : ''}`}
                      aria-pressed={pickView === 'preview'}
                      onClick={() => setView('preview')}
                    >
                      Preview
                    </button>
                  </span>
                </>
              ) : null}
              {mine ? (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => { setHandleDraft(login); setHandleStatus(''); setModal('handle'); }}
                  >
                    Change handle
                  </button>
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
          <section className={`profile-picks is-${pickView}`}>
            {docs.map((doc) => {
              const isPreview = pickView === 'preview';
              const hasImage = Boolean(doc.image);
              if (!isPreview) {
                return (
                  <a
                    key={doc.slug}
                    className="profile-pick-card"
                    href={doc.url || `/d/${encodeURIComponent(doc.slug)}/v/${doc.latest || 1}`}
                  >
                    <span className="profile-pick-body">
                      <span className="profile-pick-title">{doc.title || doc.slug}</span>
                      <span className="profile-pick-meta">
                        {day(doc.published || doc.updated) ? `Published ${day(doc.published || doc.updated)}` : ''}
                      </span>
                    </span>
                  </a>
                );
              }
              return (
                <a
                  key={doc.slug}
                  className={`profile-pick-card has-preview${hasImage ? ' has-image' : ''}`}
                  href={doc.url || `/d/${encodeURIComponent(doc.slug)}/v/${doc.latest || 1}`}
                >
                  <span className="profile-pick-surface">
                    {hasImage ? (
                      <span className="profile-pick-media" aria-hidden="true">
                        <img src={doc.image} alt="" loading="lazy" />
                      </span>
                    ) : null}
                    <span className="profile-pick-copy">
                      <span className="profile-pick-title">{doc.title || doc.slug}</span>
                      {doc.excerpt ? (
                        <span className="profile-pick-excerpt">{doc.excerpt}</span>
                      ) : null}
                    </span>
                  </span>
                  <span className="profile-pick-meta">
                    {day(doc.published || doc.updated) ? `Published ${day(doc.published || doc.updated)}` : ''}
                  </span>
                </a>
              );
            })}
          </section>
        )}
      </main>

      {modal === 'handle' ? (
        <ProfileDialog
          title="Change your public URL"
          confirmLabel={busy ? 'Saving…' : 'Save'}
          onConfirm={saveHandle}
          onClose={() => setModal(null)}
        >
          <p className="manage-hint">
            Public docs show at tdoc.dev/@handle. Changing frees the old name.
          </p>
          <label className="field" htmlFor="tdoc-profile-handle">Handle</label>
          <input
            id="tdoc-profile-handle"
            type="text"
            maxLength={39}
            autoFocus
            disabled={busy}
            value={handleDraft}
            onChange={(event) => setHandleDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') saveHandle(); }}
          />
          {handleStatus ? <p className="manage-hint">{handleStatus}</p> : null}
        </ProfileDialog>
      ) : null}

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

      {modal && modal.type === 'curate-warn' ? (
        <ProfileDialog
          title="Show on your profile?"
          confirmLabel="Show on profile"
          onConfirm={async () => {
            const slug = modal.slug;
            setModal('picks');
            await togglePin(slug, true, { confirmed: true });
          }}
          onClose={() => setModal('picks')}
        >
          <p className="manage-hint">
            This makes the doc public so anyone can open the link from your profile.
            Taking it down later restores the previous access.
          </p>
        </ProfileDialog>
      ) : null}

      {modal === 'picks' ? (
        <ProfileDialog
          title="Public picks"
          onClose={() => setModal(null)}
          actions={<button type="button" onClick={() => setModal(null)}>Done</button>}
        >
          <p className="manage-hint">
            Curating a doc makes it public on your profile. Take it down to restore the previous access.
          </p>
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
                    <em>
                      {day(row.created || row.updated)
                        ? `Published ${day(row.created || row.updated)}`
                        : row.slug}
                    </em>
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
