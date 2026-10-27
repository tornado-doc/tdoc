import React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { usePortalContainer } from './portal.js';

// The one modal surface. Visuals come from chrome.css's `.tdoc-modal` rules —
// the same sheet the rest of the reader chrome uses — so a dialog looks the
// same whether it is Publish, Share, Sign in, or a Docs Hub confirm. Base UI
// supplies the portal, focus trap, Escape, and backdrop dismissal.
export function AppDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  // A surface with its own header (the onboarding) keeps the title for
  // assistive tech and hides it from view; `className` widens the sheet.
  hideTitle = false,
  className = '',
  // `side`: a panel docked at the right edge (a bottom sheet on a phone) that
  // leaves the page readable and scrollable beside it — no backdrop, no
  // focus trap. Escape and the panel's own Close still dismiss it.
  side = false,
}) {
  const container = usePortalContainer();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={side ? false : true} disablePointerDismissal={side}>
      <Dialog.Portal container={container}>
        {side ? null : <Dialog.Backdrop className="ui-dialog-backdrop" />}
        <Dialog.Viewport className={`ui-dialog-viewport${side ? ' ui-dialog-side' : ''}`}>
          <Dialog.Popup className={`ui-dialog-popup tdoc-modal${side ? ' ui-dialog-side-popup' : ''}${className ? ` ${className}` : ''}`}>
            <Dialog.Title className={`ui-dialog-title${hideTitle ? ' ui-sr-only' : ''}`} render={<h3 />}>{title}</Dialog.Title>
            {description ? (
              <Dialog.Description className="muted ui-dialog-description">
                {description}
              </Dialog.Description>
            ) : null}
            <div className="ui-dialog-body">{children}</div>
            {actions ? <div className="actions">{actions}</div> : null}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
