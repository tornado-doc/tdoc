import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { usePortalContainer } from './portal.js';
import { isPlainNavigationClick, startNavigationProgress } from '../nav-progress.js';

// A press on a row ends in the browser's own click. Base UI also clicks a row
// when the mouse goes up on it, for a press that began on the menu's button
// and was dragged here; it learns that press is over from a mouseup on the
// document, which the feedback widget's presses never reach (they stay in its
// shadow tree: isolateLayerEvents). There each row acted twice on a press, and
// once on a right press. A press that began in the popup is not a drag from
// the button: the row's mouseup handler is skipped.
const PressContext = createContext(null);
// Each time the menu opens or closes the press starts over.
function usePress(open, onOpenChange) {
  const pressed = useRef(false);
  useEffect(() => { pressed.current = false; }, [open]);
  return {
    pressed,
    onOpenChange: (...args) => { pressed.current = false; onOpenChange?.(...args); },
  };
}
function MenuPopup({ pressed, ...props }) {
  return (
    <PressContext.Provider value={pressed}>
      <Menu.Popup {...props} onMouseDownCapture={() => { pressed.current = true; }} />
    </PressContext.Provider>
  );
}
// A row's mouseup: the caller's, and the skip above.
function useRowMouseUp(onMouseUp) {
  const pressed = useContext(PressContext);
  return (event) => {
    onMouseUp?.(event);
    if (pressed?.current) event.preventBaseUIHandler();
  };
}

export function AppMenu({
  trigger,
  children,
  align = 'end',
  sideOffset = 6,
  open,
  onOpenChange,
  popupClassName = '',
  positionerClassName = '',
  // Where focus goes when the menu closes (base-ui Menu.Popup finalFocus):
  // by default back to the trigger. A row that hands focus elsewhere (the
  // title menu's Rename, to its field) passes a function returning false.
  finalFocus = undefined,
}) {
  const press = usePress(open, onOpenChange);
  return (
    <Menu.Root open={open} onOpenChange={press.onOpenChange}>
      <Menu.Trigger render={trigger} />
      <Menu.Portal container={usePortalContainer()}>
        <Menu.Positioner align={align} sideOffset={sideOffset} className={`ui-menu-positioner ${positionerClassName}`.trim()}>
          <MenuPopup pressed={press.pressed} className={`ui-menu-popup ${popupClassName}`.trim()} finalFocus={finalFocus}>{children}</MenuPopup>
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
  onMouseUp,
  ...props
}) {
  const rowMouseUp = useRowMouseUp(onMouseUp);
  const classes = ['ui-menu-item', tone === 'danger' ? 'ui-menu-item-danger' : null, className]
    .filter(Boolean)
    .join(' ');
  return (
    <Menu.Item
      className={classes}
      onClick={onClick}
      onMouseUp={rowMouseUp}
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
export function AppMenuLinkItem({ href, children, className, onClick, onMouseUp, ...props }) {
  const rowMouseUp = useRowMouseUp(onMouseUp);
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
      onMouseUp={rowMouseUp}
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
  const press = usePress(undefined);
  return (
    <Menu.SubmenuRoot onOpenChange={press.onOpenChange}>
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
          <MenuPopup pressed={press.pressed} className={`ui-menu-popup ${popupClassName}`.trim()}>
            {children}
          </MenuPopup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}
