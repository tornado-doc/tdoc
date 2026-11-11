import React, { useEffect, useState } from 'react';
import { AppDialog } from '../ui/dialog.jsx';
import { AppButton } from '../ui/button.jsx';
import { allowSheetEmbeds, unnamedVersions } from './sheet-embed.js';

// "Allow sheet embeds on this page": the owner vouches, as their own writing,
// for the versions of this page that name no writer. Before they do, it says
// who the history says wrote those versions, which sheets the page embeds,
// and what it means: whatever those versions put on the page sits beside
// the sheets' rows.
export function AllowSheetEmbedsDialog({ open, slug, sheets, onOpenChange, onAllowed }) {
  const [versions, setVersions] = useState(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!open) return;
    let live = true;
    setVersions(null);
    setStatus('');
    unnamedVersions(slug).then((list) => { if (live) setVersions(list); }).catch(() => { if (live) setStatus('The history could not be read. Try again.'); });
    return () => { live = false; };
  }, [open, slug]);
  const allow = async () => {
    setStatus('Allowing…');
    let ok = false;
    try { ok = await allowSheetEmbeds(slug); } catch {}
    if (!ok) { setStatus('Sheet embeds could not be allowed. Try again.'); return; }
    onAllowed();
  };
  const writers = versions ? [...new Set(versions.map((v) => v.who))] : [];
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Allow sheet embeds on this page?"
      description="Some versions of this page do not record who wrote them, so its embedded sheets show as links. Allowing them vouches for those versions as your own writing."
      actions={(
        <>
          <AppButton onClick={() => onOpenChange(false)}>Cancel</AppButton>
          <AppButton variant="primary" data-action="confirm-allow-embeds" disabled={!versions} onClick={allow}>Allow</AppButton>
        </>
      )}
    >
      <div id="tdoc-allow-embeds">
        <p><strong>Versions without a recorded writer</strong></p>
        {versions ? (
          <ul>
            {versions.map((v) => <li key={v.n}>v{v.n} · {v.who}</li>)}
          </ul>
        ) : <p role="status">{status || 'Reading the history…'}</p>}
        <p><strong>Sheets this page embeds</strong></p>
        <ul>
          {(sheets || []).map((s) => <li key={s}>/d/{s}</li>)}
        </ul>
        <p>Whatever {writers.length ? writers.join(', ') : 'those writers'} put on the page in those versions, styles included, will share the page with these sheets' rows, shown to everyone who can read both.</p>
        {versions && status ? <p role="status">{status}</p> : null}
      </div>
    </AppDialog>
  );
}
