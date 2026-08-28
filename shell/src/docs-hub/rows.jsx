import React from 'react';
import { Folder, MoreHorizontal, Star } from 'lucide-react';
import { AppMenu, AppMenuItem } from '../ui/menu.jsx';

export const day = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '');

export const docHref = (doc) => `/d/${encodeURIComponent(doc.slug)}/v/${doc.latest}`;

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

// One document row for every tab. `meta` is the caller's one-line summary;
// `selection` (optional) adds the checkbox; `menuItems` (optional) adds "⋯".
export function DocRow({
  doc,
  meta,
  selection,
  starrable = true,
  onToggleStar,
  menuItems = [],
  className,
  data = {},
}) {
  const dataAttrs = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [`data-${key}`, value]),
  );
  const classes = ['doc-row', selection?.checked ? 'is-selected' : null, className]
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
      <div className="doc-info">
        <a className="doc-title" href={docHref(doc)}>{doc.title}</a>
        <div className="doc-meta">{meta}</div>
      </div>
      <div className="row-actions">
        {starrable ? <StarButton doc={doc} onToggle={onToggleStar} /> : null}
        <RowMenu label="More actions" items={menuItems} />
      </div>
    </div>
  );
}

export function FolderRow({ folder, count, onOpen, menuItems = [] }) {
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
        <div className="doc-meta">{count} {count === 1 ? 'doc' : 'docs'}</div>
      </div>
      <div className="row-actions">
        <RowMenu label="Folder actions" items={menuItems} />
      </div>
    </div>
  );
}
