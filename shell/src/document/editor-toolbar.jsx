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
  MoreHorizontal,
  ListOrdered,
  Pencil,
  Quote,
  Redo2,
  RotateCcw,
  Save,
  Shapes,
  Undo2,
} from 'lucide-react';
import { AppDialog } from '../ui/dialog.jsx';
import { AppButton } from '../ui/button.jsx';
import { CommentIcon } from '../ui/comment-icon.jsx';
import { AppMenu, AppMenuItem } from '../ui/menu.jsx';
import { formatDraftAge } from './draft-store.js';

export const MODES = [
  { value: 'read', label: 'Read', Icon: Eye },
  { value: 'comment', label: 'Comment', Icon: (props) => <CommentIcon outline {...props} /> },
  { value: 'edit', label: 'Edit', Icon: Pencil },
];

// `signInToComment`: the doc takes comments, but the visitor has no session.
// Let them enter Comment mode; sending the comment is the sign-in boundary.
export function availableModes({ canComment, canEdit, signInToComment = false }) {
  return MODES.filter((option) => (
    option.value === 'read'
    || (option.value === 'comment' && (canComment || signInToComment))
    || (option.value === 'edit' && canEdit)
  ));
}

export function DocumentModeControl({ mode, canComment, canEdit, onChange, signInToComment = false }) {
  const options = availableModes({ canComment, canEdit, signInToComment });
  if (options.length < 2) return !canComment && !signInToComment ? (
    <span className="tdoc-mode-trigger tdoc-mode-readonly" aria-label="Read only; commenting is disabled by the author" title="Commenting is disabled by the author">
      <Eye size={15} /><span className="tdoc-mode-label">Read</span>
    </span>
  ) : null;
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

function ToolButton({ label, icon, command, value, onFormat, pressed, keepFocus = false }) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={pressed === undefined ? undefined : String(Boolean(pressed))}
      // Over a selection the doc keeps focus: a press must not take it first.
      onMouseDown={keepFocus ? (event) => event.preventDefault() : undefined}
      onClick={() => onFormat(command, value)}>
      {icon}
    </button>
  );
}

// proseTools false (a doc that is only its sheet): the bar keeps Undo, Redo,
// the status and Save / Discard, and the sheet's own format row is the only
// formatting row. A prose doc keeps the prose tools.
export function EditorToolbar({ dirty, checking, saving, onFormat, onInsertDiagram, onDiscard, onSave, proseTools = true }) {
  return (
    <div className="tdoc-editor-toolbar" role="toolbar" aria-label="Document editing">
      <div className="tdoc-editor-tools">
        {proseTools ? (<>
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
        <button type="button" title="Insert diagram" aria-label="Insert diagram" onClick={onInsertDiagram}>
          <Shapes size={17} />
        </button>
        <span className="tdoc-editor-divider" />
        </>) : null}
        <ToolButton label="Undo" icon={<Undo2 size={16} />} command="undo" onFormat={onFormat} />
        <ToolButton label="Redo" icon={<Redo2 size={16} />} command="redo" onFormat={onFormat} />
      </div>
      <div className="tdoc-editor-commit">
        <span className="tdoc-editor-status">{checking ? 'Checking changes...' : (dirty ? 'Unsaved draft' : 'No changes')}</span>
        <button type="button" title="Discard draft" aria-label="Discard draft" disabled={!dirty || saving} onClick={onDiscard}>
          <RotateCcw size={15} />
        </button>
        <button type="button" className="primary" aria-label={saving ? 'Saving' : 'Save'} disabled={!dirty || checking || saving} onClick={onSave}>
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
          <AppButton onClick={onKeep}>Keep this version</AppButton>
          <AppButton variant="primary" className="primary" onClick={onRestore}>Restore draft</AppButton>
        </>
      )}
    />
  );
}

