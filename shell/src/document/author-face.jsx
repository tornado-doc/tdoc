import React, { useState } from 'react';
import { ProviderMark } from './notify-handoff.jsx';
import { avatarFor, avatarInitial } from './model.js';

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

const faceSize = (size) => (size ? { width: size, height: size, maxWidth: size, maxHeight: size } : undefined);

// Whoever wrote a comment or reply, as its card shows them (comment-card.jsx
// Author): an agent with a provider wears its program's mark (Claude, Codex,
// Raft, ...), anyone else their picture (avatarFor: an older agent reply's
// runtime logo, tdoc's mark) or their initial. Every surface that names a
// comment's author -- the thread, My docs' Needs you, the notifications
// list, a team's comments -- draws them with this. `size`: px for the
// picture; 0 leaves the size to the surface's stylesheet (which always sizes
// the mark: .tdoc-agent-provider-mark).
export function AuthorAvatar({ author, size = 24 }) {
  if (author && author.kind === 'agent' && author.provider) {
    return (
      <span className="tdoc-agent-provider-mark" aria-hidden="true">
        <ProviderMark target={author} size={18} />
      </span>
    );
  }
  const initial = <span className="tdoc-avatar-fallback" aria-hidden="true">{avatarInitial(author)}</span>;
  return <AuthorFace src={avatarFor(author)} style={faceSize(size)} fallback={initial} />;
}
