// Product anchors may come from another commenter or from older stored data.
// Only absolute web URLs are safe to put in a link or navigate to.
export function productPageUrl(raw, origin = null) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (origin && url.origin !== origin) return null;
    return url.href;
  } catch {
    return null;
  }
}
