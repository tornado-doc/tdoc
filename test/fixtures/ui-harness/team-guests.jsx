import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import '../../../shell/src/docs-hub.css';
import { TeamSettingsPane } from '../../../shell/src/docs-hub/teams.jsx';

window.__TDOC_APP_BOOT__ = { devMode: { on: true } };
createRoot(document.getElementById('root')).render(<main className="docs-hub wrap">
  <TeamSettingsPane team={{ id: 't_0123456789abcdef', name: 'BeFreed', role: 'admin' }} onChanged={() => {}} onLeave={() => {}} />
</main>);
