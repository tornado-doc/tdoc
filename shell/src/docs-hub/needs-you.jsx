import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { AppButton } from '../ui/button.jsx';
import { listNotifications, markNotificationsRead } from '../document/api.js';
import { actorName, notificationAction, notificationTarget } from '../notification-text.js';
import { absoluteTime, relativeTime } from './row-meta.js';
import { docHref } from './rows.jsx';

// "Needs you" on My docs: what is waiting on this person, from the data the
// rows' unread badges already come from -- the bell's unread comment, reply
// and mention rows (/api/notifications, the same inbox the badge counts) and
// the agent replies not opened yet (doc.activity.agent). Nothing new on the
// server: a card per doc, newest first.

const INBOX_KINDS = new Set(['comment', 'reply', 'mention']);

// The bell's first page, once. A failure leaves only the badge counts.
export function useNeedsInbox(enabled) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    listNotifications(0)
      .then((page) => { if (live) setItems(Array.isArray(page?.items) ? page.items : []); })
      .catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [enabled]);
  const markRead = useCallback((ids) => {
    const gone = new Set(ids);
    setItems((current) => (current || []).map((item) => (gone.has(item.id) ? { ...item, read: true } : item)));
    return markNotificationsRead(ids);
  }, []);
  return { items, markRead };
}

// Cards for one space. `docs`: the docs this space lists (and any other row
// the page knows, for its type); `inSpace(slug)`: whether a notification's
// doc belongs here.
export function needsCards({ inbox, docs, inSpace }) {
  const bySlug = new Map();
  for (const doc of docs) if (doc && doc.slug && !bySlug.has(doc.slug)) bySlug.set(doc.slug, doc);
  const cards = new Map();
  for (const item of inbox || []) {
    if (!item || item.read || !INBOX_KINDS.has(item.kind) || !item.slug || !inSpace(item.slug)) continue;
    const card = cards.get(item.slug);
    if (card) { card.ids.push(item.id); continue; }
    const doc = bySlug.get(item.slug) || { slug: item.slug, title: item.title || item.slug };
    cards.set(item.slug, {
      key: `n:${item.slug}`,
      kind: 'comment',
      slug: item.slug,
      doc,
      who: actorName(item),
      reason: `${actorName(item)} ${notificationAction(item)}`,
      quote: item.preview || '',
      at: item.at,
      href: notificationTarget(item) || docHref(doc),
      ids: [item.id],
    });
  }
  for (const doc of bySlug.values()) {
    if (!inSpace(doc.slug)) continue;
    const activity = doc.activity || {};
    const agent = Math.max(0, Number(activity.agent) || 0);
    const comments = Math.max(0, Number(activity.comments) || 0);
    const card = cards.get(doc.slug);
    if (card) {
      if (agent) card.agent = agent;
      continue;
    }
    if (agent) {
      cards.set(doc.slug, {
        key: `a:${doc.slug}`, kind: 'agent', slug: doc.slug, doc, agent,
        reason: agent === 1 ? 'An agent replied' : `${agent} agent replies`,
        quote: comments ? `${comments} new ${comments === 1 ? 'comment' : 'comments'} too` : 'Not opened yet',
        at: '', href: docHref(doc), ids: [],
      });
    } else if (comments) {
      // The badge counted it, the first page of the bell did not have it.
      cards.set(doc.slug, {
        key: `c:${doc.slug}`, kind: 'comment', slug: doc.slug, doc,
        reason: `${comments} new ${comments === 1 ? 'comment' : 'comments'}`,
        quote: '', at: '', href: docHref(doc), ids: [],
      });
    }
  }
  return [...cards.values()].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

// One to-do, as in Apple's Reminders: a round check on the left marks it
// done; the doc is the line; who did what, their words and when sit under it
// in grey. An agent reply has no check (it is read in the doc), only a dot.
function NeedCard({ card, onDone }) {
  const when = relativeTime(card.at);
  return (
    <div className="mda-need" data-slug={card.slug} data-kind={card.kind}>
      <a className="mda-need-link" href={card.href} aria-label={`${card.reason} on ${card.doc.title}`} />
      {card.ids.length ? (
        <AppButton variant="icon" size="s" className="mda-need-done" title="Mark done" aria-label={`Mark done: ${card.doc.title}`} onClick={() => onDone(card)}>
          <span className="mda-need-ring"><Check size={11} strokeWidth={3} /></span>
        </AppButton>
      ) : (
        <span className="mda-need-dot" aria-hidden="true" />
      )}
      <div className="mda-need-body">
        <span className="mda-need-title">{card.doc.title}</span>
        <span className="mda-need-sub">
          <span className="mda-need-reason">{card.reason}</span>
          {/* Someone's words are quoted; an agent card's line is a status. */}
          {card.quote ? <>{' · '}{card.kind === 'agent' ? <span className="mda-need-note">{card.quote}</span> : <q className="mda-need-quote">{card.quote}</q>}</> : null}
          {when ? <>{' · '}<time className="mda-need-when" dateTime={card.at} title={absoluteTime(card.at)}>{when}</time></> : null}
        </span>
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
