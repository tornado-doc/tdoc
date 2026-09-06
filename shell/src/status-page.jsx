import React, { useEffect } from 'react';

export function StatusPage({ boot }) {
  // Opened as the sign-in pop-up's last page: tell the page that opened us,
  // then close. The opener is the landing's onboarding, which carries on.
  useEffect(() => {
    if (!boot.popup || boot.error) return;
    try { window.opener?.postMessage({ type: 'tdoc:signed-in' }, location.origin); } catch {}
    window.setTimeout(() => window.close(), 150);
  }, [boot.popup, boot.error]);

  return (
    <main className={`tdoc-status-page${boot.error ? ' error' : ''}`}>
      <img src="/tdoc_logo.svg" width="44" height="44" alt="" />
      <h1>{boot.title}</h1>
      <p>{boot.popup && !boot.error ? 'You can close this window.' : boot.message}</p>
      {boot.error ? <a href="/">Return to tdoc</a> : null}
    </main>
  );
}
