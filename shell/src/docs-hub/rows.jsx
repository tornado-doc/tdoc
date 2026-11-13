import React from 'react';
import { FileText, Folder, Globe, Link2, Lock, MoreHorizontal, Presentation, Sheet, Star, UserRound, UsersRound } from 'lucide-react';
import { AppMenu, AppMenuItem } from '../ui/menu.jsx';
import { isFeatureOn } from '../feature-flags.js';
import { absoluteTime, activityText, docTypeLabel, docTypeOf, relativeTime, sharingText } from './row-meta.js';

export const day = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '');

// The doc's own address: always its newest version, and the URL people copy.
export const docHref = (doc) => `/d/${encodeURIComponent(doc.slug)}`;
// The doc page's own Share dialog: ?share=1 opens it on arrival
// (document-shell.jsx), for the owner's access panel or a reader's link.
export const shareHref = (doc) => `${docHref(doc)}?share=1`;
export const shareMenuItem = (doc) => ({
  label: 'Share',
  className: 'row-share',
  onSelect: () => { location.assign(shareHref(doc)); },
});

// One part of a row's meta line: words, or { label, at } -- "visited 3h ago"
// with the full stamp on hover. Empty parts drop out, so a missing date never
// leaves a bare "visited".
export function MetaParts({ parts }) {
  const shown = parts.map((part) => {
    if (!part) return null;
    if (typeof part === 'string' || React.isValidElement(part)) return part;
    const when = relativeTime(part.at);
    if (!when) return part.fallback || null;
    return (
      <time dateTime={part.at} title={absoluteTime(part.at)}>{part.label ? `${part.label} ${when}` : when}</time>
    );
  }).filter(Boolean);
  return shown.map((part, i) => <React.Fragment key={i}>{i ? ' · ' : null}{part}</React.Fragment>);
}

const TYPE_ICONS = { doc: FileText, sheet: Sheet, slides: Presentation };
export function DocTypeIcon({ doc }) {
  const type = docTypeOf(doc);
  const Icon = TYPE_ICONS[type];
  const label = docTypeLabel(type);
  return (
    <span className={`doc-type is-${type}`} role="img" aria-label={label} title={label}>
      <Icon size={15} aria-hidden="true" />
    </span>
  );
}

const SHARING_ICONS = { public: Globe, link: Link2, team: UsersRound, people: UserRound, private: Lock };
export function SharingState({ doc }) {
  const text = sharingText(doc);
  if (!text) return null;
  const Icon = SHARING_ICONS[doc.sharing];
  return (
    <span className="doc-sharing" title={text.long} aria-label={text.long} data-sharing={doc.sharing}>
      <Icon size={12} aria-hidden="true" />
      <span aria-hidden="true">{text.short}</span>
    </span>
  );
}

// Unread on a doc: one blue circle with one number (comments, replies,
// @mentions and agent replies together) at the end of a row or on a card's
// corner; the label breaks it down.
export function ActivityBadge({ doc }) {
  const activity = activityText(doc);
  if (!activity) return null;
  return (
    <a className="doc-activity" href={docHref(doc)} title={activity.label} aria-label={activity.label}>
      {activity.total > 99 ? '99+' : activity.total}
    </a>
  );
}

// Row-level "⋯" menu. Items: { label, icon?, tone?, className?, onSelect }.
// Built on the shared AppMenu facade so every row gets outside-click and
// Escape dismissal, keyboard navigation, and aria wiring for free.
export function RowMenu({ label, items }) {
  if (!items.length) return null;
  return (
    <AppMenu
      trigger={(
        <button type="button" className="row-menu-btn" aria-label={label}>
          <MoreHorizontal size={18} />
        </button>
      )}
    >
      {items.map((item) => (
        <AppMenuItem
          key={item.label}
          tone={item.tone}
          className={item.className}
          onClick={item.onSelect}
        >
          {item.icon}
          {item.label}
        </AppMenuItem>
      ))}
    </AppMenu>
  );
}

