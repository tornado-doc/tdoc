import React, { useEffect, useMemo, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { AppDialog } from '../ui/dialog.jsx';
import { SegmentedControl } from '../ui/segmented-control.jsx';
import { deleteDocument, updateDocumentAccess } from './api.js';
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

function normalizeLogin(value) {
  return value
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\/.*$/, '');
}

function InviteField({ users, onChange }) {
  const [value, setValue] = useState('');
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    const login = normalizeLogin(value);
    if (login.length < 2) {
      setSuggestions([]);
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const query = new URLSearchParams({ q: `${login} in:login`, per_page: '5' });
      try {
        const response = await fetch(`https://api.github.com/search/users?${query}`, {
          signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json' },
        });
        const body = response.ok ? await response.json() : {};
        setSuggestions(Array.isArray(body.items) ? body.items : []);
      } catch (error) {
        if (error.name !== 'AbortError') setSuggestions([]);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [value]);

  const add = (rawValue) => {
    const login = normalizeLogin(rawValue);
    if (!login || users.some((user) => user.toLowerCase() === login.toLowerCase())) return;
    onChange([...users, login]);
    setValue('');
    setSuggestions([]);
  };

  return (
    <div className="tdoc-invite-control">
      <div className="tdoc-token-field">
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
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          value={value}
          autoComplete="off"
          spellCheck="false"
          placeholder="Add a GitHub username…"
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
        <div className="tdoc-ac open">
          {suggestions.map((user) => (
            <button key={user.id} type="button" onClick={() => add(user.login)}>
              <img src={user.avatar_url} alt="" />
              <span>{user.login}</span>
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
      description={`${config.slug} · ${manage.versionCount} versions · ${manage.commentCount} comments`}
      actions={<button type="button" onClick={() => onOpenChange(false)}>Close</button>}
    >
      <div className="code" id="tdoc-share-url" onClick={() => copyText(url)}>{url}</div>
      <button
        type="button"
        className="primary"
        onClick={() => copyText(url).then(onCopied)}
      >
        Copy link
      </button>

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

      <details
        className="tdoc-adv"
        open={normalized.commenting !== 'signed_in' || normalized.history_visibility !== 'owner'}
      >
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
      <p className="manage-hint" role="status">{status || '\u00a0'}</p>
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
