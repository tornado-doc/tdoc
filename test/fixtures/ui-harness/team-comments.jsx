import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import '../../../shell/src/docs-hub.css';
import { TeamCommentsPane } from '../../../shell/src/docs-hub/teams.jsx';

const pageSize = Number(new URLSearchParams(location.search).get('pageSize')) || 25;

createRoot(document.getElementById('root')).render(
  <main className="docs-hub wrap">
    <h1>BeFreed</h1>
    <div className="tabs tm-view-tabs" role="tablist">
      <button type="button" className="tab">Docs</button>
      <button type="button" className="tab is-active">Comments</button>
    </div>
    <TeamCommentsPane team={{ id: 't_0123456789abcdef', name: 'BeFreed' }} pageSize={pageSize} />
  </main>,
);
