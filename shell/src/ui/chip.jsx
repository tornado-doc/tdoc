import React from 'react';

// One chip, one shape. Before this existed every surface that needed a small
// status label wrote its own: `.tdoc-resolved-chip` and `.tdoc-demo-chip` were
// byte-identical pills, and `.tdoc-handoff-chip` had quietly drifted to a 4px
// box — so a card could show two labels of the same size in two different
// shapes. Shape belongs to the kit; callers pick a tone, never a radius.
//
// Tone is meaning, not decoration:
//   success — a conclusion. The thing is closed.
//   neutral — a process note. Something happened; nothing is settled.
//   info    — in flight, still moving.
//   warn    — it came back needing a human.
//   danger  — it did not land.
//   accent  — the agent asked something.
//
// `name` becomes `data-chip`, which is what tests and any future styling hook
// should select on. Class names are the kit's business and may change.
export function Chip({ tone = 'neutral', name, pulse = false, className = '', children, ...rest }) {
  const classes = ['ui-chip', `ui-chip-${tone}`];
  if (pulse) classes.push('ui-chip-pulse');
  if (className) classes.push(className);
  return (
    <span className={classes.join(' ')} {...(name ? { 'data-chip': name } : null)} {...rest}>
      {children}
    </span>
  );
}

// Chips sit on ONE line. The old markup put the resolved chip in an inline
// span and the handoff chips in a block-level flex div right after it, so a
// block box followed an inline one and they could never share a row no matter
// what the chips themselves were styled to do. One row, one container.
export function ChipRow({ className = '', children }) {
  return <div className={`ui-chip-row${className ? ` ${className}` : ''}`}>{children}</div>;
}
