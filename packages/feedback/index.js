// A thin loader. The comment UI itself is served by tdoc (feedback.js), so it
// is always the current one; this package only puts it on the page, once,
// and hands back the `tdoc` API it exposes.
const DEFAULT_BASE = 'https://tdoc.dev';
let loading = null;

/**
 * Put tdoc comments on this page.
 * @param {{ space: string, base?: string, open?: boolean }} options
 * @returns {Promise<import('./index').TdocApi>}
 */
export function loadTdocFeedback({ space, base = DEFAULT_BASE, open = false } = {}) {
  if (typeof window === 'undefined') return Promise.reject(new Error('tdoc feedback runs in a browser'));
  if (!space || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(String(space))) {
    return Promise.reject(new Error('loadTdocFeedback: `space` is the id from tdoc (My docs → Feedback → Add to your site)'));
  }
  if (window.tdocFeedback) return Promise.resolve(window.tdocFeedback);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let origin;
    try { origin = new URL(String(base)).origin; } catch (_) { loading = null; reject(new Error(`Not a URL: ${base}`)); return; }
    script.src = `${origin}/feedback.js`;
    script.async = true;
    script.setAttribute('data-tdoc-space', space);
    if (open) script.setAttribute('data-tdoc-open', '1');
    script.onerror = () => { loading = null; reject(new Error(`Could not load ${script.src}`)); };
    script.onload = () => {
      // The API appears once the client has mounted.
      const started = Date.now();
      (function wait() {
        if (window.tdocFeedback) return resolve(window.tdocFeedback);
        if (Date.now() - started > 10000) { loading = null; return reject(new Error('tdoc feedback did not start')); }
        setTimeout(wait, 50);
      })();
    };
    document.head.appendChild(script);
  });
  return loading;
}

export default loadTdocFeedback;
