import React, { useEffect, useState } from 'react';
import { Link2, Plus, UserRound, UsersRound } from 'lucide-react';
import { AppDialog } from '../ui/dialog.jsx';
import { AppSelect } from '../ui/select.jsx';
import { InviteField } from '../document/owner-access-dialog.jsx';
import { copyText } from '../document/model.js';
import {
  createTeam,
  getTeam,
  removeTeamMember,
  setTeamRole,
  updateTeam,
} from '../document/api.js';
import { DocRow, day } from './rows.jsx';
import './teams.css';

const ERRORS = {
  last_admin: 'Make someone else an admin first. A team always keeps at least one admin.',
  team_limit: 'You are in the maximum number of teams.',
  invalid_name: 'Give the team a name (up to 60 characters).',
};
const message = (error) => ERRORS[error?.body?.error] || error?.message || 'Request failed';

function Avatar({ member }) {
  const key = member.key || '';
  if (key && !key.startsWith('email:') && !key.includes('@')) {
    return <img src={`https://github.com/${encodeURIComponent(key)}.png?size=52`} alt="" />;
  }
  return <span className="tdoc-avatar-fallback" aria-hidden="true">{String(member.name || key || '?').slice(0, 1).toUpperCase()}</span>;
}

function PersonRow({ member, name, sub, right }) {
  return (
    <div className="tm-person">
      <Avatar member={member} />
      <div className="tm-person-text">
        <span>{name}</span>
        {sub ? <span className="tm-person-sub">{sub}</span> : null}
      </div>
      <div className="tm-person-right">{right}</div>
    </div>
  );
}

// The spaces, side by side and always in view (Julie, 2026-10-10: a title
// that is secretly a dropdown is not where a first-time person looks for
// their team). One pill per space, the current one filled; New team at the
// end, so a person with no team yet learns that teams exist. On a phone the
// row scrolls sideways instead of wrapping into a block.
function teamHue(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
export function SpaceBar({ teams, space, onSpace, onNewTeam }) {
  const pill = (id, label, icon) => (
    <button
      key={id || 'me'}
      type="button"
      role="tab"
      aria-selected={space === id}
      className={`tm-space${space === id ? ' is-active' : ''}`}
      onClick={() => onSpace(id)}
    >
      {icon}
      <span className="tm-space-name">{label}</span>
    </button>
  );
  return (
    <nav className="tm-spaces" aria-label="Spaces">
      <div className="tm-spaces-row" role="tablist">
        {pill('', 'My docs', <UserRound size={14} aria-hidden="true" />)}
        {teams.map((team) => pill(team.id, team.name, (
          <span className="tm-space-mark" aria-hidden="true" style={{ background: `hsl(${teamHue(team.id)} 55% 46%)` }}>
            {String(team.name || '?').trim().slice(0, 1).toUpperCase()}
          </span>
        )))}
        <button type="button" className="tm-space tm-space-new" onClick={onNewTeam}>
          <Plus size={14} aria-hidden="true" />
          <span className="tm-space-name">New team</span>
        </button>
      </div>
    </nav>
  );
}

export function TeamPane({ team, docs, viewer, menuFor }) {
  return (
    <section className="pane" id="pane-team">
      <div className="doc-list">
        {docs.map((doc) => (
          <DocRow
            key={doc.slug}
            doc={doc}
            meta={[
              `by ${doc.mine ? 'me' : doc.author || 'unknown'}${doc.former_member ? ' (former member)' : ''}`,
              day(doc.updated) ? `updated ${day(doc.updated)}` : null,
            ].filter(Boolean).join(' · ')}
            starrable={false}
            menuItems={menuFor(doc)}
            data={{ created: doc.created, updated: doc.updated, author: doc.author || viewer }}
          />
        ))}
      </div>
      {!docs.length ? (
        <p className="empty">No docs in {team.name} yet. Create one, or move one here from My docs.</p>
      ) : null}
    </section>
  );
}

export function NewTeamDialog({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [people, setPeople] = useState([]);
  const [status, setStatus] = useState('');
  const submit = async () => {
    setStatus('Creating…');
    try {
      const res = await createTeam(name.trim(), people);
      onCreated(res.team);
    } catch (error) {
      setStatus(message(error));
    }
  };
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="New team"
      actions={(
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={submit} disabled={!name.trim() || status === 'Creating…'}>Create team</button>
        </>
      )}
    >
      <section className="manage-section">
        <label className="field" htmlFor="tm-team-name">Name</label>
        <input
          id="tm-team-name"
          type="text"
          autoFocus
          maxLength={60}
          placeholder="Acme Research"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && name.trim()) submit(); }}
        />
      </section>
      <section className="manage-section">
        <label className="field">Invite people</label>
        <InviteField users={people} onChange={setPeople} />
        <p className="manage-hint">You are the admin. Invitees join with the team’s invite link, which you can copy from Members.</p>
      </section>
      {status ? <p className="status" role="status">{status}</p> : null}
    </AppDialog>
  );
}

