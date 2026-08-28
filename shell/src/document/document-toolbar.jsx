import React from 'react';
import {
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  MoreHorizontal,
  Share2,
  Star,
  Trash2,
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
            onClick={() => {
              location.href = `/d/${encodeURIComponent(config.slug)}/v/${version.n}`;
            }}
          >
            <span className={version.n === config.version ? 'current' : ''}>
              v{version.n}{version.n === config.version ? ' · current' : ''}
            </span>
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
        <AppMenuItem data-action="copy" onClick={onCopyMarkdown}>
          <Copy size={14} /> Copy as Markdown
        </AppMenuItem>
        {config.mode === 'published' ? (
          <AppMenuItem data-action="duplicate" onClick={onDuplicate}>
            <Copy size={14} /> Duplicate
          </AppMenuItem>
        ) : null}
        <AppMenuItem data-action="download" onClick={onDownload}>
          <Download size={14} /> Download HTML
        </AppMenuItem>
        <AppMenuItem data-action="download-pdf" onClick={onPrint}>
          <Download size={14} /> Download PDF
        </AppMenuItem>
        {config.ownerManage ? (
          <AppMenuItem data-action="delete" onClick={onDelete}>
            <Trash2 size={14} /> Delete document
          </AppMenuItem>
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
