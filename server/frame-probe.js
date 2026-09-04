// tdoc frame probe — injected into the sandboxed author document (/frame) in
// shell mode. It is the ONLY tdoc code that reaches into the author DOM: it
// reports selections/anchors/geometry to the shell over postMessage and applies
// highlight/scroll commands the shell sends back. The shell (outer document)
// owns all chrome (top bar, composer, pins, cards) and never touches this DOM.
//
// Protocol (outbound carries { source:'tdoc-frame' }; inbound is validated by
// event.source === window.parent + { source:'tdoc-shell' }; the frame origin is
// opaque so we cannot check event.origin — validate by window identity + shape):
//   frame → shell:
//     { type:'tdoc:ready',     height }
//     { type:'tdoc:selection', text, context_before, context_after, rect }
//     { type:'tdoc:cleared' }
//     { type:'tdoc:scroll',    scrollY, height }
//     { type:'tdoc:pins',      pins:[{id,docY,login,avatar_url,kind,resolved}], scrollY, articleRight, docHeight }
//   shell → frame:
//     { type:'tdoc:anchors',   comments:[...] }   // resolve → highlight → report pins
//     { type:'tdoc:scrollTo',  docY }
//     { type:'tdoc:focusAnchor', id, scroll }      // activate and optionally reveal an anchor
(function () {
  'use strict';
  function post(msg) {
    try { window.parent.postMessage(Object.assign({ source: 'tdoc-frame' }, msg), '*'); } catch (e) {}
  }
  var interactionMode = 'read';
  // Whether the shell currently has a comment card, cluster, or composer open.
  // While something is open, the next click anywhere in the document only
  // dismisses it — it must not open a different comment or start a new one.
  var shellUiOpen = false;
  var swallowClick = false;
  var dismissDownX = 0, dismissDownY = 0;
  var COMMENT_ICON_PATH = 'M2 2H12A10 10 0 1 1 2 12V2Z';
  var COMMENT_ACCENT = '#1652f0';
  var HL = !!(window.CSS && CSS.highlights && window.Highlight);
  function highlightCss(dark) {
    var anchor = dark ? 'rgba(255,214,0,.78)' : 'rgba(255,214,0,.38)';
    var pending = dark ? 'rgba(255,214,0,.88)' : 'rgba(255,214,0,.55)';
    var selecting = dark ? 'rgba(76,137,255,.72)' : 'rgba(22,82,240,.32)';
    return '::highlight(tdoc-anchor){background:' + anchor + ';text-decoration:underline solid rgba(184,134,11,.7);text-decoration-thickness:2px;}' +
      '::highlight(tdoc-anchor-active){background:rgba(255,216,77,.94);text-decoration:underline solid #b8860b;text-decoration-thickness:3px;}' +
      '::highlight(tdoc-selecting){background:' + selecting + ';}' +
      '::highlight(tdoc-pending){background:' + pending + ';}';
  }
  var st = null;
  if (HL) {
    st = document.createElement('style');
    st.id = 'tdoc-provider-highlight-style';
    st.setAttribute('data-tdoc-provider', '');
    st.textContent = highlightCss(false);
    (document.head || document.documentElement).appendChild(st);
  }
  // Element-comment affordances live IN the frame (they hug author artifacts).
  // Colors are inlined (the frame has no :root chrome tokens); look matches the
  // overlay's .tdoc-hover-outline / .tdoc-comment-pill.
  (function () {
    var s = document.createElement('style');
    var cursorSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="' + COMMENT_ICON_PATH + '" fill="' + COMMENT_ACCENT + '"/></svg>';
    var commentCursor = 'url("data:image/svg+xml,' + encodeURIComponent(cursorSvg) + '") 2 2, crosshair';
    s.id = 'tdoc-provider-comment-style';
    s.setAttribute('data-tdoc-provider', '');
    s.textContent =
      '.tdoc-hover-outline{position:absolute;pointer-events:none;z-index:2147483644;border:2px dashed ' + COMMENT_ACCENT + ';border-radius:4px;background:rgba(22,82,240,.06);box-sizing:border-box;}' +
      '.tdoc-comment-pill{position:absolute;z-index:2147483645;width:30px;height:30px;padding:0;background:rgba(255,255,255,.96);color:' + COMMENT_ACCENT + ';border:1px solid #dedee3;border-radius:999px;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.06),0 3px 10px rgba(0,0,0,.08);display:inline-flex;align-items:center;justify-content:center;line-height:1;}' +
      '.tdoc-comment-pill:hover{background:' + COMMENT_ACCENT + ';color:#fff;border-color:' + COMMENT_ACCENT + ';}' +
      '.tdoc-comment-pill svg{width:14px;height:14px;stroke:none;}' +
      'html[data-tdoc-interaction-mode="comment"] body,html[data-tdoc-interaction-mode="comment"] body *{cursor:' + commentCursor + '!important;}' +
      'html[data-tdoc-interaction-mode="comment"][data-tdoc-selecting] body,html[data-tdoc-interaction-mode="comment"][data-tdoc-selecting] body *{cursor:text!important;}' +
      'html[data-tdoc-interaction-mode="comment"] body ::selection{background:rgba(22,82,240,.32)!important;color:inherit!important;}' +
      'html[data-tdoc-interaction-mode="comment"] .tdoc-comment-pill{cursor:pointer!important;}' +
      'html[data-tdoc-editing] [data-tdoc-editor-root]{outline:none;caret-color:#1652f0;}' +
      'html[data-tdoc-editing] [data-tdoc-editor-root]:focus{box-shadow:inset 0 0 0 1px rgba(22,82,240,.18);}';
    (document.head || document.documentElement).appendChild(s);
  })();

  // --- selection capture ---------------------------------------------------
  function selectionRect(range) {
    var rects = range.getClientRects ? range.getClientRects() : null;
    if (rects && rects.length) {
      for (var i = rects.length - 1; i >= 0; i--) {
        var r = rects[i];
        if (r.width > 0 || r.height > 0) return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
      }
    }
    var b = range.getBoundingClientRect();
    return { top: b.top, left: b.left, bottom: b.bottom, right: b.right, width: b.width, height: b.height };
  }
  function context(range, chars) {
    try {
      // Context must cross text-node boundaries. Reading only startContainer
      // and endContainer leaves both sides empty when a user selects a whole
      // table cell, heading, or inline run. That makes repeated labels
      // impossible to disambiguate after reload.
      var beforeRange = document.createRange();
      beforeRange.selectNodeContents(document.body);
      beforeRange.setEnd(range.startContainer, range.startOffset);
      var afterRange = document.createRange();
      afterRange.selectNodeContents(document.body);
      afterRange.setStart(range.endContainer, range.endOffset);
      var beforeText = beforeRange.toString(), afterText = afterRange.toString();
      var before = beforeText.slice(Math.max(0, beforeText.length - chars));
      var after = afterText.slice(0, chars);
      return { before: before, after: after };
    } catch (e) { return { before: '', after: '' }; }
  }
  // Which occurrence of this text the selection is, counted through the same
  // normalized view the resolver searches. Context disambiguates most repeats,
  // but not a short run inside a row that repeats verbatim — and a person who
  // can select something expects to be able to comment on it. This is the
  // deterministic tiebreak for that case; it is advisory, so an older anchor
  // without one, or a regenerated document where the count changed, still
  // resolves the way it always did.
  // Where this selection sits in the view the resolver will search, and what
  // surrounds it THERE. Context read off the live DOM instead drifts from what
  // resolution compares against: Range.toString() walks into the injected
  // probe <script> (which collectTextNodes rejects) and misses the virtual
  // space the view inserts at every <br> and block boundary. Measuring both
  // sides in one coordinate space is what makes the comparison mean anything.
  function placeInView(range, text) {
    try {
      var view = docView();
      var needle = normalizeNeedle(text);
      if (!needle || !view.norm) return null;
      // Where the selection starts, in raw view coordinates. A triple-click, or
      // dragging across a whole table cell, leaves the range's endpoint on an
      // ELEMENT rather than a text node — so matching on startContainer alone
      // loses exact placement for exactly the selections people make fastest.
      // The first text node the range touches is where its text begins.
      var raw = -1;
      for (var i = 0; i < view.nodes.length; i++) {
        var node = view.nodes[i].node;
        if (node === range.startContainer) { raw = view.nodes[i].start + range.startOffset; break; }
        if (range.intersectsNode && range.intersectsNode(node)) { raw = view.nodes[i].start; break; }
      }
      if (raw < 0) return null;
      // normToRaw ascends: the first norm index at or past this raw offset.
      var lo = 0, hi = view.normToRaw.length - 1, at = view.normToRaw.length;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (view.normToRaw[mid] >= raw) { at = mid; hi = mid - 1; } else lo = mid + 1;
      }
      var hits = [];
      for (var j = 0; (j = view.norm.indexOf(needle, j)) !== -1; j += Math.max(1, needle.length)) hits.push(j);
      var index = -1;
      for (var k = 0; k < hits.length; k++) if (hits[k] >= at) { index = k; break; }
      if (index === -1) index = hits.length ? hits.length - 1 : 0;
      var start = hits.length ? hits[index] : at;
      return {
        occurrence: index,
        occurrences: hits.length,
        before: view.norm.slice(Math.max(0, start - 60), start),
        after: view.norm.slice(start + needle.length, start + needle.length + 60)
      };
    } catch (e) { return null; }
  }

  function postTextSelection(range, text) {
    var placed = placeInView(range, text);
    var ctx = placed ? { before: placed.before, after: placed.after } : context(range, 60);
    // Paint the pending anchor so it stays visibly marked while the composer
    // (in the shell document) has focus; cleared on cancel/close (#281 parity).
    if (HL) {
      try {
        CSS.highlights.delete('tdoc-selecting');
        CSS.highlights.set('tdoc-pending', new Highlight(range.cloneRange()));
      } catch (e) {}
    }
    post({ type: 'tdoc:selection', text: text, context_before: ctx.before, context_after: ctx.after,
           occurrence: placed ? placed.occurrence : null,
           occurrences: placed ? placed.occurrences : null,
           rect: selectionRect(range) });
  }
  function reportSelection() {
    if (interactionMode !== 'comment') return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    var text = sel.toString().trim();
    if (!text) return;
    var range = sel.getRangeAt(0);
    postTextSelection(range, text);
  }
  function caretAtPoint(x, y) {
    if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(x, y);
      if (pos) return { node: pos.offsetNode, offset: pos.offset };
    }
    if (document.caretRangeFromPoint) {
      var caret = document.caretRangeFromPoint(x, y);
      if (caret) return { node: caret.startContainer, offset: caret.startOffset };
    }
    return null;
  }
  function wordBounds(value, offset) {
    if (!value) return null;
    var at = Math.max(0, Math.min(offset, value.length));
    if (window.Intl && Intl.Segmenter) {
      try {
        var segments = Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(value));
        var nearest = null;
        segments.forEach(function (part) {
          if (!part.isWordLike) return;
          var end = part.index + part.segment.length;
          if (part.index <= at && at <= end) nearest = { start: part.index, end: end };
          else if (!nearest && end === at) nearest = { start: part.index, end: end };
        });
        if (nearest) return nearest;
      } catch (e) {}
    }
    var isWord = function (ch) { return !!ch && !/[\s.,;:!?()[\]{}<>"'`~@#$%^&*+=|\\/\-]/.test(ch); };
    var i = at < value.length && isWord(value.charAt(at)) ? at : at - 1;
    if (i < 0 || !isWord(value.charAt(i))) return null;
    var start = i, end = i + 1;
    while (start > 0 && isWord(value.charAt(start - 1))) start--;
    while (end < value.length && isWord(value.charAt(end))) end++;
    return { start: start, end: end };
  }
  // caretPositionFromPoint answers with the NEAREST caret, not the one under the
  // pointer: a click in a margin, in the gap between blocks, or below the last
  // line still resolves into the closest text node. Commenting on a word the
  // pointer was never over is how a click meant to dismiss a card opened a
  // different one, and how blank space 30px under a paragraph could select a
  // word inside a <pre>. A click is on a word or it is not — no proximity.
  function pointOverRange(range, x, y) {
    var rects = range.getClientRects();
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  }
  function reportPointSelection(event) {
    if (interactionMode !== 'comment' || event.button !== 0) return;
    if (event.target && event.target.closest && event.target.closest('a,button,input,textarea,select,summary,[contenteditable],.tdoc-comment-pill')) return;
    var current = window.getSelection();
    if (current && !current.isCollapsed) return; // a drag selection owns this click
    var point = caretAtPoint(event.clientX, event.clientY);
    if (!point || !point.node || point.node.nodeType !== Node.TEXT_NODE) return;
    var bounds = wordBounds(point.node.nodeValue || '', point.offset);
    if (!bounds || bounds.end - bounds.start < 1) return;
    try {
      var range = document.createRange();
      range.setStart(point.node, bounds.start); range.setEnd(point.node, bounds.end);
      var text = range.toString().trim();
      if (!text) return;
      // Clicked past the text, not on it: leave the click to the clear path so
      // it dismisses whatever is open instead of commenting on a neighbour.
      if (!pointOverRange(range, event.clientX, event.clientY)) return;
      if (current) { current.removeAllRanges(); current.addRange(range); }
      event.preventDefault(); event.stopPropagation();
      postTextSelection(range, text);
    } catch (e) {}
  }
  // Links: a click inside the sandboxed frame would navigate the FRAME (nested
  // shell / 404), not the page. Intercept and hand navigation to the shell,
  // which navigates the top document (or opens a tab for target=_blank).
  document.addEventListener('click', function (e) {
    // The mousedown of this same gesture dismissed something. Let it end there.
    if (swallowClick) {
      swallowClick = false;
      // Stop only our own affordances and links — the pill would otherwise open
      // an element comment on the very click that closed a card. Author markup
      // (a <details> toggle, a button) keeps behaving normally.
      if (e.target && e.target.closest && e.target.closest('.tdoc-comment-pill, a[href]')) {
        e.preventDefault(); e.stopPropagation();
      }
      return;
    }
    var commentId = interactionMode === 'edit' ? null : anchorIdAtPoint(e.clientX, e.clientY);
    if (commentId) {
      e.preventDefault(); e.stopPropagation();
      setActiveAnchor(commentId, false);
      post({ type: 'tdoc:anchorClick', id: commentId });
      return;
    }
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) { reportPointSelection(e); return; }
    if (interactionMode === 'edit') { e.preventDefault(); return; }
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;                    // in-page anchors stay in the frame
    if (!/^(https?:\/\/|\/(?!\/))/i.test(href)) return;             // javascript:/data: etc. — let CSP kill them
    e.preventDefault(); e.stopPropagation();
    post({ type: 'tdoc:navigate', href: href, blank: a.getAttribute('target') === '_blank' });
  }, true);

  function clearSelectingCursor() { document.documentElement.removeAttribute('data-tdoc-selecting'); }
  document.addEventListener('mouseup', function (e) {
    clearSelectingCursor();
    // A dismissing click must not report a selection either. Content styled
    // `user-select: all` selects its whole block on a single click, which came
    // back as a composer on the very click that closed a card. A real drag is
    // still a selection, so only a pointer that stayed put is suppressed.
    var moved = Math.abs(e.clientX - dismissDownX) > 4 || Math.abs(e.clientY - dismissDownY) > 4;
    if (swallowClick && !moved) {
      // A click whose only job is to dismiss. Content styled `user-select: all`
      // selects its whole block on one click, which came back as a composer on
      // the very click that closed a card, so no selection is reported either.
      if (HL) CSS.highlights.delete('tdoc-pending');
      setActiveAnchor(null, false);
      post({ type: 'tdoc:cleared' });
      return;
    }
    setTimeout(reportSelection, 0);
  }, true);
  document.addEventListener('touchend', function () { setTimeout(reportSelection, 0); }, true);
  window.addEventListener('blur', clearSelectingCursor);
  document.addEventListener('copy', function (e) {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
    var text = sel.toString();
    if (!text) return;
    try {
      var box = document.createElement('div');
      box.appendChild(sel.getRangeAt(0).cloneContents());
      e.clipboardData.setData('text/plain', text);
      e.clipboardData.setData('text/html', box.innerHTML);
      e.preventDefault();
    } catch (x) {}
  }, true);
  document.addEventListener('mousedown', function (e) {
    // Edit mode opts out of comment behaviour, but not out of dismissal: a card
    // opened from a pin stayed open there while every other mode closed it on
    // a click outside. Everything below is already mode-agnostic, so letting
    // edit through while something is open is the whole change — the selection
    // painting further down is still gated on comment mode, and the swallow
    // only preventDefaults our own pill and links, so a caret still lands.
    if (interactionMode === 'edit' && !shellUiOpen) return;
    // Clicking our own comment pill must not fire the clear (it opens the
    // composer) — everything else in the doc clears the shell's open UI.
    // The pill is our own UI, so a click on it normally opens the composer
    // rather than clearing. While something is open it is outside that card
    // like anything else, and dismissal wins.
    if (!shellUiOpen && e.target && e.target.closest && e.target.closest('.tdoc-comment-pill')) return;
    // Dismissal does not hit-test. While the shell has something open, an anchor
    // under the pointer stops being special — the click that closes a card must
    // not also open the next one. Fall through rather than returning, so a drag
    // that starts here still paints its selection.
    swallowClick = shellUiOpen;
    dismissDownX = e.clientX; dismissDownY = e.clientY;

    if (!shellUiOpen && anchorIdAtPoint(e.clientX, e.clientY)) return;
    if (interactionMode === 'comment' && e.button === 0
      && !(e.target && e.target.closest && e.target.closest('a,button,input,textarea,select,summary,[contenteditable]'))) {
      var point = caretAtPoint(e.clientX, e.clientY);
      if (point && point.node && point.node.nodeType === Node.TEXT_NODE) {
        document.documentElement.setAttribute('data-tdoc-selecting', '');
      }
    }
    // Dismiss on mouseup, not here. Clearing on mousedown unmounts the focused
    // composer in the shell, and losing that focus wipes the selection the user
    // is in the middle of dragging. This sits AFTER the painting setup above:
    // an early return here stops a drag from painting at all.
    if (shellUiOpen) return;
    if (HL) CSS.highlights.delete('tdoc-pending');
    setActiveAnchor(null, false);
    post({ type: 'tdoc:cleared' });
  }, true);

  // --- element/region commenting (slice 1: hover a commentable artifact →
  //     outline + pill → click to comment on the whole element). Mirrors the
  //     overlay COMMENTABLE set + hover affordance; the marquee sub-region
  //     gesture is a follow-on slice. ---
  var COMMENTABLE = 'img, svg, canvas, video, pre, figure, iframe[src], section, aside, blockquote, table, details, [data-tdoc-artifact], [class*="tdoc-artifact"]';
  var UI_SEL = '.tdoc-hover-outline, .tdoc-comment-pill';
  function isProbeUI(el) { return !!(el && el.closest && el.closest(UI_SEL)); }
  function artifactFor(node) {
    if (!node || isProbeUI(node)) return null;
    var el = node.matches && node.matches(COMMENTABLE) ? node : (node.closest && node.closest(COMMENTABLE));
    return (el && !isProbeUI(el)) ? el : null;
  }
  // A simple, same-version-stable selector (id, else an nth-of-type path). Good
  // enough to re-find the element for a pin; the worker's aid stamping is the
  // durable cross-version identity (a later slice).
  function cssPath(el) {
    if (el.id) { try { if (document.querySelectorAll('#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id)).length === 1) return '#' + el.id; } catch (x) {} }
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && parts.length < 8) {
      var tag = el.tagName.toLowerCase(), parent = el.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(el) + 1) + ')' : tag);
      el = parent;
    }
    return parts.join(' > ');
  }
  var hoverEl = null, hoverOutline = null, hoverPill = null;
  function ensureHoverUI() {
    if (hoverOutline) return;
    hoverOutline = document.createElement('div'); hoverOutline.className = 'tdoc-hover-outline'; hoverOutline.style.display = 'none';
    hoverPill = document.createElement('button'); hoverPill.className = 'tdoc-comment-pill'; hoverPill.type = 'button'; hoverPill.style.display = 'none';
    hoverOutline.setAttribute('data-tdoc-provider', ''); hoverPill.setAttribute('data-tdoc-provider', '');
    hoverPill.setAttribute('aria-label', 'Comment on this');
    hoverPill.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="' + COMMENT_ICON_PATH + '"/></svg>';
    // Parent on <html>, NOT <body>: a transformed body (see the hostile fixture)
    // becomes the containing block for absolute descendants, so viewport-derived
    // coordinates written to a body child render shifted/scaled. <html> keeps
    // document coordinates honest, and body clones (copyDoc) never include the UI.
    document.documentElement.appendChild(hoverOutline); document.documentElement.appendChild(hoverPill);
    hoverPill.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (hoverEl) commentOnElement(hoverEl); });
  }
  // The element's VISIBLE box: its rect intersected with every clipping
  // ancestor (overflow scroll/auto/hidden/clip). A wide graph inside an
  // overflow-x container has a bounding rect far wider than what's on screen —
  // painting the outline/pill from the raw rect runs them outside the
  // container, across the page.
  function clipRect(el) {
    var r = el.getBoundingClientRect();
    var L = r.left, T = r.top, R = r.right, B = r.bottom;
    var p = el.parentElement;
    while (p && p !== document.documentElement) {
      var cs; try { cs = getComputedStyle(p); } catch (x) { break; }
      if (/auto|scroll|hidden|clip/.test(cs.overflowX + cs.overflowY)) {
        var pr = p.getBoundingClientRect();
        if (pr.left > L) L = pr.left; if (pr.top > T) T = pr.top;
        if (pr.right < R) R = pr.right; if (pr.bottom < B) B = pr.bottom;
      }
      p = p.parentElement;
    }
    return { left: L, top: T, right: R, bottom: B, width: Math.max(0, R - L), height: Math.max(0, B - T) };
  }
  function positionHover(el) {
    ensureHoverUI();
    var r = clipRect(el), sx = window.scrollX || 0, sy = window.scrollY || 0;
    if (r.width < 12 || r.height < 12) { hideHover(); return; }   // scrolled out of its container
    hoverOutline.style.display = 'block';
    hoverOutline.style.left = (r.left + sx) + 'px'; hoverOutline.style.top = (r.top + sy) + 'px';
    hoverOutline.style.width = r.width + 'px'; hoverOutline.style.height = r.height + 'px';
    hoverPill.style.display = 'inline-flex';
    hoverPill.style.left = (r.right + sx - 34) + 'px'; hoverPill.style.top = (r.top + sy + 6) + 'px';
  }
  function hideHover() { hoverEl = null; if (hoverOutline) hoverOutline.style.display = 'none'; if (hoverPill) hoverPill.style.display = 'none'; }
  function commentOnElement(el) {
    var r = clipRect(el);   // visible box — the raw rect of a scroll-container child can be miles wide
    var label = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('data-tdoc-artifact') || el.tagName.toLowerCase();
    // Anchor the composer to the PILL the user just clicked (element top-right),
    // not the element box — a tall section would otherwise park the composer
    // below the whole box, far from the click.
    var pr = (hoverPill && hoverPill.style.display !== 'none') ? hoverPill.getBoundingClientRect() : null;
    var ar = pr && (pr.width || pr.height) ? pr : { top: r.top, left: Math.max(r.left, r.right - 40), bottom: r.top + 36, right: r.right, width: 30, height: 30 };
    post({
      type: 'tdoc:selection', kind: 'element', label: String(label).slice(0, 80), selector: cssPath(el),
      text: '', context_before: '', context_after: '',
      rect: { top: ar.top, left: ar.left, bottom: ar.bottom, right: ar.right, width: ar.width, height: ar.height },
    });
    hideHover();
  }
  document.addEventListener('mousemove', function (e) {
    if (interactionMode !== 'comment') { if (hoverEl) hideHover(); return; }
    var t = e.target;
    if (isProbeUI(t)) return; // keep the pill/outline up while the cursor is on them
    var art = artifactFor(t);
    if (art) positionHover((hoverEl = art));
    else if (hoverEl) hideHover();
  });
  window.addEventListener('scroll', function () { if (hoverEl) positionHover(hoverEl); }, { passive: true });

  // --- data-tdoc-copy author buttons (port of overlay.js wireCopyTriggers) ---
  // A doc element with data-tdoc-copy becomes a click-to-copy trigger. The
  // author's own <script> is inert here, so we wire it. Clipboard from a
  // sandboxed frame is unreliable, so we execCommand on the user gesture AND ask
  // the shell to copy (belt and suspenders); either way the button flashes.
  function tdocFallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (e) { return false; }
  }
  function flashCopy(trigger) {
    var done = trigger.getAttribute('data-tdoc-copy-done') || 'Copied ✓';
    if (trigger.getAttribute('data-tdoc-copy-label') == null) trigger.setAttribute('data-tdoc-copy-label', trigger.textContent);
    trigger.textContent = done; trigger.classList.add('tdoc-copied');
    clearTimeout(trigger._tdocCopyTimer);
    trigger._tdocCopyTimer = setTimeout(function () {
      var orig = trigger.getAttribute('data-tdoc-copy-label');
      if (orig != null) trigger.textContent = orig;
      trigger.classList.remove('tdoc-copied');
    }, 1600);
  }
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest && e.target.closest('[data-tdoc-copy]');
    if (!trigger) return;
    e.preventDefault(); e.stopPropagation();
    var raw = trigger.getAttribute('data-tdoc-copy') || '', text = raw;
    if (raw.charAt(0) === '#') { var src = document.getElementById(raw.slice(1)); if (src) text = (src.innerText || src.textContent || '').replace(/ /g, ' ').trim(); }
    post({ type: 'tdoc:copyText', text: text });
    tdocFallbackCopy(text);
    flashCopy(trigger);
  }, true);

  // --- anchor resolution (faithful port of overlay.js collectTextNodes/
  //     findTextRange). Normalizes whitespace so multi-block/wrapped selections
  //     (Selection.toString gives "para1\n\npara2" but the raw DOM has "\n   ")
  //     resolve, with context to disambiguate repeated text. The crude raw
  //     indexOf this replaces silently failed on any cross-block selection —
  //     which is why comments showed no pin/highlight. ---
  function collectTextNodes() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.parentElement) return NodeFilter.FILTER_REJECT;
        var tag = n.parentElement.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [], total = '', norm = '', normToRaw = [], prevWasSpace = false, previousNode = null;
    function hasLineBreakBetween(left, right) {
      if (!left || !right) return false;
      try {
        var gap = document.createRange();
        gap.setStartAfter(left);
        gap.setEndBefore(right);
        var fragment = gap.cloneContents();
        return !!(fragment.querySelector && fragment.querySelector('br'));
      } catch (e) { return false; }
    }
    // The nearest ancestor that lays out as a block. Cached: this runs once per
    // text node while building the view, and the same few ancestors repeat.
    var blockOf = new Map();
    function nearestBlock(node) {
      var el = node.parentElement;
      while (el && el !== document.body) {
        if (blockOf.has(el)) { var hit = blockOf.get(el); if (hit) return hit; }
        var display = '';
        try { display = window.getComputedStyle(el).display; } catch (e) { display = ''; }
        if (display && display.indexOf('inline') !== 0 && display !== 'contents') {
          blockOf.set(el, el);
          return el;
        }
        blockOf.set(el, null);
        el = el.parentElement;
      }
      return document.body;
    }
    // Two text nodes in different blocks read as separate lines, and
    // Selection.toString() puts a newline between them — with no <br> and no
    // whitespace node to show for it when the markup is written `</p><p>`.
    // Without a boundary here the saved anchor carries a space the rebuilt
    // text does not have, and a selection across two paragraphs can never be
    // found again. #339 asked for exactly this alongside the <br> case.
    function crossesBlock(left, right) {
      if (!left || !right) return false;
      try { return nearestBlock(left) !== nearestBlock(right); } catch (e) { return false; }
    }
    while (walker.nextNode()) {
      var n = walker.currentNode, start = total.length, v = n.nodeValue;
      // Selection.toString() represents <br> as a newline. Text-node walking
      // used to erase it completely, so an anchor saved as "有\n可做到…"
      // could never match the reconstructed "有可做到…" after submission.
      // Add one normalized virtual space and map it to the next node boundary;
      // Range creation can then still use real DOM offsets.
      if (norm.length && !prevWasSpace && (hasLineBreakBetween(previousNode, n) || crossesBlock(previousNode, n))) {
        norm += ' '; normToRaw.push(start); prevWasSpace = true;
      }
      nodes.push({ node: n, start: start, end: start + v.length });
      total += v;
      for (var i = 0; i < v.length; i++) {
        var ch = v.charCodeAt(i);
        var isWs = ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0xa0;
        if (isWs) { if (!prevWasSpace && norm.length) { norm += ' '; normToRaw.push(start + i); prevWasSpace = true; } }
        else { norm += v[i]; normToRaw.push(start + i); prevWasSpace = false; }
      }
      previousNode = n;
    }
    normToRaw.push(total.length);
    return { nodes: nodes, total: total, norm: norm, normToRaw: normToRaw };
  }
  function normalizeNeedle(s) { return s ? s.replace(/\s+/g, ' ').trim() : ''; }
  function normalizeContext(s) { return s ? s.replace(/\s+/g, ' ') : ''; }
  function locateAt(nodes, off) {
    var lo = 0, hi = nodes.length - 1;
    while (lo <= hi) { var mid = (lo + hi) >> 1, n = nodes[mid];
      if (off < n.start) hi = mid - 1; else if (off > n.end) lo = mid + 1; else return { node: n.node, offset: off - n.start }; }
    return null;
  }
  function commonSuffixLen(a, b) { var i = 0, m = Math.min(a.length, b.length); while (i < m && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }
  function commonPrefixLen(a, b) { var i = 0, m = Math.min(a.length, b.length); while (i < m && a[i] === b[i]) i++; return i; }
  function rangeFromNorm(view, normIdx, normLen) {
    var rawStart = view.normToRaw[normIdx], rawEnd = view.normToRaw[normIdx + normLen];
    if (rawEnd == null) rawEnd = view.total.length;
    var s = locateAt(view.nodes, rawStart), e = locateAt(view.nodes, rawEnd);
    if (!s || !e) return null;
    try { var r = document.createRange(); r.setStart(s.node, s.offset); r.setEnd(e.node, e.offset); return r; } catch (x) { return null; }
  }
  // The anchor's own words are gone, but its neighbours may not be. Every field
  // needed for this is already saved — context_before and context_after — and
  // findTextRange only ever used them to break ties between several copies of
  // the anchor text. When the text itself has been rewritten it returns null
  // before it ever looks at them, and the comment loses its place entirely.
  //
  // The tail of context_before and the head of context_after are the parts that
  // touched the anchor, so the longest surviving run of either is the closest
  // thing to where the words used to be. Measured on a real document: five
  // comments whose text was rewritten still had 9–59 characters of neighbouring
  // context alive in the new version.
  //
  // Approximate on purpose. The caller marks these unanchored, so the card is
  // dashed and offers Re-anchor — a guess that admits it is a guess, rather than
  // a pin that claims to point at somebody else's sentence.
  var NEAR_CONTEXT_MIN = 12;
  function findNearContext(anchor, view) {
    if (!anchor || !view || !view.norm) return null;
    var before = normalizeContext(anchor.context_before).trim();
    var after = normalizeContext(anchor.context_after).trim();
    var best = null; // { at, len }

    // Suffixes of context_before: the end of it sat against the anchor.
    for (var lb = before.length; lb >= NEAR_CONTEXT_MIN; lb--) {
      var tail = before.slice(before.length - lb);
      var i = view.norm.indexOf(tail);
      if (i !== -1 && view.norm.indexOf(tail, i + 1) === -1) { best = { at: i + lb, len: lb }; break; }
    }
    // Prefixes of context_after: the start of it sat against the anchor. Only
    // taken when it beats what the other side found — longer surviving run wins.
    for (var la = after.length; la >= NEAR_CONTEXT_MIN; la--) {
      if (best && la <= best.len) break;
      var head = after.slice(0, la);
      var j = view.norm.indexOf(head);
      if (j !== -1 && view.norm.indexOf(head, j + 1) === -1) { best = { at: j, len: la }; break; }
    }
    if (!best) return null;
    // Land ON the surviving context, not on the position just past it. For a
    // before-match that position is where the anchor used to begin, which after a
    // rewrite is often the whitespace between two blocks — a text node with no
    // layout, whose rect is 0x0 at the top of the document.
    //
    // Prefer the single character adjacent to where the anchor sat; if that one
    // cannot be measured either, widen to the whole surviving run, which spans
    // real rendered text by construction. Only give up when neither can be
    // measured — a spot with no rect is not a spot, and pinning to it would drop
    // the comment at the top of the page.
    var start = best.side === 'before' ? best.at - best.len : best.at;
    var adjacent = best.side === 'before' ? best.at - 1 : best.at;
    var tries = [
      [Math.max(0, Math.min(adjacent, view.norm.length - 1)), 1],
      [Math.max(0, start), best.len]
    ];
    for (var t = 0; t < tries.length; t++) {
      var candidate = rangeFromNorm(view, tries[t][0], tries[t][1]);
      if (!candidate) continue;
      var box = candidate.getBoundingClientRect();
      if (box.width || box.height) return candidate;
    }
    return null;
  }

  function findTextRange(anchor, view) {
    // No length floor. A one-character anchor used to be refused outright,
    // which in CJK is an ordinary thing to want to comment on — and the
    // composer accepted it anyway, so the comment was saved and then never
    // drawn. Ambiguity is what the floor was really guarding against, and
    // context plus `occurrence` below answer that directly.
    if (!anchor || !anchor.text || !view.norm) return null;
    var needleN = normalizeNeedle(anchor.text); if (!needleN) return null;
    var hits = [];
    for (var i = 0; (i = view.norm.indexOf(needleN, i)) !== -1; i += Math.max(1, needleN.length)) { hits.push(i); if (hits.length > 64) break; }
    if (!hits.length) return null;
    if (hits.length === 1) return rangeFromNorm(view, hits[0], needleN.length); // unique → accept
    // The copy that was selected, when the document still has exactly the same
    // copies it had then. This is exact where context is a guess, so it goes
    // first: twelve identical rows give every candidate the same neighbourhood,
    // and a score picks one of them at random-looking. If the count changed the
    // document was regenerated around this text, the index no longer means what
    // it meant, and context — which travels — takes over.
    if (typeof anchor.occurrence === 'number' && anchor.occurrences === hits.length
        && hits[anchor.occurrence] != null) {
      return rangeFromNorm(view, hits[anchor.occurrence], needleN.length);
    }
    // Multiple occurrences: disambiguate by saved context; refuse if none clears.
    var beforeN = normalizeContext(anchor.context_before), afterN = normalizeContext(anchor.context_after);
    if (!beforeN && !afterN) return null;
    var MIN = 4, L = 60;
    var bTail = beforeN.slice(-Math.min(L, beforeN.length)), aHead = afterN.slice(0, Math.min(L, afterN.length));
    var bestIdx = -1, bestScore = 0;
    for (var k = 0; k < hits.length; k++) {
      var h = hits[k];
      var bScore = commonSuffixLen(view.norm.slice(Math.max(0, h - L), h), bTail);
      var aScore = commonPrefixLen(view.norm.slice(h + needleN.length, h + needleN.length + L), aHead);
      var score = (bScore >= MIN ? bScore : 0) + (aScore >= MIN ? aScore : 0);
      if (score > bestScore) { bestScore = score; bestIdx = h; }
    }
    if (bestIdx !== -1 && bestScore > 0) return rangeFromNorm(view, bestIdx, needleN.length);
    // Nothing decided. A stale index is worse than no pin: it looks anchored
    // and points at somebody else's sentence.
    return null;
  }
  // Article right edge (page coords) so the shell can park pins/cards in the
  // gutter just right of the reading column — not pinned to the viewport edge.
  // Mirrors overlay.js getArticleMetrics: widest wrapper, else widest prose.
  function articleRight() {
    // A qualifying wrapper must plausibly BE the reading column: at least half
    // the viewport wide (an interior grid cell can match .content/.container
    // and would park pins mid-screen) but narrower than the viewport itself.
    var best = 0, bw = 0, minW = Math.max(200, window.innerWidth * 0.5);
    var els = document.querySelectorAll('main, article, .wrap, .content, .container');
    for (var i = 0; i < els.length; i++) { var r = els[i].getBoundingClientRect(); if (r.width > bw && r.width > minW && r.width < window.innerWidth) { bw = r.width; best = r.right; } }
    if (bw) return best;
    // No wrapper narrower than the viewport — on narrow windows the column IS
    // the viewport. The reading column's right edge is the RIGHTMOST prose
    // edge, not the widest block's: in grid/column layouts the widest
    // paragraph can be a left column ending mid-screen (pins parked centered).
    var right = 0, ps = document.querySelectorAll('p, h1, h2, h3, li');
    for (var j = 0; j < ps.length; j++) { var rr = ps[j].getBoundingClientRect(); if (rr.width > 120 && rr.right > right && rr.right <= window.innerWidth) right = rr.right; }
    return right || window.innerWidth;
  }
  // The author document is static in shell mode, so cache the text-model view
  // and each anchor's resolved Range. Re-resolving after a comment/reply then
  // only pays findTextRange for NEW anchors (O(D) each) instead of re-walking
  // the whole doc + re-scanning every anchor (O(N + C·D)) every time.
  var _view = null, _rangeCache = {}, _anchorTargets = {}, _activeAnchorId = null;
  var _lastComments = [];   // re-report pins when layout settles (images/fonts)
  function docView() { return _view || (_view = collectTextNodes()); }
  function anchorIdAtPoint(x, y) {
    var ids = Object.keys(_anchorTargets);
    for (var i = ids.length - 1; i >= 0; i--) {
      var target = _anchorTargets[ids[i]];
      // Element anchors use an outline rather than a painted text highlight;
      // do not steal the element's own click behavior.
      if (!target.range) continue;
      var rects = target.range.getClientRects();
      for (var j = 0; j < rects.length; j++) {
        var rect = rects[j];
        if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) return ids[i];
      }
    }
    return null;
  }
  function setActiveAnchor(id, scroll) {
    _activeAnchorId = id || null;
    if (HL) CSS.highlights.delete('tdoc-anchor-active');
    var target = id && _anchorTargets[id];
    if (!target) return;
    if (HL && target.range) CSS.highlights.set('tdoc-anchor-active', new Highlight(target.range));
    if (!scroll) return;
    var rect = target.range ? target.range.getBoundingClientRect() : target.element.getBoundingClientRect();
    var top = rect.top + (window.scrollY || 0) - Math.max(80, window.innerHeight / 3);
    try { window.scrollTo(0, Math.max(0, top)); } catch (e) {}
  }
  function reportPins(comments) {
    _lastComments = comments || [];
    _anchorTargets = {};
    var pins = [], hl = HL ? new Highlight() : null;
    // An anchor that cannot be placed still deserves a seat. Without a pin the
    // desktop rail has no coordinate to draw the card at, so the comment sits in
    // the data and nowhere on screen — while the phone drawer, which renders the
    // list directly, shows it.
    //
    // The seat goes at the END of the document, not the top. At the top a stack
    // of comments from an older version is the first thing beside the title,
    // which reads as "these matter most"; at the end it reads as what it is —
    // what the last revision left behind. Everything downstream is unchanged:
    // clustering, the rail, the dashed unanchored card, and the Re-anchor that
    // puts one back where it belongs.
    // Not the very last pixel: the rail culls a pin that falls outside the
    // viewport, and a seat pinned to the document's final row is never on
    // screen even when you scroll all the way down. Sit just above the end.
    var seatY = Math.max(0, document.documentElement.scrollHeight - 160);
    function seat(c, extra) {
      var pin = { id: c.id, docY: seatY, lost: true, login: (c.author && c.author.login) || null,
        avatar_url: (c.author && c.author.avatar_url) || null, kind: (c.author && c.author.kind) || null,
        resolved: c.status === 'applied', deleted: !!c.deleted };
      if (extra) for (var k in extra) pin[k] = extra[k];
      pins.push(pin);
    }
    (comments || []).forEach(function (c) {
      if (!c) return;
      if (!c.anchor) return seat(c);
      if (c.anchor.kind === 'element' && c.anchor.selector) {
        var eel = null; try { eel = document.querySelector(c.anchor.selector); } catch (x) {}
        if (eel) {
          _anchorTargets[c.id] = { element: eel };
          var er = eel.getBoundingClientRect();
          pins.push({ id: c.id, docY: er.top + (window.scrollY || 0), elementKey: c.anchor.selector, elementTop: er.top + (window.scrollY || 0), elementHeight: er.height, login: (c.author && c.author.login) || null, avatar_url: (c.author && c.author.avatar_url) || null, kind: (c.author && c.author.kind) || null, resolved: c.status === 'applied', deleted: !!c.deleted });
        } else seat(c);
        return;
      }
      if (c.anchor.kind !== 'text') return seat(c);
      var key = (c.anchor.text || '') + '\u0000' + (c.anchor.context_before || '') + '\u0000' + (c.anchor.context_after || '');
      var r = (key in _rangeCache) ? _rangeCache[key] : (_rangeCache[key] = findTextRange(c.anchor, docView()));
      // Exact first, then the neighbourhood, then a seat at the end. The middle
      // one is approximate, so it is NOT painted as a highlight and its pin is
      // flagged: the card reads unanchored and offers Re-anchor.
      var approximate = false;
      if (!r) {
        r = findNearContext(c.anchor, docView());
        approximate = !!r;
      }
      if (!r) return seat(c);
      _anchorTargets[c.id] = { range: r };
      if (hl && !c.deleted && !approximate) hl.add(r);
      var rect = r.getBoundingClientRect();
      // Second line of defence: findNearContext already measures its candidates,
      // but an exact hit can be invisible too (a rule moved into a hidden block).
      if (approximate && !rect.width && !rect.height) return seat(c);
      pins.push({ id: c.id, docY: rect.top + (window.scrollY || 0), lost: approximate || undefined, login: (c.author && c.author.login) || null, avatar_url: (c.author && c.author.avatar_url) || null, kind: (c.author && c.author.kind) || null, resolved: c.status === 'applied', deleted: !!c.deleted });
    });
    if (HL) CSS.highlights.set('tdoc-anchor', hl);
    setActiveAnchor(_activeAnchorId, false);
    post({ type: 'tdoc:pins', pins: pins, scrollY: window.scrollY || 0, articleRight: Math.round(articleRight()), docHeight: document.documentElement.scrollHeight });
  }

  // Geometry can settle AFTER the first pin report (images/fonts load, layout
  // shifts): re-resolve + re-report so pins/cards move to the real article
  // edge instead of sticking mid-screen until the next comment arrives.
  var _geoTimer = null;
  function rereportPins() { if (_geoTimer) clearTimeout(_geoTimer); _geoTimer = setTimeout(function () { _view = null; _rangeCache = {}; reportPins(_lastComments); }, 150); }
  window.addEventListener('load', rereportPins);
  if (typeof ResizeObserver !== 'undefined') {
    try { new ResizeObserver(rereportPins).observe(document.body); } catch (e) {}
  }

  // Doc → Markdown (verbatim port of overlay.js htmlToMarkdown 4176-4253). Runs
  // in the frame (the only place with the doc DOM) on a tdoc:copyDoc request.
  function htmlToMarkdown(root) {
    function walk(node, ctx) {
      if (node.nodeType === Node.TEXT_NODE) { var t = node.nodeValue; return ctx.inPre ? t : t.replace(/\s+/g, ' '); }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      var tag = node.tagName.toLowerCase();
      var kids = function () { return Array.prototype.map.call(node.childNodes, function (c) { return walk(c, ctx); }).join(''); };
      switch (tag) {
        case 'h1': return '\n\n# ' + kids().trim() + '\n\n';
        case 'h2': return '\n\n## ' + kids().trim() + '\n\n';
        case 'h3': return '\n\n### ' + kids().trim() + '\n\n';
        case 'h4': return '\n\n#### ' + kids().trim() + '\n\n';
        case 'h5': return '\n\n##### ' + kids().trim() + '\n\n';
        case 'h6': return '\n\n###### ' + kids().trim() + '\n\n';
        case 'p': return '\n\n' + kids().trim() + '\n\n';
        case 'br': return '  \n';
        case 'hr': return '\n\n---\n\n';
        case 'strong': case 'b': return '**' + kids() + '**';
        case 'em': case 'i': return '*' + kids() + '*';
        case 'code': return ctx.inPre ? kids() : '`' + kids() + '`';
        case 'pre': {
          var c = { inPre: true };
          var codeEl = node.querySelector('code');
          var m = codeEl && codeEl.className && codeEl.className.match(/language-([\w-]+)/);
          var lang = m ? m[1] : '';
          var inner = Array.prototype.map.call(node.childNodes, function (n) { return walk(n, c); }).join('');
          return '\n\n```' + lang + '\n' + inner.replace(/\n$/, '') + '\n```\n\n';
        }
        case 'blockquote': return '\n\n' + kids().trim().split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n\n';
        case 'ul': { var items = Array.prototype.filter.call(node.children, function (c) { return c.tagName === 'LI'; }); return '\n\n' + items.map(function (li) { return '- ' + walk(li, ctx).trim(); }).join('\n') + '\n\n'; }
        case 'ol': { var oi = Array.prototype.filter.call(node.children, function (c) { return c.tagName === 'LI'; }); return '\n\n' + oi.map(function (li, i) { return (i + 1) + '. ' + walk(li, ctx).trim(); }).join('\n') + '\n\n'; }
        case 'li': return kids();
        case 'a': { var href = node.getAttribute('href') || ''; var text = kids().trim(); return href ? '[' + text + '](' + href + ')' : text; }
        case 'img': return '![' + (node.getAttribute('alt') || '') + '](' + (node.getAttribute('src') || '') + ')';
        case 'svg': case 'canvas': case 'video': case 'iframe': return '\n\n[' + tag + ' embed]\n\n';
        case 'figure': return '\n\n' + kids().trim() + '\n\n';
        case 'figcaption': return '\n\n*' + kids().trim() + '*\n\n';
        case 'table': {
          var rows = Array.prototype.slice.call(node.querySelectorAll('tr'));
          if (!rows.length) return '';
          var cells = function (r) { return Array.prototype.map.call(r.children, function (c) { return walk(c, ctx).trim().replace(/\\/g, '\\\\').replace(/\|/g, '\\|'); }); };
          var head = cells(rows[0]), body = rows.slice(1).map(cells);
          return '\n\n| ' + head.join(' | ') + ' |\n| ' + head.map(function () { return '---'; }).join(' | ') + ' |\n' + body.map(function (r) { return '| ' + r.join(' | ') + ' |'; }).join('\n') + '\n\n';
        }
        case 'th': case 'td': case 'tr': return kids();
        default: return kids();
      }
    }
    return walk(root, { inPre: false }).replace(/\n{3,}/g, '\n\n').trim();
  }

  // Dark mode = filter-invert applied INSIDE the frame (verbatim from overlay.js
  // 821-842). Works on any author doc without knowing its colors; photos/video/
  // canvas are inverted back. An author can opt an element out with
  // data-tdoc-dark="invert", or ship their own theme (then avoid our toggle).
  var themeStyle = null;
  function applyTheme(theme) {
    var html = document.documentElement;
    if (theme === 'dark') html.setAttribute('data-tdoc-theme', 'dark'); else html.removeAttribute('data-tdoc-theme');
    if (st) st.textContent = highlightCss(theme === 'dark');
    if (!themeStyle) {
      themeStyle = document.createElement('style');
      themeStyle.id = 'tdoc-provider-theme-style';
      themeStyle.setAttribute('data-tdoc-provider', '');
      themeStyle.textContent = 'html[data-tdoc-theme="dark"]{color-scheme:dark;background:#fff;filter:invert(1) hue-rotate(180deg);}html[data-tdoc-theme="dark"] button,html[data-tdoc-theme="dark"] input,html[data-tdoc-theme="dark"] select,html[data-tdoc-theme="dark"] textarea{color-scheme:light;}html[data-tdoc-theme="dark"] img:not([data-tdoc-dark="invert"]),html[data-tdoc-theme="dark"] video:not([data-tdoc-dark="invert"]),html[data-tdoc-theme="dark"] canvas:not([data-tdoc-dark="invert"]),html[data-tdoc-theme="dark"] iframe:not([data-tdoc-dark="invert"]){filter:invert(1) hue-rotate(180deg);}';
      (document.head || document.documentElement).appendChild(themeStyle);
    }
  }

  // --- explicit browser editing ------------------------------------------
  // The provider owns editability. Author HTML stays framework-free and is
  // never expected to include contenteditable, toolbars, or save scripts.
  var editRoot = null, editDirty = false, editTimer = null, savedRange = null, editBaselineHtml = null;
  // Comment targets are not editing boundaries. Keep only elements whose
  // native interaction or internal structure should be isolated from the
  // surrounding editing host; authors can opt other widgets out explicitly.
  var ATOMIC = 'img,svg,canvas,video,audio,pre,iframe,table,[data-tdoc-edit-atomic]';
  function findEditRoot() {
    if (editRoot && document.contains(editRoot)) return editRoot;
    var children = document.body ? document.body.children : [];
    for (var i = 0; i < children.length; i++) {
      if (children[i].matches('main,article,.wrap,.content,.container')) {
        editRoot = children[i]; break;
      }
    }
    return editRoot || (editRoot = document.body);
  }
  function selectionInsideRoot() {
    var sel = window.getSelection(), root = findEditRoot();
    if (!sel || !root || !sel.rangeCount) return false;
    var node = sel.getRangeAt(0).commonAncestorContainer;
    return node === root || root.contains(node.nodeType === 1 ? node : node.parentNode);
  }
  document.addEventListener('selectionchange', function () {
    if (interactionMode === 'comment' && HL) {
      try {
        var live = window.getSelection();
        if (live && !live.isCollapsed && live.rangeCount) {
          CSS.highlights.set('tdoc-selecting', new Highlight(live.getRangeAt(0).cloneRange()));
        } else {
          CSS.highlights.delete('tdoc-selecting');
        }
      } catch (e) {}
      return;
    }
    if (interactionMode !== 'edit' || !selectionInsideRoot()) return;
    try { savedRange = window.getSelection().getRangeAt(0).cloneRange(); } catch (e) {}
    markCaretLine();
  });

  // A placeholder line stops showing its hint once the caret is actually in it:
  // the hint is there to say what to write, and by then you are writing. The
  // caret this file places on entering edit mode does NOT count — it would blank
  // the guidance before the first paint — so the marking only starts after the
  // reader moves the caret themselves.
  var caretHintsArmed = false;
  function markCaretLine() {
    var root = findEditRoot();
    if (!root || !root.querySelectorAll) return;
    var current = null;
    if (caretHintsArmed) {
      try {
        var sel = window.getSelection();
        if (sel && sel.rangeCount) {
          var node = sel.getRangeAt(0).startContainer;
          node = node.nodeType === 1 ? node : node.parentNode;
          current = node && node.closest ? node.closest('[data-tdoc-placeholder]') : null;
        }
      } catch (e) {}
    }
    Array.prototype.forEach.call(root.querySelectorAll('[data-tdoc-caret]'), function (node) {
      if (node !== current) node.removeAttribute('data-tdoc-caret');
    });
    if (current) current.setAttribute('data-tdoc-caret', '');
  }
  function armCaretHints() {
    if (caretHintsArmed) return;
    caretHintsArmed = true;
    markCaretLine();
  }
  document.addEventListener('mousedown', armCaretHints, true);
  document.addEventListener('keydown', armCaretHints, true);
  function cleanEditorAttributes(root) {
    if (!root || !root.querySelectorAll) return;
    var roots = [];
    if (root.hasAttribute && root.hasAttribute('data-tdoc-editor-root')) roots.push(root);
    Array.prototype.push.apply(roots, root.querySelectorAll('[data-tdoc-editor-root]'));
    Array.prototype.forEach.call(root.querySelectorAll('[data-tdoc-caret]'), function (node) {
      node.removeAttribute('data-tdoc-caret');
    });
    if (root.removeAttribute) root.removeAttribute('data-tdoc-caret');
    roots.forEach(function (node) {
      node.removeAttribute('data-tdoc-editor-root');
      var original = node.getAttribute('data-tdoc-editor-original-editable');
      if (original === '__missing__') {
        node.removeAttribute('contenteditable');
      } else if (original != null) {
        node.setAttribute('contenteditable', original);
      }
      node.removeAttribute('data-tdoc-editor-original-editable');
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-tdoc-editor-atomic]'), function (node) {
      node.removeAttribute('data-tdoc-editor-atomic');
      var original = node.getAttribute('data-tdoc-editor-original-editable');
      if (original === '__missing__') {
        node.removeAttribute('contenteditable');
      } else if (original != null) {
        node.setAttribute('contenteditable', original);
      }
      node.removeAttribute('data-tdoc-editor-original-editable');
    });
  }
  function draftBodyHtml() {
    var clone = findEditRoot().cloneNode(true);
    cleanEditorAttributes(clone);
    Array.prototype.forEach.call(clone.querySelectorAll('[data-tdoc-provider]'), function (node) { node.remove(); });
    return clone.innerHTML;
  }
  function setDirty(next, checking) {
    editDirty = !!next;
    post({ type: 'tdoc:editState', dirty: editDirty, checking: !!checking });
  }
  function reportDraft() {
    // Recovery is not debounced. A refresh can arrive between any two
    // keystrokes, so hand the shell a restorable snapshot before yielding.
    // The more expensive baseline/pin bookkeeping can still settle once the
    // input burst is over.
    var immediateHtml = draftBodyHtml();
    post({ type: 'tdoc:editDraft', bodyHtml: immediateHtml });
    clearTimeout(editTimer);
    editTimer = setTimeout(function () {
      var bodyHtml = draftBodyHtml();
      var dirty = bodyHtml !== editBaselineHtml;
      setDirty(dirty, false);
      post({ type: 'tdoc:editSnapshot', bodyHtml: bodyHtml, dirty: dirty });
      rereportPins();
    }, 350);
  }
  function markdownCtx() {
    return { root: findEditRoot(), atomicSelector: ATOMIC + ',[data-tdoc-editor-atomic]' };
  }
  function onEditInput(event) {
    var md = window.tdocEditMarkdown;
    if (event && md) {
      try { md.applyAfterInput(event, markdownCtx()); } catch (e) {}
    }
    // Mark the comparison as pending; reportDraft persists first, then
    // settles baseline equality after the input burst.
    setDirty(true, true);
    reportDraft();
  }
  function onEditBeforeInput(event) {
    var md = window.tdocEditMarkdown;
    if (!md) return;
    try {
      if (md.applyBeforeInput(event, markdownCtx())) onEditInput();
    } catch (e) {}
  }
  function onEditKeydown(event) {
    var md = window.tdocEditMarkdown;
    if (md) {
      try {
        if (md.applyKeydown(event, markdownCtx())) {
          onEditInput();
          return;
        }
      } catch (e) {}
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    var key = String(event.key || '').toLowerCase(), command = null;
    if (key === 'b' && !event.shiftKey) command = 'bold';
    else if (key === 'i' && !event.shiftKey) command = 'italic';
    else if (key === 'z') command = event.shiftKey ? 'redo' : 'undo';
    else if (key === 'y' && !event.shiftKey) command = 'redo';
    if (!command) return;
    event.preventDefault();
    try {
      document.execCommand(command, false, null);
      onEditInput();
    } catch (e) {}
  }
  function enableEditing() {
    var root = findEditRoot();
    if (!root) return;
    root.setAttribute('data-tdoc-editor-root', '');
    if (!root.hasAttribute('data-tdoc-editor-original-editable')) {
      root.setAttribute('data-tdoc-editor-original-editable', root.hasAttribute('contenteditable') ? root.getAttribute('contenteditable') : '__missing__');
    }
    root.setAttribute('contenteditable', 'true');
    Array.prototype.forEach.call(root.querySelectorAll(ATOMIC), function (node) {
      node.setAttribute('data-tdoc-editor-atomic', '');
      if (!node.hasAttribute('data-tdoc-editor-original-editable')) {
        node.setAttribute('data-tdoc-editor-original-editable', node.hasAttribute('contenteditable') ? node.getAttribute('contenteditable') : '__missing__');
      }
      node.setAttribute('contenteditable', 'false');
    });
    if (editBaselineHtml == null) editBaselineHtml = draftBodyHtml();
    root.addEventListener('beforeinput', onEditBeforeInput, true);
    root.addEventListener('input', onEditInput);
    root.addEventListener('keydown', onEditKeydown);
    document.documentElement.setAttribute('data-tdoc-editing', '');
    post({ type: 'tdoc:editBaseline', publishedHtml: editBaselineHtml, bodyHtml: draftBodyHtml() });
    // Entering edit mode should leave you able to type. Without this the root
    // is editable but unfocused, so a doc created from scratch — which lands
    // here with nothing on the page — swallows the first thing you type until
    // you think to click. The caret goes to the first placeholder line (the
    // heading of a blank doc) and an existing selection is left alone.
    try {
      if (!selectionInsideRoot()) {
        var caretAt = root.querySelector('[data-tdoc-placeholder]') || root;
        var caret = document.createRange();
        caret.selectNodeContents(caretAt);
        caret.collapse(true);
        var caretSel = window.getSelection();
        caretSel.removeAllRanges();
        caretSel.addRange(caret);
      }
      root.focus({ preventScroll: true });
    } catch (e) {}
    caretHintsArmed = false;
    markCaretLine();
  }
  function disableEditing() {
    var root = findEditRoot();
    if (root) root.removeEventListener('beforeinput', onEditBeforeInput, true);
    if (root) root.removeEventListener('input', onEditInput);
    if (root) root.removeEventListener('keydown', onEditKeydown);
    cleanEditorAttributes(document.documentElement);
    document.documentElement.removeAttribute('data-tdoc-editing');
    savedRange = null;
  }
  function setInteractionMode(mode) {
    var next = /^(read|comment|edit)$/.test(mode) ? mode : 'read';
    if (interactionMode === 'edit' && next !== 'edit') disableEditing();
    interactionMode = next;
    document.documentElement.setAttribute('data-tdoc-interaction-mode', next);
    clearSelectingCursor();
    if (HL && next !== 'comment') CSS.highlights.delete('tdoc-selecting');
    if (next === 'edit') { hideHover(); enableEditing(); }
    else if (next !== 'comment') hideHover();
  }
  function restoreSelection() {
    if (!savedRange) return;
    try {
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange);
    } catch (e) {}
  }
  function formatEdit(command, value) {
    if (interactionMode !== 'edit') return;
    var nextValue = value;
    if (command === 'createLink') {
      if (!nextValue) return;
    }
    try {
      findEditRoot().focus();
      restoreSelection();
      if (command === 'code') {
        var live = window.getSelection();
        var text = live && !live.isCollapsed ? live.toString() : '';
        if (!text) return;
        // Keep this safe even if the optional input-rule helper failed to
        // initialize: selected author text is interpolated into insertHTML.
        var esc = String(text)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
        document.execCommand('insertHTML', false, '<code>' + esc + '</code>');
      } else {
        document.execCommand(command, false, nextValue || null);
      }
      onEditInput();
    } catch (e) {}
  }
  function serializeDocument() {
    var clone = document.documentElement.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('[data-tdoc-provider]'), function (node) { node.remove(); });
    cleanEditorAttributes(clone);
    clone.removeAttribute('data-tdoc-theme');
    clone.removeAttribute('data-tdoc-editing');
    return '<!doctype html>\n' + clone.outerHTML;
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data; if (!d || d.source !== 'tdoc-shell') return;
    if (d.type === 'tdoc:anchors') reportPins(d.comments);
    else if (d.type === 'tdoc:clearPending') {
      if (HL) CSS.highlights.delete('tdoc-pending');
      // Drop the reader's own selection too. The browser paints it OVER our
      // anchor highlight, so after a comment is posted or an anchor is moved
      // the yellow would not appear until the reader happened to click away —
      // it looked as though the anchor had not moved at all.
      try { var s0 = window.getSelection(); if (s0) s0.removeAllRanges(); } catch (x0) {}
    }
    else if (d.type === 'tdoc:theme') applyTheme(d.theme);
    else if (d.type === 'tdoc:mode') setInteractionMode(d.mode);
    else if (d.type === 'tdoc:uiOpen') shellUiOpen = !!d.open;
    else if (d.type === 'tdoc:editFormat') formatEdit(d.command, d.value);
    else if (d.type === 'tdoc:editRestore') {
      var restoreRoot = findEditRoot();
      if (restoreRoot && typeof d.bodyHtml === 'string') {
        restoreRoot.innerHTML = d.bodyHtml;
        if (interactionMode === 'edit') { disableEditing(); enableEditing(); }
        var restoredHtml = draftBodyHtml();
        var restoredDirty = restoredHtml !== editBaselineHtml;
        setDirty(restoredDirty, false);
        post({ type: 'tdoc:editSnapshot', bodyHtml: restoredHtml, dirty: restoredDirty });
        rereportPins();
      }
    }
    else if (d.type === 'tdoc:editSerialize') {
      post({ type: 'tdoc:editDocument', requestId: d.requestId, html: serializeDocument() });
    }
    else if (d.type === 'tdoc:focusAnchor') setActiveAnchor(d.id, !!d.scroll);
    else if (d.type === 'tdoc:scrollTo') { try { window.scrollTo(0, Math.max(0, (d.docY || 0) - 80)); } catch (x) {} }
    else if (d.type === 'tdoc:copyDoc') {
      var clone = document.body.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll('script, style, noscript, .tdoc-hover-outline, .tdoc-comment-pill'), function (n) { n.remove(); });
      post({ type: 'tdoc:docMarkdown', markdown: htmlToMarkdown(clone), requestId: d.requestId });
    }
  });

  // --- scroll sync ---------------------------------------------------------
  // innerH (frame viewport height) lets the shell tell when the doc is scrolled
  // to the bottom, so the footer reveals only there.
  function reportScroll() {
    post({ type: 'tdoc:scroll', scrollY: window.scrollY || window.pageYOffset || 0, innerH: window.innerHeight, height: document.documentElement.scrollHeight });
  }
  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return; ticking = true;
    requestAnimationFrame(function () { ticking = false; reportScroll(); });
  }, { passive: true });

  post({ type: 'tdoc:ready', height: document.documentElement.scrollHeight, defaultTheme: document.documentElement.getAttribute('data-tdoc-default-theme') || null });
  reportScroll(); // initial position so the shell can evaluate at-bottom for short docs
})();
