import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { AppMenu, AppMenuItem, AppMenuSeparator } from './ui/menu.jsx';

// Which space you are in, and every other one a click away, in the top bar
// on every page (Julie, 2026-10-16: "右上角 … 和 notion 一样 switch
// workspace"). It replaced the row of space pills on My docs: one switcher,
// the same on every page and on a phone. On My docs it switches in place
// (onSpace / onNewTeam); elsewhere it navigates. `space` is the current team
// id, '' for My docs, or null when the page belongs to no space.
export function spaceHue(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function WorkspaceSwitcher({ space = null, teams: given = null, currentTeam = null, onSpace = null, onNewTeam = null }) {
  const go = (id) => (onSpace ? onSpace(id) : (location.href = id ? `/me?team=${encodeURIComponent(id)}` : '/me'));
  const [teams, setTeams] = useState(given || null);
  useEffect(() => {
    if (given) { setTeams(given); return undefined; }
    const controller = new AbortController();
    fetch('/api/teams', { credentials: 'same-origin', signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (body && Array.isArray(body.teams)) setTeams(body.teams); })
      .catch(() => {});
    return () => controller.abort();
  }, [given]);
  const list = teams || [];
  const current = space ? list.find((team) => team.id === space) || (currentTeam?.id === space ? currentTeam : null) : null;
  const label = current ? current.name : 'My docs';
  return (
    <AppMenu trigger={(
      <button type="button" className="tdoc-chip tdoc-space-trigger" aria-label={`Space: ${label}. Switch space`}>
        <span className="name tdoc-space-name">{label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
    )}>
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
      <AppMenuItem className="tdoc-action-menu-item" onClick={() => (onNewTeam ? onNewTeam() : (location.href = '/me?new_team=1'))}>
        <Plus size={15} aria-hidden="true" />
        <span className="tdoc-space-item-name">New team</span>
      </AppMenuItem>
    </AppMenu>
  );
}
