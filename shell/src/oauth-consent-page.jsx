import React, { useState } from 'react';
import { TopBar } from './top-bar.jsx';
import { AppButton } from './ui/button.jsx';
import { SignInDialog } from './sign-in-dialog.jsx';
import { WorkspaceChecklist, workspaceSummary } from './workspace-checklist.jsx';

// /oauth/authorize — an AI app (Claude, ChatGPT, Cursor...) asking to use
// tdoc as this person, through the remote MCP server. The same page as the
// terminal Allow page (/activate): the same sign-in, the same workspace
// ticks, the same one question. It names the app as it registered itself and
// the address the browser goes back to, because a registered name is the
// app's own claim and the return address is what actually receives access.
//
// Allow and Cancel post to /api/oauth/approve with the request id and the
// CSRF value the server rendered into this page for this session; the answer
// is where to send the browser next (the app's redirect URI, with a code or
// access_denied).

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

export function OAuthConsentPage({ boot }) {
  const identity = boot.identity || null;
  const client = boot.client || {};
  const workspaces = Array.isArray(boot.workspaces) ? boot.workspaces : [];
  const [picked, setPicked] = useState(() => workspaces.map((w) => w.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signInOpen, setSignInOpen] = useState(false);
  const back = boot.returnTo || '/';
  const choosing = workspaces.length > 1;

  const signIn = () => {
    if (boot.oidcAuth) { location.href = `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(back)}`; return; }
    if (boot.webAuth) { location.href = `/api/auth/web/login?return=${encodeURIComponent(back)}`; return; }
    setSignInOpen(true);
  };

  const decide = async (decision) => {
    setBusy(true);
    setError('');
    const { status, data } = await post('/api/oauth/approve', {
      request_id: boot.request_id,
      csrf: boot.csrf,
      decision,
      ...(decision === 'allow' && choosing ? { workspaces: picked } : {}),
    });
    if (status === 200 && data && data.redirect) {
      location.href = data.redirect;
      return;
    }
    setBusy(false);
    if (status === 429) setError('Too many tries. Wait a minute, then try again.');
    else if (status === 400 && data && /workspace/.test(String(data.error || ''))) setError('Your workspaces changed. Reload this page and try again.');
    else setError('This request has expired. Start the connection again from the app.');
  };

  const who = identity ? (identity.email || identity.name || identity.login) : '';
  return (
    <div className="tdoc-app tdoc-edge-page">
      <TopBar identity={identity} authConfigured={Boolean(boot.oidcAuth || boot.authConfigured)} onSignIn={signIn} />
      <main className="tdoc-status-page tdoc-activate-page tdoc-oauth-consent">
        <div className={`tdoc-activate-stack${!identity ? ' tdoc-activate-signin' : ''}`}>
          <h1>Allow {client.name || 'this app'}{client.redirect_host ? ` (${client.redirect_host})` : ''} to use tdoc</h1>
          {!identity ? (
            <>
              <p>Sign in to tdoc, then allow the app to work with your documents.</p>
              <p className="tdoc-activate-hint">New here? Signing in creates your account.</p>
              {boot.oidcAuth || boot.authConfigured
                ? <AppButton variant="primary" onClick={signIn}>Sign in</AppButton>
                : <p>Sign-in is not configured on this host.</p>}
            </>
          ) : (
            <>
              <p className="tdoc-activate-grant">
                An app at <b>{client.redirect_host}</b> will use tdoc as <b>{who}</b>: read, create and edit your docs, reply to comments, and change sharing.
              </p>
              <p className="tdoc-activate-hint tdoc-oauth-return">
                {client.verified_host
                  ? <>It calls itself “{client.name}”, published by <b>{client.verified_host}</b>. </>
                  : <>It calls itself “{client.name}” (a name the app chose; tdoc has not checked it). </>}
                If you did not start this from <b>{client.redirect_host}</b>, cancel.
              </p>
              {choosing ? (
                <div className="tdoc-activate-workspaces">
                  <p className="tdoc-activate-ask">It can open, publish and edit docs in:</p>
                  <WorkspaceChecklist
                    workspaces={workspaces}
                    picked={picked}
                    onChange={setPicked}
                    disabled={busy}
                    label="Workspaces this app can reach"
                  />
                  <p className="tdoc-activate-hint">
                    {picked.length
                      ? `${workspaceSummary(workspaces, picked.length === workspaces.length ? null : picked)}. You can change this or disconnect later in Settings → Agents.`
                      : 'Tick at least one workspace.'}
                  </p>
                </div>
              ) : (
                <p className="tdoc-activate-hint">You can disconnect it later in Settings → Agents.</p>
              )}
              <div className="tdoc-oauth-actions">
                <AppButton variant="primary" disabled={busy || (choosing && !picked.length)} onClick={() => decide('allow')}>Allow</AppButton>
                <AppButton disabled={busy} onClick={() => decide('deny')}>Cancel</AppButton>
              </div>
            </>
          )}
          {error ? <p role="alert" className="tdoc-activate-error">{error}</p> : null}
          <p className="tdoc-activate-hint"><a href="/privacy">Privacy policy</a></p>
        </div>
        <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} onSuccess={() => { setSignInOpen(false); location.reload(); }} />
      </main>
    </div>
  );
}
