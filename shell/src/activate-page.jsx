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

export function ActivatePage({ boot }) {
  const [code, setCode] = useState(boot.code || '');
  const [signInOpen, setSignInOpen] = useState(false);
  const [identity, setIdentity] = useState(boot.identity);
  // idle → looked-up (terminal named, confirm offered) → approved | error
  const [pending, setPending] = useState(null);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    setError('');
    const { status, data } = await post('/api/cli/pair/lookup', { user_code: code });
    setBusy(false);
    if (status === 200 && data && data.ok) {
      setPending({ label: data.label });
    } else if (status === 429) {
      setError('Too many attempts — wait a minute and try again.');
    } else {
      setError('That code is not waiting for approval. It may have expired — re-run the command in your terminal for a fresh one.');
    }
  };

  const approve = async () => {
    setBusy(true);
    setError('');
    const { status, data } = await post('/api/cli/pair/approve', { user_code: code });
    setBusy(false);
    if (status === 200 && data && data.ok) {
      setApproved(true);
    } else if (status === 429) {
      setError('Too many approvals just now — wait a minute and try again.');
    } else {
      setError('Approval failed — the code may have just expired. Re-run the command in your terminal.');
    }
  };

  // A signed-in arrival with a prefilled code (the auto-opened tab, or the
  // return leg of the sign-in redirect) should land one click from done, not
  // re-type what the URL already carried.
  useEffect(() => {
    if (identity && code.length === 9 && !pending && !approved && !busy) lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  if (approved) {
    return (
      <main className="tdoc-status-page">
        <img src="/tdoc_logo.svg" width="44" height="44" alt="" />
        <h1>Connected</h1>
        <p>Your terminal has picked this up and continued on its own — there is nothing to go back and tell it.</p>
        <p>You can close this tab.</p>
      </main>
    );
  }

  return (
    <main className="tdoc-status-page tdoc-activate-page">
      <img src="/tdoc_logo.svg" width="44" height="44" alt="" />
      <h1>Connect a terminal</h1>
      {!identity ? (
        <>
          <p>{code
            ? 'A terminal wants to publish to your tdoc account. Sign in, then approve the code it showed you.'
            : 'Sign in to connect a terminal to your tdoc account.'}</p>
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
          <p>Signed in as <b>{identity.name || identity.login}</b>.</p>
          {!boot.code ? (
            <p className="tdoc-activate-hint">
              This page connects a terminal: running <code>tdoc publish</code> shows a short
              code, and approving it here lets that terminal publish as you. No terminal
              waiting? You're signed in — head to <a href="/me">your docs</a>.
            </p>
          ) : null}
          <p>{boot.code ? 'Confirm the code from your terminal:' : 'Have a code? Enter it:'}</p>
          <input
            className="tdoc-activate-code"
            value={code}
            onChange={(e) => setCode(cleanCode(e.target.value))}
            placeholder="XXXX-XXXX"
            autoFocus
            spellCheck={false}
            aria-label="pairing code"
          />
          <button type="button" className="primary" disabled={busy || code.length !== 9} onClick={lookup}>
            Continue
          </button>
        </>
      ) : (
        <>
          <p>
            {pending.label
              ? <>A terminal working on <code>{pending.label}</code> is asking to publish as <b>{identity.name || identity.login}</b>.</>
              : <>A terminal is asking to publish as <b>{identity.name || identity.login}</b>.</>}
          </p>
          <p>Only approve this if the code came from your own terminal, just now.</p>
          <button type="button" className="primary" disabled={busy} onClick={approve}>
            Approve
          </button>
        </>
      )}
      {error ? <p role="alert" className="tdoc-activate-error">{error}</p> : null}
      <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} onSuccess={completeSignIn} />
    </main>
  );
}
