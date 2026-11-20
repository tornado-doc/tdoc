// Which React component an element belongs to, for a comment the feedback
// widget leaves on a site built with React (feature-flags.js
// reactSourceCapture): the component chain ("App › Pricing › PlanCard") and,
// in a dev build, the file and line the element was written at. It rides on
// the comment's anchor as `react` and reaches agents (get_comments `where`,
// Copy for agent) so a fix starts in the right file.
//
// Best effort, read only, never throws: React's internals are not an API.
// Where it looks, nearest element first (at most MAX_DOM_UP ancestors):
// - the fiber React keeps on each element it renders (own property
//   __reactFiber$<id>, React 17+; __reactInternalInstance$<id>, React 16):
//   the `.return` chain gives the component names, `_debugSource` (dev
//   builds of React 16-18) the file / line / column. React 19 dropped
//   `_debugSource`, so there it is names only (unless an attribute below).
// - source attributes some build plugins add (on the element or at most
//   two levels above it): react-dev-inspector
//   (data-inspector-relative-path / -line / -column), Sentry's component
//   annotation (data-sentry-component, data-sentry-source-file) and the
//   plain data-source-file / data-source-line.
// No cost on a page without React: Object.keys of a few elements (React's
// key is an own property; a plain element has none) and a few attribute reads.
//
// Everything read here is the site's, so untrusted: names must look like
// identifiers, strings are one line and cut, numbers are small integers, the
// chain is capped. Whoever shows it shows it as text, never as HTML. The
// server cleans it again (worker cleanReactPart); this module is
// framework-free so the doc frame could reuse it.

export const REACT_MAX_COMPONENTS = 8;
const MAX_NAME = 60;
const MAX_FILE = 200;
const MAX_DOM_UP = 8;
// Source attributes count only on the element or close above it (2 levels):
// an attribute far up the page says nothing about this element.
const MAX_ATTR_UP = 2;
const MAX_FIBERS = 400;
const MAX_LINE = 10_000_000;

// A component name: an identifier (dots for Foo.Bar), PascalCase, not a
// minified one- or two-letter name.
const NAME_RE = /^[A-Z][A-Za-z0-9_$.]{2,59}$/;
export function cleanComponentName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return name.length <= MAX_NAME && NAME_RE.test(name) ? name : '';
}

// A source path, or '' when it is not one. Read off the site's page (an
// attribute any script can set), so it must look like a path and nothing
// else: [A-Za-z0-9._@+-/] only (no spaces, quotes, backticks, brackets or
// "·", so it cannot pose as another field or line for an agent), no ".."
// segment, at most MAX_FILE characters (the end kept, from a "/"). The
// protocol and host go first (file:///, webpack:///, http://localhost:5173/),
// then the query, a drive letter, and the person's home folder (/Users/<name>,
// /home/<name>, /var/home/<name>, /mnt/c/Users/<name>, /root, ~).
// worker.js cleanSourcePath holds the same rules for the server.
const PATH_RE = /^[A-Za-z0-9._@+\-/]{1,200}$/;
export function cleanSourceFile(value) {
  if (typeof value !== 'string') return '';
  let file = value.trim().replace(/\\/g, '/');
  if (!file || file.length > 2000) return '';
  file = file
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, '')
    .replace(/^(?:webpack-internal|webpack|vite|file):/i, '')
    .replace(/[?#].*$/, '')
    .replace(/^\/?[A-Za-z]:(?=\/)/, '')
    .replace(/^~(?=\/|$)/, '')
    .replace(/^\/(?:mnt\/[A-Za-z]\/)?(?:Users|home|var\/home)\/[^/]+(?=\/|$)/i, '')
    .replace(/^\/root(?=\/|$)/, '')
    .replace(/^(?:\.?\/)+/, '');
  if (file.length > MAX_FILE) {
    file = file.slice(-MAX_FILE);
    const cut = file.indexOf('/');
    file = cut >= 0 ? file.slice(cut + 1) : '';
  }
  if (!PATH_RE.test(file)) return '';
  if (file.split('/').some((part) => part === '..')) return '';
  return file;
}

const cleanInt = (value) => {
  const n = typeof value === 'string' && /^\d{1,8}$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 && n <= MAX_LINE ? n : null;
};

// The anchor's `react` part, rebuilt field by field from whatever it was
// given: { components: [outermost … innermost], file?, line?, column? }, or
// null when nothing usable is left.
export function cleanReactSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const components = (Array.isArray(raw.components) ? raw.components.slice(-REACT_MAX_COMPONENTS * 2) : [])
    .map(cleanComponentName).filter(Boolean).slice(-REACT_MAX_COMPONENTS);
  const out = { components };
  const file = cleanSourceFile(raw.file);
  if (file) {
    out.file = file;
    const line = cleanInt(raw.line);
    if (line) {
      out.line = line;
      const column = cleanInt(raw.column);
      if (column) out.column = column;
    }
  }
  return components.length || out.file ? out : null;
}

