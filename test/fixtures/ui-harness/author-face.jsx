// Mounts comment faces (card author and margin pin) for
// test/author-face-ui.test.js. The page is served with a CSP whose img-src
// allows only 'self' and data:, as a host app's would.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import { Author } from '../../../shell/src/document/comment-card.jsx';
import { CommentPinFace } from '../../../shell/src/document/comment-pin.jsx';
import { AuthorAvatar } from '../../../shell/src/document/author-face.jsx';
import { TDOC_AI } from '../../../shell/src/document/ai-answerer.js';

// Clerk's bucket: what a person signed in by email/GitHub through Clerk carries.
const blocked = { login: 'yayashuxue', name: 'Jingyu Shi (Julie)', avatar_url: 'https://storage.googleapis.com/images.clerk.dev/oauth_github/img_x' };
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const shown = { login: 'dana', name: 'Dana', avatar_url: PIXEL };
// tdoc AI as the worker signs its answer in a thread (a picture on tdoc's
// host, which a host CSP may block too), as the Ask AI panel signs its
// answer, an agent reply kept before tdoc stored who wrote it, and an agent
// with real provider info.
const tdocAi = { kind: 'agent', login: 'tdoc-ai', name: 'tdoc AI', avatar_url: 'https://tdoc.dev/tdoc_logo.png' };
const askAi = { ...TDOC_AI, kind: 'agent', handle: 'tdoc AI', login: 'tdoc AI' };
const unknownAgent = { kind: 'agent', login: 'agent', name: 'Agent' };
const claude = { kind: 'agent', login: 'claude', name: 'Claude Code', provider: 'local', cli: 'claude' };
const face = (size, author) => <span className="tdoc-notif-avatar" style={{ width: size, height: size }}><AuthorAvatar author={author} size={0} /></span>;

createRoot(document.getElementById('root')).render(
  <div style={{ display: 'grid', gap: 12, padding: 16, width: 300 }}>
    <div id="card-blocked" className="tdoc-margin-comment" style={{ position: 'static' }}><Author author={blocked} /></div>
    <div id="card-shown" className="tdoc-margin-comment" style={{ position: 'static' }}><Author author={shown} /></div>
    <div id="pin-blocked" className="tdoc-pin"><CommentPinFace comment={{ id: 'c1', author: blocked }} /></div>
    <div id="pin-shown" className="tdoc-pin"><CommentPinFace comment={{ id: 'c2', author: shown }} /></div>
    <div id="card-tdoc-ai" className="tdoc-margin-comment" style={{ position: 'static' }}><Author author={tdocAi} /></div>
    <div id="card-ask-ai" className="tdoc-margin-comment" style={{ position: 'static' }}><Author author={askAi} /></div>
    <div id="card-unknown-agent" className="tdoc-margin-comment" style={{ position: 'static' }}><Author author={unknownAgent} /></div>
    <div id="card-claude" className="tdoc-margin-comment" style={{ position: 'static' }}><Author author={claude} /></div>
    <div id="pin-tdoc-ai" className="tdoc-pin"><CommentPinFace comment={{ id: 'c3', author: tdocAi }} /></div>
    <div id="face-16">{face(16, tdocAi)}</div>
    <div id="face-32">{face(32, tdocAi)}</div>
  </div>,
);
