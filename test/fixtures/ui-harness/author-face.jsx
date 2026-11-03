// Mounts comment faces (card author and margin pin) for
// test/author-face-ui.test.js. The page is served with a CSP whose img-src
// allows only 'self' and data:, as a host app's would.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import { Author } from '../../../shell/src/document/comment-card.jsx';
import { CommentPinFace } from '../../../shell/src/document/comment-pin.jsx';

// Clerk's bucket: what a person signed in by email/GitHub through Clerk carries.
const blocked = { login: 'yayashuxue', name: 'Jingyu Shi (Julie)', avatar_url: 'https://storage.googleapis.com/images.clerk.dev/oauth_github/img_x' };
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const shown = { login: 'dana', name: 'Dana', avatar_url: PIXEL };

createRoot(document.getElementById('root')).render(
  <div style={{ display: 'grid', gap: 12, padding: 16, width: 300 }}>
    <div id="card-blocked" className="tdoc-margin-comment" style={{ position: 'static' }}><Author author={blocked} /></div>
    <div id="card-shown" className="tdoc-margin-comment" style={{ position: 'static' }}><Author author={shown} /></div>
    <div id="pin-blocked" className="tdoc-pin"><CommentPinFace comment={{ id: 'c1', author: blocked }} /></div>
    <div id="pin-shown" className="tdoc-pin"><CommentPinFace comment={{ id: 'c2', author: shown }} /></div>
  </div>,
);
