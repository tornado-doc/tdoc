import React, { useCallback, useEffect, useState } from 'react';
import { SignInDialog } from './sign-in-dialog.jsx';
import { TopBar } from './top-bar.jsx';
import { WorkspaceChecklist, workspaceSummary } from './workspace-checklist.jsx';

// The pairing approval page (/activate). A terminal showed the visitor a
// short code; this page is where their own browser — their own session —
// turns that code into an approval. Three states, in the order a first-time
// visitor meets them: sign in, allow what is being connected, done.
//
// Allow lists the person's workspaces (My docs and each team), all ticked.
// Leaving them all ticked connects the whole account, as it always did;
// unticking some gives the connection only the rest. Someone with no team
// has nothing to choose and sees no list.
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
  const [picked, setPicked] = useState(() => (preview?.pending?.workspaces || []).map((w) => w.id));
  const [approved, setApproved] = useState(Boolean(preview?.approved));
  const [error, setError] = useState(preview?.error || '');
  const [busy, setBusy] = useState(Boolean(preview?.busy));

  const signIn = () => {
    const back = `/activate${code ? `?code=${encodeURIComponent(code)}` : ''}`;
    // The provider seat first, then tdoc's own GitHub redirect; the
    // device-code dialog only where neither exists (a seat host answers the
    // device flow with 410).
    if (boot.oidcAuth) {
      location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(back)}`;
      return;
    }
    if (boot.webAuth) {
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
    if (preview) { setPending({ label: 'Preview device' }); setError(''); return; }
    setBusy(true);
    setError('');
    const { status, data } = await post('/api/cli/pair/lookup', { user_code: code });
    setBusy(false);
    if (status === 200 && data && data.ok) {
      const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
      setPending({ label: data.label, device: data.device || '', client: data.client || '', workspaces });
      setPicked(workspaces.map((w) => w.id));
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
    const { status, data } = await post('/api/cli/pair/approve', { user_code: code, ...(choosing ? { workspaces: picked } : {}) });
    setBusy(false);
    if (status === 200 && data && data.ok) {
      setApproved(true);
    } else if (status === 400 && data && /workspace/.test(String(data.error || ''))) {
      setError('Your workspaces changed. Reload this page and try again.');
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

  const workspaces = pending?.workspaces || [];
  const choosing = workspaces.length > 1;
  const partial = choosing && picked.length < workspaces.length;
  // Who is asking, as the terminal describes itself ("Claude Code on
  // julies-mac"). Self-reported: a hint for the person, never a grant.
  const asker = pending
    ? [pending.client, pending.device].filter(Boolean).join(' on ') || 'This device'
    : '';

  // A consent page: kept to its one question, under the shared top bar so the
  // account being connected is the avatar in the corner. The design preview
  // renders it without the bar (no session there), so it keeps the mark.
  const mark = preview ? <img src="/tdoc_logo.svg" width="44" height="44" alt="" /> : null;
  const frame = (main) => (preview ? main : (
    <div className="tdoc-app tdoc-edge-page">
      <TopBar
        identity={identity}
        authConfigured={Boolean(boot.oidcAuth || boot.authConfigured)}
        onSignIn={() => {
          if (!boot.oidcAuth) { signIn(); return; }
          const back = `/activate${code ? `?code=${encodeURIComponent(code)}` : ''}`;
          location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(back)}`;
        }}
      />
      {main}
    </div>
  ));

  if (approved) {
    return frame(
      <main className="tdoc-status-page tdoc-activate-page">
        <div className="tdoc-activate-stack">
        {mark}
        <h1>Access allowed</h1>
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
        <p>Your agent is finishing sign-in.</p>
        {partial ? <p className="tdoc-activate-hint">It can reach {workspaceSummary(workspaces, picked)}.</p> : null}
        <div className="tdoc-status-actions">
          <a className="primary" href="/me">My docs</a>
        </div>
        <p className="tdoc-activate-hint">You can close this tab.</p>
        </div>
      </main>
    );
  }

  return frame(
    <main className="tdoc-status-page tdoc-activate-page">
      <div className={`tdoc-activate-stack${!identity ? ' tdoc-activate-signin' : ''}`}>
      {mark}
      <h1>{pending ? 'Allow access to tdoc' : 'Approve device login'}</h1>
      {!identity ? (
        <>
          <p>{code
            ? 'Sign in, then approve this device or agent to publish to your account.'
            : 'Sign in to connect your device or agent.'}</p>
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
            Use another account
          </button>
        </>
      ) : (
        <>
          {/* Who is asking and as whom. Allowing hands that machine your
              account in the workspaces below -- if the name is not one you
              know, or the code is not the one on your screen, stop here. */}
          <p className="tdoc-activate-grant">
            <b>{asker}</b> will use tdoc as <b>{identity.email || identity.name || identity.login}</b>.
          </p>
          <div className="tdoc-activate-codeshow">{code}</div>
          {choosing ? (
            <div className="tdoc-activate-workspaces">
              <p className="tdoc-activate-ask">It can open, publish and edit docs in:</p>
              <WorkspaceChecklist
                workspaces={workspaces}
                picked={picked}
                onChange={setPicked}
                disabled={busy}
                label="Workspaces this agent can reach"
              />
              <p className="tdoc-activate-hint">
                {picked.length
                  ? 'Untick any it should not see. You can change this later in Settings → Agents.'
                  : 'Tick at least one workspace.'}
              </p>
            </div>
          ) : null}
          <button type="button" className="primary" disabled={busy || (choosing && !picked.length)} onClick={approve}>
            Allow
          </button>
          <button type="button" className="secondary" onClick={() => {
            location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(`/activate?code=${code}`)}`;
          }}>
            Use another account
          </button>
        </>
      )}
      {error ? <p role="alert" className="tdoc-activate-error">{error}</p> : null}
      </div>
      <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} onSuccess={completeSignIn} />
    </main>
  );
}
