import React from 'react';
import { Folder } from 'lucide-react';
import { isFeatureOn } from '../feature-flags.js';
import { docTypeOf } from './row-meta.js';
import { ActivityBadge, DocTypeIcon, MetaParts, RowMenu, SharingState, StarButton, docHref } from './rows.jsx';

// My docs on a wide screen (layout A): the grid of cards and the list table.
// They are DocRow's two wide-screen shapes, not a second row: the same type
// icon, sharing state, unread badge, star and ⋯ menu (rows.jsx), the same
// `.doc-row[data-slug]` root and `.doc-meta` words, so every test and caller
// that knows a row knows these. What DocRow cannot do is the thumbnail on top
// of a card and the table's Folder / Sharing / Last activity columns.

// A doc can be dragged onto a folder in the sidebar. The payload is the slugs
// moving (the row, or the whole selection when the row is part of it).
export const DRAG_TYPE = 'application/x-tdoc-slugs';
function dragProps(doc, dragSlugs) {
  if (!dragSlugs) return {};
  return {
    draggable: true,
    onDragStart: (event) => {
      const slugs = dragSlugs(doc);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(slugs));
      event.dataTransfer.setData('text/plain', doc.title || doc.slug);
      event.currentTarget.classList.add('is-dragging');
    },
    onDragEnd: (event) => { event.currentTarget.classList.remove('is-dragging'); },
  };
}

