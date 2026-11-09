import { useCallback } from 'react';
import { readStored, writeStored } from '../safe-storage.js';
import { isFeatureOn } from '../feature-flags.js';

// A sheet's view (search, filters, sort, open tab, column widths) belongs to
// the reader, not the document. The sandboxed frame has no storage of its
// own, so the shell keeps it: the query in the page's #sheet= hash, so a
// filtered view is a link you can send, and the whole view in localStorage
// per doc, so it is still there next time. Widths stay local.
//
//   frame → shell { type:'tdoc:sheetReady', tabs }
//   shell → frame { type:'tdoc:sheetConfig', editing, hash, widths }
//   frame → shell { type:'tdoc:sheetView', hash, widths }

const HASH_KEY = 'sheet';
const storeKey = (slug) => `tdoc-sheet-view:${slug}`;

export function readHashView(hash = location.hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  return params.get(HASH_KEY) || '';
}

export function withHashView(hash, view) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  if (view) params.set(HASH_KEY, view); else params.delete(HASH_KEY);
  const next = params.toString();
  return next ? `#${next}` : '';
}

function readStoredView(slug) {
  try {
    const value = JSON.parse(readStored(storeKey(slug)) || 'null');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function useSheetView({ slug, send }) {
  const ready = useCallback(() => {
    const stored = readStoredView(slug);
    // A link that carries a view wins over the one remembered here.
    const fromLink = readHashView();
    send({
      type: 'tdoc:sheetConfig',
      editing: isFeatureOn('sheets'),
      hash: fromLink || (typeof stored.hash === 'string' ? stored.hash : ''),
      widths: stored.widths && typeof stored.widths === 'object' ? stored.widths : {},
    });
  }, [send, slug]);

  const viewChanged = useCallback((message) => {
    const hash = typeof message.hash === 'string' ? message.hash.slice(0, 4000) : '';
    let widths = message.widths && typeof message.widths === 'object' ? message.widths : {};
    // The frame is author-controlled territory: keep what it hands over small.
    if (JSON.stringify(widths).length > 20_000) widths = {};
    writeStored(storeKey(slug), JSON.stringify({ hash, widths }));
    const next = withHashView(location.hash, hash);
    if (next !== (location.hash || '')) {
      try { history.replaceState(history.state, '', `${location.pathname}${location.search}${next}`); } catch {}
    }
  }, [slug]);

  return { 'tdoc:sheetReady': ready, 'tdoc:sheetView': viewChanged };
}
