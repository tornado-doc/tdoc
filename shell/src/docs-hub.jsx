import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Folder, FolderPlus, LayoutGrid, List, Search, UsersRound, X } from 'lucide-react';
import { TopBar } from './top-bar.jsx';
import { AppDialog } from './ui/dialog.jsx';
import { AppButton } from './ui/button.jsx';
import { AppSelect } from './ui/select.jsx';
import { CopyPromptButton } from './ui/copy-prompt-button.jsx';
import { AgentRecipe, CreateMenu } from './create-from-scratch.jsx';
import { DocList, DocRow, FolderRow, day } from './docs-hub/rows.jsx';
import { OnboardingChecklist } from './docs-hub/onboarding-checklist.jsx';
import { ConnectorsBody } from './connectors-page.jsx';
import { DevicesBody } from './tokens-page.jsx';
import { ConnectAiAppsSection } from './connect-ai-apps.jsx';
import { SignInMethodsCard } from './docs-hub/sign-in-methods.jsx';
import { copyText } from './document/model.js';
import { InviteField } from './document/owner-access-dialog.jsx';
import { QuotaBumpDialog, ShareLinkRow } from './document/document-dialogs.jsx';
import {
  createFolder,
  deleteDocument,
  deleteFolder as deleteFolderRequest,
  moveDocsToFolder,
  moveDocsToTeam,
  removeTeamMember,
  renameFolder,
  restoreFromTrash,
  updateFolderAccess,
} from './document/api.js';
import { TrashPane } from './docs-hub/trash.jsx';
import { rememberTrashed } from './recent-trash.js';
import {
  LeaveTeamDialog,
  MoveFolderToTeamDialog,
  MoveToTeamDialog,
  NewTeamDialog,
  TeamCommentsPane,
  TeamPane,
  TeamSettingsPane,
} from './docs-hub/teams.jsx';
import { useDocsHub } from './hooks/use-docs-hub.js';
import { folderContents, folderPathLabel, matchesCatalogQuery, sortCatalogDocs } from './docs-hub/search.js';
import { TextSearchResults, useTextSearch } from './docs-hub/text-search.jsx';
import { isFeatureOn } from './feature-flags.js';
import { markShareAfterNav } from './profile-posters.js';
import './docs-hub.css';

const VIEWS = [['docs', 'Docs'], ['recent', 'Recent'], ['starred', 'Starred'], ['comments', 'Comments'], ['trash', 'Trash'], ['settings', 'Settings']];
const CATALOG_LAYOUT_KEY = 'tdoc.catalogLayout';

// A profile lists only Public docs, and pinning one makes it Public. Say so
// every time the doc is not Public yet (an unknown visibility counts as not).
function pinNeedsPublicConfirm(visibility) {
  return visibility !== 'public';
}

function HubDialog({ title, children, confirmLabel, danger, onConfirm, onClose, actions }) {
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={title}
      actions={actions || (
        <>
          <AppButton onClick={onClose}>Cancel</AppButton>
          {onConfirm ? (
            <AppButton variant={danger ? 'danger' : 'primary'} className={danger ? 'danger' : 'primary'} onClick={onConfirm}>
              {confirmLabel}
            </AppButton>
          ) : null}
        </>
      )}
    >
      {children}
    </AppDialog>
  );
}

// A name prompt. Folders were its first caller; renaming a document is its
// second, and neither wants its own copy of an input that commits on Enter.
function NameDialog({ title, confirmLabel, initialName, maxLength = 60, onSave, onClose }) {
  const [name, setName] = useState(initialName);
  const save = () => onSave(name);
  return (
    <HubDialog title={title} confirmLabel={confirmLabel} onConfirm={save} onClose={onClose}>
      <input
        type="text"
        maxLength={maxLength}
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
      />
    </HubDialog>
  );
}

// `team` (its name) for a team folder: there a private link opens for the
// whole team plus whoever is invited.
function FolderShareDialog({ folder, team = '', onClose, onAccess }) {
  const [visibility, setVisibility] = useState(folder.visibility === 'private' ? 'private' : 'unlisted');
  const [allowedUsers, setAllowedUsers] = useState(() => folder.allowed_users || []);
  const [shareId, setShareId] = useState(folder.share_id || '');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [minting, setMinting] = useState(!folder.share_id);
  const savedRef = useRef({
    visibility: folder.visibility === 'private' ? 'private' : 'unlisted',
    allowed_users: folder.allowed_users || [],
    share_id: folder.share_id || '',
  });

  useEffect(() => {
    setVisibility(savedRef.current.visibility);
    setAllowedUsers(savedRef.current.allowed_users);
    setShareId(savedRef.current.share_id);
  }, [folder.id]);

  const shareUrl = shareId
    ? `${location.origin}/f/${encodeURIComponent(shareId)}`
    : '';
  const invitedCount = allowedUsers.length;
  const accessDescription = visibility !== 'private'
    ? 'Anyone with the link sees docs they already have permission to read.'
    : invitedCount
      ? `Only ${team ? `${team} members` : 'you'} and ${invitedCount} invited ${invitedCount === 1 ? 'person' : 'people'} can open this folder. Docs keep their own access.`
      : `Only ${team ? `${team} members` : 'you'} can open this folder. Add people below to invite them.`;

  const save = async (patch, { quiet = false } = {}) => {
    const previous = { visibility, allowedUsers, shareId };
    const nextVisibility = patch.visibility ?? visibility;
    const nextAllowed = patch.allowed_users ?? allowedUsers;
    setVisibility(nextVisibility);
    setAllowedUsers(nextAllowed);
    setBusy(true);
    if (!quiet) setStatus('Saving…');
    const saved = await onAccess(patch.share === false ? { share: false } : { visibility: nextVisibility, allowed_users: nextAllowed });
    setBusy(false);
    if (!saved) {
      setVisibility(previous.visibility);
      setAllowedUsers(previous.allowedUsers);
      setShareId(previous.shareId);
      setStatus('Could not save.');
      return;
    }
    const next = {
      visibility: saved.visibility === 'private' ? 'private' : 'unlisted',
      allowed_users: saved.allowed_users || [],
      share_id: saved.share_id || '',
    };
    savedRef.current = next;
    setVisibility(next.visibility);
    setAllowedUsers(next.allowed_users);
    setShareId(next.share_id);
    setStatus(quiet ? '' : patch.share === false ? 'Link turned off.' : 'Saved.');
  };

  // A folder only gets its link the first time its access is saved, so one
  // still on its default access ("the team and people I invite") had nothing
  // to copy. Saving the current access as the dialog opens mints the link;
  // the link still opens only for people who already have access.
  useEffect(() => {
    if (savedRef.current.share_id) { setMinting(false); return; }
    setMinting(true);
    save({}, { quiet: true }).finally(() => setMinting(false));
  }, [folder.id]);

  return (
    <HubDialog
      title="Share"
      onClose={onClose}
      actions={(
        <>
          {shareId ? (
            <AppButton className="folder-unshare" disabled={busy} onClick={() => save({ share: false, visibility: 'private', allowed_users: [] })}>
              Stop sharing
            </AppButton>
          ) : null}
          <AppButton onClick={onClose}>Close</AppButton>
        </>
      )}
    >
      {shareUrl ? (
        <>
          <ShareLinkRow url={shareUrl} disabled={busy} onCopy={() => copyText(shareUrl).then(() => setStatus('Copied.'))} />
        </>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          {minting ? 'Getting the link…' : 'Choose who has access to mint a share link.'}
        </p>
      )}
      <p className="muted" style={{ margin: '8px 0 0' }}>
        {folder.name} · docs keep their own access
      </p>

      <section className="manage-section">
        <label className="field" htmlFor="tdoc-folder-access">Who has access</label>
        <AppSelect
          id="tdoc-folder-access"
          value={visibility}
          disabled={busy}
          onChange={(next) => save({ visibility: next })}
          options={[
            { value: 'private', label: team ? 'The team and people I invite' : 'Only people I invite' },
            { value: 'unlisted', label: 'Anyone with the link' },
          ]}
        />
        <p className="manage-hint">{accessDescription}</p>

        {visibility === 'private' ? (
          <>
            <label className="field">Invite by GitHub username</label>
            <InviteField
              users={allowedUsers}
              onChange={(users) => save({ allowed_users: users })}
            />
          </>
        ) : null}
      </section>
      {status ? <p className="muted" style={{ margin: '8px 0 0' }}>{status}</p> : null}
    </HubDialog>
  );
}

