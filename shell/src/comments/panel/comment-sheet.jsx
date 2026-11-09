import React, { forwardRef } from 'react';
import { Drawer } from '@base-ui/react/drawer';
import { SegmentedControl } from '../../ui/segmented-control.jsx';
import { usePortalContainer } from '../../ui/portal.js';

// The phone's comment list: one bottom sheet for the doc page and the
// feedback widget (it replaces the widget's full-width aside, which covered
// the app being commented on). It snaps at 70% and full height and swipes
// down to close. Tabs are optional: the doc page adds Ask AI beside
// Comments; the widget has none. `trigger` is the doc's floating button; the
// widget opens the sheet from its dock instead.
export const CommentSheet = forwardRef(function CommentSheet({
  open, onOpenChange, trigger = null, tabs = null, title = 'Comments', id = undefined, className = '', children,
}, ref) {
  const container = usePortalContainer();
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="down" snapPoints={[0.7, 1]} defaultSnapPoint={0.7}>
      {trigger}
      <Drawer.Portal container={container}>
        <Drawer.Backdrop className="tdoc-drawer-backdrop tdoc-sheet-backdrop" />
        <Drawer.Viewport className="tdoc-drawer-viewport tdoc-sheet-viewport">
          <Drawer.Popup ref={ref} id={id} className={`tdoc-sheet open${className ? ` ${className}` : ''}`}>
            <Drawer.Title className="tdoc-visually-hidden">{title}</Drawer.Title>
            <Drawer.Close className="tdoc-drawer-handle tdoc-sheet-handle" aria-label={`Close ${title.toLowerCase()}`} />
            {tabs ? (
              <div className="tdoc-drawer-tabs tdoc-sheet-tabs">
                <SegmentedControl ariaLabel={tabs.ariaLabel || 'Comments or Ask AI'} value={tabs.value} onChange={tabs.onChange} options={tabs.options} />
              </div>
            ) : null}
            {children}
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
});

export const SheetTrigger = Drawer.Trigger;
export const SheetContent = Drawer.Content;
