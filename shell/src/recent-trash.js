import { readStored, writeStored } from './safe-storage.js';

// What this browser deleted in the last few minutes. Trash is listed from
// KV, which can lag a write by up to a minute; naming these lets the list
// show them at once (the server checks each one like any other row).
const RECENT_TRASH_KEY = 'tdoc.recentTrash';
const RECENT_TRASH_MS = 5 * 60 * 1000;
export function recentTrash() {
  try {
    const list = JSON.parse(readStored(RECENT_TRASH_KEY, '[]'));
    return Array.isArray(list) ? list.filter((item) => item && Date.now() - item.at < RECENT_TRASH_MS) : [];
  } catch {
    return [];
  }
}
export function rememberTrashed({ slug, folder }) {
  const item = slug ? { slug, at: Date.now() } : { folder, at: Date.now() };
  writeStored(RECENT_TRASH_KEY, JSON.stringify([item, ...recentTrash()].slice(0, 20)));
}