// One rule for every list: a document says whose it is, and your own say "me",
// the way a docs list's Owner column reads. A document with nobody recorded —
// published before hosted accounts, or living on a self-hosted worker — says
// nothing rather than guessing.
function ownerLabel(doc, viewer) {
  if (doc.mine) return 'me';
  if (!doc.owner) return null;
  return viewer && doc.owner === viewer ? 'me' : doc.owner;
}

// Personal and team spaces share this exact catalog control bar. A space may
// add its own action at the end, but search and sort never fork again.
function DocsToolbar({ query, onQuery, sort, onSort, children }) {
  return (
    <div className="toolbar">
      <label className="search-field">
        <Search size={15} />
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search all docs · try title:roadmap"
          aria-label="Search docs"
          aria-description="Searches every folder. Narrow a term with title, slug, preview, or path followed by a colon."
        />
      </label>
      <AppSelect
        plain
        className="toolbar-select"
        ariaLabel="Sort docs"
        value={sort}
        onChange={onSort}
        options={[
          { value: 'updated', label: 'Last updated' },
          { value: 'created', label: 'Created' },
          { value: 'title', label: 'Title' },
        ]}
      />
      {children}
      {query.trim() ? (
        <p className="search-syntax">Searching every folder · narrow with <code>title:</code>, <code>preview:</code>, <code>path:</code>, or <code>slug:</code></p>
      ) : null}
    </div>
  );
}

// Feedback spaces: one row per app, with where its comments stand. The row
// opens the space's own page (the comment list), not a document.
function FeedbackList({ spaces: initial }) {
  // Counts cost a comment read per space, so they load when the tab opens.
  const [spaces, setSpaces] = useState(initial);
  const [embedding, setEmbedding] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/me/feedback', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (!cancelled && b && Array.isArray(b.spaces)) setSpaces(b.spaces); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (!spaces.length) {
    // The first visit to this tab is usually someone who has not tried it:
    // say what it is and how to start, rather than "nothing here".
    return (
      <div className="tdoc-fb-empty">
        <div className="tdoc-fb-empty-art" aria-hidden="true">
          <span className="win"><i /><i /><i /></span>
          <span className="pin">💬</span>
        </div>
        <h3>Collect feedback on your own app</h3>
        <p className="muted">Click anything in the app you are building, say what is wrong, and hand it to your agent. Every app you comment on gets a list here.</p>
        <ol>
          <li><b>Get the bookmark</b> — drag it to your bookmarks bar.</li>
          <li><b>Open your app</b> and click it, then <b>+ Comment</b>.</li>
          <li><b>Share</b> the list with teammates, or <b>Send to agent</b>.</li>
        </ol>
        <a className="ui-btn ui-btn-primary ui-btn-m" href="/feedback">Get the bookmark</a>
      </div>
    );
  }
  return (
    <>
    <div className="doc-list">
      {spaces.map((space) => {
        let host = space.origin;
        try { host = new URL(space.origin).host; } catch (_) {}
        return (
          <div key={space.slug} className="doc-row flat-row tdoc-fb-row">
            <a className="doc-info" href={`/d/${encodeURIComponent(space.slug)}`}>
              <span className="doc-title">{host}</span>
              <div className="doc-meta">
                {[space.open == null ? null : `${space.open} open`, space.replied ? `${space.replied} replied` : null, space.mine ? null : 'joined', space.site ? 'on the site' : null, `updated ${day(space.updated)}`].filter(Boolean).join(' · ')}
              </div>
            </a>
            {space.mine ? (
              <AppButton className="tdoc-fb-embed-btn" onClick={() => setEmbedding(space)}>
                {space.site ? 'Site settings' : 'Add to your site'}
              </AppButton>
            ) : null}
          </div>
        );
      })}
    </div>
    {embedding ? (
      <SiteEmbedDialog
        space={embedding}
        onClose={() => setEmbedding(null)}
        onSaved={(site) => setSpaces((list) => list.map((s) => (s.slug === embedding.slug ? { ...s, site } : s)))}
      />
    ) : null}
    </>
  );
}

// Turn a feedback space into the site's own comment space: the snippet any
// page can paste and which origins it works on. Who may comment is the
// space's own Share settings, as on any doc.
function SiteEmbedDialog({ space, onClose, onSaved }) {
  const [origins, setOrigins] = useState(() => ((space.site && space.site.origins) || [space.origin]).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [snippet, setSnippet] = useState(space.site ? `<script src="${location.origin}/feedback.js" data-tdoc-space="${space.slug}" async></script>` : '');
  const save = async (off = false) => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/feedback/site', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(off ? { slug: space.slug, off: true } : { slug: space.slug, origins: origins.split(/[\s,]+/).filter(Boolean) }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error === 'invalid_origin' ? `Not a site address: ${body.origin}. Use the form https://example.com.` : (body.message || body.error || 'Could not save'));
      if (off) { onSaved(null); onClose(); return; }
      setSnippet(body.snippet);
      onSaved(body.site);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="Comments on your site"
      description="Paste one line into your site and the people you share this space with can comment on any page. Every comment lands here."
      actions={(
        <>
          {space.site ? <AppButton variant="danger" className="danger" disabled={busy} onClick={() => save(true)}>Turn off</AppButton> : null}
          <AppButton onClick={onClose}>Close</AppButton>
          <AppButton variant="primary" className="primary" disabled={busy} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</AppButton>
        </>
      )}
    >
      <div className="tdoc-send">
        <div className="tdoc-send-field">
          <label className="tdoc-send-label" htmlFor="tdoc-site-origins">Site addresses <span>one per line</span></label>
          <textarea id="tdoc-site-origins" className="tdoc-notify-instruction" rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://example.com" />
        </div>
        <p className="tdoc-send-hint">Who can comment follows this space's <a href={`/d/${encodeURIComponent(space.slug)}?doc=1&share=1`}>Share settings</a>, like any doc.</p>
        {snippet ? (
          <div className="tdoc-send-field">
            <span className="tdoc-send-label">Paste this into your site</span>
            <code className="tdoc-site-snippet">{snippet}</code>
            <CopyPromptButton text={snippet} />
          </div>
        ) : null}
        {error ? <p className="tdoc-send-result tdoc-notify-error" role="status">{error}</p> : null}
      </div>
    </AppDialog>
  );
}

