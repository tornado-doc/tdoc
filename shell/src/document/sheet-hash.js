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
  return withHashParam(hash, HASH_KEY, view);
}

// The sheet shown full screen: #expand=1, so a link opens it that way.
const EXPAND_KEY = 'expand';

export function readHashExpanded(hash = typeof location !== 'undefined' ? location.hash : '') {
  const params = hashParams(hash);
  return params ? params.get(EXPAND_KEY) === '1' : false;
}

export function withHashExpanded(hash, open) {
  return withHashParam(hash, EXPAND_KEY, open ? '1' : '');
}

function withHashParam(hash, key, value) {
  const params = hashParams(hash);
  if (!params) return String(hash || '');
  if (value) params.set(key, value); else params.delete(key);
  const next = params.toString();
  return next ? `#${next}` : '';
}

// The sheet's own page: /d/<slug>?sheet=<n> shows tab n (1-based) and
// nothing else of the doc. 0 when the page is the doc.
export function readSheetAlone(search = typeof location !== 'undefined' ? location.search : '') {
  const n = Number(new URLSearchParams(search).get('sheet'));
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : 0;
}

