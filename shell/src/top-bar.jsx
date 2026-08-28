import React, { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { AppMenu, AppMenuItem } from './ui/menu.jsx';
import { useNotifications } from './hooks/use-notifications.js';
import { NotificationsDialog, notificationTarget } from './notifications-dialog.jsx';

export function TopBar({
  identity,
  children,
  actions,
  theme,
  onThemeChange,
  onNotificationNavigate,
  authConfigured = false,
  onSignIn,
}) {
  const [localTheme, setLocalTheme] = useState(() => (
    localStorage.getItem('tdoc-theme') === 'dark' ? 'dark' : 'light'
  ));
  const activeTheme = theme || localTheme;
  const dark = activeTheme === 'dark';
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notifications = useNotifications(Boolean(identity));

  useEffect(() => {
    document.documentElement.setAttribute('data-tdoc-theme', dark ? 'dark' : 'light');
  }, [activeTheme]);

  const toggleTheme = () => {
    const next = !dark;
    localStorage.setItem('tdoc-theme', next ? 'dark' : 'light');
    const nextTheme = next ? 'dark' : 'light';
    setLocalTheme(nextTheme);
    onThemeChange?.(nextTheme);
  };

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/';
  };

  const openNotifications = () => {
    setNotificationsOpen(true);
    notifications.load();
  };

  const selectNotification = async (item) => {
    await notifications.markRead(item);
    setNotificationsOpen(false);
    const target = notificationTarget(item);
    if (!target) return;
    if (onNotificationNavigate) onNotificationNavigate(item, target);
    else location.href = target;
  };

  return (
    <header className="tdoc-bar">
      <div className="tdoc-bar-left">
        <button className="tdoc-bar-mark" title="My docs" aria-label="My docs" onClick={() => { location.href = '/me'; }}>
          <img src="/tdoc_logo.svg" alt="" width="24" height="24" data-tdoc-dark="invert" />
        </button>
        {children}
      </div>
      <div className="tdoc-bar-right">
        {actions}
        <button id="tdoc-theme-btn" type="button" className="tdoc-theme-btn" aria-pressed={dark} title={dark ? 'Light mode' : 'Dark mode'} onClick={toggleTheme}>
          {dark ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        {identity ? (
          <AppMenu trigger={(
            <button className="tdoc-chip" type="button">
              {identity.avatar_url ? <img src={identity.avatar_url} alt="" /> : <span className="tdoc-avatar-fallback">{identity.login.slice(0, 1).toUpperCase()}</span>}
              <span className="name">{identity.name || identity.login}</span>
              {notifications.unread ? <span className="tdoc-unread-dot" /> : null}
            </button>
          )}>
            <AppMenuItem onClick={openNotifications}>
              Notifications{notifications.unread ? ` (${notifications.unread})` : ''}
            </AppMenuItem>
            <AppMenuItem onClick={() => { location.href = '/me'; }}>My docs</AppMenuItem>
            <AppMenuItem onClick={signOut}>Sign out</AppMenuItem>
          </AppMenu>
        ) : authConfigured ? (
          <button type="button" className="tdoc-chip signin" onClick={onSignIn}>
            Sign in with GitHub
          </button>
        ) : null}
      </div>
      <NotificationsDialog
        open={notificationsOpen}
        notifications={notifications}
        onOpenChange={setNotificationsOpen}
        onSelect={selectNotification}
      />
    </header>
  );
}
