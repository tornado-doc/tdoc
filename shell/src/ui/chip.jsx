import React from 'react';

// accent = “waiting on you” (Agent asked) — purple is meaning, not a paint chip.
const TONES = new Set(['success', 'neutral', 'warn', 'danger', 'info', 'accent']);

/** Shared status pill — one shape, tone carries meaning. */
export function Chip({
  tone = 'neutral',
  kind,
  pulse = false,
  children,
  className = '',
  title,
}) {
  const t = TONES.has(tone) ? tone : 'neutral';
  const classes = [
    'ui-chip',
    `ui-chip-${t}`,
    pulse ? 'is-pulse' : '',
    className,
  ].filter(Boolean).join(' ');
  return (
    <span
      className={classes}
      data-chip={kind || undefined}
      title={title || undefined}
    >
      {children}
    </span>
  );
}

/** Keeps sibling chips on one row; hides when empty. */
export function ChipRow({ children, className = '' }) {
  const items = React.Children.toArray(children).filter(Boolean);
  if (!items.length) return null;
  return <div className={['ui-chip-row', className].filter(Boolean).join(' ')}>{items}</div>;
}
