import React, { useState } from 'react';
import { joinTeam } from './document/api.js';

// The landing for a team invite link. The worker has already resolved the
// token and the session; this page only asks for the click.
export function TeamJoinPage({ boot }) {
  const [status, setStatus] = useState('');
  const join = async () => {
    setStatus('Joining…');
    try {
      const res = await joinTeam(boot.token);
      location.href = `/me?team=${encodeURIComponent(res.team.id)}`;
    } catch (error) {
      setStatus(error.message || 'Could not join');
    }
  };
  const count = boot.team.member_count;
  return (
    <main className="tdoc-status-page">
      <img src="/tdoc_logo.svg" width="44" height="44" alt="" />
      <h1>Join {boot.team.name}</h1>
      <p>
        {count} {count === 1 ? 'member' : 'members'}. Members can open and comment on every doc in {boot.team.name}.
        {boot.identity?.name ? ` You’ll join as ${boot.identity.name}.` : ''}
      </p>
      <div className="tdoc-status-actions">
        <button type="button" className="primary" onClick={join} disabled={status === 'Joining…'}>Join team</button>
        <a className="secondary" href="/me">Not now</a>
      </div>
      {status ? <p className="tdoc-status-note" role="status">{status}</p> : null}
    </main>
  );
}
