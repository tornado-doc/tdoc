const DB_NAME = 'tdoc-browser-drafts';
const STORE_NAME = 'drafts';
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('indexeddb_unavailable'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

function storageKey(key) {
  return `tdoc-draft:${key}`;
}

function readLocalRecord(key) {
  try {
    const value = localStorage.getItem(storageKey(key));
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeLocalRecord(key, value) {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    // IndexedDB remains the large-draft fallback.
  }
}

function recordStamp(record) {
  const updated = Number(record?.updatedAt || 0);
  const bodyUpdated = Number(record?.bodyUpdatedAt || 0);
  return Math.max(
    Number.isFinite(updated) ? updated : 0,
    Number.isFinite(bodyUpdated) ? bodyUpdated : 0,
  );
}

async function readRecord(key) {
  const local = readLocalRecord(key);
  try {
    const indexed = await transact('readonly', (store) => store.get(key)) || null;
    const value = recordStamp(local) >= recordStamp(indexed) ? local : indexed;
    if (value === indexed && indexed) writeLocalRecord(key, indexed);
    return value;
  } catch {
    return local;
  }
}

async function writeRecord(key, value) {
  // localStorage is deliberately first and synchronous. If the page reloads
  // before the IndexedDB request settles, the newest keystroke is still there.
  writeLocalRecord(key, value);
  try {
    await transact('readwrite', (store) => store.put(value, key));
  } catch {}
}

async function deleteRecord(key) {
  try { localStorage.removeItem(storageKey(key)); } catch {}
  try {
    await transact('readwrite', (store) => store.delete(key));
  } catch {}
}

// Per document, not per version and not a global last-mode. A draft started
// on v1 has to be able to surface when the author opens v2 of the same doc.
//
// Multi-tab/collaboration note: this intentionally remains one record per
// author + document, so concurrent tabs currently use last-write-wins. Before
// supporting simultaneous editors, give each editing session its own id and
// revision, announce newer drafts with BroadcastChannel (or a server-side
// revision), and prompt instead of silently replacing an active editor. A
// successful save must then clear only the session it published.
export function draftKey(config) {
  const author = config.identity?.login || 'local';
  return `${config.slug}:${author}`;
}

export function legacyDraftKey(config) {
  const author = config.identity?.login || 'local';
  return `${config.slug}:v${config.version}:${author}`;
}

export function htmlHash(html) {
  const value = String(html || '');
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) + value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export function formatDraftAge(updatedAt, now = Date.now()) {
  const stamped = Number(updatedAt);
  const current = Number(now);
  if (!Number.isFinite(stamped) || stamped <= 0) return 'recently';
  const ms = Math.max(0, (Number.isFinite(current) ? current : Date.now()) - stamped);
  if (ms < 45_000) return 'just now';
  if (ms < 90_000) return 'a minute ago';
  if (ms < 45 * 60_000) return `${Math.round(ms / 60_000)} minutes ago`;
  if (ms < 90 * 60_000) return 'an hour ago';
  if (ms < 22 * 3600_000) return `${Math.round(ms / 3600_000)} hours ago`;
  if (ms < 36 * 3600_000) return 'yesterday';
  const date = new Date(stamped);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString() : 'recently';
}

export function draftBodyExpired(record, now = Date.now()) {
  if (!record?.bodyHtml) return false;
  const stamped = Number(record.bodyUpdatedAt || record.updatedAt || 0);
  return stamped > 0 && now - stamped > DRAFT_MAX_AGE_MS;
}

export async function loadDraft(key, fallbackKey) {
  const current = await readRecord(key);
  if (current) return current;
  if (!fallbackKey || fallbackKey === key) return null;
  const legacy = await readRecord(fallbackKey);
  if (!legacy) return null;
  await writeRecord(key, legacy);
  await deleteRecord(fallbackKey);
  return legacy;
}

export async function patchDraft(key, patch) {
  const prev = (await readRecord(key)) || {};
  const value = { ...prev, ...patch, updatedAt: Date.now() };
  await writeRecord(key, value);
  return value;
}

export function saveDraft(key, bodyHtml, meta = {}) {
  const now = Date.now();
  const value = {
    ...(readLocalRecord(key) || {}),
    bodyHtml,
    baseHash: meta.baseHash,
    baseVersion: meta.baseVersion,
    bodyUpdatedAt: now,
    updatedAt: now,
  };
  return writeRecord(key, value).then(() => value);
}

export async function saveDraftMode(key, mode) {
  return patchDraft(key, { mode });
}

export async function clearDraftBody(key) {
  const prev = await readRecord(key);
  if (!prev) return;
  if (!prev.mode) {
    await deleteRecord(key);
    return;
  }
  const next = { mode: prev.mode, updatedAt: Date.now() };
  await writeRecord(key, next);
}

export async function clearDraft(key) {
  await deleteRecord(key);
}
