import React from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  CopyPlus,
  Download,
  FileDown,
  History,
  Share2,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { AppMenu, AppMenuItem, AppSubmenu } from '../ui/menu.jsx';

// The bar names the document, and the document's name is its title. The slug
// used to sit here because an agent-picked one reads like a name, but it is a
// URL detail — already in the address bar — and a browser-created doc's slug
// is an opaque id that made a titled document read as untitled. Version and
// title carry the bar now, which is what the narrow layout already did.
export function DocumentBreadcrumbs({ config, starred, onToggleStar }) {
  if (config.isLanding) return null;

  return (
    <>
      <AppMenu
        align="start"
        trigger={(
          <button id="tdoc-version-toggle" type="button" className="tdoc-version-toggle">
            v{config.version}
            {config.versions?.length > 1 ? <ChevronDown size={11} /> : null}
          </button>
        )}
      >
        {(config.versions || []).map((version) => (
          <AppMenuItem
            key={version.n}
            className={`tdoc-version-item${version.n === config.version ? ' current' : ''}`}
            onClick={() => {
              location.href = `/d/${encodeURIComponent(config.slug)}/v/${version.n}`;
            }}
          >
            v{version.n}{version.n === config.version ? ' · current' : ''}
          </AppMenuItem>
        ))}
      </AppMenu>
      <span className="doc-title">{config.title || 'tdoc'}</span>
      {config.viewerStar ? (
        <button
          id="tdoc-star-btn"
          type="button"
          className={`tdoc-star-btn${starred ? ' is-starred' : ''}`}
          aria-pressed={starred}
          aria-label={starred ? 'Remove from starred' : 'Add to starred'}
          onClick={onToggleStar}
        >
          <Star size={15} fill={starred ? 'currentColor' : 'none'} />
        </button>
      ) : null}
    </>
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
    <button id="tdoc-share-btn" type="button" className="primary tdoc-document-primary" aria-label="Share" onClick={onShare}>
      <Share2 size={14} /> <span>Share</span>
    </button>
  );
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
  onDelete,
}) {
  return (
    <>
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
          className="tdoc-action-menu-item tdoc-mobile-overflow-only tdoc-version-submenu-trigger"
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
              v{version.n}{version.n === config.version ? ' · current' : ''}
            </AppMenuItem>
          ))}
        </AppSubmenu>
      ) : null}
      {config.viewerStar ? (
        <AppMenuItem className="tdoc-action-menu-item tdoc-mobile-overflow-only" data-action="star" onClick={onToggleStar}>
          <Star size={15} fill={starred ? 'currentColor' : 'none'} />
          {starred ? 'Remove from starred' : 'Add to starred'}
        </AppMenuItem>
      ) : null}
      <AppMenuItem className="tdoc-action-menu-item" data-action="copy" onClick={onCopyMarkdown}>
        <Copy size={15} /> Copy as Markdown
      </AppMenuItem>
      {config.mode === 'published' ? (
        <AppMenuItem className="tdoc-action-menu-item" data-action="duplicate" onClick={onDuplicate}>
          <CopyPlus size={15} /> Duplicate
        </AppMenuItem>
      ) : null}
      <AppMenuItem className="tdoc-action-menu-item" data-action="download" onClick={onDownload}>
        <Download size={15} /> Download HTML
      </AppMenuItem>
      <AppMenuItem className="tdoc-action-menu-item" data-action="download-pdf" onClick={onPrint}>
        <FileDown size={15} /> Download PDF
      </AppMenuItem>
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
  );
}
