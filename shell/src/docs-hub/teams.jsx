import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, Link2, Plus, UsersRound } from 'lucide-react';
import { AppDialog } from '../ui/dialog.jsx';
import { AppMenu, AppMenuItem, AppMenuSeparator } from '../ui/menu.jsx';
import { InviteField } from '../document/owner-access-dialog.jsx';
import { copyText } from '../document/model.js';
import {
  acceptTeamInvite,
  createTeam,
  declineTeamInvite,
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
  team_full: 'This team is full.',
  not_invited: 'This invite is no longer open. Ask a team admin to invite you again.',
  email_required: 'Your sign-in did not share a verified email, so it cannot be matched to an email invite.',
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

export function SpaceSwitcher({ teams, space, onSpace, onNewTeam }) {
  const current = teams.find((team) => team.id === space);
  return (
    <AppMenu
      align="start"
      trigger={(
        <button type="button" className="tm-switch" aria-label="Switch space">
          {current ? current.name : 'My docs'}
          <ChevronDown size={18} />
        </button>
      )}
    >
      <AppMenuItem onClick={() => onSpace('')}>
        <span className="tm-menu-check">{!current ? <Check size={14} /> : null}</span>My docs
      </AppMenuItem>
      {teams.map((team) => (
        <AppMenuItem key={team.id} onClick={() => onSpace(team.id)}>
          <span className="tm-menu-check">{current?.id === team.id ? <Check size={14} /> : null}</span>{team.name}
        </AppMenuItem>
      ))}
      <AppMenuSeparator />
      <AppMenuItem className="tm-new-team" onClick={onNewTeam}>
        <span className="tm-menu-check"><Plus size={14} /></span>New team
      </AppMenuItem>
    </AppMenu>
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
        <p className="manage-hint">You are the admin. Invitees see the invite in their notifications and on My docs once they sign in with that GitHub account or email.</p>
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
              <label className="tm-check">
                <input
                  type="checkbox"
                  checked={team.anyone_with_link}
                  onChange={(event) => apply(() => updateTeam(team.id, { anyone_with_link: event.target.checked }))}
                />
                Anyone with the link can join
              </label>
              {team.invite_url ? (
                <button
                  type="button"
                  className="tm-link-btn"
                  onClick={() => copyText(team.invite_url).then(() => setCopied(true))}
                >
                  <Link2 size={14} /> {copied ? 'Invite link copied' : 'Copy invite link'}
                </button>
              ) : null}
              <p className="manage-hint">
                {team.anyone_with_link
                  ? 'Anyone signed in who has the link can join as a member.'
                  : 'Only people you invited can join, from the link or from their notifications.'}
              </p>
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
                  <select
                    className="tm-role"
                    aria-label={`Role for ${m.name}`}
                    value={m.role}
                    onChange={(event) => {
                      const value = event.target.value;
                      apply(() => (value === 'remove'
                        ? removeTeamMember(team.id, m.account_id)
                        : setTeamRole(team.id, m.account_id, value)));
                    }}
                  >
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                    {!m.me ? <option value="remove">Remove</option> : null}
                  </select>
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

export function PendingInvites({ invites, onDone }) {
  const [status, setStatus] = useState('');
  if (!invites.length) return null;
  const drop = (id) => onDone(invites.filter((invite) => invite.id !== id));
  const accept = async (invite) => {
    setStatus(`Joining ${invite.name}…`);
    try {
      await acceptTeamInvite(invite.id);
      location.href = `/me?team=${encodeURIComponent(invite.id)}`;
    } catch (error) {
      setStatus(message(error));
      if (error?.body?.error === 'not_invited') drop(invite.id);
    }
  };
  const decline = async (invite) => {
    setStatus('');
    try {
      await declineTeamInvite(invite.id);
      drop(invite.id);
    } catch (error) {
      setStatus(message(error));
    }
  };
  return (
    <section className="tm-invites" aria-label="Team invites">
      {invites.map((invite) => (
        <div className="tm-invite" key={invite.id}>
          <UsersRound size={16} />
          <span className="tm-invite-text">
            {invite.invited_by ? `${invite.invited_by} invited you to join ` : 'You are invited to join '}
            <strong>{invite.name}</strong>
            <span className="muted"> · {invite.member_count} {invite.member_count === 1 ? 'member' : 'members'}</span>
          </span>
          <button type="button" onClick={() => decline(invite)}>Decline</button>
          <button type="button" className="primary" onClick={() => accept(invite)}>Accept</button>
        </div>
      ))}
      {status ? <p className="status" role="status">{status}</p> : null}
    </section>
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
