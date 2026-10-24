import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import '../../../shell/src/shell.css';
import '../../../shell/src/setup-gate.css';
import { SetupGate } from '../../../shell/src/setup-gate.jsx';
createRoot(document.getElementById('root')).render(<SetupGate boot={{ identity: { name: 'Alex', email: 'alex@example.com' }, oidcAuth: true }} />);
