import React, { useState } from 'react';
import { acceptTeamInvite, joinTeam } from './document/api.js';
import { TopBar } from './top-bar.jsx';

// The landing for a team invite link (/team/join/<token>) and for the team
// link (/t/<handle>) opened by someone on the invite list. The worker has
// already resolved the team and the session; this page only asks for the
// click. With a token the link itself is the proof; without one the invite
// list is, matched against the signed-in handle or address.
export function TeamJoinPage({ boot }) {
  const [status, setStatus] = useState('');
  const join = async () => {
    setStatus('Joining…');
    try {
      const res = await (boot.token ? joinTeam(boot.token) : acceptTeamInvite(boot.team.id));
      location.href = `/me?team=${encodeURIComponent(res.team.id)}`;
    } catch (error) {
      setStatus(error?.body?.error === 'team_full' ? `${boot.team.name} is full. Ask an admin to make room.` : (error.message || 'Could not join'));
    }
  };
  const count = boot.team.member_count;
  const who = boot.identity?.label || boot.identity?.name;
  return (
    <div className="tdoc-app tdoc-edge-page">
      <TopBar identity={boot.identity || null} />
      <main className="tdoc-status-page">
        <h1>Join {boot.team.name}</h1>
        <p>
          {count} {count === 1 ? 'member' : 'members'}. Members can open and comment on every doc in {boot.team.name}.
          {who ? ` You’ll join as ${who}.` : ''}
        </p>
        <div className="tdoc-status-actions">
          <button type="button" className="primary" onClick={join} disabled={status === 'Joining…'}>Join team</button>
          <a className="secondary" href="/me">Not now</a>
        </div>
        {status ? <p className="tdoc-status-note" role="status">{status}</p> : null}
        {boot.switch_href ? (
          <p className="tdoc-status-note">Not you? <a href={boot.switch_href}>Sign in with another account</a></p>
        ) : null}
      </main>
    </div>
  );
}
