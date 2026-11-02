import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Send, Share2 } from 'lucide-react';
import { TopBar } from './top-bar.jsx';
import { Bookmarklet } from './feedback-install.jsx';
import { SegmentedControl } from './ui/segmented-control.jsx';
import { AppButton } from './ui/button.jsx';
import { CommentCard } from './document/comment-card.jsx';
import { ShareDialog } from './document/document-dialogs.jsx';
import { OwnerAccessDialog } from './document/owner-access-dialog.jsx';
import { MoveToTeamDialog } from './docs-hub/teams.jsx';
import { NotifyHandoffPanel, sendOneCommentToAgent, useNotifyTargets } from './document/notify-handoff.jsx';
import { orderedAgentChoices } from './document/agent-choices.js';
import { AgentMentionContext } from './document/mention-field.jsx';
import { summarizeHandoffSurfaces, threadPhase } from './document/handoff-state.js';
import {
  createComment, listComments, listMentionableUsers, listTeams, moveDocsToTeam, removeComment,
  setCommentResolved, toggleReaction, updateCommentText,
} from './document/api.js';
import './docs-hub.css';

// A feedback space's own page: every comment left on the app, grouped by the
// app page it was left on, the same list the in-app panel shows. It is also
// the one link people share — someone who has not joined gets the Join step
// right here, instead of a second /feedback/join address.

const pathOf = (href) => {
  try { const u = new URL(href); return `${u.pathname}${u.search}` || '/'; } catch (_) { return href || '(no page)'; }
};

