// A sheet's view in the page's #hash (sheet=<encoded view>), beside any
// other key=value pairs there. A hash that is not key=value pairs is a plain
// anchor (#intro) and is never rewritten. No imports: an offline test runs it.
const HASH_KEY = 'sheet';

// The hash as key=value pairs, or null when it is something else (a plain
// #section anchor), which is then never rewritten.
function hashParams(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return new URLSearchParams();
  if (!raw.split('&').every((part) => /^[^=]+=/.test(part))) return null;
  return new URLSearchParams(raw);
}

export function readHashView(hash = typeof location !== 'undefined' ? location.hash : '') {
  const params = hashParams(hash);
  return params ? params.get(HASH_KEY) || '' : '';
}

export function withHashView(hash, view) {
  const params = hashParams(hash);
  if (!params) return String(hash || '');
  if (view) params.set(HASH_KEY, view); else params.delete(HASH_KEY);
  const next = params.toString();
  return next ? `#${next}` : '';
}

