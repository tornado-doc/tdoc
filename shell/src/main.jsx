import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../server/chrome.css';
import './ui/ui.css';
import './shell.css';
import { DocsHub } from './docs-hub.jsx';
import { DocumentShell } from './document-shell.jsx';
import { NeutralLanding } from './neutral-landing.jsx';
import { StatusPage } from './status-page.jsx';

const appRoot = document.getElementById('tdoc-app-root');
const appBoot = window.__TDOC_APP_BOOT__;

if (appRoot && appBoot) {
  let page;
  if (appBoot.page === 'docs-hub') page = <DocsHub boot={appBoot} />;
  else if (appBoot.page === 'status') page = <StatusPage boot={appBoot} />;
  else page = <NeutralLanding boot={appBoot} />;
  createRoot(appRoot).render(page);
} else {
  const root = document.getElementById('tdoc-shell-root');
  const boot = window.__TDOC_SHELL_BOOT__;
  const config = window.__TDOC_SHELL__;
  if (!root || !boot || !config || !boot.frameSrc) {
    throw new Error('tdoc boot payload is missing');
  }
  createRoot(root).render(<DocumentShell boot={boot} config={config} />);
}
