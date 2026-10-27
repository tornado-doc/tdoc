import React, { useEffect, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { usePortalContainer } from './portal.js';
import { isPlainNavigationClick, startNavigationProgress } from '../nav-progress.js';

export function AppMenu({
  trigger,
  children,
  align = 'end',
  sideOffset = 6,
  open,
  onOpenChange,
  popupClassName = '',
  positionerClassName = '',
}) {
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger render={trigger} />
      <Menu.Portal container={usePortalContainer()}>
        <Menu.Positioner align={align} sideOffset={sideOffset} className={`ui-menu-positioner ${positionerClassName}`.trim()}>
          <Menu.Popup className={`ui-menu-popup ${popupClassName}`.trim()}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function AppMenuItem({
  children,
  onClick,
  disabled = false,
  tone,
  className,
  ...props
}) {
  const classes = ['ui-menu-item', tone === 'danger' ? 'ui-menu-item-danger' : null, className]
    .filter(Boolean)
    .join(' ');
  return (
    <Menu.Item
      className={classes}
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </Menu.Item>
  );
}

// A menu row that goes to another page: a real link, so it navigates even if
// a script handler misfires, opens in a new tab on a modified click, and
// shows its address on hover. A plain click keeps the menu open with the row
// marked busy, and the top-of-page bar starts, until the next page arrives:
// a slow page must never look like a click that did nothing.
export function AppMenuLinkItem({ href, children, className, onClick, ...props }) {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending) return undefined;
    const reset = (event) => { if (event.persisted) setPending(false); };
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, [pending]);
  const classes = ['ui-menu-item', 'ui-menu-link-item', className].filter(Boolean).join(' ');
  return (
    <Menu.LinkItem
      href={href}
      className={classes}
      aria-busy={pending || undefined}
      data-pending={pending ? '' : undefined}
      onClick={(event) => {
        onClick?.(event);
        if (!isPlainNavigationClick(event)) return;
        setPending(true);
        startNavigationProgress();
      }}
      {...props}
    >
      {children}
      {pending ? <span className="ui-menu-item-spinner" aria-hidden="true" /> : null}
    </Menu.LinkItem>
  );
}

// A hairline between groups. Carries className so it can inherit the same
// visibility gate as the items it sits between — a separator that survives when
// its whole group is hidden reads as a bug.
export function AppMenuSeparator({ className }) {
  return <Menu.Separator className={['ui-menu-sep', className].filter(Boolean).join(' ')} />;
}

export function AppSubmenu({
  trigger,
  children,
  className = '',
  popupClassName = '',
  side = 'right',
  align = 'start',
  sideOffset = 4,
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={`ui-menu-item ${className}`.trim()}>
        {trigger}
      </Menu.SubmenuTrigger>
      <Menu.Portal container={usePortalContainer()}>
        <Menu.Positioner
          side={side}
          align={align}
          sideOffset={sideOffset}
          className="ui-menu-positioner"
        >
          <Menu.Popup className={`ui-menu-popup ${popupClassName}`.trim()}>
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}