export function StarButton({ doc, onToggle }) {
  return (
    <button
      type="button"
      className={`star-btn${doc.starred ? ' is-starred' : ''}`}
      aria-pressed={doc.starred}
      aria-label={`${doc.starred ? 'Unstar' : 'Star'} ${doc.title}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(doc.slug, !doc.starred);
      }}
    >
      <Star size={17} fill={doc.starred ? 'currentColor' : 'none'} />
    </button>
  );
}

// One document row for every tab. `meta` is the caller's one-line summary
// (words, or MetaParts parts); the row adds what it is, who can open it and
// what is unread on it from the doc itself.
// `selection` (optional) adds the checkbox; `menuItems` (optional) adds "⋯".
export function DocRow({
  doc,
  meta,
  path,
  selection,
  layout = 'list',
  starrable = true,
  onToggleStar,
  menuItems = [],
  className,
  data = {},
}) {
  const dataAttrs = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [`data-${key}`, value]),
  );
  const thumbnail = layout === 'grid' && isFeatureOn('docThumbnails');
  const classes = ['doc-row', layout === 'grid' ? 'is-card' : null, layout === 'grid' && !thumbnail ? 'is-text-card' : null, selection?.checked ? 'is-selected' : null, className]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} data-slug={doc.slug} data-title={doc.title} {...dataAttrs}>
      {selection ? (
        <label className="row-check">
          <input
            type="checkbox"
            checked={selection.checked}
            onChange={selection.onChange}
            aria-label={`Select ${doc.title}`}
          />
        </label>
      ) : null}
      {thumbnail ? (
        <a className="doc-card-preview" href={docHref(doc)} aria-label={`Open ${doc.title}`}>
          <span>{doc.excerpt || doc.title}</span>
          {doc.image ? (
            <img
              src={doc.image}
              alt=""
              loading="lazy"
              onError={(event) => { event.currentTarget.hidden = true; }}
            />
          ) : null}
        </a>
      ) : null}
      <div className="doc-info">
        <div className="doc-title-line">
          <DocTypeIcon doc={doc} />
          {path ? <span className="doc-path" title={path}>{path} ›</span> : null}
          <a className="doc-title" href={docHref(doc)}>{doc.title}</a>
        </div>
        {doc.excerpt ? <div className="doc-preview-excerpt">{doc.excerpt}</div> : null}
        <div className="doc-meta">
          <MetaParts parts={[...(Array.isArray(meta) ? meta : [meta]), sharingText(doc) ? <SharingState doc={doc} /> : null]} />
        </div>
      </div>
      <div className="row-actions">
        <ActivityBadge doc={doc} />
        {starrable ? <StarButton doc={doc} onToggle={onToggleStar} /> : null}
        <RowMenu label="More actions" items={menuItems} />
      </div>
    </div>
  );
}

// One list surface for personal and team spaces. The caller supplies only the
// actions/metadata that differ; preview layout, selection state, and empty
// treatment stay identical instead of slowly becoming two products.
export function DocList({ docs, rowProps, selecting = false, empty = null, layout = 'list' }) {
  return (
    <>
      <div className={`doc-list is-${layout}${selecting ? ' is-selecting' : ''}`}>
        {docs.map((doc) => <DocRow key={doc.slug} doc={doc} layout={layout} {...rowProps(doc)} />)}
      </div>
      {!docs.length && empty ? <p className="empty">{empty}</p> : null}
    </>
  );
}

function folderMeta({ folders = 0, docs = 0 } = {}) {
  const parts = [];
  if (folders) parts.push(`${folders} ${folders === 1 ? 'folder' : 'folders'}`);
  if (docs || !folders) parts.push(`${docs} ${docs === 1 ? 'doc' : 'docs'}`);
  return parts.join(' · ');
}

export function FolderRow({ folder, contents, onOpen, menuItems = [] }) {
  return (
    <div
      className="doc-row folder-row"
      data-folder-id={folder.id}
      data-parent={folder.parent}
      data-name={folder.name}
      role="button"
      tabIndex="0"
      onDoubleClick={onOpen}
      onKeyDown={(event) => { if (event.key === 'Enter') onOpen(); }}
    >
      <span className="folder-ico"><Folder size={18} /></span>
      <div className="doc-info" onClick={onOpen}>
        <span className="doc-title">{folder.name}</span>
        <div className="doc-meta">{folderMeta(contents)}</div>
      </div>
      <div className="row-actions">
        <RowMenu label="Folder actions" items={menuItems} />
      </div>
    </div>
  );
}
