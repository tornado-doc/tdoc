import React from 'react';
import { Folder } from 'lucide-react';
import './docs-hub.css';

export function FolderShare({ boot }) {
  const folder = boot.folder || { name: 'Folder' };
  const docs = Array.isArray(boot.docs) ? boot.docs : [];

  return (
    <div className="tdoc-app docs-hub">
      <main className="wrap">
        <div className="page-hd">
          <h1>
            <Folder size={22} style={{ verticalAlign: '-4px', marginRight: 8 }} />
            {folder.name}
          </h1>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
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
