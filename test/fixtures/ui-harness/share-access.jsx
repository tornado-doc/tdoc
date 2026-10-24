// The real owner Share panel, opened on a new doc. `?doc=public|private|team`
// opens it on a doc that already has that access instead.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../server/chrome.css';
import '../../../shell/src/ui/ui.css';
import { OwnerAccessDialog } from '../../../shell/src/document/owner-access-dialog.jsx';

const kind = new URLSearchParams(location.search).get('doc') || 'new';
const access = kind === 'public'
  ? { visibility: 'public', history_visibility: 'owner', commenting: 'signed_in', allowed_users: [] }
  : kind === 'team'
    ? { visibility: 'private', team: true, history_visibility: 'owner', commenting: 'signed_in', allowed_users: [] }
    // What the worker gives a brand-new doc.
    : { visibility: 'unlisted', history_visibility: 'owner', commenting: 'signed_in', allowed_users: [] };
const team = kind === 'team' ? { id: 'tm_1', name: 'BeFreed' } : null;
const config = team
  ? { slug: 'quarterly-plan', teamManage: { canManage: true, team, access, versionCount: 3, commentCount: 2 } }
  : { slug: 'quarterly-plan', ownerManage: { access, versionCount: 3, commentCount: 2 } };

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Share</button>
      <OwnerAccessDialog
        open={open}
        config={config}
        url="https://tdoc.dev/d/quarterly-plan"
        versionUrl="https://tdoc.dev/d/quarterly-plan/v/3"
        version={3}
        onOpenChange={setOpen}
        onCopied={() => {}}
      />
    </>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
