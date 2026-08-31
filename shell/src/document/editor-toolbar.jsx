import React, { useEffect, useState } from 'react';
import {
  Bold,
  Check,
  ChevronDown,
  Eye,
  Heading1,
  Heading2,
  Italic,
  Link,
  Pencil,
  Redo2,
  RotateCcw,
  Save,
  Undo2,
} from 'lucide-react';
import { AppDialog } from '../ui/dialog.jsx';
import { CommentIcon } from '../ui/comment-icon.jsx';
import { AppMenu, AppMenuItem } from '../ui/menu.jsx';

const MODES = [
  { value: 'read', label: 'Read', Icon: Eye },
  { value: 'comment', label: 'Comment', Icon: CommentIcon },
  { value: 'edit', label: 'Edit', Icon: Pencil },
];

export function DocumentModeControl({ mode, canComment, canEdit, onChange }) {
  const options = MODES.filter((option) => (
    option.value === 'read'
    || (option.value === 'comment' && canComment)
    || (option.value === 'edit' && canEdit)
  ));
  if (options.length < 2) return null;
  const current = options.find((option) => option.value === mode) || options[0];
  const CurrentIcon = current.Icon;
  return (
    <AppMenu
      trigger={(
        <button
          type="button"
          className="tdoc-mode-trigger"
          data-mode={current.value}
          aria-label={`Document mode: ${current.label}`}
          title={`Document mode: ${current.label}`}
        >
          <CurrentIcon size={15} />
          <span className="tdoc-mode-label">{current.label}</span>
          <ChevronDown className="tdoc-mode-chevron" size={13} />
        </button>
      )}
      align="end"
    >
      {options.map((option) => {
        const Icon = option.Icon;
        const selected = option.value === current.value;
        return (
          <AppMenuItem
            key={option.value}
            className={`tdoc-mode-item${selected ? ' current' : ''}`}
            role="menuitemradio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
          >
            <Icon size={15} />
            <span>{option.label}</span>
            {selected ? <Check className="tdoc-mode-check" size={14} /> : null}
          </AppMenuItem>
        );
      })}
    </AppMenu>
  );
}

function ToolButton({ label, icon, command, value, onFormat }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={() => onFormat(command, value)}>
      {icon}
    </button>
  );
}

export function EditorToolbar({ dirty, saving, onFormat, onDiscard, onSave }) {
  return (
    <div className="tdoc-editor-toolbar" role="toolbar" aria-label="Text formatting">
      <div className="tdoc-editor-tools">
        <ToolButton label="Bold" icon={<Bold size={16} />} command="bold" onFormat={onFormat} />
        <ToolButton label="Italic" icon={<Italic size={16} />} command="italic" onFormat={onFormat} />
        <span className="tdoc-editor-divider" />
        <ToolButton label="Heading 1" icon={<Heading1 size={17} />} command="formatBlock" value="h1" onFormat={onFormat} />
        <ToolButton label="Heading 2" icon={<Heading2 size={17} />} command="formatBlock" value="h2" onFormat={onFormat} />
        <ToolButton label="Add link" icon={<Link size={16} />} command="createLink" onFormat={onFormat} />
        <span className="tdoc-editor-divider" />
        <ToolButton label="Undo" icon={<Undo2 size={16} />} command="undo" onFormat={onFormat} />
        <ToolButton label="Redo" icon={<Redo2 size={16} />} command="redo" onFormat={onFormat} />
      </div>
      <div className="tdoc-editor-commit">
        <span className="tdoc-editor-status">{dirty ? 'Unsaved draft' : 'No changes'}</span>
        <button type="button" title="Discard draft" aria-label="Discard draft" disabled={!dirty || saving} onClick={onDiscard}>
          <RotateCcw size={15} />
        </button>
        <button type="button" className="primary" disabled={!dirty || saving} onClick={onSave}>
          <Save size={15} /> <span>{saving ? 'Saving...' : 'Save'}</span>
        </button>
      </div>
    </div>
  );
}

export function SaveConflictDialog({ conflict, onClose }) {
  return (
    <AppDialog
      open={Boolean(conflict)}
      onOpenChange={(open) => !open && onClose()}
      title="A newer version exists"
      description="Your draft is still saved in this browser. Open the latest version to review it before saving again."
      actions={(
        <>
          <button type="button" onClick={onClose}>Keep editing</button>
          <button type="button" className="primary" onClick={() => { location.href = conflict.latestUrl; }}>
            Open v{conflict?.latestVersion}
          </button>
        </>
      )}
    />
  );
}

export function LinkDialog({ open, onOpenChange, onSubmit }) {
  const [url, setUrl] = useState('https://');

  useEffect(() => {
    if (open) setUrl('https://');
  }, [open]);

  const addLink = () => {
    const value = url.trim();
    if (!/^https?:\/\//i.test(value) && !/^\/(?!\/)/.test(value)) return;
    onSubmit(value);
    onOpenChange(false);
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add link"
      actions={(
        <>
          <button type="button" onClick={() => onOpenChange(false)}>Cancel</button>
          <button type="button" className="primary" onClick={addLink}>Add link</button>
        </>
      )}
    >
      <label className="tdoc-editor-link-field" htmlFor="tdoc-editor-link-url">
        URL
        <input
          id="tdoc-editor-link-url"
          type="url"
          value={url}
          autoFocus
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') addLink(); }}
        />
      </label>
    </AppDialog>
  );
}
