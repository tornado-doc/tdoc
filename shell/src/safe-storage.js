// localStorage that cannot take the page down with it.
//
// Reading it THROWS, rather than returning null, in contexts a browser has
// decided should not have storage: third-party-cookie blocking, a sandboxed
// frame, Safari's "prevent cross-site tracking", an incognito profile with
// site data off. The exception is `Access to storage is not allowed from this
// context.`
//
// Most call sites here already wrapped it. Four did not, and three of those
// were inside `useState(() => ...)` initialisers -- the worst possible place,
// because they throw during the FIRST render, so React never mounts the tree.
// The result is a page with a working top bar and nothing under it: the
// document's own text never appears and nothing says why. Seen on tdoc.dev's
// landing page in a browser configured that way, while the same page was
// perfect in a default profile.
//
// A remembered theme is a convenience. It must never be the reason a reader
// cannot see the document.

export function readStored(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
