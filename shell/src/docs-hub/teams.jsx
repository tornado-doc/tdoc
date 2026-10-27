import React, { useEffect, useState } from 'react';
import { Bot, DatabaseBackup, Link2, MessageSquareText, RefreshCw, ServerCog, SlidersHorizontal, UsersRound } from 'lucide-react';
import { AppDialog } from '../ui/dialog.jsx';
import { AppSelect } from '../ui/select.jsx';
import { SegmentedControl } from '../ui/segmented-control.jsx';
import { InviteField } from '../document/owner-access-dialog.jsx';
import { CopyPromptButton } from '../ui/copy-prompt-button.jsx';
import { copyText } from '../document/model.js';
import {
  addTeamAgent,
  createTeam,
  changeTeamGuest,
  getTeamBackup,
  getTeamBilling,
  getTeam,
  getTeamGuests,
  listTeamAgents,
  listTeamComments,
  moveFolderToTeam,
  openTeamBilling,
  removeTeamAgent,
  removeTeamBackup,
  removeTeamMember,
  saveTeamBackup,
  setTeamRole,
  syncTeamBackup,
  updateTeam,
} from '../document/api.js';
import { isFeatureOn } from '../feature-flags.js';
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
  billing_unavailable: 'Billing is not set up on this deployment.',
  already_subscribed: 'This team already has the Team plan. Use Manage billing.',
  no_billing_customer: 'There is no billing account yet. Upgrade first.',
  team_agent_limit: 'This team has the most agents it can have. Remove one first.',
  name_taken: 'This team already has an agent by that name.',
};
const message = (error) => ERRORS[error?.body?.error] || error?.message || 'Request failed';

function Avatar({ member }) {
  const key = member.key || '';
  if (key && !key.startsWith('email:') && !key.includes('@')) {
    return <img src={`https://github.com/${encodeURIComponent(key)}.png?size=52`} alt="" />;
  }
  return <span className="tdoc-avatar-fallback" aria-hidden="true">{String(member.name || key || '?').slice(0, 1).toUpperCase()}</span>;
}

