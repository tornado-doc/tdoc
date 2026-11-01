import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import '../../../shell/src/docs-hub.css';
import { TeamBackupDialog } from '../../../shell/src/docs-hub/teams.jsx';

createRoot(document.getElementById('root')).render(
  <main className="docs-hub wrap">
    <TeamBackupDialog team={{ id: 't_0123456789abcdef', name: 'Acme' }} onClose={() => {}} />
  </main>,
);