export function FeedbackSpace({ boot }) {
  const { slug, version, title, origin, shareUrl, docUrl, bookmarklet, identity, isOwner, canComment, signinUrl } = boot;
  const host = (() => { try { return new URL(origin).host; } catch (_) { return origin; } })();
  const [joined, setJoined] = useState(Boolean(boot.joined));
  const [comments, setComments] = useState(null);
  const [mentionable, setMentionable] = useState([]);
  const [filter, setFilter] = useState('open');
  const [openId, setOpenId] = useState(null);
  const [notice, setNotice] = useState('');
  const [notifyIds, setNotifyIds] = useState(null);
  const [joinBusy, setJoinBusy] = useState(false);
  // Share is the doc's Share dialog (a space is a doc). ?share=1 — the
  // in-app widget's Share — arrives with it open, as on the doc page.
  const [shareOpen, setShareOpen] = useState(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('share') !== '1') return false;
    params.delete('share');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    return true;
  });
  const [move, setMove] = useState(null);
  const canManage = Boolean(boot.ownerManage || boot.teamManage?.canManage);
  const currentTeam = boot.workspaceId || boot.teamManage?.team?.id || null;

  const notify = useNotifyTargets(slug, Boolean(isOwner));
  const canSendToAgent = Boolean(isOwner && notify.ready && notify.available && notify.reason !== 'no_agent_bound'
    && (notify.default || (notify.candidates || []).length || notify.fallback));
  // Replies here use the same @ picker: the owner's agents, as in the document.
  const agentMentions = useMemo(() => (canSendToAgent
    ? { choices: orderedAgentChoices(notify), preselected: notify.default }
    : { choices: [], preselected: null }
  ), [canSendToAgent, notify.default, notify.candidates, notify.fallback]);

  const refresh = useCallback(async () => {
    try {
      const list = await listComments(slug, version);
      setComments(Array.isArray(list) ? list : []);
    } catch (err) {
      setNotice(err.message || 'Could not load comments');
      setComments([]);
    }
  }, [slug, version]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!identity) return;
    listMentionableUsers(slug).then((b) => setMentionable(Array.isArray(b && b.users) ? b.users : [])).catch(() => {});
  }, [slug, identity]);

  const act = async (fn) => {
    try { await fn(); await refresh(); return true; } catch (err) { setNotice(err.message || 'That did not work'); return false; }
  };

  const join = async () => {
    setJoinBusy(true);
    try {
      const r = await fetch('/api/feedback/join', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error((b && b.error) || `HTTP ${r.status}`);
      setJoined(true);
    } catch (err) {
      setNotice(`Could not join: ${err.message}`);
    } finally {
      setJoinBusy(false);
    }
  };

  // Move into a team: the doc page's picker and /api/team/move, unchanged.
  const openMove = async () => {
    setShareOpen(false);
    setMove({ teams: [], loading: true, busy: false, error: '' });
    try {
      const result = await listTeams();
      setMove({ teams: result.teams || [], loading: false, busy: false, error: '' });
    } catch (err) {
      setMove({ teams: [], loading: false, busy: false, error: err.message || 'Could not load workspaces.' });
    }
  };
  const moveTo = async (target) => {
    setMove((m) => ({ ...m, busy: true, error: '' }));
    try {
      await moveDocsToTeam([slug], target.id);
      location.href = `/d/${encodeURIComponent(slug)}?share=1`;
    } catch (err) {
      setMove((m) => ({ ...m, busy: false, error: err.message || 'Could not move this space.' }));
    }
  };

  const live = (comments || []).filter((c) => !c.deleted);
  const shown = live.filter((c) => filter === 'all' || threadPhase(c) === filter);
  const groups = new Map();
  for (const c of shown) {
    const key = (c.anchor && c.anchor.url) || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const ready = summarizeHandoffSurfaces(live).ready;
  const openCount = live.filter((c) => threadPhase(c) === 'open').length;
  const repliedCount = live.filter((c) => threadPhase(c) === 'replied').length;

  return (
    <AgentMentionContext.Provider value={agentMentions}>
    <div className="tdoc-app docs-hub tdoc-fbspace">
      <TopBar identity={identity} />
      <main className="wrap">
        <div className="page-hd">
          <h1>{title}</h1>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Comments left on <a href={origin} target="_blank" rel="noopener noreferrer">{host}</a> · {openCount} open · {repliedCount} replied
        </p>
        <div className="tdoc-fbspace-actions">
          <a className="ui-btn ui-btn-secondary ui-btn-m" href={origin} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> Open the app</a>
          <AppButton id="tdoc-fbspace-share" onClick={() => setShareOpen(true)} title={canManage ? 'Invite people, or move this space into a team' : 'Copy the link to this space'}>
            <Share2 size={14} /> Share
          </AppButton>
          {isOwner && notify.ready && notify.available ? (
            <AppButton variant="primary" className="primary" onClick={() => setNotifyIds(ready.map((c) => c.id))}>
              <Send size={14} /> Send to agent{ready.length ? ` (${ready.length})` : ''}
            </AppButton>
          ) : null}
        </div>


        {!identity ? (
          <section className="tdoc-fbspace-card">
            <p><strong>Sign in to join.</strong> You're invited to leave feedback on {host}; your comments land here, next to everyone else's.</p>
            <a className="ui-btn ui-btn-primary ui-btn-m" href={signinUrl}>Sign in</a>
          </section>
        ) : !joined ? (
          <section className="tdoc-fbspace-card">
            <p><strong>Join to comment on {host}.</strong> Your comments on the app will land in this list.</p>
            <AppButton variant="primary" className="primary" disabled={joinBusy} onClick={join}>{joinBusy ? 'Joining…' : 'Join'}</AppButton>
          </section>
        ) : null}

        {identity && joined ? (
          <details className="tdoc-fbspace-how" open={!isOwner && !live.length}>
            <summary>How to comment on the app</summary>
            <ol>
              <li>Drag this to your bookmarks bar (skip if you have it): <Bookmarklet className="tdoc-fbspace-bm" href={bookmarklet} /> No bar? ⌘⇧B.</li>
              <li>Open <a href={origin} target="_blank" rel="noopener noreferrer">{host}</a> and click the bookmark, then <strong>+ Comment</strong>.</li>
            </ol>
          </details>
        ) : null}

        <div className="tdoc-fbspace-filter">
          <SegmentedControl
            ariaLabel="Show"
            value={filter}
            onChange={setFilter}
            options={[{ value: 'open', label: 'Open' }, { value: 'replied', label: 'Replied' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All' }]}
          />
        </div>

        {notice ? <p className="muted" role="status">{notice}</p> : null}
        {comments === null ? <p className="muted">Loading…</p> : null}
        {comments !== null && !shown.length ? (
          <p className="empty">{filter === 'all' ? 'No comments yet.' : `Nothing ${filter}.`}</p>
        ) : null}

        {[...groups.entries()].map(([url, list]) => (
          <section key={url} className="tdoc-fbspace-group">
            <h2 title={url}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{pathOf(url)}</a> : 'Elsewhere'}</h2>
            <div className="tdoc-fbspace-list">
              {list.map((c) => (
                <CommentCard
                  key={c.id}
                  comment={c}
                  currentUser={(identity && identity.login) || 'anon'}
                  handoffViewer={[(identity && identity.login) || 'anon', ...((identity && identity.linked_actor_keys) || [])]}
                  isOwner={Boolean(isOwner)}
                  mentionable={mentionable}
                  canSendToAgent={canSendToAgent}
                  unanchored={false}
                  selected={openId === c.id}
                  expandReplies={openId === c.id}
                  onActivate={(id) => setOpenId(id)}
                  onReply={async (parentId, text, opts = {}) => {
                    if (!canComment) { setNotice('Join to reply.'); return false; }
                    let made = null;
                    const ok = await act(async () => { made = await createComment({ slug, version, text, parent_id: parentId }); });
                    if (ok && opts.sendToAgent && canSendToAgent) {
                      const target = opts.handoffCommentId || (made && made.id);
                      if (target) await act(() => sendOneCommentToAgent(slug, target, opts.recipient));
                    }
                    return ok;
                  }}
                  onReact={(id, emoji) => act(() => toggleReaction({ slug, version, comment_id: id, emoji }))}
                  onDelete={(id) => act(() => removeComment(slug, version, id))}
                  onResolve={(id, resolved) => act(() => setCommentResolved({ slug, version, id, resolved }))}
                  onEdit={(id, text) => act(() => updateCommentText({ slug, version, id, text }))}
                  onReanchor={() => setNotice('Move a comment from the app: open it there and use Move anchor.')}
                />
              ))}
            </div>
          </section>
        ))}

        <p className="muted tdoc-fbspace-foot"><a href="/me?tab=feedback">All your feedback</a> · <a href={docUrl}>Open as a document</a></p>
      </main>
      {canManage ? (
        <OwnerAccessDialog
          open={shareOpen}
          config={{ slug, ownerManage: boot.ownerManage, teamManage: boot.teamManage }}
          url={shareUrl}
          onOpenChange={setShareOpen}
          onCopied={() => setNotice('Link copied')}
          onMove={isOwner ? openMove : null}
        />
      ) : (
        <ShareDialog
          open={shareOpen}
          url={shareUrl}
          team={boot.teamManage}
          onOpenChange={setShareOpen}
          onCopied={() => { setShareOpen(false); setNotice('Link copied'); }}
        />
      )}
      {move ? (
        <MoveToTeamDialog
          title="Move this feedback space"
          teams={move.teams}
          count={1}
          includePersonal={Boolean(currentTeam)}
          currentTeam={currentTeam}
          loading={move.loading}
          busy={move.busy}
          error={move.error}
          onClose={() => { if (!move.busy) setMove(null); }}
          onMove={moveTo}
        />
      ) : null}
      {notifyIds ? (
        <NotifyHandoffPanel slug={slug} open commentIds={notifyIds} onClose={() => setNotifyIds(null)} onSent={() => refresh()} onTargetsChanged={notify.refresh} />
      ) : null}
    </div>
    </AgentMentionContext.Provider>
  );
}
