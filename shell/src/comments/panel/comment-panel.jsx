import React, { useEffect, useRef } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { AppButton } from '../../ui/button.jsx';
import { AppSelect } from '../../ui/select.jsx';
import { SegmentedControl } from '../../ui/segmented-control.jsx';
import { CommentThreadList } from '../../document/comment-thread-list.jsx';
import { filterOptions, SORT_OPTIONS } from '../core/comment-query.js';

// The one comment list, on every surface: the widget's side panel and phone
// sheet, the feedback space page, the doc page's side panel and phone sheet.
// Data comes from comment-area.js (useCommentArea + useCommentListPrefs);
// each surface passes only what is its own: how threads are grouped (by
// page, by document vs. body), the empty state, a context line over each
// card, and where a click on a thread goes.

// The filter, with a count on every choice.
export function CommentFilter({ area, prefs, ariaLabel = 'Show comments' }) {
  return (
    <SegmentedControl
      className="tdoc-comment-filter"
      ariaLabel={ariaLabel}
      value={prefs.filter}
      onChange={prefs.setFilter}
      options={filterOptions(area.counts).map(({ value, label }) => ({ value, label }))}
    />
  );
}

// Search (text, author:name, agent:name) and order.
export function CommentListQuery({ search = '', onSearch, sort, onSort }) {
  return (
    <div className="tdoc-comment-query">
      <input type="search" className="tdoc-comment-search" placeholder="Search comments" aria-label="Search comments"
        value={search} onChange={(event) => onSearch(event.target.value)} />
      <AppSelect className="tdoc-comment-sort" ariaLabel="Order" value={sort} onChange={onSort} options={SORT_OPTIONS} />
    </div>
  );
}

export function RefreshButton({ onRefresh, refreshing = false }) {
  return (
    <AppButton variant="icon" size="s" className="tdoc-comment-refresh" aria-label="Refresh comments" title="Refresh comments"
      aria-busy={refreshing ? 'true' : 'false'} onClick={() => onRefresh()}>
      <RefreshCw size={14} aria-hidden="true" />
    </AppButton>
  );
}

// "N new agent replies · Mark all as read": shown whenever something is
// unread (comment-area.js showMarkAll), marking exactly what it counts.
export function MarkAllBar({ area }) {
  if (!area.showMarkAll) return null;
  return (
    <div className="tdoc-cpanel-readbar" role="status">
      <span>{area.unreadCount} new agent {area.unreadCount === 1 ? 'reply' : 'replies'}</span>
      <button type="button" className="tdoc-comment-mark-all" onClick={() => area.markAllRead()}>Mark all as read</button>
    </div>
  );
}

// The compact header the doc keeps beside its pins when the side panel is
// closed: filter, Refresh and Mark all as read, no list.
export function CommentListControls({ filter, unreadCount = 0, onMarkAllRead = null, onRefresh = null, refreshing = false, list = null }) {
  if (!filter && !(unreadCount && onMarkAllRead)) return null;
  return <>
    <div className={`tdoc-comment-filter-row${unreadCount > 0 && onMarkAllRead ? ' has-mark-all' : ''}`}>
      {filter}
      {onRefresh ? <RefreshButton onRefresh={onRefresh} refreshing={refreshing} /> : null}
      {unreadCount > 0 && onMarkAllRead ? (
        <button type="button" className="tdoc-comment-mark-all" onClick={() => onMarkAllRead()}>Mark all as read</button>
      ) : null}
    </div>
    {list ? <CommentListQuery {...list} /> : null}
  </>;
}

// groups: [{ key, label, title?, href?, items, empty? }]. A group with no
// items shows its own `empty` (the widget's "This page"), else is skipped.
// `contextLine(comment)` draws the line over a card (the widget: dialog,
// tab, element); `empty` is the whole list's empty state.
export function CommentPanel({
  area, prefs, groups,
  title = 'Comments', titleSlot = null,
  onAdd = null, addLabel = 'New comment',
  onRefresh = null, refreshing = false,
  onClose = null, closeLabel = 'Close comments',
  empty = null,
  cardProps, selectedId = null, expandReplies = true,
  isAnchored = null, onNavigate = null, contextLine = null,
  onSeen = undefined,
  showTitle = true,
  className = '', ariaLabel = 'Comments', style = undefined,
  scrollRef = null, children = null,
}) {
  const unreadIds = new Set(area.unread.map((comment) => comment.id));
  const ownScroll = useRef(null);
  const scroller = scrollRef || ownScroll;
  // The selected thread is brought into view: a pin clicked on the page, a
  // deep link, a thread just opened elsewhere.
  useEffect(() => {
    if (!selectedId || !scroller.current) return;
    const card = [...scroller.current.querySelectorAll('[data-comment-id]')].find((el) => el.dataset.commentId === selectedId);
    if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' });
  }, [selectedId, scroller]);
  const listed = groups.filter((group) => group.items.length || group.empty);
  const anything = groups.some((group) => group.items.length);
  const list = (items) => (
    <CommentThreadList
      comments={items}
      cardProps={cardProps}
      selectedId={selectedId}
      expandReplies={expandReplies}
      itemClassName="tdoc-cpanel-item"
      isAnchored={isAnchored}
      isUnread={(comment) => unreadIds.has(comment.id)}
      onSeen={onSeen === undefined ? area.onSeen : onSeen}
      onNavigate={onNavigate}
      beforeCard={contextLine}
    />
  );
  return (
    <section className={`tdoc-cpanel${className ? ` ${className}` : ''}`} aria-label={ariaLabel} style={style}>
      {children}
      <header className="tdoc-cpanel-head">
        {showTitle ? (
          <div className="tdoc-cpanel-titlerow">
            {titleSlot || <strong className="tdoc-cpanel-title">{title}</strong>}
            {onAdd ? (
              <AppButton variant="primary" size="s" className="tdoc-cpanel-add" onClick={onAdd}>
                <Plus size={14} aria-hidden="true" /> {addLabel}
              </AppButton>
            ) : null}
            {onRefresh ? <RefreshButton onRefresh={onRefresh} refreshing={refreshing} /> : null}
            {onClose ? (
              <AppButton variant="icon" size="s" className="tdoc-cpanel-close" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
                <X size={15} aria-hidden="true" />
              </AppButton>
            ) : null}
          </div>
        ) : null}
        <div className="tdoc-comment-filter-row tdoc-cpanel-filterrow">
          <CommentFilter area={area} prefs={prefs} />
          {!showTitle && onRefresh ? <RefreshButton onRefresh={onRefresh} refreshing={refreshing} /> : null}
        </div>
        <CommentListQuery search={prefs.search} onSearch={prefs.setSearch} sort={prefs.sort} onSort={prefs.setSort} />
      </header>
      <MarkAllBar area={area} />
      <div className="tdoc-cpanel-scroll" ref={scroller}>
        {!anything && prefs.search ? <p className="tdoc-comment-query-empty">No comments match.</p> : null}
        {!anything && !prefs.search && empty ? empty : null}
        {listed.map((group) => (
          <section key={group.key} className="tdoc-cpanel-group">
            {group.label ? (
              <h4 className="tdoc-cpanel-grouphead" title={group.title || undefined}>
                {group.href ? <a href={group.href} target="_blank" rel="noopener noreferrer">{group.label}</a> : group.label}
              </h4>
            ) : null}
            {group.items.length ? list(group.items) : (anything || !empty ? group.empty : null)}
          </section>
        ))}
      </div>
    </section>
  );
}
