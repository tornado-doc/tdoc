import React, { useCallback, useRef, useState } from 'react';
import { TopBar } from './top-bar.jsx';
import { BookmarkDemo, Coach, useHandFont } from './feedback-install.jsx';
import './docs-hub.css';
import './feedback-pages.css';

// /feedback/invite/<id> — where an invite to a feedback space lands when
// the site has no tdoc widget of its own (the bookmarklet's spaces). Its
// only job: say who invited them to what, get them the bookmark, and open
// the site with the invite in the link, where the bookmark asks Join. Not
// the space's page: the comments live on the site (Julie, 2026-11-03).
// A site with the widget gets a link straight to itself; this page then
// only has the one step.
export function FeedbackInvite({ boot }) {
  const { identity = null, inviter = 'Someone', host = '', siteUrl = '', site = false, bookmarklet = '' } = boot;
  const [coaching, setCoaching] = useState(false);
  const pill = useRef(null);
  useHandFont();
  const close = useCallback(() => setCoaching(false), []);
  return (
    <div className={`tdoc-app docs-hub tdoc-feedback-page${coaching ? ' coaching' : ''}`}>
      <TopBar identity={identity} />
      <main className="fb-main narrow fb-invite">
        <h1>{inviter} invited you to comment on {host}</h1>
        <p className="muted">You comment on the page itself: click anything on {host} and say what you see. {inviter} sees it there too.</p>
        <ol className="fb-invite-steps">
          {site ? null : (
            <li className="fb-invite-step" id="step-bookmark">
              <h2>Drag the tdoc bookmark to your bookmarks bar</h2>
              <p className="phone-only"><strong>On a computer.</strong> The bookmark needs a bookmarks bar: open this link on a computer.</p>
              <div className="install-desktop">
                <BookmarkDemo bookmarklet={bookmarklet} omnibox={host} coaching={coaching} pillRef={pill} onTeach={() => setCoaching(true)} hint="Drag me ↑" />
                <p className="muted">No bookmarks bar? Press <kbd>⌘⇧B</kbd>. Already have the bookmark? Go to the next step.</p>
              </div>
            </li>
          )}
          <li className="fb-invite-step" id="step-open">
            <h2>Open {host}</h2>
            <p className="muted">{site ? 'Then click Join in the tdoc comments.' : 'Then click the tdoc bookmark there, and Join.'}</p>
            <a className="fb-btn" id="open-site" href={siteUrl} rel="noreferrer">Open {host}</a>
          </li>
        </ol>
      </main>
      <Coach open={coaching} target={pill} onClose={close} numbered={false} />
    </div>
  );
}
