import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { AppDialog } from '../ui/dialog.jsx';
import { SegmentedControl } from '../ui/segmented-control.jsx';
import { AppSwitch } from '../ui/switch.jsx';
import { deleteDocument, updateDocumentAccess } from './api.js';
import { VersionLinkChoice } from './document-dialogs.jsx';
import { normalizeLogin, useGithubUserSearch } from './github-user-search.js';

// Mirrors normalizeInvitee in the worker: a handle reading first (so "@Bob"
// stays a handle, not an address), email only when what is left cannot be a
// handle. Divergence here is invisible until someone's invite silently fails
// server-side, so keep the two in step.
function normalizeInvitee(raw) {
  const login = normalizeLogin(raw);
  if (login) return login;
  const email = String(raw || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
const isEmailInvite = (entry) => String(entry).includes('@');
import { copyText } from './model.js';

const COMMENTING_OPTIONS = [
  { value: 'signed_in', label: 'Signed in' },
  { value: 'invited', label: 'Invited' },
  { value: 'owner', label: 'Owner only' },
  { value: 'off', label: 'Off' },
];

// Who can open the doc, the way Google Docs says it. "Anyone with the link"
// is stored as `unlisted`. Public is the only one search engines may index.
export const GENERAL_ACCESS_OPTIONS = [
  { value: 'private', label: 'Specific people / team', hint: 'Only people you add.' },
  { value: 'unlisted', label: 'Anyone with the link', hint: 'Not listed or searchable.' },
  { value: 'public', label: 'Public', hint: 'Listed on the web and searchable by search engines.' },
];

function GeneralAccessChoice({ value, onChange }) {
  return (
    <div className="tdoc-access-options" role="radiogroup" aria-label="Who has access">
      {GENERAL_ACCESS_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`tdoc-access-option${value === option.value ? ' active' : ''}`}
          data-access={option.value}
          onClick={() => { if (value !== option.value) onChange(option.value); }}
        >
          <span className="tdoc-access-dot" aria-hidden="true" />
          <span className="tdoc-access-text">
            <span className="tdoc-access-label">{option.label}</span>
            <span className="tdoc-access-hint">{option.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

const HISTORY_OPTIONS = [
  { value: 'owner', label: 'Owner only' },
  { value: 'invited', label: 'Invited' },
  { value: 'public', label: 'Everyone' },
];

export function InviteField({ users, onChange }) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  // Same GitHub search the @ picker uses — see github-user-search.js.
  // An address is not a GitHub query — stop hitting the search API the moment
  // one is being typed.
  const suggestions = useGithubUserSearch(value, { enabled: !value.includes('@') });

  const add = (rawValue) => {
    const login = normalizeInvitee(rawValue);
    if (!login || users.some((user) => user.toLowerCase() === login.toLowerCase())) return;
    onChange([...users, login]);
    setValue('');
  };

  return (
    <div className="tdoc-ac">
      <div className={`tdoc-token-field${focused ? ' focus' : ''}`}>
        {users.map((login) => (
          <span key={login} className="tdoc-token">
            {isEmailInvite(login) ? (
              <span className="tdoc-token-initial" aria-hidden="true">{login.slice(0, 1).toUpperCase()}</span>
            ) : (
              <img src={`https://github.com/${encodeURIComponent(login)}.png?size=48`} alt="" />
            )}
            <span>{login}</span>
            <button
              type="button"
              className="rm"
              aria-label={`Remove ${login}`}
              onClick={() => onChange(users.filter((user) => user !== login))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={value}
          autoComplete="off"
          spellCheck="false"
          placeholder="Add an email or GitHub username…"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add(value);
            }
          }}
        />
      </div>
      {suggestions.length ? (
        <div className="tdoc-ac-list">
          {suggestions.map((user) => (
            <button key={user.id} type="button" className="tdoc-ac-item" onMouseDown={(event) => event.preventDefault()} onClick={() => add(user.login)}>
              <img src={user.avatar_url} alt="" />
              <span className="login">{user.login}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function OwnerAccessDialog({ open, config, url, versionUrl, version, onOpenChange, onCopied }) {
  const manage = config.ownerManage || (config.teamManage?.canManage ? config.teamManage : null);
  const team = config.teamManage?.team || null;
  const [access, setAccess] = useState(manage?.access || {});
  const [status, setStatus] = useState('');
  // The boot config never learns about saves, so resetting from it on reopen
  // silently reverted every change the server had already accepted — add an
  // invitee, close, reopen, and the list looked like the invite never
  // happened. The latest SAVED value is the baseline the dialog reopens to.
  const savedRef = useRef(manage?.access || {});

  useEffect(() => {
    if (open) setAccess(savedRef.current);
  }, [open]);

  const normalized = useMemo(() => ({
    visibility: 'unlisted',
    history_visibility: 'owner',
    commenting: 'signed_in',
    allowed_users: [],
    ...access,
  }), [access]);

  if (!manage) return null;

  const save = async (patch) => {
    const previous = access;
    const next = { ...normalized, ...patch };
    setAccess(next);
    setStatus('Saving…');
    try {
      const saved = await updateDocumentAccess(config.slug, patch);
      savedRef.current = saved?.access || next;
      // "Saved" and "they were told" are different promises — surface the
      // second one when the server actually mailed someone.
      const emailed = Array.isArray(saved?.emailed) ? saved.emailed : [];
      setStatus(emailed.length ? `Saved. Invitation emailed to ${emailed.join(', ')}.` : 'Saved.');
    } catch (error) {
      setAccess(previous);
      setStatus(`Failed: ${error.message}`);
    }
  };

  const inviteRelevant = normalized.visibility === 'private'
    || normalized.commenting === 'invited'
    || normalized.history_visibility === 'invited';
  const invitedCount = normalized.allowed_users.length;
  const general = ['private', 'unlisted', 'public'].includes(normalized.visibility) ? normalized.visibility : 'unlisted';
  const teamWide = general === 'private' && !!team && !!normalized.team;
  const accessDescription = general === 'public'
    ? 'Anyone can find and read it, including search engines.'
    : general === 'unlisted'
      ? (normalized.signin_required
        ? 'Anyone signed in to tdoc who has the link can read it. It is not listed anywhere.'
        : 'Anyone with the link can read it. It is not listed anywhere or shown to search engines.')
      : teamWide
        ? `Everyone in ${team.name} can open and comment${invitedCount ? `, plus ${invitedCount} invited ${invitedCount === 1 ? 'person' : 'people'}` : ''}.`
        : invitedCount
          ? `Only you and ${invitedCount} invited ${invitedCount === 1 ? 'person' : 'people'} can open it.`
          : 'Only you can open it. Add people below to invite them.';

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Share"
      actions={<button type="button" onClick={() => onOpenChange(false)}>Close</button>}
    >
      <div
        className="code url"
        id="tdoc-share-url"
        onClick={() => copyText(url).then(onCopied)}
      >
        {url}
      </div>
      <div className="actions" style={{ justifyContent: 'flex-start', marginTop: 0 }}>
        <button type="button" className="primary" onClick={() => copyText(url).then(onCopied)}>
          Copy link
        </button>
      </div>
      <VersionLinkChoice versionUrl={versionUrl} version={version} onCopied={onCopied} />
      {manage.versionCount != null ? (
        <p className="muted" style={{ margin: '8px 0 0' }}>
          {config.slug} · {manage.versionCount} versions · {manage.commentCount} comments
        </p>
      ) : null}

      <section className="manage-section">
        <label className="field" id="tdoc-access-label">Who has access</label>
        <GeneralAccessChoice
          value={general}
          onChange={(value) => save({ visibility: value })}
        />
        {general === 'unlisted' ? (
          <div className="tdoc-access-sub">
            <AppSwitch
              id="tdoc-access-signin"
              checked={!!normalized.signin_required}
              onCheckedChange={(checked) => save({ signin_required: !!checked })}
              label="Require sign-in to view"
            />
          </div>
        ) : null}
        {general === 'private' && team ? (
          <div className="tdoc-access-sub">
            <AppSwitch
              id="tdoc-access-team"
              checked={!!normalized.team}
              onCheckedChange={(checked) => save({ team: !!checked })}
              label={`Everyone in ${team.name}`}
            />
          </div>
        ) : null}
        <p className="manage-hint">{accessDescription}</p>

        {inviteRelevant ? (
          <>
            <label className="field">Invite by GitHub username</label>
            <InviteField
              users={normalized.allowed_users}
              onChange={(allowedUsers) => save({ allowed_users: allowedUsers })}
            />
          </>
        ) : null}
      </section>

      <details className="tdoc-adv">
        <summary>Advanced</summary>
        <section className="manage-section">
          <label className="field">Who can comment</label>
          <SegmentedControl
            ariaLabel="Who can comment"
            value={normalized.commenting}
            options={COMMENTING_OPTIONS}
            onChange={(commenting) => save({ commenting })}
          />
        </section>
        <section className="manage-section">
          <label className="field">Who can see version history</label>
          <SegmentedControl
            ariaLabel="Who can see version history"
            value={normalized.history_visibility}
            options={HISTORY_OPTIONS}
            onChange={(historyVisibility) => save({ history_visibility: historyVisibility })}
          />
        </section>
      </details>
      <p className="status" role="status">{status || '\u00a0'}</p>
    </AppDialog>
  );
}

export function DeleteDocumentDialog({ open, config, onOpenChange }) {
  const [status, setStatus] = useState('');
  const manage = config.ownerManage;
  if (!manage) return null;
  const team = config.teamManage?.team || null;
  const where = team ? `${team.name}’s Trash` : 'Trash';
  const versions = `${manage.versionCount} ${manage.versionCount === 1 ? 'version' : 'versions'}`;
  const comments = `${manage.commentCount} ${manage.commentCount === 1 ? 'comment' : 'comments'}`;

  // Delete moves the doc to Trash. My docs then says so, with an Undo that
  // brings the reader straight back here.
  const remove = async () => {
    setStatus('Moving to Trash…');
    try {
      await deleteDocument(config.slug);
      const query = new URLSearchParams({ ...(team ? { team: team.id } : {}), trashed: config.slug });
      location.href = `/me?${query}`;
    } catch (error) {
      setStatus(`Failed: ${error.message}`);
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete this doc?"
      description={`${config.slug}, its ${versions} and ${comments} move to ${where} for 30 days, then they are deleted for good.`}
      actions={(
        <>
          <button type="button" onClick={() => onOpenChange(false)}>Cancel</button>
          <button type="button" className="danger" onClick={remove}>
            <Trash2 size={14} /> Delete
          </button>
        </>
      )}
    >
      <p>Until then nobody can open it, agents included{team ? ', and a team admin can restore it from Trash' : ', and you can restore it from Trash in My docs'}.</p>
      {status ? <p role="status">{status}</p> : null}
    </AppDialog>
  );
}