function PersonRow({ member, name, sub, right, className = '' }) {
  return (
    <div className={`tm-person ${className}`.trim()}>
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
export function TeamPane({ team, docs, viewer, menuFor, inFolder = false, layout = 'list', empty, pathForDoc }) {
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
          path: pathForDoc ? pathForDoc(doc) : '',
          menuItems: menuFor(doc),
          data: { created: doc.created, updated: doc.updated, author: doc.author || viewer },
        })}
        empty={empty ?? (!inFolder ? `No docs in ${team.name} yet. Create one, or move one here from My docs.` : null)}
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
export function TeamCommentsPane({ team, pageSize = 25 }) {
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
  const [page, setPage] = useState(1);

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
  const safePageSize = Math.max(1, Number(pageSize) || 25);
  const pageCount = Math.max(1, Math.ceil(shown.length / safePageSize));
  const visiblePage = Math.min(page, pageCount);
  const pageStart = (visiblePage - 1) * safePageSize;
  const pageItems = shown.slice(pageStart, pageStart + safePageSize);

  useEffect(() => { setPage(1); }, [status, replyState, authorKind, person, doc, since, team.id]);

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
        {pageItems.map((item) => (
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
      {shown.length > safePageSize ? (
        <nav className="tm-comment-pagination" aria-label="Comment pages">
          <span>{pageStart + 1}–{Math.min(pageStart + safePageSize, shown.length)} of {shown.length}</span>
          <div>
            <button type="button" disabled={visiblePage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button>
            <span>Page {visiblePage} of {pageCount}</span>
            <button type="button" disabled={visiblePage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Next</button>
          </div>
        </nav>
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
          <div><b>{backup.paused ? 'Backup paused' : backup.state === 'syncing' ? (backup.initial_synced_at ? 'Full sync running' : 'Initial backup running') : backup.state === 'error' ? 'Backup needs attention' : 'Automatic backup active'}</b><span>{backup.endpoint}/{backup.bucket}/{backup.prefix}/{team.id}</span></div>
          {backup.paused ? <span>The Team plan ended. Your settings are kept, and copying resumes when the plan is renewed.</span>
            : backup.state === 'active' ? <span>Changes are copied automatically.</span> : null}
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

function billingDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Team plan. Members are always free; a free team holds `free_docs` docs.
// The Team plan (unlimited docs, Data backup) bills every member per seat
// through Stripe. Hidden on a deployment without Stripe.
export function TeamBillingCard({ team }) {
  const [billing, setBilling] = useState(null);
  const [period, setPeriod] = useState('month');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const returned = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('billing') : null;

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const load = () => getTeamBilling(team.id).then((result) => {
      if (cancelled) return;
      setBilling(result.billing);
      // Stripe confirms by webhook a moment after Checkout returns.
      if (returned === 'success' && result.billing.plan !== 'team' && tries++ < 5) setTimeout(load, 2000);
    }).catch((error) => { if (!cancelled) setStatus(message(error)); });
    load();
    if (returned === 'success') setStatus('Payment received. The Team plan turns on in a few seconds.');
    if (returned === 'canceled') setStatus('Checkout was canceled. Nothing was charged.');
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('appsumo') === 'applied') setStatus('Your AppSumo license is on. This team has the Team plan.');
    return () => { cancelled = true; };
  }, [team.id]);

  if (!billing || !billing.configured) return null;
  const go = async (action) => {
    setBusy(true);
    setStatus(action === 'portal' ? 'Opening Stripe…' : 'Opening checkout…');
    try {
      const result = await openTeamBilling(team.id, action, action === 'checkout' ? period : undefined);
      location.assign(result.url);
    } catch (error) {
      setStatus(message(error));
      setBusy(false);
    }
  };
  const prices = billing.prices;
  const paid = billing.plan === 'team';
  const lifetime = billing.lifetime;
  const seats = billing.seats;
  const renews = billingDate(billing.current_period_end);
  const overSeats = !!lifetime && seats > lifetime.seats;
  const summary = lifetime
    ? billing.double_billed
      ? 'This team has an AppSumo lifetime license and also pays by card. Cancel the card plan in Manage billing; the license already covers the team.'
      : overSeats
        ? `Lifetime license from AppSumo. ${seats} members on ${lifetime.seats} seats: everyone stays, but nobody new can join until someone leaves or the license is upgraded.`
        : `Lifetime license from AppSumo. ${seats} of ${lifetime.seats} seats used. It does not renew.`
    : paid
    ? billing.status === 'past_due'
      ? 'The last payment failed. Update the card to keep the Team plan.'
      : `${billing.quantity || seats} ${(billing.quantity || seats) === 1 ? 'seat' : 'seats'}, billed ${billing.interval === 'year' ? 'yearly' : 'monthly'}.${renews ? ` ${billing.cancel_at_period_end ? 'Ends' : 'Renews'} ${renews}.` : ''}`
    : billing.at_limit
      ? `${billing.docs} docs. The free plan holds ${billing.free_docs}; upgrade to add more. Existing docs stay editable.`
      : billing.near_limit
        ? `${billing.docs} of ${billing.free_docs} free docs used. ${billing.free_docs - billing.docs} left before the Team plan is needed.`
        : `${billing.docs} of ${billing.free_docs} free docs used.`;

  return (
    <section className="tm-settings-card" id="billing" aria-labelledby="tm-billing-heading">
      <div className="tm-settings-head">
        <div>
          <h2 id="tm-billing-heading">Plan</h2>
          <p>Free for {billing.free_docs} docs and any number of members. The Team plan adds unlimited docs and Data backup for ${prices.month} per member a month, or ${prices.year} a year.</p>
        </div>
        <span className={`tm-plan-badge${paid ? ' is-team' : ''}`}>{paid ? 'Team' : 'Free'}</span>
      </div>
      <p className={`tm-plan-summary${billing.status === 'past_due' || billing.at_limit || billing.double_billed ? ' is-error' : billing.near_limit || overSeats ? ' is-warn' : ''}`}>{summary}</p>
      {paid ? null : (
        <div className="tm-plan-choose">
          <SegmentedControl
            ariaLabel="Billing period"
            value={period}
            onChange={setPeriod}
            options={[{ value: 'month', label: 'Monthly' }, { value: 'year', label: 'Yearly' }]}
          />
          <span>{seats} × ${prices[period]} = <b>${seats * prices[period]}</b> / {period === 'year' ? 'year' : 'month'}</span>
        </div>
      )}
      <p className="tm-plan-note">{lifetime
        ? 'Every admin and member is a seat; agents never are. For more seats, upgrade the license on AppSumo.'
        : 'Every admin and member is a seat; agents never are. Seats follow the member list, and changes are prorated.'}</p>
      {status ? <p className="status" role="status">{status}</p> : null}
      <div className="tm-settings-actions">
        {(paid && !lifetime) || billing.has_customer ? (
          <button type="button" className={paid && !lifetime ? 'primary' : 'tm-link-btn'} onClick={() => go('portal')} disabled={busy}>Manage billing</button>
        ) : null}
        {paid ? null : <button type="button" className="primary" onClick={() => go('checkout')} disabled={busy}>Upgrade to Team</button>}
      </div>
    </section>
  );
}

function seenText(iso) {
  const ms = Date.now() - Date.parse(iso || '');
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// Team agents: agents that belong to the team, not to a person. Every member
// can send them comments on team docs; admins add and remove them. Adding
// gives one command for a dedicated machine; nothing personal should be on
// it, because every member's comments drive it.
function TeamAgentRow({ agent, team, canManage, onRemove }) {
  const devices = agent.devices || [];
  const sub = !agent.connected
    ? 'Waiting for its machine to run the setup command'
    : devices.length
      ? devices.map((d) => `${d.device} · seen ${seenText(d.last_seen)}`).join(', ')
      : 'Connected; its daemon has not checked in yet';
  return (
    <div className="tm-person tm-agent-row">
      <span className="tdoc-avatar-fallback tm-agent-mark" aria-hidden="true"><Bot size={15} /></span>
      <div className="tm-person-text">
        <span><b>{agent.name}</b> · {team.name} team agent</span>
        <span className="tm-person-sub">{sub}</span>
      </div>
      <div className="tm-person-right">
        {canManage ? <button type="button" className="tm-text-btn" onClick={() => onRemove(agent)}>Remove</button> : null}
      </div>
    </div>
  );
}

function AddTeamAgentDialog({ team, onClose, onAdded }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [added, setAdded] = useState(null);
  const add = async () => {
    setBusy(true);
    setStatus('');
    try {
      const result = await addTeamAgent(team.id, name.trim());
      setAdded(result);
      onAdded(result.agents);
    } catch (error) { setStatus(message(error)); }
    setBusy(false);
  };
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open && !busy) onClose(); }}
      title={added ? `Connect ${added.agent.name}` : 'Add team agent'}
      actions={added ? <button type="button" className="primary" onClick={onClose}>Done</button> : (
        <>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="primary" onClick={add} disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add'}</button>
        </>
      )}
    >
      <div className="tm-agent-add">
        <p className="tm-agent-warn">
          <ServerCog size={18} aria-hidden="true" />
          <span><b>Run it on a dedicated machine or container, with no personal data on it.</b> Every member of {team.name} can send it comments, so many people&apos;s words drive what it does on that machine.</span>
        </p>
        {added ? (
          <>
            <p>Run this once on that machine. It installs tdoc if needed, connects as <b>{added.agent.name} · {team.name} team agent</b>, and starts picking up comments. It works once, within the hour.</p>
            <div className="tm-agent-command">
              <code>{added.command}</code>
              <CopyPromptButton text={added.command} />
            </div>
            <p className="manage-hint">It reaches {team.name}&apos;s docs and nothing else: no one&apos;s personal docs, no other team. It cannot share, delete, invite or change billing. It belongs to the team, so it keeps working if you leave; remove it here to stop it.</p>
          </>
        ) : (
          <>
            <label className="field">Name<input type="text" maxLength={40} placeholder="e.g. report-bot" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) add(); }} /></label>
            <p className="manage-hint">Shown on its replies as “{name.trim() || 'name'} · {team.name} team agent”.</p>
          </>
        )}
        {status ? <p className="status" role="status">{status}</p> : null}
      </div>
    </AppDialog>
  );
}

