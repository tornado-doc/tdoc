import React, { useEffect, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Drawer } from '@base-ui/react/drawer';
import {
  Check,
  ChevronRight,
  Copy,
  CopyPlus,
  Download,
  FileDown,
  FolderInput,
  History,
  Send,
  Share2,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { AppMenu, AppMenuItem, AppMenuSeparator, AppSubmenu } from '../ui/menu.jsx';
import { AskIcon } from '../ui/ask-icon.jsx';
import { usePortalContainer } from '../ui/portal.js';

// The label after a version number. "current" read as "latest" from an old
// version (round-4 tester), so the two facts get their own words: where you
// are, and which one is newest.
function versionLabel(n, config) {
  const latest = Math.max(...(config.versions || []).map((v) => Number(v.n) || 0), 0);
  if (n === config.version) return n === latest ? ' · viewing · latest' : ' · viewing';
  return n === latest ? ' · latest' : '';
}

// The bar names the document, and the document's name is its title. The slug
// used to sit here because an agent-picked one reads like a name, but it is a
// URL detail — already in the address bar — and a browser-created doc's slug
// is an opaque id that made a titled document read as untitled. Version and
// title carry the bar now, which is what the narrow layout already did.
// The title in the bar, editable in place by whoever owns the document. Commit
// on Enter or on leaving the field, abandon on Escape; an empty title is not a
// rename, it is a mistake, so it restores instead of clearing the name.
function DocumentTitle({ title, canRename, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef(null);

  useEffect(() => { if (!editing) setDraft(title); }, [title, editing]);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);

  if (!canRename) return <span className="doc-title">{title || 'tdoc'}</span>;

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === title) { setDraft(title); return; }
    onRename(next);
  };

  if (editing) {
    return (
      <input
        ref={input}
        className="doc-title doc-title-input"
        aria-label="Document title"
        maxLength="120"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); }
          if (event.key === 'Escape') { setDraft(title); setEditing(false); }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="doc-title doc-title-edit"
      title="Rename"
      onClick={() => setEditing(true)}
    >
      {title || 'Untitled'}
    </button>
  );
}

