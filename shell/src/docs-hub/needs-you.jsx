import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Check, MessageSquareText } from 'lucide-react';
import { AppButton } from '../ui/button.jsx';
import { listNotifications, markDocNotificationsRead, markNotificationsRead, postThreadSeen } from '../document/api.js';
import { actorName, notificationTarget } from '../notification-text.js';
import { absoluteTime, relativeTime } from './row-meta.js';
import { docHref } from './rows.jsx';
import { AuthorAvatar } from '../document/author-face.jsx';
import { authorLine } from '../document/comment-card.jsx';

// "Needs you" on My docs: what is waiting on this person, from the data the
// rows' unread badges already come from -- the bell's unread comment, reply
// and mention rows (/api/notifications, the same inbox the badge counts) and
// the agent replies not opened yet (doc.activity.agent / agent_threads).
//
// One item per doc and thread: every row about the same thread (a comment,
// the replies after it, a mention in it -- whichever version each was left
// on) is one to-do, at its newest. Each says what to do in plain words
// ("Reply to Bob", "Answer Serena's question", "Review 2 agent replies") and
// opens the doc as it is now at that thread (/d/<slug>?comment=, never a
// /v/<n>). Reading the thread on the doc page marks its rows read on the
// server, so an item someone already dealt with does not linger here.
//
// Every item has the round check: it clears what made the item -- the bell
// rows (by id, or the doc's when the item came from the badge count alone)
// or the agent replies' threads, marked seen as the doc page would.

const INBOX_KINDS = new Set(['comment', 'reply', 'mention']);
const INBOX_PAGES = 10;

// Every unread bell row, once: unread rows come first, so paging stops at the
// first page holding a read one. A failure leaves only the badge counts.
export function useNeedsInbox(enabled) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    (async () => {
      const all = [];
      let offset = 0;
      for (let n = 0; n < INBOX_PAGES; n += 1) {
        const page = await listNotifications(offset);
        const rows = Array.isArray(page?.items) ? page.items : [];
        all.push(...rows);
        offset += rows.length;
        if (!page?.has_more || !rows.length || rows.some((row) => row && row.read)) break;
      }
      return all;
    })()
      .then((rows) => { if (live) setItems(rows); })
      .catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [enabled]);
  // Clears what made the item (see above); the list drops it at once.
  const markDone = useCallback((card) => {
    const ids = new Set(card.ids);
    setItems((current) => (current || []).map((item) => (
      ids.has(item.id) || (card.allOfDoc && item.slug === card.slug && INBOX_KINDS.has(item.kind)) ? { ...item, read: true } : item
    )));
    const work = [];
    if (card.ids.length) work.push(markNotificationsRead(card.ids));
    else if (card.allOfDoc) work.push(markDocNotificationsRead(card.slug));
    if (card.threads.length) {
      // Seen up to the reply's own (server) time at least: a browser clock
      // running behind would otherwise mark it seen before it was written.
      const now = Date.now();
      const at = card.threadAt || {};
      work.push(postThreadSeen(card.slug, Object.fromEntries(card.threads.map((thread) => [thread, Math.max(Date.parse(at[thread] || '') || 0, now)]))));
    }
    return Promise.all(work);
  }, []);
  return { items, markDone };
}

const isQuestion = (text) => /[?\uff1f]/.test(String(text || ''));

// What to do, in plain words.
function inboxAction(card) {
  const who = card.who;
  if (card.kind === 'comment' && card.count > 1 && card.threadsCount > 1) return `Read ${card.count} new comments`;
  if (isQuestion(card.quote)) return `Answer ${who}\u2019s question`;
  return `Reply to ${who}`;
}

function agentAction(count) {
  return count === 1 ? 'Review the agent\u2019s reply' : `Review ${count} agent replies`;
}

