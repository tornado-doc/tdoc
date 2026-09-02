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

async function readRecord(key) {
  try {
    return await transact('readonly', (store) => store.get(key)) || null;
  } catch {
    try {
      const value = localStorage.getItem(storageKey(key));
      return value ? JSON.parse(value) : null;
    } catch {
      return null;
    }
  }
}

async function writeRecord(key, value) {
  try {
    await transact('readwrite', (store) => store.put(value, key));
  } catch {
    localStorage.setItem(storageKey(key), JSON.stringify(value));
  }
}

async function deleteRecord(key) {
  try {
    await transact('readwrite', (store) => store.delete(key));
  } catch {
    localStorage.removeItem(storageKey(key));
  }
}

// Per document, not per version and not a global last-mode. A draft started
// on v1 has to be able to surface when the author opens v2 of the same doc.
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
  const ms = Math.max(0, now - Number(updatedAt || 0));
  if (ms < 45_000) return 'just now';
  if (ms < 90_000) return 'a minute ago';
  if (ms < 45 * 60_000) return `${Math.round(ms / 60_000)} minutes ago`;
  if (ms < 90 * 60_000) return 'an hour ago';
  if (ms < 22 * 3600_000) return `${Math.round(ms / 3600_000)} hours ago`;
  if (ms < 36 * 3600_000) return 'yesterday';
  return new Date(updatedAt).toLocaleDateString();
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

export async function saveDraft(key, bodyHtml, meta = {}) {
  return patchDraft(key, {
    bodyHtml,
    baseHash: meta.baseHash,
    baseVersion: meta.baseVersion,
    bodyUpdatedAt: Date.now(),
  });
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
