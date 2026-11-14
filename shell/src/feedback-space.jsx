import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Send, Share2 } from 'lucide-react';
import { TopBar } from './top-bar.jsx';
import { Bookmarklet } from './feedback-install.jsx';
import { AppButton } from './ui/button.jsx';
import { ShareDialog } from './document/document-dialogs.jsx';
import { OwnerAccessDialog } from './document/owner-access-dialog.jsx';
import { MoveToTeamDialog } from './docs-hub/teams.jsx';
import { CONNECT_AGENT_PROMPT, NotifyHandoffPanel, sendOneCommentToAgent, useNotifyTargets } from './document/notify-handoff.jsx';
import { composerAgents } from './document/ai-answerer.js';
import { composerDefault, maySendToAgent, sendToAgentSetup, sendToAgentState } from './document/agent-choices.js';
import { askOwnAgent, threadAskPick, useMyAgent } from './document/my-agent.js';
import { AgentMentionContext } from './document/mention-field.jsx';
import { CommentPanel } from './comments/panel/comment-panel.jsx';
import { useCommentArea, useCommentListPrefs } from './comments/core/comment-area.js';
import { groupBy } from './comments/core/comment-query.js';
import { useCommentFeed } from './comments/core/use-comment-feed.js';
import { withPostedComment } from './comments/core/posted-comment.js';
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
  // Open by default; the choice remembered per space, as in the widget.
  const listPrefs = useCommentListPrefs(slug);
  const { filter, setFilter } = listPrefs;
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

  const notifyViewer = (identity && (identity.account_id || identity.login)) || '';
  // Who may send: the owner or a member of the space's team (maySendToAgent,
  // the server's rule), as on the doc page and in the widget.
  const sendToAgentMay = maySendToAgent({ owner: isOwner, teamMember: Boolean(boot.teamManage && boot.teamManage.team && !boot.teamManage.guest) });
  const notify = useNotifyTargets(slug, sendToAgentMay, notifyViewer);
  const canSendToAgent = Boolean(sendToAgentMay && notify.ready && notify.available && notify.reason !== 'no_agent_bound'
    && (notify.default || (notify.candidates || []).length || notify.fallback));
  // Anyone else who joined: their OWN agents, which answer in the thread
  // and never edit (my-agent.js), as on a doc page.
  const myAgent = useMyAgent(slug, Boolean(identity && joined && !isOwner));
  // Replies here use the same @ picker as the document: the owner's agents
  // (may edit), else the replier's own and, on a team's space, the team's
  // (answer only, in the thread). No tdoc AI here, and no private answer:
  // nothing on this page shows one.
  const agentChoices = useMemo(() => composerAgents({
    canSendToAgent,
    notifyTargets: notify,
    mine: !isOwner && myAgent.state ? { agents: myAgent.state.agents || [], team_agents: myAgent.state.team_agents || [], tdoc_ai: false } : null,
  }), [canSendToAgent, notify.default, notify.candidates, notify.fallback, isOwner, myAgent.state]);
  // The same Send to agent judgment as the doc page and the widget.
  const { setupHref: sendToAgentSetupHref, disabledReason: sendToAgentDisabledReason } = sendToAgentSetup({
    canSendToAgent, may: sendToAgentMay, targets: notify, href: '/me?view=settings#agents',
  });
  const sendToAgentConnectPrompt = sendToAgentSetupHref ? CONNECT_AGENT_PROMPT : null;
  const sendToAgent = useMemo(() => sendToAgentState({
    canSendToAgent,
    choices: agentChoices,
    disabledReason: sendToAgentDisabledReason,
    connectPrompt: sendToAgentConnectPrompt,
    setupHref: sendToAgentSetupHref,
  }), [canSendToAgent, agentChoices, sendToAgentDisabledReason, sendToAgentConnectPrompt, sendToAgentSetupHref]);
  const agentMentions = useMemo(() => ({
    choices: agentChoices,
    preselected: canSendToAgent ? composerDefault(agentChoices, { orTop: true }) : null,
    privateAskSupported: false,
    fixesTheApp: true,
    canSendToAgent,
    sendToAgentDisabledReason,
    connectAgentPrompt: sendToAgentConnectPrompt,
    agentSetupHref: sendToAgentSetupHref,
    sendToAgent,
  }), [agentChoices, canSendToAgent, sendToAgentDisabledReason, sendToAgentConnectPrompt, sendToAgentSetupHref, sendToAgent]);

  // Which threads this tab shows: the same area the doc page and the widget
  // use, so a card being typed in stays put the same way everywhere.
  const viewerKeys = useMemo(() => [(identity && identity.login) || 'anon', ...((identity && identity.linked_actor_keys) || [])], [identity]);
  // Read state too: a reply read in the widget is read here (the server
  // keeps it per person), and the reverse.
  const area = useCommentArea({
    comments: comments || [], slug, selectedId: openId, filter, sort: listPrefs.sort, search: listPrefs.search,
    handoffViewer: viewerKeys, isOwner: Boolean(isOwner), syncSeen: Boolean(identity),
  });

  const refresh = useCallback(async () => {
    try {
      const list = await listComments(slug, version);
      setComments(Array.isArray(list) ? list : []);
    } catch (err) {
      setNotice(err.message || 'Could not load comments');
      setComments((prev) => prev || []);
    }
  }, [slug, version]);

  useEffect(() => { refresh(); }, [refresh]);
  // Kept current like the doc page and the widget (use-comment-feed.js).
  const feed = useCommentFeed({ load: refresh, enabled: comments !== null });
  // An answer from the replier's agent arrives as a reply: read the list
  // again when one of their questions here is answered.
  const answered = (myAgent.state?.asks || []).filter((a) => a.answer).length;
  useEffect(() => { if (answered) refresh(); }, [answered]);
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
      if (!r.ok) throw new Error((b && (b.message || b.error)) || `HTTP ${r.status}`);
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
  const shown = area.shown;
  const ready = area.handoffBuckets.ready;

  return (
    <AgentMentionContext.Provider value={agentMentions}>
    <div className="tdoc-app docs-hub tdoc-fbspace">
      {/* The space's workspace, as on a doc page: a team's space shows the
          team in the switcher, not whatever space was open last. */}
      <TopBar identity={identity} space={boot.teamManage?.team?.id || ''} currentTeam={boot.teamManage?.team || null} />
      <main className="wrap">
        <div className="page-hd">
          <h1>{title}</h1>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Comments left on <a href={origin} target="_blank" rel="noopener noreferrer">{host}</a>
          {boot.teamManage?.team && !boot.teamManage.guest ? <> · <span className="tdoc-fbspace-team">In <a href={`/me?team=${encodeURIComponent(boot.teamManage.team.id)}&view=comments`}>{boot.teamManage.team.name}</a></span></> : null}
          {' '}· {area.openCount} open · {area.waitingCount} waiting on you
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
        ) : !joined && boot.canJoin === false ? (
          <section className="tdoc-fbspace-card">
            <p><strong>Not invited to this space.</strong> Your comments on {host} go to your own space. To comment here from the app, ask its owner to invite you in Share.</p>
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

        {notice ? <p className="muted" role="status">{notice}</p> : null}
        {comments === null ? <p className="muted">Loading…</p> : (
          // The same list as the widget and the doc page (comments/panel/),
          // grouped by the app page each thread was left on.
          <CommentPanel
            area={area}
            prefs={listPrefs}
            className="tdoc-cpanel-inline tdoc-fbspace-list"
            ariaLabel="Comments on the app"
            title="Comments"
            onRefresh={feed.refresh}
            refreshing={feed.refreshing}
            groups={groupBy(shown, (c) => (c.anchor && c.anchor.url) || '').map(({ key, items }) => ({
              key, items, title: key || undefined, href: key || undefined, label: key ? pathOf(key) : 'Elsewhere',
            }))}
            empty={<p className="tdoc-cpanel-empty">{filter === 'all' ? 'No comments yet.' : `Nothing ${filter}.`}</p>}
            selectedId={openId}
            onNavigate={(id) => setOpenId(id)}
            cardProps={{
              currentUser: (identity && identity.login) || 'anon',
              handoffViewer: viewerKeys,
              isOwner: Boolean(isOwner),
              mentionable,
              canSendToAgent,
              onMarkRead: area.markRead,
              onReply: async (parentId, text, opts = {}) => {
                if (!canComment) { setNotice('Join to reply.'); return false; }
                let made = null;
                try {
                  made = await createComment({ slug, version, text, parent_id: parentId });
                } catch (err) {
                  setNotice(err.message || 'That did not work');
                  return false;
                }
                // Posted: it shows now (comments/core/posted-comment.js) and
                // the reply box is done. The re-read and an agent hand-off
                // follow on their own and report through the notice.
                setComments((prev) => withPostedComment(prev || [], made, parentId));
                (async () => {
                  if (opts.sendToAgent && canSendToAgent) {
                    const target = opts.handoffCommentId || (made && made.id);
                    if (target) await act(() => sendOneCommentToAgent(slug, target, opts.recipient));
                  } else {
                    await refresh();
                  }
                  // Their own agent (or their team's) answers the reply they
                  // just wrote (only a comment of theirs may ask it).
                  const own = threadAskPick(opts);
                  if (own && made && made.id) {
                    const sent = await askOwnAgent(slug, made.id, own);
                    if (sent.ask) myAgent.addAsk(sent.ask);
                    setNotice(sent.message);
                  }
                })().catch((err) => setNotice((err && err.message) || 'Posted; could not refresh the list'));
                return true;
              },
              onReact: (id, emoji) => act(() => toggleReaction({ slug, version, comment_id: id, emoji })),
              onDelete: (id) => act(() => removeComment(slug, version, id)),
              onResolve: (id, resolved) => act(() => setCommentResolved({ slug, version, id, resolved })),
              onEdit: (id, text) => act(() => updateCommentText({ slug, version, id, text })),
              onReanchor: () => setNotice('Move a comment from the app: open it there and use Move anchor.'),
            }}
          />
        )}

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
        <NotifyHandoffPanel slug={slug} open commentIds={notifyIds} onClose={() => setNotifyIds(null)} onSent={() => refresh()} onTargetsChanged={notify.refresh} viewer={notifyViewer} />
      ) : null}
    </div>
    </AgentMentionContext.Provider>
  );
}