// Modeless editing (flag modelessEdit) -------------------------------------
// No Edit mode, no bar: the formatting tools come up over a selection (the
// same buttons and commands as the editor bar above), "/" on an empty line
// opens the block menu (AppMenu), and the bar's status text says where the
// draft is. Both menus are built from one registry (block-commands.js). The
// frame says where (tdoc:bubble / tdoc:slash rects, in its own viewport);
// `frameBox` moves them into the page's.
const BUBBLE_HEIGHT = 40;
// Half its width, to keep it on a phone's screen.
const BUBBLE_HALF_WIDTH = 170;

function CommandItem({ item, current, onPick }) {
  const { Icon } = item;
  return (
    <AppMenuItem className={`tdoc-mode-item${current ? ' current' : ''}`}
      {...(current === undefined ? {} : { role: 'menuitemradio', 'aria-checked': current })}
      onClick={() => onPick(item)}>
      {Icon ? <Icon size={15} /> : null}
      <span>{item.label}</span>
      {current ? <Check className="tdoc-mode-check" size={14} /> : null}
    </AppMenuItem>
  );
}

// [Text ▾] · B · I · link · Comment · [···]: the dropdown turns the block
// into another kind (the registry's turnInto items), ··· holds the rest
// (its insert items).
export function SelectionToolbar({ rect, frameBox, marks = {}, narrow = false, commands, onFormat, onCommand, onComment }) {
  if (!rect || !frameBox) return null;
  const top = frameBox.top + rect.top;
  const bottom = frameBox.top + rect.bottom;
  // Above the selection on a computer; below it on a phone, where the
  // system's own copy / paste menu takes the space above.
  const below = narrow || top - BUBBLE_HEIGHT - 8 < frameBox.top;
  const y = below ? bottom + 8 : top - BUBBLE_HEIGHT - 8;
  if (y < frameBox.top - BUBBLE_HEIGHT || y > window.innerHeight - BUBBLE_HEIGHT) return null;
  const center = frameBox.left + rect.left + rect.width / 2;
  const turnInto = commands.filter((item) => item.kind === 'turnInto');
  const more = commands.filter((item) => item.kind === 'insert');
  const current = turnInto.find((item) => item.id === marks.block) || turnInto[0];
  return (
    <div className="tdoc-editor-toolbar tdoc-editor-bubble" role="toolbar" aria-label="Format selection"
      style={{ top: y, left: Math.max(8 + BUBBLE_HALF_WIDTH, Math.min(window.innerWidth - 8 - BUBBLE_HALF_WIDTH, center)) }}
      onPointerDown={(event) => event.stopPropagation()}>
      <div className="tdoc-editor-tools">
        <AppMenu
          align="start"
          popupClassName="tdoc-block-menu tdoc-turn-into-menu"
          trigger={(
            <button type="button" className="tdoc-block-level" aria-label={`Turn into: ${current?.label || 'Text'}`} title="Turn into">
              <span>{current?.short || 'Text'}</span>
              <ChevronDown size={13} />
            </button>
          )}
        >
          {turnInto.map((item) => <CommandItem key={item.id} item={item} current={item.id === current?.id} onPick={onCommand} />)}
        </AppMenu>
        <span className="tdoc-editor-divider" />
        <ToolButton keepFocus label="Bold" icon={<Bold size={16} />} command="bold" pressed={marks.bold} onFormat={onFormat} />
        <ToolButton keepFocus label="Italic" icon={<Italic size={16} />} command="italic" pressed={marks.italic} onFormat={onFormat} />
        <ToolButton keepFocus label="Add link" icon={<Link size={16} />} command="createLink" onFormat={onFormat} />
        <span className="tdoc-editor-divider" />
        <button type="button" className="tdoc-bubble-comment" title="Comment" aria-label="Comment" onMouseDown={(event) => event.preventDefault()} onClick={onComment}>
          <CommentIcon size={15} outline /> <span>Comment</span>
        </button>
        {more.length ? (
          <AppMenu
            align="end"
            popupClassName="tdoc-block-menu tdoc-insert-menu"
            trigger={(
              <button type="button" className="tdoc-block-more" aria-label="More blocks" title="More">
                <MoreHorizontal size={16} />
              </button>
            )}
          >
            {more.map((item) => <CommandItem key={item.id} item={item} onPick={onCommand} />)}
          </AppMenu>
        ) : null}
      </div>
    </div>
  );
}