export function TeamAgentsSection({ team }) {
  const [agents, setAgents] = useState(null);
  const [canManage, setCanManage] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    let cancelled = false;
    listTeamAgents(team.id).then((result) => {
      if (cancelled) return;
      setAgents(result.agents || []);
      setCanManage(!!result.can_manage);
    }).catch((error) => { if (!cancelled) { setAgents([]); setStatus(message(error)); } });
    return () => { cancelled = true; };
  }, [team.id]);
  const remove = async () => {
    const agent = removing;
    setStatus('Removing…');
    try {
      const result = await removeTeamAgent(team.id, agent.id);
      setAgents(result.agents || []);
      setStatus(`${agent.name} removed. Its machine can no longer reach ${team.name}.`);
    } catch (error) { setStatus(message(error)); }
    setRemoving(null);
  };
  return (
    <section className="manage-section tm-team-agents" aria-labelledby="tm-team-agents-heading">
      <div className="tm-team-agents-head">
        <label className="field" id="tm-team-agents-heading">Team agents</label>
        {canManage ? <button type="button" className="tm-link-btn" onClick={() => setAdding(true)}><Bot size={14} /> Add team agent</button> : null}
      </div>
      {agents === null ? <p className="muted">Loading…</p> : agents.length ? agents.map((agent) => (
        <TeamAgentRow key={agent.id} agent={agent} team={team} canManage={canManage} onRemove={setRemoving} />
      )) : <p className="empty">No team agent yet.{canManage ? '' : ' A team admin can add one.'}</p>}
      <p className="manage-hint">Every member can send a comment on a {team.name} doc to a team agent; its replies are visible to everyone who can see the doc. It belongs to the team, not to whoever added it.</p>
      {status ? <p className="status" role="status">{status}</p> : null}
      {adding ? <AddTeamAgentDialog team={team} onClose={() => setAdding(false)} onAdded={setAgents} /> : null}
      {removing ? (
        <AppDialog
          open
          onOpenChange={(open) => { if (!open) setRemoving(null); }}
          title={`Remove ${removing.name}?`}
          actions={(
            <>
              <button type="button" onClick={() => setRemoving(null)}>Cancel</button>
              <button type="button" className="danger" onClick={remove}>Remove</button>
            </>
          )}
        >
          <p>Its token stops working right away and comments can no longer be sent to it. Its past replies stay.</p>
        </AppDialog>
      ) : null}
    </section>
  );
}

