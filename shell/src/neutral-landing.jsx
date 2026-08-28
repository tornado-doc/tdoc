import React, { useCallback, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { SignInDialog } from './sign-in-dialog.jsx';

export function NeutralLanding({ boot }) {
  const [signInOpen, setSignInOpen] = useState(false);

  const signIn = () => {
    if (boot.webAuth) {
      location.href = '/api/auth/web/login?return=%2Fme';
      return;
    }
    setSignInOpen(true);
  };

  const completeSignIn = useCallback(() => {
    location.href = '/me';
  }, []);

  return (
    <main className="tdoc-neutral-page">
      {boot.notice ? <div className="tdoc-neutral-notice" role="status">{boot.notice}</div> : null}
      <img src="/tdoc_logo.svg" width="54" height="54" alt="" />
      <h1>tdoc</h1>
      <p>Prompt-native, commentable documents.</p>
      {boot.authConfigured ? (
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
  );
}
