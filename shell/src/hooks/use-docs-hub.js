import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createDocument,
  createFolder,
  deleteDocument,
  deleteFolder as deleteFolderRequest,
  moveDocsToFolder,
  renameFolder,
  setDocumentStar,
} from '../document/api.js';

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
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const next = folder ? `?folder=${encodeURIComponent(folder)}` : location.pathname;
    history.replaceState(null, '', next);
    setSelected(new Set());
  }, [folder]);

  const notify = useCallback((message, error = false) => setToast({ message, error }), []);

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
    const needle = query.trim().toLowerCase();
    return docs
      .filter((doc) => doc.folder === folder)
      .filter((doc) => `${doc.title} ${doc.slug}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        if (sort === 'title') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
        return String(b[sort]).localeCompare(String(a[sort]));
      });
  }, [docs, folder, query, sort]);

  const shownFolders = useMemo(() => folders
    .filter((item) => item.parent === folder)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })), [folders, folder]);

  const folderCounts = useMemo(() => {
    const counts = {};
    for (const doc of docs) counts[doc.folder] = (counts[doc.folder] || 0) + 1;
    return counts;
  }, [docs]);

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
  // there is no success toast to raise — only a failure keeps us on /me, and
  // `run` has already turned that into one.
  const createDoc = useCallback(async (title) => {
    let created = null;
    const ok = await run(async () => { created = await createDocument(title); });
    if (!ok || !created || !created.url) return false;
    location.href = created.url;
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
    const ok = await run(
      () => moveDocsToFolder(slugs, destination),
      `Moved ${plural(slugs.length, 'doc')}`,
    );
    if (!ok) return false;
    setDocs((items) => items.map((item) => (slugs.includes(item.slug) ? { ...item, folder: destination } : item)));
    setSelected(new Set());
    return true;
  }, [run]);

  const deleteDocs = useCallback(async (slugs) => {
    const ok = await run(
      () => Promise.all(slugs.map((slug) => deleteDocument(slug))),
      `Deleted ${plural(slugs.length, 'doc')}`,
    );
    if (!ok) return false;
    const keep = (items) => items.filter((item) => !slugs.includes(item.slug));
    setDocs(keep);
    setRecent(keep);
    setStarred(keep);
    setSelected(new Set());
    return true;
  }, [run]);

  const saveFolder = useCallback(async ({ id, name }) => {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    if (id) {
      let saved;
      const ok = await run(async () => { saved = (await renameFolder(id, trimmed)).folder; });
      if (!ok) return false;
      setFolders((items) => items.map((item) => (item.id === saved.id ? { ...item, name: saved.name } : item)));
      return true;
    }
    let created;
    const ok = await run(async () => { created = (await createFolder(trimmed, folder)).folder; });
    if (!ok) return false;
    setFolders((items) => [...items, { ...created, parent: created.parent || '' }]);
    return true;
  }, [folder, run]);

  const deleteFolder = useCallback(async (item) => {
    const ok = await run(() => deleteFolderRequest(item.id));
    if (!ok) return false;
    setFolders((items) => items
      .filter((candidate) => candidate.id !== item.id)
      .map((candidate) => (candidate.parent === item.id ? { ...candidate, parent: item.parent } : candidate)));
    setDocs((items) => items.map((doc) => (doc.folder === item.id ? { ...doc, folder: item.parent } : doc)));
    if (folder === item.id) setFolder(item.parent);
    return true;
  }, [folder, run]);

  return {
    docs,
    recent,
    starred,
    folders,
    folder,
    setFolder,
    folderById,
    path,
    shownDocs,
    shownFolders,
    folderCounts,
    query,
    setQuery,
    sort,
    setSort,
    selected,
    toggleSelected,
    selectAll,
    toast,
    createDoc,
    toggleStar,
    moveDocs,
    deleteDocs,
    saveFolder,
    deleteFolder,
  };
}
