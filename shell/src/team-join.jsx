import React, { useState } from 'react';
import { joinTeam } from './document/api.js';

const ERRORS = {
  not_invited: 'You haven’t been invited to this team. Ask a team admin to invite you.',
  email_required: 'Your sign-in did not share a verified email, so it cannot be matched to an email invite.',
};

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
      setStatus(ERRORS[error?.body?.error] || error.message || 'Could not join');
    }
  };
  const count = boot.team.member_count;
  return (
    <main className="tdoc-status-page">
      <img src="/tdoc_logo.svg" width="44" height="44" alt="" />
      <h1>Join {boot.team.name}</h1>
      <p>
        {count} {count === 1 ? 'member' : 'members'}. Every member can read, comment on and edit the docs in {boot.team.name}.
        {boot.identity?.name ? ` You’ll join as ${boot.identity.name}.` : ''}
      </p>
      <div className="tdoc-status-actions pair">
        <button type="button" className="primary" onClick={join} disabled={status === 'Joining…'}>Join team</button>
        <a className="secondary" href="/me">Not now</a>
      </div>
      {status ? <p className="tdoc-status-note" role="status">{status}</p> : null}
    </main>
  );
}
