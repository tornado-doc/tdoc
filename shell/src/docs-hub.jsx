import React, { useState } from 'react';
import { Check, ChevronRight, Folder, FolderPlus, Search, X } from 'lucide-react';
import { TopBar } from './top-bar.jsx';
import { AppDialog } from './ui/dialog.jsx';
import { DocRow, FolderRow, day } from './docs-hub/rows.jsx';
import { FIRST_DOC_RECIPE } from './onboarding-dialog.jsx';
import { copyText } from './document/model.js';
import { useDocsHub } from './hooks/use-docs-hub.js';
import './docs-hub.css';

const TABS = [['mine', 'My docs'], ['recent', 'Recent'], ['starred', 'Starred']];

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

function FolderNameDialog({ title, confirmLabel, initialName, onSave, onClose }) {
  const [name, setName] = useState(initialName);
  const save = () => onSave(name);
  return (
    <HubDialog title={title} confirmLabel={confirmLabel} onConfirm={save} onClose={onClose}>
      <input
        type="text"
        maxLength="60"
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
      />
    </HubDialog>
  );
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
          meta={`${doc.owner && doc.owner !== viewer ? `by ${doc.owner} · ` : ''}${label} ${day(doc.at)}`}
          onToggleStar={onToggleStar}
        />
      ))}
    </div>
  );
}

// Page-level orchestrator for /me. State and mutations live in useDocsHub;
// rows and menus are the shared docs-hub/rows.jsx components; every modal is
// the AppDialog facade. This component only decides what is on screen.
export function DocsHub({ boot }) {
  const capabilities = { folders: true, delete: true, star: true, ...(boot.capabilities || {}) };
  const viewer = boot.identity?.login || '';
  const hub = useDocsHub({
    boot,
    // /me is session-gated by the server; a 401 mid-visit means the session
    // expired, and the route's own redirect is the sign-in path.
    onUnauthorized: () => { location.href = '/?notice=signin'; },
  });
  const [tab, setTab] = useState('mine');
  const [modal, setModal] = useState(null);
  const [createCopied, setCreateCopied] = useState(false);
  const closeModal = () => setModal(null);
  const closeIf = (promise) => promise.then((ok) => { if (ok) closeModal(); });
  const openCreateHelp = () => {
    setCreateCopied(false);
    setModal({ type: 'create-help' });
  };
  const copyFirstDocRecipe = () => copyText(FIRST_DOC_RECIPE).then(setCreateCopied);

  const docMenu = (slugs) => [
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
      <TopBar identity={boot.identity} />
      <main className="wrap">
        <div className="page-hd">
          <h1>My docs</h1>
          <button className="mk-btn" type="button" onClick={openCreateHelp}>Create a doc</button>
        </div>
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
                    `${doc.slug} · v${doc.latest}`,
                    day(doc.updated) ? `updated ${day(doc.updated)}` : null,
                    doc.folder ? `in ${hub.folderById.get(doc.folder)?.name || ''}` : null,
                  ].filter(Boolean).join(' · ')}
                  selection={{ checked: hub.selected.has(doc.slug), onChange: () => hub.toggleSelected(doc.slug) }}
                  starrable={capabilities.star}
                  onToggleStar={hub.toggleStar}
                  menuItems={docMenu([doc.slug])}
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

      {modal?.type === 'create-help' ? (
        <HubDialog
          title="Create a doc"
          onClose={closeModal}
          actions={<button type="button" className="primary" onClick={closeModal}>Done</button>}
        >
          <p>Paste this into your AI. It installs tdoc, builds your personal AI portrait, publishes it privately, and gives you the link.</p>
          <div className="tdoc-recipe-wrap">
            <code>{FIRST_DOC_RECIPE}</code>
            <button type="button" className={createCopied ? 'done' : undefined} onClick={copyFirstDocRecipe}>
              {createCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </HubDialog>
      ) : null}
      {modal?.type === 'new-folder' ? (
        <FolderNameDialog title="New folder" confirmLabel="Create" initialName="" onClose={closeModal}
          onSave={(name) => closeIf(hub.saveFolder({ name }))} />
      ) : null}
      {modal?.type === 'rename-folder' ? (
        <FolderNameDialog title="Rename folder" confirmLabel="Save" initialName={modal.folder.name} onClose={closeModal}
          onSave={(name) => closeIf(hub.saveFolder({ id: modal.folder.id, name }))} />
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
