import React from 'react';
import { TopBar } from './top-bar.jsx';
import { FeedbackSharePanel } from './feedback-share-panel.jsx';
import './docs-hub.css';
import './feedback-pages.css';

async function sameOriginRequest(path, init = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error((body && (body.message || body.error)) || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

// /feedback/share/<slug>: the same Share in a small tdoc window, opened by
// the widget's Share on a site that is not the owner's own.
export function FeedbackShare({ boot }) {
  const { slug, identity = null } = boot;
  return (
    <div className="tdoc-app docs-hub tdoc-feedback-page">
      <TopBar identity={identity} />
      <FeedbackSharePanel slug={slug} open request={sameOriginRequest} onClose={() => { try { window.close(); } catch (_) {} }} />
    </div>
  );
}
