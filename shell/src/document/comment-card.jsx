import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ProviderMark } from './notify-handoff.jsx';
import { COPY_FALLBACK } from '../onboarding-copy.js';
import { Check, ChevronRight, MoreHorizontal, SmilePlus } from 'lucide-react';
import { SuggestContext } from './suggestions.js';
import { Popover } from '@base-ui/react/popover';
import { PreviewCard } from '@base-ui/react/preview-card';
import { AppMenu, AppMenuItem } from '../ui/menu.jsx';
import { usePortalContainer } from '../ui/portal.js';
import { CopyPromptButton } from '../ui/copy-prompt-button.jsx';
import { AgentButtonsContext, AgentMentionContext, MentionField, MentionText } from './mention-field.jsx';
import { agentFacts, agentName, agentOwner } from './agent-choices.js';
import { AgentAskRow, AskOnlyToggle, PrivateAnswer, SendToAgentToggle, agentAskHint, useAgentAsk } from './agent-ask.jsx';
import { agentForThread, targetKey } from './agent-choices.js';
import { freeLeftText, isOwnTdocAiReply, joinAiTags, mentionsAi } from './ai-answerer.js';
import { avatarFor, avatarInitial, QUICK_REACTIONS, tdocUrl } from './model.js';
import { AuthorFace } from './author-face.jsx';
import { HandoffStatusChips } from './handoff-status-line.jsx';
import { canSeeHandoff } from '../comments/core/handoff-state.js';
import { productPageUrl } from './product-url.js';
import { observeVisibleRead } from '../comments/core/visible-read.js';
import { clearReplyDraft, readReplyDraft, writeReplyDraft } from './reply-draft.js';

const AUTHOR_FACE_SIZE = { width: 24, height: 24, maxWidth: 24, maxHeight: 24 };

export function authorLine(author) {
  if (!author) return 'anonymous';
  if (author.kind === 'agent') {
    // Brand stays on the avatar; the text line is name · owner, the owner
    // being the account whose token posted it (stamped by the server).
    if (agentOwner(author)) return `${agentName(author)} · ${agentOwner(author)}`;
    // Older replies, from before the owner was stamped: handle · principal.
    const handle = author.handle || null;
    const principal = author.principal?.display || null;
    if (handle && principal) return `${handle} · ${principal}`;
    if (principal) return principal;
    if (handle) return handle;
  }
  return author.name || (author.login ? replyName(author) : 'anonymous');
}

// An agent's name with the five facts behind it on hover: name, who it acts
// for, program, where it runs, and scope. Only for replies that carry an
// owner; older ones keep their plain line.
function AgentAuthorName({ author }) {
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger render={<span className="login tdoc-agent-name" tabIndex={0} />} delay={300}>
        {authorLine(author)}
      </PreviewCard.Trigger>
      <PreviewCard.Portal container={usePortalContainer()}>
        <PreviewCard.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8}
          positionMethod="fixed" className="tdoc-picker-positioner">
          <PreviewCard.Popup className="tdoc-agent-card">
            <dl>
              {agentFacts(author).map((f) => (
                <React.Fragment key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></React.Fragment>
              ))}
            </dl>
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

