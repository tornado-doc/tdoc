import { useCallback, useEffect, useState } from 'react';
import {
  getUnreadNotificationCount,
  listNotifications,
  markNotificationsRead,
} from '../document/api.js';

export function useNotifications(enabled) {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const refreshUnread = useCallback(async () => {
    if (!enabled || document.hidden) return;
    try {
      const result = await getUnreadNotificationCount();
      setUnread(Number(result.unread) || 0);
    } catch {
      // The identity may have expired. The next navigation will refresh it.
    }
  }, [enabled]);

  const load = useCallback(async ({ append = false } = {}) => {
    if (!enabled) return;
    setLoading(true);
    try {
      const offset = append ? items.length : 0;
      const result = await listNotifications(offset);
      setItems((current) => append ? [...current, ...(result.items || [])] : result.items || []);
      setUnread(Number(result.unread) || 0);
      setHasMore(Boolean(result.has_more));
    } finally {
      setLoading(false);
    }
  }, [enabled, items.length]);

  const markRead = useCallback(async (item) => {
    setItems((current) => current.map((row) => (
      row.id === item.id ? { ...row, read: true } : row
    )));
    setUnread((current) => Math.max(0, current - (item.read ? 0 : 1)));
    await markNotificationsRead([item.id]);
  }, []);

  useEffect(() => {
    refreshUnread();
    const timer = window.setInterval(() => {
      const active = document.activeElement;
      const typing = active?.matches?.('input, textarea, [contenteditable="true"]');
      if (!typing) refreshUnread();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshUnread]);

  return { items, unread, hasMore, loading, load, markRead };
}
