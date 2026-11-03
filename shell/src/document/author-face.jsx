import React, { useState } from 'react';

// A comment author's picture, or `fallback` (their initial) when it cannot be
// shown. The picture is a URL on somebody else's host (GitHub, Clerk's
// bucket, a CDN): the feedback overlay renders it inside the app's own page,
// whose CSP img-src usually allows none of them (app.hustlefree.ai,
// 2026-11-02: every face was a broken-image icon). A face that fails to load
// shows what a person with no picture gets, never a broken icon.
export function AuthorFace({ src, style, fallback }) {
  // Which src failed, not whether one did: a new src gets its own try, and
  // an error that fires before any effect runs (a CSP block) is not undone.
  const [failed, setFailed] = useState(null);
  if (!src || failed === src) return fallback;
  return <img src={src} alt="" width="24" height="24" style={style} onError={() => setFailed(src)} />;
}
