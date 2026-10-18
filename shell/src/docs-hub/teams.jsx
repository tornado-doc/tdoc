import React, { useEffect, useState } from 'react';
import { DatabaseBackup, Link2, MessageSquareText, RefreshCw, SlidersHorizontal, UsersRound } from 'lucide-react';
import { AppDialog } from '../ui/dialog.jsx';
import { AppSelect } from '../ui/select.jsx';
import { InviteField } from '../document/owner-access-dialog.jsx';
import { copyText } from '../document/model.js';
import {
  createTeam,
  getTeamBackup,
  getTeam,
  listTeamComments,
  moveFolderToTeam,
  removeTeamBackup,
  removeTeamMember,
  saveTeamBackup,
  setTeamRole,
  syncTeamBackup,
  updateTeam,
} from '../document/api.js';
import { DocList, day } from './rows.jsx';
import { ConnectorsBody } from '../connectors-page.jsx';
import './teams.css';

const ERRORS = {
  last_admin: 'Make someone else an admin first. A team always keeps at least one admin.',
  team_limit: 'You are in the maximum number of teams.',
  invalid_name: 'Give the team a name (up to 60 characters).',
  too_many_folders: 'That team has too many folders to take these. Delete or merge some first.',
  backup_queue_unavailable: 'Data Mirror is not available on this deployment yet.',
  backup_queue_failed: 'The bucket is connected, but tdoc could not queue the backup. Try Sync everything again.',
  backup_connection_failed: 'tdoc could not write to that bucket. Check the endpoint, bucket, region and keys.',
  backup_encryption_unavailable: 'This deployment needs its Data Mirror encryption key configured.',
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

function teamHue(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
export function TeamPane({ team, docs, viewer, menuFor, inFolder = false, layout = 'list' }) {
  return (
    <section className="pane" id="pane-team">
      <DocList
        docs={docs}
        layout={layout}
        rowProps={(doc) => ({
          meta: [
            `by ${doc.mine ? 'me' : doc.author || 'unknown'}${doc.former_member ? ' (former member)' : ''}`,
            day(doc.updated) ? `updated ${day(doc.updated)}` : null,
          ].filter(Boolean).join(' · '),
          starrable: false,
          menuItems: menuFor(doc),
          data: { created: doc.created, updated: doc.updated, author: doc.author || viewer },
        })}
        empty={!inFolder ? `No docs in ${team.name} yet. Create one, or move one here from My docs.` : null}
      />
    </section>
  );
}

function commentDate(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function commentTarget(item) {
  const version = Math.max(1, Number(item.version) || 1);
  return `/d/${encodeURIComponent(item.slug)}/v/${version}?comment=${encodeURIComponent(item.id || item.thread_id)}`;
}

function CommentAvatar({ author }) {
  if (author?.avatar_url) return <img className="tm-comment-avatar" src={author.avatar_url} alt="" />;
  return <span className="tm-comment-avatar tm-comment-avatar--anon" aria-hidden="true">{String(author?.name || '?').slice(0, 1).toUpperCase()}</span>;
}

// A browseable team review surface, separate from the bell. The bell answers
// “what needs my attention”; this answers “what is everyone discussing across
// this team?” and therefore intentionally includes comments not addressed to
// the current viewer.
export function TeamCommentsPane({ team }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadedDocs, setLoadedDocs] = useState(0);
  const [totalDocs, setTotalDocs] = useState(0);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('unresolved');
  const [replyState, setReplyState] = useState('all');
  const [authorKind, setAuthorKind] = useState('all');
  const [person, setPerson] = useState('');
  const [doc, setDoc] = useState('');
  const [since, setSince] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setItems([]);
    setLoading(true);
    setLoadedDocs(0);
    setTotalDocs(0);
    setError('');
    (async () => {
      let offset = 0;
      try {
        do {
          const page = await listTeamComments(team.id, offset);
          if (cancelled) return;
          setItems((current) => [...current, ...(page.items || [])]);
          setLoadedDocs((n) => n + Number(page.docs_scanned || 0));
          setTotalDocs(Number(page.docs_total || 0));
          offset = page.next == null ? null : Number(page.next);
        } while (offset != null);
      } catch (e) {
        if (!cancelled) setError(message(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [team.id]);

  const people = new Map();
  const docs = new Map();
  for (const item of items) {
    if (item.author?.key) people.set(item.author.key, item.author.name || item.author.key);
    if (item.slug) docs.set(item.slug, item.title || item.slug);
  }
  const sinceMs = since ? Date.parse(`${since}T00:00:00`) : 0;
  const advancedCount = [replyState !== 'all', authorKind !== 'all', !!person, !!doc, !!since].filter(Boolean).length;
  const clearAdvanced = () => {
    setReplyState('all');
    setAuthorKind('all');
    setPerson('');
    setDoc('');
    setSince('');
  };
  const shown = items
    .filter((item) => status === 'all' || (status === 'resolved' ? item.resolved : !item.resolved))
    .filter((item) => replyState === 'all'
      || (replyState === 'unreplied' ? item.kind === 'comment' && Number(item.reply_count || 0) === 0 : Number(item.reply_count || 0) > 0))
    .filter((item) => authorKind === 'all' || item.author?.kind === authorKind)
    .filter((item) => !person || item.author?.key === person)
    .filter((item) => !doc || item.slug === doc)
    .filter((item) => !sinceMs || Date.parse(item.created || '') >= sinceMs)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));

  return (
    <section className="pane tm-comments-pane" id="pane-team-comments">
      <div className="tm-comment-toolbar" aria-label="Filter team comments">
        <AppSelect
          className="tm-comment-filter"
          ariaLabel="Comment status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'unresolved', label: 'Unresolved' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'all', label: 'All status' },
          ]}
        />
        <button type="button" className={`tm-comment-filter-button${advancedCount ? ' is-active' : ''}`} onClick={() => setFiltersOpen(true)}>
          <SlidersHorizontal size={15} aria-hidden="true" />
          Filters{advancedCount ? ` · ${advancedCount}` : ''}
        </button>
      </div>

      <AppDialog
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        title="Filter comments"
        className="tm-comment-filter-dialog"
        actions={(
          <>
            {advancedCount ? <button type="button" className="tdoc-quiet-link tm-push-left" onClick={clearAdvanced}>Clear filters</button> : null}
            <button type="button" onClick={() => setFiltersOpen(false)}>Done</button>
          </>
        )}
      >
        <div className="tm-comment-filter-fields">
          <label className="field">
            <span>Replies</span>
            <AppSelect
              ariaLabel="Reply status"
              value={replyState}
              onChange={setReplyState}
              options={[
                { value: 'all', label: 'All conversations' },
                { value: 'unreplied', label: 'Unreplied' },
                { value: 'replied', label: 'Replied' },
              ]}
            />
          </label>
          <label className="field">
            <span>Authors</span>
            <AppSelect
              ariaLabel="Author type"
              value={authorKind}
              onChange={setAuthorKind}
              options={[
                { value: 'all', label: 'People + AI' },
                { value: 'human', label: 'People only' },
                { value: 'agent', label: 'AI only' },
              ]}
            />
          </label>
          <label className="field">
            <span>Person</span>
            <AppSelect
              ariaLabel="Comment author"
              value={person}
              onChange={setPerson}
              options={[
                { value: '', label: 'All people' },
                ...[...people].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
              ]}
            />
          </label>
          <label className="field">
            <span>Document</span>
            <AppSelect
              ariaLabel="Comment document"
              value={doc}
              onChange={setDoc}
              options={[
                { value: '', label: 'All docs' },
                ...[...docs].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
              ]}
            />
          </label>
          <label className="field tm-comment-since">
            <span>Since</span>
            <input type="date" value={since} onChange={(event) => setSince(event.target.value)} />
          </label>
        </div>
      </AppDialog>

      {loading ? <p className="muted tm-comment-progress">Loading comments… {loadedDocs}{totalDocs ? ` of ${totalDocs}` : ''} docs</p> : null}
      {error ? <p className="tm-comment-error">{error}</p> : null}
      {!loading && !error && !shown.length ? (
        <div className="empty">
          <MessageSquareText size={22} aria-hidden="true" />
          <p>{items.length ? 'No comments match these filters.' : `No comments in ${team.name} yet.`}</p>
        </div>
      ) : null}
      <div className="tm-comment-list">
        {shown.map((item) => (
          <a className={`tm-comment-row${item.resolved ? ' is-resolved' : ''}`} href={commentTarget(item)} key={`${item.slug}:${item.id}`}>
            <CommentAvatar author={item.author} />
            <span className="tm-comment-body">
              <span className="tm-comment-line">
                <strong>{item.author?.name || 'Someone'}</strong>
                <span>{item.kind === 'reply' ? 'replied in' : 'commented on'}</span>
                <b>{item.title || item.slug}</b>
                <span className={`tm-comment-status${item.resolved ? ' resolved' : ''}`}>{item.resolved ? 'Resolved' : 'Unresolved'}</span>
              </span>
              <span className="tm-comment-text">{item.text}</span>
              {item.anchor ? <span className="tm-comment-anchor">“{item.anchor}”</span> : null}
            </span>
            <time className="tm-comment-time" dateTime={item.created}>{commentDate(item.created)}</time>
          </a>
        ))}
      </div>
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

export function MembersDialog({ teamId, onClose, onLeave, onChanged, inline = false }) {
  const [team, setTeam] = useState(null);
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState('');

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
  const Shell = inline ? 'section' : AppDialog;
  const shellProps = inline ? { className: 'tm-settings-card', 'aria-labelledby': 'tm-members-heading' } : {
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
    title: team ? `${team.name} members` : 'Members',
    actions: (
      <>
        <button type="button" className="danger tm-push-left" disabled={!team || soleAdmin} onClick={() => onLeave(team, me)}>Leave team</button>
        <button type="button" onClick={onClose}>Close</button>
      </>
    ),
  };

  return (
    <Shell {...shellProps}>
      {inline ? <div className="tm-settings-head"><div><h2 id="tm-members-heading">Members</h2><p>Invite people and manage who can administer this workspace.</p></div><span>{team?.members?.length || 0}</span></div> : null}
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
                  onClick={() => copyText(team.invite_url).then(() => setCopied('invite'))}
                >
                  <Link2 size={14} /> {copied === 'invite' ? 'Invite link copied' : 'Copy invite link'}
                </button>
              ) : null}
            </section>
          ) : null}
          {team.team_url ? (
            <section className="manage-section">
              <label className="field">Team link</label>
              <div className="tm-team-link">
                <code>{team.team_url.replace(/^https?:\/\//, '')}</code>
                <button type="button" className="tm-text-btn" onClick={() => copyText(team.team_url).then(() => setCopied('team'))}>
                  {copied === 'team' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="manage-hint">Opens the team for members and for people on the invite list. Anyone else is told whom to ask.</p>
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
          {inline ? (
            <button type="button" className="danger tm-settings-leave" disabled={soleAdmin} onClick={() => onLeave(team, me)}>Leave workspace</button>
          ) : null}
        </>
      )}
    </Shell>
  );
}

function backupTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

export function TeamBackupDialog({ team, onClose, inline = false }) {
  const [backup, setBackup] = useState(null);
  const [form, setForm] = useState({ endpoint: '', bucket: '', region: 'auto', prefix: 'tdoc-backups', access_key_id: '', secret_access_key: '' });
  const [status, setStatus] = useState('Loading…');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getTeamBackup(team.id).then((result) => {
      const next = result.backup || { enabled: false };
      setBackup(next);
      if (next.enabled) setForm((current) => ({
        ...current,
        endpoint: next.endpoint || '', bucket: next.bucket || '', region: next.region || 'auto', prefix: next.prefix || 'tdoc-backups',
      }));
      setStatus('');
    }).catch((error) => setStatus(message(error)));
  }, [team.id]);

  const field = (name) => (event) => setForm((current) => ({ ...current, [name]: event.target.value }));
  const save = async () => {
    setBusy(true);
    setStatus('Testing the bucket…');
    try {
      const result = await saveTeamBackup(team.id, form);
      setBackup(result.backup);
      setForm((current) => ({ ...current, secret_access_key: '' }));
      setStatus('Connected. The first full backup is running in the background.');
    } catch (error) { setStatus(message(error)); }
    setBusy(false);
  };
  const sync = async () => {
    setBusy(true);
    setStatus('Starting a full sync…');
    try {
      const result = await syncTeamBackup(team.id);
      setBackup(result.backup);
      setStatus('Full sync started. Automatic backups stay on.');
    } catch (error) { setStatus(message(error)); }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    setStatus('Turning off…');
    try {
      await removeTeamBackup(team.id);
      setBackup({ enabled: false });
      setStatus('Data Mirror is off. Existing files in your bucket were not deleted.');
    } catch (error) { setStatus(message(error)); }
    setBusy(false);
  };
  const Shell = inline ? 'section' : AppDialog;
  const saveButton = <button type="button" className="primary" onClick={save} disabled={busy || !form.endpoint.trim() || !form.bucket.trim() || !form.region.trim() || !form.access_key_id.trim() || !form.secret_access_key}>Connect and back up</button>;
  const shellProps = inline ? { className: 'tm-settings-card', 'aria-labelledby': 'tm-backup-heading' } : {
    open: true,
    onOpenChange: (open) => { if (!open && !busy) onClose(); },
    title: `${team.name} data backup`,
    actions: (
      <>
        <button type="button" onClick={onClose} disabled={busy}>Close</button>
        {saveButton}
      </>
    ),
  };

  return (
    <Shell {...shellProps}>
      {inline ? <div className="tm-settings-head"><div><h2 id="tm-backup-heading">Data backup</h2><p>Keep a portable copy in storage your company owns.</p></div></div> : null}
      <div className="tm-backup-intro">
        <DatabaseBackup size={22} aria-hidden="true" />
        <div>
          <b>Keep a copy in your own storage.</b>
          <p>First create a bucket in Cloudflare R2, Amazon S3, or another S3-compatible service. Then paste that bucket's connection details below.</p>
        </div>
      </div>
      <ol className="tm-backup-steps">
        <li>Create a private bucket with your storage provider.</li>
        <li>Create a key that can write to only that bucket.</li>
        <li>Connect it here. tdoc will keep copying changes automatically.</li>
      </ol>
      {backup?.enabled ? (
        <section className={`tm-backup-health ${backup.state === 'error' ? 'is-error' : ''}`}>
          <div><b>{backup.state === 'syncing' ? (backup.initial_synced_at ? 'Full sync running' : 'Initial backup running') : backup.state === 'error' ? 'Backup needs attention' : 'Automatic backup active'}</b><span>{backup.endpoint}/{backup.bucket}/{backup.prefix}/{team.id}</span></div>
          {backup.state === 'active' ? <span>Changes are copied automatically.</span> : null}
          {backup.last_synced_at ? <span>Last copy {backupTime(backup.last_synced_at)}</span> : null}
          {backup.last_error ? <span>{backup.last_error}</span> : null}
          <div className="tm-backup-health-actions">
            <div className="tm-backup-sync-action">
              <button type="button" className="tm-text-btn" onClick={sync} disabled={busy}><RefreshCw size={14} /> Run full sync again</button>
              <span>Optional. Use this only to re-copy all current data.</span>
            </div>
            <button type="button" className="tm-text-btn tm-backup-off" onClick={remove} disabled={busy}>Turn off</button>
          </div>
        </section>
      ) : null}
      <div className="tm-backup-grid">
        <label className="field tm-backup-wide">S3-compatible endpoint<input type="url" placeholder="https://account.r2.cloudflarestorage.com" value={form.endpoint} onChange={field('endpoint')} /></label>
        <label className="field">Bucket<input type="text" placeholder="company-backups" value={form.bucket} onChange={field('bucket')} /></label>
        <label className="field">Region<input type="text" placeholder="auto" value={form.region} onChange={field('region')} /></label>
        <label className="field tm-backup-wide">Folder prefix<input type="text" placeholder="tdoc-backups" value={form.prefix} onChange={field('prefix')} /></label>
        <label className="field">Access key ID<input type="text" autoComplete="off" placeholder={backup?.access_key_hint || 'Access key ID'} value={form.access_key_id} onChange={field('access_key_id')} /></label>
        <label className="field">Secret access key<input type="password" autoComplete="new-password" placeholder="Secret access key" value={form.secret_access_key} onChange={field('secret_access_key')} /></label>
      </div>
      <p className="manage-hint"><b>Where do I see the backup?</b> Open the bucket in your R2, S3, or storage provider console. tdoc keeps running normally and does not replace that provider's file browser.</p>
      <p className="manage-hint">Credentials are encrypted before storage and are never shown again. Turning this off never deletes your copy.</p>
      {status ? <p className="status" role="status">{status}</p> : null}
      {inline ? <div className="tm-settings-actions">{saveButton}</div> : null}
    </Shell>
  );
}

export function TeamSettingsPane({ team, onChanged, onLeave }) {
  return (
    <section className="tm-settings" aria-label={`${team.name} workspace settings`}>
      <div className="tm-settings-title">
        <h2>Workspace settings</h2>
        <p>Manage this workspace in one place.</p>
      </div>
      <MembersDialog teamId={team.id} inline onChanged={onChanged} onLeave={onLeave} />
      <section className="tm-settings-card" id="agents">
        <div className="tm-settings-head"><div><h2>Agents</h2><p>Connect Raft, Claude Code, Codex, or a webhook for this workspace.</p></div></div>
        {team.role === 'admin'
          ? <ConnectorsBody team={team} returnTo={`/me?team=${encodeURIComponent(team.id)}&view=settings#agents`} />
          : <p className="empty">Only a workspace admin can connect agents and send team comments to them.</p>}
      </section>
      {team.role === 'admin' ? <TeamBackupDialog team={team} inline /> : null}
    </section>
  );
}

export function MoveToTeamDialog({ teams, count, skipped = 0, onMove, onClose }) {
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
            <span className="tm-space-mark" aria-hidden="true" style={{ background: `hsl(${teamHue(team.id)} 55% 46%)` }}>
              {String(team.name || '?').trim().slice(0, 1).toUpperCase()}
            </span>
            {team.name}
          </button>
        ))}
      </div>
      <p className="manage-hint">The team becomes the owner and every member can open and comment. You stay the author.</p>
      {skipped ? (
        <p className="manage-hint">{skipped === 1 ? '1 selected doc is' : `${skipped} selected docs are`} not yours, so {skipped === 1 ? 'it stays' : 'they stay'} where {skipped === 1 ? 'it is' : 'they are'}. Only a doc&apos;s author can move it into a team.</p>
      ) : null}
    </AppDialog>
  );
}

