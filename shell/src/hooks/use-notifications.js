import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
} from '../document/api.js';
import { notificationLabel, notificationTarget } from '../notifications-dialog.jsx';
import {
  alertNewNotifications,
  browserNotificationPermission,
  browserNotificationsEnabled,
  setBrowserNotifications,
} from './browser-notifications.js';

export function useNotifications(enabled) {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [browserAlerts, setBrowserAlerts] = useState(() => ({
    on: browserNotificationsEnabled(),
    permission: browserNotificationPermission(),
  }));
  const lastUnread = useRef(-1);

  // With desktop alerts on, a rise in the unread count fetches the newest
  // page and alerts for what is new; a hidden tab keeps polling, since a
  // hidden tab is exactly when an alert is worth having.
  const refreshUnread = useCallback(async () => {
    if (!enabled) return;
    const alerting = browserNotificationsEnabled();
    if (document.hidden && !alerting) return;
    try {
      const result = await getUnreadNotificationCount();
      const count = Number(result.unread) || 0;
      setUnread(count);
      if (alerting && count > 0 && count > lastUnread.current) {
        const page = await listNotifications(0);
        alertNewNotifications(page.items || [], {
          label: notificationLabel,
          open: (item) => { window.location.href = notificationTarget(item); },
        });
      }
      lastUnread.current = count;
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

  const markAllRead = useCallback(async () => {
    setItems((current) => current.map((row) => ({ ...row, read: true })));
    setUnread(0);
    await markAllNotificationsRead();
  }, []);

  const setAlerts = useCallback(async (on) => {
    const permission = await setBrowserNotifications(on, items);
    setBrowserAlerts({ on: on && permission === 'granted', permission });
    lastUnread.current = -1;
  }, [items]);

  useEffect(() => {
    refreshUnread();
    const timer = window.setInterval(() => {
      const active = document.activeElement;
      const typing = active?.matches?.('input, textarea, [contenteditable="true"]');
      if (!typing) refreshUnread();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshUnread]);

  return { items, unread, hasMore, loading, load, markRead, markAllRead, browserAlerts, setAlerts };
}
