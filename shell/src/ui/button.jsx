import React, { forwardRef } from 'react';

// The one button. Sizes and colours live in ui.css (.ui-btn*), from --td-*
// tokens only; a surface may recolour a variant (the dark composer popover)
// but never resize it. New buttons use this, not their own CSS.
//   variant: primary | secondary | danger | quiet | icon (32px square, an icon only)
//   size:    m (32px) | s (28px)
export const AppButton = forwardRef(function AppButton(
  { variant = 'secondary', size = 'm', className = '', type = 'button', ...props },
  ref,
) {
  const classes = ['ui-btn', `ui-btn-${variant}`, `ui-btn-${size}`, className].filter(Boolean).join(' ');
  return <button ref={ref} type={type} className={classes} {...props} />;
});
