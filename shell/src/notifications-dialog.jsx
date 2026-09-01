import React from 'react';
import { AppDialog } from './ui/dialog.jsx';

function relativeTime(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function notificationLabel(item) {
  const actor = item.actor?.name || item.actor?.login || 'Someone';
  const count = Number(item.count) || 1;
  if (item.kind === 'reaction') {
    return `${actor} reacted ${item.emoji || ''}${count > 1 ? ` and ${count - 1} more` : ''}`;
  }
  if (item.kind === 'mention') {
    return `${actor} mentioned you`;
  }
  if (item.kind === 'reply') {
    return `${actor} replied${count > 1 ? ` and ${count - 1} more replied` : ''}`;
  }
  return `${actor} commented${count > 1 ? ` and ${count - 1} more commented` : ''}`;
}

export function notificationTarget(item) {
  if (!item?.slug) return '';
  const version = Math.max(1, Number(item.version) || 1);
  const target = item.comment_id || item.thread_id;
  const query = target ? `?comment=${encodeURIComponent(target)}` : '';
  return `/d/${encodeURIComponent(item.slug)}/v/${version}${query}`;
}

export function NotificationsDialog({ open, notifications, onOpenChange, onSelect }) {
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Notifications"
      actions={(
        <>
          {notifications.hasMore ? (
            <button type="button" disabled={notifications.loading} onClick={() => notifications.load({ append: true })}>
              Load more
            </button>
          ) : null}
          <button type="button" onClick={() => onOpenChange(false)}>Close</button>
        </>
      )}
    >
      {notifications.loading && !notifications.items.length ? <p className="muted">Loading…</p> : null}
      {!notifications.loading && !notifications.items.length ? <p className="muted">No notifications yet.</p> : null}
      <div className="tdoc-notification-list">
        {notifications.items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`tdoc-cluster-row${item.read ? '' : ' unread'}`}
            title={item.preview || ''}
            onClick={() => onSelect(item)}
          >
            {item.actor?.avatar_url ? <img src={item.actor.avatar_url} alt="" /> : <span className="tdoc-cluster-anon" />}
            <span className="tdoc-cluster-snip">{notificationLabel(item)} on {item.title || item.slug}</span>
            <span className="muted">{relativeTime(item.created || item.at || item.updated)}</span>
          </button>
        ))}
      </div>
    </AppDialog>
  );
}
