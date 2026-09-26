import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Folder, FolderPlus, Search, X } from 'lucide-react';
import { TopBar } from './top-bar.jsx';
import { AppDialog } from './ui/dialog.jsx';
import { AgentRecipe, CreateMenu } from './create-from-scratch.jsx';
import { DocRow, FolderRow, day } from './docs-hub/rows.jsx';
import { OnboardingChecklist } from './docs-hub/onboarding-checklist.jsx';
import { DebugBar } from './debug-bar.jsx';
import { copyText } from './document/model.js';
import { InviteField } from './document/owner-access-dialog.jsx';
import { QuotaBumpDialog } from './document/document-dialogs.jsx';
import { useDocsHub } from './hooks/use-docs-hub.js';
import { markShareAfterNav } from './profile-posters.js';
import './docs-hub.css';

const TABS = [['mine', 'My docs'], ['recent', 'Recent'], ['starred', 'Starred']];
const CURATE_WARN_KEY = 'tdoc.curateWarned';

function needsCurateWarn() {
  try { return localStorage.getItem(CURATE_WARN_KEY) !== '1'; } catch { return true; }
}

function markCurateWarned() {
  try { localStorage.setItem(CURATE_WARN_KEY, '1'); } catch { /* ignore */ }
}

function HubDialog({ title, children, confirmLabel, danger, onConfirm, onClose, actions }) {
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={title}
      actions={actions || (
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          {onConfirm ? (
            <button type="button" className={danger ? 'danger' : 'primary'} onClick={onConfirm}>
              {confirmLabel}
            </button>
          ) : null}
        </>
      )}
    >
      {children}
    </AppDialog>
  );
}

// A name prompt. Folders were its first caller; renaming a document is its
// second, and neither wants its own copy of an input that commits on Enter.
function NameDialog({ title, confirmLabel, initialName, maxLength = 60, onSave, onClose }) {
  const [name, setName] = useState(initialName);
  const save = () => onSave(name);
  return (
    <HubDialog title={title} confirmLabel={confirmLabel} onConfirm={save} onClose={onClose}>
      <input
        type="text"
        maxLength={maxLength}
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
      />
    </HubDialog>
  );
}

function FolderShareDialog({ folder, onClose, onAccess }) {
  const [visibility, setVisibility] = useState(folder.visibility === 'private' ? 'private' : 'unlisted');
  const [allowedUsers, setAllowedUsers] = useState(() => folder.allowed_users || []);
  const [shareId, setShareId] = useState(folder.share_id || '');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const savedRef = useRef({
    visibility: folder.visibility === 'private' ? 'private' : 'unlisted',
    allowed_users: folder.allowed_users || [],
    share_id: folder.share_id || '',
  });

  useEffect(() => {
    setVisibility(savedRef.current.visibility);
    setAllowedUsers(savedRef.current.allowed_users);
    setShareId(savedRef.current.share_id);
  }, [folder.id]);

  const shareUrl = shareId
    ? `${location.origin}/f/${encodeURIComponent(shareId)}`
    : '';
  const invitedCount = allowedUsers.length;
  const accessDescription = visibility !== 'private'
    ? 'Anyone with the link sees docs they already have permission to read.'
    : invitedCount
      ? `Only you and ${invitedCount} invited ${invitedCount === 1 ? 'person' : 'people'} can open this folder. Docs keep their own access.`
      : 'Only you can open this folder. Add people below to invite them.';

  const save = async (patch) => {
    const previous = { visibility, allowedUsers, shareId };
    const nextVisibility = patch.visibility ?? visibility;
    const nextAllowed = patch.allowed_users ?? allowedUsers;
    setVisibility(nextVisibility);
    setAllowedUsers(nextAllowed);
    setBusy(true);
    setStatus('Saving…');
    const saved = await onAccess({ visibility: nextVisibility, allowed_users: nextAllowed });
    setBusy(false);
    if (!saved) {
      setVisibility(previous.visibility);
      setAllowedUsers(previous.allowedUsers);
      setShareId(previous.shareId);
      setStatus('Could not save.');
      return;
    }
    const next = {
      visibility: saved.visibility === 'private' ? 'private' : 'unlisted',
      allowed_users: saved.allowed_users || [],
      share_id: saved.share_id || '',
    };
    savedRef.current = next;
    setVisibility(next.visibility);
    setAllowedUsers(next.allowed_users);
    setShareId(next.share_id);
    setStatus('Saved.');
  };

  return (
    <HubDialog
      title="Share"
      onClose={onClose}
      actions={<button type="button" onClick={onClose}>Close</button>}
    >
      {shareUrl ? (
        <>
          <div className="code url" onClick={() => copyText(shareUrl)}>
            {shareUrl}
          </div>
          <div className="actions" style={{ justifyContent: 'flex-start', marginTop: 0 }}>
            <button type="button" className="primary" disabled={busy} onClick={() => copyText(shareUrl).then(() => setStatus('Copied.'))}>
              Copy link
            </button>
          </div>
        </>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          Choose who has access to mint a share link.
        </p>
      )}
      <p className="muted" style={{ margin: '8px 0 0' }}>
        {folder.name} · docs keep their own access
      </p>

      <section className="manage-section">
        <label className="field" htmlFor="tdoc-folder-access">Who has access</label>
        <select
          id="tdoc-folder-access"
          className="tdoc-select"
          value={visibility}
          disabled={busy}
          onChange={(event) => save({ visibility: event.target.value })}
        >
          <option value="private">Only people I invite</option>
          <option value="unlisted">Anyone with the link</option>
        </select>
        <p className="manage-hint">{accessDescription}</p>

        {visibility === 'private' ? (
          <>
            <label className="field">Invite by GitHub username</label>
            <InviteField
              users={allowedUsers}
              onChange={(users) => save({ allowed_users: users })}
            />
          </>
        ) : null}
      </section>
      {status ? <p className="muted" style={{ margin: '8px 0 0' }}>{status}</p> : null}
    </HubDialog>
  );
}

