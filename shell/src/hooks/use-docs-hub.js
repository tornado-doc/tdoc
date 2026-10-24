import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createDocument,
  createFolder,
  renameDocument,
  deleteDocument,
  deleteFolder as deleteFolderRequest,
  restoreFromTrash,
  moveDocsToFolder,
  renameFolder,
  updateFolderAccess,
  setDocumentStar,
} from '../document/api.js';
import { folderContents, folderPathLabel, matchesCatalogQuery, sortCatalogDocs } from '../docs-hub/search.js';

const plural = (count, word) => `${count} ${count === 1 ? word : `${word}s`}`;

// The Docs Hub's data boundary: catalog state seeded from the boot payload,
// derived views (current folder, search, sort), and the session mutations.
// Every mutation goes through `run`, so a failure always reaches the user as
// a toast and an expired session always reaches `onUnauthorized` — the page
// component never has to remember to catch.
export function useDocsHub({ boot, onUnauthorized }) {
  const [docs, setDocs] = useState(boot.docs || []);
  const [recent, setRecent] = useState(boot.recent || []);
  const [starred, setStarred] = useState(boot.starred || []);
  const [folders, setFolders] = useState(boot.folders || []);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('updated');
  const [selected, setSelected] = useState(() => new Set());
  const [toast, setToast] = useState(null);
  const [folder, setFolder] = useState(() => {
    const initial = new URLSearchParams(location.search).get('folder') || '';
    return (boot.folders || []).some((item) => item.id === initial) ? initial : '';
  });

  useEffect(() => {
    if (!toast) return undefined;
    // A toast that offers Undo stays long enough to reach for it.
    const timer = window.setTimeout(() => setToast(null), toast.action ? 8000 : 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const url = new URL(location.href);
    // Team folders are owned by the workspace view, not this personal-docs
    // hook. Preserve the unified view parameter instead of erasing it.
    if (!url.searchParams.has('team')) {
      if (folder) url.searchParams.set('folder', folder);
      else url.searchParams.delete('folder');
      url.searchParams.delete('tab');
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    setSelected(new Set());
  }, [folder]);

  // `action`: { label, run } -- one button on the toast (Undo after a delete).
  const notify = useCallback((message, error = false, action = null) => setToast({ message, error, action }), []);

  const run = useCallback(async (operation, success) => {
    try {
      await operation();
      if (success) notify(success);
      return true;
    } catch (error) {
      if (error.status === 401 && onUnauthorized) {
        onUnauthorized();
        return false;
      }
      notify(error.message || 'Request failed', true);
      return false;
    }
  }, [notify, onUnauthorized]);

  const folderById = useMemo(() => new Map(folders.map((item) => [item.id, item])), [folders]);

  const path = useMemo(() => {
    const result = [];
    let current = folderById.get(folder);
    while (current) {
      result.unshift(current);
      current = folderById.get(current.parent);
    }
    return result;
  }, [folder, folderById]);

  const shownDocs = useMemo(() => {
    const searching = Boolean(query.trim());
    return sortCatalogDocs(docs
      .filter((doc) => searching || doc.folder === folder)
      .filter((doc) => matchesCatalogQuery(doc, folderPathLabel(doc.folder, folderById), query)), sort);
  }, [docs, folder, folderById, query, sort]);

  const shownFolders = useMemo(() => folders
    .filter(() => !query.trim())
    .filter((item) => item.parent === folder)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })), [folders, folder, query]);

  const folderCounts = useMemo(() => folderContents(folders, docs), [folders, docs]);

  const toggleSelected = useCallback((slug) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    return next;
  }), []);

  const selectAll = useCallback((on) => {
    setSelected(on ? new Set(shownDocs.map((doc) => doc.slug)) : new Set());
  }, [shownDocs]);

  const paintStar = useCallback((slug, on) => {
    const update = (items) => items.map((item) => (item.slug === slug ? { ...item, starred: on } : item));
    setDocs(update);
    setRecent(update);
    setStarred((items) => {
      const found = [...docs, ...recent, ...items].find((item) => item.slug === slug);
      if (on && found && !items.some((item) => item.slug === slug)) {
        return [{ ...found, starred: true, at: new Date().toISOString() }, ...update(items)];
      }
      return on ? update(items) : items.filter((item) => item.slug !== slug);
    });
  }, [docs, recent]);

  // Start from scratch. On success the browser leaves for the new document, so
  // there is no success toast to raise — only a failure keeps us on /me.
  // Quota hits return `{ quota }` so the page can open the bump dialog instead
  // of a toast that leaves the person stuck.
  const createDoc = useCallback(async (team) => {
    try {
      const created = await createDocument(team);
      if (!created || !created.url) return false;
      location.href = created.url;
      return true;
    } catch (error) {
      if (error.status === 401 && onUnauthorized) {
        onUnauthorized();
        return false;
      }
      if (error.body?.error === 'quota_docs') {
        return { quota: error.body };
      }
      notify(error.message || 'Request failed', true);
      return false;
    }
  }, [notify, onUnauthorized]);

  // Renaming from the list, the same metadata edit the document bar performs.
  // The row updates from the title the server echoes back rather than the one
  // that was typed, so what the list shows is what was stored.
  const renameDoc = useCallback(async (slug, name) => {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    let saved;
    const ok = await run(async () => { saved = await renameDocument(slug, trimmed); });
    if (!ok) return false;
    const apply = (items) => items.map((item) => (
      item.slug === slug ? { ...item, title: saved.title } : item
    ));
    setDocs(apply);
    setRecent(apply);
    setStarred(apply);
    return true;
  }, [run]);

  const toggleStar = useCallback(async (slug, on) => {
    paintStar(slug, on);
    const ok = await run(() => setDocumentStar(slug, on));
    if (!ok) {
      paintStar(slug, !on);
      return;
    }
    try {
      new BroadcastChannel('tdoc-doc-state').postMessage({ type: 'star', slug, starred: on });
    } catch {
      // BroadcastChannel is a nicety for other open tabs, never a requirement.
    }
  }, [paintStar, run]);

  const moveDocs = useCallback(async (slugs, destination) => {
    const moved = new Set(slugs);
    const previous = docs.filter((item) => moved.has(item.slug));
    setDocs((items) => items.map((item) => (moved.has(item.slug) ? { ...item, folder: destination } : item)));
    const ok = await run(
      () => moveDocsToFolder(slugs, destination),
      `Moved ${plural(slugs.length, 'doc')}`,
    );
    if (!ok) {
      const bySlug = new Map(previous.map((item) => [item.slug, item]));
      setDocs((items) => items.map((item) => bySlug.get(item.slug) || item));
      return false;
    }
    setSelected(new Set());
    return true;
  }, [docs, run]);

  // Delete moves the docs to Trash; the toast's Undo takes them straight back
  // out, rows and all, without a reload.
  const deleteDocs = useCallback(async (slugs) => {
    const ok = await run(() => Promise.all(slugs.map((slug) => deleteDocument(slug))));
    if (!ok) return false;
    const gone = new Set(slugs);
    const before = { docs, recent, starred };
    const keep = (items) => items.filter((item) => !gone.has(item.slug));
    setDocs(keep);
    setRecent(keep);
    setStarred(keep);
    setSelected(new Set());
    notify(`Moved ${plural(slugs.length, 'doc')} to Trash`, false, {
      label: 'Undo',
      run: async () => {
        const back = await run(
          () => Promise.all(slugs.map((slug) => restoreFromTrash({ slug }))),
          `Restored ${plural(slugs.length, 'doc')}`,
        );
        if (!back) return;
        const putBack = (list, items) => [...list.filter((item) => gone.has(item.slug)), ...keep(items)];
        setDocs((items) => putBack(before.docs, items));
        setRecent((items) => putBack(before.recent, items));
        setStarred((items) => putBack(before.starred, items));
      },
    });
    return true;
  }, [docs, recent, starred, notify, run]);

  const saveFolder = useCallback(async ({ id, name }) => {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    if (id) {
      let saved;
      const ok = await run(async () => { saved = (await renameFolder(id, trimmed)).folder; });
      if (!ok) return false;
      setFolders((items) => items.map((item) => (item.id === saved.id ? { ...item, ...saved } : item)));
      return true;
    }
    let created;
    const ok = await run(async () => { created = (await createFolder(trimmed, folder)).folder; });
    if (!ok) return false;
    setFolders((items) => [...items, { ...created, parent: created.parent || '' }]);
    return true;
  }, [folder, run]);

  const setFolderAccess = useCallback(async (id, patch) => {
    let saved;
    const ok = await run(async () => { saved = (await updateFolderAccess(id, patch)).folder; });
    if (!ok) return null;
    // share_id spelled out: after "Stop sharing" the reply has none.
    setFolders((items) => items.map((item) => (item.id === saved.id ? { ...item, ...saved, share_id: saved.share_id } : item)));
    return saved;
  }, [run]);

  // A folder goes to Trash with its subfolders and the docs in them; Undo
  // brings the whole tree back.
  const deleteFolder = useCallback(async (item) => {
    let result;
    const ok = await run(async () => { result = await deleteFolderRequest(item.id); });
    if (!ok) return false;
    const before = { docs, folders, recent, starred };
    const tree = new Set([item.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const candidate of folders) if (tree.has(candidate.parent) && !tree.has(candidate.id)) { tree.add(candidate.id); grew = true; }
    }
    const trashed = new Set((result && result.docs) || []);
    const keep = (items) => items.filter((doc) => !trashed.has(doc.slug));
    setFolders((items) => items.filter((candidate) => !tree.has(candidate.id)));
    // Whatever stayed behind (docs it could not delete) moves up a level.
    setDocs((items) => keep(items).map((doc) => (tree.has(doc.folder) ? { ...doc, folder: item.parent } : doc)));
    setRecent(keep);
    setStarred(keep);
    if (tree.has(folder)) setFolder(item.parent);
    notify(`Moved “${item.name}”${trashed.size ? ` and ${plural(trashed.size, 'doc')}` : ''} to Trash`, false, {
      label: 'Undo',
      run: async () => {
        const back = await run(() => restoreFromTrash({ folder: item.id }), `Restored “${item.name}”`);
        if (!back) return;
        setFolders(before.folders);
        setDocs(before.docs);
        setRecent(before.recent);
        setStarred(before.starred);
      },
    });
    return true;
  }, [docs, folders, recent, starred, folder, notify, run]);

  return {
    docs,
    setDocs,
    recent,
    setRecent,
    starred,
    setStarred,
    folders,
    setFolders,
    folder,
    setFolder,
    folderById,
    path,
    shownDocs,
    shownFolders,
    folderCounts,
    pathForDoc: (doc) => folderPathLabel(doc.folder, folderById),
    query,
    setQuery,
    sort,
    setSort,
    selected,
    setSelected,
    toggleSelected,
    selectAll,
    toast,
    notify,
    dismissToast: () => setToast(null),
    createDoc,
    renameDoc,
    toggleStar,
    moveDocs,
    deleteDocs,
    saveFolder,
    setFolderAccess,
    deleteFolder,
  };
}
