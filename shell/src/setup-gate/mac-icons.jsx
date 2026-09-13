import React from 'react';

// The apps that are always in a dock, drawn rather than fetched.
//
// A dock holding three chat apps and nothing else is not a dock anybody has,
// and that is what made the desk read as a drawing. These are recognisable at
// 46px -- the shape, the ground, the one mark each is known by -- without
// being anybody's actual icon file: this is a picture of a desk, not a copy of
// one, and the point is that a reader recognises where they are.

export function FinderIcon() {
  return (
    <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
      <defs>
        <linearGradient id="fnd" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3fa9f5" /><stop offset="1" stopColor="#1e6fd9" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="11" fill="url(#fnd)" />
      <path d="M24 3v42" stroke="rgba(255,255,255,.35)" strokeWidth="1" />
      <rect x="6" y="3" width="18" height="42" fill="rgba(255,255,255,.9)" />
      {/* the two eyes and the smile of the face it is known by */}
      <path d="M12.5 17v4M18 17v4" stroke="#2b2b2b" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M11 29c3.2 2.6 7.6 2.6 10.8 0" stroke="#2b2b2b" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M29 17.5v4M35 17.5v4" stroke="rgba(255,255,255,.95)" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M27.5 29c3.4 2.8 8 2.8 11.4 0" stroke="rgba(255,255,255,.95)" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function SafariIcon() {
  return (
    <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
      <defs>
        <linearGradient id="saf" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f4f7fb" /><stop offset="1" stopColor="#dbe4ef" />
        </linearGradient>
        <linearGradient id="safd" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2fb6f5" /><stop offset="1" stopColor="#1372e8" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="11" fill="url(#saf)" />
      <circle cx="24" cy="24" r="18" fill="url(#safd)" />
      <circle cx="24" cy="24" r="15.5" fill="#eaf3fc" />
      {/* the needle: red one way, white the other */}
      <path d="M32 16 21.5 21.5 16 32l10.5-5.5Z" fill="#f4453c" />
      <path d="M16 32l10.5-5.5L32 16Z" fill="#fff" opacity=".92" />
      <circle cx="24" cy="24" r="1.4" fill="#c9d4e2" />
    </svg>
  );
}

export function MessagesIcon() {
  return (
    <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
      <defs>
        <linearGradient id="msg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6ee86b" /><stop offset="1" stopColor="#2ec52a" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="11" fill="url(#msg)" />
      <path
        d="M24 11c-7.7 0-14 4.9-14 11 0 3.5 2.1 6.6 5.3 8.6-.5 2-1.6 3.9-3 5.4 2.9-.4 5.5-1.6 7.3-3.1 1.4.3 2.9.5 4.4.5 7.7 0 14-4.9 14-11S31.7 11 24 11Z"
        fill="#fff"
      />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
      {/* A wire basket, not a tile: the bin is the one dock item with no
          rounded-square ground behind it. */}
      <path d="M15 16h18l-1.6 24a3 3 0 0 1-3 2.8H19.6a3 3 0 0 1-3-2.8Z"
        fill="rgba(236,244,252,.5)" stroke="rgba(255,255,255,.85)" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M20 21v16M24 21v16M28 21v16" stroke="rgba(255,255,255,.7)" strokeWidth="1.3" strokeLinecap="round" />
      <rect x="12.5" y="12" width="23" height="4.2" rx="2.1" fill="rgba(255,255,255,.9)" />
      <path d="M20.5 12V9.6a1.8 1.8 0 0 1 1.8-1.8h3.4a1.8 1.8 0 0 1 1.8 1.8V12"
        fill="none" stroke="rgba(255,255,255,.9)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