export function MembersDialog({ teamId, onClose, onLeave, onChanged }) {
  const [team, setTeam] = useState(null);
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getTeam(teamId).then((res) => setTeam(res.team)).catch((error) => setStatus(message(error)));
  }, [teamId]);

  const apply = async (operation) => {
    setStatus('Saving…');
    try {
      const res = await operation();
      if (res?.team) {
        setTeam(res.team);
        onChanged(res.team);
      }
      const emailed = Array.isArray(res?.emailed) ? res.emailed : [];
      setStatus(emailed.length ? `Saved. Invitation emailed to ${emailed.join(', ')}.` : 'Saved.');
    } catch (error) {
      setStatus(message(error));
    }
  };

  const admin = team?.role === 'admin';
  const admins = team ? team.members.filter((m) => m.role === 'admin').length : 0;
  const soleAdmin = admin && admins === 1;
  const me = team?.members.find((m) => m.me);

  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={team ? `${team.name} members` : 'Members'}
      actions={(
        <>
          <button type="button" className="danger tm-push-left" disabled={!team || soleAdmin} onClick={() => onLeave(team, me)}>Leave team</button>
          <button type="button" onClick={onClose}>Close</button>
        </>
      )}
    >
      {!team ? <p className="muted">{status || 'Loading…'}</p> : (
        <>
          {admin ? (
            <section className="manage-section">
              <label className="field">Invite people</label>
              <InviteField
                users={[]}
                onChange={(added) => apply(() => updateTeam(team.id, { invites: [...team.invites, ...added.filter((x) => !team.invites.includes(x))] }))}
              />
              {team.invite_url ? (
                <button
                  type="button"
                  className="tm-link-btn"
                  onClick={() => copyText(team.invite_url).then(() => setCopied(true))}
                >
                  <Link2 size={14} /> {copied ? 'Invite link copied' : 'Copy invite link'}
                </button>
              ) : null}
            </section>
          ) : null}
          <section className="manage-section">
            <label className="field">{team.members.length} {team.members.length === 1 ? 'member' : 'members'}</label>
            {team.members.map((m) => (
              <PersonRow
                key={m.account_id}
                member={m}
                name={`${m.name}${m.me ? ' (you)' : ''}`}
                sub={m.key && !m.key.startsWith('email:') ? `@${m.key}` : null}
                right={admin && !(m.role === 'admin' && admins === 1) ? (
                  <AppSelect
                    plain
                    className="tm-role"
                    ariaLabel={`Role for ${m.name}`}
                    value={m.role}
                    onChange={(value) => {
                      apply(() => (value === 'remove'
                        ? removeTeamMember(team.id, m.account_id)
                        : setTeamRole(team.id, m.account_id, value)));
                    }}
                    options={[
                      { value: 'admin', label: 'Admin' },
                      { value: 'member', label: 'Member' },
                      ...(!m.me ? [{ value: 'remove', label: 'Remove' }] : []),
                    ]}
                  />
                ) : <span className="tm-role-label">{m.role === 'admin' ? 'Admin' : 'Member'}</span>}
              />
            ))}
            {team.invites.map((invitee) => (
              <PersonRow
                key={invitee}
                member={{ key: invitee, name: invitee }}
                name={invitee}
                sub="Invited"
                right={admin ? (
                  <button
                    type="button"
                    className="tm-text-btn"
                    onClick={() => apply(() => updateTeam(team.id, { invites: team.invites.filter((x) => x !== invitee) }))}
                  >
                    Cancel invite
                  </button>
                ) : null}
              />
            ))}
          </section>
          <p className="manage-hint">
            {soleAdmin ? 'You are the only admin. Make someone else an admin before you leave.'
              : admin ? 'Admins add and remove people, and can change access on or delete any team doc.'
                : 'Only admins can invite or remove people.'}
          </p>
          <p className="status" role="status">{status || '\u00a0'}</p>
        </>
      )}
    </AppDialog>
  );
}

export function MoveToTeamDialog({ teams, count, onMove, onClose }) {
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={`Move ${count === 1 ? 'this doc' : `${count} docs`} to a team`}
      actions={<button type="button" onClick={onClose}>Cancel</button>}
    >
      <div className="move-list">
        {teams.map((team) => (
          <button key={team.id} type="button" onClick={() => onMove(team)}>
            <UsersRound size={15} /> {team.name}
          </button>
        ))}
      </div>
      <p className="manage-hint">The team becomes the owner and every member can open and comment. You stay the author.</p>
    </AppDialog>
  );
}

export function LeaveTeamDialog({ team, docCount, onLeave, onClose }) {
  const [status, setStatus] = useState('');
  const leave = async () => {
    setStatus('Leaving…');
    try {
      await onLeave();
    } catch (error) {
      setStatus(message(error));
    }
  };
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={`Leave ${team.name}?`}
      actions={(
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="danger" onClick={leave}>Leave team</button>
        </>
      )}
    >
      <p>
        {docCount
          ? `Your ${docCount === 1 ? 'doc' : `${docCount} docs`} in this team ${docCount === 1 ? 'stays' : 'stay'} with the team, and your name stays on ${docCount === 1 ? 'it' : 'them'} as the author.`
          : 'You will no longer see this team’s docs.'}
      </p>
      <p className="manage-hint">You lose access unless someone shares it with you. To keep a copy, open it and use Duplicate first.</p>
      {status ? <p className="status" role="status">{status}</p> : null}
    </AppDialog>
  );
}