export function TeamSettingsPane({ team, onChanged, onLeave }) {
  const [guestsEnabled] = useState(() => isFeatureOn('teamGuests'));
  const [tab, setTab] = useState(() => window.location.hash === '#agents' ? 'agents' : 'members');
  useEffect(() => {
    const showLinkedTab = () => {
      if (window.location.hash === '#agents') setTab('agents');
    };
    window.addEventListener('hashchange', showLinkedTab);
    return () => window.removeEventListener('hashchange', showLinkedTab);
  }, []);
  return (
    <section className="tm-settings" aria-label={`${team.name} workspace settings`}>
      <div className="tm-settings-title">
        <h2>Workspace settings</h2>
        <p>Manage this workspace in one place.</p>
      </div>
      {team.role === 'admin' ? <TeamBillingCard team={team} /> : null}
      {guestsEnabled ? <SegmentedControl ariaLabel="Team settings" className="tm-settings-tabs" value={tab} onChange={setTab} options={[
        { value: 'members', label: 'Members' },
        ...(team.role === 'admin' ? [{ value: 'guests', label: 'Guests' }] : []),
        { value: 'agents', label: 'Agents' },
      ]} /> : null}
      {(!guestsEnabled || tab === 'members') ? <MembersDialog teamId={team.id} inline onChanged={onChanged} onLeave={onLeave} /> : null}
      {guestsEnabled && team.role === 'admin' && tab === 'guests' ? <TeamGuestsSection team={team} /> : null}
      {(!guestsEnabled || tab === 'agents') ? <section className="tm-settings-card" id="agents">
        <div className="tm-settings-head"><div><h2>Agents</h2><p>Team agents work for everyone in this workspace. Admins can also use their own connected agents here.</p></div></div>
        <TeamAgentsSection team={team} />
        {team.role === 'admin' ? (
          <section className="manage-section">
            <label className="field">Your own agents</label>
            <ConnectorsBody team={team} returnTo={`/me?team=${encodeURIComponent(team.id)}&view=settings#agents`} />
          </section>
        ) : null}
      </section> : null}
      {team.role === 'admin' ? <TeamBackupDialog team={team} inline /> : null}
    </section>
  );
}

function maskedInvitee(invitee) {
  const [name, domain] = String(invitee).split('@');
  return domain ? `${name.slice(0, 2)}${name.length > 2 ? '•••' : ''}@${domain}` : invitee;
}

