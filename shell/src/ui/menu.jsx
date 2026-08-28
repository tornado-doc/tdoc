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
