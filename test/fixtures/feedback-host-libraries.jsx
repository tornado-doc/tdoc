import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as RadixDialog from '@radix-ui/react-dialog';
import * as RadixPopover from '@radix-ui/react-popover';
import { Dialog as HeadlessDialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { Dialog as MuiDialog, DialogTitle as MuiDialogTitle } from '@mui/material';

window.__libraryEvents = { radixKeys: 0, headlessKeys: 0, headlessSubmits: 0, headlessCloses: 0 };

function LibraryHost() {
  const [radixOpen, setRadixOpen] = useState(false);
  const [headlessOpen, setHeadlessOpen] = useState(false);
  const [muiOpen, setMuiOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  return <main>
    <h1>Real modal libraries</h1>
    <button id="radix-open" onClick={() => setRadixOpen(true)}>Open Radix</button>
    <button id="headless-open" onClick={() => setHeadlessOpen(true)}>Open Headless UI</button>
    <button id="mui-open" onClick={() => setMuiOpen(true)}>Open MUI</button>
    <RadixPopover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
      <RadixPopover.Trigger id="popover-open">Open Radix Popover</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content id="radix-popover" sideOffset={6}>Non-modal popover content</RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
    <RadixDialog.Root open={radixOpen} onOpenChange={setRadixOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="modal-overlay" />
        <RadixDialog.Content id="radix-content" className="modal-content" onKeyDown={() => window.__libraryEvents.radixKeys++}>
          <RadixDialog.Title>Radix settings</RadixDialog.Title>
          <RadixDialog.Description>Settings for this app</RadixDialog.Description>
          <h2 id="radix-target">Comment on Radix</h2>
          <RadixDialog.Close>Close Radix</RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
    <HeadlessDialog open={headlessOpen} onClose={setHeadlessOpen} className="modal-wrapper">
      <div className="modal-overlay" aria-hidden="true" />
      <DialogPanel as="form" id="custom-headless-panel" transition className="modal-content"
        onKeyDown={() => window.__libraryEvents.headlessKeys++}
        onSubmit={(event) => { event.preventDefault(); window.__libraryEvents.headlessSubmits++; }}>
        <DialogTitle>Headless settings</DialogTitle>
        <h2 id="headless-target">Comment on Headless UI</h2>
        <button type="button" onClick={() => { window.__libraryEvents.headlessCloses++; setHeadlessOpen(false); }}>Close Headless UI</button>
      </DialogPanel>
    </HeadlessDialog>
    <MuiDialog keepMounted open={muiOpen} onClose={() => setMuiOpen(false)}>
      <MuiDialogTitle>MUI settings</MuiDialogTitle>
      <h2 id="mui-target">Comment on MUI</h2>
      <button type="button" onClick={() => setMuiOpen(false)}>Close MUI</button>
    </MuiDialog>
  </main>;
}

createRoot(document.getElementById('host-app')).render(<LibraryHost />);
