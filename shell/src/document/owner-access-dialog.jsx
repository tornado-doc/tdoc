import React, { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { AppDialog } from '../ui/dialog.jsx';
import { SegmentedControl } from '../ui/segmented-control.jsx';
import { deleteDocument, updateDocumentAccess } from './api.js';
import { normalizeLogin, useGithubUserSearch } from './github-user-search.js';
import { copyText } from './model.js';

const COMMENTING_OPTIONS = [
  { value: 'signed_in', label: 'Signed in' },
  { value: 'invited', label: 'Invited' },
  { value: 'owner', label: 'Owner only' },
  { value: 'off', label: 'Off' },
];

const HISTORY_OPTIONS = [
  { value: 'owner', label: 'Owner only' },
  { value: 'invited', label: 'Invited' },
  { value: 'public', label: 'Everyone' },
];

function InviteField({ users, onChange }) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  // Same GitHub search the @ picker uses — see github-user-search.js.
  const suggestions = useGithubUserSearch(value);

  const add = (rawValue) => {
    const login = normalizeLogin(rawValue);
    if (!login || users.some((user) => user.toLowerCase() === login.toLowerCase())) return;
    onChange([...users, login]);
    setValue('');
  };

  return (
    <div className="tdoc-ac">
      <div className={`tdoc-token-field${focused ? ' focus' : ''}`}>
        {users.map((login) => (
          <span key={login} className="tdoc-token">
            <img src={`https://github.com/${encodeURIComponent(login)}.png?size=48`} alt="" />
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
          placeholder="Add a GitHub username…"
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

export function OwnerAccessDialog({ open, config, url, onOpenChange, onCopied }) {
  const manage = config.ownerManage;
  const [access, setAccess] = useState(manage?.access || {});
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (open) setAccess(manage?.access || {});
  }, [manage?.access, open]);

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
      await updateDocumentAccess(config.slug, patch);
      setStatus('Saved.');
    } catch (error) {
      setAccess(previous);
      setStatus(`Failed: ${error.message}`);
    }
  };

  const inviteRelevant = normalized.visibility === 'private'
    || normalized.commenting === 'invited'
    || normalized.history_visibility === 'invited';
  const invitedCount = normalized.allowed_users.length;
  const accessDescription = normalized.visibility !== 'private'
    ? 'Anyone with the link can read it.'
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
      <p className="muted" style={{ margin: '8px 0 0' }}>
        {config.slug} · {manage.versionCount} versions · {manage.commentCount} comments
      </p>

      <section className="manage-section">
        <label className="field" htmlFor="tdoc-access-select">Who has access</label>
        <select
          id="tdoc-access-select"
          className="tdoc-select"
          value={normalized.visibility === 'private' ? 'private' : 'unlisted'}
          onChange={(event) => save({ visibility: event.target.value })}
        >
          <option value="private">Only people I invite</option>
          <option value="unlisted">Anyone with the link</option>
        </select>
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

  const remove = async () => {
    setStatus('Deleting…');
    try {
      await deleteDocument(config.slug);
      location.href = '/me';
    } catch (error) {
      setStatus(`Failed: ${error.message}`);
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete this doc?"
      description={`This permanently removes ${config.slug}, all ${manage.versionCount} versions, and all ${manage.commentCount} comments.`}
      actions={(
        <>
          <button type="button" onClick={() => onOpenChange(false)}>Cancel</button>
          <button type="button" className="danger" onClick={remove}>
            <Trash2 size={14} /> Delete
          </button>
        </>
      )}
    >
      <p>This cannot be undone.</p>
      {status ? <p role="status">{status}</p> : null}
    </AppDialog>
  );
}
