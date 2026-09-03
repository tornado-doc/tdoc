import React, { useEffect, useState } from 'react';
import {
  Bell,
  Library,
  LogIn,
  LogOut,
  MoreHorizontal,
  Moon,
  Sun,
} from 'lucide-react';
import { AppMenu, AppMenuItem, AppMenuSeparator } from './ui/menu.jsx';
import { useNotifications } from './hooks/use-notifications.js';
import { NotificationsDialog, notificationTarget } from './notifications-dialog.jsx';

export function TopBar({
  identity,
  children,
  actions,
  overflowActions,
  theme,
  onThemeChange,
  onNotificationNavigate,
  authConfigured = false,
  onSignIn,
  onSwitchAccount,
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
        <div className="tdoc-bar-actions">{actions}</div>
        <AppMenu trigger={(
          <button
            id="tdoc-more-btn"
            type="button"
            className={`tdoc-secondary-toggle${overflowActions ? '' : ' tdoc-mobile-overflow-trigger'}`}
            aria-label="More actions"
          >
            <MoreHorizontal size={18} />
            {notifications.unread ? <span className="tdoc-unread-dot tdoc-mobile-overflow-only" /> : null}
          </button>
        )}>
          {overflowActions}
          <AppMenuSeparator className="tdoc-mobile-overflow-only" />
          <AppMenuItem className="tdoc-action-menu-item tdoc-mobile-overflow-only" onClick={toggleTheme}>
            {dark ? <Sun size={15} /> : <Moon size={15} />}
            {dark ? 'Light mode' : 'Dark mode'}
          </AppMenuItem>
          {identity ? (
            <>
              <AppMenuItem className="tdoc-action-menu-item tdoc-mobile-overflow-only" onClick={openNotifications}>
                <Bell size={15} />
                Notifications{notifications.unread ? ` (${notifications.unread})` : ''}
              </AppMenuItem>
              <AppMenuSeparator className="tdoc-mobile-overflow-only" />
              <AppMenuItem className="tdoc-action-menu-item tdoc-mobile-overflow-only" onClick={() => { location.href = '/me'; }}>
                <Library size={15} /> My docs
              </AppMenuItem>
              <AppMenuItem className="tdoc-action-menu-item tdoc-mobile-overflow-only" onClick={signOut}>
                <LogOut size={15} /> Sign out
              </AppMenuItem>
              {onSwitchAccount ? (
                <AppMenuItem className="tdoc-action-menu-item" onClick={onSwitchAccount}>
                  <LogIn size={15} /> Switch account
                </AppMenuItem>
              ) : null}
            </>
          ) : authConfigured ? (
            <AppMenuItem className="tdoc-action-menu-item tdoc-mobile-overflow-only" onClick={onSignIn}>
              <LogIn size={15} /> Sign in
            </AppMenuItem>
          ) : null}
        </AppMenu>
        <button id="tdoc-theme-btn" type="button" className="tdoc-theme-btn" aria-label={dark ? 'Light mode' : 'Dark mode'} aria-pressed={dark} title={dark ? 'Light mode' : 'Dark mode'} onClick={toggleTheme}>
          {dark ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        {identity ? (
          <AppMenu trigger={(
            <button className="tdoc-chip tdoc-account-trigger" type="button">
              {identity.avatar_url ? <img src={identity.avatar_url} alt="" /> : <span className="tdoc-avatar-fallback">{String(identity.name || identity.login || "?").slice(0, 1).toUpperCase()}</span>}
              <span className="name">{identity.name || identity.login}</span>
              {notifications.unread ? <span className="tdoc-unread-dot" /> : null}
            </button>
          )}>
            <AppMenuItem onClick={openNotifications}>
              Notifications{notifications.unread ? ` (${notifications.unread})` : ''}
            </AppMenuItem>
            <AppMenuItem onClick={() => { location.href = '/me'; }}>My docs</AppMenuItem>
            <AppMenuItem onClick={signOut}>Sign out</AppMenuItem>
            {onSwitchAccount ? <AppMenuItem onClick={onSwitchAccount}>Switch account</AppMenuItem> : null}
          </AppMenu>
        ) : authConfigured ? (
          <button type="button" className="tdoc-chip signin tdoc-account-trigger" onClick={onSignIn}>
            Sign in
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
