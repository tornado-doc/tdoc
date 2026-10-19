import React, { useState } from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { AppSwitch } from './ui/switch.jsx';
import { actorName, joiner, notificationAction, notificationLabel, notificationTarget } from './notification-text.js';

export { notificationLabel, notificationTarget };

function relativeTime(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// A product-level soft ask before Chrome's permission prompt. It is shown on
// document pages only, and only after unread collaboration activity makes the
// value concrete. Not now (or dismissing Chrome's prompt) snoozes it for seven
// days; no browser permission is requested until Turn on is clicked.
export function BrowserAlertsPrompt({ notifications }) {
  const [result, setResult] = useState('');
  if (!notifications.browserPrompt && !result) return null;

  const enable = async () => setResult(await notifications.setAlerts(true));
  const dismiss = () => {
    notifications.dismissAlertsPrompt();
    setResult('');
  };
  const granted = result === 'granted';
  const blocked = result === 'denied' || result === 'default';
  const { mode, pushable } = notifications.browserAlerts || {};

  return (
    <aside className="tdoc-notif-prompt" role="dialog" aria-label="Turn on browser notifications">
      <div className="tdoc-notif-prompt-copy">
        <strong>{granted ? 'Test alert sent' : blocked ? 'Notifications weren’t enabled' : 'Don’t miss replies'}</strong>
        <span>{granted
          ? `If you didn’t see it, allow browser notifications in your system settings.${mode === 'push' ? '' : ' Keep a tdoc tab open for alerts.'}`
          : blocked
            ? 'You can allow tdoc in the browser’s site settings and turn it on later from Notifications.'
            : `Get a browser alert when someone comments, mentions you, or replies${pushable ? ', even with tdoc closed.' : '. tdoc needs to stay open in a tab.'}`}</span>
      </div>
      <div className="tdoc-notif-prompt-actions">
        {!result ? <button type="button" className="primary" onClick={enable}>Turn on</button> : null}
        <button type="button" onClick={dismiss}>{result ? 'Close' : 'Not now'}</button>
      </div>
    </aside>
  );
}

function BrowserAlertsSetting({ notifications }) {
  const { on, permission, mode, pushable } = notifications.browserAlerts || {};
  if (permission === 'unsupported') return null;
  const reachesClosed = on ? mode === 'push' : pushable;
  const hint = permission === 'denied'
    ? 'Blocked for tdoc in this browser. Allow notifications in the site settings, then turn this on.'
    : `A desktop alert when someone comments, mentions you or replies, ${reachesClosed ? 'even when tdoc is closed.' : 'while tdoc is open in a tab.'}`;
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

// Shown only when this site can send email at all.
function EmailAlertsSetting({ notifications }) {
  const email = notifications.emailAlerts;
  if (!email || !email.available) return null;
  return (
    <div className="tdoc-notif-setting">
      <AppSwitch
        id="tdoc-email-alerts"
        checked={!!email.on}
        onCheckedChange={(next) => notifications.setEmailAlerts(next)}
        label="Email notifications"
      />
      <p className="manage-hint">An email when someone mentions you, replies to you, comments on your doc or asks for access. At most one per thread every 30 minutes.</p>
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
      <EmailAlertsSetting notifications={notifications} />
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
