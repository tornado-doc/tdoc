import React, { useState } from 'react';
import { TopBar } from './top-bar.jsx';
import './docs-hub.css';
import './feedback-pages.css';

// /feedback/connect?origin=… — the popup the client opens the first time it
// runs on an app. Runs on our origin with the cookie: sign in if needed, make
// or reuse the space, mint a token, hand it back to the opener and close.
// A consent page, so it stays small, but under the same top bar as the rest:
// the account it is about to connect is the avatar in the corner.
export function FeedbackConnect({ boot }) {
  const { origin = null, space = null, identity = null, doors = {}, error = '', baseHost = '' } = boot;
  const host = (() => { try { return new URL(origin).host; } catch { return ''; } })();
  const returnTo = `/feedback/connect?origin=${encodeURIComponent(origin || '')}${space ? `&space=${encodeURIComponent(space)}` : ''}`;
  const [status, setStatus] = useState({ text: '', bad: false, acceptUrl: '' });
  const [docLink, setDocLink] = useState('');
  const [busy, setBusy] = useState(false);

  const say = (text, bad = false, acceptUrl = '') => setStatus({ text, bad, acceptUrl });

  const deliver = (payload) => {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'tdoc-feedback-connected', origin, session: payload }, origin);
      say('Connected. You can close this window.');
      setTimeout(() => { window.close(); }, 400);
    } else {
      say('Connected. Go back to your app and click the tdoc button again.');
    }
  };

  const connect = async (extra = {}) => {
    say('Connecting…');
    setBusy(true);
    try {
      const response = await fetch('/api/feedback/connect', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ origin, ...(space ? { space } : {}), ...extra }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // Invited to the team that owns this space: its page is the
        // invitation, and Accept there joins (#711).
        say((body && (body.message || body.error)) || 'Could not connect', true, (body && body.accept_url) || '');
        return;
      }
      deliver(body);
    } catch (err) {
      say(String((err && err.message) || err), true);
    } finally {
      setBusy(false);
    }
  };

  const connectDoc = () => {
    const m = /\/d\/([^/?#]+)/.exec(docLink.trim());
    if (!m) { say('That is not a doc link', true); return; }
    connect({ slug: decodeURIComponent(m[1]) });
  };

  const signInHref = doors.oidc
    ? `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(returnTo)}`
    : doors.web ? `/api/auth/web/login?return=${encodeURIComponent(returnTo)}` : null;

  let body;
  if (error) {
    body = (
      <>
        <p className="err">{error}</p>
        {origin ? <p><a href={returnTo}>Try again</a></p> : null}
      </>
    );
  } else if (!identity) {
    body = (
      <>
        <p>Sign in so your feedback on <strong>{host}</strong> carries your name.</p>
        <div className="row">
          {doors.oidc ? <a className="fb-btn" href={`/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(returnTo)}`}>Sign in with {doors.oidcLabel || 'Email'}</a> : null}
          {doors.web ? <a className={`fb-btn${doors.oidc ? ' secondary' : ''}`} href={`/api/auth/web/login?return=${encodeURIComponent(returnTo)}`}>Sign in with GitHub</a> : null}
          {!doors.oidc && !doors.web ? (
            <>
              <a className="fb-btn" href="/?notice=signin" target="_blank" rel="opener">Sign in on {baseHost}</a>
              <a className="fb-btn secondary" href={returnTo}>I've signed in</a>
            </>
          ) : null}
        </div>
      </>
    );
  } else {
    const statusLine = (
      <span id="status" className={status.bad ? 'err' : 'muted'} role="status">
        {status.text}
        {status.acceptUrl ? <> <a href={status.acceptUrl} target="_blank" rel="noopener">Open the invitation</a></> : null}
      </span>
    );
    body = space ? (
      // A site's own comment space: nothing to choose, the site chose it.
      <>
        <p>Signed in as <strong>{identity.name || identity.login}</strong>.</p>
        <div className="card">
          <p>Your comments on <strong>{host}</strong> go to the site's comment space, under your name.</p>
          <div className="row"><button type="button" className="fb-btn" id="connect" disabled={busy} onClick={() => connect()}>Continue</button>{statusLine}</div>
        </div>
      </>
    ) : (
      <>
        <p>Signed in as <strong>{identity.name || identity.login}</strong>.</p>
        <div className="card">
          <p>Comments you leave on <strong>{host}</strong> will be saved to your tdoc account, where you can share them and hand them to an agent.</p>
          <div className="row"><button type="button" className="fb-btn" id="connect" disabled={busy} onClick={() => connect()}>Connect</button>{statusLine}</div>
        </div>
        <p className="muted">Joining a teammate's feedback? Open the invite link they sent you first, then click the bookmark again.</p>
        <details>
          <summary className="muted">Save to an existing doc instead</summary>
          <p className="muted">Paste a doc link you can comment on and its comments will hold this app's feedback.</p>
          <div className="row">
            <input id="doc" className="fb-field" placeholder={`https://${baseHost}/d/…/v/1`} value={docLink} onChange={(e) => setDocLink(e.target.value)} />
            <button type="button" className="fb-btn secondary" id="connect-doc" disabled={busy} onClick={connectDoc}>Use this doc</button>
          </div>
        </details>
      </>
    );
  }

  return (
    <div className="tdoc-app docs-hub tdoc-feedback-page">
      <TopBar
        identity={identity}
        authConfigured={Boolean(signInHref)}
        onSignIn={() => { if (signInHref) location.href = signInHref; }}
      />
      <main className="fb-main narrow">
        <h1>tdoc Feedback</h1>
        {body}
      </main>
    </div>
  );
}
