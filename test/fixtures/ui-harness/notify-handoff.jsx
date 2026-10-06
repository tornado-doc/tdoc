// Mounts the Send to agent dialog on its own, for test/notify-handoff-ui.test.js.
// The document page and the feedback overlay render this same component.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import { NotifyHandoffPanel } from '../../../shell/src/document/notify-handoff.jsx';

const ids = JSON.parse(new URLSearchParams(location.search).get('ids') || '[]');
createRoot(document.getElementById('root')).render(
  <NotifyHandoffPanel slug="doc" open commentIds={ids} onClose={() => {}} />,
);
