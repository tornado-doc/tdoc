import React from 'react';

export const COMMENT_ICON_PATH = 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z';

export function CommentIcon({ size = 24, className = '', ...props }) {
  return (
    <svg
      {...props}
      className={`tdoc-comment-icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={COMMENT_ICON_PATH} />
    </svg>
  );
}
