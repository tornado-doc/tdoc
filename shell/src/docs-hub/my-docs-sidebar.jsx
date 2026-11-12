import React, { useState } from 'react';
import { FileText, Folder, FolderOpen, Inbox, MessageSquareText, Plus, Presentation, Settings, Sheet, Trash2 } from 'lucide-react';
import { AppButton } from '../ui/button.jsx';
import { RowMenu } from './rows.jsx';
import { DRAG_TYPE } from './doc-cards.jsx';

export const DOC_TYPES = [
  { id: 'doc', label: 'Docs', icon: FileText },
  { id: 'sheet', label: 'Sheets', icon: Sheet },
  { id: 'slides', label: 'Slides', icon: Presentation },
];

// Folders as a tree, depth-first, each with its depth for the indent.
export function folderTree(folders) {
  const children = new Map();
  for (const item of folders) {
    const parent = item.parent || '';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  }
  const out = [];
  const seen = new Set();
  const walk = (parent, depth) => {
    const list = (children.get(parent) || []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const item of list) {
      if (seen.has(item.id) || depth > 8) continue;
      seen.add(item.id);
      out.push({ folder: item, depth });
      walk(item.id, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

// One sidebar entry; with `onDrop`, docs dragged from the grid or the table
// can be dropped on it.
function SideItem({ icon: Icon, label, count, active, onClick, onDrop, depth = 0, menuItems, menuLabel, className = '', data = {}, asTab = false }) {
  const [over, setOver] = useState(false);
  const dataAttrs = Object.fromEntries(Object.entries(data).map(([key, value]) => [`data-${key}`, value]));
  const dropProps = onDrop ? {
    onDragOver: (event) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (!over) setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (event) => {
      setOver(false);
      const raw = event.dataTransfer.getData(DRAG_TYPE);
      if (!raw) return;
      event.preventDefault();
      try { onDrop(JSON.parse(raw)); } catch { /* not ours */ }
    },
  } : {};
  return (
    <div className={`mda-side-row${active ? ' is-on' : ''}${over ? ' is-drop' : ''}${className ? ` ${className}` : ''}`} data-depth={Math.min(depth, 4)} {...dataAttrs} {...dropProps}>
      <button
        type="button"
        className="mda-side-item"
        {...(asTab ? { role: 'tab', 'aria-selected': Boolean(active) } : { 'aria-current': active ? 'true' : undefined })}
        onClick={onClick}
        title={onDrop ? 'Drop a doc here to move it' : undefined}
      >
        <Icon size={16} aria-hidden="true" />
        <span className="mda-side-name">{label}</span>
        {count != null ? <span className="mda-side-count">{count}</span> : null}
      </button>
      {menuItems && menuItems.length ? <span className="row-actions"><RowMenu label={menuLabel || `${label} actions`} items={menuItems} /></span> : null}
    </div>
  );
}

export function MyDocsSidebar({
  allCount,
  everythingActive,
  onEverything,
  onDropTop,
  types,
  typeCounts,
  type,
  onType,
  folders,
  folder,
  folderCounts,
  onFolder,
  onDropFolder,
  folderMenu,
  onNewFolder,
  view,
  onView,
  settingsLabel = 'Settings',
}) {
  const tree = folderTree(folders);
  return (
    <aside className="mda-side" aria-label="Filters and folders">
      <SideItem icon={Inbox} label="Everything" count={allCount} active={everythingActive} onClick={onEverything} onDrop={onDropTop} className="mda-everything" />

      <div className="mda-side-h"><span>Types</span></div>
      <div role="group" aria-label="Filter by type">
        {types.map(({ id, label, icon: Icon }) => (
          <div key={id} className={`mda-side-row${type === id ? ' is-on' : ''}`}>
            <button
              type="button"
              className="mda-side-item mda-type"
              data-type={id}
              aria-pressed={type === id}
              aria-label={`${label} (${typeCounts[id] || 0})`}
              onClick={() => onType(type === id ? '' : id)}
            >
              <Icon size={16} aria-hidden="true" />
              <span className="mda-side-name">{label}</span>
              <span className="mda-side-count">{typeCounts[id] || 0}</span>
            </button>
          </div>
        ))}
      </div>

      {onNewFolder || tree.length ? (
        <>
          <div className="mda-side-h">
            <span>Folders</span>
            {onNewFolder ? (
              <AppButton variant="icon" size="s" className="mda-new-folder" title="New folder" aria-label="New folder" onClick={onNewFolder}>
                <Plus size={14} />
              </AppButton>
            ) : null}
          </div>
          <div className="mda-folders" role="group" aria-label="Folders">
            {tree.map(({ folder: item, depth }) => (
              <SideItem
                key={item.id}
                icon={folder === item.id ? FolderOpen : Folder}
                label={item.name}
                count={folderCounts[item.id]?.docs ?? 0}
                active={folder === item.id}
                depth={depth}
                onClick={() => onFolder(item.id)}
                onDrop={onDropFolder ? (slugs) => onDropFolder(slugs, item) : null}
                menuItems={folderMenu ? folderMenu(item) : null}
                menuLabel="Folder actions"
                className="mda-folder"
                data={{ 'folder-id': item.id }}
              />
            ))}
            {!tree.length ? <p className="mda-side-hint">Drag docs into a folder to keep them together.</p> : null}
          </div>
        </>
      ) : null}

      {/* Views of their own, beside the list views (the chips over the list). */}
      <div className="mda-side-foot" role="tablist" aria-orientation="vertical" aria-label="More views">
        <SideItem asTab icon={MessageSquareText} label="Comments" active={view === 'comments'} onClick={() => onView('comments')} className="mda-view-comments" />
        <SideItem asTab icon={Trash2} label="Trash" active={view === 'trash'} onClick={() => onView('trash')} className="mda-view-trash" />
        <SideItem asTab icon={Settings} label={settingsLabel} active={view === 'settings'} onClick={() => onView('settings')} className="mda-view-settings" />
      </div>
    </aside>
  );
}
