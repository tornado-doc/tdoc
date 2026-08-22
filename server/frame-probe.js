// tdoc frame probe — injected into the sandboxed author document (/frame) in
// shell mode. It is the ONLY tdoc code that reaches into the author DOM; it
// reports selections/anchors/geometry to the shell over postMessage and applies
// highlight/scroll commands the shell sends back. The shell (outer document)
// owns all chrome (top bar, composer, pins, cards) and never touches this DOM.
//
// Protocol (all messages carry { source: 'tdoc-frame' } outbound / are validated
// by event.source inbound; the frame's origin is opaque so we cannot check
// event.origin — we validate by window identity + shape instead):
//   frame → shell:
//     { type:'tdoc:ready',     height }
//     { type:'tdoc:selection', text, context_before, context_after, rect }
//     { type:'tdoc:cleared' }
//     { type:'tdoc:scroll',    scrollY, height }
//   shell → frame:
//     { type:'tdoc:scrollTo',  y }               (P3)
//     { type:'tdoc:highlight', ranges:[...] }     (P3)
(function () {
  'use strict';
  function post(msg) {
    try { window.parent.postMessage(Object.assign({ source: 'tdoc-frame' }, msg), '*'); } catch (e) {}
  }

  // Last visible line box of the selection = where the user finished (mouse-up
  // / caret), not the union of all line boxes. Mirrors overlay.js selectionEndRect.
  function selectionRect(range) {
    const rects = range.getClientRects ? range.getClientRects() : null;
    if (rects && rects.length) {
      for (let i = rects.length - 1; i >= 0; i--) {
        const r = rects[i];
        if (r.width > 0 || r.height > 0) {
          return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
        }
      }
    }
    const r = range.getBoundingClientRect();
    return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
  }

  // Lightweight context (P2). P3 will port overlay.js's TreeWalker-based
  // normalized-text model for robust re-anchoring across versions.
  function context(range, chars) {
    try {
      const sc = range.startContainer, ec = range.endContainer;
      const before = (sc.textContent || '').slice(Math.max(0, range.startOffset - chars), range.startOffset);
      const after = (ec.textContent || '').slice(range.endOffset, range.endOffset + chars);
      return { before: before, after: after };
    } catch (e) { return { before: '', after: '' }; }
  }

  function reportSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (!text) return;
    const range = sel.getRangeAt(0);
    const ctx = context(range, 60);
    post({ type: 'tdoc:selection', text: text, context_before: ctx.before, context_after: ctx.after, rect: selectionRect(range) });
  }

  // Selection is finalized on mouseup (and touchend, one tick later on iOS).
  document.addEventListener('mouseup', function () { setTimeout(reportSelection, 0); }, true);
  document.addEventListener('touchend', function () { setTimeout(reportSelection, 0); }, true);
  document.addEventListener('mousedown', function () { post({ type: 'tdoc:cleared' }); }, true);

  // Keep the shell's pin layer aligned with the document as it scrolls.
  let ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return; ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      post({ type: 'tdoc:scroll', scrollY: window.scrollY || window.pageYOffset || 0, height: document.documentElement.scrollHeight });
    });
  }, { passive: true });

  post({ type: 'tdoc:ready', height: document.documentElement.scrollHeight });
})();
