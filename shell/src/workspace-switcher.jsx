import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, Plus, Settings } from 'lucide-react';
import { AppMenu, AppMenuItem, AppMenuLinkItem, AppMenuSeparator } from './ui/menu.jsx';

// Which space you are in, and every other one a click away, in the top bar
// on every page (Julie, 2026-10-16: "右上角 … 和 notion 一样 switch
// workspace"). It replaced the row of space pills on My docs: one switcher,
// the same on every page and on a phone. On My docs it switches in place
// (onSpace / onNewTeam); elsewhere it navigates. `space` is the current team
// id, '' for My docs, or null when the page belongs to no space. On a phone
// the chip is hidden and the same rows are a submenu of ⋯ (top-bar.jsx), so
// the bar keeps room for ⋯ itself.
// The viewer's teams: the page's own list when it has one, else fetched once.
export function useSpaceTeams(given = null, enabled = true) {
  const [teams, setTeams] = useState(given || null);
  useEffect(() => {
    if (given) { setTeams(given); return undefined; }
    if (!enabled) return undefined;
    const controller = new AbortController();
    fetch('/api/teams', { credentials: 'same-origin', signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (body && Array.isArray(body.teams)) setTeams(body.teams); })
      .catch(() => {});
    return () => controller.abort();
  }, [given, enabled]);
  return teams;
}

function currentSpace(space, list, currentTeam) {
  return space ? list.find((team) => team.id === space) || (currentTeam?.id === space ? currentTeam : null) : null;
}

// The rows of the space menu: My docs, each team (the current one checked),
// Workspace settings and New team. The top-bar chip shows them on a wide
// screen; on a phone they sit in the ⋯ menu under "Switch space".
export function SpaceMenuItems({ space = null, teams = null, currentTeam = null, onSpace = null, onNewTeam = null }) {
  const go = (id) => (onSpace ? onSpace(id) : (location.href = id ? `/me?team=${encodeURIComponent(id)}` : '/me'));
  const list = teams || [];
  const current = currentSpace(space, list, currentTeam);
  return (
    <>
      <AppMenuItem className="tdoc-action-menu-item" onClick={() => go('')}>
        <span className="tdoc-space-item-name">My docs</span>
        {space === '' ? <Check size={14} className="tdoc-space-check" aria-label="Current" /> : null}
      </AppMenuItem>
      {list.map((team) => (
        <AppMenuItem key={team.id} className="tdoc-action-menu-item" onClick={() => go(team.id)}>
          <span className="tdoc-space-item-name">{team.name}</span>
          {space === team.id ? <Check size={14} className="tdoc-space-check" aria-label="Current" /> : null}
        </AppMenuItem>
      ))}
      <AppMenuSeparator />
      <AppMenuLinkItem className="tdoc-action-menu-item" href={current ? `/me?team=${encodeURIComponent(current.id)}&view=settings` : '/me?view=settings'}>
        <Settings size={15} aria-hidden="true" />
        <span className="tdoc-space-item-name">Workspace settings</span>
      </AppMenuLinkItem>
      <AppMenuItem className="tdoc-action-menu-item" onClick={() => (onNewTeam ? onNewTeam() : (location.href = '/me?new_team=1'))}>
        <Plus size={15} aria-hidden="true" />
        <span className="tdoc-space-item-name">New team</span>
      </AppMenuItem>
    </>
  );
}

export function spaceLabel(space, teams, currentTeam) {
  const current = currentSpace(space, teams || [], currentTeam);
  return current ? current.name : 'My docs';
}

export function WorkspaceSwitcher({ space = null, teams = null, currentTeam = null, onSpace = null, onNewTeam = null }) {
  const label = spaceLabel(space, teams, currentTeam);
  return (
    <AppMenu trigger={(
      <button type="button" className="tdoc-chip tdoc-space-trigger" aria-label={`Space: ${label}. Switch space`}>
        <span className="name tdoc-space-name">{label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
    )}>
      <SpaceMenuItems space={space} teams={teams} currentTeam={currentTeam} onSpace={onSpace} onNewTeam={onNewTeam} />
    </AppMenu>
  );
}
