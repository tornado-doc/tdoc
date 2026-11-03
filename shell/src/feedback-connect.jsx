import React, { useEffect, useRef, useState } from 'react';
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
  // Signing in visits pages that cut this window off from the app
  // (Cross-Origin-Opener-Policy), so while it can still hear us, start a
  // claim and tell the app its id (sent only to the app's own origin); the
  // app collects the connection from tdoc if our message never comes. See
  // "Connecting when the popup loses its opener" in the worker.
  // Leaving to sign in waits for the claim to reach the app (a navigation
  // would cancel it), at most a few seconds.
  const claimSent = useRef(Promise.resolve());
  const hasOpener = () => Boolean(window.opener && !window.opener.closed);
  const leaveToSignIn = (event) => {
    const href = event.currentTarget.getAttribute('href');
    if (!href || event.currentTarget.target === '_blank' || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    Promise.race([claimSent.current, new Promise((r) => setTimeout(r, 3000))]).then(() => { location.href = href; });
  };
  useEffect(() => {
    if (!origin || error || !hasOpener()) return;
    claimSent.current = fetch('/api/feedback/connect/claim/new', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin, ...(space ? { space } : {}) }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b && b.claim && hasOpener()) window.opener.postMessage({ type: 'tdoc-feedback-claim', origin, claim: b.claim }, origin);
      })
      .catch(() => {});
  }, [origin, space, error]);
  const [status, setStatus] = useState({ text: '', bad: false, acceptUrl: '' });
  const [docLink, setDocLink] = useState('');
  const [busy, setBusy] = useState(false);

  const say = (text, bad = false, acceptUrl = '') => setStatus({ text, bad, acceptUrl });

  const deliver = (payload) => {
    // Had been filed into someone else's space by its link: this connect gave
    // them their own. Say so, and leave the window up long enough to read.
    const moved = payload && payload.moved
      ? ` Your comments on ${host || 'this app'} now go to your own private space; the ones you left before stay in the space you had joined.`
      : '';
    if (hasOpener()) {
      window.opener.postMessage({ type: 'tdoc-feedback-connected', origin, session: payload }, origin);
      say(`Connected.${moved || ' You can close this window.'}`);
      setTimeout(() => { window.close(); }, moved ? 6000 : 400);
    } else if (payload && payload.claim_filed) {
      // Signing in cut this window off from the app; the app collects the
      // connection from tdoc instead and posts the comment it was holding.
      say(`Connected. Go back to ${host || 'your app'}: your comment will post there.${moved}`);
      setTimeout(() => { try { window.close(); } catch (_) {} }, moved ? 6000 : 1200);
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
        // No opener left: leave the connection with tdoc for the app.
        body: JSON.stringify({ origin, ...(space ? { space } : {}), ...(hasOpener() ? {} : { handoff: 'claim' }), ...extra }),
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
          {doors.oidc ? <a className="fb-btn" href={`/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(returnTo)}`} onClick={leaveToSignIn}>Sign in with {doors.oidcLabel || 'Email'}</a> : null}
          {doors.web ? <a className={`fb-btn${doors.oidc ? ' secondary' : ''}`} href={`/api/auth/web/login?return=${encodeURIComponent(returnTo)}`} onClick={leaveToSignIn}>Sign in with GitHub</a> : null}
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
        <p className="muted">Your comments stay private to you. Joining a teammate's feedback? Ask them to invite you in Share, open their space and click Join, then click the bookmark again.</p>
        <details>
          <summary className="muted">Save to an existing doc instead</summary>
          <p className="muted">Paste a link to a doc of yours, or one you were invited to, and its comments will hold this app's feedback.</p>
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
        onSignIn={() => { if (signInHref) Promise.race([claimSent.current, new Promise((r) => setTimeout(r, 3000))]).then(() => { location.href = signInHref; }); }}
      />
      <main className="fb-main narrow">
        <h1>tdoc Feedback</h1>
        {body}
      </main>
    </div>
  );
}
