import { useEffect } from 'react';
import { loadTdocFeedback } from './index.js';

/**
 * <TdocFeedback space="…" /> — renders nothing; puts tdoc comments on the page.
 * `onReady` receives the tdoc API (open, close, comment, on…).
 */
export function TdocFeedback({ space, base, open = false, onReady }) {
  useEffect(() => {
    let cancelled = false;
    loadTdocFeedback({ space, base, open })
      .then((api) => { if (!cancelled && onReady) onReady(api); })
      .catch((error) => { if (!cancelled) console.warn('[tdoc]', error.message); });
    return () => { cancelled = true; };
  }, [space, base, open]);
  return null;
}

export default TdocFeedback;
