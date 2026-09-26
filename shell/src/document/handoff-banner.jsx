// Top-of-doc strip for in-flight handoffs only (waiting / failed).
// No send actions here — those live on the details panel, one row at a time.

import React, { useMemo } from 'react';
import { formatHandoffAgo } from './handoff-ago.js';
import { summarizeHandoffSurfaces } from './handoff-state.js';

export { formatHandoffAgo } from './handoff-ago.js';

export function HandoffBanner({
  comments,
  onOpenDetails,
}) {
  const summary = useMemo(() => summarizeHandoffSurfaces(comments), [comments]);
  const failed = summary.failed;
  const waiting = summary.waiting;
  if (!failed.length && !waiting.length) return null;

  let latestAt = null;
  for (const c of [...waiting, ...failed]) {
    if (!c.handoff_at) continue;
    if (!latestAt || Date.parse(c.handoff_at) > Date.parse(latestAt)) latestAt = c.handoff_at;
  }
  const ago = latestAt ? formatHandoffAgo(latestAt) : '';

  const line = failed.length
    ? `${failed.length} handoff${failed.length === 1 ? '' : 's'} not delivered${ago ? ` · ${ago}` : ''}`
    : `Waiting on agent · ${waiting.length} comment${waiting.length === 1 ? '' : 's'}${ago ? ` · ${ago}` : ''}`;

  return (
    <div className={`tdoc-handoff-banner${failed.length ? ' is-failed' : ''}`} role="status">
      <span className="tdoc-handoff-banner-text">{line}</span>
      <span className="tdoc-handoff-banner-actions">
        <button type="button" className="text-btn" onClick={onOpenDetails}>
          Details
        </button>
      </span>
    </div>
  );
}
