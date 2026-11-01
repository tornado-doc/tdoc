import React, { useState } from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { AppButton } from './ui/button.jsx';
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
        {!result ? <AppButton variant="primary" className="primary" onClick={enable}>Turn on</AppButton> : null}
        <AppButton onClick={dismiss}>{result ? 'Close' : 'Not now'}</AppButton>
      </div>
    </aside>
  );
}

// The two channels as one settings group: label left, switch right, no
// explanations -- "Browser" and "Email" under "Notifications" say it. The
// only extra word is a browser block, which the switch cannot undo.
function NotificationSettings({ notifications }) {
  const { on, permission } = notifications.browserAlerts || {};
  const email = notifications.emailAlerts;
  const showBrowser = permission !== 'unsupported';
  const showEmail = !!(email && email.available);
  if (!showBrowser && !showEmail) return null;
  return (
    <div className="tdoc-notif-settings">
      {showBrowser ? (
        <div className="tdoc-notif-setting">
          {permission === 'denied' ? (
            <>
              <span className="tdoc-switch-label">Browser</span>
              <span className="tdoc-notif-setting-value">Blocked</span>
            </>
          ) : (
            <AppSwitch
              id="tdoc-browser-alerts"
              checked={!!on}
              onCheckedChange={(next) => notifications.setAlerts(next)}
              label="Browser"
            />
          )}
        </div>
      ) : null}
      {showEmail ? (
        <div className="tdoc-notif-setting">
          <AppSwitch
            id="tdoc-email-alerts"
            checked={!!email.on}
            onCheckedChange={(next) => notifications.setEmailAlerts(next)}
            label="Email"
          />
        </div>
      ) : null}
    </div>
  );
}

export function NotificationsDialog({ open, notifications, onOpenChange, onSelect }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const unread = notifications.items.some((item) => !item.read);
  const hasSettings = (!!notifications.browserAlerts && notifications.browserAlerts.permission !== 'unsupported') || !!notifications.emailAlerts?.available;
  const changeOpen = (next) => {
    if (!next) setSettingsOpen(false);
    onOpenChange(next);
  };
  return (
    <AppDialog
      open={open}
      onOpenChange={changeOpen}
      title="Notifications"
      className="tdoc-notif-dialog"
      actions={(
        <>
          {notifications.hasMore ? (
            <AppButton disabled={notifications.loading} onClick={() => notifications.load({ append: true })}>
              Load more
            </AppButton>
          ) : null}
          <AppButton onClick={() => changeOpen(false)}>Close</AppButton>
        </>
      )}
    >
      <div className="tdoc-notif-head">
        <span className="tdoc-notif-count">{notifications.unread ? `${notifications.unread} unread` : 'All caught up'}</span>
        <span className="tdoc-notif-head-actions">
          {unread ? (
            <button type="button" className="tdoc-quiet-link" onClick={() => notifications.markAllRead()}>Mark all read</button>
          ) : null}
          {hasSettings ? (
            <button type="button" className="tdoc-quiet-link" aria-expanded={settingsOpen} aria-controls={settingsOpen ? 'tdoc-notif-settings' : undefined} onClick={() => setSettingsOpen((value) => !value)}>
              {settingsOpen ? 'Hide settings' : 'Settings'}
            </button>
          ) : null}
        </span>
      </div>
      {settingsOpen && hasSettings ? <div id="tdoc-notif-settings"><NotificationSettings notifications={notifications} /></div> : null}
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
                  <AppButton variant="primary" size="s" className="primary" onClick={() => notifications.answerAccessRequest(item, 'approve')}>Approve</AppButton>
                  <AppButton size="s" onClick={() => notifications.answerAccessRequest(item, 'ignore')}>Ignore</AppButton>
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </AppDialog>
  );
}
