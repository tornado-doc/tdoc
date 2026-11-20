import { useEffect, useRef } from 'react';

// Esc steps back one level, on every comment surface. `levels` runs from the
// innermost (a composer) out (the list); the first active one is closed and
// the key is ours alone (a modal underneath must not close on the same
// press). Nothing active: the key goes on untouched.
// A key someone already handled (an @ menu, a dialog) is left alone.
export function useEscapeLadder(levels, { enabled = true, capture = false } = {}) {
  const ref = useRef(levels);
  ref.current = levels;
  useEffect(() => {
    if (!enabled) return undefined;
    const keydown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const level = ref.current.find((step) => step && (typeof step.active === 'function' ? step.active() : step.active));
      if (!level) return;
      level.close(event);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', keydown, capture);
    return () => window.removeEventListener('keydown', keydown, capture);
  }, [enabled, capture]);
}

// Double-tap Option (Alt) starts a comment from anywhere, without taking a
// single letter from the page (the app keeps its own "C"). Not while typing.
export const DOUBLE_TAP_MS = 430;
export function isDoubleTapTarget(target) {
  return !(target && (target.matches?.('input,textarea,select') || target.isContentEditable));
}
export function useDoubleTapOption(onDouble, { enabled = true, target = typeof document !== 'undefined' ? document : null } = {}) {
  const ref = useRef(onDouble);
  ref.current = onDouble;
  useEffect(() => {
    if (!enabled || !target) return undefined;
    let last = 0;
    const keydown = (event) => {
      if (event.key !== 'Alt' || event.repeat || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const inner = (event.composedPath && event.composedPath()[0]) || event.target;
      if (!isDoubleTapTarget(inner)) return;
      const now = Date.now();
      if (now - last < DOUBLE_TAP_MS) { event.preventDefault(); last = 0; ref.current(); } else last = now;
    };
    target.addEventListener('keydown', keydown, true);
    return () => target.removeEventListener('keydown', keydown, true);
  }, [enabled, target]);
}

// Single keys while a comment surface is open (comments/panel/copy-for-agent.jsx):
// C copies the selected thread for an agent (all open threads when none is
// selected), H hides / shows the comment markers. Esc is the ladder above.
// Letters are the host page's too (the widget runs on other sites, the doc
// is someone's page), so they are taken only while the comment list or a
// thread is open, never with a modifier (⌘C stays copy), never while a key
// repeats or an IME is composing, and never from a place that takes typing.
export const COMMENT_SHORTCUTS = Object.freeze([
  Object.freeze({ key: 'C', action: 'copy', label: 'Copy for agent' }),
  Object.freeze({ key: 'H', action: 'markers', label: 'Hide / show markers' }),
  Object.freeze({ key: 'Esc', action: 'close', label: 'Close' }),
]);

const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]';
// A menu or list box reads letters as type-ahead; a letter there is its own.
const OWN_KEYS = '[role="menu"], [role="menubar"], [role="listbox"], [role="tree"], [role="grid"]';

// True where a letter is text being typed (or a widget's own letter): form
// fields, anything editable, ARIA text boxes, menus and lists.
export function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable) return true;
  const el = target.nodeType === 1 ? target : target.parentElement;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(el.closest(TYPING) || el.closest(OWN_KEYS));
}

// The action a keydown asks for, or null. Pure (tests call it with plain
// objects): the innermost target is composedPath()[0], so a field inside
// a shadow root (the widget) is seen as the field, not as its host.
export function commentShortcutFor(event) {
  if (!event || event.defaultPrevented || event.isComposing || event.repeat) return null;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  const key = String(event.key || '');
  if (key.length !== 1) return null;
  const inner = (typeof event.composedPath === 'function' && event.composedPath()[0]) || event.target;
  if (isTypingTarget(inner) || isOpaqueHost(inner)) return null;
  const active = typeof document !== 'undefined' ? deepActiveElement(document) : null;
  if (active && active !== inner && (isTypingTarget(active) || isOpaqueHost(active))) return null;
  const lower = key.toLowerCase();
  if (lower === 'c') return 'copy';
  if (lower === 'h') return 'markers';
  return null;
}

// A custom element (a dash in its name) with no open shadow root: its
// shadow root is closed, so the key's real target (maybe a field in a host
// app's web component) cannot be seen. Not ours to take.
export function isOpaqueHost(target) {
  const el = target && target.nodeType === 1 ? target : null;
  if (!el) return false;
  const name = String(el.localName || el.tagName || '').toLowerCase();
  return name.includes('-') && !el.shadowRoot;
}

function deepActiveElement(doc) {
  let el = doc.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

// handlers: { copy, markers } (a missing one leaves its key to the page).
// Window capture, as the Esc ladder: the host page does not also act on a
// key we took.
export function useCommentShortcuts(handlers, { enabled = true } = {}) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const keydown = (event) => {
      const action = commentShortcutFor(event);
      const run = action && ref.current && ref.current[action];
      if (!run) return;
      event.preventDefault();
      event.stopPropagation();
      run(event);
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [enabled]);
}
