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
