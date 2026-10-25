import React, { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import './teams.css';

// Settings -> Sign-in methods (#58). What this account can sign in with: the
// verified addresses that reach it and the GitHub account linked to it.
// Connect goes through GitHub's account picker and links the chosen account
// to THIS account (the server refuses one that belongs to another account);
// Disconnect is offered only while another way in remains.

const NOTICES = {
  github: 'GitHub connected.',
};

export function SignInMethodsCard() {
  const [methods, setMethods] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(() => {
    const q = new URLSearchParams(location.search);
    return NOTICES[q.get('connected')] || '';
  });

  const [hidden, setHidden] = useState(false);
  const load = () => fetch('/api/me/sign-in-methods', { credentials: 'same-origin' })
    .then((r) => {
      // No account on this host (self-hosted, or nothing created yet): there
      // is nothing to manage, so the card stays out of the way.
      if (r.status === 401 || r.status === 403 || r.status === 404) { setHidden(true); return null; }
      return r.ok ? r.json() : Promise.reject(new Error(String(r.status)));
    })
    .then((data) => { if (data) setMethods(data); })
    .catch(() => setNotice('Could not load sign-in methods. Reload and try again.'));
  useEffect(() => { load(); }, []);

  const post = async (path, body) => {
    const r = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
    return data;
  };

  const connect = async () => {
    setBusy(true);
    setNotice('');
    try {
      const { url } = await post('/api/me/sign-in-methods/github/connect', { return: '/me?view=settings#sign-in-methods' });
      location.assign(url);
    } catch (err) {
      setNotice(err.message);
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setNotice('');
    try {
      await post('/api/me/sign-in-methods/github/disconnect');
      setNotice('GitHub disconnected.');
      await load();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  };

  const gh = methods && methods.github;
  if (hidden) return null;
  return (
    <section className="tm-settings-card" id="sign-in-methods">
      <div className="tm-settings-head"><div><h2>Sign-in methods</h2><p>The ways you can sign in to this account.</p></div></div>
      {!methods ? (
        notice ? null : <p className="tm-sim-muted">Loading…</p>
      ) : (
        <ul className="tm-sim-list">
          {methods.emails.map((email) => (
            <li key={email}>
              <span className="tm-sim-icon"><Mail size={18} aria-hidden="true" /></span>
              <span className="tm-sim-main"><b>Email</b><span>{email}</span></span>
            </li>
          ))}
          <li>
            {gh ? (
              <img className="tm-sim-avatar" src={gh.avatar_url} width="28" height="28" alt="" />
            ) : (
              <span className="tm-sim-icon"><GithubMark /></span>
            )}
            <span className="tm-sim-main">
              <b>GitHub</b>
              <span>{gh ? `@${gh.login || gh.id}` : 'Not connected'}</span>
            </span>
            {gh ? (
              methods.can_disconnect_github ? (
                <button type="button" className="tm-link-btn" onClick={disconnect} disabled={busy}>Disconnect</button>
              ) : (
                <span className="tm-sim-muted" title="Add another sign-in method first">Only sign-in method</span>
              )
            ) : methods.connect_available ? (
              <button type="button" className="tm-link-btn" onClick={connect} disabled={busy}>Connect GitHub</button>
            ) : null}
          </li>
        </ul>
      )}
      {!gh && methods && methods.connect_available ? (
        <p className="tm-sim-muted">GitHub asks which account to connect. It must not already belong to another tdoc account.</p>
      ) : null}
      {notice ? <p className="tm-sim-notice" role="status">{notice}</p> : null}
    </section>
  );
}

function GithubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
