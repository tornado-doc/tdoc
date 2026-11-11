import { useCallback } from 'react';
import { readStored, writeStored } from '../safe-storage.js';
import { isFeatureOn } from '../feature-flags.js';
import { readHashExpanded, readHashView, readSheetAlone, withHashExpanded, withHashView } from './sheet-hash.js';

// A sheet's view (search, filters, sort, open tab, column widths) belongs to
// the reader, not the document. The sandboxed frame has no storage of its
// own, so the shell keeps it: the query in the page's #sheet= hash, so a
// filtered view is a link you can send, and the whole view in localStorage
// per doc, so it is still there next time. Widths stay local. A signed-out
// visitor to the homepage keeps nothing: no storage, no hash rewrite.
//
//   frame → shell { type:'tdoc:sheetReady', tabs }
//   shell → frame { type:'tdoc:sheetConfig', editing, hash, widths, path, expanded, alone }
//   frame → shell { type:'tdoc:sheetView', hash, widths }
//   frame → shell { type:'tdoc:sheetExpand', open }
//
// Full screen is in the hash too (#expand=1), so a link opens the sheet that
// way. The sheet's own page is the same doc at ?sheet=<tab>: same version,
// same comments, only that tab, full screen; `path` lets the frame link to it.

const storeKey = (slug) => `tdoc-sheet-view:${slug}`;
const INDEX_KEY = 'tdoc-sheet-views';
// Views remembered per browser, newest first; older ones are dropped.
export const MAX_STORED_VIEWS = 50;

function readStoredView(slug) {
  try {
    const value = JSON.parse(readStored(storeKey(slug)) || 'null');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function storeView(slug, value) {
  let index = [];
  try { index = JSON.parse(readStored(INDEX_KEY) || '[]'); } catch {}
  if (!Array.isArray(index)) index = [];
  index = [slug, ...index.filter((s) => s !== slug && typeof s === 'string')];
  for (const old of index.slice(MAX_STORED_VIEWS)) {
    try { localStorage.removeItem(storeKey(old)); } catch {}
  }
  writeStored(INDEX_KEY, JSON.stringify(index.slice(0, MAX_STORED_VIEWS)));
  writeStored(storeKey(slug), JSON.stringify(value));
}

export function useSheetView({ slug, send, persist = true }) {
  const ready = useCallback(() => {
    const stored = persist ? readStoredView(slug) : {};
    // A link that carries a view wins over the one remembered here.
    const fromLink = readHashView();
    send({
      type: 'tdoc:sheetConfig',
      editing: isFeatureOn('sheets'),
      hash: fromLink || (typeof stored.hash === 'string' ? stored.hash : ''),
      widths: stored.widths && typeof stored.widths === 'object' ? stored.widths : {},
      path: location.pathname,
      expanded: readHashExpanded(),
      alone: readSheetAlone(),
    });
  }, [persist, send, slug]);

  const expandChanged = useCallback((message) => {
    const next = withHashExpanded(location.hash, message.open === true);
    if (next !== (location.hash || '')) {
      try { history.replaceState(history.state, '', `${location.pathname}${location.search}${next}`); } catch {}
    }
  }, []);

  const viewChanged = useCallback((message) => {
    if (!persist) return;
    const hash = typeof message.hash === 'string' ? message.hash.slice(0, 4000) : '';
    let widths = message.widths && typeof message.widths === 'object' ? message.widths : {};
    // The frame is author-controlled territory: keep what it hands over small.
    if (JSON.stringify(widths).length > 20_000) widths = {};
    storeView(slug, { hash, widths });
    const next = withHashView(location.hash, hash);
    if (next !== (location.hash || '')) {
      try { history.replaceState(history.state, '', `${location.pathname}${location.search}${next}`); } catch {}
    }
  }, [persist, slug]);

  return { 'tdoc:sheetReady': ready, 'tdoc:sheetView': viewChanged, 'tdoc:sheetExpand': expandChanged };
}
