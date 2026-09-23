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
        <div className="page-hd" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {avatar ? (
            <img
              src={avatar}
              alt=""
              width={48}
              height={48}
              style={{ borderRadius: 24, display: 'block' }}
            />
          ) : null}
          <div>
            <h1 style={{ margin: 0 }}>@{login}</h1>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              {docs.length} public {docs.length === 1 ? 'doc' : 'docs'}
            </p>
          </div>
        </div>
        {docs.length === 0 ? (
          <p className="empty">No public docs yet.</p>
        ) : (
          <section className="pane">
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
          </section>
        )}
      </main>
    </div>
  );
}
