import React, { useCallback, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { SignInDialog } from './sign-in-dialog.jsx';
import { TopBar } from './top-bar.jsx';
import { useViewerIdentity } from './hooks/use-viewer-identity.js';

export function NeutralLanding({ boot }) {
  const [signInOpen, setSignInOpen] = useState(false);
  // The worker renders this page from places that never read the session
  // (a missing landing doc, a bounce notice), so the page asks who is here.
  const viewer = useViewerIdentity(boot.identity);
  const identity = viewer.identity;
  const canSignIn = Boolean(boot.oidcAuth || boot.authConfigured);

  const signIn = () => {
    if (boot.oidcAuth) {
      location.href = '/api/auth/oidc/login?prompt=login&return=%2Fme';
      return;
    }
    if (boot.webAuth) {
      location.href = '/api/auth/web/login?return=%2Fme';
      return;
    }
    setSignInOpen(true);
  };

  const completeSignIn = useCallback(() => {
    location.href = '/me';
  }, []);

  // Signed in, the way on is My docs, not another Sign in. The one notice
  // that says My docs is not for this account ('me') gets neither.
  const showMyDocs = Boolean(identity) && boot.noticeKind !== 'me';

  return (
    <div className="tdoc-app tdoc-edge-page">
      <TopBar identity={identity} authConfigured={viewer.ready && canSignIn} onSignIn={signIn} />
      <main className="tdoc-neutral-page">
        {boot.notice ? <div className="tdoc-neutral-notice" role="status">{boot.notice}</div> : null}
        <img src="/tdoc_logo.svg" width="54" height="54" alt="" />
        <h1>tdoc</h1>
        <p>Prompt-native, commentable documents.</p>
        {!viewer.ready ? (
          // Holds the button's place while the page learns who is here.
          <span className="tdoc-neutral-primary is-pending" aria-hidden="true">Sign in</span>
        ) : showMyDocs ? (
          <a className="tdoc-neutral-primary" href="/me">Open My docs</a>
        ) : !identity && boot.oidcAuth ? (
          <button type="button" className="primary" onClick={signIn}>Sign in</button>
        ) : !identity && boot.authConfigured ? (
          <button type="button" className="primary" onClick={signIn}>Sign in with GitHub</button>
        ) : null}
        <a href="https://github.com/tornado-doc/tdoc">
          github.com/tornado-doc/tdoc <ExternalLink size={14} />
        </a>
        <SignInDialog
          open={signInOpen}
          onOpenChange={setSignInOpen}
          onSuccess={completeSignIn}
        />
      </main>
    </div>
  );
}
