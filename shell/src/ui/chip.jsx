import React from 'react';

const TONES = new Set(['success', 'neutral', 'warn', 'danger', 'info']);

/** Shared status pill — one shape, tone carries meaning. */
export function Chip({ tone = 'neutral', children, className = '', title }) {
  const t = TONES.has(tone) ? tone : 'neutral';
  const classes = ['ui-chip', `ui-chip-${t}`, className].filter(Boolean).join(' ');
  return <span className={classes} title={title || undefined}>{children}</span>;
}

/** Keeps sibling chips on one row; hides when empty. */
export function ChipRow({ children, className = '' }) {
  return <div className={['ui-chip-row', className].filter(Boolean).join(' ')}>{children}</div>;
}
