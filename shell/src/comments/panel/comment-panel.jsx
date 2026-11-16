import React, { useEffect, useRef } from 'react';
import { Check, ChevronDown, Plus, RefreshCw, X } from 'lucide-react';
import { AppButton } from '../../ui/button.jsx';
import { AppMenu, AppMenuItem, AppMenuSeparator } from '../../ui/menu.jsx';
import { AppSelect } from '../../ui/select.jsx';
import { SegmentedControl } from '../../ui/segmented-control.jsx';
import { CommentThreadList } from '../../document/comment-thread-list.jsx';
import { filterName, filterOptions, SORT_OPTIONS } from '../core/comment-query.js';

// The one comment list, on every surface: the widget's side panel and phone
// sheet, the feedback space page, the doc page's side panel and phone sheet.
// Data comes from comment-area.js (useCommentArea + useCommentListPrefs);
// each surface passes only what is its own: how threads are grouped (by
// page, by document vs. body), the empty state, a context line over each
// card, what a press on a card selects (onSelect) and where Go to comment
// goes (onGoTo, where canGoTo allows). A press on a card never navigates.

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

// The doc bar's filter: a chevron beside the Comment button opening Open /
// Replied / Resolved / All with their counts (and Mark all as read while
// something is unread). It replaced the filter row that floated at the top
// of the comment column and covered the first cards (Julie, 2026-11-16).
// Threads refresh on their own (use-comment-feed.js), so no Refresh here.
export function CommentFilterMenu({ area, prefs, onChange = null, unreadCount = 0, onMarkAllRead = null }) {
  const pick = onChange || prefs.setFilter;
  return (
    // A press in the menu is not a press on the page: it must not close the
    // open card (document-shell's pointer-down dismiss).
    <span className="tdoc-comments-filter-wrap" onPointerDown={(event) => event.stopPropagation()}>
      <AppMenu align="end" popupClassName="tdoc-comments-filter-popup" trigger={(
        <AppButton variant="icon" className="tdoc-comments-filter-menu" aria-label="Filter comments" title="Filter comments">
          <ChevronDown size={12} aria-hidden="true" />
        </AppButton>
      )}>
        <div className="tdoc-menu-label">Show</div>
        {filterOptions(area.counts).map((option) => {
          const selected = option.value === prefs.filter;
          return (
            <AppMenuItem key={option.value}
              className={`tdoc-action-menu-item tdoc-mode-item tdoc-comments-filter-item${selected ? ' current' : ''}`}
              role="menuitemradio" aria-checked={selected} aria-label={option.label} data-filter={option.value}
              onClick={() => pick(option.value)}>
              <span>{filterName(option.value)}</span>
              <span className="tdoc-comments-filter-count">{option.count}</span>
              {selected ? <Check className="tdoc-mode-check" size={14} aria-hidden="true" /> : <span className="tdoc-mode-check" aria-hidden="true" />}
            </AppMenuItem>
          );
        })}
        {unreadCount > 0 && onMarkAllRead ? <>
          <AppMenuSeparator />
          <AppMenuItem className="tdoc-action-menu-item tdoc-comment-mark-all-item" onClick={() => onMarkAllRead()}>
            Mark all as read
          </AppMenuItem>
        </> : null}
      </AppMenu>
    </span>
  );
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
  isAnchored = null, onSelect = null, onGoTo = null, canGoTo = null, contextLine = null,
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
      onSelect={onSelect}
      onGoTo={onGoTo}
      canGoTo={canGoTo}
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