// "Edited 3m ago": when the version on screen was made, in words.
export function editedAgo(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'Edited just now';
  if (s < 3600) return `Edited ${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `Edited ${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `Edited ${Math.floor(s / 86400)}d ago`;
  return `Edited ${new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

// The bar's left side after the logo: the document's title, renameable by its
// owner. No space or folder crumbs (they led nowhere -- there is no sidebar
// behind them); the space is the switcher chip on the right, as on My docs.
// Version and star moved: the version is behind "Edited …" on the right, the
// star in ⋯.
export function DocumentBreadcrumbs({ config, title, onRename }) {
  if (config.isLanding) return null;
  return <DocumentTitle title={title} canRename={Boolean(config.isOwner)} onRename={onRename} />;
}

// "Edited 3m ago", muted, on the right: the version on screen. A click lists
// the versions and View changes (it was the v1 chip beside the title).
export function DocumentEdited({ config, onCompare }) {
  if (config.isLanding || config.mode === 'local') return null;
  const current = (config.versions || []).find((v) => Number(v.n) === Number(config.version)) || null;
  const words = editedAgo(current?.created) || `v${config.version}`;
  return (
    <AppMenu
      align="end"
      trigger={(
        <button id="tdoc-version-toggle" type="button" className="tdoc-edited" title={`Version ${config.version}`}>
          {words}
        </button>
      )}
    >
      {[...(config.versions || [])].reverse().map((version) => (
        <AppMenuItem
          key={version.n}
          className={`tdoc-version-item${version.n === config.version ? ' current' : ''}`}
          onClick={() => {
            location.href = `/d/${encodeURIComponent(config.slug)}/v/${version.n}`;
          }}
        >
          v{version.n}{versionLabel(version.n, config)}
        </AppMenuItem>
      ))}
      <AppMenuSeparator />
      <AppMenuItem onClick={onCompare}>View changes</AppMenuItem>
    </AppMenu>
  );
}

export function DocumentPrimaryAction({
  config,
  onPublish,
  onShare,
}) {
  return config.mode === 'local' ? (
    <button id="tdoc-publish-btn" type="button" className="primary tdoc-document-primary" aria-label="Publish" onClick={onPublish}>
      <Upload size={14} /> <span>Publish</span>
    </button>
  ) : (
    <button id="tdoc-share-btn" type="button" className="tdoc-share-quiet tdoc-document-primary" aria-label="Share" onClick={onShare}>
      <Share2 size={15} /> <span>Share</span>
    </button>
  );
}

// Send to agent, one click: opens the Send dialog with the comments ready to
// hand off. It sits beside Ask AI (desktop bar) or in the comments drawer
// header (phone), so sending never hides inside the Ask AI panel.
export function DocumentSendToAgentButton({ count = 0, onClick }) {
  const label = count > 0 ? `Send to agent (${count} ready)` : 'Send to agent';
  return (
    <button
      id="tdoc-send-plane-btn"
      type="button"
      className="tdoc-send-plane-action"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Send size={16} aria-hidden="true" />
      {count > 0 ? (
        <span className="tdoc-send-plane-badge">{count > 99 ? '99+' : count}</span>
      ) : null}
    </button>
  );
}

// One document-level entry for handoff activity and unsent comments. The
// comment card itself carries the state of that one comment.
export function DocumentSendAgentAction({ counts = {}, unread = 0, open, onOpenChange, narrow = false, children }) {
  const portalContainer = usePortalContainer();
  const [visibleViewport, setVisibleViewport] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const dragStart = useRef(null);
  const dragged = useRef(false);
  useEffect(() => {
    if (!narrow || !open) return undefined;
    const visual = window.visualViewport;
    const update = () => {
      const height = Math.round(visual?.height || window.innerHeight);
      if (window.innerHeight - height > 100) setExpanded(true);
      setVisibleViewport({
        bottom: Math.max(0, window.innerHeight - ((visual?.offsetTop || 0) + height)),
        height,
      });
    };
    update();
    visual?.addEventListener('resize', update);
    visual?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      visual?.removeEventListener('resize', update);
      visual?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [narrow, open]);
  const ready = counts.ready || 0;
  const waiting = (counts.waiting || 0) + (counts.received || 0);
  const failed = counts.failed || 0;
  const details = [
    ready ? `${ready} to send` : null,
    waiting ? `${waiting} waiting for agent` : null,
    unread ? `${unread} new agent ${unread === 1 ? 'reply' : 'replies'}` : null,
    failed ? `${failed} not delivered` : null,
  ].filter(Boolean).join(' · ');
  const label = `Ask AI${details ? ` · ${details}` : ''}`;
  const triggerContents = <>
    <AskIcon className="tdoc-ask-ai-mark" size={18} color="var(--td-accent, #1652f0)" />
    <span className="tdoc-ask-ai-label">Ask AI</span>
    {unread ? <span className="tdoc-send-agent-badge is-unread" aria-hidden="true" />
      : ready ? <span className="tdoc-send-agent-badge is-ready" aria-hidden="true" /> : null}
  </>;
  const triggerProps = { id: 'tdoc-send-agent-btn', type: 'button', className: 'tdoc-send-agent-action', 'aria-label': label, title: label };
  if (narrow) return <Drawer.Root open={open} onOpenChange={(next) => { if (!next) setExpanded(false); onOpenChange(next); }} swipeDirection="down">
    <Drawer.Trigger {...triggerProps}>{triggerContents}</Drawer.Trigger>
    <Drawer.Portal container={portalContainer}>
      <Drawer.Backdrop className="tdoc-ask-drawer-backdrop" />
      <Drawer.Viewport className="tdoc-ask-drawer-viewport">
        <Drawer.Popup className="tdoc-ask-mobile-drawer" style={{ bottom: visibleViewport?.bottom ?? 0, height: Math.max(120, expanded ? (visibleViewport?.height || 600) - 48 : (visibleViewport?.height || 600) * 0.7 - 8) }}>
          <Drawer.Title className="tdoc-visually-hidden">Ask AI</Drawer.Title>
          <button type="button" className="tdoc-ask-drawer-grip" aria-label={expanded ? 'Collapse Ask AI' : 'Expand Ask AI'}
            onClick={() => { if (!dragged.current) setExpanded(!expanded); dragged.current = false; }}
            onPointerDown={(event) => { dragStart.current = event.clientY; dragged.current = false; event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerUp={(event) => {
              if (dragStart.current != null && Math.abs(dragStart.current - event.clientY) > 48) {
                dragged.current = true;
                setExpanded(event.clientY < dragStart.current);
              }
              dragStart.current = null;
            }}><span /></button>
          <Drawer.Close className="tdoc-ask-drawer-close" aria-label="Close Ask AI">×</Drawer.Close>
          <Drawer.Content className="tdoc-ask-drawer-content">{children}</Drawer.Content>
        </Drawer.Popup>
      </Drawer.Viewport>
    </Drawer.Portal>
  </Drawer.Root>;
  return <Popover.Root open={open} onOpenChange={onOpenChange}>
    <Popover.Trigger {...triggerProps}>{triggerContents}</Popover.Trigger>
    <Popover.Portal container={portalContainer}>
      <Popover.Positioner side="bottom" align="end" sideOffset={narrow ? 8 : 48} collisionPadding={8} positionMethod="fixed" className="tdoc-picker-positioner">
        <Popover.Popup className="tdoc-handoff-popover" aria-label="Ask AI">
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

export function DocumentOverflowActions({
  config,
  starred,
  onToggleStar,
  onPublish,
  onShare,
  onCopyMarkdown,
  onDuplicate,
  onDownload,
  onPrint,
  onMoveDocument,
  onDelete,
  onCompare,
  // Read / Comment / Edit, at the top of ⋯ with the current one ticked
  // (it was a dropdown in the bar): { modes: [{ value, label, Icon }], value, onChange }.
  mode = null,
}) {
  return (
    <>
      {mode && mode.modes.length > 1 ? (
        <>
          <div className="tdoc-menu-label">Mode</div>
          {mode.modes.map((option) => {
            const Icon = option.Icon;
            const selected = option.value === mode.value;
            return (
              <AppMenuItem
                key={option.value}
                className={`tdoc-action-menu-item tdoc-mode-item${selected ? ' current' : ''}`}
                role="menuitemradio"
                aria-checked={selected}
                data-action={`mode-${option.value}`}
                onClick={() => mode.onChange(option.value)}
              >
                <Icon size={15} /> <span>{option.label}</span>
                {selected ? <Check className="tdoc-mode-check" size={14} /> : null}
              </AppMenuItem>
            );
          })}
          <AppMenuSeparator />
        </>
      ) : null}
      <AppMenuItem className="tdoc-action-menu-item" data-action="compare" onClick={onCompare}>
        <History size={15} /> View changes
      </AppMenuItem>
      {config.mode === 'local' ? (
        <AppMenuItem className="tdoc-action-menu-item tdoc-mobile-overflow-only" data-action="publish" onClick={onPublish}>
          <Upload size={15} /> Publish
        </AppMenuItem>
      ) : (
        <AppMenuItem className="tdoc-action-menu-item tdoc-mobile-overflow-only" data-action="share" onClick={onShare}>
          <Share2 size={15} /> Share
        </AppMenuItem>
      )}
      {(config.versions || []).length > 1 ? (
        <AppSubmenu
          className="tdoc-action-menu-item tdoc-version-submenu-trigger"
          popupClassName="tdoc-version-submenu"
          trigger={(
            <>
              <History size={15} />
              <span>Versions</span>
              <span className="tdoc-version-submenu-current">v{config.version}</span>
              <ChevronRight className="tdoc-submenu-chevron" size={14} />
            </>
          )}
        >
          {[...(config.versions || [])].reverse().map((version) => (
            <AppMenuItem
              key={version.n}
              className={`tdoc-version-item${version.n === config.version ? ' current' : ''}`}
              onClick={() => { location.href = `/d/${encodeURIComponent(config.slug)}/v/${version.n}`; }}
            >
              v{version.n}{versionLabel(version.n, config)}
            </AppMenuItem>
          ))}
        </AppSubmenu>
      ) : null}
      {config.viewerStar ? (
        <AppMenuItem className="tdoc-action-menu-item" data-action="star" onClick={onToggleStar}>
          <Star size={15} fill={starred ? 'currentColor' : 'none'} />
          {starred ? 'Remove from starred' : 'Add to starred'}
        </AppMenuItem>
      ) : null}
      {/* Four groups: what this doc is, how to take a copy of it, the app, the
          account. Thirteen flat rows made every one of them cost a read. The
          separator carries tdoc-mobile-overflow-only because everything above
          it does — on a desktop that group is not rendered, and a rule floating
          at the top of the menu would be the only thing left of it. */}
      <AppMenuSeparator />
      {/* One row instead of three. Taking a copy of the document is a single
          intent; which format is a detail that belongs one level down.
          Duplicate stays out here — it makes a new document on tdoc, which is
          not "take this one away". */}
      <AppSubmenu
        className="tdoc-action-menu-item tdoc-export-submenu-trigger"
        trigger={(
          <>
            <Download size={15} />
            <span>Download &amp; copy</span>
            <ChevronRight className="tdoc-submenu-chevron" size={14} />
          </>
        )}
      >
        <AppMenuItem className="tdoc-action-menu-item" data-action="copy" onClick={onCopyMarkdown}>
          <Copy size={15} /> Copy as Markdown
        </AppMenuItem>
        <AppMenuItem className="tdoc-action-menu-item" data-action="download" onClick={onDownload}>
          <Download size={15} /> Download HTML
        </AppMenuItem>
        <AppMenuItem className="tdoc-action-menu-item" data-action="download-pdf" onClick={onPrint}>
          <FileDown size={15} /> Download PDF
        </AppMenuItem>
      </AppSubmenu>
      {config.mode === 'published' ? (
        <AppMenuItem className="tdoc-action-menu-item" data-action="duplicate" onClick={onDuplicate}>
          <CopyPlus size={15} /> Duplicate
        </AppMenuItem>
      ) : null}
      {onMoveDocument || config.ownerManage ? <AppMenuSeparator /> : null}
      {onMoveDocument ? (
        <AppMenuItem className="tdoc-action-menu-item" data-action="move-document" onClick={onMoveDocument}>
          <FolderInput size={15} /> Move document…
        </AppMenuItem>
      ) : null}
      {config.ownerManage ? (
        <AppMenuItem className="tdoc-action-menu-item" data-action="delete" tone="danger" onClick={onDelete}>
          <Trash2 size={15} /> Delete doc…
        </AppMenuItem>
      ) : null}
    </>
  );
}

// The landing bar's GitHub entry: the mark itself plus the live star count,
// exactly as the pre-React bar drew it (chrome.css styles .tdoc-github-btn /
// .tdoc-gh-stars). Both marks are inlined rather than taken from the icon set:
// lucide dropped brand icons, and a generic "external link" glyph reads as a
// share control, not as GitHub.
const GITHUB_MARK = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z';
const STAR_MARK = 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';

function starCount(stars) {
  if (typeof stars !== 'number' || stars < 0) return null;
  return stars >= 1000 ? `${(stars / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(stars);
}

export function LandingActions({ stars }) {
  const count = starCount(stars);
  return (
    <>
    <a
      id="tdoc-github-btn"
      className="tdoc-github-btn"
      href="https://github.com/tornado-doc/tdoc"
      target="_blank"
      rel="noopener noreferrer"
      title={count === null ? 'tdoc on GitHub' : `${stars} stars on GitHub`}
      aria-label="tdoc on GitHub"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d={GITHUB_MARK} />
      </svg>
      {count === null ? null : (
        <span className="tdoc-gh-stars">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d={STAR_MARK} />
          </svg>
          {count}
        </span>
      )}
    </a>
    </>
  );
}
