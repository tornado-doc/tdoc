import React from 'react';
import { Folder } from 'lucide-react';
import { TopBar } from './top-bar.jsx';
import './docs-hub.css';

// /f/<share>: a shared folder's list. It used to be the one app page with no
// bar at all — no way home, no account. It has the shared top bar now.
export function FolderShare({ boot }) {
  const folder = boot.folder || { name: 'Folder' };
  const docs = Array.isArray(boot.docs) ? boot.docs : [];

  return (
    <div className="tdoc-app docs-hub tdoc-folder-share">
      <TopBar identity={boot.identity || null} />
      <main className="wrap">
        <div className="page-hd">
          <h1>
            <Folder size={22} className="tdoc-folder-share-icon" aria-hidden="true" />
            {folder.name}
          </h1>
        </div>
        <p className="muted tdoc-folder-share-meta">
          Shared folder · {docs.length} {docs.length === 1 ? 'doc' : 'docs'} you can open
        </p>
        {docs.length === 0 ? (
          <p className="empty">No readable docs in this folder for you.</p>
        ) : (
          <section className="pane">
            {docs.map((doc) => (
              <a key={doc.slug} className="doc-row" href={doc.url || `/d/${encodeURIComponent(doc.slug)}`}>
                <div className="doc-info">
                  <span className="doc-title">{doc.title || doc.slug}</span>
                  <div className="doc-meta">{doc.slug}</div>
                </div>
              </a>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
