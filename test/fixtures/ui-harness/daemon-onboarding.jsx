import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import '../../../shell/src/shell.css';
import '../../../shell/src/setup-gate.css';
import { DocsHub } from '../../../shell/src/docs-hub.jsx';
import OnboardingPreview from '../../../shell/src/onboarding-preview.jsx';
// The AI onboarding is dev-mode only; ?classic renders an ordinary account.
window.__TDOC_APP_BOOT__ = new URLSearchParams(location.search).has('classic') ? {} : { devMode: { on: true } };
createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('preview') ? <OnboardingPreview /> : <DocsHub boot={{ identity: { name: 'Alex', email: 'alex@example.com' }, oidcAuth: true }} />);
