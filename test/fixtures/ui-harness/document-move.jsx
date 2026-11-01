// Real document overflow action + shared workspace picker. This keeps the
// browser regression focused on the path an owner uses from an open doc.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MoreHorizontal } from 'lucide-react';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import '../../../shell/src/docs-hub/teams.css';
import { AppMenu } from '../../../shell/src/ui/menu.jsx';
import { DocumentOverflowActions } from '../../../shell/src/document/document-toolbar.jsx';
import { MoveToTeamDialog } from '../../../shell/src/docs-hub/teams.jsx';

const config = {
  mode: 'published',
  isOwner: true,
  ownerManage: true,
  viewerStar: true,
  version: 3,
  versions: [{ n: 1 }, { n: 2 }, { n: 3 }],
  slug: 'quarterly-plan',
  // The workspace comes from document metadata even when session-derived
  // teamManage is temporarily absent (for example immediately after joining).
  workspaceId: 'tm_current',
};

function Harness() {
  const [moving, setMoving] = useState(false);
  const [picked, setPicked] = useState('');
  return (
    <>
      <header className="tdoc-bar">
        <div className="tdoc-bar-left">
          <span className="doc-title">Quarterly plan</span>
          <span className="doc-author">Julie</span>
        </div>
        <div className="tdoc-bar-right">
          <AppMenu
            trigger={(
              <button id="tdoc-more-btn" type="button" aria-label="More actions">
                <MoreHorizontal size={18} />
              </button>
            )}
          >
            <DocumentOverflowActions
              config={config}
              starred={false}
              onToggleStar={() => {}}
              onPublish={() => {}}
              onShare={() => {}}
              onCopyMarkdown={() => {}}
              onDuplicate={() => {}}
              onDownload={() => {}}
              onPrint={() => {}}
              onMoveDocument={() => setMoving(true)}
              onDelete={() => {}}
              resolvedCount={0}
              showResolved={false}
              onToggleResolved={() => {}}
              onCompare={() => {}}
            />
          </AppMenu>
        </div>
      </header>
      <main style={{ maxWidth: 720, margin: '56px auto', padding: '0 20px', font: '16px/1.6 system-ui' }}>
        <h1>Quarterly plan</h1>
        <p>An open document whose author can move it from the top-right menu.</p>
        {picked ? <p role="status">Moving to {picked}</p> : null}
      </main>
      {moving ? (
        <MoveToTeamDialog
          title="Move Quarterly plan"
          count={1}
          teams={[
            { id: 'tm_current', name: 'Tdoc' },
            { id: 'tm_befreed', name: 'BeFreed' },
          ]}
          includePersonal
          currentTeam="tm_current"
          onMove={(team) => { setPicked(team.name); setMoving(false); }}
          onClose={() => setMoving(false)}
        />
      ) : null}
    </>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
