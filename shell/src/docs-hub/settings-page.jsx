import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bell, Bot, KeyRound, Plus, ShieldAlert, Sparkles, UserRound, UsersRound } from 'lucide-react';
import { AppButton } from '../ui/button.jsx';
import { AppSwitch } from '../ui/switch.jsx';
import { ConnectorsBody } from '../connectors-page.jsx';
import { DevicesBody } from '../tokens-page.jsx';
import { ConnectAiAppsSection } from '../connect-ai-apps.jsx';
import { NotificationSettings } from '../notifications-dialog.jsx';
import { useNotifications } from '../hooks/use-notifications.js';
import { readDevMode, setDevMode } from '../dev-mode.js';
import { devOnlyFlags, isFeatureOn } from '../feature-flags.js';
import { SignInMethodsCard } from './sign-in-methods.jsx';
import { ProfileSettingsCard } from './display-name.jsx';
import { DeleteAccountCard } from './delete-account.jsx';

// Settings as its own page (My docs layout A): a section list on the left,
// the existing settings cards on the right -- Profile, Sign-in methods and
// Delete account are the same components the old Settings tab showed; this
// page only orders them and adds the rows that were reachable elsewhere
// (teams from the space switcher, notification switches from the bell).

function TeamsCard({ teams, invites, onNewTeam }) {
  return (
    <section className="tm-settings-card" id="teams" aria-labelledby="settings-teams-h">
      <div className="tm-settings-head">
        <div><h2 id="settings-teams-h">Teams</h2><p>Spaces you share with other people, their members and invites.</p></div>
        {onNewTeam ? <AppButton onClick={onNewTeam}><Plus size={15} aria-hidden="true" />New team</AppButton> : null}
      </div>
      {invites}
      {teams.length ? (
        <div className="mds-rows">
          {teams.map((team) => (
            <div key={team.id} className="mds-row" data-team-id={team.id}>
              <span className="mds-row-ic mds-team-mark" aria-hidden="true">{String(team.name || '?').slice(0, 1).toUpperCase()}</span>
              <span className="mds-row-tx">
                <span>{team.name}</span>
                <small>{[team.member_count ? `${team.member_count} ${team.member_count === 1 ? 'member' : 'members'}` : null, team.role === 'admin' ? 'you are admin' : team.role === 'guest' ? 'guest' : 'member'].filter(Boolean).join(' · ')}</small>
              </span>
              <span className="mds-row-rt">
                <a className="ui-btn ui-btn-secondary ui-btn-m" href={`/me?team=${encodeURIComponent(team.id)}`}>Open</a>
                <a className="ui-btn ui-btn-quiet ui-btn-m" href={`/me?team=${encodeURIComponent(team.id)}&view=settings`}>Manage</a>
              </span>
            </div>
          ))}
        </div>
      ) : <p className="manage-hint">You are not in a team yet. A team shares its docs, folders and agents with every member.</p>}
    </section>
  );
}

function NotificationsCard() {
  const notifications = useNotifications(true);
  const { load } = notifications;
  // The email switch is read with the bell's first page.
  useEffect(() => { load().catch(() => {}); }, []);
  const unsupported = notifications.browserAlerts?.permission === 'unsupported' && !notifications.emailAlerts?.available;
  return (
    <section className="tm-settings-card" id="notifications" aria-labelledby="settings-notifications-h">
      <div className="tm-settings-head"><div><h2 id="settings-notifications-h">Notifications</h2><p>What reaches you outside tdoc: comments, replies and @mentions on your docs. Everything also shows under Needs you on My docs.</p></div></div>
      {unsupported ? <p className="manage-hint">This browser cannot show notifications, and email is not set up on this server.</p> : <NotificationSettings notifications={notifications} />}
    </section>
  );
}

function FeaturePreviewCard({ devMode }) {
  const [busy, setBusy] = useState(false);
  const flags = devOnlyFlags();
  return (
    <section className="tm-settings-card" id="preview" aria-labelledby="settings-preview-h">
      <div className="tm-settings-head"><div><h2 id="settings-preview-h">Feature preview</h2><p>Try features before they ship. They may change or break.</p></div></div>
      <div className="mds-row">
        <span className="mds-row-ic" aria-hidden="true"><Sparkles size={16} /></span>
        <span className="mds-row-tx">
          <span>Dev mode</span>
          <small>{flags.length ? `Shows ${flags.map((flag) => flag.label).join(', ')}` : 'Nothing is in preview right now'}</small>
        </span>
        <span className="mds-row-rt">
          <AppSwitch
            id="settings-dev-mode"
            checked={devMode.on}
            label={busy ? 'Switching…' : devMode.on ? 'On' : 'Off'}
            onCheckedChange={(next) => { setBusy(true); setDevMode(next).catch(() => setBusy(false)); }}
          />
        </span>
      </div>
    </section>
  );
}

