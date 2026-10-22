import React from 'react';
import { Folder, MoreHorizontal, Star } from 'lucide-react';
import { AppMenu, AppMenuItem } from '../ui/menu.jsx';

export const day = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '');

// The doc's own address: always its newest version, and the URL people copy.
export const docHref = (doc) => `/d/${encodeURIComponent(doc.slug)}`;

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
  const classes = ['doc-row', layout === 'grid' ? 'is-card' : null, selection?.checked ? 'is-selected' : null, className]
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
      {layout === 'grid' ? (
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
      ) : doc.image ? (
        <img
          className="doc-preview-image"
          src={doc.image}
          alt=""
          loading="lazy"
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      ) : null}
      <div className="doc-info">
        <div className="doc-title-line">
          {path ? <span className="doc-path" title={path}>{path} ›</span> : null}
          <a className="doc-title" href={docHref(doc)}>{doc.title}</a>
        </div>
        {doc.excerpt ? <div className="doc-preview-excerpt">{doc.excerpt}</div> : null}
        <div className="doc-meta">{meta}</div>
      </div>
      <div className="row-actions">
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