function seedOf(text) {
  let h = 0;
  for (const c of String(text || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

// A drawn stand-in for the doc's first page: a page of lines, a grid, or a
// slide, varied per doc so a wall of cards does not look like one card.
// With the docThumbnails flag and a stored preview image, the image instead.
export function DocThumb({ doc }) {
  const type = docTypeOf(doc);
  const h = seedOf(doc.slug || doc.title);
  if (isFeatureOn('docThumbnails') && doc.image) {
    return <img className="mda-th-img" src={doc.image} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />;
  }
  const w = (k) => (h >> k) % 5;
  if (type === 'sheet') {
    const selected = 7 + (h % 18);
    const cells = [];
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 6; c += 1) {
        const head = r === 0 || c === 0;
        const index = r * 6 + c;
        cells.push(
          <i key={index} className={[head ? 'hd' : '', index === selected && !head ? 'sel' : '', c >= 3 && !head ? 'num' : ''].filter(Boolean).join(' ') || undefined}>
            {c === 0 ? null : <b data-w={head ? 2 : w(index % 13)} />}
          </i>,
        );
      }
    }
    return <span className="mda-th mda-th-sheet" aria-hidden="true">{cells}</span>;
  }
  if (type === 'slides') {
    return (
      <span className="mda-th mda-th-slides" aria-hidden="true">
        <span className={`sl${h % 2 ? '' : ' dark'}`}>
          <span className="bar" />
          <span className="ln h" data-w={w(2)} />
          <span className="ln" data-w={w(3)} />
          <span className="ln" data-w={w(5)} />
        </span>
        <span className="stack"><i className="on" /><i /><i /><i /></span>
      </span>
    );
  }
  const lines = [];
  for (let i = 0; i < 9; i += 1) {
    if (i === 3 && h % 3 === 0) { lines.push(<span key={i} className="fig" />); continue; }
    lines.push(<span key={i} className={`ln${i === 6 && h % 4 === 1 ? ' a' : ''}`} data-w={i % 4 === 3 ? 0 : w(i + 2)} />);
  }
  return (
    <span className="mda-th mda-th-doc" aria-hidden="true">
      <span className="pg"><span className="ln h" data-w={w(1)} />{lines}</span>
    </span>
  );
}

// One card: the drawing, the title, then the type icon and the row's own
// meta line (when, who can open it). Unread sits on the drawing's corner,
// the star on the other, ⋯ beside the title.
export function DocCard({ doc, meta, path, starrable = true, onToggleStar, menuItems = [], dragSlugs, data = {} }) {
  const dataAttrs = Object.fromEntries(Object.entries(data).map(([key, value]) => [`data-${key}`, value]));
  return (
    <div className={`doc-row mda-card${doc.starred ? ' is-starred' : ''}`} data-slug={doc.slug} data-title={doc.title} {...dataAttrs} {...dragProps(doc, dragSlugs)}>
      <a className="mda-thumb" href={docHref(doc)} tabIndex={-1} aria-hidden="true" draggable={false}>
        <DocThumb doc={doc} />
      </a>
      <ActivityBadge doc={doc} />
      {starrable ? <StarButton doc={doc} onToggle={onToggleStar} /> : null}
      <div className="doc-info">
        <div className="doc-title-line">
          {path ? <span className="doc-path" title={path}>{path} ›</span> : null}
          <a className="doc-title" href={docHref(doc)} draggable={false}>{doc.title}</a>
        </div>
        <div className="doc-meta">
          <DocTypeIcon doc={doc} />
          <span className="mda-meta-words">
            <MetaParts parts={[...(Array.isArray(meta) ? meta : [meta]), doc.sharing ? <SharingState doc={doc} /> : null]} />
          </span>
        </div>
      </div>
      <div className="row-actions">
        <RowMenu label="More actions" items={menuItems} />
      </div>
    </div>
  );
}

// One table row: type, title (with its unread badge), folder, sharing, the
// latest activity, star, ⋯. `selection` adds the checkbox column.
export function DocTableRow({ doc, meta, path, folderName = '', selection, starrable = true, onToggleStar, menuItems = [], dragSlugs, data = {} }) {
  const dataAttrs = Object.fromEntries(Object.entries(data).map(([key, value]) => [`data-${key}`, value]));
  return (
    <div className={`doc-row mda-row${selection?.checked ? ' is-selected' : ''}`} data-slug={doc.slug} data-title={doc.title} {...dataAttrs} {...dragProps(doc, dragSlugs)}>
      <span className="mda-cell-check">
        {selection ? (
          <label className="row-check">
            <input type="checkbox" checked={selection.checked} onChange={selection.onChange} aria-label={`Select ${doc.title}`} />
          </label>
        ) : null}
      </span>
      <DocTypeIcon doc={doc} />
      <div className="doc-info">
        <div className="doc-title-line">
          {path ? <span className="doc-path" title={path}>{path} ›</span> : null}
          <a className="doc-title" href={docHref(doc)} draggable={false}>{doc.title}</a>
          <ActivityBadge doc={doc} />
        </div>
      </div>
      <span className="mda-cell mda-cell-folder">{folderName ? <><Folder size={14} aria-hidden="true" /><span>{folderName}</span></> : null}</span>
      <span className="mda-cell mda-cell-sharing">{doc.sharing ? <SharingState doc={doc} /> : null}</span>
      <span className="mda-cell doc-meta"><MetaParts parts={Array.isArray(meta) ? meta : [meta]} /></span>
      <div className="row-actions">
        {starrable ? <StarButton doc={doc} onToggle={onToggleStar} /> : null}
        <RowMenu label="More actions" items={menuItems} />
      </div>
    </div>
  );
}

// The grid or the table, with the table's column heads.
export function DocCollection({ docs, layout, rowProps, empty = null, selecting = false }) {
  if (!docs.length) return empty ? <p className="empty">{empty}</p> : null;
  if (layout === 'list') {
    return (
      <div className={`doc-list mda-table${selecting ? ' is-selecting' : ''}`}>
        <div className="mda-table-hd" aria-hidden="true">
          <span /><span /><span>Name</span><span>Folder</span><span>Sharing</span><span>Last activity</span><span />
        </div>
        {docs.map((doc) => <DocTableRow key={doc.slug} doc={doc} {...rowProps(doc)} />)}
      </div>
    );
  }
  return (
    <div className="doc-list mda-grid">
      {docs.map((doc) => {
        const { selection, folderName, ...props } = rowProps(doc);
        return <DocCard key={doc.slug} doc={doc} {...props} />;
      })}
    </div>
  );
}