// Items for one space. `docs`: the docs this space lists (and any other row
// the page knows, for its type); `inSpace(slug)`: whether a notification's
// doc belongs here.
export function needsCards({ inbox, docs, inSpace }) {
  const bySlug = new Map();
  for (const doc of docs) if (doc && doc.slug && !bySlug.has(doc.slug)) bySlug.set(doc.slug, doc);
  const cards = new Map();
  const docsWithRows = new Set();
  // Newest first, so the first row of a thread is the one the item shows.
  const rows = (inbox || []).filter((item) => item && !item.read && INBOX_KINDS.has(item.kind) && item.slug && inSpace(item.slug))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  for (const item of rows) {
    docsWithRows.add(item.slug);
    const thread = item.thread_id || item.comment_id || item.id;
    const key = `n:${item.slug}:${thread}`;
    const count = Math.max(1, Number(item.count) || 1);
    const card = cards.get(key);
    if (card) {
      card.ids.push(item.id);
      card.count += count;
      continue;
    }
    const doc = bySlug.get(item.slug) || { slug: item.slug, title: item.title || item.slug };
    cards.set(key, {
      key,
      kind: item.kind,
      slug: item.slug,
      thread,
      doc,
      who: actorName(item),
      actor: item.actor || null,
      quote: item.preview || '',
      at: item.at,
      count,
      // A grouped "commented" row spans the doc's new threads.
      threadsCount: item.kind === 'comment' && count > 1 ? count : 1,
      href: notificationTarget({ ...item, comment_id: thread }) || docHref(doc),
      ids: [item.id],
      threads: [],
    });
  }
  for (const doc of bySlug.values()) {
    if (!inSpace(doc.slug)) continue;
    const activity = doc.activity || {};
    const agent = Math.max(0, Number(activity.agent) || 0);
    const comments = Math.max(0, Number(activity.comments) || 0);
    const agentThreads = (Array.isArray(activity.agent_threads) ? activity.agent_threads : [])
      .filter((row) => row && typeof row.thread === 'string');
    if (agent) {
      // An agent answered in a thread that already has an item: that item
      // carries it (one to-do per thread), and its check clears both.
      const rest = [];
      for (const row of agentThreads) {
        const card = cards.get(`n:${doc.slug}:${row.thread}`);
        if (card) {
          card.agent = true;
          if (!card.agentAuthor && row.author) card.agentAuthor = row.author;
          card.threads.push(row.thread);
          card.threadAt = { ...(card.threadAt || {}), [row.thread]: row.at };
        } else rest.push(row);
      }
      const left = agentThreads.length ? rest.length : agent;
      if (left) {
        const newest = rest[0];
        cards.set(`a:${doc.slug}`, {
          key: `a:${doc.slug}`, kind: 'agent', slug: doc.slug, doc, count: left,
          action: agentAction(left),
          // Who answered (the newest reply's agent), as the thread shows it.
          author: newest?.author || null,
          quote: '',
          at: newest?.at || '',
          href: newest ? `/d/${encodeURIComponent(doc.slug)}?comment=${encodeURIComponent(newest.thread)}` : docHref(doc),
          ids: [],
          threads: rest.map((row) => row.thread),
          threadAt: Object.fromEntries(rest.map((row) => [row.thread, row.at])),
        });
      }
    }
    if (comments && !docsWithRows.has(doc.slug)) {
      // The badge counted it but the bell's rows did not load.
      cards.set(`c:${doc.slug}`, {
        key: `c:${doc.slug}`, kind: 'comments', slug: doc.slug, doc, count: comments,
        action: `Read ${comments} new ${comments === 1 ? 'comment' : 'comments'}`,
        quote: '', at: '', href: docHref(doc), ids: [], threads: [], allOfDoc: true,
      });
    }
  }
  for (const card of cards.values()) if (!card.action) card.action = inboxAction(card);
  return [...cards.values()].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

// Whose item it is, drawn as the comment thread draws its author
// (AuthorAvatar): a person's photo or initial; an agent's reply, the agent's
// own mark (Claude, Codex, Raft, ...). An agent reply noted before the
// server kept who wrote it, the generic agent mark.
function NeedAvatar({ card }) {
  const author = card.kind === 'agent' ? card.author : card.kind === 'comments' ? null : (card.actor || { name: card.who });
  if (author) return <span className={`mda-need-avatar is-face${author.kind === 'agent' ? ' is-agent' : ''}`}><AuthorAvatar author={author} size={0} /></span>;
  if (card.kind === 'agent') return <span className="mda-need-avatar is-mark" aria-hidden="true"><Bot size={15} /></span>;
  return <span className="mda-need-avatar is-mark" aria-hidden="true"><MessageSquareText size={14} /></span>;
}

// One to-do, as in Apple's Reminders: a round check on the left marks it
// done; who it is from and what to do is the line, the doc follows it; their
// words and when sit under it in grey.
function NeedCard({ card, onDone }) {
  const when = relativeTime(card.at);
  const more = card.kind !== 'comment' || card.threadsCount === 1 ? card.count - 1 : 0;
  // The agent by name and whose it is ("name · owner"), as on its reply.
  const by = card.kind === 'agent' && card.author ? authorLine(card.author) : '';
  const agentNote = card.agentAuthor ? `${authorLine(card.agentAuthor)} replied` : 'an agent replied';
  return (
    <div className="mda-need" data-slug={card.slug} data-kind={card.kind}>
      <a className="mda-need-link" href={card.href} aria-label={`${card.action} in ${card.doc.title}`} />
      <AppButton variant="icon" size="s" className="mda-need-done" title="Mark done" aria-label={`Mark done: ${card.action} in ${card.doc.title}`} onClick={() => onDone(card)}>
        <span className="mda-need-ring"><Check size={11} strokeWidth={3} /></span>
      </AppButton>
      <NeedAvatar card={card} />
      <div className="mda-need-body">
        <span className="mda-need-line">
          <span className="mda-need-action">{card.action}</span>
          <span className="mda-need-in"> in </span>
          <span className="mda-need-title">{card.doc.title}</span>
        </span>
        {card.quote || by || when || more > 0 || card.agent ? (
          <span className="mda-need-sub">
            {by ? <span className="mda-need-by">{by}</span> : null}
            {card.quote ? <q className="mda-need-quote">{card.quote}</q> : null}
            {more > 0 ? <>{card.quote || by ? ' · ' : ''}<span className="mda-need-more">{`+${more} more`}</span></> : null}
            {card.agent ? <>{card.quote || by || more > 0 ? ' · ' : ''}<span className="mda-need-note">{agentNote}</span></> : null}
            {when ? <>{card.quote || by || more > 0 || card.agent ? ' · ' : ''}<time className="mda-need-when" dateTime={card.at} title={absoluteTime(card.at)}>{when}</time></> : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// `limit`: the list on top of My docs shows the newest few; the Needs you
// view all of them. Desktop and phone are the same list.
export function NeedsYou({ cards, limit = 0, onSeeAll, onDone, empty = null }) {
  const shown = useMemo(() => (limit ? cards.slice(0, limit) : cards), [cards, limit]);
  if (!cards.length) return empty;
  return (
    <section className="mda-needs" aria-label="Needs you">
      {limit ? (
        <div className="mda-sec-hd">
          <h2>Needs you</h2>
          {onSeeAll ? <button type="button" className="mda-text-link" onClick={onSeeAll}>See all {cards.length}</button> : null}
        </div>
      ) : null}
      <div className="mda-needs-grid">
        {shown.map((card) => <NeedCard key={card.key} card={card} onDone={onDone} />)}
      </div>
    </section>
  );
}
