import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Folder, Trash2 } from 'lucide-react';
import { RowMenu, day } from './rows.jsx';
import { AppDialog } from '../ui/dialog.jsx';
import { deleteForever, listTrash, restoreFromTrash } from '../document/api.js';
import { recentTrash } from '../recent-trash.js';

const plural = (count, word) => `${count} ${count === 1 ? word : `${word}s`}`;

export function trashDaysLabel(daysLeft) {
  const n = Number(daysLeft) || 0;
  return n <= 0 ? 'Deleted for good today' : `${plural(n, 'day')} left`;
}

// What a doc or a folder in Trash is, to the restore and purge routes.
export function trashTarget(item, team) {
  return item.kind === 'folder'
    ? { folder: item.id, ...(team ? { team: team.id } : {}) }
    : { slug: item.slug };
}

// One Trash per space: My docs' (the owner's own docs and folders) or a
// team's (what its admins, or a folder's maker, could delete). The server
// filters rows by who may restore them, so an empty list is the honest
// answer for a member who could not delete anything. Rows are the catalog's
// own doc rows: nothing in Trash opens, so the title is text, not a link.
export function TrashPane({ team, notify, onChanged, onFailed }) {
  const [items, setItems] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState('');
  const keyOf = (item) => (item.kind === 'folder' ? `folder:${item.id}` : item.slug);
  // The page hands a fresh handler every render; the list loads once per space.
  const failed = useRef(onFailed);
  failed.current = onFailed;
  const teamId = team ? team.id : '';

  const load = useCallback(() => {
    setItems(null);
    const recent = recentTrash();
    listTrash(teamId, {
      slugs: recent.map((item) => item.slug).filter(Boolean),
      folders: recent.map((item) => item.folder).filter(Boolean),
    })
      .then((body) => setItems(Array.isArray(body?.items) ? body.items : []))
      .catch((error) => { setItems([]); failed.current(error); });
  }, [teamId]);
  useEffect(() => { load(); }, [load]);

  const drop = (item) => setItems((list) => (list || []).filter((row) => keyOf(row) !== keyOf(item)));

  const restore = async (item) => {
    setBusy(keyOf(item));
    try {
      await restoreFromTrash(trashTarget(item, team));
      drop(item);
      notify(`Restored “${item.title}”`);
      onChanged();
    } catch (error) {
      onFailed(error);
    } finally {
      setBusy('');
    }
  };

  const purge = async (item) => {
    setBusy(keyOf(item));
    try {
      await deleteForever(trashTarget(item, team));
      drop(item);
      setConfirm(null);
      notify(`Deleted “${item.title}” for good`);
    } catch (error) {
      onFailed(error);
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="pane" id="pane-trash">
      <p className="loc-hint trash-hint">
        Deleted docs wait here for 30 days, then they are deleted for good. Until they are restored nobody can open them, agents included.
      </p>
      {items === null ? (
        <p className="empty">Loading…</p>
      ) : !items.length ? (
        <p className="empty">Trash is empty.</p>
      ) : (
        <div className="doc-list is-list trash-list">
          {items.map((item) => (
            <div
              className="doc-row trash-row"
              key={keyOf(item)}
              data-kind={item.kind}
              data-slug={item.slug || undefined}
              data-folder-id={item.id || undefined}
              data-title={item.title}
            >
              {item.kind === 'folder' ? <span className="folder-ico"><Folder size={18} /></span> : null}
              <div className="doc-info">
                <span className="doc-title">{item.title}</span>
                <div className="doc-meta">
                  {[
                    item.kind === 'folder' ? `Folder · ${plural(item.doc_count || 0, 'doc')}` : null,
                    item.trashed_by ? `deleted by ${item.trashed_by}` : 'deleted',
                    day(item.trashed_at) ? `on ${day(item.trashed_at)}` : null,
                  ].filter(Boolean).join(' · ')}
                </div>
              </div>
              <span className={`trash-days${item.days_left <= 3 ? ' is-soon' : ''}`}>{trashDaysLabel(item.days_left)}</span>
              <div className="row-actions trash-actions">
                <button
                  type="button"
                  className="trash-restore"
                  disabled={busy === keyOf(item)}
                  onClick={() => restore(item)}
                >
                  Restore
                </button>
                <RowMenu
                  label={`More actions for ${item.title}`}
                  // A team doc's author may restore it; erasing it is an admin's call.
                  items={item.can_purge === false ? [] : [{
                    label: 'Delete forever',
                    tone: 'danger',
                    className: 'trash-purge',
                    icon: <Trash2 size={15} />,
                    onSelect: () => setConfirm(item),
                  }]}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {confirm ? (
        <AppDialog
          open
          onOpenChange={(open) => { if (!open) setConfirm(null); }}
          title={`Delete “${confirm.title}” forever?`}
          actions={(
            <>
              <button type="button" onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="danger trash-purge-confirm" disabled={busy === keyOf(confirm)} onClick={() => purge(confirm)}>
                Delete forever
              </button>
            </>
          )}
        >
          <p>
            {confirm.kind === 'folder'
              ? `The folder and its ${plural(confirm.doc_count || 0, 'doc')}, with every version and comment, are erased now. This cannot be undone.`
              : 'Every version and comment is erased now. This cannot be undone.'}
          </p>
        </AppDialog>
      ) : null}
    </section>
  );
}