// "src/Pricing.jsx:42:7"
export function reactSourceLocation(react) {
  if (!react || !react.file) return '';
  return `${react.file}${react.line ? `:${react.line}${react.column ? `:${react.column}` : ''}` : ''}`;
}

// The picker's hover hint: the innermost two components and the file name
// with its line: "Pricing › PlanCard · Pricing.jsx:42".
export function reactSourceHint(react) {
  if (!react) return '';
  const names = (react.components || []).slice(-2).join(' › ');
  const base = react.file ? react.file.split('/').pop() : '';
  const where = base ? `${base}${react.line ? `:${react.line}` : ''}` : '';
  return [names, where].filter(Boolean).join(' · ');
}

const safe = (fn, fallback = null) => { try { return fn(); } catch (_) { return fallback; } };

function fiberOf(node) {
  const keys = safe(() => Object.keys(node), []);
  for (const key of keys) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return safe(() => node[key]);
  }
  return null;
}

function nameOfType(type) {
  if (!type) return '';
  if (typeof type === 'function') return cleanComponentName(safe(() => type.displayName || type.name, ''));
  if (typeof type === 'object') {
    // forwardRef ({ render }), memo ({ type }): their own displayName first.
    const own = cleanComponentName(safe(() => type.displayName, ''));
    if (own) return own;
    const inner = safe(() => type.render || type.type);
    return typeof inner === 'function' ? cleanComponentName(safe(() => inner.displayName || inner.name, '')) : '';
  }
  return '';
}

function fromFiber(fiber) {
  const names = [];
  let source = null;
  let f = fiber;
  for (let steps = 0; f && steps < MAX_FIBERS; steps++) {
    if (!source) {
      const s = safe(() => f._debugSource);
      if (s && typeof s === 'object') {
        const file = cleanSourceFile(safe(() => s.fileName, ''));
        if (file) source = { file, line: safe(() => s.lineNumber), column: safe(() => s.columnNumber) };
      }
    }
    const name = nameOfType(safe(() => f.type));
    if (name && names[names.length - 1] !== name) {
      if (names.length >= REACT_MAX_COMPONENTS) break;
      names.push(name);
    }
    f = safe(() => f.return);
  }
  return { names: names.reverse(), source };
}

function attr(node, name) {
  return safe(() => (node.getAttribute ? node.getAttribute(name) : null));
}

function fromAttributes(node) {
  const inspector = attr(node, 'data-inspector-relative-path');
  if (inspector) return { file: inspector, line: attr(node, 'data-inspector-line'), column: attr(node, 'data-inspector-column') };
  const plain = attr(node, 'data-source-file');
  if (plain) return { file: plain, line: attr(node, 'data-source-line'), column: attr(node, 'data-source-column') };
  const sentry = attr(node, 'data-sentry-source-file');
  if (sentry) return { file: sentry, component: attr(node, 'data-sentry-component') };
  return null;
}

// The `react` part for an element, or null (no React, nothing found, or
// anything went wrong).
export function reactSourceFor(element) {
  try {
    let fiberInfo = null;
    let attrs = null;
    let node = element;
    for (let up = 0; node && node.nodeType === 1 && up < MAX_DOM_UP && !(fiberInfo && (attrs || up > MAX_ATTR_UP)); up++) {
      if (!fiberInfo) {
        const fiber = fiberOf(node);
        if (fiber) fiberInfo = fromFiber(fiber);
      }
      if (!attrs && up <= MAX_ATTR_UP) attrs = fromAttributes(node);
      node = node.parentElement;
    }
    if (!fiberInfo && !attrs) return null;
    const components = fiberInfo ? fiberInfo.names : [];
    if (!components.length && attrs && attrs.component) components.push(attrs.component);
    const source = (fiberInfo && fiberInfo.source) || attrs;
    return cleanReactSource({
      components,
      file: source && source.file,
      line: source && source.line,
      column: source && source.column,
    });
  } catch (_) {
    return null;
  }
}
