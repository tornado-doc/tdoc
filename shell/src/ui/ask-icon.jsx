import React from 'react';

// Ask AI and tdoc AI: one solid four-point star, no satellite sparks.
export const ASK_ICON_PATH = 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2Z';

export function AskIcon({ size = 18, className = '', color = 'currentColor', ...props }) {
  return (
    <svg
      {...props}
      className={className || undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ASK_ICON_PATH} />
    </svg>
  );
}
