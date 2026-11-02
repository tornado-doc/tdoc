import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as RadixDialog from '@radix-ui/react-dialog';
import * as RadixPopover from '@radix-ui/react-popover';
import { Dialog as HeadlessDialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { Dialog as MuiDialog, DialogTitle as MuiDialogTitle } from '@mui/material';

window.__libraryEvents = { radixKeys: 0, headlessKeys: 0, headlessSubmits: 0, headlessCloses: 0, overlayCloses: 0, menuCloses: 0, nativeCloses: 0 };

// A chart people want to comment on a part of: a canvas has no elements to
// click, which is what dragging an area is for.
function Chart({ id }) {
  const ref = useRef(null);
  useEffect(() => {
    const ctx = ref.current.getContext('2d');
    ctx.fillStyle = '#e8eefc'; ctx.fillRect(0, 0, 240, 90);
    ctx.fillStyle = '#1652f0';
    [30, 55, 20, 70, 45, 60].forEach((h, i) => ctx.fillRect(12 + i * 38, 90 - h, 24, h));
  }, []);
  return <canvas id={id} ref={ref} width="240" height="90" style={{ display: 'block' }} />;
}

// The hand-written kind: a fixed full-screen backdrop, no role or
// aria-modal, closed by a press outside its box (a capture-phase
// "click outside" hook, as most apps write it) or on the backdrop itself.
function OverlayModal({ onClose }) {
  const box = useRef(null);
  useEffect(() => {
    const outside = (event) => { if (box.current && !box.current.contains(event.target)) { window.__libraryEvents.overlayCloses++; onClose(); } };
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('touchstart', outside, true);
    return () => { document.removeEventListener('mousedown', outside, true); document.removeEventListener('touchstart', outside, true); };
  }, [onClose]);
  return <div id="overlay-backdrop" className="overlay-backdrop">
    <div id="overlay-modal" className="overlay-box" ref={box}>
      <h2 id="overlay-target">Comment on the overlay</h2>
      <Chart id="overlay-chart" />
      <button id="overlay-disabled" type="button" disabled>Disabled save</button>
      <button type="button" onClick={onClose}>Close overlay</button>
    </div>
  </div>;
}

// A dropdown menu: closes on any press outside it, on Escape and when an
// item is chosen.
function Menu({ onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const outside = (event) => { if (ref.current && !ref.current.contains(event.target)) { window.__libraryEvents.menuCloses++; onClose(); } };
    const key = (event) => { if (event.key === 'Escape') { window.__libraryEvents.menuCloses++; onClose(); } };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key); };
  }, [onClose]);
  return <div id="menu" role="menu" className="menu" ref={ref}>
    <button type="button" role="menuitem" id="menu-rename" onClick={() => { window.__libraryEvents.menuChosen = 'rename'; onClose(); }}>Rename</button>
    <button type="button" role="menuitem" id="menu-archive" onClick={() => { window.__libraryEvents.menuChosen = 'archive'; onClose(); }}>Archive</button>
  </div>;
}

function LibraryHost() {
  const [radixOpen, setRadixOpen] = useState(false);
  const [radixNoOverlayOpen, setRadixNoOverlayOpen] = useState(false);
  const [headlessOpen, setHeadlessOpen] = useState(false);
  const [muiOpen, setMuiOpen] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeOverlay = React.useCallback(() => setOverlayOpen(false), []);
  const closeMenu = React.useCallback(() => setMenuOpen(false), []);
  return <main>
    <h1>Real modal libraries</h1>
    <button id="radix-open" onClick={() => setRadixOpen(true)}>Open Radix</button>
    <button id="radix-no-overlay-open" onClick={() => setRadixNoOverlayOpen(true)}>Open Radix without Overlay</button>
    <button id="headless-open" onClick={() => setHeadlessOpen(true)}>Open Headless UI</button>
    <button id="mui-open" onClick={() => setMuiOpen(true)}>Open MUI</button>
    <button id="native-open" onClick={() => document.getElementById('native-dialog').showModal()}>Open native dialog</button>
    <button id="overlay-open" onClick={() => setOverlayOpen(true)}>Open overlay</button>
    <span className="menu-anchor"><button id="menu-open" onClick={() => setMenuOpen((v) => !v)}>Open menu</button>
      {menuOpen ? <Menu onClose={closeMenu} /> : null}</span>
    <section id="page-chart-card"><h3>Signups</h3><Chart id="page-chart" /></section>
    <dialog id="native-dialog" onClose={() => window.__libraryEvents.nativeCloses++}>
      <h2 id="native-target">Comment on native</h2>
      <Chart id="native-chart" />
      <button type="button" onClick={() => document.getElementById('native-dialog').close()}>Close native</button>
    </dialog>
    {overlayOpen ? <OverlayModal onClose={closeOverlay} /> : null}
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
          <Chart id="radix-chart" />
          <RadixDialog.Close>Close Radix</RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
    <RadixDialog.Root open={radixNoOverlayOpen} onOpenChange={setRadixNoOverlayOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Content id="radix-no-overlay-content" className="modal-content">
          <RadixDialog.Title>Radix without Overlay</RadixDialog.Title>
          <RadixDialog.Description>Settings without a backdrop</RadixDialog.Description>
          <h2 id="radix-no-overlay-target">Comment on this dialog</h2>
          <Chart id="radix-no-overlay-chart" />
          <RadixDialog.Close>Close Radix without Overlay</RadixDialog.Close>
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
      <div style={{ padding: '0 24px 16px' }}><Chart id="mui-chart" /></div>
      <button type="button" onClick={() => setMuiOpen(false)}>Close MUI</button>
    </MuiDialog>
  </main>;
}

createRoot(document.getElementById('host-app')).render(<LibraryHost />);
