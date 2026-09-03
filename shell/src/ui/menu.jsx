import React from 'react';
import { Menu } from '@base-ui/react/menu';

export function AppMenu({
  trigger,
  children,
  align = 'end',
  sideOffset = 6,
  open,
  onOpenChange,
}) {
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner align={align} sideOffset={sideOffset} className="ui-menu-positioner">
          <Menu.Popup className="ui-menu-popup">{children}</Menu.Popup>
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
      <Menu.Portal>
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
