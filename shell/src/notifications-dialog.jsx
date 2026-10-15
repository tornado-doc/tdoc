import React from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { AppSwitch } from './ui/switch.jsx';

function relativeTime(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function actorName(item) {
  return item.actor?.name || item.actor?.login || 'Someone';
}

// What happened, without the actor (the row sets the actor in bold).
function notificationAction(item) {
  const count = Number(item.count) || 1;
  if (item.kind === 'reaction') return `reacted ${item.emoji || ''}${count > 1 ? ` and ${count - 1} more` : ''}`;
  if (item.kind === 'mention') return 'mentioned you';
  if (item.kind === 'reply') return `replied${count > 1 ? ` and ${count - 1} more replied` : ''}`;
  if (item.kind === 'access_request') return 'asked for access to';
  if (item.kind === 'access_granted') return 'gave you access to';
  return `commented${count > 1 ? ` and ${count - 1} more commented` : ''}`;
}

// One line, for a desktop alert's title.
function joiner(item) {
  return item.kind === 'access_request' || item.kind === 'access_granted' ? '' : ' on';
}

export function notificationLabel(item) {
  return `${actorName(item)} ${notificationAction(item)}${joiner(item)} ${item.title || item.slug}`;
}

export function notificationTarget(item) {
  if (!item?.slug) return '';
  // Access is about the document, not a comment: open its latest version.
  if (item.kind === 'access_request' || item.kind === 'access_granted') return `/d/${encodeURIComponent(item.slug)}`;
  const version = Math.max(1, Number(item.version) || 1);
  const target = item.comment_id || item.thread_id;
  const query = target ? `?comment=${encodeURIComponent(target)}` : '';
  return `/d/${encodeURIComponent(item.slug)}/v/${version}${query}`;
}

function BrowserAlertsSetting({ notifications }) {
  const { on, permission } = notifications.browserAlerts || {};
  if (permission === 'unsupported') return null;
  const hint = permission === 'denied'
    ? 'Blocked for tdoc in this browser. Allow notifications in the site settings, then turn this on.'
    : 'A desktop alert when someone comments, mentions you or replies, while tdoc is open in a tab.';
  return (
    <div className="tdoc-notif-setting">
      <AppSwitch
        id="tdoc-browser-alerts"
        checked={!!on}
        onCheckedChange={(next) => notifications.setAlerts(next)}
        label="Browser notifications"
      />
      <p className="manage-hint">{hint}</p>
    </div>
  );
}

export function NotificationsDialog({ open, notifications, onOpenChange, onSelect }) {
  const unread = notifications.items.some((item) => !item.read);
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Notifications"
      className="tdoc-notif-dialog"
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
      <BrowserAlertsSetting notifications={notifications} />
      <div className="tdoc-notif-head">
        <span className="tdoc-notif-count">{notifications.unread ? `${notifications.unread} unread` : 'All caught up'}</span>
        {unread ? (
          <button type="button" className="tdoc-quiet-link" onClick={() => notifications.markAllRead()}>Mark all read</button>
        ) : null}
      </div>
      {notifications.loading && !notifications.items.length ? <p className="muted">Loading…</p> : null}
      {!notifications.loading && !notifications.items.length ? <p className="muted">No notifications yet.</p> : null}
      <div className="tdoc-notification-list">
        {notifications.items.map((item) => {
          const pending = item.kind === 'access_request' && !item.resolved;
          return (
            <div key={item.id} className={`tdoc-notif-row${item.read ? '' : ' unread'}`}>
              <button type="button" className="tdoc-notif-open" onClick={() => onSelect(item)}>
                {item.actor?.avatar_url
                  ? <img className="tdoc-notif-avatar" src={item.actor.avatar_url} alt="" />
                  : <span className="tdoc-notif-avatar tdoc-notif-avatar--anon" aria-hidden="true">{actorName(item).slice(0, 1).toUpperCase()}</span>}
                <span className="tdoc-notif-main">
                  <span className="tdoc-notif-line">
                    <strong>{actorName(item)}</strong> {notificationAction(item)}{joiner(item)} <span className="tdoc-notif-doc">{item.title || item.slug}</span>
                  </span>
                  {item.preview ? <span className="tdoc-notif-preview">{item.preview}</span> : null}
                  {item.resolved === 'approved' ? <span className="tdoc-notif-preview">Approved. {actorName(item)} can open it now.</span> : null}
                  {item.resolved === 'ignored' ? <span className="tdoc-notif-preview">Ignored.</span> : null}
                </span>
                <span className="tdoc-notif-time">{relativeTime(item.created || item.at || item.updated)}</span>
              </button>
              {pending ? (
                // Answer it here: the request is the whole job, not a link to go find Share.
                <span className="tdoc-notif-actions">
                  <button type="button" className="primary" onClick={() => notifications.answerAccessRequest(item, 'approve')}>Approve</button>
                  <button type="button" onClick={() => notifications.answerAccessRequest(item, 'ignore')}>Ignore</button>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </AppDialog>
  );
}
