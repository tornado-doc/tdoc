import React, { useState } from 'react';
import { Check, ChevronDown, Folder, Link2, Plus, UsersRound } from 'lucide-react';
import { TopBar } from './top-bar.jsx';
import { AppDialog } from './ui/dialog.jsx';
import { AppMenu, AppMenuItem, AppMenuSeparator } from './ui/menu.jsx';
import { DocRow } from './docs-hub/rows.jsx';
import { StatusPage } from './status-page.jsx';
import { InviteField } from './document/owner-access-dialog.jsx';
import './docs-hub.css';
import './onboarding-preview.css';
import './workspace-preview.css';

// Design review for JUL-71 (teams). Sample state only; served by the PR
// preview Worker, never production.
const me = { login: 'alex', name: 'Alex Morgan' };
const TEAM = { id: 'acme', name: 'Acme Research' };
const MEMBERS = [
  { id: 'alex', name: 'Alex Morgan', email: 'alex@acme.dev', role: 'admin' },
  { id: 'priya', name: 'Priya Shah', email: 'priya@acme.dev', role: 'admin' },
  { id: 'sam', name: 'Sam Lee', email: 'sam@acme.dev', role: 'member' },
  { id: 'jo', name: 'Jo Park', email: 'jo@acme.dev', role: 'member' },
];
const PENDING = ['dana@acme.dev'];
const PERSONAL_DOCS = [
  { slug: 'reading-notes', title: 'Reading notes', latest: 3, author: 'alex', updated: '2026-09-30' },
  { slug: 'trip-plan', title: 'Trip plan', latest: 1, author: 'alex', updated: '2026-09-21' },
];
const TEAM_DOCS = [
  { slug: 'q4-roadmap', title: 'Q4 roadmap', latest: 7, author: 'priya', updated: '2026-10-01' },
  { slug: 'launch-checklist', title: 'Launch checklist', latest: 4, author: 'alex', updated: '2026-09-29' },
  { slug: 'eval-results', title: 'Eval results', latest: 2, author: 'morgan', former: true, updated: '2026-09-12' },
];
const nameOf = (id) => MEMBERS.find((m) => m.id === id)?.name || (id === 'morgan' ? 'Morgan Wu' : id);

const SCREENS = [
  'My docs', 'Switch space', 'New team', 'Team docs (admin)', 'Team docs (member)',
  'Members (admin)', 'Members (member)', 'Last admin leaving', 'Invite link',
  'Share: personal doc', 'Share: team doc (author or admin)', 'Share: team doc (member)',
  'Move to team', 'Leave team',
];

function Avatar({ name }) {
  return <span className="tdoc-avatar-fallback" aria-hidden="true">{String(name || '?').slice(0, 1).toUpperCase()}</span>;
}

function PersonRow({ name, sub, right }) {
  return (
    <div className="wp-person">
      <Avatar name={name} />
      <div className="wp-person-text"><span>{name}</span>{sub ? <span className="wp-person-sub">{sub}</span> : null}</div>
      <div className="wp-person-right">{right}</div>
    </div>
  );
}

function SpaceSwitcher({ space, setSpace, onNewTeam, open, onOpenChange }) {
  return (
    <AppMenu
      align="start"
      open={open}
      onOpenChange={onOpenChange}
      trigger={<button type="button" className="wp-switch" aria-label="Switch space">{space === 'team' ? TEAM.name : 'My docs'}<ChevronDown size={18} /></button>}
    >
      <AppMenuItem onClick={() => setSpace('personal')}>
        <span className="wp-menu-check">{space === 'personal' ? <Check size={14} /> : null}</span>My docs
      </AppMenuItem>
      <AppMenuItem onClick={() => setSpace('team')}>
        <span className="wp-menu-check">{space === 'team' ? <Check size={14} /> : null}</span>{TEAM.name}
      </AppMenuItem>
      <AppMenuSeparator />
      <AppMenuItem onClick={onNewTeam}><span className="wp-menu-check"><Plus size={14} /></span>New team</AppMenuItem>
    </AppMenu>
  );
}

