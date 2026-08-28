import React from 'react';
import {
  ChevronDown,
  ExternalLink,
  MoreHorizontal,
  Share2,
  Star,
  Upload,
} from 'lucide-react';
import { AppMenu, AppMenuItem } from '../ui/menu.jsx';

export function DocumentBreadcrumbs({ config, starred, onToggleStar }) {
  if (config.isLanding) return null;

  return (
    <>
      <span className="crumb crumb-slug">{config.slug}</span>
      <span className="crumb-sep">/</span>
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
          onClick={onToggleStar}
        >
          <Star size={15} fill={starred ? 'currentColor' : 'none'} />
        </button>
      ) : null}
    </>
  );
}

export function DocumentActions({
  config,
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
        <button id="tdoc-publish-btn" type="button" className="primary" onClick={onPublish}>
          <Upload size={14} /> <span>Publish</span>
        </button>
      ) : (
        <button id="tdoc-share-btn" type="button" className="primary" onClick={onShare}>
          <Share2 size={14} /> <span>Share</span>
        </button>
      )}
      <AppMenu
        trigger={(
          <button id="tdoc-more-btn" type="button" className="tdoc-secondary-toggle" aria-label="More actions">
            <MoreHorizontal size={17} />
          </button>
        )}
      >
        <AppMenuItem data-action="copy" onClick={onCopyMarkdown}>Copy as Markdown</AppMenuItem>
        {config.mode === 'published' ? (
          <AppMenuItem data-action="duplicate" onClick={onDuplicate}>Duplicate</AppMenuItem>
        ) : null}
        <AppMenuItem data-action="download" onClick={onDownload}>Download HTML</AppMenuItem>
        <AppMenuItem data-action="download-pdf" onClick={onPrint}>Download PDF</AppMenuItem>
        {config.ownerManage ? (
          <AppMenuItem data-action="delete" tone="danger" onClick={onDelete}>Delete doc…</AppMenuItem>
        ) : null}
      </AppMenu>
    </>
  );
}

export function LandingActions() {
  return (
    <a
      className="icon-btn"
      href="https://github.com/tornado-doc/tdoc"
      target="_blank"
      rel="noreferrer"
      title="tdoc on GitHub"
      aria-label="tdoc on GitHub"
    >
      <ExternalLink size={16} />
    </a>
  );
}
