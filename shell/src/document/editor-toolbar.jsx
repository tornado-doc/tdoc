import React, { useEffect, useState } from 'react';
import {
  Bold,
  Check,
  ChevronDown,
  Code,
  Eye,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  Pencil,
  Quote,
  Redo2,
  RotateCcw,
  Save,
  Undo2,
} from 'lucide-react';
import { AppDialog } from '../ui/dialog.jsx';
import { CommentIcon } from '../ui/comment-icon.jsx';
import { AppMenu, AppMenuItem } from '../ui/menu.jsx';
import { formatDraftAge } from './draft-store.js';

const MODES = [
  { value: 'read', label: 'Read', Icon: Eye },
  { value: 'comment', label: 'Comment', Icon: CommentIcon },
  { value: 'edit', label: 'Edit', Icon: Pencil },
];

// `signInToComment`: the doc takes comments, this visitor has no session. The
// Comment option still shows — the door has to be where the person looks for
// it, not hidden behind a Sign in button in the corner — and choosing it opens
// the sign-in instead of the mode.
export function DocumentModeControl({ mode, canComment, canEdit, onChange, signInToComment = false, onSignIn }) {
  const options = MODES.filter((option) => (
    option.value === 'read'
    || (option.value === 'comment' && (canComment || signInToComment))
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
            onClick={() => (
              option.value === 'comment' && !canComment && signInToComment
                ? onSignIn?.()
                : onChange(option.value)
            )}
          >
            <Icon size={15} />
            <span>{option.value === 'comment' && !canComment && signInToComment ? 'Sign in to comment' : option.label}</span>
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

export function EditorToolbar({ dirty, checking, saving, onFormat, onDiscard, onSave }) {
  return (
    <div className="tdoc-editor-toolbar" role="toolbar" aria-label="Text formatting">
      <div className="tdoc-editor-tools">
        <ToolButton label="Bold" icon={<Bold size={16} />} command="bold" onFormat={onFormat} />
        <ToolButton label="Italic" icon={<Italic size={16} />} command="italic" onFormat={onFormat} />
        <span className="tdoc-editor-divider" />
        <ToolButton label="Heading 1" icon={<Heading1 size={17} />} command="formatBlock" value="h1" onFormat={onFormat} />
        <ToolButton label="Heading 2" icon={<Heading2 size={17} />} command="formatBlock" value="h2" onFormat={onFormat} />
        <ToolButton label="Heading 3" icon={<Heading3 size={17} />} command="formatBlock" value="h3" onFormat={onFormat} />
        <ToolButton label="Bullet list" icon={<List size={16} />} command="insertUnorderedList" onFormat={onFormat} />
        <ToolButton label="Numbered list" icon={<ListOrdered size={16} />} command="insertOrderedList" onFormat={onFormat} />
        <ToolButton label="Quote" icon={<Quote size={16} />} command="formatBlock" value="blockquote" onFormat={onFormat} />
        <ToolButton label="Inline code" icon={<Code size={16} />} command="code" onFormat={onFormat} />
        <ToolButton label="Add link" icon={<Link size={16} />} command="createLink" onFormat={onFormat} />
        <span className="tdoc-editor-divider" />
        <ToolButton label="Undo" icon={<Undo2 size={16} />} command="undo" onFormat={onFormat} />
        <ToolButton label="Redo" icon={<Redo2 size={16} />} command="redo" onFormat={onFormat} />
      </div>
      <div className="tdoc-editor-commit">
        <span className="tdoc-editor-status">{checking ? 'Checking changes...' : (dirty ? 'Unsaved draft' : 'No changes')}</span>
        <button type="button" title="Discard draft" aria-label="Discard draft" disabled={!dirty || saving} onClick={onDiscard}>
          <RotateCcw size={15} />
        </button>
        <button type="button" className="primary" disabled={!dirty || checking || saving} onClick={onSave}>
          <Save size={15} /> <span>{saving ? 'Saving...' : 'Save'}</span>
        </button>
      </div>
    </div>
  );
}

export function StaleDraftDialog({ draft, currentVersion, onRestore, onKeep }) {
  if (!draft) return null;
  const age = formatDraftAge(draft.updatedAt);
  const fromOtherVersion = Number(draft.baseVersion) > 0
    && Number(draft.baseVersion) !== Number(currentVersion);
  const description = fromOtherVersion
    ? `You have a draft from ${age}, started on v${draft.baseVersion}. Restore it, or keep the version on the page.`
    : `You have a draft from ${age}. Restore it, or keep the version on the page.`;
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onKeep(); }}
      title="A draft of this document is saved here"
      description={description}
      actions={(
        <>
          <button type="button" onClick={onKeep}>Keep this version</button>
          <button type="button" className="primary" onClick={onRestore}>Restore draft</button>
        </>
      )}
    />
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

// Save writes a new version, and on a published doc that version is instantly
// the one the shared link resolves to. Nothing said so before the click. This
// says it once; the checkbox is the author telling us they have understood,
// and it is remembered per browser so the explanation never becomes a nag.
//
// The flag lives in localStorage, which throws in some privacy modes and comes
// back empty in others. Both are read as "not dismissed yet": showing the
// explanation one extra time is harmless, and a save that never happens
// because storage threw is not.
const SAVE_NOTICE_KEY = 'tdoc-save-notice-dismissed';

export function saveNoticeDismissed() {
  try {
    return localStorage.getItem(SAVE_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

export function SaveNoticeDialog({ open, onOpenChange, onConfirm }) {
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (open) setRemember(false);
  }, [open]);

  const confirm = () => {
    if (remember) {
      try { localStorage.setItem(SAVE_NOTICE_KEY, '1'); } catch {}
    }
    onOpenChange(false);
    onConfirm();
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Saving publishes a new version"
      description="Your draft becomes the next version of this document. If you have shared the link, that is what people see from now on — earlier versions stay reachable, and comments stay on the text they were left on."
      actions={(
        <>
          <button type="button" onClick={() => onOpenChange(false)}>Cancel</button>
          <button type="button" className="primary" onClick={confirm}>Save and publish</button>
        </>
      )}
    >
      <label className="tdoc-save-remember">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        Don&rsquo;t show this again
      </label>
    </AppDialog>
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
