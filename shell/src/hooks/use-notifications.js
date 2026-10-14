import { useCallback, useEffect, useState } from 'react';
import {
  answerAccessRequest as answerAccessRequestApi,
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

  // With desktop alerts on, any unread at all fetches the newest page and
  // alerts for events not alerted before. Watching only for a rise in the
  // count missed a new reply that arrived as another was read (same total)
  // and a reply folded into an already-unread row (count unchanged). A
  // hidden tab keeps polling, since that is exactly when an alert matters.
  const refreshUnread = useCallback(async () => {
    if (!enabled) return;
    const alerting = browserNotificationsEnabled();
    if (document.hidden && !alerting) return;
    try {
      const result = await getUnreadNotificationCount();
      const count = Number(result.unread) || 0;
      setUnread(count);
      if (alerting && count > 0) {
        const page = await listNotifications(0);
        alertNewNotifications(page.items || [], {
          label: notificationLabel,
          open: (item) => { window.location.href = notificationTarget(item); },
        });
      }
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

  const answerAccessRequest = useCallback(async (item, action) => {
    const result = await answerAccessRequestApi({ slug: item.slug, requester: item.requester || item.actor?.login, action });
    setItems((current) => current.map((row) => (
      row.id === item.id ? { ...row, read: true, resolved: result.resolved } : row
    )));
    setUnread((current) => Math.max(0, current - (item.read ? 0 : 1)));
  }, []);

  const markAllRead = useCallback(async () => {
    setItems((current) => current.map((row) => ({ ...row, read: true })));
    setUnread(0);
    await markAllNotificationsRead();
  }, []);

  const setAlerts = useCallback(async (on) => {
    const permission = await setBrowserNotifications(on, items);
    setBrowserAlerts({ on: on && permission === 'granted', permission });
  }, [items]);

  useEffect(() => {
    refreshUnread();
    const timer = window.setInterval(() => {
      const active = document.activeElement;
      const typing = active?.matches?.('input, textarea, [contenteditable="true"]');
      if (!typing) refreshUnread();
    }, (typeof window !== 'undefined' && window.__TDOC_NOTIFY_POLL_MS) || 30_000);
    return () => window.clearInterval(timer);
  }, [refreshUnread]);

  return { items, unread, hasMore, loading, load, markRead, markAllRead, answerAccessRequest, browserAlerts, setAlerts };
}
