const DB_NAME = 'tdoc-browser-drafts';
const STORE_NAME = 'drafts';

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

export function draftKey(config) {
  const author = config.identity?.login || 'local';
  return `${config.slug}:v${config.version}:${author}`;
}

export async function loadDraft(key) {
  try {
    return await transact('readonly', (store) => store.get(key));
  } catch {
    const value = localStorage.getItem(`tdoc-draft:${key}`);
    return value ? JSON.parse(value) : null;
  }
}

export async function saveDraft(key, bodyHtml) {
  const value = { bodyHtml, updatedAt: Date.now() };
  try {
    await transact('readwrite', (store) => store.put(value, key));
  } catch {
    localStorage.setItem(`tdoc-draft:${key}`, JSON.stringify(value));
  }
}

export async function clearDraft(key) {
  try {
    await transact('readwrite', (store) => store.delete(key));
  } catch {
    localStorage.removeItem(`tdoc-draft:${key}`);
  }
}