const SECTIONS = [
  { id: 'profile', label: 'Profile', icon: UserRound },
  { id: 'sign-in-methods', label: 'Sign-in methods', icon: KeyRound },
  { id: 'agents', label: 'Agents & computers', icon: Bot },
  { id: 'teams', label: 'Teams', icon: UsersRound },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'preview', label: 'Feature preview', icon: Sparkles, devOnly: true },
  { id: 'delete-account', label: 'Danger zone', icon: ShieldAlert, danger: true, flag: 'deleteAccount' },
];

export function SettingsPage({ identity, profile, teams = [], invites = null, onNameSaved, onBack, onNewTeam }) {
  const name = identity?.name || identity?.email || identity?.login || 'Your account';
  const [devMode] = useState(readDevMode);
  const sections = SECTIONS.filter((section) => (!section.devOnly || devMode) && (!section.flag || isFeatureOn(section.flag)));
  const [active, setActive] = useState(() => {
    const hash = typeof location !== 'undefined' ? location.hash.slice(1) : '';
    if (hash === 'agent-access') return 'agents';
    return sections.some((section) => section.id === hash) ? hash : 'profile';
  });

  // The section nearest the top is the one the list marks; a click on the
  // list holds its choice while the page scrolls there.
  const heldUntil = useRef(0);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const seen = new Map();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting ? entry.boundingClientRect.top : null);
      if (Date.now() < heldUntil.current) return;
      const visible = [...seen.entries()].filter(([, top]) => top != null).sort((a, b) => a[1] - b[1]);
      if (visible.length) setActive(visible[0][0]);
    }, { rootMargin: '-64px 0px -55% 0px' });
    for (const section of sections) {
      const el = document.getElementById(section.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections.length]);

  // Arriving at #agents (the account menu's Agents) scrolls to it once the
  // cards have drawn.
  useEffect(() => {
    const hash = location.hash.slice(1);
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) el.scrollIntoView({ block: 'start' });
  }, []);

  const go = (event, id) => {
    event.preventDefault();
    heldUntil.current = Date.now() + 1200;
    setActive(id);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', `${location.pathname}${location.search}#${id}`);
  };

  return (
    <div className="mds">
      <nav className="mds-nav" aria-label="Settings sections">
        <button type="button" className="mds-back" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" />My docs</button>
        <h1>Settings</h1>
        {sections.map(({ id, label, icon: Icon, danger }) => (
          <a key={id} href={`#${id}`} className={`mds-nav-item${active === id ? ' is-on' : ''}${danger ? ' is-danger' : ''}`} aria-current={active === id ? 'true' : undefined} onClick={(event) => go(event, id)}>
            <Icon size={16} aria-hidden="true" />{label}
          </a>
        ))}
      </nav>
      <section className="tm-settings mds-body" aria-label="Personal workspace settings">
        <ProfileSettingsCard name={name} profile={profile} onNameSaved={onNameSaved} />
        <SignInMethodsCard />
        <div className="mds-group" id="agents-computers">
          <section className="tm-settings-card" id="agents">
            <div className="tm-settings-head"><div><h2>Agents &amp; computers</h2><p>Connect Raft, Claude Code, Codex, or a webhook for this workspace.</p></div></div>
            <ConnectorsBody returnTo="/me?view=settings#agents" />
          </section>
          <section className="tm-settings-card" id="agent-access">
            <div className="tm-settings-head"><div><h2>Agent access</h2><p>Computers and agents that can act as you, and which workspaces each one can reach.</p></div></div>
            <DevicesBody />
          </section>
          <ConnectAiAppsSection className="tm-settings-card" />
        </div>
        <TeamsCard teams={teams} invites={invites} onNewTeam={onNewTeam} />
        <NotificationsCard />
        {devMode ? <FeaturePreviewCard devMode={devMode} /> : null}
        {isFeatureOn('deleteAccount') ? <DeleteAccountCard /> : null}
      </section>
    </div>
  );
}