function TeamGuestsSection({ team }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    getTeamGuests(team.id).then(setData).catch((error) => setStatus(message(error)));
  }, [team.id]);
  const act = async (invitee, action) => {
    setStatus('Saving…');
    try {
      const result = await changeTeamGuest(team.id, invitee, action);
      setData(result);
      setStatus(action === 'remove' ? 'Guest removed.' : result.emailed?.length ? 'Invitation emailed.' : 'Invitation saved.');
    } catch (error) { setStatus(message(error)); }
  };
  return <section className="tm-settings-card" aria-label="Guests">
    <div className="tm-settings-head"><div><h2>Guests</h2><p>Guests can open only the team documents shared with them. They do not use a seat.</p></div></div>
    <p className="manage-hint">{data ? `${data.guests.length} ${data.guests.length === 1 ? 'guest' : 'guests'} · limit ${data.limit}` : 'Loading guests…'}</p>
    {(data?.guests || []).map((guest) => {
      const invited = data.invites?.includes(guest.invitee);
      const documentNames = guest.documents.slice(0, 3).map((doc) => doc.title).join(', ');
      const moreDocuments = guest.documents.length > 3 ? ` +${guest.documents.length - 3} more` : '';
      return <PersonRow key={guest.invitee} className="tm-guest-row"
        member={{ name: guest.invitee, key: guest.invitee }}
        name={maskedInvitee(guest.invitee)}
        sub={`${guest.documents.length} ${guest.documents.length === 1 ? 'document' : 'documents'}: ${documentNames}${moreDocuments} · Added by ${guest.added_by || 'unknown'}${guest.documents.length >= 40 ? ' · Frequent collaborator — consider a member seat' : ''}`}
        right={team.role === 'admin' ? <>
          <button type="button" className="tm-text-btn" onClick={() => act(guest.invitee, invited ? 'resend' : 'invite_member')}>{invited ? 'Resend invite' : 'Invite to team'}</button>
          <button type="button" className="tm-text-btn" onClick={() => act(guest.invitee, 'remove')}>Remove</button>
        </> : null} />;
    })}
    {(data?.invites || []).filter((invitee) => !(data?.guests || []).some((guest) => guest.invitee === invitee))
      .map((invitee) => <PersonRow key={`invite:${invitee}`} className="tm-guest-row"
        member={{ name: invitee, key: invitee }} name={maskedInvitee(invitee)}
        sub="Team invitation pending · no document shared"
        right={team.role === 'admin' ? <button type="button" className="tm-text-btn" onClick={() => act(invitee, 'resend')}>Resend invite</button> : null} />)}
    <p className="status" role="status">{status}</p>
  </section>;
}

export function MoveToTeamDialog({
  teams,
  count,
  skipped = 0,
  onMove,
  onClose,
  includePersonal = false,
  currentTeam = null,
  loading = false,
  busy = false,
  error = '',
  title = '',
}) {
  const destinations = [
    ...(includePersonal ? [{ id: null, name: 'My docs', personal: true }] : []),
    ...(teams || []),
  ].filter((team) => team.id !== currentTeam);
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={title || `Move ${count === 1 ? 'this doc' : `${count} docs`} to a team`}
      actions={<button type="button" onClick={onClose}>Cancel</button>}
    >
      <div className="move-list">
        {destinations.map((team) => (
          <button key={team.id || 'personal'} type="button" disabled={busy} onClick={() => onMove(team)}>
            <span className="tm-space-mark" aria-hidden="true" style={{ background: team.personal ? 'var(--td-accent)' : `hsl(${teamHue(team.id)} 55% 46%)` }}>
              {String(team.name || '?').trim().slice(0, 1).toUpperCase()}
            </span>
            {team.name}
          </button>
        ))}
      </div>
      {loading ? <p className="manage-hint">Loading workspaces…</p> : null}
      {busy ? <p className="manage-hint" role="status">Moving…</p> : null}
      {!loading && !destinations.length ? <p className="empty">No other workspace is available. Create a team first.</p> : null}
      {error ? <p className="status" role="alert">{error}</p> : null}
      <p className="manage-hint">{includePersonal
        ? 'A team owns docs moved into it; My docs returns the doc to your personal workspace. You stay the author.'
        : 'The team becomes the owner and every member can open and comment. You stay the author.'}</p>
      {skipped ? (
        <p className="manage-hint">{skipped === 1 ? '1 selected doc is' : `${skipped} selected docs are`} not yours, so {skipped === 1 ? 'it stays' : 'they stay'} where {skipped === 1 ? 'it is' : 'they are'}. Only a doc&apos;s author can move it into a team.</p>
      ) : null}
    </AppDialog>
  );
}

// A My docs folder, with its subfolders and your docs, into a team: pick the
// team, confirm, watch it go, then stay on the current list.
export function MoveFolderToTeamDialog({ folder, teams, docCount, onClose, onStart, onSettled }) {
  const [target, setTarget] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(null);
  const docs = docCount === 1 ? '1 doc' : `${docCount} docs`;
  const run = async () => {
    setBusy(true);
    setStatus('Moving…');
    onStart();
    try {
      const result = await moveFolderToTeam(folder.id, target.id, ({ moved, remaining }) => {
        if (remaining) setStatus(`Moving… ${moved} of ${moved + remaining}`);
      });
      await onSettled();
      if (!result.skipped.length) { onClose(); return; }
      setLeft({ count: result.skipped.length });
      setStatus('');
    } catch (error) {
      await onSettled();
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
        actions={<button type="button" onClick={close}>Close</button>}
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