// One rule for every list: a document says whose it is, and your own say "me",
// the way a docs list's Owner column reads. A document with nobody recorded —
// published before hosted accounts, or living on a self-hosted worker — says
// nothing rather than guessing.
function ownerLabel(doc, viewer) {
  if (doc.mine) return 'me';
  if (!doc.owner) return null;
  return viewer && doc.owner === viewer ? 'me' : doc.owner;
}

function FlatList({ docs, label, viewer, empty, onToggleStar }) {
  if (!docs.length) return <p className="empty">{empty}</p>;
  return (
    <div className="doc-list">
      {docs.map((doc) => (
        <DocRow
          key={doc.slug}
          doc={doc}
          className="flat-row"
          meta={[ownerLabel(doc, viewer), `${label} ${day(doc.at)}`].filter(Boolean).join(' · ')}
          onToggleStar={onToggleStar}
        />
      ))}
    </div>
  );
}

// Claim or change via the same AppDialog / HubDialog surface as rename +
// folder share. Letters/numbers/hyphens; changing frees the previous @handle.
function ClaimHandleDialog({ suggested, current, onClose }) {
  const changing = Boolean(current);
  const [name, setName] = useState(suggested || current || '');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setStatus('');
    try {
      const r = await fetch('/api/me/handle', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: name }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus(
          body.error === 'handle_taken' ? 'That handle is taken.'
            : body.error === 'reserved_handle' ? 'That name is reserved.'
            : body.error === 'invalid_handle' ? 'Use letters, numbers, and hyphens.'
            : body.error === 'sign_in_required' ? 'Sign in again, then retry.'
            : body.error === 'forbidden' ? 'This account cannot claim a handle here.'
            : body.error ? `Could not claim (${body.error}).`
            : 'Could not claim handle.',
        );
        setBusy(false);
        return;
      }
      markShareAfterNav();
      if (body.url) location.assign(body.url.includes('?') ? `${body.url}&share=1` : `${body.url}?share=1`);
      else location.reload();
    } catch {
      setStatus('Could not claim handle.');
      setBusy(false);
    }
  };

  return (
    <HubDialog
      title={changing ? 'Change your public URL' : 'Claim your public URL'}
      confirmLabel={busy ? (changing ? 'Saving…' : 'Claiming…') : (changing ? 'Save' : 'Claim')}
      onConfirm={save}
      onClose={onClose}
    >
      <p className="manage-hint">
        {changing
          ? 'Public docs show at tdoc.dev/@handle. Changing frees the old name.'
          : 'Public docs show at tdoc.dev/@handle. Letters, numbers, hyphens.'}
      </p>
      <label className="field" htmlFor="tdoc-handle-claim">Handle</label>
      <input
        id="tdoc-handle-claim"
        type="text"
        maxLength={39}
        autoFocus
        disabled={busy}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
        placeholder={suggested || current || 'you'}
      />
      {status ? <p className="manage-hint">{status}</p> : null}
    </HubDialog>
  );
}