// AppMenu, opened at the caret, with every registry item. Arrow keys, Enter,
// Esc and type-to-find are the menu's own; closing without a choice puts the
// caret back after "/".
export function SlashMenu({ rect, frameBox, commands, onPick, onCancel }) {
  const open = Boolean(rect && frameBox);
  const picked = React.useRef(false);
  useEffect(() => {
    if (!open) return undefined;
    picked.current = false;
    // The caret is in the doc's frame; the keys (arrows, Enter, Esc,
    // type-to-find) belong to the menu while it is open.
    const timer = window.setTimeout(() => document.querySelector('.tdoc-slash-menu')?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, rect]);
  if (!open) return null;
  return (
    <AppMenu
      open
      // A pick closes the menu too, and may report the close first.
      onOpenChange={(next) => { if (!next) window.setTimeout(() => { if (!picked.current) onCancel(); }, 0); }}
      align="start"
      popupClassName="tdoc-block-menu tdoc-slash-menu"
      trigger={<span className="tdoc-slash-anchor" aria-hidden="true"
        style={{ top: frameBox.top + rect.top, left: frameBox.left + rect.left, height: rect.height || 18 }} />}
    >
      {commands.map((item) => (
        <CommandItem key={item.id} item={item} onPick={(chosen) => { picked.current = true; onPick(chosen); }} />
      ))}
    </AppMenu>
  );
}

// The one status line beside "Edited …" in the bar: where the draft is.
// Once it is published the slot is empty again and "Edited just now" lights
// up (flashEdited, modeless-edit.jsx). No version numbers here.
const SAVE_STATES = {
  typing: { text: 'Saving…' },
  publishing: { text: 'Saving…' },
  draft: { text: 'Draft · only you can see', title: 'Publishes after 2 min idle or when you leave' },
  conflict: { text: 'Draft · not published', title: 'Someone else just edited this doc. Your changes are kept in this browser.' },
  error: { text: 'Draft · not published yet', title: 'Publishing failed; it tries again shortly. Your changes are kept in this browser.' },
};

export function EditorSaveStatus({ status }) {
  const state = SAVE_STATES[status];
  if (!state) return null;
  return (
    <span className="tdoc-editor-status tdoc-editor-autosave" role="status" title={state.title} data-state={status}>
      {state.text}
    </span>
  );
}

export function SaveConflictDialog({ conflict, onClose }) {
  // Modeless editing says it in the "was just published" strip instead.
  if (conflict?.modeless) return null;
  return (
    <AppDialog
      open={Boolean(conflict)}
      onOpenChange={(open) => !open && onClose()}
      title="A newer version exists"
      description="Your draft is still saved in this browser. Open the latest version to review it before saving again."
      actions={(
        <>
          <AppButton onClick={onClose}>Keep editing</AppButton>
          <AppButton variant="primary" className="primary" onClick={() => { location.href = conflict.latestUrl; }}>
            Open v{conflict?.latestVersion}
          </AppButton>
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
          <AppButton onClick={() => onOpenChange(false)}>Cancel</AppButton>
          <AppButton variant="primary" className="primary" onClick={confirm}>Save and publish</AppButton>
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

export function LinkDialog({ open, onOpenChange, onSubmit, title = 'Add link', submitLabel = 'Add link' }) {
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
      title={title}
      actions={(
        <>
          <AppButton onClick={() => onOpenChange(false)}>Cancel</AppButton>
          <AppButton variant="primary" className="primary" onClick={addLink}>{submitLabel}</AppButton>
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
