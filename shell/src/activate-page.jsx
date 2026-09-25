import React, { useCallback, useEffect, useState } from 'react';
import { SignInDialog } from './sign-in-dialog.jsx';

// The pairing approval page (/activate). A terminal showed the visitor a
// short code; this page is where their own browser — their own session —
// turns that code into an approval. Three states, in the order a first-time
// visitor meets them: sign in, confirm what is being connected, done.
//
// The confirm step is the anti-phishing seam: before the button, the page
// names the terminal's label and the signed-in account, so "paste this code
// for me" social engineering has to survive the visitor reading what they
// are about to attach to their own account.

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

function cleanCode(raw) {
  const v = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v;
}

export function ActivatePage({ boot, preview = null }) {
  const [code, setCode] = useState(boot.code || '');
  const [signInOpen, setSignInOpen] = useState(false);
  const [identity, setIdentity] = useState(boot.identity);
  // idle → looked-up (terminal named, confirm offered) → approved | error
  const [pending, setPending] = useState(preview?.pending || null);
  const [approved, setApproved] = useState(Boolean(preview?.approved));
  const [error, setError] = useState(preview?.error || '');
  const [busy, setBusy] = useState(Boolean(preview?.busy));

  const signIn = () => {
    if (boot.webAuth) {
      const back = `/activate${code ? `?code=${encodeURIComponent(code)}` : ''}`;
      location.href = `/api/auth/web/login?return=${encodeURIComponent(back)}`;
      return;
    }
    setSignInOpen(true);
  };

  const completeSignIn = useCallback((who) => {
    setSignInOpen(false);
    setIdentity(who);
  }, []);

  const lookup = async () => {
    if (preview) { setPending({ label: 'Preview terminal' }); setError(''); return; }
    setBusy(true);
    setError('');
    const { status, data } = await post('/api/cli/pair/lookup', { user_code: code });
    setBusy(false);
    if (status === 200 && data && data.ok) {
      setPending({ label: data.label });
    } else if (status === 429) {
      setError('Too many tries. Wait a minute, then try again.');
    } else {
      setError('This code has expired. Ask your agent to connect again.');
    }
  };

  const approve = async () => {
    if (preview) { setApproved(true); return; }
    setBusy(true);
    setError('');
    const { status, data } = await post('/api/cli/pair/approve', { user_code: code });
    setBusy(false);
    if (status === 200 && data && data.ok) {
      setApproved(true);
    } else if (status === 429) {
      setError('Too many tries. Wait a minute, then try again.');
    } else {
      setError('This code has expired. Ask your agent to connect again.');
    }
  };

  // A signed-in arrival with a prefilled code (the auto-opened tab, or the
  // return leg of the sign-in redirect) should land one click from done, not
  // re-type what the URL already carried.
  useEffect(() => {
    if (!preview && identity && code.length === 9 && !pending && !approved && !busy) lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  if (approved) {
    return (
      <main className="tdoc-status-page tdoc-activate-page">
        <div className="tdoc-activate-stack">
        <img src="/tdoc_logo.svg" width="44" height="44" alt="" />
        <h1>Device login approved</h1>
        {/* What happens next, not what this page cannot do. `window.close()`
            is ignored by every browser on a tab the script did not open --
            which is every tab reached from a link in a terminal -- so the
            button did nothing, and the line under it ("if this tab stays
            open, close it manually") was an apology for that. A page whose
            main action visibly fails and then explains itself is the thing
            that reads as untrustworthy, on the one screen that is supposed to
            confirm a credential was granted.

            So: say what the terminal is doing, and offer the one place worth
            going instead. */}
        <p>Your terminal is finishing sign-in.</p>
        <div className="tdoc-status-actions">
          <a className="primary" href="/me">My docs</a>
        </div>
        <p className="tdoc-activate-hint">You can close this tab.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="tdoc-status-page tdoc-activate-page">
      <div className={`tdoc-activate-stack${!identity ? ' tdoc-activate-signin' : ''}`}>
      <img src="/tdoc_logo.svg" width="44" height="44" alt="" />
      <h1>Approve Device Login</h1>
      {!identity ? (
        <>
          <p>{code
            ? 'Sign in, then approve this terminal to publish to your account.'
            : 'Sign in to connect your terminal.'}</p>
          <p className="tdoc-activate-hint">
            New here? Signing in creates your account.
          </p>
          {boot.oidcAuth ? (
            // One action, one surface: every sign-in method — GitHub
            // included — lives in the provider's own modal. Legacy GitHub
            // accounts are reconnected server-side through the provider's
            // record of which GitHub identity the visitor connected, so no
            // second button has to exist for their sake.
            <button
              type="button"
              className="primary"
              onClick={() => {
                const back = `/activate${code ? `?code=${encodeURIComponent(code)}` : ''}`;
                location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(back)}`;
              }}
            >
              Sign in
            </button>
          ) : boot.authConfigured ? (
            <button type="button" className="primary" onClick={signIn}>Sign in with GitHub</button>
          ) : (
            <p>Sign-in is not configured on this host.</p>
          )}
        </>
      ) : !pending ? (
        <>
          <p className="tdoc-activate-grant">
            Signed in as <b>{identity.email || identity.name || identity.login}</b>.
          </p>
          <input
            className="tdoc-activate-code"
            value={code}
            onChange={(e) => setCode(cleanCode(e.target.value))}
            placeholder="XXXX-XXXX"
            autoFocus
            spellCheck={false}
            aria-label="Device code"
          />
          <button type="button" className="primary" disabled={busy || code.length !== 9} onClick={lookup}>
            Continue
          </button>
          <button type="button" className="secondary" onClick={() => {
            location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(`/activate${code ? `?code=${code}` : ''}`)}`;
          }}>
            Use Another Account
          </button>
        </>
      ) : (
        <>
          <p className="tdoc-activate-grant">
            Signed in as <b>{identity.email || identity.name || identity.login}</b>.
          </p>
          <div className="tdoc-activate-codeshow">{code}</div>
          <button type="button" className="primary" disabled={busy} onClick={approve}>
            Approve Device Login
          </button>
          <button type="button" className="secondary" onClick={() => {
            location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(`/activate?code=${code}`)}`;
          }}>
            Use Another Account
          </button>
        </>
      )}
      {error ? <p role="alert" className="tdoc-activate-error">{error}</p> : null}
      </div>
      <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} onSuccess={completeSignIn} />
    </main>
  );
}