export function Author({ author, timestamp }) {
  if (!author) {
    return (
      <div className="author">
        <span className="tdoc-cc-who">
          <span className="anon">anonymous</span>
          {timestamp ? <span className="tdoc-cc-when">{timestamp}</span> : null}
        </span>
      </div>
    );
  }

  const avatar = avatarFor(author);
  const initial = <span className="tdoc-avatar-fallback" aria-hidden="true">{avatarInitial(author)}</span>;
  const providerAvatar = author.kind === 'agent' && author.provider;
  const profileUrl = author.kind !== 'agent' && author.kind !== 'system'
    && /^\/@[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(author.profile_url || '')
    ? tdocUrl(author.profile_url) : null;
  // In the feedback widget the profile is on tdoc, not on the app it sits in.
  const profileElsewhere = profileUrl && !profileUrl.startsWith('/');
  const hoverCard = author.kind === 'agent' && !!agentOwner(author);
  const title = author.kind === 'agent' && !hoverCard && author.principal?.terminal
    ? author.principal.terminal
    : undefined;
  return (
    <div className={`author${author.kind === 'agent' ? ' tdoc-agent-author' : ''}`} title={title}>
      {providerAvatar ? (
        <span className="tdoc-agent-provider-mark" aria-hidden="true">
          <ProviderMark target={author} size={18} />
        </span>
      ) : avatar && profileUrl ? (
        <a className="tdoc-author-profile" href={profileUrl}
          {...(profileElsewhere ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          aria-label={`View ${authorLine(author)}'s public profile`}
          title={`View ${authorLine(author)}'s public profile`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}>
          <AuthorFace src={avatar} style={AUTHOR_FACE_SIZE} fallback={initial} />
        </a>
      ) : <AuthorFace src={avatar} style={AUTHOR_FACE_SIZE} fallback={initial} />}
      <span className="tdoc-cc-who">
        {hoverCard ? <AgentAuthorName author={author} /> : <span className="login">{authorLine(author)}</span>}
        {timestamp ? <span className="tdoc-cc-when">{timestamp}</span> : null}
      </span>
    </div>
  );
}

// The same safe body is used by comments, replies, and private Ask AI turns.
export function CommentMessageText({ text, mentions = [] }) {
  return <div className="text"><MentionText text={text} mentions={mentions} /></div>;
}

export function ReplyMessage({ author, text, mentions = [] }) {
  return <><Author author={author} /><CommentMessageText text={text} mentions={mentions} /></>;
}

function ReactionPicker({ onPick }) {
  return (
    <Popover.Root>
      <Popover.Trigger className="tdoc-react-add" title="Add reaction">
        <SmilePlus size={14} />
      </Popover.Trigger>
      <Popover.Portal container={usePortalContainer()}>
        {/* Legacy placement: under the button, left edges aligned, flipped or
            shifted to stay on screen. positionMethod="fixed" because the card
            it opens from is itself fixed to the viewport. */}
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          positionMethod="fixed"
          className="tdoc-picker-positioner"
        >
          <Popover.Popup className="tdoc-emoji-picker react-picker">
            {QUICK_REACTIONS.map((emoji) => (
              <Popover.Close
                key={emoji}
                className={emoji === 'LGTM' ? 'tdoc-emoji-text' : undefined}
                data-emoji={emoji}
                onClick={() => onPick(emoji)}
              >
                {emoji}
              </Popover.Close>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Reactions({ item, me, onReact }) {
  const reactions = Object.entries(item.reactions || {})
    .filter(([, users]) => users?.length);

  return (
    <div className="tdoc-reactions" data-target-id={item.id}>
      {reactions.map(([emoji, users]) => (
        <button
          key={emoji}
          type="button"
          className={[
            'tdoc-react-chip',
            users.includes(me) ? 'mine' : '',
            users.some((user) => /agent|codex|claude/i.test(user)) ? 'agent' : '',
          ].filter(Boolean).join(' ')}
          onClick={() => onReact(item.id, emoji)}
        >
          <span className="tdoc-emoji">{emoji}</span> {users.length}
        </button>
      ))}
      <ReactionPicker onPick={(emoji) => onReact(item.id, emoji)} />
    </div>
  );
}

function ReplyForm({
  commentId,
  handoffCommentId,
  thread = null,
  account = 'anon',
  // False for a box that reopened itself on a saved draft in a list: it should
  // not take the caret (or raise a phone's keyboard) from whatever is going on.
  takeFocus = true,
  onReply,
  replyingTo,
  mentionable,
  demo = false,
  canSendToAgent = false,
  // Owner with no agent connected: @agent stays visible and leads to setup.
  agentSetupHref = null,
}) {
  // One draft per thread, kept outside this form (reply-draft.js): it survives
  // the card leaving the screen, and moves with the form between replies.
  const threadId = thread?.id || handoffCommentId || commentId;
  const [saved] = useState(() => readReplyDraft(threadId, account));
  const [text, setText] = useState(saved?.text || '');
  // One submit at a time, same as the comment composer: ⌘+Enter and the
  // button share the lock, so a second press while the first reply is still
  // in flight does not post a twin.
  const [busy, setBusy] = useState(false);
  const agentButtons = useContext(AgentButtonsContext);
  // The same @agent as the new-comment composer (agent-ask.jsx): the button
  // that puts the default agent's pill in, the pill's dropdown, Only me. The
  // feedback overlay keeps its own @agent buttons (AgentButtonsContext).
  const field = useRef(null);
  const ask = useAgentAsk(text, setText, field);
  const { agents, target } = ask;
  const v4 = !agentButtons && !demo;
  // Answering an agent: the box starts with its tag, as if picked after @, for
  // everybody on every surface, editing agents included (Julie, 2026-11-06: she
  // knows a plain handoff can publish without review). Who counts is
  // agentForThread's rule: the latest reply is this viewer's own agent, and this
  // box answers it. Once per draft, and only into a box nobody has touched: the
  // list can load late, and a tag someone deleted stays deleted. The tag alone
  // is not a reply: nothing was written yet.
  const touched = useRef(Boolean(saved));
  const prefilled = useRef(saved?.prefilled || '');
  const answering = v4 ? agentForThread(thread, ask.choices, commentId) : null;
  const answeringKey = answering ? targetKey(answering) : '';
  useLayoutEffect(() => {
    if (!answering || touched.current || prefilled.current || text) return;
    prefilled.current = ask.putAgent(answering);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answeringKey]);
  // The text is the draft, unless it is only the tag the box started with.
  useEffect(() => {
    const words = text.trim() && text.trim() !== prefilled.current.trim() ? text : '';
    writeReplyDraft(threadId, account, words ? { text: words, parentId: commentId, prefilled: prefilled.current } : null);
  }, [text, commentId, threadId, account]);
  // Reopened on a draft: the caret goes to the end of it.
  useLayoutEffect(() => {
    const box = field.current;
    if (saved?.text && box && takeFocus) box.setSelectionRange(box.value.length, box.value.length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // An "Only me" question asked from this reply box: its answer shows here.
  const privateAsk = agents.privateReply && agents.privateReply.parentId === commentId ? agents.privateReply : null;
  // Asked: the question has gone, so the box it came from starts empty.
  useEffect(() => { if (privateAsk) setText(''); }, [Boolean(privateAsk)]);

  const submit = async (sendToAgent = false) => {
    if (busy || !text.trim()) return;
    if (prefilled.current && text.trim() === prefilled.current.trim()) return;
    if (sendToAgent && v4 && !target && !agents.preselected) { ask.putDefault(); return; }
    setBusy(true);
    const sent = text;
    try {
      let opts;
      let body = text;
      if (v4) {
        // ⌘⇧Enter puts the default agent in, then sends. A named agent that
        // may edit gets the thread to answer or change; one that may not (or
        // Ask only, or Only me) answers only, under this reply or to the asker
        // alone.
        const out = ask.outgoing(sendToAgent);
        body = out.text;
        const recipient = canSendToAgent && out.target && !out.askOnly ? out.target : null;
        opts = { sendToAgent: Boolean(recipient), recipient, target: out.target, askOnly: out.askOnly, onlyMe: out.onlyMe };
      } else {
        opts = { sendToAgent: canSendToAgent && sendToAgent, recipient: null, target: null, askOnly: false, onlyMe: false };
      }
      // onReply resolves false when the shell reported a failure; keep the draft.
      const ok = await onReply(commentId, opts.target || mentionsAi(body) ? joinAiTags(body) : body, {
        ...opts,
        handoffCommentId: handoffCommentId || commentId,
      });
      if (ok !== false) {
        // Words typed while it was on their way stay, as a draft.
        clearReplyDraft(threadId, account, sent);
        setText((current) => (current === sent ? '' : current));
      }
    } finally { setBusy(false); }
  };

  if (privateAsk) {
    return (
      <div className="tdoc-reply-form open tdoc-private-ask" data-parent-id={commentId}>
        {replyingTo ? <div className="tdoc-reply-to">Replying to @{replyingTo}</div> : null}
        <PrivateAnswer privateAsk={privateAsk} onMakePublic={agents.onMakePublic} onClose={agents.onClosePrivate} submitClassName="tdoc-reply-submit" />
      </div>
    );
  }

  return (
    <div className="tdoc-reply-form open" data-parent-id={commentId}>
      {replyingTo ? <div className="tdoc-reply-to">Replying to @{replyingTo}</div> : null}
      <MentionField
        // The box you asked for is the box you want to type in. Without this,
        // clicking Reply put a composer on screen and left the caret wherever
        // it was, so the first thing you do is click the thing you just opened.
        autoFocus={takeFocus}
        fieldRef={field}
        placeholder={demo ? 'Reply… GitHub @ or @email'
          : v4 && (agents.choices || []).length ? 'Reply, or type @ to ask an agent' : 'Reply… (@ to notify someone)'}
        value={text}
        people={mentionable}
        replacesTag={prefilled.current}
        onChange={(next) => { touched.current = true; setText(next); }}
        onSubmit={({ sendToAgent } = {}) => submit(Boolean(sendToAgent))}
      />
      {v4 ? <AgentAskRow ask={ask} hint={agentAskHint(ask)} /> : null}
      <div className="tdoc-reply-form-foot">
        <span className="hint tdoc-keyboard-shortcut-hint">
          {canSendToAgent && agentButtons ? '⌘+Enter · ⌘⇧+Enter @agent' : ''}
        </span>
        <div className="tdoc-reply-form-actions">
          {v4 || agentButtons ? <SendToAgentToggle ask={ask} busy={busy} className="tdoc-reply-submit agent tdoc-reply-agent tdoc-send-agent-toggle ui-btn ui-btn-secondary ui-btn-m" /> : null}
          {v4 ? <AskOnlyToggle ask={ask} busy={busy} /> : null}
          <button className="tdoc-reply-submit ui-btn ui-btn-primary ui-btn-m" type="button" onClick={() => submit(false)} disabled={busy}>
            {busy ? 'Posting…' : 'Reply'}
          </button>
        </div>
      </div>
    </div>
  );
}

// An inline rewrite of a comment or reply that is already on screen. Opens
// seeded with the current text — an edit is a correction, not a re-draft — and
// leaves the card untouched when the text comes back unchanged.
function EditForm({ item, onSave, onCancel }) {
  const [text, setText] = useState(item.text || '');
  const boxRef = useRef(null);

  // Open at the END of what is already written. autoFocus alone leaves the
  // caret in front of your own sentence, so the first keystroke lands before
  // the first word — an edit is a correction, and you carry on from where the
  // text stopped.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, []);

  const submit = async () => {
    const next = text.trim();
    if (!next || next === item.text) return onCancel();
    // onSave resolves false when the shell reported a failure; keep the draft.
    if (await onSave(item.id, next) !== false) onCancel();
    return undefined;
  };

  return (
    <div className="tdoc-edit-form open" data-comment-id={item.id}>
      <textarea
        ref={boxRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit();
          if (event.key === 'Escape') onCancel();
        }}
      />
      <div className="tdoc-edit-form-foot">
        <button className="tdoc-edit-cancel ui-btn ui-btn-quiet ui-btn-m" type="button" onClick={onCancel}>Cancel</button>
        <button className="tdoc-edit-save ui-btn ui-btn-primary ui-btn-m" type="button" onClick={submit}>Save</button>
      </div>
    </div>
  );
}

// Your own words: what you may edit, and what you may delete. Deliberately
// narrower than mayMutate below, which also grants the doc owner — neither
// rewriting nor removing somebody else's comment is a power owning the
// document confers. The worker enforces the same rule on PATCH and DELETE,
// and this keeps the buttons from rendering where they would 403.
// Under a tdoc AI answer, for the person who asked and nobody else: one muted
// line with what is left of the free answers and the way to unlimited ones.
function TdocAiQuota({ reply, currentUser }) {
  const { ai } = useContext(AgentMentionContext);
  if (!isOwnTdocAiReply(reply, currentUser)) return null;
  // Only when few are left: the allowance is large (freeLeftText).
  const left = freeLeftText(ai && ai.remaining);
  return (
    <div className="tdoc-ai-quota">
      {left ? <>tdoc AI · {left} · <a href={tdocUrl('/start')}>Connect your agent for unlimited</a></> : 'tdoc AI'}
    </div>
  );
}

// Whoever answers Ask AI is writing an answer somewhere in this thread.
function AiAnswering({ ids }) {
  const { ai } = useContext(AgentMentionContext);
  if (!ai || !ai.thinking || !ids.has(ai.thinking.id)) return null;
  return <div className="tdoc-ai-quota tdoc-ai-answering" aria-live="polite">{ai.thinking.label} is answering…</div>;
}

function authoredBy(item, currentUser) {
  return Boolean(
    currentUser
    && currentUser !== 'anon'
    && item.author?.login
    && item.author.login === currentUser,
  );
}

// Mirrors the worker's mayDelete(): your own words, plus — for the doc owner —
// an agent's, because /api/agent/reply runs on the owner's upload token. The
// agent is the owner writing through a tool, not a third party with speech of
// its own. Editing stays authoredBy: nobody rewrites what the agent said.
function mayDelete(item, currentUser, isOwner) {
  return authoredBy(item, currentUser) || (isOwner && item.author?.kind === 'agent');
}

// Mirrors the worker's canMutate(): resolving and re-anchoring are the
// author's or the doc owner's, nobody else's. Without this the buttons
// rendered for every reader and the server's 403 (`not_author`) was the only
// thing stopping them — a toast where there should have been no affordance at
// all. Delete used to share this gate; it is authoredBy's now.
//   - isOwner is the worker's isDocOwnerSession(), sent as is: the doc's
//     owner, or for a team doc the team's admins, or a feedback space's owner.
//   - the author is matched like actorKeys(session): case-insensitive, and
//     against every key the viewer is known by (handoffViewer carries the
//     linked ones). An exact compare on one login hid ✓ from an author who
//     signed in with the other half of a linked account (Julie, 2026-10-27).
export function mayMutate(item, currentUser, isOwner, viewerKeys = []) {
  const who = String(item.author?.login || '').trim().toLowerCase();
  if (isOwner) return true;
  if (!who) return false;
  return [currentUser, ...[].concat(viewerKeys || [])]
    .some((key) => key && key !== 'anon' && String(key).trim().toLowerCase() === who);
}

function hasReactions(item) {
  return Object.values(item.reactions || {}).some((users) => users?.length);
}

// "· edited" rather than a second timestamp: which words changed matters, the
// minute they changed at does not.
function editedSuffix(item) {
  return item.edited ? ' · edited' : '';
}

// One formatter for the page: a phone drawer formats every comment and reply
// on each open, and toLocaleString builds a new Intl.DateTimeFormat per call.
let createdFormat = null;
function formatCreated(created) {
  if (!created) return '';
  const date = new Date(created);
  if (Number.isNaN(date.getTime())) return date.toLocaleString();
  createdFormat ||= new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return createdFormat.format(date);
}

// A reply's parent is another comment id: the thread root when parent_id is
// absent (every reply written before threads nested) or another reply when the
// conversation went deeper. The server has always stored the chain — see the
// `reply_added` fold, which defaults parent_id to the root comment.
function childrenOf(replies, parentId, rootId) {
  return replies.filter((reply) => (reply.parent_id || rootId) === parentId);
}

// Everything hanging off a reply, at any depth, in thread order. A thread reads
// as one flat list, as in Google Docs (Julie, 2026-11-03): every reply flush with
// the top comment, however deep the chain; who a reply answers is said where the
// row above is not it.
function descendantsOf(replies, parentId, rootId) {
  const out = [];
  for (const kid of childrenOf(replies, parentId, rootId)) {
    out.push(kid);
    out.push(...descendantsOf(replies, kid.id, rootId));
  }
  return out;
}

// The name in "Replying to @…": a GitHub login, else the display name. An
// email account's key is an address (or, for other readers, an alias), and
// neither belongs on screen.
function replyName(author) {
  const login = String(author?.login || '');
  if (login && login !== 'email-hidden' && !login.includes(':') && !login.includes('@')) return login;
  return String(author?.name || '').split('@')[0] || 'someone';
}

// Who a reply is answering, for the line a flattened reply carries in place of
// the indentation it lost.
function answers(replies, reply, rootComment) {
  const parent = reply.parent_id === rootComment.id || !reply.parent_id
    ? rootComment
    : replies.find((other) => other.id === reply.parent_id) || rootComment;
  return replyName(parent.author);
}

// A comment or reply whose text was taken down but whose slot still holds a
// thread together (#354). Everything that acts on the words is gone with them
// — no reply, no react, no delete, no re-anchor — but the name and the place
// stay, so the answers under it still read as answers to someone.
function Tombstone({ item, children }) {
  return (
    <>
      <Author author={item.author} />
      <div className="text tdoc-deleted-text">Comment deleted</div>
      <div className="meta">
        <span>{formatCreated(item.created)}</span>
      </div>
      {children}
    </>
  );
}

// A reply carries the same affordances as the comment it hangs under: react,
// reply, and delete-your-own. Between the overlay rewrite and the React port
// these were "deferred", which left every answer in a thread a dead end.
function ReplyCard({
  reply,
  replies,
  rootId,
  rootComment,
  saysWhoItAnswers = false,
  currentUser,
  isOwner,
  mentionable,
  demo = false,
  canSendToAgent = false,
  // Owner with no agent connected: @agent stays visible and leads to setup.
  agentSetupHref = null,
  replyTarget,
  onReplyTarget,
  // The floating card holds the box at its foot, whichever reply it answers.
  formHere = true,
  takeFocus = true,
  editTarget,
  onEditTarget,
  onReply,
  onReact,
  onDelete,
  onEdit,
}) {
  const reacted = hasReactions(reply);
  const author = replyName(reply.author);

  if (reply.deleted) {
    return (
      <div className="tdoc-reply tdoc-deleted" data-comment-id={reply.id}>
        <Tombstone item={reply} />
      </div>
    );
  }

  return (
    <div className="tdoc-reply" data-comment-id={reply.id}>
      {saysWhoItAnswers ? (
        <div className="tdoc-reply-to">Replying to @{answers(replies, reply, rootComment)}</div>
      ) : null}
      {editTarget === reply.id ? (
        <><Author author={reply.author} /><EditForm item={reply} onSave={onEdit} onCancel={() => onEditTarget(null)} /></>
      ) : (
        <ReplyMessage author={reply.author} text={reply.text} mentions={reply.mentions} />
      )}
      <TdocAiQuota reply={reply} currentUser={currentUser} />
      {reacted ? <Reactions item={reply} me={currentUser} onReact={onReact} /> : null}

      <div className="meta">
        <span>{formatCreated(reply.created)}{editedSuffix(reply)}</span>
        <span className="actions">
          {reacted ? null : (
            <ReactionPicker onPick={(emoji) => onReact(reply.id, emoji)} />
          )}
          <button
            type="button"
            className="tdoc-reply-toggle"
            onClick={() => onReplyTarget(replyTarget === reply.id ? null : reply.id)}
          >
            reply
          </button>
          {authoredBy(reply, currentUser) ? (
            <button
              type="button"
              className="tdoc-edit-toggle"
              onClick={() => onEditTarget(editTarget === reply.id ? null : reply.id)}
            >
              edit
            </button>
          ) : null}
          {mayDelete(reply, currentUser, isOwner) ? (
            <button type="button" className="del" onClick={() => onDelete(reply.id)}>
              delete
            </button>
          ) : null}
        </span>
      </div>

      {replyTarget === reply.id && formHere ? (
        <ReplyForm
          commentId={reply.id}
          handoffCommentId={rootId}
          thread={rootComment}
          account={currentUser}
          takeFocus={takeFocus}
          onReply={onReply}
          replyingTo={author}
          mentionable={mentionable}
          demo={demo}
          canSendToAgent={canSendToAgent}
            agentSetupHref={agentSetupHref}
        />
      ) : null}
    </div>
  );
}

// A comment left on an app (feedback overlay) points at a page and an element
// of that app, not at anything in this document. Without this line the card,
// seen on the doc page, says what is wrong but not where.
function ProductWhere({ anchor, origin }) {
  if (!anchor || anchor.kind !== 'product' || !anchor.url) return null;
  const webUrl = productPageUrl(anchor.url);
  const safeUrl = productPageUrl(anchor.url, origin);
  let path = webUrl ? 'Page outside this site' : 'Invalid page link';
  if (safeUrl) { const u = new URL(safeUrl); path = `${u.host}${u.pathname}${u.search}`; }
  const text = String(anchor.text || '').trim();
  // An area (a box dragged on the app) says so, with what was under it.
  // Inside a tdoc doc (the widget on tdoc's own doc page, anchor.frame):
  // its label is the words, the box or the element picked in the doc.
  const what = anchor.region || anchor.frame ? (anchor.label || 'Area') : anchor.accessible_name || (text ? `${anchor.tag || 'element'} “${text.slice(0, 40)}${text.length > 40 ? '…' : ''}”` : anchor.tag || '');
  const st = anchor.state || {};
  const inState = [
    st.dialog ? `in dialog “${st.dialog}”` : (st.layer ? `in “${st.layer}”` : ''),
    st.tabs && st.tabs.length ? `tab ${st.tabs.join(' › ')}` : '',
  ].filter(Boolean).join(' · ');
  const label = <>{path}{inState ? ` · ${inState}` : ''}{what ? ` · ${what}` : ''}</>;
  return safeUrl
    ? <a className="tdoc-product-where" href={safeUrl} target="_blank" rel="noopener noreferrer" title={safeUrl}>{label}</a>
    : <span className="tdoc-product-where">{label}</span>;
}

// The version the doc page shows (version history). A comment that lost its
// place and was written on an older version says so: its text is gone from
// this one, which is why it sits apart. Surfaces without versions (the
// feedback overlay) provide nothing and the line never shows.
export const CommentDocVersionContext = createContext(null);

export function CommentCard({
  comment,
  currentUser,
  // The agent progress line (flag agentProgress); undefined reads the flag
  // on tdoc's own origin, the feedback widget passes its session's answer.
  progressLine,
  handoffViewer = currentUser,
  isOwner = false,
  mentionable = [],
  demo = false,
  unanchored,
  floating = false,
  position,
  expandReplies = false,
  selected = false,
  unread = false,
  onMarkRead = null,
  onSeen = null,
  productLinkOrigin = null,
  canSendToAgent = false,
  // Owner with no agent connected: @agent stays visible and leads to setup.
  agentSetupHref = null,
  onActivate,
  onReply,
  onReact,
  onDelete,
  onResolve,
  onEdit,
  onReanchor,
  // Bridge 2, on the owner's own doc: { line, state, onCopy }. Shown under
  // every thread the agent has not answered yet — one paste covers them all.
  handoff = null,
  // The owner's way out of a handoff nobody picked up (handoff-status-line).
  onResendHandoff = null,
  onSendHandoffElsewhere = null,
}) {
  // A thread with a saved reply opens with its box and its words back in it.
  const [savedDraft] = useState(() => (comment.deleted ? null : readReplyDraft(comment.id, currentUser)));
  const savedParent = savedDraft && (comment.replies || []).some((r) => r.id === savedDraft.parentId && !r.deleted)
    ? savedDraft.parentId : savedDraft && comment.id;
  const [repliesOpen, setRepliesOpen] = useState(expandReplies || Boolean(savedDraft && savedParent !== comment.id));
  // A thread that asked AI opens its replies, so the answer is in view when
  // it lands.
  const { ai: asking } = useContext(AgentMentionContext);
  // Ask/Edit v2 (flag askEditV2): the way from an open comment to the edit an
  // agent suggested for it. Nothing to review, nothing here.
  const suggest = useContext(SuggestContext);
  const canReview = Boolean(suggest?.enabled) && !comment.resolved && comment.status !== 'applied' && !comment.deleted
    && suggest.pendingFor(comment.id);
  const docVersion = useContext(CommentDocVersionContext);
  const earlierVersion = Boolean(unanchored && docVersion && comment.anchor?.kind !== 'document'
    && Number(comment.created_in) > 0 && Number(comment.created_in) < Number(docVersion));
  const thinkingId = asking?.thinking?.id;
  const askingHere = Boolean(thinkingId) && (thinkingId === comment.id || (comment.replies || []).some((r) => r.id === thinkingId));
  useEffect(() => { if (askingHere) setRepliesOpen(true); }, [askingHere]);
  const [replyTarget, setReplyTargetNow] = useState(savedParent || null);
  // Restored rather than asked for: see ReplyForm's takeFocus.
  const reopenedBox = useRef(Boolean(savedDraft));
  const setReplyTarget = (next) => { reopenedBox.current = false; setReplyTargetNow(next); };
  // One record at a time is being rewritten — this card's comment or any reply
  // under it — the same way one reply form is open at a time.
  const [editTarget, setEditTarget] = useState(null);
  const cardRef = useRef(null);
  const onSeenRef = useRef(onSeen);
  const commentRef = useRef(comment);
  onSeenRef.current = onSeen;
  commentRef.current = comment;
  useEffect(() => {
    if (!unread || !onSeen || !cardRef.current) return undefined;
    return observeVisibleRead(cardRef.current, () => onSeenRef.current?.(commentRef.current));
  }, [comment.id, unread, Boolean(onSeen)]);
  // The floating card fits the screen and scrolls inside, with the reply box
  // held at its foot. Measured rather than left to the stylesheet: it starts
  // where its anchor is, and an on-screen keyboard shrinks only the visual
  // viewport, which no vh unit follows.
  const [fit, setFit] = useState(null);
  const anchorTop = position?.top;
  useLayoutEffect(() => {
    if (!floating || anchorTop === undefined || !cardRef.current) return undefined;
    const view = window.visualViewport;
    const measure = () => {
      const card = cardRef.current;
      if (!card) return;
      const height = view ? view.height : window.innerHeight;
      const offset = view ? view.offsetTop : 0;
      // Under the document bar, unless a keyboard has taken the room for it.
      const floor = offset + (height < window.innerHeight - 100 ? 8 : 52);
      const maxHeight = Math.max(160, offset + height - 8 - floor);
      const top = Math.max(floor, Math.min(anchorTop, offset + height - 8 - Math.min(card.offsetHeight, maxHeight)));
      setFit((cur) => (cur && cur.top === top && cur.maxHeight === maxHeight ? cur : { top, maxHeight }));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(cardRef.current);
    window.addEventListener('resize', measure);
    view?.addEventListener('resize', measure);
    view?.addEventListener('scroll', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      view?.removeEventListener('resize', measure);
      view?.removeEventListener('scroll', measure);
    };
  }, [floating, anchorTop]);
  const floatingStyle = floating ? { ...position, top: fit?.top ?? anchorTop, maxHeight: fit?.maxHeight } : undefined;

  // A posted reply closes the composer it came from and opens the thread it
  // landed in. Before, the form stayed on screen under a collapsed "N replies"
  // fold: the reply was saved, nothing visibly changed, and only a page
  // refresh cleared the box. A failure (onReply === false) keeps the composer
  // and its draft so the text isn't lost.
  const submitReply = async (parentId, text, opts = {}) => {
    const result = await onReply(parentId, text, opts);
    if (result === false) return false;
    setReplyTarget(null);
    setRepliesOpen(true);
    return result;
  };

  const saveEdit = async (id, text) => {
    const result = await onEdit(id, text);
    if (result === false) return false;
    setEditTarget(null);
    return result;
  };

  const reactionCount = hasReactions(comment);
  const isMine = authoredBy(comment, currentUser);
  const canDelete = mayDelete(comment, currentUser, isOwner);
  const canMutate = mayMutate(comment, currentUser, isOwner, handoffViewer);
  const createdAt = formatCreated(comment.created);
  const replies = comment.replies || [];
  // The reply being answered was deleted: the box and its words move to the thread.
  const replyTo = replyTarget && replyTarget !== comment.id && !replies.some((r) => r.id === replyTarget && !r.deleted)
    ? comment.id : replyTarget;
  const replyFocus = !reopenedBox.current || floating || selected;
  const footTarget = floating ? replies.find((r) => r.id === replyTo) : null;
  // Orphans — their parent reply was deleted — still show under the root
  // rather than vanishing with it.
  const known = new Set(replies.map((reply) => reply.id).concat([comment.id]));
  const rootReplies = childrenOf(replies, comment.id, comment.id)
    .concat(replies.filter((reply) => reply.parent_id && !known.has(reply.parent_id)));
  // The order they always read in; only the nesting is gone.
  const flatReplies = rootReplies.flatMap((reply) => [reply, ...descendantsOf(replies, reply.id, comment.id)]);

  const className = [
    'tdoc-margin-comment',
    'active',
    floating ? 'tdoc-floating-open' : '',
    selected ? 'tdoc-current-comment' : '',
    comment.status === 'applied' ? 'tdoc-resolved' : '',
    unanchored ? 'tdoc-unanchored' : '',
    comment.deleted ? 'tdoc-deleted' : '',
  ].filter(Boolean).join(' ');

  // The thread block is the same whether the comment above it is still there
  // or is a tombstone — the replies are why the tombstone exists.
  const threadBlock = replies.length ? (
    <>
      <button
        type="button"
        className={`tdoc-replies-toggle${repliesOpen ? ' open' : ''}`}
        onClick={() => setRepliesOpen((open) => !open)}
      >
        <ChevronRight className="chev" size={10} />
        {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
      </button>
      <div className={`tdoc-replies${repliesOpen ? ' open' : ''}`}>
        {flatReplies.map((reply, index) => (
          <ReplyCard
            key={reply.id}
            reply={reply}
            replies={replies}
            rootId={comment.id}
            rootComment={comment}
            saysWhoItAnswers={Boolean(reply.parent_id) && reply.parent_id !== comment.id && reply.parent_id !== flatReplies[index - 1]?.id}
            currentUser={currentUser}
            isOwner={isOwner}
            mentionable={mentionable}
            demo={demo}
            canSendToAgent={canSendToAgent}
            agentSetupHref={agentSetupHref}
            replyTarget={replyTo}
            onReplyTarget={setReplyTarget}
            formHere={!floating}
            takeFocus={replyFocus}
            editTarget={editTarget}
            onEditTarget={setEditTarget}
            onReply={submitReply}
            onReact={onReact}
            onDelete={onDelete}
            onEdit={saveEdit}
          />
        ))}
      </div>
    </>
  ) : null;

  if (comment.deleted) {
    return (
      <article
        ref={cardRef}
        className={className}
        data-comment-id={comment.id}
        style={floatingStyle}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="tdoc-cc-body"><Tombstone item={comment}>{threadBlock}</Tombstone></div>
      </article>
    );
  }

  return (
    <article
      ref={cardRef}
      className={className}
      data-comment-id={comment.id}
      style={floatingStyle}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        if (!onActivate) return;
        // [role="menuitem"] belongs on this list: the card's ⋯ menu renders
        // through a portal, and React bubbles portal events along the COMPONENT
        // tree, so choosing Edit or Delete arrived here as a click on the card.
        // In the phone drawer that meant "focus this comment", which closes the
        // drawer — the card appeared to jump away instead of opening an editor.
        // A checkbox in the reply box (Only me, Ask only) is a <label>: the
        // same, or ticking it closed the phone drawer.
        if (event.target instanceof Element
          && event.target.closest('button, a, input, textarea, select, label, [role="button"], [role="menuitem"], [role="checkbox"]')) return;
        onActivate(comment.id);
      }}
    >
      <div className="tdoc-cc-body">
      {demo ? <span className="tdoc-demo-chip">Demo</span> : null}
      <div className="tdoc-status-row">
        {comment.status === 'applied' ? (
          <span className="tdoc-resolved-chip">
            {comment.handoff_at && !comment.resolved_by && (demo || canSeeHandoff(comment, handoffViewer, isOwner)) ? '✅ Done' : comment.resolved_by
              ? `✓ resolved by @${comment.resolved_by}`
              : `✓ fixed${comment.applied_in ? ` · v${comment.applied_in}` : ''}`}
          </span>
        ) : null}
        {demo || canSeeHandoff(comment, handoffViewer, isOwner) ? (
          <HandoffStatusChips comment={comment} progressLine={progressLine} onResend={comment.handoff_resend_allowed === false ? null : onResendHandoff} />
        ) : null}
        {unread ? (onMarkRead && !onSeen
          ? <button type="button" className="tdoc-thread-mark-read" aria-label="Mark as read" title="Mark as read" onClick={() => onMarkRead(comment)}><span className="tdoc-thread-unread-dot" aria-hidden="true" /></button>
          : <span className="tdoc-thread-unread-dot" role="status" aria-label="New agent reply" title="New agent reply" />) : null}
      </div>
      <header className="tdoc-cc-head">
        <Author
          author={comment.author}
          timestamp={`${createdAt || `v${comment.version || 1}`}${editedSuffix(comment)}`}
        />
        <div className="tdoc-cc-head-actions">
          {canMutate ? (
            <button
              type="button"
              className="tdoc-resolve-toggle"
              data-resolved={comment.status === 'applied' ? '' : undefined}
              title={comment.status === 'applied' ? 'Reopen' : 'Resolve'}
              aria-label={comment.status === 'applied' ? 'Reopen' : 'Resolve'}
              onClick={() => onResolve(comment.id, comment.status !== 'applied')}
            >
              <Check size={16} />
            </button>
          ) : null}
          {isMine || canDelete || canMutate ? (
            <AppMenu
              trigger={(
                <button type="button" className="tdoc-cc-icon" title="More" aria-label="More actions">
                  <MoreHorizontal size={16} />
                </button>
              )}
            >
              {isMine ? (
                <AppMenuItem
                  className="tdoc-edit-toggle"
                  onClick={() => setEditTarget(editTarget === comment.id ? null : comment.id)}
                >
                  Edit
                </AppMenuItem>
              ) : null}
              {/* Plain text, not the two toggled spans the inline button used:
                  their visibility was written as `.tdoc-margin-comment …`
                  descendant rules, and a menu renders through a portal OUTSIDE
                  the card, so both spans stayed display:none and the row came
                  out empty — an invisible item reads as a gap in the menu. */}
              {canMutate && comment.anchor && comment.anchor.kind !== 'document' ? (
                <AppMenuItem
                  className="tdoc-reanchor-btn"
                  onClick={() => onReanchor(comment.id)}
                >
                  {unanchored ? 'Re-anchor' : 'Move anchor'}
                </AppMenuItem>
              ) : null}
              {canDelete ? (
                <AppMenuItem className="del" onClick={() => onDelete(comment.id)}>
                  Delete
                </AppMenuItem>
              ) : null}
            </AppMenu>
          ) : null}
        </div>
      </header>
      <ProductWhere anchor={comment.anchor} origin={productLinkOrigin} />
      {earlierVersion ? <p className="tdoc-cc-earlier">Commented on an earlier version</p> : null}
      {editTarget === comment.id ? (
        <EditForm item={comment} onSave={saveEdit} onCancel={() => setEditTarget(null)} />
      ) : (
        <CommentMessageText text={comment.text} mentions={comment.mentions} />
      )}
      {reactionCount ? (
        <Reactions item={comment} me={currentUser} onReact={onReact} />
      ) : null}

      {/* On the owner's own thread, and no other. It used to arrive on every
          card the layer drew, so the seeded comment -- which is still asking
          them to say something -- carried the line for handing their answer to
          an agent, above a Reply button they had not pressed yet. */}
      {handoff && handoff.threadId === comment.id && comment.status !== 'applied'
        && !replies.some((reply) => reply.author?.kind === 'agent') ? (() => {
          const copyButton = (
            <CopyPromptButton
              className={handoff.state !== 'idle' ? 'tdoc-handoff-copy done' : 'tdoc-handoff-copy'}
              label="Copy"
              copied={handoff.state !== 'idle'}
              copiedLabel={handoff.copyFailed ? 'Select & copy' : 'Copied'}
              showTick={!handoff.copyFailed}
              onCopy={handoff.onCopy}
            />
          );
          return (
          <div className={handoff.open ? 'tdoc-handoff open' : 'tdoc-handoff'}>
            {/* One row when closed: the name of the thing and Copy. The line
                with the doc's address and the sentence saying what happens
                open under it — pinned open on the onboarding doc, and
                otherwise remembered the way the reader last left it. */}
            <div className="tdoc-handoff-head">
              <button
                type="button"
                className="tdoc-handoff-toggle"
                aria-expanded={handoff.open}
                onClick={handoff.onToggle}
              >
                <ChevronRight size={14} className="chev" aria-hidden="true" />
                Let your agent fix it
              </button>
              {!handoff.open ? copyButton : null}
            </div>
            {/* Open, Copy sits on the prompt itself, so what gets copied is
                the box it is attached to and nothing else on the card. */}
            {handoff.open ? (
              <div className="tdoc-handoff-line">
                <code>{handoff.line}</code>
                {copyButton}
              </div>
            ) : null}
            {handoff.open || handoff.state !== 'idle' ? (
              <div className="tdoc-handoff-status" role="status" aria-live="polite">
                {handoff.state === 'idle' ? 'Paste into your agent to address each comment and publish an update.' : null}
                {handoff.state === 'waiting' && handoff.copyFailed ? <><span className="tdoc-wait-dot" aria-hidden="true" />{COPY_FALLBACK}</> : null}
                {handoff.state === 'waiting' && !handoff.copyFailed ? <><span className="tdoc-wait-dot" aria-hidden="true" />Waiting for your agent…</> : null}
                {handoff.state === 'reading' ? <><span className="tdoc-wait-dot" aria-hidden="true" />Your agent is reading…</> : null}
                {handoff.state === 'stuck' ? 'Check your agent’s window.' : null}
              </div>
            ) : null}
          </div>
          );
        })() : null}

      {/* Resolve, edit, delete and the anchor moved to the header — the two
          controls a reader needs are ✓ and ⋯, and the rest belong behind them.
          Reply keeps its own affordance and its own show/hide rule: this change
          is the card's dress, not when anything appears. */}
      <div className="meta">
        <span className="actions">
          {/* Reply first, so it keeps its place. The add-reaction control moves
              into the reactions row once a reaction exists; with it leading,
              Reply slid sideways the moment anyone reacted. */}
          <button
            type="button"
            className="tdoc-reply-toggle"
            onClick={() => setReplyTarget((open) => (open === comment.id ? null : comment.id))}
          >
            Reply
          </button>
          {!reactionCount ? (
            <ReactionPicker onPick={(emoji) => onReact(comment.id, emoji)} />
          ) : null}
          {canReview ? (
            <button
              type="button"
              className="tdoc-reply-toggle tdoc-review-suggestion"
              title="Show the suggested edit in the doc"
              onClick={(event) => { event.stopPropagation(); suggest.review(comment.id); }}
            >
              Review suggestion
            </button>
          ) : null}
        </span>
      </div>

      {threadBlock}
      <AiAnswering ids={known} />
      </div>

      {replyTo === comment.id || footTarget ? (
        <ReplyForm
          key={replyTo}
          commentId={replyTo}
          handoffCommentId={comment.id}
          thread={comment}
          account={currentUser}
          takeFocus={replyFocus}
          replyingTo={footTarget ? replyName(footTarget.author) : undefined}
          onReply={submitReply}
          mentionable={mentionable}
          demo={demo}
          canSendToAgent={canSendToAgent}
            agentSetupHref={agentSetupHref}
        />
      ) : null}
    </article>
  );
}
