import React, { useCallback, useRef, useState } from 'react';
import { TopBar } from './top-bar.jsx';
import { BookmarkDemo, Coach, useHandFont } from './feedback-install.jsx';
import './docs-hub.css';
import './feedback-pages.css';

// /feedback/invite/<id> — where an invite to a feedback space lands when
// the site has no tdoc widget of its own (the bookmarklet's spaces). Its
// only job: say who invited them to what, get them the bookmark, and open
// the site. Not the space's page: the comments live on the site (Julie,
// 2026-11-03). Join happens here, signed in on tdoc, and the site opens
// without the invite in its address: it is often not the owner's site, and
// its logs and scripts must not get a one-time key. A site with the widget
// gets its link straight to itself; this page then only opens it.
export function FeedbackInvite({ boot }) {
  const { identity = null, id = '', inviter = 'Someone', host = '', siteUrl = '', site = false, bookmarklet = '', doors = {} } = boot;
  const [coaching, setCoaching] = useState(false);
  const [status, setStatus] = useState({ text: '', bad: false, busy: false });
  const returnTo = `/feedback/invite/${encodeURIComponent(id)}`;
  const signIn = doors.oidc
    ? `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(returnTo)}`
    : doors.web ? `/api/auth/web/login?return=${encodeURIComponent(returnTo)}` : `/?notice=signin`;
  const join = async () => {
    setStatus({ text: 'Joining…', bad: false, busy: true });
    try {
      const response = await fetch('/api/feedback/invite/join', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) { setStatus({ text: (body && (body.message || body.error)) || 'Could not join', bad: true, busy: false }); return; }
      setStatus({ text: `Joined. Opening ${host}…`, bad: false, busy: true });
      location.href = body.site_url || siteUrl;
    } catch (err) {
      setStatus({ text: String((err && err.message) || err), bad: true, busy: false });
    }
  };
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
            <h2>{site ? `Open ${host}` : `Join, and open ${host}`}</h2>
            {site ? (
              <>
                <p className="muted">Then click Join in the tdoc comments.</p>
                <a className="fb-btn" id="open-site" href={siteUrl} rel="noreferrer">Open {host}</a>
              </>
            ) : identity ? (
              <>
                <p className="muted">Signed in as <strong>{identity.name || identity.login}</strong>. Then click the tdoc bookmark there to comment.</p>
                <div className="row">
                  <button type="button" className="fb-btn" id="open-site" disabled={status.busy} onClick={join}>Join and open {host}</button>
                  <span className={status.bad ? 'err' : 'muted'} role="status">{status.text}</span>
                </div>
              </>
            ) : (
              <>
                <p className="muted">Sign in to tdoc to join, then click the tdoc bookmark there to comment.</p>
                <a className="fb-btn" id="sign-in" href={signIn}>Sign in to join</a>
              </>
            )}
          </li>
        </ol>
      </main>
      <Coach open={coaching} target={pill} onClose={close} numbered={false} />
    </div>
  );
}
