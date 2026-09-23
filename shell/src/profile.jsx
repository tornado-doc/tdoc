import React from 'react';
import './docs-hub.css';

export function Profile({ boot }) {
  const login = boot.handle || boot.login || '';
  const githubLogin = boot.github_login || '';
  const docs = Array.isArray(boot.docs) ? boot.docs : [];
  const avatar = githubLogin
    ? `https://github.com/${encodeURIComponent(githubLogin)}.png?size=96`
    : '';

  return (
    <div className="tdoc-app docs-hub">
      <main className="wrap">
        <div className="page-hd profile-hd">
          {avatar ? (
            <img className="profile-avatar" src={avatar} alt="" width={48} height={48} />
          ) : null}
          <div>
            <h1>@{login}</h1>
            <p className="loc-hint">
              {docs.length} {docs.length === 1 ? 'pick' : 'picks'}
            </p>
          </div>
        </div>
        {docs.length === 0 ? (
          <p className="empty">No public picks yet.</p>
        ) : (
          <section className="pane">
            <div className="doc-list">
              {docs.map((doc) => (
                <a
                  key={doc.slug}
                  className="doc-row"
                  href={doc.url || `/d/${encodeURIComponent(doc.slug)}/v/${doc.latest || 1}`}
                >
                  <div className="doc-info">
                    <span className="doc-title">{doc.title || doc.slug}</span>
                    <div className="doc-meta">{doc.slug}</div>
                  </div>
                </a>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
