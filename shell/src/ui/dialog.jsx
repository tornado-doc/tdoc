import React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';

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
          <Dialog.Popup className="ui-dialog-popup">
            <header className="ui-dialog-header">
              <div>
                <Dialog.Title className="ui-dialog-title">{title}</Dialog.Title>
                {description ? (
                  <Dialog.Description className="ui-dialog-description">
                    {description}
                  </Dialog.Description>
                ) : null}
              </div>
              <Dialog.Close className="ui-icon-button" aria-label="Close">
                <X size={16} />
              </Dialog.Close>
            </header>
            <div className="ui-dialog-body">{children}</div>
            {actions ? <footer className="ui-dialog-actions">{actions}</footer> : null}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