// A My docs folder, with its subfolders and your docs, into a team: pick the
// team, confirm, watch it go, land on the folder in the team.
export function MoveFolderToTeamDialog({ folder, teams, docCount, onClose }) {
  const [target, setTarget] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(null);
  const docs = docCount === 1 ? '1 doc' : `${docCount} docs`;
  const run = async () => {
    setBusy(true);
    setStatus('Moving…');
    try {
      const result = await moveFolderToTeam(folder.id, target.id, ({ moved, remaining }) => {
        if (remaining) setStatus(`Moving… ${moved} of ${moved + remaining}`);
      });
      const href = `/me?team=${encodeURIComponent(target.id)}&folder=${encodeURIComponent(result.folder || '')}`;
      if (!result.skipped.length) { location.href = href; return; }
      setLeft({ href, count: result.skipped.length });
      setStatus('');
    } catch (error) {
      setStatus(message(error));
    }
    setBusy(false);
  };
  const close = () => { if (!busy) onClose(); };
  if (left) {
    return (
      <AppDialog
        open
        onOpenChange={(open) => { if (!open) close(); }}
        title={`Moved to ${target.name}`}
        actions={<button type="button" onClick={() => { location.href = left.href; }}>Open in {target.name}</button>}
      >
        <p>{left.count === 1 ? '1 doc was' : `${left.count} docs were`} not yours to move, so {left.count === 1 ? 'it stays' : 'they stay'} in {folder.name} in My docs.</p>
      </AppDialog>
    );
  }
  if (!target) {
    return (
      <AppDialog
        open
        onOpenChange={(open) => { if (!open) close(); }}
        title={`Move ${folder.name} to a team`}
        actions={<button type="button" onClick={close}>Cancel</button>}
      >
        <div className="move-list">
          {teams.map((team) => (
            <button key={team.id} type="button" onClick={() => setTarget(team)}>
              <span className="tm-space-mark" aria-hidden="true" style={{ background: `hsl(${teamHue(team.id)} 55% 46%)` }}>
                {String(team.name || '?').trim().slice(0, 1).toUpperCase()}
              </span>
              {team.name}
            </button>
          ))}
        </div>
      </AppDialog>
    );
  }
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) close(); }}
      title={`Move ${folder.name} to ${target.name}?`}
      actions={(
        <>
          <button type="button" onClick={() => { setTarget(null); setStatus(''); }} disabled={busy}>Back</button>
          <button type="button" className="primary folder-move-team-confirm" onClick={run} disabled={busy}>Move {docs}</button>
        </>
      )}
    >
      <p>{folder.name}, its subfolders and {docs} move into {target.name}. A folder with the same name there is merged into.</p>
      <p className="manage-hint">The team becomes the owner and every member can open and comment. You stay the author. The emptied folders leave My docs.</p>
      {status ? <p className="status" role="status">{status}</p> : null}
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
