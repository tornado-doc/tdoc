import React from 'react';

// The top-left point is also the pointer hotspot in the document frame.
export const COMMENT_ICON_PATH = 'M2 2H12A10 10 0 1 1 2 12V2Z';

export function CommentIcon({ size = 24, className = '', ...props }) {
  return (
    <svg
      {...props}
      className={`tdoc-comment-icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d={COMMENT_ICON_PATH} />
    </svg>
  );
}