// Teams that invited you by handle or address and you have not joined yet.
// An invite by handle sends no email, so this is where the person finds it.
function TeamInviteBanner({ invites }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const join = async (team) => {
    setBusy(team.id);
    setError('');
    try {
      const r = await fetch('/api/team/accept-invite', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: team.id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error === 'team_full' ? `${team.name} is full.` : (body.message || body.error || 'Could not join'));
      location.href = `/me?team=${encodeURIComponent(team.id)}`;
    } catch (err) {
      setError(err.message);
      setBusy('');
    }
  };
  return (
    <div className="tm-invites" role="region" aria-label="Team invitations">
      {invites.map((team) => (
        <div key={team.id} className="tm-invite">
          <UsersRound size={16} aria-hidden="true" />
          <span className="tm-invite-text"><b>{team.name}</b> invited you to its team{team.member_count ? ` · ${team.member_count} ${team.member_count === 1 ? 'member' : 'members'}` : ''}</span>
          <AppButton variant="primary" className="primary" disabled={busy === team.id} onClick={() => join(team)}>
            {busy === team.id ? 'Joining…' : 'Join'}
          </AppButton>
        </div>
      ))}
      {error ? <p className="tm-invite-error" role="status">{error}</p> : null}
    </div>
  );
}

function CatalogLayoutToggle({ layout, onLayout }) {
  return (
    <div className="catalog-layout" role="group" aria-label="Document layout">
      <button type="button" className={layout === 'grid' ? 'is-active' : ''} aria-label="Grid view" aria-pressed={layout === 'grid'} onClick={() => onLayout('grid')}><LayoutGrid size={17} /></button>
      <button type="button" className={layout === 'list' ? 'is-active' : ''} aria-label="List view" aria-pressed={layout === 'list'} onClick={() => onLayout('list')}><List size={18} /></button>
    </div>
  );
}

function FlatList({ docs, label, viewer, empty, onToggleStar, layout }) {
  if (!docs.length) return <p className="empty">{empty}</p>;
  return (
    <DocList
      docs={docs}
      layout={layout}
      rowProps={(doc) => ({
        className: 'flat-row',
        meta: [ownerLabel(doc, viewer), `${label} ${day(doc.at)}`].filter(Boolean).join(' · '),
        onToggleStar,
      })}
    />
  );
}

function AccountSettingsPane({ identity, profile }) {
  const name = identity?.name || identity?.email || identity?.login || 'Your account';
  return (
    <section className="tm-settings" aria-label="Personal workspace settings">
      <div className="tm-settings-title"><h2>Workspace settings</h2><p>Settings for your personal workspace.</p></div>
      <section className="tm-settings-card">
        <div className="tm-settings-head"><div><h2>Profile</h2><p>{name}</p></div></div>
        <a className="ui-btn ui-btn-secondary ui-btn-m" href={profile?.handle ? `/@${encodeURIComponent(profile.handle)}` : '/me#claim-profile'}>
          {profile?.handle ? 'Open public profile' : 'Claim public profile'}
        </a>
      </section>
      <SignInMethodsCard />
      <ConnectAiAppsSection className="tm-settings-card" />
      <section className="tm-settings-card" id="agents">
        <div className="tm-settings-head"><div><h2>Agents</h2><p>Connect Raft, Claude Code, Codex, or a webhook for this workspace.</p></div></div>
        <ConnectorsBody returnTo="/me?view=settings#agents" />
      </section>
      <section className="tm-settings-card" id="agent-access">
        <div className="tm-settings-head"><div><h2>Agent access</h2><p>Computers and agents that can act as you, and which workspaces each one can reach.</p></div></div>
        <DevicesBody />
      </section>
    </section>
  );
}

// Claim or change via the same AppDialog / HubDialog surface as rename +
// folder share. Letters/numbers/hyphens; changing frees the previous @handle.
function ClaimHandleDialog({ suggested, current, onClose }) {
  const changing = Boolean(current);
  const [name, setName] = useState(suggested || current || '');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setStatus('');
    try {
      const r = await fetch('/api/me/handle', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: name }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus(
          body.error === 'handle_taken' ? 'That handle is taken.'
            : body.error === 'reserved_handle' ? 'That name is reserved.'
            : body.error === 'invalid_handle' ? 'Use letters, numbers, and hyphens.'
            : body.error === 'sign_in_required' ? 'Sign in again, then retry.'
            : body.error === 'forbidden' ? 'This account cannot claim a handle here.'
            : body.error ? `Could not claim (${body.error}).`
            : 'Could not claim handle.',
        );
        setBusy(false);
        return;
      }
      markShareAfterNav();
      if (body.url) location.assign(body.url.includes('?') ? `${body.url}&share=1` : `${body.url}?share=1`);
      else location.reload();
    } catch {
      setStatus('Could not claim handle.');
      setBusy(false);
    }
  };

  return (
    <HubDialog
      title={changing ? 'Change your public URL' : 'Claim your public URL'}
      confirmLabel={busy ? (changing ? 'Saving…' : 'Claiming…') : (changing ? 'Save' : 'Claim')}
      onConfirm={save}
      onClose={onClose}
    >
      <p className="manage-hint">
        {changing
          ? 'Public docs show at tdoc.dev/@handle. Changing frees the old name.'
          : 'Public docs show at tdoc.dev/@handle. Letters, numbers, hyphens.'}
      </p>
      <label className="field" htmlFor="tdoc-handle-claim">Handle</label>
      <input
        id="tdoc-handle-claim"
        type="text"
        maxLength={39}
        autoFocus
        disabled={busy}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
        placeholder={suggested || current || 'you'}
      />
      {status ? <p className="manage-hint">{status}</p> : null}
    </HubDialog>
  );
}

