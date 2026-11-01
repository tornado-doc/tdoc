import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '../../server/chrome.css';
import './ui/ui.css';
import './shell.css';
import './setup-gate.css';
import { DocsHub } from './docs-hub.jsx';
import { FolderShare } from './folder-share.jsx';
import { FeedbackSpace } from './feedback-space.jsx';
import { FeedbackInstall } from './feedback-install.jsx';
import { FeedbackConnect } from './feedback-connect.jsx';
import { AgentsPage } from './agents-page.jsx';
import { Profile } from './profile.jsx';
import { DocumentShell } from './document-shell.jsx';
import { NeutralLanding } from './neutral-landing.jsx';
import { StatusPage } from './status-page.jsx';
import { ActivatePage } from './activate-page.jsx';
import { OAuthConsentPage } from './oauth-consent-page.jsx';
import { SetupGate } from './setup-gate.jsx';
import { TeamJoinPage } from './team-join.jsx';

const OnboardingPreview = lazy(() => import('./onboarding-preview.jsx'));

// An open tab can request a lazy chunk after a deploy has replaced the
// Worker bundle. Old content-hashed assets are no longer served then. Refresh
// once to load the new shell instead of leaving the page with a failed import.
window.addEventListener('vite:preloadError', (event) => {
  const key = `tdoc:preload-reload:${window.location.pathname}`;
  try {
    const lastReload = Number(sessionStorage.getItem(key) || 0);
    if (Date.now() - lastReload < 60_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return; // Without the guard, a persistent load failure could reload forever.
  }
  event.preventDefault();
  window.location.reload();
});

const appRoot = document.getElementById('tdoc-app-root');
const appBoot = window.__TDOC_APP_BOOT__;

if (appRoot && appBoot) {
  let page;
  if (appBoot.page === 'onboarding-preview') page = <Suspense fallback={<p>Loading preview…</p>}><OnboardingPreview /></Suspense>;
  else if (appBoot.page === 'docs-hub') page = <DocsHub boot={appBoot} />;
  else if (appBoot.page === 'feedback-space') page = <FeedbackSpace boot={appBoot} />;
  else if (appBoot.page === 'feedback-install') page = <FeedbackInstall boot={appBoot} />;
  else if (appBoot.page === 'feedback-connect') page = <FeedbackConnect boot={appBoot} />;
  else if (appBoot.page === 'agents') page = <AgentsPage boot={appBoot} />;
  else if (appBoot.page === 'folder-share') page = <FolderShare boot={appBoot} />;
  else if (appBoot.page === 'profile') page = <Profile boot={appBoot} />;
  else if (appBoot.page === 'status') page = <StatusPage boot={appBoot} />;
  else if (appBoot.page === 'activate') page = <ActivatePage boot={appBoot} />;
  else if (appBoot.page === 'oauth-consent') page = <OAuthConsentPage boot={appBoot} />;
  else if (appBoot.page === 'setup') page = <SetupGate boot={appBoot} />;
  else if (appBoot.page === 'team-join') page = <TeamJoinPage boot={appBoot} />;
  else page = <NeutralLanding boot={appBoot} />;
  createRoot(appRoot).render(page);
} else {
  const root = document.getElementById('tdoc-shell-root');
  const boot = window.__TDOC_SHELL_BOOT__;
  const config = window.__TDOC_SHELL__;
  if (!root || !boot || !config || !boot.frameSrc) {
    throw new Error('tdoc boot payload is missing');
  }
  // The app shows the document now; the text copy for agents would only be
  // read twice by a screen reader. Site pages keep it: the page lives in a
  // frame, and a search engine that runs scripts credits the frame's text to
  // the frame's own URL, not to tdoc.dev/ or /pricing. It is hidden from
  // assistive tech instead, so nobody hears the page twice.
  const agentView = document.getElementById('tdoc-agent-view');
  if (config.isLanding) agentView?.setAttribute('aria-hidden', 'true');
  else agentView?.remove();
  createRoot(root).render(<DocumentShell boot={boot} config={config} />);
}
