import React, { useEffect, useState } from 'react';
import { LayoutGrid, Rows3, Share2, UserRoundPen, PencilLine, X } from 'lucide-react';
import { TopBar } from './top-bar.jsx';
import { AppDialog } from './ui/dialog.jsx';
import {
  DEFAULT_ANNOTATION_LINES,
  POSTER_KINDS,
  consumeShareAfterNav,
  downloadHandlePoster,
  ensurePosterFonts,
  markShareAfterNav,
  posterPreviewDataUrl,
  profileUrl,
} from './profile-posters.js';
import './docs-hub.css';

const PICK_VIEW_KEY = 'tdoc.profilePickView';

// A profile lists only Public docs, and pinning one makes it Public. Say so
// every time the doc is not Public yet (an unknown visibility counts as not).
function pinNeedsPublicConfirm(visibility) {
  return visibility !== 'public';
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

function pinErrorMessage(error, pinned) {
  if (error === 'team_doc') return 'That doc belongs to a team now, so it cannot be a personal pick.';
  if (error === 'not_found') return 'That doc no longer exists.';
  if (error === 'forbidden') return 'Only the author can change this pick.';
  if (error === 'sign_in_required') return 'Sign in again to change your picks.';
  const verb = pinned ? 'add this pick' : 'remove this pick';
  return error ? `Could not ${verb} (${error}).` : `Could not ${verb}.`;
}

function catalogNote(row) {
  if (row.status === 'team') return 'Moved to a team · uncheck to remove';
  if (row.status === 'deleted') return 'Deleted · uncheck to remove';
  return day(row.created || row.updated) ? `Published ${day(row.created || row.updated)}` : row.slug;
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
  const [shareStatus, setShareStatus] = useState('');
  const [posterFontsReady, setPosterFontsReady] = useState(false);
  // { message, error?, undo? } — pick add/remove feedback, undo for take-downs.
  const [notice, setNotice] = useState(null);
  const [posterArrow, setPosterArrow] = useState(true);
  const [posterAnnotation, setPosterAnnotation] = useState(() => DEFAULT_ANNOTATION_LINES.join('\n'));
  const identity = boot.identity || null;

  useEffect(() => {
    if (!mine) return;
    let open = false;
    try {
      const q = new URLSearchParams(window.location.search);
      open = q.get('share') === '1';
      if (open) {
        // Drop the flag so refresh does not keep re-opening.
        q.delete('share');
        const next = `${window.location.pathname}${q.toString() ? `?${q}` : ''}${window.location.hash || ''}`;
        window.history.replaceState({}, '', next);
      }
    } catch { /* ignore */ }
    if (!open) open = consumeShareAfterNav();
    if (open) setModal('share');
  }, [mine]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 6000 : 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let cancelled = false;
    ensurePosterFonts().then(() => {
      if (!cancelled) setPosterFontsReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  const setView = (view) => {
    setPickView(view);
    writePickView(view);
  };

  const copyProfileLink = async () => {
    const url = profileUrl(login);
    try {
      await navigator.clipboard.writeText(url);
      setShareStatus('Link copied.');
    } catch {
      setShareStatus(url);
    }
  };

  // restore: the card to put back without a reload (Undo of a take-down).
  const togglePin = async (slug, pinned, { confirmed = false, restore = null } = {}) => {
    if (pinned && !confirmed && pinNeedsPublicConfirm((catalog.find((item) => item.slug === slug) || {}).visibility)) {
      setModal({ type: 'curate-warn', slug });
      return false;
    }
    const row = catalog.find((item) => item.slug === slug);
    const card = docs.find((doc) => doc.slug === slug);
    const title = (card && card.title) || (row && row.title) || slug;
    setBusy(true);
    try {
      const r = await fetch('/api/me/profile/pin', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, pinned }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({ error: true, message: pinErrorMessage(body.error, pinned) });
        return false;
      }
      setCatalog((cur) => cur
        // A pick whose doc moved to a team or was deleted cannot come back.
        .filter((item) => pinned || item.slug !== slug || !item.status)
        .map((item) => (
          item.slug === slug
            ? {
              ...item,
              on_profile: pinned,
              visibility: body.visibility || (pinned ? 'public' : item.visibility),
            }
            : item
        )));
      if (!pinned) {
        setDocs((cur) => cur.filter((doc) => doc.slug !== slug));
        setNotice({
          message: `Removed “${title}” from your profile.`,
          undo: row && row.status ? null : (card || { slug, title, url: `/d/${encodeURIComponent(slug)}` }),
        });
      } else if (restore) {
        setDocs((cur) => [restore, ...cur.filter((doc) => doc.slug !== slug)]);
        setNotice(null);
      } else {
        // Reload so new picks get server-side excerpts.
        location.reload();
      }
      return true;
    } catch {
      setNotice({ error: true, message: pinErrorMessage('', pinned) });
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
      markShareAfterNav();
      if (body.url) location.assign(body.url.includes('?') ? `${body.url}&share=1` : `${body.url}?share=1`);
      else {
        setModal('share');
        location.reload();
      }
    } catch {
      setHandleStatus('Could not save handle.');
    } finally {
      setBusy(false);
    }
  };

  // inline: inside the Public picks dialog, under its hint, instead of a toast.
  const pickNotice = (inline) => (notice ? (
    <div
      className={`${inline ? 'profile-pick-notice is-inline' : 'tdoc-toast profile-pick-notice'}${notice.error ? ' error' : ''}`}
      role="status"
    >
      <span>{notice.message}</span>
      {notice.undo ? (
        <button
          type="button"
          className="text-btn"
          disabled={busy}
          onClick={() => togglePin(notice.undo.slug, true, { confirmed: true, restore: notice.undo })}
        >
          Undo
        </button>
      ) : null}
    </div>
  ) : null);

  return (
    <div className="tdoc-app docs-hub">
      {/* A visitor with no account sees someone's docs and nothing else to do;
          send them to the front page, which is where getting started lives. */}
      <TopBar
        identity={identity}
        actions={identity ? undefined : <a className="tdoc-chip signin" href="/">Make your own tdoc</a>}
      />
      <main className="wrap">
        <div className="page-hd profile-hd">
          <ProfileAvatar
            githubLogin={githubLogin}
            name={login}
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
                  <span className="profile-view-switch" role="group" aria-label="Pick layout">
                    <button
                      type="button"
                      className={`profile-icon-btn${pickView === 'compact' ? ' is-active' : ''}`}
                      aria-pressed={pickView === 'compact'}
                      title="Compact"
                      onClick={() => setView('compact')}
                    >
                      <Rows3 size={15} aria-hidden="true" />
                      <span className="ui-sr-only">Compact</span>
                    </button>
                    <button
                      type="button"
                      className={`profile-icon-btn${pickView === 'preview' ? ' is-active' : ''}`}
                      aria-pressed={pickView === 'preview'}
                      title="Preview"
                      onClick={() => setView('preview')}
                    >
                      <LayoutGrid size={15} aria-hidden="true" />
                      <span className="ui-sr-only">Preview</span>
                    </button>
                  </span>
                </>
              ) : null}
              {mine ? (
                <span className="profile-owner-actions">
                  <button
                    type="button"
                    className="profile-icon-btn"
                    title="Share"
                    aria-label="Share"
                    onClick={() => { setShareStatus(''); setModal('share'); }}
                  >
                    <Share2 size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="profile-icon-btn"
                    title="Change handle"
                    aria-label="Change handle"
                    onClick={() => { setHandleDraft(login); setHandleStatus(''); setModal('handle'); }}
                  >
                    <UserRoundPen size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="profile-icon-btn"
                    title={bio ? 'Edit bio' : 'Add bio'}
                    aria-label={bio ? 'Edit bio' : 'Add bio'}
                    onClick={() => { setBioDraft(bio); setModal('bio'); }}
                  >
                    <PencilLine size={15} aria-hidden="true" />
                  </button>
                </span>
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
              const href = doc.url || `/d/${encodeURIComponent(doc.slug)}/v/${doc.latest || 1}`;
              const published = day(doc.published || doc.updated);
              const card = !isPreview ? (
                <a className="profile-pick-card" href={href}>
                  <span className="profile-pick-body">
                    <span className="profile-pick-title">{doc.title || doc.slug}</span>
                    <span className="profile-pick-meta">
                      {published ? `Published ${published}` : ''}
                    </span>
                  </span>
                </a>
              ) : (
                <a className={`profile-pick-card has-preview${doc.image ? ' has-image' : ''}`} href={href} aria-label={doc.title || doc.slug}>
                  <span className="profile-pick-surface">
                    {doc.image ? <span className="profile-pick-media"><img src={doc.image} alt="" loading="lazy" /></span> : null}
                    <span className="profile-pick-copy">
                      <span className="profile-pick-title">{doc.title || doc.slug}</span>
                      {doc.excerpt ? <span className="profile-pick-excerpt">{doc.excerpt}</span> : null}
                    </span>
                  </span>
                  <span className="profile-pick-meta">
                    {published ? `Published ${published}` : ''}
                  </span>
                </a>
              );
              return (
                <div key={doc.slug} className="profile-pick-item">
                  {card}
                  {mine ? (
                    <button
                      type="button"
                      className="profile-icon-btn profile-pick-remove"
                      title="Remove from profile"
                      aria-label={`Remove ${doc.title || doc.slug} from profile`}
                      disabled={busy}
                      onClick={() => togglePin(doc.slug, false)}
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
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

      {modal === 'share' ? (
        <ProfileDialog
          title="Share your profile"
          onClose={() => setModal(null)}
          actions={<button type="button" className="primary" onClick={() => setModal(null)}>Done</button>}
        >
          <p className="manage-hint">
            Copy the link, or download a poster with your handle filled in.
          </p>
          <div className="profile-share-link">
            <code>{profileUrl(login)}</code>
            <button type="button" className="text-btn" onClick={copyProfileLink}>Copy link</button>
          </div>
          {shareStatus ? <p className="manage-hint">{shareStatus}</p> : null}
          <label className="profile-poster-field">
            <span>Annotation</span>
            <textarea
              rows={2}
              maxLength={120}
              value={posterAnnotation}
              onChange={(event) => setPosterAnnotation(event.target.value)}
              placeholder={DEFAULT_ANNOTATION_LINES.join('\n')}
            />
          </label>
          <label className="profile-poster-toggle">
            <input
              type="checkbox"
              checked={posterArrow}
              onChange={(event) => setPosterArrow(event.target.checked)}
            />
            <span>Curly arrow</span>
          </label>
          <ul className="profile-poster-list">
            {POSTER_KINDS.map((kind) => {
              const posterOpts = {
                showArrow: posterArrow,
                annotationLines: posterAnnotation.split('\n'),
              };
              const preview = posterFontsReady
                ? posterPreviewDataUrl(login, kind.id, posterOpts)
                : '';
              return (
                <li key={kind.id}>
                  {preview ? (
                    <img
                      className="profile-poster-preview"
                      src={preview}
                      alt={`${kind.label} preview`}
                    />
                  ) : (
                    <div className="profile-poster-preview profile-poster-preview--loading" aria-hidden="true" />
                  )}
                  <div className="profile-poster-meta">
                    <b>{kind.label}</b>
                    <span>{kind.hint}</span>
                    <button
                      type="button"
                      className="text-btn"
                      onClick={async () => {
                        await ensurePosterFonts();
                        downloadHandlePoster(login, kind.id, posterOpts);
                      }}
                    >
                      Download PNG
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </ProfileDialog>
      ) : null}

      {modal && modal.type === 'curate-warn' ? (
        <ProfileDialog
          title="Pinning makes this doc Public (searchable)"
          confirmLabel="Make Public and pin"
          onConfirm={async () => {
            const slug = modal.slug;
            setModal('picks');
            await togglePin(slug, true, { confirmed: true });
          }}
          onClose={() => setModal('picks')}
        >
          <p className="manage-hint">
            Anyone can open it from your profile, and search engines can find it.
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
          {pickNotice(true)}
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
                    <em>{catalogNote(row)}</em>
                  </span>
                </label>
              ))}
            </div>
          )}
        </ProfileDialog>
      ) : null}

      {/* Inside the dialog while it is open: a modal makes the page behind it inert. */}
      {modal !== 'picks' ? pickNotice(false) : null}
    </div>
  );
}
