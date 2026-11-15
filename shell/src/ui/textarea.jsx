import React, { forwardRef, useCallback, useLayoutEffect, useRef } from 'react';

// A text box that grows with what is typed, from one line up to `maxHeight`
// px, then scrolls -- the Ask AI composer's way (ask-ai-panel.jsx), as one
// primitive for any field where people may say more than a line. Styling is
// the surface's (the class it is given); only the height is set here, since
// it is measured.
export const AppTextarea = forwardRef(function AppTextarea(
  { value, maxHeight = 200, rows = 1, className = '', ...props },
  ref,
) {
  const own = useRef(null);
  const setRef = useCallback((el) => {
    own.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  }, [ref]);
  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    el.style.height = 'auto';
    const full = el.scrollHeight + (el.offsetHeight - el.clientHeight);
    el.style.height = `${Math.min(full, maxHeight)}px`;
    el.style.overflowY = full > maxHeight ? 'auto' : 'hidden';
  }, [value, maxHeight]);
  return <textarea ref={setRef} rows={rows} value={value} className={['ui-textarea', className].filter(Boolean).join(' ')} {...props} />;
});