function Hub({ space, setSpace, admin, switcherOpen, onModal }) {
  const [menuOpen, setMenuOpen] = useState(switcherOpen);
  const team = space === 'team';
  const docs = team ? TEAM_DOCS : PERSONAL_DOCS;
  const docMenu = (doc) => {
    const mine = doc.author === me.login;
    return [
      { label: 'Share', onSelect: () => onModal(team ? (mine || admin ? 'Share: team doc (author or admin)' : 'Share: team doc (member)') : 'Share: personal doc') },
      !team ? { label: 'Move to team', onSelect: () => onModal('Move to team') } : null,
      team && mine ? { label: 'Move to My docs', onSelect: () => {} } : null,
      team && admin ? { label: 'Remove from team', onSelect: () => {} } : null,
      !team || admin ? { label: 'Delete', tone: 'danger', onSelect: () => {} } : null,
    ].filter(Boolean);
  };
  return (
    <div className="tdoc-app docs-hub">
      <TopBar identity={me} />
      <main className="wrap">
        <div className="page-hd">
          <h1><SpaceSwitcher space={space} setSpace={setSpace} onNewTeam={() => onModal('New team')} open={menuOpen} onOpenChange={setMenuOpen} /></h1>
          {team ? (
            <button type="button" className="new-folder-btn wp-members-btn" onClick={() => onModal(admin ? 'Members (admin)' : 'Members (member)')}>
              <UsersRound size={15} /> {MEMBERS.length} members
            </button>
          ) : null}
          <button className="mk-btn" type="button">Create a doc</button>
        </div>
        {team ? <p className="loc-hint wp-loc">Docs here belong to the team. Every member can open and comment.</p> : null}
        <div className="tabs" role="tablist">
          {['Docs', 'Recent', 'Starred'].map((label, i) => (
            <button key={label} type="button" className={`tab${i === 0 ? ' is-active' : ''}`} role="tab" aria-selected={i === 0}>{label}</button>
          ))}
        </div>
        <div className="doc-list">
          {docs.map((doc) => (
            <DocRow
              key={doc.slug}
              doc={doc}
              meta={[
                team ? `by ${doc.author === me.login ? 'me' : nameOf(doc.author)}${doc.former ? ' (former member)' : ''}` : 'me',
                `updated ${doc.updated}`,
              ].join(' · ')}
              onToggleStar={() => {}}
              menuItems={docMenu(doc)}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

function NewTeamDialog({ onClose }) {
  const [name, setName] = useState('');
  const [people, setPeople] = useState([]);
  return (
    <AppDialog open onOpenChange={(o) => { if (!o) onClose(); }} title="New team"
      actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" onClick={onClose} disabled={!name.trim()}>Create team</button></>}>
      <section className="manage-section">
        <label className="field" htmlFor="wp-team-name">Name</label>
        <input id="wp-team-name" type="text" autoFocus maxLength={60} placeholder="Acme Research" value={name} onChange={(e) => setName(e.target.value)} />
      </section>
      <section className="manage-section">
        <label className="field">Invite people</label>
        <InviteField users={people} onChange={setPeople} />
        <p className="manage-hint">You are the admin. You can invite more people later.</p>
      </section>
    </AppDialog>
  );
}

function MembersDialog({ admin, lastAdmin, onClose, onLeave }) {
  const [members, setMembers] = useState(lastAdmin ? MEMBERS.map((m) => (m.id === 'priya' ? { ...m, role: 'member' } : m)) : MEMBERS);
  const [pending, setPending] = useState(PENDING);
  const [copied, setCopied] = useState(false);
  const admins = members.filter((m) => m.role === 'admin').length;
  const setRole = (id, role) => setMembers((list) => list.map((m) => (m.id === id ? { ...m, role } : m)));
  const soleAdmin = admin && admins === 1;
  return (
    <AppDialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`${TEAM.name} members`}
      actions={<>
        <button type="button" className="danger" disabled={soleAdmin} onClick={onLeave}>Leave team</button>
        <button type="button" onClick={onClose}>Close</button>
      </>}>
      {admin ? (
        <section className="manage-section">
          <label className="field">Invite people</label>
          <InviteField users={[]} onChange={(added) => setPending((list) => [...list, ...added])} />
          <button type="button" className="wp-link-btn" onClick={() => setCopied(true)}><Link2 size={14} /> {copied ? 'Invite link copied' : 'Copy invite link'}</button>
        </section>
      ) : null}
      <section className="manage-section">
        <label className="field">{members.length} members</label>
        {members.map((m) => (
          <PersonRow key={m.id} name={`${m.name}${m.id === me.login ? ' (you)' : ''}`} sub={m.email}
            right={admin && !(m.role === 'admin' && admins === 1) ? (
              <select className="wp-role" aria-label={`Role for ${m.name}`} value={m.role}
                onChange={(e) => (e.target.value === 'remove' ? setMembers((list) => list.filter((x) => x.id !== m.id)) : setRole(m.id, e.target.value))}>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                {m.id !== me.login ? <option value="remove">Remove</option> : null}
              </select>
            ) : <span className="wp-role-label">{m.role === 'admin' ? 'Admin' : 'Member'}</span>} />
        ))}
        {pending.map((email) => (
          <PersonRow key={email} name={email} sub="Invited"
            right={admin ? <button type="button" className="wp-text-btn" onClick={() => setPending((list) => list.filter((x) => x !== email))}>Cancel invite</button> : null} />
        ))}
      </section>
      <p className="manage-hint">
        {soleAdmin ? 'You are the only admin. Make someone else an admin before you leave.'
          : admin ? 'Admins add and remove people, and can delete or remove any team doc.'
            : 'Only admins can invite or remove people.'}
      </p>
    </AppDialog>
  );
}

const ACCESS_HINT = {
  invited: 'Only people added above can open it.',
  team: `Everyone in ${TEAM.name} can open and comment.`,
  link: 'Anyone with the link can open it. Signed-in readers can comment.',
};

function ShareDialog({ kind, onClose }) {
  const team = kind !== 'personal';
  const canEdit = kind !== 'member';
  const [general, setGeneral] = useState(team ? 'team' : 'invited');
  const [people, setPeople] = useState(team ? ['dana@partner.io'] : ['bob']);
  const [copied, setCopied] = useState(false);
  const doc = team ? TEAM_DOCS[0] : PERSONAL_DOCS[0];
  return (
    <AppDialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`Share “${doc.title}”`}
      actions={<>
        <button type="button" className="wp-link-btn" onClick={() => setCopied(true)}><Link2 size={14} /> {copied ? 'Link copied' : 'Copy link'}</button>
        <button type="button" className="primary" onClick={onClose}>Done</button>
      </>}>
      {canEdit ? <InviteField users={[]} onChange={(added) => setPeople((list) => [...list, ...added.filter((x) => !list.includes(x))])} /> : null}
      <section className="manage-section">
        <label className="field">People with access</label>
        <PersonRow name={team ? nameOf(doc.author) : `${me.name} (you)`} sub={team ? 'Author' : 'Owner'} right={null} />
        {team ? <PersonRow name={TEAM.name} sub={`${MEMBERS.length} members`} right={<span className="wp-role-label">{general === 'invited' ? 'Admins only' : 'Can comment'}</span>} /> : null}
        {people.map((p) => (
          <PersonRow key={p} name={p} sub={p.includes('@') ? 'Invited by email' : 'GitHub'}
            right={canEdit ? <button type="button" className="wp-text-btn" aria-label={`Remove ${p}`} onClick={() => setPeople((list) => list.filter((x) => x !== p))}>Remove</button> : <span className="wp-role-label">Can comment</span>} />
        ))}
      </section>
      <section className="manage-section">
        <label className="field" htmlFor="wp-general">General access</label>
        <select id="wp-general" className="tdoc-select" value={general} disabled={!canEdit} onChange={(e) => setGeneral(e.target.value)}>
          <option value="invited">Only people with access</option>
          {team ? <option value="team">Everyone in {TEAM.name}</option> : null}
          <option value="link">Anyone with the link</option>
        </select>
        <p className="manage-hint">
          {ACCESS_HINT[general]}
          {!canEdit ? ' Only the author and team admins can change access.' : ''}
        </p>
      </section>
    </AppDialog>
  );
}

function MoveDialog({ onClose }) {
  return (
    <AppDialog open onOpenChange={(o) => { if (!o) onClose(); }} title="Move “Reading notes”"
      actions={<button type="button" onClick={onClose}>Cancel</button>}>
      <div className="move-list">
        <button type="button" onClick={onClose}><Folder size={15} /> My docs</button>
        <button type="button" onClick={onClose}><UsersRound size={15} /> {TEAM.name}</button>
      </div>
      <p className="manage-hint">Moving to a team makes the team its owner. You stay the author, and its sharing settings carry over.</p>
    </AppDialog>
  );
}

function LeaveDialog({ onClose }) {
  return (
    <AppDialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`Leave ${TEAM.name}?`}
      actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="danger" onClick={onClose}>Leave team</button></>}>
      <p>Your 1 doc in this team stays with the team, and your name stays on it as the author.</p>
      <p className="manage-hint">You lose access unless someone shares it with you. To keep a copy, move it to My docs first.</p>
    </AppDialog>
  );
}

const MODAL_FOR = {
  'New team': 'new-team', 'Members (admin)': 'members-admin', 'Members (member)': 'members-member',
  'Last admin leaving': 'members-last', 'Share: personal doc': 'share-personal',
  'Share: team doc (author or admin)': 'share-team', 'Share: team doc (member)': 'share-member',
  'Move to team': 'move', 'Leave team': 'leave',
};
const TEAM_SCREENS = new Set(['Team docs (admin)', 'Team docs (member)', 'Members (admin)', 'Members (member)', 'Last admin leaving', 'Share: team doc (author or admin)', 'Share: team doc (member)', 'Leave team']);

export default function WorkspacePreview() {
  const [screen, setScreen] = useState('My docs');
  const [modal, setModal] = useState(null);
  const [space, setSpace] = useState('personal');
  const [notice, setNotice] = useState('');
  const go = (next) => {
    setScreen(next);
    setNotice('');
    setModal(MODAL_FOR[next] || null);
    setSpace(TEAM_SCREENS.has(next) ? 'team' : 'personal');
  };
  const admin = !['Team docs (member)', 'Members (member)', 'Share: team doc (member)'].includes(screen);
  const close = () => setModal(null);
  const keepInPreview = (event) => {
    const link = event.target.closest('a');
    if (link) { event.preventDefault(); event.stopPropagation(); setNotice('Preview only. Links do not open.'); }
  };
  return (
    <div className="op-preview" onClickCapture={keepInPreview}>
      <nav className="op-nav" aria-label="Workspace preview states">
        <div><strong>Teams preview (JUL-71)</strong><span>Proposed UI · sample data</span></div>
        <label>Screen <select value={screen} onChange={(e) => go(e.target.value)}>{SCREENS.map((s) => <option key={s}>{s}</option>)}</select></label>
      </nav>
      {notice ? <p className="op-notice" role="status">{notice}</p> : null}
      {screen === 'Invite link' ? (
        <StatusPage boot={{
          title: `Join ${TEAM.name}`,
          message: `Priya Shah invited you. Members can open and comment on every doc in ${TEAM.name}.`,
          actions: [{ label: 'Join team', href: '/me?team=acme', primary: true }, { label: 'Not now', href: '/me' }],
        }} />
      ) : (
        <Hub key={screen} space={space} setSpace={setSpace} admin={admin} switcherOpen={screen === 'Switch space'}
          onModal={(next) => setModal(MODAL_FOR[next])} />
      )}
      {modal === 'new-team' ? <NewTeamDialog onClose={close} /> : null}
      {modal === 'members-admin' ? <MembersDialog admin onClose={close} onLeave={() => setModal('leave')} /> : null}
      {modal === 'members-member' ? <MembersDialog admin={false} onClose={close} onLeave={() => setModal('leave')} /> : null}
      {modal === 'members-last' ? <MembersDialog admin lastAdmin onClose={close} onLeave={() => setModal('leave')} /> : null}
      {modal === 'share-personal' ? <ShareDialog kind="personal" onClose={close} /> : null}
      {modal === 'share-team' ? <ShareDialog kind="team" onClose={close} /> : null}
      {modal === 'share-member' ? <ShareDialog kind="member" onClose={close} /> : null}
      {modal === 'move' ? <MoveDialog onClose={close} /> : null}
      {modal === 'leave' ? <LeaveDialog onClose={close} /> : null}
    </div>
  );
}
