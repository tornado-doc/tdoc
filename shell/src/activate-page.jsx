import React, { useCallback, useEffect, useState } from 'react';
import { Check } from 'lucide-react';
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
      setError('Too many tries. Wait a minute, then try again.');
    } else {
      setError('This code has expired. Ask your agent to connect again.');
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
      setError('Too many tries. Wait a minute, then try again.');
    } else {
      setError('This code has expired. Ask your agent to connect again.');
    }
  };

  // A signed-in arrival with a prefilled code (the auto-opened tab, or the
  // return leg of the sign-in redirect) should land one click from done, not
  // re-type what the URL already carried.
  useEffect(() => {
    if (identity && code.length === 9 && !pending && !approved && !busy) lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  const switchAccount = () => {
    location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(`/activate${code ? `?code=${code}` : ''}`)}`;
  };
  const beginSignIn = () => {
    if (boot.oidcAuth) return switchAccount();
    signIn();
  };
  return <>
    <ActivateView {...{ code, identity, pending, approved, error, busy }}
      canSignIn={boot.oidcAuth || boot.authConfigured}
      signInLabel={boot.oidcAuth ? 'Sign in' : 'Sign in with GitHub'}
      onCodeChange={(value) => setCode(cleanCode(value))}
      onSignIn={beginSignIn} onContinue={lookup} onApprove={approve} onSwitchAccount={switchAccount} />
    <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} onSuccess={completeSignIn} />
  </>;
}

// The same view is used by the preview gallery, without running an auth flow.
export function ActivateView({ code = '', identity, pending, approved, error, busy,
  canSignIn, signInLabel = 'Sign in', onCodeChange, onSignIn, onContinue, onApprove, onSwitchAccount }) {
  const account = identity?.email || identity?.name || identity?.login;
  return (
    <main className="tdoc-status-page tdoc-activate-page">
      <div className="tdoc-activate-stack">
        <header className="tdoc-activate-header">
          {approved ? <span className="tdoc-activate-success" aria-hidden="true"><Check size={28} strokeWidth={2} /></span>
            : <img src="/tdoc_logo.svg" width="40" height="40" alt="tdoc" />}
          <h1>{approved ? 'Device login approved' : 'Connect your agent'}</h1>
          <p>{approved ? 'Your terminal is finishing sign-in. You can return to your agent.'
            : !identity ? 'Sign in to connect your agent to your tdoc account.'
              : pending ? 'Allow this device to publish documents to your tdoc account.'
                : 'Enter the code shown by your agent.'}</p>
        </header>
        {approved ? (
          <div className="tdoc-activate-actions">
            <a className="primary" href="/me">Go to my docs</a>
            <p className="tdoc-activate-hint">You can close this tab.</p>
          </div>
        ) : !identity ? (
          <div className="tdoc-activate-actions">
            {canSignIn ? <button type="button" className="primary" onClick={onSignIn}>{signInLabel}</button>
              : <p>Sign-in is not configured on this host.</p>}
            <p className="tdoc-activate-hint">New to tdoc? Signing in creates your account.</p>
          </div>
        ) : (
          <>
            <dl className="tdoc-activate-details">
              {pending ? <div><dt>Device</dt><dd>{pending.label || 'Your terminal'}</dd></div> : null}
              <div><dt>Account</dt><dd>{account}</dd></div>
            </dl>
            {pending ? <div className="tdoc-activate-codegroup"><span>Device code</span><div className="tdoc-activate-codeshow">{code}</div></div>
              : <label className="tdoc-activate-codegroup" htmlFor="device-code"><span>Device code</span>
                <input id="device-code" className="tdoc-activate-code" value={code}
                  onChange={(event) => onCodeChange(event.target.value)} placeholder="XXXX-XXXX"
                  autoFocus autoComplete="off" spellCheck={false} aria-describedby={error ? 'pairing-error' : undefined} aria-invalid={Boolean(error)} />
                </label>}
            <div className="tdoc-activate-actions">
              <button type="button" className="primary" disabled={busy || (!pending && code.length !== 9)} onClick={pending ? onApprove : onContinue}>
                {busy ? (pending ? 'Approving…' : 'Checking code…') : pending ? 'Approve device login' : 'Continue'}
              </button>
              <button type="button" className="secondary" onClick={onSwitchAccount}>Use another account</button>
            </div>
          </>
        )}
        {error ? <p id="pairing-error" role="alert" className="tdoc-activate-error">{error}</p> : null}
      </div>
    </main>
  );
}
