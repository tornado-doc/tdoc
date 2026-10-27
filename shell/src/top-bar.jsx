import React, { useEffect, useRef, useState } from 'react';
import { readStored, writeStored } from './safe-storage.js';
import {
  Bell,
  ChevronRight,
  FlaskConical,
  Layers,
  Library,
  LogIn,
  LogOut,
  Moon,
  MoreHorizontal,
  Sun,
  TerminalSquare,
  UserRound,
} from 'lucide-react';
import { AppMenu, AppMenuItem, AppMenuLinkItem, AppMenuSeparator, AppSubmenu } from './ui/menu.jsx';
import { isPlainNavigationClick, startNavigationProgress } from './nav-progress.js';
import { useNotifications } from './hooks/use-notifications.js';
import { BrowserAlertsPrompt, NotificationsDialog, notificationTarget } from './notifications-dialog.jsx';
import { SpaceMenuItems, WorkspaceSwitcher, spaceLabel, useSpaceTeams } from './workspace-switcher.jsx';
import { readDevMode, setDevMode } from './dev-mode.js';
import { devOnlyFlags } from './feature-flags.js';
import { DebugBar } from './debug-bar.jsx';

// Sign in always asks which account: after Sign out, the provider (and
// GitHub behind it) still remember the last one, and going straight back in
// as them was the only way the old flow worked. "Switch account" was that
// same request under a second name, so it is gone; Sign out then Sign in is
// how to change accounts.
function defaultSignIn() {
  const here = location.pathname + location.search + location.hash;
  location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(here)}`;
}

export function TopBar({
  identity,
  children,
  actions,
  overflowActions,
  theme,
  onThemeChange,
  supportsTheme = true,
  onNotificationNavigate,
  notificationPrompt = false,
  // Every page has a way in. A page that does not say otherwise signs in
  // through the provider and comes back here; the doc page passes its own.
  authConfigured = true,
  onSignIn = defaultSignIn,
  profile = null,
  onClaimProfile = null,
  // The space this page belongs to: a team id, '' for My docs, null for none.
  space = null,
  teams = null,
  currentTeam = null,
  onSpace = null,
  onNewTeam = null,
  onboardingTest = null,
}) {
  const [localTheme, setLocalTheme] = useState(() => (
    readStored('tdoc-theme') === 'dark' ? 'dark' : 'light'
  ));
  const activeTheme = theme || localTheme;
  const dark = activeTheme === 'dark';
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notifications = useNotifications(Boolean(identity));
  const [viewerProfile, setViewerProfile] = useState(null);
  const viewerKey = identity?.login || '';
  const activeProfile = profile || (viewerProfile?.viewerKey === viewerKey ? viewerProfile.profile : null);
  const spaceTeams = useSpaceTeams(teams, Boolean(identity));
  // Only an allow-listed account has the switch; the boot says so.
  const [devMode] = useState(readDevMode);
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(exitTimer.current), []);
  const toggleDevMode = () => {
    if (!devMode?.on) { setDevMode(true).catch(() => {}); return; }
    if (!exitArmed) {
      setExitArmed(true);
      window.clearTimeout(exitTimer.current);
      exitTimer.current = window.setTimeout(() => setExitArmed(false), 4000);
      return;
    }
    window.clearTimeout(exitTimer.current);
    setExitArmed(false);
    setDevMode(false).catch(() => {});
  };
  const devModeLabel = devMode ? `Dev mode: ${devMode.on ? (exitArmed ? 'exit?' : 'on') : 'off'}` : '';
  const devFlags = devMode ? devOnlyFlags().map((flag) => flag.label) : [];
  const devFlagsNote = devFlags.length ? <div className="tdoc-dev-mode-flags" role="note">Dev mode shows: {devFlags.join(', ')}</div> : null;

  useEffect(() => {
    if (!viewerKey || profile) return undefined;
    const controller = new AbortController();
    fetch('/api/me/profile', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => response.ok ? response.json() : null)
      .then(body => {
        if (!controller.signal.aborted) setViewerProfile({ viewerKey, profile: body?.profile || null });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [viewerKey, profile]);

  useEffect(() => {
    document.documentElement.setAttribute('data-tdoc-theme', dark ? 'dark' : 'light');
  }, [activeTheme]);

  const toggleTheme = () => {
    const next = !dark;
    writeStored('tdoc-theme', next ? 'dark' : 'light');
    const nextTheme = next ? 'dark' : 'light';
    setLocalTheme(nextTheme);
    onThemeChange?.(nextTheme);
  };

  const signOut = async () => {
    const r = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    const body = await r.json().catch(() => ({}));
    // End the sign-in provider's session as well, or the next sign-in comes
    // straight back as this account. Best effort, and never a long wait.
    if (body.provider_signout) {
      await Promise.race([
        fetch(body.provider_signout, { method: 'DELETE', credentials: 'include', mode: 'cors' }).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    }
    location.href = '/';
  };

  const openNotifications = () => {
    setNotificationsOpen(true);
    notifications.load();
  };

  // A notification email's "Turn these off" link lands on /me?notifications=1.
  useEffect(() => {
    if (!identity || new URLSearchParams(location.search).get('notifications') !== '1') return;
    openNotifications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(identity)]);

  const selectNotification = async (item) => {
    await notifications.markRead(item);
    setNotificationsOpen(false);
    const target = notificationTarget(item);
    if (!target) return;
    if (onNotificationNavigate) onNotificationNavigate(item, target);
    else location.href = target;
  };

  const openPublicProfile = () => {
    if (activeProfile?.handle) {
      location.href = `/@${encodeURIComponent(activeProfile.handle)}`;
      return;
    }
    if (onClaimProfile) onClaimProfile();
    else if (activeProfile) location.href = '/me#claim-profile';
  };
  const publicProfileHref = activeProfile?.handle ? `/@${encodeURIComponent(activeProfile.handle)}` : null;
  const publicProfileLabel = activeProfile?.handle
    ? `Public profile (@${activeProfile.handle})`
    : 'Claim public profile';
  const themeLabel = dark ? 'Light mode' : 'Dark mode';
  // Light / dark is a row of the account menu, not a button of its own. A
  // signed-out visitor has no account menu, so for them it is in ⋯, which
  // then shows at every width. ⋯ itself shows on a wide screen only when it
  // has something in it there.
  const themeInMore = supportsTheme && !identity;
  const moreOnDesktop = Boolean(overflowActions) || themeInMore;

  return (
    <header className="tdoc-bar">
      <div className="tdoc-bar-left">
        <a
          className="tdoc-bar-mark"
          href="/me"
          title="My docs"
          aria-label="My docs"
          onClick={(event) => { if (isPlainNavigationClick(event)) startNavigationProgress(); }}
        >
          <img src="/tdoc_logo.svg" alt="" width="24" height="24" data-tdoc-dark="invert" />
        </a>
        {children}
      </div>
      <div className="tdoc-bar-right">
        <div className="tdoc-bar-actions">{actions}</div>
        <AppMenu trigger={(
          <button
            id="tdoc-more-btn"
            type="button"
            className={`tdoc-secondary-toggle${moreOnDesktop ? '' : ' tdoc-mobile-overflow-trigger'}`}
            aria-label="More actions"
          >
            <MoreHorizontal size={18} />
            {notifications.unread ? <span className="tdoc-unread-dot tdoc-mobile-overflow-only" /> : null}
          </button>
        )}>
          {overflowActions}
          {supportsTheme ? (
            <>
              <AppMenuSeparator className={themeInMore && overflowActions ? '' : 'tdoc-mobile-overflow-only'} />
              <AppMenuItem
                className={`tdoc-action-menu-item${themeInMore ? '' : ' tdoc-mobile-overflow-only'}`}
                data-action="theme"
                onClick={toggleTheme}
              >
                {dark ? <Sun size={15} /> : <Moon size={15} />}
                {themeLabel}
              </AppMenuItem>
            </>
          ) : null}
          {identity ? (
            <>
              <AppMenuItem className="tdoc-action-menu-item tdoc-mobile-overflow-only" onClick={openNotifications}>
                <Bell size={15} />
                Notifications{notifications.unread ? ` (${notifications.unread})` : ''}
              </AppMenuItem>
              <AppMenuSeparator className="tdoc-mobile-overflow-only" />
              <AppMenuLinkItem className="tdoc-action-menu-item tdoc-mobile-overflow-only" href="/me">
                <Library size={15} /> My docs
              </AppMenuLinkItem>
              {/* The space chip is hidden on a phone so ⋯ always has room;
                  its list lives here instead. */}
              <AppSubmenu
                className="tdoc-action-menu-item tdoc-mobile-overflow-only tdoc-space-submenu-trigger"
                trigger={(
                  <>
                    <Layers size={15} />
                    <span>Switch space</span>
                    {space !== null ? <span className="tdoc-space-submenu-current">{spaceLabel(space, spaceTeams, currentTeam)}</span> : null}
                    <ChevronRight className="tdoc-submenu-chevron" size={14} />
                  </>
                )}
              >
                <SpaceMenuItems space={space} teams={spaceTeams} currentTeam={currentTeam} onSpace={onSpace} onNewTeam={onNewTeam} />
              </AppSubmenu>
              {/* Both of these are "the account", and neither is something you
                  reach for often. Mobile-only like the rows above: on a desktop
                  the account chip beside this menu already carries them, and
                  Switch account used to appear in both. */}
              <AppSubmenu
                className="tdoc-action-menu-item tdoc-mobile-overflow-only tdoc-account-submenu-trigger"
                trigger={(
                  <>
                    <UserRound size={15} />
                    <span>My account</span>
                    <ChevronRight className="tdoc-submenu-chevron" size={14} />
                  </>
                )}
              >
                {publicProfileHref ? (
                  <AppMenuLinkItem className="tdoc-action-menu-item" href={publicProfileHref}>
                    <UserRound size={15} /> {publicProfileLabel}
                  </AppMenuLinkItem>
                ) : activeProfile || onClaimProfile ? (
                  <AppMenuItem className="tdoc-action-menu-item" onClick={openPublicProfile}>
                    <UserRound size={15} /> {publicProfileLabel}
                  </AppMenuItem>
                ) : null}
                <AppMenuLinkItem className="tdoc-action-menu-item" href="/me?view=settings#agents">
                  <TerminalSquare size={15} /> Agents
                </AppMenuLinkItem>
                {devMode ? (
                  <AppMenuItem className="tdoc-action-menu-item tdoc-dev-mode-item" role="menuitemcheckbox" aria-checked={devMode.on} closeOnClick={!devMode.on || exitArmed} onClick={toggleDevMode}>
                    <FlaskConical size={15} /> {devModeLabel}
                  </AppMenuItem>
                ) : null}
                {devFlagsNote}
                {devMode?.on && onboardingTest ? <DebugBar {...onboardingTest} /> : null}
                <AppMenuItem className="tdoc-action-menu-item" onClick={signOut}>
                  <LogOut size={15} /> Sign out
                </AppMenuItem>
              </AppSubmenu>
            </>
          ) : authConfigured ? (
            <AppMenuItem className="tdoc-action-menu-item tdoc-mobile-overflow-only" onClick={onSignIn}>
              <LogIn size={15} /> Sign in
            </AppMenuItem>
          ) : null}
        </AppMenu>
        {identity ? <WorkspaceSwitcher space={space} teams={spaceTeams} currentTeam={currentTeam} onSpace={onSpace} onNewTeam={onNewTeam} /> : null}
        {identity ? (
          <AppMenu trigger={(
            <button className="tdoc-chip tdoc-account-trigger" type="button" aria-label={`Account: ${identity.name || identity.login}`} title={identity.name || identity.login}>
              {identity.avatar_url ? <img src={identity.avatar_url} alt="" /> : <span className="tdoc-avatar-fallback">{String(identity.name || identity.login || "?").slice(0, 1).toUpperCase()}</span>}
              <span className="name">{identity.name || identity.login}</span>
              {notifications.unread ? <span className="tdoc-unread-dot" /> : null}
            </button>
          )}>
            <AppMenuItem onClick={openNotifications}>
              Notifications{notifications.unread ? ` (${notifications.unread})` : ''}
            </AppMenuItem>
            <AppMenuLinkItem href="/me">My docs</AppMenuLinkItem>
            {publicProfileHref ? (
              <AppMenuLinkItem href={publicProfileHref}>{publicProfileLabel}</AppMenuLinkItem>
            ) : activeProfile || onClaimProfile ? (
              <AppMenuItem onClick={openPublicProfile}>{publicProfileLabel}</AppMenuItem>
            ) : null}
            <AppMenuLinkItem href="/me?view=settings#agents">Agents</AppMenuLinkItem>
            {devMode ? (
              <AppMenuItem className="tdoc-dev-mode-item" role="menuitemcheckbox" aria-checked={devMode.on} closeOnClick={!devMode.on || exitArmed} onClick={toggleDevMode}>
                {devModeLabel}
              </AppMenuItem>
            ) : null}
            {devFlagsNote}
            {devMode?.on && onboardingTest ? <DebugBar {...onboardingTest} /> : null}
            {supportsTheme ? (
              <>
                <AppMenuSeparator />
                <AppMenuItem data-action="theme" onClick={toggleTheme}>{themeLabel}</AppMenuItem>
              </>
            ) : null}
            <AppMenuSeparator />
            <AppMenuItem onClick={signOut}>Sign out</AppMenuItem>
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
      {notificationPrompt ? <BrowserAlertsPrompt notifications={notifications} /> : null}
    </header>
  );
}