// Page-level orchestrator for /me. State and mutations live in useDocsHub;
// rows and menus are the shared docs-hub/rows.jsx components; every modal is
// the AppDialog facade. This component only decides what is on screen.
export function DocsHub({ boot }) {
  const capabilities = { folders: true, delete: true, star: true, create: true, ...(boot.capabilities || {}) };
  const viewer = boot.identity?.login || '';
  const hub = useDocsHub({
    boot,
    // /me is session-gated by the server; a 401 mid-visit means the session
    // expired, and the route's own redirect is the sign-in path.
    onUnauthorized: () => { location.href = '/?notice=signin'; },
  });
  const [tab, setTab] = useState('mine');
  const [modal, setModal] = useState(null);
  const [pins, setPins] = useState(() => new Set(boot.profile?.pins || []));
  const closeModal = () => setModal(null);
  const closeIf = (promise) => promise.then((ok) => { if (ok) closeModal(); });
  const openAgentRecipe = () => setModal({ type: 'create-agent' });

  const toggleProfilePin = async (doc, { confirmed = false } = {}) => {
    if (!doc || !doc.slug || !boot.profile || !doc.mine) return;
    const next = !pins.has(doc.slug);
    if (next && !confirmed && needsCurateWarn()) {
      setModal({ type: 'curate-warn', doc });
      return;
    }
    const previous = new Set(pins);
    setPins((cur) => {
      const copy = new Set(cur);
      if (next) copy.add(doc.slug);
      else copy.delete(doc.slug);
      return copy;
    });
    try {
      const r = await fetch('/api/me/profile/pin', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: doc.slug, pinned: next }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setPins(previous);
        return;
      }
      if (next) markCurateWarned();
      if (Array.isArray(body.pins)) setPins(new Set(body.pins));
    } catch {
      setPins(previous);
    }
  };

  const docMenu = (slugs, doc) => [
    doc && (doc.mine || !doc.owner || doc.owner === viewer) ? {
      label: 'Rename',
      className: 'row-rename',
      onSelect: () => setModal({ type: 'rename-doc', doc }),
    } : null,
    // Author only — curate is a doc permission flag, not a collaborator action.
    boot.profile && doc && doc.mine ? {
      label: pins.has(doc.slug) ? 'Remove from profile' : 'Show on profile',
      className: 'row-profile-pin',
      onSelect: () => toggleProfilePin(doc),
    } : null,
    capabilities.folders ? {
      label: 'Move to folder',
      className: 'row-move',
      onSelect: () => setModal({ type: 'move', slugs }),
    } : null,
    capabilities.delete ? {
      label: 'Delete',
      tone: 'danger',
      className: 'row-delete',
      onSelect: () => setModal({ type: 'delete-docs', slugs }),
    } : null,
  ].filter(Boolean);

  const folderMenu = (item) => [
    { label: 'Share', onSelect: () => setModal({ type: 'share-folder', folder: item }) },
    { label: 'Rename', onSelect: () => setModal({ type: 'rename-folder', folder: item }) },
    {
      label: 'Delete folder',
      tone: 'danger',
      className: 'folder-delete',
      onSelect: () => setModal({ type: 'delete-folder', folder: item }),
    },
  ];

  const allSelected = hub.shownDocs.length > 0 && hub.shownDocs.every((doc) => hub.selected.has(doc.slug));
  const batchActions = capabilities.folders || capabilities.delete;

  return (
    <div className="tdoc-app docs-hub">
      <TopBar
        identity={boot.identity}
        profile={boot.profile || null}
        onClaimProfile={boot.profile ? () => setModal({ type: 'claim-handle' }) : null}
      />
      <main className="wrap">
        <div className="page-hd">
          <h1>My docs</h1>
          <CreateMenu
            create={hub.createDoc}
            canCreate={capabilities.create}
            onAgent={openAgentRecipe}
            onQuota={(quota) => setModal({ type: 'quota-bump', quota })}
            trigger={<button className="mk-btn" type="button">Create a doc</button>}
          />
        </div>

        <OnboardingChecklist record={boot.onboarding} docs={hub.docs} />
        {/* The checklist is on this page, so all six states show a difference
            here -- this is the one surface that has a face for every one. */}
        {boot.debug ? (
          <DebugBar record={boot.onboarding} surface="hub" onState={() => location.reload()} />
        ) : null}
        <div className="tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`tab${tab === id ? ' is-active' : ''}`}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'mine' ? (
          <section className="pane" id="pane-mine">
            <div className="toolbar">
              <label className="search-field">
                <Search size={15} />
                <input
                  type="search"
                  value={hub.query}
                  onChange={(event) => hub.setQuery(event.target.value)}
                  placeholder="Search title or slug"
                  aria-label="Search docs"
                />
              </label>
              <select value={hub.sort} onChange={(event) => hub.setSort(event.target.value)} aria-label="Sort docs">
                <option value="updated">Last updated</option>
                <option value="created">Created</option>
                <option value="title">Title</option>
              </select>
              {capabilities.folders ? (
                <button type="button" className="new-folder-btn" onClick={() => setModal({ type: 'new-folder' })}>
                  <FolderPlus size={15} /> New folder
                </button>
              ) : null}
            </div>

            {hub.path.length ? (
              <nav className="crumbs" aria-label="Folder path">
                <button className="crumb-root" type="button" onClick={() => hub.setFolder('')}>My docs</button>
                {hub.path.map((item) => (
                  <React.Fragment key={item.id}>
                    <ChevronRight className="sep" size={14} />
                    <button className="crumb-root cur" type="button" onClick={() => hub.setFolder(item.id)}>{item.name}</button>
                  </React.Fragment>
                ))}
              </nav>
            ) : null}

            <div className="batch-bar">
              <label className="select-all">
                <input type="checkbox" checked={allSelected} onChange={(event) => hub.selectAll(event.target.checked)} />
                {' '}
                <span>{hub.selected.size ? `${hub.selected.size} selected` : 'Select all'}</span>
              </label>
              {hub.selected.size && batchActions ? (
                <span className="batch-actions">
                  {capabilities.folders ? (
                    <button type="button" className="batch-move is-visible" onClick={() => setModal({ type: 'move', slugs: [...hub.selected] })}>Move</button>
                  ) : null}
                  {capabilities.delete ? (
                    <button type="button" className="batch-delete is-visible" onClick={() => setModal({ type: 'delete-docs', slugs: [...hub.selected] })}>Delete selected</button>
                  ) : null}
                </span>
              ) : null}
            </div>

            <div id="folder-rows">
              {hub.shownFolders.map((item) => (
                <FolderRow
                  key={item.id}
                  folder={item}
                  count={hub.folderCounts[item.id] || 0}
                  onOpen={() => hub.setFolder(item.id)}
                  menuItems={folderMenu(item)}
                />
              ))}
            </div>
            <div className={`doc-list${hub.selected.size ? ' is-selecting' : ''}`}>
              {hub.shownDocs.map((doc) => (
                <DocRow
                  key={doc.slug}
                  doc={doc}
                  meta={[
                    ownerLabel(doc, viewer),
                    day(doc.created) ? `published ${day(doc.created)}` : null,
                    day(doc.updated) && day(doc.updated) !== day(doc.created)
                      ? `updated ${day(doc.updated)}`
                      : null,
                    doc.folder ? `in ${hub.folderById.get(doc.folder)?.name || ''}` : null,
                  ].filter(Boolean).join(' · ')}
                  selection={{ checked: hub.selected.has(doc.slug), onChange: () => hub.toggleSelected(doc.slug) }}
                  starrable={capabilities.star}
                  onToggleStar={hub.toggleStar}
                  menuItems={docMenu([doc.slug], doc)}
                  data={{ created: doc.created, updated: doc.updated, folder: doc.folder }}
                />
              ))}
            </div>
            {!hub.shownDocs.length && !hub.shownFolders.length ? (
              <p className="empty">{hub.query ? 'No matches.' : 'No published docs here.'}</p>
            ) : null}
          </section>
        ) : null}

        {tab === 'recent' ? (
          <section className="pane" id="pane-recent">
            <FlatList docs={hub.recent} label="visited" viewer={viewer} empty="Docs you open show up here." onToggleStar={hub.toggleStar} />
          </section>
        ) : null}
        {tab === 'starred' ? (
          <section className="pane" id="pane-starred">
            <FlatList docs={hub.starred} label="starred" viewer={viewer} empty="Star docs to find them again quickly." onToggleStar={hub.toggleStar} />
          </section>
        ) : null}
      </main>

      {modal?.type === 'claim-handle' ? (
        <ClaimHandleDialog
          suggested={boot.profile?.suggested || ''}
          onClose={closeModal}
        />
      ) : null}
      {modal?.type === 'create-agent' ? (
        <HubDialog
          title="Build it with your agent"
          onClose={closeModal}
          actions={<button type="button" onClick={closeModal}>Close</button>}
        >
          <AgentRecipe />
        </HubDialog>
      ) : null}
      {modal?.type === 'quota-bump' ? (
        <QuotaBumpDialog
          open
          used={modal.quota?.used}
          limit={modal.quota?.limit}
          onClose={closeModal}
          onBumped={() => hub.notify('Limit raised — try creating again')}
        />
      ) : null}
      {modal?.type === 'rename-doc' ? (
        <NameDialog
          title="Rename doc"
          confirmLabel="Rename"
          initialName={modal.doc.title || ''}
          maxLength={120}
          onClose={closeModal}
          onSave={(name) => closeIf(hub.renameDoc(modal.doc.slug, name))}
        />
      ) : null}
      {modal?.type === 'new-folder' ? (
        <NameDialog title="New folder" confirmLabel="Create" initialName="" onClose={closeModal}
          onSave={(name) => closeIf(hub.saveFolder({ name }))} />
      ) : null}
      {modal?.type === 'rename-folder' ? (
        <NameDialog title="Rename folder" confirmLabel="Save" initialName={modal.folder.name} onClose={closeModal}
          onSave={(name) => closeIf(hub.saveFolder({ id: modal.folder.id, name }))} />
      ) : null}
      {modal?.type === 'share-folder' ? (
        <FolderShareDialog
          folder={hub.folders.find((item) => item.id === modal.folder.id) || modal.folder}
          onClose={closeModal}
          onAccess={(patch) => hub.setFolderAccess(modal.folder.id, patch)}
        />
      ) : null}
      {modal?.type === 'move' ? (
        <HubDialog title="Move to folder" onClose={closeModal}>
          <div className="move-list">
            <button type="button" onClick={() => closeIf(hub.moveDocs(modal.slugs, ''))}>My docs</button>
            {hub.folders.map((item) => (
              <button key={item.id} type="button" onClick={() => closeIf(hub.moveDocs(modal.slugs, item.id))}>
                <Folder size={15} /> {item.name}
              </button>
            ))}
          </div>
        </HubDialog>
      ) : null}
      {modal?.type === 'curate-warn' ? (
        <HubDialog
          title="Show on your profile?"
          confirmLabel="Show on profile"
          onConfirm={() => {
            const doc = modal.doc;
            closeModal();
            toggleProfilePin(doc, { confirmed: true });
          }}
          onClose={closeModal}
        >
          <p className="manage-hint">
            This makes the doc public so anyone can open the link from your profile.
            Taking it down later restores the previous access. Only you can curate your own docs.
          </p>
        </HubDialog>
      ) : null}
      {modal?.type === 'delete-docs' ? (
        <HubDialog
          title={`Delete ${modal.slugs.length === 1 ? 'this doc' : `${modal.slugs.length} docs`}?`}
          confirmLabel="Delete"
          danger
          onConfirm={() => closeIf(hub.deleteDocs(modal.slugs))}
          onClose={closeModal}
        >
          <p>This permanently removes every version and comment. This cannot be undone.</p>
        </HubDialog>
      ) : null}
      {modal?.type === 'delete-folder' ? (
        <HubDialog
          title={`Delete ${modal.folder.name}?`}
          confirmLabel="Delete folder"
          danger
          onConfirm={() => closeIf(hub.deleteFolder(modal.folder))}
          onClose={closeModal}
        >
          <p>Its contents move up one level. Documents are not deleted.</p>
        </HubDialog>
      ) : null}

      {hub.toast ? (
        <div className={`tdoc-toast${hub.toast.error ? ' error' : ''}`} role="status">
          {hub.toast.error ? <X size={15} /> : <Check size={15} />}
          {hub.toast.message}
        </div>
      ) : null}
    </div>
  );
}
