import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import '../../../shell/src/shell.css';
import '../../../shell/src/setup-gate.css';
import { DocsHub } from '../../../shell/src/docs-hub.jsx';
createRoot(document.getElementById('root')).render(<DocsHub boot={{ identity: { name: 'Alex', email: 'alex@example.com' }, oidcAuth: true }} />);