// Page-level orchestrator for /me. State and mutations live in useDocsHub;
// rows and menus are the shared docs-hub/rows.jsx components; every modal is
// the AppDialog facade. This component only decides what is on screen.
export function DocsHub({ boot }) {
  const capabilities = { folders: true, delete: true, star: true, create: true, ...(boot.capabilities || {}) };
  const viewer = boot.identity?.login || '';
  const hub = useDocsHub({
    boot,
    // /me is session-gated by the server; a 401 mid-visit means the session
    // expired, and the route's own redirect is the sign-in path.
    onUnauthorized: () => { location.href = '/?notice=signin'; },
  });
  // Every workspace uses the same navigation; every view follows the active
  // workspace, including Recent and Starred.
  // Keep old ?tab=feedback links working while moving to the unified ?view=.
  const [view, setView] = useState(() => {
    const params = new URLSearchParams(location.search);
    const asked = params.get('view') || params.get('tab');
    const normalized = asked === 'feedback' ? 'comments' : asked === 'mine' ? 'docs' : asked;
    return VIEWS.some(([id]) => id === normalized) ? normalized : 'docs';
  });
  // Capture the account-menu destination before useDocsHub normalizes the URL.
  // ?new_team=1 is the top-bar switcher's "New team" from any page.
  const [modal, setModal] = useState(() => (
    boot.profile && location.hash === '#claim-profile' ? { type: 'claim-handle' }
      : new URLSearchParams(location.search).get('new_team') === '1' ? { type: 'new-team' } : null
  ));
  const [pins, setPins] = useState(() => new Set(boot.profile?.pins || []));
  const [teams, setTeams] = useState(() => boot.teams || []);
  const [teamDocs, setTeamDocs] = useState(() => boot.team_docs || []);
  const [layout, setLayoutState] = useState(() => {
    try { return localStorage.getItem(CATALOG_LAYOUT_KEY) === 'grid' ? 'grid' : 'list'; } catch { return 'list'; }
  });
  const setLayout = (next) => {
    setLayoutState(next);
    try { localStorage.setItem(CATALOG_LAYOUT_KEY, next); } catch { /* preference only */ }
  };
  const [space, setSpace] = useState(() => {
    const initial = new URLSearchParams(location.search).get('team') || '';
    return (boot.teams || []).some((team) => team.id === initial) ? initial : '';
  });
  const team = teams.find((item) => item.id === space) || null;
  // A team's folders: shared by its members, filed into by the doc's author
  // or an admin (agents do the same through tdoc-folder).
  const [teamFolders, setTeamFolders] = useState(() => boot.team_folders || {});
  const [teamFolder, setTeamFolder] = useState(() => {
    const params = new URLSearchParams(location.search);
    const initial = params.get('folder') || '';
    return ((boot.team_folders || {})[params.get('team') || ''] || []).some((item) => item.id === initial) ? initial : '';
  });
  const spaceFolders = team ? teamFolders[team.id] || [] : [];
  const teamFolderById = new Map(spaceFolders.map((item) => [item.id, item]));
  const teamPath = [];
  for (let cur = teamFolderById.get(teamFolder); cur && teamPath.length < 8; cur = teamFolderById.get(cur.parent)) teamPath.unshift(cur);
  const allTeamDocs = team ? teamDocs.filter((doc) => doc.team === team.id) : [];
  const inActiveWorkspace = (doc) => (team ? doc.workspace_id === team.id : !doc.workspace_id);
  const scopedRecent = hub.recent.filter(inActiveWorkspace);
  const scopedStarred = hub.starred.filter(inActiveWorkspace);
  const teamNeedle = hub.query.trim().toLowerCase();
  const teamSearching = Boolean(teamNeedle);
  const teamPathForDoc = (doc) => folderPathLabel(doc.folder, teamFolderById);
  const shownTeamDocs = sortCatalogDocs(allTeamDocs
    .filter((doc) => teamSearching || (doc.folder || '') === teamFolder)
    .filter((doc) => matchesCatalogQuery(doc, teamPathForDoc(doc), hub.query)), hub.sort);
  const shownTeamFolders = spaceFolders
    .filter(() => !teamSearching)
    .filter((item) => (item.parent || '') === teamFolder)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const teamFolderCounts = folderContents(spaceFolders, allTeamDocs);
  const pickSpace = (id) => { setTeamFolder(''); setSpace(id); };

  // Words inside documents and comments, from the server, for the space on
  // screen. The title filter above stays instant; these follow it.
  // Behind the fullTextSearch flag (dev mode only until approved): off, the
  // hook never asks and the section never shows.
  const [fullTextSearch] = useState(() => isFeatureOn('fullTextSearch'));
  const textSearch = useTextSearch(fullTextSearch && view === 'docs' ? hub.query : '', team ? team.id : '');
  // With no title match, the empty notice waits for the text results and
  // only shows when they found nothing either.
  const titleEmpty = (searching) => {
    if (!searching) return null;
    if (textSearch.status === 'loading') return null;
    if (textSearch.status === 'done' && textSearch.results.length) return null;
    return 'No matches.';
  };
  const textResultPath = (item) => {
    if (item.workspace_id) {
      const folderPath = team && item.workspace_id === team.id ? teamPathForDoc(item) : '';
      return [team && item.workspace_id === team.id ? team.name : '', folderPath].filter(Boolean).join(' › ');
    }
    if (item.mine) return ['My docs', hub.pathForDoc(item)].filter(Boolean).join(' › ');
    return item.owner ? `by ${item.owner}` : 'Shared with you';
  };

  useEffect(() => {
    if (space) {
      const folderPart = view === 'docs' && teamFolder ? `&folder=${encodeURIComponent(teamFolder)}` : '';
      const viewPart = view === 'docs' ? '' : `&view=${encodeURIComponent(view)}`;
      history.replaceState(null, '', `?team=${encodeURIComponent(space)}${folderPart}${viewPart}`);
    } else {
      const query = view === 'docs'
        ? (hub.folder ? `?folder=${encodeURIComponent(hub.folder)}` : '')
        : `?view=${encodeURIComponent(view)}`;
      history.replaceState(null, '', `${location.pathname}${query}`);
    }
  }, [space, teamFolder, view, hub.folder]);

  const setSpaceFolders = (update) => setTeamFolders((all) => ({ ...all, [team.id]: update(all[team.id] || []) }));
  const teamRun = (operation, success) => operation
    .then((result) => { if (success) hub.notify(success); return result || true; })
    .catch((error) => { teamFailed(error); return false; });
  const saveTeamFolder = ({ id, name }) => {
    const trimmed = String(name || '').trim();
    if (!trimmed || !team) return Promise.resolve(false);
    if (id) {
      return teamRun(renameFolder(id, trimmed, team.id).then(({ folder }) => {
        setSpaceFolders((list) => list.map((item) => (item.id === folder.id ? { ...item, ...folder } : item)));
      }));
    }
    return teamRun(createFolder(trimmed, teamFolder, team.id).then(({ folder }) => {
      setSpaceFolders((list) => [...list, { ...folder, parent: folder.parent || '' }]);
    }));
  };
  // A team folder goes to the team's Trash with its subfolders and the docs
  // this person could delete; the rest move up a level. Undo puts it back.
  const deleteTeamFolder = (item) => teamRun(deleteFolderRequest(item.id, team.id).then((result) => {
    const up = item.parent || '';
    const owner = team;
    rememberTrashed({ folder: item.id });
    const before = { folders: spaceFolders, docs: teamDocs };
    const tree = new Set([item.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const candidate of spaceFolders) if (tree.has(candidate.parent) && !tree.has(candidate.id)) { tree.add(candidate.id); grew = true; }
    }
    const trashed = new Set((result && result.docs) || []);
    setSpaceFolders((list) => list.filter((candidate) => !tree.has(candidate.id)));
    setTeamDocs((list) => list
      .filter((doc) => !trashed.has(doc.slug))
      .map((doc) => (doc.team === owner.id && tree.has(doc.folder) ? { ...doc, folder: up } : doc)));
    if (tree.has(teamFolder)) setTeamFolder(up);
    hub.notify(`Moved “${item.name}”${trashed.size ? ` and ${trashed.size === 1 ? '1 doc' : `${trashed.size} docs`}` : ''} to Trash`, false, {
      label: 'Undo',
      run: () => restoreFromTrash({ folder: item.id, team: owner.id }).then(() => {
        setTeamFolders((all) => ({ ...all, [owner.id]: before.folders }));
        setTeamDocs(before.docs);
        hub.notify(`Restored “${item.name}”`);
      }).catch(teamFailed),
    });
  }));
  // Delete a team doc: to the team's Trash, with Undo on the toast.
  const deleteTeamDoc = (doc) => deleteDocument(doc.slug).then(() => {
    rememberTrashed({ slug: doc.slug });
    setTeamDocs((list) => list.filter((row) => row.slug !== doc.slug));
    closeModal();
    hub.notify('Moved to Trash', false, {
      label: 'Undo',
      run: () => restoreFromTrash({ slug: doc.slug }).then(() => {
        setTeamDocs((list) => [doc, ...list.filter((row) => row.slug !== doc.slug)]);
        hub.notify(`Restored “${doc.title}”`);
      }).catch(teamFailed),
    });
  }).catch(teamFailed);
  const moveTeamDocs = async (slugs, destination) => {
    const moving = new Set(slugs);
    const previous = new Map(teamDocs.filter((doc) => moving.has(doc.slug)).map((doc) => [doc.slug, doc]));
    setTeamDocs((list) => list.map((doc) => (moving.has(doc.slug) ? { ...doc, folder: destination } : doc)));
    const ok = await teamRun(moveDocsToFolder(slugs, destination, team.id), `Moved ${slugs.length === 1 ? '1 doc' : `${slugs.length} docs`}`);
    if (!ok) setTeamDocs((list) => list.map((doc) => previous.get(doc.slug) || doc));
    return ok;
  };

  // Deleted from the doc page, which lands here with ?trashed=<slug>: say
  // where it went and offer the way back to the doc.
  const [trashedFromDoc] = useState(() => {
    const slug = new URLSearchParams(location.search).get('trashed') || '';
    return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) ? slug : '';
  });
  useEffect(() => {
    if (!trashedFromDoc) return;
    hub.notify('Moved to Trash', false, {
      label: 'Undo',
      run: () => restoreFromTrash({ slug: trashedFromDoc })
        .then(() => { location.href = `/d/${encodeURIComponent(trashedFromDoc)}`; })
        .catch((error) => hub.notify(error.message || 'Could not restore', true)),
    });
  }, [trashedFromDoc]);

  const closeModal = () => setModal(null);
  const closeIf = (promise) => promise.then((ok) => { if (ok) closeModal(); });
  const openAgentRecipe = () => setModal({ type: 'create-agent' });

  const toggleProfilePin = async (doc, { confirmed = false } = {}) => {
    if (!doc || !doc.slug || !boot.profile || !doc.mine) return;
    const next = !pins.has(doc.slug);
    if (next && !confirmed && pinNeedsPublicConfirm(doc.visibility)) {
      setModal({ type: 'curate-warn', doc });
      return;
    }
    const previous = new Set(pins);
    setPins((cur) => {
      const copy = new Set(cur);
      if (next) copy.add(doc.slug);
      else copy.delete(doc.slug);
      return copy;
    });
    try {
      const r = await fetch('/api/me/profile/pin', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: doc.slug, pinned: next }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setPins(previous);
        hub.notify(next
          ? `Could not show on profile${body.error ? ` (${body.error})` : ''}`
          : `Could not remove from profile${body.error ? ` (${body.error})` : ''}`, true);
        return;
      }
      if (Array.isArray(body.pins)) setPins(new Set(body.pins));
      hub.notify(next ? 'Shown on your profile' : 'Removed from your profile');
    } catch {
      setPins(previous);
      hub.notify(next ? 'Could not show on profile' : 'Could not remove from profile', true);
    }
  };

  const docMenu = (slugs, doc) => [
    doc && (doc.mine || !doc.owner || doc.owner === viewer) ? {
      label: 'Rename',
      className: 'row-rename',
      onSelect: () => setModal({ type: 'rename-doc', doc }),
    } : null,
    // Author only — curate is a doc permission flag, not a collaborator action.
    boot.profile && doc && doc.mine ? {
      label: pins.has(doc.slug) ? 'Remove from profile' : 'Show on profile',
      className: 'row-profile-pin',
      onSelect: () => toggleProfilePin(doc),
    } : null,
    teams.length && doc && doc.mine ? {
      label: 'Move to team',
      className: 'row-move-team',
      onSelect: () => setModal({ type: 'move-team', slugs }),
    } : null,
    capabilities.folders ? {
      label: 'Move to folder',
      className: 'row-move',
      onSelect: () => setModal({ type: 'move', slugs }),
    } : null,
    capabilities.delete ? {
      label: 'Delete',
      tone: 'danger',
      className: 'row-delete',
      onSelect: () => setModal({ type: 'delete-docs', slugs }),
    } : null,
  ].filter(Boolean);

  const folderMenu = (item) => [
    { label: 'Share', onSelect: () => setModal({ type: 'share-folder', folder: item }) },
    { label: 'Rename', onSelect: () => setModal({ type: 'rename-folder', folder: item }) },
    teams.length ? { label: 'Move to team…', className: 'folder-move-team', onSelect: () => setModal({ type: 'move-folder-team', folder: item }) } : null,
    {
      label: 'Delete folder',
      tone: 'danger',
      className: 'folder-delete',
      onSelect: () => setModal({ type: 'delete-folder', folder: item }),
    },
  ].filter(Boolean);

  const teamFolderMenu = (item) => (item.can_manage ? [
    { label: 'Share', onSelect: () => setModal({ type: 'share-team-folder', folder: item }) },
    { label: 'Rename', onSelect: () => setModal({ type: 'rename-team-folder', folder: item }) },
    {
      label: 'Delete folder',
      tone: 'danger',
      className: 'folder-delete',
      onSelect: () => setModal({ type: 'delete-team-folder', folder: item }),
    },
  ] : []);

  const teamFailed = (error) => {
    if (error.status === 401) location.href = '/?notice=signin';
    else hub.notify(error.message || 'Request failed', true);
  };

  const movingSlugs = useRef(new Set());
  const folderMoveBefore = useRef(null);
  const startFolderMove = (folder) => {
    folderMoveBefore.current = { docs: hub.docs, folders: hub.folders };
    const tree = new Set([folder.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const item of hub.folders) if (tree.has(item.parent) && !tree.has(item.id)) { tree.add(item.id); grew = true; }
    }
    hub.setDocs((items) => items.filter((doc) => !(doc.mine && tree.has(doc.folder))));
    hub.setFolders((items) => items.filter((item) => !tree.has(item.id)));
  };
  // The catalog as the server has it now: after a folder move, or after
  // something came back out of Trash.
  const refreshCatalog = async () => {
    const response = await fetch('/api/me', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Could not refresh the document list');
    const current = await response.json();
    hub.setDocs(current.docs || []);
    hub.setFolders(current.folders || []);
    hub.setRecent(current.recent || []);
    hub.setStarred(current.starred || []);
    setTeamDocs(current.team_docs || []);
    setTeamFolders(current.team_folders || {});
  };
  const settleFolderMove = async () => {
    try {
      await refreshCatalog();
      folderMoveBefore.current = null;
    } catch (error) {
      if (folderMoveBefore.current) {
        hub.setDocs(folderMoveBefore.current.docs);
        hub.setFolders(folderMoveBefore.current.folders);
        folderMoveBefore.current = null;
      }
      hub.notify(error.message || 'Could not refresh the document list', true);
    }
  };
  const moveBetweenWorkspaces = async (slugs, targetId) => {
    if (slugs.some((slug) => movingSlugs.current.has(slug))) return false;
    slugs.forEach((slug) => movingSlugs.current.add(slug));
    const moving = new Set(slugs);
    const personalRows = hub.docs.filter((doc) => moving.has(doc.slug));
    const teamRows = teamDocs.filter((doc) => moving.has(doc.slug));
    const sourceRows = targetId ? personalRows : teamRows;
    const targetTeam = teams.find((item) => item.id === targetId);
    const movedRows = sourceRows.map((doc) => ({
      ...doc,
      folder: '',
      workspace_id: targetId || null,
      ...(targetId ? {
        team: targetId,
        author: doc.mine ? 'me' : doc.owner,
        can_manage: true,
        can_file: true,
      } : {}),
    }));
    const updateSaved = (items, workspaceId) => items.map((doc) => (
      moving.has(doc.slug) ? { ...doc, workspace_id: workspaceId, folder: '' } : doc
    ));
    hub.setDocs((items) => targetId
      ? items.filter((doc) => !moving.has(doc.slug))
      : [...items, ...movedRows.filter((doc) => doc.mine)]);
    setTeamDocs((items) => targetId
      ? [...items, ...movedRows]
      : items.filter((doc) => !moving.has(doc.slug)));
    hub.setRecent((items) => updateSaved(items, targetId));
    hub.setStarred((items) => updateSaved(items, targetId));
    try {
      await moveDocsToTeam(slugs, targetId);
      hub.setSelected(new Set());
      hub.notify(`Moved ${slugs.length === 1 ? '1 doc' : `${slugs.length} docs`}${targetTeam ? ` to ${targetTeam.name}` : ' to My docs'}`);
      return true;
    } catch (error) {
      hub.setDocs((items) => targetId
        ? [...items, ...personalRows]
        : items.filter((doc) => !moving.has(doc.slug)));
      setTeamDocs((items) => targetId
        ? items.filter((doc) => !moving.has(doc.slug))
        : [...items, ...teamRows]);
      const restoreSaved = (items) => items.map((doc) => {
        const original = [...hub.recent, ...hub.starred].find((row) => row.slug === doc.slug);
        return original && moving.has(doc.slug) ? original : doc;
      });
      hub.setRecent(restoreSaved);
      hub.setStarred(restoreSaved);
      teamFailed(error);
      return false;
    } finally {
      slugs.forEach((slug) => movingSlugs.current.delete(slug));
    }
  };

  const teamDocMenu = (doc) => [
    { label: 'Open', onSelect: () => { location.href = `/d/${encodeURIComponent(doc.slug)}`; } },
    doc.can_file ? {
      label: 'Move to folder',
      className: 'row-move',
      onSelect: () => setModal({ type: 'team-move', slugs: [doc.slug] }),
    } : null,
    doc.can_manage ? {
      label: doc.mine ? 'Move to My docs' : "Move to author's My docs",
      className: 'row-move-personal',
      onSelect: () => moveBetweenWorkspaces([doc.slug], null),
    } : null,
    doc.can_manage ? {
      label: 'Delete',
      tone: 'danger',
      className: 'row-delete',
      onSelect: () => setModal({ type: 'delete-team-doc', doc }),
    } : null,
  ].filter(Boolean);

  const allSelected = hub.shownDocs.length > 0 && hub.shownDocs.every((doc) => hub.selected.has(doc.slug));
  const batchActions = capabilities.folders || capabilities.delete || teams.length > 0;
  // Only the author moves a personal doc into a team, so a mixed selection
  // moves the author's own and says how many it left behind.
  const selectedDocs = hub.docs.filter((doc) => hub.selected.has(doc.slug));
  const movableToTeam = selectedDocs.filter((doc) => doc.mine).map((doc) => doc.slug);

  return (
    <div className="tdoc-app docs-hub">
      <TopBar
        identity={boot.identity}
        profile={boot.profile || null}
        onClaimProfile={boot.profile ? () => setModal({ type: 'claim-handle' }) : null}
        onboardingTest={boot.debug ? { record: boot.onboarding, surface: 'hub', onState: () => location.reload() } : null}
        space={space}
        teams={teams}
        onSpace={pickSpace}
        onNewTeam={() => setModal({ type: 'new-team' })}
      />
      <main className="wrap">
        {(boot.team_invites || []).length ? (
          <TeamInviteBanner invites={boot.team_invites} />
        ) : null}
        <div className="page-hd">
          <h1>{team ? team.name : 'My docs'}</h1>
          {['docs', 'recent', 'starred'].includes(view) ? (
            <div className="page-hd-actions">
              <CatalogLayoutToggle layout={layout} onLayout={setLayout} />
              {view === 'docs' ? (
                <CreateMenu
                  create={hub.createDoc}
                  team={team ? team.id : ''}
                  canCreate={capabilities.create}
                  onAgent={openAgentRecipe}
                  onQuota={(quota) => setModal({ type: 'quota-bump', quota })}
                  trigger={<button className="mk-btn" type="button">Create a doc</button>}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="tabs" role="tablist" aria-label={`${team ? team.name : 'My docs'} views`}>
          {VIEWS.map(([id, label]) => (
            <button key={id} type="button" className={`tab${view === id ? ' is-active' : ''}`} role="tab" aria-selected={view === id} onClick={() => { setTeamFolder(''); setView(id); }}>
              {label}
            </button>
          ))}
        </div>
        {view === 'recent' ? (
          <section className="pane" id="pane-recent">
            <FlatList docs={scopedRecent} label="visited" viewer={viewer} empty={`Docs you open in ${team ? team.name : 'My docs'} show up here.`} onToggleStar={hub.toggleStar} layout={layout} />
          </section>
        ) : view === 'starred' ? (
          <section className="pane" id="pane-starred">
            <FlatList docs={scopedStarred} label="starred" viewer={viewer} empty={`Star docs in ${team ? team.name : 'My docs'} to find them here.`} onToggleStar={hub.toggleStar} layout={layout} />
          </section>
        ) : team ? (
          <>
            {view === 'comments' ? (
              <TeamCommentsPane team={team} />
            ) : view === 'trash' ? (
              <TrashPane
                team={team}
                notify={hub.notify}
                onChanged={() => refreshCatalog().catch(teamFailed)}
                onFailed={teamFailed}
              />
            ) : view === 'settings' ? (
              <TeamSettingsPane
                team={team}
                onChanged={(next) => setTeams((list) => list.map((item) => (
                  item.id === next.id ? { ...item, name: next.name, role: next.role, member_count: next.member_count } : item
                )))}
                onLeave={(current, me) => setModal({ type: 'leave-team', team: current, me })}
              />
            ) : (
              <>
                <p className="loc-hint tm-loc muted">Docs here belong to the team. Every member can open and comment.</p>
                <DocsToolbar query={hub.query} onQuery={hub.setQuery} sort={hub.sort} onSort={hub.setSort}>
                  <button type="button" className="new-folder-btn" onClick={() => setModal({ type: 'new-team-folder' })}>
                    <FolderPlus size={15} /> New folder
                  </button>
                </DocsToolbar>
                {!teamSearching && teamPath.length ? (
                  <nav className="crumbs" aria-label="Folder path">
                    <button className="crumb-root" type="button" onClick={() => setTeamFolder('')}>{team.name}</button>
                    {teamPath.map((item) => (
                      <React.Fragment key={item.id}>
                        <ChevronRight className="sep" size={14} />
                        <button className="crumb-root cur" type="button" onClick={() => setTeamFolder(item.id)}>{item.name}</button>
                      </React.Fragment>
                    ))}
                  </nav>
                ) : null}
                <div id="folder-rows">
                  {shownTeamFolders.map((item) => (
                    <FolderRow
                      key={item.id}
                      folder={item}
                      contents={teamFolderCounts[item.id]}
                      onOpen={() => setTeamFolder(item.id)}
                      menuItems={teamFolderMenu(item)}
                    />
                  ))}
                </div>
                <TeamPane
                  team={team}
                  docs={shownTeamDocs}
                  viewer={viewer}
                  menuFor={teamDocMenu}
                  inFolder={!!teamFolder || shownTeamFolders.length > 0}
                  layout={layout}
                  empty={teamSearching ? titleEmpty(true) : undefined}
                  pathForDoc={teamSearching ? teamPathForDoc : null}
                />
                <TextSearchResults
                  search={textSearch}
                  exclude={new Set(shownTeamDocs.map((doc) => doc.slug))}
                  pathFor={textResultPath}
                />
              </>
            )}
          </>
        ) : (
        <>

        <OnboardingChecklist record={boot.onboarding} docs={hub.docs} />
        {view === 'docs' ? (
          <section className="pane" id="pane-mine">
            <DocsToolbar query={hub.query} onQuery={hub.setQuery} sort={hub.sort} onSort={hub.setSort}>
              {capabilities.folders ? (
                <button type="button" className="new-folder-btn" onClick={() => setModal({ type: 'new-folder' })}>
                  <FolderPlus size={15} /> New folder
                </button>
              ) : null}
            </DocsToolbar>

            {!hub.query.trim() && hub.path.length ? (
              <nav className="crumbs" aria-label="Folder path">
                <button className="crumb-root" type="button" onClick={() => hub.setFolder('')}>My docs</button>
                {hub.path.map((item) => (
                  <React.Fragment key={item.id}>
                    <ChevronRight className="sep" size={14} />
                    <button className="crumb-root cur" type="button" onClick={() => hub.setFolder(item.id)}>{item.name}</button>
                  </React.Fragment>
                ))}
              </nav>
            ) : null}

            <div className="batch-bar">
              <label className="select-all">
                <input type="checkbox" checked={allSelected} onChange={(event) => hub.selectAll(event.target.checked)} />
                {' '}
                <span>{hub.selected.size ? `${hub.selected.size} selected` : 'Select all'}</span>
              </label>
              {hub.selected.size && batchActions ? (
                <span className="batch-actions">
                  {teams.length && movableToTeam.length ? (
                    <button
                      type="button"
                      className="batch-move batch-move-team is-visible"
                      onClick={() => setModal({ type: 'move-team', slugs: movableToTeam, skipped: hub.selected.size - movableToTeam.length })}
                    >
                      Move to team
                    </button>
                  ) : null}
                  {capabilities.folders ? (
                    <button type="button" className="batch-move is-visible" onClick={() => setModal({ type: 'move', slugs: [...hub.selected] })}>Move to folder</button>
                  ) : null}
                  {capabilities.delete ? (
                    <button type="button" className="batch-delete is-visible" onClick={() => setModal({ type: 'delete-docs', slugs: [...hub.selected] })}>Delete selected</button>
                  ) : null}
                </span>
              ) : null}
            </div>

            <div id="folder-rows">
              {hub.shownFolders.map((item) => (
                <FolderRow
                  key={item.id}
                  folder={item}
                  contents={hub.folderCounts[item.id]}
                  onOpen={() => hub.setFolder(item.id)}
                  menuItems={folderMenu(item)}
                />
              ))}
            </div>
            <DocList
              docs={hub.shownDocs}
              layout={layout}
              selecting={hub.selected.size > 0}
              rowProps={(doc) => ({
                meta: [
                  ownerLabel(doc, viewer),
                  day(doc.created) ? `published ${day(doc.created)}` : null,
                  day(doc.updated) && day(doc.updated) !== day(doc.created)
                    ? `updated ${day(doc.updated)}`
                    : null,
                  doc.folder ? `in ${hub.folderById.get(doc.folder)?.name || ''}` : null,
                ].filter(Boolean).join(' · '),
                path: hub.query.trim() ? hub.pathForDoc(doc) : '',
                selection: { checked: hub.selected.has(doc.slug), onChange: () => hub.toggleSelected(doc.slug) },
                starrable: capabilities.star,
                onToggleStar: hub.toggleStar,
                menuItems: docMenu([doc.slug], doc),
                data: { created: doc.created, updated: doc.updated, folder: doc.folder },
              })}
              empty={!hub.shownFolders.length ? (hub.query ? titleEmpty(true) : 'No published docs here.') : null}
            />
            <TextSearchResults
              search={textSearch}
              exclude={new Set(hub.shownDocs.map((doc) => doc.slug))}
              pathFor={textResultPath}
            />
          </section>
        ) : null}

        {view === 'comments' ? (
          <section className="pane" id="pane-feedback">
            <FeedbackList spaces={Array.isArray(boot.feedback) ? boot.feedback : []} />
          </section>
        ) : null}
        {view === 'trash' ? (
          <TrashPane
            team={null}
            notify={hub.notify}
            onChanged={() => refreshCatalog().catch(teamFailed)}
            onFailed={teamFailed}
          />
        ) : null}
        {view === 'settings' ? <AccountSettingsPane identity={boot.identity} profile={boot.profile} /> : null}
        </>
        )}
      </main>

      {modal?.type === 'new-team' ? (
        <NewTeamDialog
          onClose={closeModal}
          onCreated={(created) => { location.href = `/me?team=${encodeURIComponent(created.id)}`; }}
        />
      ) : null}
      {modal?.type === 'leave-team' ? (
        <LeaveTeamDialog
          team={modal.team}
          docCount={teamDocs.filter((doc) => doc.team === modal.team.id && doc.mine).length}
          onClose={closeModal}
          onLeave={async () => {
            await removeTeamMember(modal.team.id, modal.me.account_id);
            location.href = '/me';
          }}
        />
      ) : null}
      {modal?.type === 'move-team' ? (
        <MoveToTeamDialog
          teams={teams}
          count={modal.slugs.length}
          skipped={modal.skipped || 0}
          onClose={closeModal}
          onMove={(target) => moveBetweenWorkspaces(modal.slugs, target.id).then((ok) => { if (ok) closeModal(); })}
        />
      ) : null}
      {modal?.type === 'move-folder-team' ? (
        <MoveFolderToTeamDialog
          folder={modal.folder}
          teams={teams}
          docCount={(() => {
            const tree = new Set([modal.folder.id]);
            for (let grew = true; grew;) {
              grew = false;
              for (const item of hub.folders) if (tree.has(item.parent) && !tree.has(item.id)) { tree.add(item.id); grew = true; }
            }
            return hub.docs.filter((doc) => doc.mine !== false && tree.has(doc.folder)).length;
          })()}
          onClose={closeModal}
          onStart={() => startFolderMove(modal.folder)}
          onSettled={settleFolderMove}
        />
      ) : null}
      {modal?.type === 'delete-team-doc' ? (
        <HubDialog
          title="Delete this doc?"
          confirmLabel="Delete"
          danger
          onConfirm={() => deleteTeamDoc(modal.doc)}
          onClose={closeModal}
        >
          <p>“{modal.doc.title}” moves to the team’s Trash for 30 days, then it is deleted for good. Until then nobody can open it, and a team admin can restore it from Trash.</p>
        </HubDialog>
      ) : null}

      {modal?.type === 'claim-handle' ? (
        <ClaimHandleDialog
          suggested={boot.profile?.suggested || ''}
          onClose={closeModal}
        />
      ) : null}
      {modal?.type === 'create-agent' ? (
        <HubDialog
          title="Build it with your agent"
          onClose={closeModal}
          actions={<AppButton onClick={closeModal}>Close</AppButton>}
        >
          <AgentRecipe />
        </HubDialog>
      ) : null}
      {modal?.type === 'quota-bump' ? (
        <QuotaBumpDialog
          open
          used={modal.quota?.used}
          limit={modal.quota?.limit}
          onClose={closeModal}
          onBumped={() => hub.notify('Limit raised — try creating again')}
        />
      ) : null}
      {modal?.type === 'rename-doc' ? (
        <NameDialog
          title="Rename doc"
          confirmLabel="Rename"
          initialName={modal.doc.title || ''}
          maxLength={120}
          onClose={closeModal}
          onSave={(name) => closeIf(hub.renameDoc(modal.doc.slug, name))}
        />
      ) : null}
      {modal?.type === 'new-folder' ? (
        <NameDialog title="New folder" confirmLabel="Create" initialName="" onClose={closeModal}
          onSave={(name) => closeIf(hub.saveFolder({ name }))} />
      ) : null}
      {modal?.type === 'rename-folder' ? (
        <NameDialog title="Rename folder" confirmLabel="Save" initialName={modal.folder.name} onClose={closeModal}
          onSave={(name) => closeIf(hub.saveFolder({ id: modal.folder.id, name }))} />
      ) : null}
      {modal?.type === 'share-folder' ? (
        <FolderShareDialog
          folder={hub.folders.find((item) => item.id === modal.folder.id) || modal.folder}
          onClose={closeModal}
          onAccess={(patch) => hub.setFolderAccess(modal.folder.id, patch)}
        />
      ) : null}
      {modal?.type === 'move' ? (
        <HubDialog title="Move to folder" onClose={closeModal}>
          <div className="move-list">
            <button type="button" onClick={() => closeIf(hub.moveDocs(modal.slugs, ''))}>My docs</button>
            {hub.folders.map((item) => (
              <button key={item.id} type="button" onClick={() => closeIf(hub.moveDocs(modal.slugs, item.id))}>
                <Folder size={15} /> {item.name}
              </button>
            ))}
          </div>
        </HubDialog>
      ) : null}
      {modal?.type === 'new-team-folder' ? (
        <NameDialog title="New folder" confirmLabel="Create" initialName="" onClose={closeModal}
          onSave={(name) => closeIf(saveTeamFolder({ name }))} />
      ) : null}
      {modal?.type === 'share-team-folder' && team ? (
        <FolderShareDialog
          folder={spaceFolders.find((item) => item.id === modal.folder.id) || modal.folder}
          team={team.name}
          onClose={closeModal}
          onAccess={(patch) => teamRun(updateFolderAccess(modal.folder.id, patch, team.id).then(({ folder }) => {
            setSpaceFolders((list) => list.map((item) => (item.id === folder.id ? { ...item, ...folder, share_id: folder.share_id } : item)));
            return folder;
          })).then((saved) => saved || null)}
        />
      ) : null}
      {modal?.type === 'rename-team-folder' ? (
        <NameDialog title="Rename folder" confirmLabel="Save" initialName={modal.folder.name} onClose={closeModal}
          onSave={(name) => closeIf(saveTeamFolder({ id: modal.folder.id, name }))} />
      ) : null}
      {modal?.type === 'delete-team-folder' ? (
        <HubDialog
          title={`Delete ${modal.folder.name}?`}
          confirmLabel="Delete folder"
          danger
          onConfirm={() => closeIf(deleteTeamFolder(modal.folder))}
          onClose={closeModal}
        >
          <p>The folder, its subfolders and the docs in them move to the team’s Trash for 30 days, then they are deleted for good. Restore them together from Trash until then. Docs you can’t delete yourself move up a level instead.</p>
        </HubDialog>
      ) : null}
      {modal?.type === 'team-move' && team ? (
        <HubDialog title="Move to folder" onClose={closeModal}>
          <div className="move-list">
            <button type="button" onClick={() => closeIf(moveTeamDocs(modal.slugs, ''))}>{team.name}</button>
            {spaceFolders.map((item) => (
              <button key={item.id} type="button" onClick={() => closeIf(moveTeamDocs(modal.slugs, item.id))}>
                <Folder size={15} /> {item.name}
              </button>
            ))}
          </div>
        </HubDialog>
      ) : null}
      {modal?.type === 'curate-warn' ? (
        <HubDialog
          title="Pinning makes this doc Public (searchable)"
          confirmLabel="Make Public and pin"
          onConfirm={() => {
            const doc = modal.doc;
            closeModal();
            toggleProfilePin(doc, { confirmed: true });
          }}
          onClose={closeModal}
        >
          <p className="manage-hint">
            Anyone can open it from your profile, and search engines can find it.
            Taking it down later restores the previous access. Only you can curate your own docs.
          </p>
        </HubDialog>
      ) : null}
      {modal?.type === 'delete-docs' ? (
        <HubDialog
          title={`Delete ${modal.slugs.length === 1 ? 'this doc' : `${modal.slugs.length} docs`}?`}
          confirmLabel="Delete"
          danger
          onConfirm={() => closeIf(hub.deleteDocs(modal.slugs))}
          onClose={closeModal}
        >
          <p>{modal.slugs.length === 1 ? 'It moves' : 'They move'} to Trash for 30 days, then {modal.slugs.length === 1 ? 'it is' : 'they are'} deleted for good. Until then nobody can open {modal.slugs.length === 1 ? 'it' : 'them'}, and you can restore {modal.slugs.length === 1 ? 'it' : 'them'} from Trash.</p>
        </HubDialog>
      ) : null}
      {modal?.type === 'delete-folder' ? (
        <HubDialog
          title={`Delete ${modal.folder.name}?`}
          confirmLabel="Delete folder"
          danger
          onConfirm={() => closeIf(hub.deleteFolder(modal.folder))}
          onClose={closeModal}
        >
          <p>The folder, its subfolders and the docs in them move to Trash for 30 days, then they are deleted for good. Restore them together from Trash until then.</p>
        </HubDialog>
      ) : null}

      {hub.toast ? (
        <div className={`tdoc-toast${hub.toast.error ? ' error' : ''}`} role="status">
          {hub.toast.error ? <X size={15} /> : <Check size={15} />}
          {hub.toast.message}
          {hub.toast.action ? (
            <button
              type="button"
              className="tdoc-toast-action"
              onClick={() => { const { run } = hub.toast.action; hub.dismissToast(); run(); }}
            >
              {hub.toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
