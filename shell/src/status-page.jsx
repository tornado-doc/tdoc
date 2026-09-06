import React from 'react';

export function StatusPage({ boot }) {
  return (
    <main className={`tdoc-status-page${boot.error ? ' error' : ''}`}>
      <img src="/tdoc_logo.svg" width="44" height="44" alt="" />
      <h1>{boot.title}</h1>
      <p>{boot.message}</p>
      {boot.error ? <a href="/">Return to tdoc</a> : null}
    </main>
  );
}
