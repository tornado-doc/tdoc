import React from 'react';
import { Dialog } from '@base-ui/react/dialog';

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
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Viewport className="ui-dialog-viewport">
          <Dialog.Popup className="ui-dialog-popup tdoc-modal">
            <Dialog.Title className="ui-dialog-title" render={<h3 />}>{title}</Dialog.Title>
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
