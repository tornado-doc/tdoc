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
  // A baked reader block is present on every upload, including fully authored
  // designs. Its presence alone is not consent to restyle or invert the page.
  function usesReaderDesign() {
    var explicit = document.documentElement.getAttribute('data-tdoc-design');
    if (explicit === 'custom') return false;
    if (explicit === 'tdoc') return true;
    var roots = [document.documentElement, document.body];
    Array.prototype.forEach.call(document.querySelectorAll('body > main, body > article, body > section, body > div'), function (content) { roots.push(content); });
    // Keep ownership per element: house presets put the page background on
    // body and inherited text color on .wrap. Combining those is not evidence
    // that one author surface supplies its own complete palette.
    var palettes = roots.map(function () { return { background: false, color: false }; });
    function foundation(style, palette) {
      if (!style) return false;
      // Token-based adjustments still use the reader design. Typography,
      // layout and individual accents do not opt out: require an author
      // background AND text color before removing the house stylesheet.
      function own(prop) {
        var value = style.getPropertyValue(prop).trim();
        return value && !/var\(\s*--td-/.test(value) && !/^(inherit|initial|unset|revert|transparent)$/.test(value);
      }
      if (own('background-color') || own('background')) palette.background = true;
      if (own('color')) palette.color = true;
      return palette.background && palette.color;
    }
    function rulesHaveDesign(rules) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule.selectorText && roots.some(function (root, index) {
          try { return root && root.matches(rule.selectorText) && foundation(rule.style, palettes[index]); } catch (_) { return false; }
        })) return true;
        // Include conditional styles: the design must not switch ownership
        // when a viewport breakpoint or OS color preference changes.
        if (rule.cssRules && rulesHaveDesign(rule.cssRules)) return true;
      }
      return false;
    }
    for (var i = 0; i < roots.length; i++) if (roots[i] && foundation(roots[i].style, palettes[i])) return false;
    for (var j = 0; j < document.styleSheets.length; j++) {
      var sheet = document.styleSheets[j], owner = sheet.ownerNode;
      if (sheet.disabled || (owner && (owner.id === 'tdoc-reader' || owner.id === 'tdoc-reader-patch' || owner.hasAttribute('data-tdoc-provider')))) continue;
      try { if (rulesHaveDesign(sheet.cssRules)) return false; }
      catch (_) {} // Opaque stylesheets (including web fonts) do not prove a custom palette.
    }
    return true;
  }
  var supportsTheme = usesReaderDesign();
  if (supportsTheme) {
    // Serve-time enforcement also covers older documents carrying a baked
    // wide-column rule. Custom designs never receive this constraint.
    var designStyle = document.createElement('style');
    designStyle.setAttribute('data-tdoc-provider', '');
    designStyle.textContent = 'body > :is(.wrap,main,article,.content,.container):not(:popover-open){width:100%!important;max-width:720px!important;box-sizing:border-box!important;margin-left:auto!important;margin-right:auto!important;}';
    (document.head || document.documentElement).appendChild(designStyle);
  }
  if (!supportsTheme) {
    // Disable only the house design, not the provider's table/overflow patch,
    // comments or author styles. CSSOM state is not serialized into storage.
    Array.prototype.forEach.call(document.querySelectorAll('style#tdoc-reader'), function (style) {
      if (style.sheet) style.sheet.disabled = true;
    });
  }
  var interactionMode = 'read';
  // The mode is this script's to set, never the document's: a page saved or
  // published with data-tdoc-interaction-mode="edit" on <html> must not open
  // in Edit mode's chrome (the slide bar, edit-only styles) for its readers.
  document.documentElement.removeAttribute('data-tdoc-interaction-mode');
  // Site pages (home, pricing, start, templates, privacy) load the frame with
  // ?tdoc_site=1. They read as an ordinary website: a normal cursor, no
  // document chrome on visuals, and no comment on a bare click. Selecting text
  // still opens a comment -- that is the demo.
  // The home page adds &tdoc_demo=1: it IS the demo, so it keeps the blue
  // comment cursor and click-a-word-to-comment (Julie, 2026-11-02). Only the
  // fullscreen and diagram chrome stays off there.
  var SITE_PARAMS = new URLSearchParams(location.search);
  var SITE = SITE_PARAMS.get('tdoc_site') === '1';
  var SITE_DEMO = SITE && SITE_PARAMS.get('tdoc_demo') === '1';
  if (SITE) document.documentElement.setAttribute('data-tdoc-site', '');
  if (SITE && !SITE_DEMO) document.documentElement.setAttribute('data-tdoc-site-plain', '');
  function visualViewerOpen() { return document.documentElement.hasAttribute('data-tdoc-visual-open'); }
  // Block/artifact hover outline. Off on the homepage — landing sections are
  // huge commentable boxes and the dashed chrome gets in the way. Text
  // selection commenting still works. Shell sets this via tdoc:mode.
  var elementComment = true;

  // Whether the shell currently has a comment card, cluster, or composer open.
  // While something is open, the next click anywhere in the document only
  // dismisses it — it must not open a different comment or start a new one.
  var shellUiOpen = false;
  var swallowClick = false;
  var dismissDownX = 0, dismissDownY = 0;
  var COMMENT_ICON_PATH = 'M2 2H12A10 10 0 1 1 2 12V2Z';
  var COMMENT_ACCENT = '#1652f0';
  var HL = !!(window.CSS && CSS.highlights && window.Highlight);
  var reanchorMode = false;
  var pointerStartX = 0, pointerStartY = 0;
  function highlightCss(dark) {
    var anchor = dark ? 'rgba(255,214,0,.78)' : 'rgba(255,214,0,.38)';
    // The block that replaced a visible comment's words: a light, dashed mark.
    var moved = dark ? 'rgba(255,214,0,.34)' : 'rgba(255,214,0,.16)';
    var pending = dark ? 'rgba(255,214,0,.88)' : 'rgba(255,214,0,.55)';
    var selecting = dark ? 'rgba(76,137,255,.72)' : 'rgba(22,82,240,.32)';
    return '::highlight(tdoc-anchor){background:' + anchor + ';text-decoration:underline solid rgba(184,134,11,.7);text-decoration-thickness:2px;}' +
      '::highlight(tdoc-anchor-active){background:rgba(255,216,77,.94);text-decoration:underline solid #b8860b;text-decoration-thickness:3px;}' +
      '::highlight(tdoc-anchor-flash){background:rgba(255,185,0,.98);text-decoration:underline solid #9a6200;text-decoration-thickness:3px;}' +
      '::highlight(tdoc-anchor-moved){background:' + moved + ';text-decoration:underline dashed rgba(184,134,11,.55);text-decoration-thickness:1.5px;}' +
      '::highlight(tdoc-selecting){background:' + selecting + ';}' +
      '::highlight(tdoc-pending){background:' + pending + ';}' +
      // Comments tdoc's own feedback widget left on this doc (fbAnchors).
      '::highlight(tdoc-fb-quote){background:' + (dark ? 'rgba(255,200,0,.5)' : 'rgba(255,200,0,.32)') + ';}';
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
    // Author figure rules also match our SVG icons. Protect the provider's
    // fixed icon geometry from ID-scoped map sizing and reader image margins.
    s.textContent =
      '.tdoc-hover-outline{position:absolute;pointer-events:none;z-index:2147483644;border:2px dashed ' + COMMENT_ACCENT + ';border-radius:4px;background:rgba(22,82,240,.06);box-sizing:border-box;}' +
      '.tdoc-comment-pill{position:absolute;z-index:2147483645;width:30px;height:30px;padding:0;background:rgba(255,255,255,.96);color:' + COMMENT_ACCENT + ';border:1px solid #dedee3;border-radius:999px;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.06),0 3px 10px rgba(0,0,0,.08);display:inline-flex;align-items:center;justify-content:center;line-height:1;}' +
      '.tdoc-comment-pill:hover{background:' + COMMENT_ACCENT + ';color:#fff;border-color:' + COMMENT_ACCENT + ';}' +
      '.tdoc-comment-pill svg{width:14px;height:14px;stroke:none;}' +
      'figure[data-tdoc-artifact="Diagram"][aria-label="Diagram"][data-tdoc-excalidraw]{border:0!important;border-radius:0!important;padding:0!important;background:transparent!important;}' +
      'figure[data-tdoc-excalidraw] > figcaption[data-tdoc-provider]{display:none;}' +
      'figure[data-tdoc-excalidraw] [data-tdoc-diagram-tools]{display:flex;justify-content:flex-end;box-sizing:border-box;padding-right:52px;margin-bottom:4px;}' +
      'html[data-tdoc-interaction-mode="edit"] figure[data-tdoc-excalidraw] [data-tdoc-diagram-tools]{padding-right:0;}' +
      'figure[data-tdoc-excalidraw] [data-tdoc-diagram-open]{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 13px;border:1px solid #c8d7fc;border-radius:999px;background:#f3f7ff;box-shadow:none;color:#1652f0;font:600 13px/1.2 system-ui,sans-serif;white-space:nowrap;cursor:pointer;}' +
      'figure[data-tdoc-excalidraw] [data-tdoc-diagram-open]:hover{background:#e8f0ff;border-color:#a9c0f8;color:#1244c5;}' +
      'figure[data-tdoc-excalidraw] [data-tdoc-diagram-open]:focus-visible{outline:2px solid #1652f0;outline-offset:2px;}' +
      'figure[data-tdoc-excalidraw] [data-tdoc-diagram-open] svg{width:16px!important;min-width:16px!important;max-width:16px!important;height:16px!important;min-height:16px!important;max-height:16px!important;margin:0!important;flex:0 0 16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}' +
      '@media print{figure[data-tdoc-excalidraw] [data-tdoc-diagram-open]{display:none!important;}}' +
      'html[data-tdoc-interaction-mode="comment"] body,html[data-tdoc-interaction-mode="comment"] body *{cursor:' + commentCursor + '!important;}' +
      'html[data-tdoc-interaction-mode="comment"][data-tdoc-selecting] body,html[data-tdoc-interaction-mode="comment"][data-tdoc-selecting] body *{cursor:text!important;}' +
      'html[data-tdoc-interaction-mode="comment"] body ::selection{background:rgba(22,82,240,.32)!important;color:inherit!important;}' +
      'html[data-tdoc-interaction-mode="comment"] .tdoc-comment-pill{cursor:pointer!important;}' +
      'html[data-tdoc-site-plain][data-tdoc-interaction-mode="comment"] body,html[data-tdoc-site-plain][data-tdoc-interaction-mode="comment"] body *{cursor:auto!important;}' +
      'html[data-tdoc-site][data-tdoc-interaction-mode="comment"] a[href],html[data-tdoc-site][data-tdoc-interaction-mode="comment"] a[href] *,html[data-tdoc-site][data-tdoc-interaction-mode="comment"] button,html[data-tdoc-site][data-tdoc-interaction-mode="comment"] label,html[data-tdoc-site][data-tdoc-interaction-mode="comment"] summary{cursor:pointer!important;}' +
      'html[data-tdoc-site] [data-tdoc-diagram-tools]{display:none!important;}' +
      'html[data-tdoc-editing] [data-tdoc-editor-root]{outline:none;caret-color:#1652f0;}' +
      'html[data-tdoc-editing] [data-tdoc-editor-root]:focus{box-shadow:inset 0 0 0 1px rgba(22,82,240,.18);}';
    (document.head || document.documentElement).appendChild(s);
  })();

  // Excalidraw is opt-in. Source travels with the document through existing
  // pull/publish/download/version paths; provider buttons are never serialized.
  function diagramById(id) {
    return Array.prototype.find.call(document.querySelectorAll('figure[data-tdoc-excalidraw]'), function (el) { return el.id === id; });
  }
  function prepareDiagrams() {
    Array.prototype.forEach.call(document.querySelectorAll('figure[data-tdoc-excalidraw]'), function (figure) {
      if (!figure.id || figure.querySelector('[data-tdoc-diagram-open]')) return;
      var caption = figure.querySelector(':scope > figcaption');
      if (caption && caption.textContent.trim() === 'Diagram') caption.setAttribute('data-tdoc-provider', '');
      var button = document.createElement('button');
      button.type = 'button';
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4L16.5 3.5Z"/></svg><span>Edit diagram</span>';
      button.setAttribute('aria-label', 'Edit diagram');
      button.setAttribute('data-tdoc-provider', '');
      button.setAttribute('data-tdoc-diagram-open', '');
      button.setAttribute('contenteditable', 'false');
      button.addEventListener('click', function (event) {
        event.preventDefault(); event.stopPropagation();
        post({ type: 'tdoc:diagramOpen', id: figure.id, title: figure.getAttribute('aria-label') || 'Diagram', json: figure.getAttribute('data-tdoc-excalidraw') });
      });
      var tools = document.createElement('div');
      tools.setAttribute('data-tdoc-provider', '');
      tools.setAttribute('data-tdoc-diagram-tools', '');
      tools.appendChild(button);
      figure.insertBefore(tools, figure.firstChild);
    });
  }
  function applyDiagram(d) {
    var figure = diagramById(d.id);
    if (!figure || typeof d.json !== 'string' || d.json.length > 2000000 || typeof d.svg !== 'string' || d.svg.length > 4000000) return;
    try {
      var scene = JSON.parse(d.json);
      if (scene.type !== 'excalidraw' || !Array.isArray(scene.elements)) return;
      var parsed = new DOMParser().parseFromString(d.svg, 'image/svg+xml');
      var svg = parsed.documentElement;
      if (svg.localName !== 'svg' || parsed.querySelector('parsererror')) return;
      // Only use the exported vector snapshot; no active content or links.
      Array.prototype.forEach.call(svg.querySelectorAll('script,foreignObject,iframe,object,embed,a,image,use'), function (el) { el.remove(); });
      Array.prototype.forEach.call([svg].concat(Array.prototype.slice.call(svg.querySelectorAll('*'))), function (el) {
        Array.prototype.forEach.call(Array.prototype.slice.call(el.attributes), function (attr) {
          if (/^on/i.test(attr.name) || /href$/i.test(attr.name)) el.removeAttribute(attr.name);
        });
      });
      var snapshot = figure.querySelector('[data-tdoc-diagram-snapshot]');
      if (!snapshot) return;
      if (interactionMode !== 'edit') setInteractionMode('edit');
      svg.style.maxWidth = '100%';
      svg.style.height = 'auto';
      snapshot.replaceChildren(document.importNode(svg, true));
      figure.setAttribute('data-tdoc-excalidraw', d.json);
      onEditInput();
      return true;
    } catch (error) { return false; }
  }
  function insertDiagram(d) {
    if (interactionMode !== 'edit' || typeof d.id !== 'string' || !/^diagram-[a-f0-9-]{36}$/i.test(d.id) || document.getElementById(d.id)) return false;
    var root = findEditRoot();
    if (!root) return false;
    var figure = document.createElement('figure');
    figure.id = d.id;
    figure.setAttribute('data-tdoc-artifact', 'Diagram');
    figure.setAttribute('data-tdoc-excalidraw', '');
    figure.setAttribute('aria-label', 'Diagram');
    figure.setAttribute('data-tdoc-editor-atomic', '');
    figure.setAttribute('data-tdoc-editor-original-editable', '__missing__');
    figure.setAttribute('contenteditable', 'false');
    figure.style.cssText = 'display:block;max-width:100%;margin:1.5rem 0';
    var snapshot = document.createElement('div');
    snapshot.setAttribute('data-tdoc-diagram-snapshot', '');
    snapshot.style.overflow = 'hidden';
    figure.appendChild(snapshot);

    var range = savedRange;
    if (!range && window.getSelection().rangeCount) range = window.getSelection().getRangeAt(0);
    var node = range && range.startContainer;
    if (node && node.nodeType !== 1) node = node.parentNode;
    while (node && node !== root && node.parentNode !== root) node = node.parentNode;
    if (node && node.parentNode === root) node.after(figure);
    else root.appendChild(figure);
    if (!applyDiagram(d)) { figure.remove(); return false; }
    prepareDiagrams();
    var after = figure.nextElementSibling;
    if (!after) {
      after = document.createElement('p');
      after.appendChild(document.createElement('br'));
      figure.after(after);
      onEditInput();
    }
    try {
      root.focus({ preventScroll: true });
      var caret = document.createRange();
      caret.selectNodeContents(after);
      caret.collapse(true);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(caret);
      savedRange = caret.cloneRange();
    } catch (e) {}
    return true;
  }

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
  // Text anchors live in the shared module (shell/src/comments/selection/
  // anchors/text-range.js), bundled ahead of this file as TdocSelection.
  var TS = TdocSelection;
  function context(range, chars) { return TS.contextAround(range, chars); }
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
  function placeInView(range, text) { return TS.placeInView(range, text, docView()); }

  // An embedded sheet (sheet-embed-viewer.js) is not the page's text: a
  // selection that starts or ends in one is not a quote, and one that spans
  // one keeps only the page's own words around it.
  function inEmbedHost(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('[data-tdoc-embed-host]'));
  }
  function postTextSelection(range, text) {
    if (inEmbedHost(range.startContainer) || inEmbedHost(range.endContainer)) return;
    var hosts = document.querySelectorAll('[data-tdoc-embed-host]');
    for (var hi = 0; hi < hosts.length; hi++) {
      if (range.intersectsNode(hosts[hi])) { text = String(range.toString() || '').trim(); break; }
    }
    if (!text) return;
    var placed = placeInView(range, text);
    var ctx = placed ? { before: placed.before, after: placed.after } : context(range, 60);
    // Keep the selected passage visible while the shell composer has focus.
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
    if (interactionMode !== 'comment' || visualViewerOpen()) return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    var text = sel.toString().trim();
    if (!text) return;
    postTextSelection(sel.getRangeAt(0), text);
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
    if (interactionMode !== 'comment' || event.button !== 0) return false;
    if (SITE && !SITE_DEMO && !reanchorMode) return false;
    if (event.target && event.target.closest && event.target.closest('a,button,input,label,textarea,select,summary,[contenteditable],.tdoc-comment-pill')) return false;
    var current = window.getSelection();
    if (current && !current.isCollapsed) return false; // a drag selection owns this click
    var point = caretAtPoint(event.clientX, event.clientY);
    if (!point || !point.node || point.node.nodeType !== Node.TEXT_NODE) return false;
    var bounds = wordBounds(point.node.nodeValue || '', point.offset);
    if (!bounds || bounds.end - bounds.start < 1) return false;
    try {
      var range = document.createRange();
      range.setStart(point.node, bounds.start); range.setEnd(point.node, bounds.end);
      var text = range.toString().trim();
      if (!text) return false;
      // Clicked past the text, not on it: leave the click to the clear path so
      // it dismisses whatever is open instead of commenting on a neighbour.
      if (!pointOverRange(range, event.clientX, event.clientY)) return false;
      if (current) { current.removeAllRanges(); current.addRange(range); }
      event.preventDefault(); event.stopPropagation();
      postTextSelection(range, text);
      return true;
    } catch (e) {}
    return false;
  }
  // Links: a click inside the sandboxed frame would navigate the FRAME (nested
  // shell / 404), not the page. Intercept and hand navigation to the shell,
  // which navigates the top document (or opens a tab for target=_blank).
  document.addEventListener('click', function (e) {
    if (visualViewerOpen() || e.target.closest?.('.tdoc-visual-open')) return;
    if (e.target.closest && e.target.closest('[data-tdoc-diagram-open]')) return;
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
    if (e.target && e.target.closest && e.target.closest('.tdoc-comment-pill')) return;
    if (reanchorMode) { reportPointSelection(e); return; }
    // A drag across existing highlighted text can still finish with a click
    // event. Keep that gesture as a selection; opening the old thread would
    // make the next tap on Comment dismiss the card instead of composing.
    var dragSelection = window.getSelection();
    if (dragSelection && !dragSelection.isCollapsed
      && (Math.abs(e.clientX - pointerStartX) > 4 || Math.abs(e.clientY - pointerStartY) > 4)) return;
    var commentId = interactionMode === 'comment' ? anchorIdAtPoint(e.clientX, e.clientY) : null;
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
    // Cmd/Ctrl/Shift-click means "somewhere else", as on any page (#896).
    var blank = a.getAttribute('target') === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey;
    post({ type: 'tdoc:navigate', href: href, blank: blank });
  }, true);
  // Middle-click fires auxclick, not click, and the sandbox has no
  // allow-popups, so the browser's own new tab is blocked. Route it the same way.
  document.addEventListener('auxclick', function (e) {
    if (e.button !== 1 || visualViewerOpen() || interactionMode === 'edit') return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!/^(https?:\/\/|\/(?!\/))/i.test(href)) return;
    e.preventDefault(); e.stopPropagation();
    post({ type: 'tdoc:navigate', href: href, blank: true });
  }, true);

  function clearSelectingCursor() { document.documentElement.removeAttribute('data-tdoc-selecting'); }
  document.addEventListener('mouseup', function (e) {
    if (visualViewerOpen()) return;
    clearSelectingCursor();
    if (reanchorMode) {
      var reanchorSelection = window.getSelection();
      if (reanchorSelection && !reanchorSelection.isCollapsed && reanchorSelection.rangeCount) {
        var reanchorText = reanchorSelection.toString().trim();
        if (reanchorText) postTextSelection(reanchorSelection.getRangeAt(0), reanchorText);
      }
      return;
    }
    // A dismissing click must not report a selection either. Content styled
    // `user-select: all` selects its whole block on a single click, which came
    // back as a composer on the very click that closed a card. A real drag is
    // still a selection, so only a pointer that stayed put is suppressed.
    var moved = Math.abs(e.clientX - dismissDownX) > 4 || Math.abs(e.clientY - dismissDownY) > 4;
    if (swallowClick && !moved) {
      // A double- or triple-click selected a word or a sentence on purpose. The
      // card it landed beside closes, and the selection is the next comment —
      // it is not made to be selected twice. (`detail` counts the clicks; a
      // single click on `user-select: all` content stays a dismissal.)
      var multi = e.detail >= 2 && interactionMode === 'comment';
      var live = multi ? window.getSelection() : null;
      if (multi && live && !live.isCollapsed && live.rangeCount) {
        post({ type: 'tdoc:cleared' });
        setTimeout(reportSelection, 0);
        return;
      }
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
  // A tap on highlighted text. iOS Safari sends no click (and no mouse
  // events) for a tap on plain, non-interactive text, and a highlight is a
  // painted range, not an element -- so on an iPhone the click handler above
  // never ran and tapping a highlight did nothing (Julie, 2026-10-13). Read
  // the tap itself: one finger, short, barely moved.
  var _tap = null;
  document.addEventListener('touchstart', function (e) {
    var t = e.touches && e.touches.length === 1 ? e.touches[0] : null;
    var selected = t ? window.getSelection() : null;
    _tap = t ? {
      x: t.clientX, y: t.clientY, at: Date.now(),
      // A tap on the selected passage is for the native copy menu. A tap
      // elsewhere dismisses the composer, even on iOS where plain text taps
      // never produce the mouse events used by the desktop clear path.
      inSelection: !!(selected && !selected.isCollapsed && selected.rangeCount
        && pointOverRange(selected.getRangeAt(0), t.clientX, t.clientY))
    } : null;
  }, { capture: true, passive: true });
  document.addEventListener('touchend', function (e) {
    var start = _tap;
    _tap = null;
    var t = e.changedTouches && e.changedTouches[0];
    var still = start && t && Math.abs(t.clientX - start.x) < 10
      && Math.abs(t.clientY - start.y) < 10 && Date.now() - start.at < 600;
    if (still && shellUiOpen && interactionMode === 'comment' && !start.inSelection
      && !visualViewerOpen() && !(e.target && e.target.closest
        && e.target.closest('a,button,input,label,textarea,select,summary,[contenteditable]'))) {
      // The pending CSS highlight outlives the browser selection. Clear both
      // before closing the composer so no yellow passage remains on the page.
      if (e.cancelable) e.preventDefault();
      if (HL) CSS.highlights.delete('tdoc-pending');
      try { var pendingSelection = window.getSelection(); if (pendingSelection) pendingSelection.removeAllRanges(); } catch (x) {}
      setActiveAnchor(null, false);
      post({ type: 'tdoc:cleared' });
      return;
    }
    if (start && !shellUiOpen && interactionMode !== 'edit' && !visualViewerOpen()) {
      var sel = window.getSelection();
      if (still && (!sel || sel.isCollapsed)) {
        var hit = anchorIdAtPoint(t.clientX, t.clientY);
        if (hit) {
          // The synthetic mouse events and click that may follow would run the
          // handlers above a second time.
          if (e.cancelable) e.preventDefault();
          setActiveAnchor(hit, false);
          post({ type: 'tdoc:anchorClick', id: hit });
          return;
        }
      }
      // Safari does not dispatch a click for ordinary text. Reuse the same
      // point-to-word path as desktop for a light tap, leaving drags alone.
      if (still && interactionMode === 'comment' && (!sel || sel.isCollapsed)
        && reportPointSelection({ button: 0, target: e.target,
          clientX: t.clientX, clientY: t.clientY,
          preventDefault: function () { if (e.cancelable) e.preventDefault(); },
          stopPropagation: function () { e.stopPropagation(); } })) return;
    }
    setTimeout(reportSelection, 0);
  }, true);
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
    pointerStartX = e.clientX; pointerStartY = e.clientY;
    if (visualViewerOpen()) return;
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

    if (!shellUiOpen && interactionMode === 'comment' && anchorIdAtPoint(e.clientX, e.clientY)) return;
    if (interactionMode === 'comment' && e.button === 0
      && !(e.target && e.target.closest && e.target.closest('a,button,input,label,textarea,select,summary,[contenteditable]'))) {
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
  // A provider viewer that hides author elements and draws them itself (the
  // sheets viewer: a <table data-tdoc-sheet> becomes a grid) stands in for
  // them here. Every hook is optional:
  //   selector(el) -> a stable anchor selector for el, or null for cssPath's
  //   proxy(el)    -> the visible element to measure in el's place, or null
  //   reveal(el)   -> bring el into view (switch tab, scroll its row in)
  //   anchor(el)   -> extra identity stored with the anchor ({ table, row,
  //                   key } for a sheet cell), or null
  //   resolve(anchor) -> the element that identity names now, null if it is
  //                   gone, undefined to fall back to the selector
  var elementHooks = window.__tdocElementHooks = window.__tdocElementHooks || {};
  function hookCall(name, el) { try { return typeof elementHooks[name] === 'function' ? elementHooks[name](el) : null; } catch (x) { return null; } }
  function visibleFor(el) { return hookCall('proxy', el) || el; }
  // A sheet's cells resolve through the sheets viewer's hook, registered as
  // the 'sheet' anchor adapter (selection/anchors/registry.js): any anchor
  // carrying `sheet` ({ table, row, key }, data-key) is the viewer's to find.
  TS.registerAnchorAdapter('sheet', {
    match: function (anchor) { return !!(anchor && anchor.sheet && typeof anchor.sheet === 'object'); },
    resolve: function (anchor) {
      if (typeof elementHooks.resolve !== 'function') return undefined;
      try { return elementHooks.resolve(anchor); } catch (x) { return undefined; }
    },
  });
  // { element, approximate }: an adapter's answer when it has one, else the
  // shared finder.
  function resolveElementAnchor(anchor) {
    var adapter = TS.adapterFor(anchor);
    if (adapter) {
      var found = adapter.resolve(anchor);
      if (found !== undefined) return { element: found || null, approximate: false };
    }
    return TS.resolveElement(anchor, { exclude: isProbeUI });
  }
  var UI_SEL = '.tdoc-hover-outline, .tdoc-comment-pill, [data-tdoc-provider]';
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
    var stable = hookCall('selector', el);
    if (stable) return stable;
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
    // document coordinates honest, and body clones (serializeDocument) never include the UI.
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
  function commentOnElement(el, near, named) {
    var r = clipRect(visibleFor(el));   // visible box — the raw rect of a scroll-container child can be miles wide
    var label = named || el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('data-tdoc-artifact') || el.tagName.toLowerCase();
    // Anchor the composer to the PILL the user just clicked (element top-right),
    // not the element box — a tall section would otherwise park the composer
    // below the whole box, far from the click.
    var pr = (hoverPill && hoverPill.style.display !== 'none') ? hoverPill.getBoundingClientRect() : null;
    var ar = near || (pr && (pr.width || pr.height) ? pr : null) || { top: r.top, left: Math.max(r.left, r.right - 40), bottom: r.top + 36, right: r.right, width: 30, height: 30 };
    var identity = hookCall('anchor', el);
    // The shared description (selection/anchors/element.js): selector,
    // what it shows, and its slide's stable id. cssPath stays only as the
    // fallback selector shape older anchors were written with.
    var described = TS.describeElement(el);
    post({
      type: 'tdoc:selection', kind: 'element', label: String(label).slice(0, 80), selector: hookCall('selector', el) || described.selector || cssPath(el),
      element: { tag: described.tag, text: described.text, accessible_name: described.accessible_name, container: described.container || null, container_is_target: !!described.container_is_target },
      sheet: identity && typeof identity === 'object' ? identity : undefined,
      text: '', context_before: '', context_after: '',
      rect: { top: ar.top, left: ar.left, bottom: ar.bottom, right: ar.right, width: ar.width, height: ar.height },
    });
    hideHover();
  }
  // A box drawn on an artifact (a chart, an image, a diagram, a slide):
  // the artifact's description plus where the box sits, as fractions.
  function commentOnRegion(el, box) {
    var anchor = TS.regionOf(box, el, { exclude: isProbeUI });
    post({
      type: 'tdoc:selection', kind: 'element', label: String(anchor.label || 'Area').slice(0, 80), selector: hookCall('selector', el) || anchor.selector || cssPath(el),
      element: { tag: anchor.tag, text: anchor.text, accessible_name: anchor.accessible_name, container: anchor.container || null, container_is_target: !!anchor.container_is_target },
      region: anchor.region,
      text: '', context_before: '', context_after: '',
      rect: { top: box.top, left: box.left, bottom: box.bottom, right: box.right, width: box.width, height: box.height },
    });
    hideHover();
  }
  // The slides presenter's "Comment on this slide" asks for a whole-element
  // comment the same way the hover pill does; the sheets viewer asks for a
  // cell, column or sheet, and names it ("Budget!C12 · Amount").
  document.addEventListener('tdoc:comment-element', function (e) {
    var d = e.detail || {};
    if (!d.el || !d.el.isConnected) return;
    hideHover(); commentOnElement(d.el, d.rect || null, typeof d.label === 'string' ? d.label.slice(0, 80) : null);
  });
  document.addEventListener('mousemove', function (e) {
    if (interactionMode !== 'comment' || !elementComment || visualViewerOpen()) { if (hoverEl) hideHover(); return; }
    var t = e.target;
    if (isProbeUI(t)) return; // keep the pill/outline up while the cursor is on them
    var art = artifactFor(t);
    if (art) positionHover((hoverEl = art));
    else if (hoverEl) hideHover();
  });
  window.addEventListener('scroll', function () { if (hoverEl) positionHover(hoverEl); }, { passive: true });

  // ── Picking and drawing a box (selection/pick-gesture.js, shared with the
  // feedback widget) ──────────────────────────────────────────────────────
  // areaSelect: a drag that starts on an artifact (an image, a chart, a
  // diagram, a slide) and not on its text draws a box (the feedbackAreaSelect
  // rule, sent by the shell in tdoc:mode). picking: the shell's + Comment
  // (tdoc:startPick): a click on an artifact comments on it, a drag over
  // text quotes it, a box on an artifact comments on that area, and a click
  // on nothing in particular asks the shell for a whole-document comment.
  var areaSelect = false, picking = false, marquee = null, pressArtifact = null;
  function showMarquee(box) {
    if (!box) { if (marquee) marquee.style.display = 'none'; return; }
    if (!marquee) {
      marquee = document.createElement('div');
      marquee.setAttribute('data-tdoc-provider', '');
      marquee.className = 'tdoc-drag-marquee';
      marquee.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid ' + COMMENT_ACCENT + ';background:rgba(22,82,240,.08);border-radius:4px;';
      document.documentElement.appendChild(marquee);
    }
    marquee.style.display = 'block';
    marquee.style.left = box.left + 'px'; marquee.style.top = box.top + 'px';
    marquee.style.width = box.width + 'px'; marquee.style.height = box.height + 'px';
  }
  function frameElementAt(x, y) {
    var el = null; try { el = document.elementFromPoint(x, y); } catch (e) { el = null; }
    return el && !isProbeUI(el) ? el : null;
  }
  function frameStartsOnText(x, y) {
    try {
      var node = null;
      if (document.caretPositionFromPoint) { var c = document.caretPositionFromPoint(x, y); node = c && c.offsetNode; }
      else if (document.caretRangeFromPoint) { var r0 = document.caretRangeFromPoint(x, y); node = r0 && r0.startContainer; }
      if (!node || node.nodeType !== 3 || !node.textContent.trim()) return false;
      var parent = node.parentElement;
      if (!parent || parent.closest('svg') || isProbeUI(parent)) return false;
      var range = document.createRange(); range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length; i++) { var q = rects[i]; if (x >= q.left - 1 && x <= q.right + 1 && y >= q.top - 1 && y <= q.bottom + 1) return true; }
      return false;
    } catch (e) { return false; }
  }
  function endPick(cancelled) {
    if (!picking) return;
    picking = false;
    document.documentElement.removeAttribute('data-tdoc-picking');
    hideHover(); showMarquee(null);
    if (cancelled) post({ type: 'tdoc:pickCancelled' });
  }
  var gestureOptions = {
    areaSelect: false,
    textSelect: false,
    elementAt: frameElementAt,
    startsOnText: frameStartsOnText,
    onHover: function (el) {
      if (!picking) return;
      var art = el && artifactFor(el);
      if (art) positionHover((hoverEl = art)); else hideHover();
    },
    onDrag: showMarquee,
    onElement: function (el) {
      if (!picking) return;
      var art = el && artifactFor(el);
      endPick(false);
      if (art) commentOnElement(art);
      else post({ type: 'tdoc:pickNothing' });
    },
    onText: function (a, b) {
      if (!picking) return;
      endPick(false);
      var r = TS.rangeBetweenPoints(a, b);
      var text = r ? String(r.toString()).trim() : '';
      if (text) postTextSelection(r, text); else post({ type: 'tdoc:pickNothing' });
    },
    onBox: function (box) {
      var art = pressArtifact;
      endPick(false);
      if (art) commentOnRegion(art, box);
    },
  };
  var gesture = TS.createPickGesture(gestureOptions);
  // A box is drawn on pictures: images, charts, diagrams, video, embedded
  // frames, slides. Not on text blocks (a section, a quote, a table), where a
  // press selects words or picks a suggestion.
  var BOX_ON = 'img, svg, canvas, video, figure, iframe[src], [data-tdoc-slide], [data-tdoc-artifact], [data-tdoc-excalidraw]';
  function boxTarget(node) {
    var el = node && node.closest ? node.closest(BOX_ON) : null;
    return el && !isProbeUI(el) ? el : null;
  }
  function gestureWanted(e) {
    if (interactionMode === 'edit' || visualViewerOpen()) return false;
    if (picking) return true;
    if (!areaSelect || interactionMode !== 'comment' || !elementComment) return false;
    // Only a press on a picture, off its text: text keeps selecting text.
    return !!boxTarget(e.target) && !frameStartsOnText(e.clientX, e.clientY);
  }
  document.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (isProbeUI(e.target) || !gestureWanted(e)) return;
    pressArtifact = picking ? artifactFor(e.target) : boxTarget(e.target);
    gestureOptions.areaSelect = areaSelect && !!(boxTarget(e.target) || (picking && pressArtifact));
    gestureOptions.textSelect = picking;
    // A pick owns the press; outside a pick only a picture's own drag (an
    // image's ghost) is held back, and the press still reaches the doc.
    if (picking) { if (e.pointerType === 'mouse') e.preventDefault(); e.stopPropagation(); }
    else if (e.pointerType === 'mouse' && /^(IMG|SVG|CANVAS|VIDEO)$/i.test(String(e.target.tagName || ''))) e.preventDefault();
    gesture.down(e);
  }, true);
  document.addEventListener('pointermove', function (e) {
    if (!gesture.pressing() && !picking) return;
    gesture.move(e);
  }, true);
  document.addEventListener('pointerup', function (e) {
    if (!gesture.pressing()) return;
    if (picking || gesture.mode() === 'area') e.stopPropagation();
    // Outside a pick, a press that did not draw a box was not ours.
    if (!picking && gesture.mode() !== 'area') { gesture.cancel(); return; }
    gesture.up(e);
  }, true);
  document.addEventListener('pointercancel', function () { gesture.cancel(true); }, true);
  // A click that ended a pick or a box must not also select or open anything.
  document.addEventListener('click', function (e) { if (picking) { e.preventDefault(); e.stopPropagation(); } }, true);
  var pickStyle = null;
  function startPick() {
    if (interactionMode === 'edit') return;
    if (!pickStyle) {
      pickStyle = document.createElement('style');
      pickStyle.setAttribute('data-tdoc-provider', '');
      pickStyle.textContent = 'html[data-tdoc-picking],html[data-tdoc-picking] *{cursor:crosshair!important;}';
      document.documentElement.appendChild(pickStyle);
    }
    picking = true;
    document.documentElement.setAttribute('data-tdoc-picking', '');
  }

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
    if (e.target.closest && e.target.closest('[data-tdoc-diagram-open]')) return;
    var trigger = e.target.closest && e.target.closest('[data-tdoc-copy]');
    if (!trigger) return;
    e.preventDefault(); e.stopPropagation();
    var raw = trigger.getAttribute('data-tdoc-copy') || '', text = raw;
    if (raw.charAt(0) === '#') { var src = document.getElementById(raw.slice(1)); if (src) text = (src.innerText || src.textContent || '').replace(/ /g, ' ').trim(); }
    post({ type: 'tdoc:copyText', text: text });
    tdocFallbackCopy(text);
    flashCopy(trigger);
  }, true);

  // --- data-tdoc-send: copy a prompt and ask the shell to open an agent app
  //     with it (tdoc's own site pages only; the shell checks). The element
  //     names the app, never a URL: data-tdoc-send="claudecode|codex|cursor|claude|claudeai|chatgpt|grok",
  //     data-tdoc-send-text="#id" holds the prompt. The label is left alone. ---
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest && e.target.closest('[data-tdoc-send]');
    if (!trigger) return;
    e.preventDefault(); e.stopPropagation();
    var raw = trigger.getAttribute('data-tdoc-send-text') || '', text = raw;
    if (raw.charAt(0) === '#') { var src = document.getElementById(raw.slice(1)); text = src ? (src.innerText || src.textContent || '').replace(/\u00a0/g, ' ').trim() : ''; }
    if (!text) return;
    tdocFallbackCopy(text);
    post({ type: 'tdoc:sendToApp', app: trigger.getAttribute('data-tdoc-send') || '', text: text });
    trigger.classList.add('tdoc-sent');
    clearTimeout(trigger._tdocSentTimer);
    trigger._tdocSentTimer = setTimeout(function () { trigger.classList.remove('tdoc-sent'); }, 1600);
  }, true);

  // --- data-tdoc-carousel: radio-driven slides (author CSS) ---
  // Author CSS can switch slides with radios and labels and even run them on
  // a timer with CSS animations, but it cannot see a swipe, and choosing the
  // radio that is already checked changes no style, so a timed cycle that has
  // moved on cannot be sent back to it. On an element with
  // data-tdoc-carousel the reader adds both:
  //   - a sideways touch swipe checks the next (left) or previous (right)
  //     radio inside it, counted from the slide on show: the
  //     [data-tdoc-carousel-for="<radio id>"] element nearest the carousel's
  //     centre, else the checked radio;
  //   - landing on the radio that is already checked (a swipe, or a click on
  //     its label) restarts the CSS animations inside from their start. ---
  function carouselRestart(host) {
    (host.getAnimations ? host.getAnimations({ subtree: true }) : []).forEach(function (a) { try { a.currentTime = 0; } catch (_) {} });
  }
  document.addEventListener('click', function (e) {
    var label = e.target && e.target.closest && e.target.closest('label[for]');
    var host = label && label.closest('[data-tdoc-carousel]');
    if (!host) return;
    var radio = document.getElementById(label.htmlFor);
    if (radio && radio.type === 'radio' && radio.checked && host.contains(radio)) carouselRestart(host);
  }, true);
  // A swipe is only a swipe in Read/Comment with nothing else under way: not
  // while + Comment is picking, not in Edit, not while a box is being drawn
  // and not over a text selection, so a comment-selection drag can never
  // flip the slide under its own anchor.
  function carouselGestureBusy() {
    if (picking || interactionMode === 'edit') return true;
    if (marquee && marquee.style.display !== 'none') return true;
    var sel = window.getSelection && window.getSelection();
    return !!(sel && sel.rangeCount && !sel.isCollapsed);
  }
  var swipeStart = null;
  document.addEventListener('touchstart', function (e) {
    var host = e.target && e.target.closest && e.target.closest('[data-tdoc-carousel]');
    swipeStart = host && e.touches.length === 1 && !carouselGestureBusy() ? { host: host, x: e.touches[0].clientX, y: e.touches[0].clientY, busy: false } : null;
  }, { passive: true, capture: true });
  document.addEventListener('touchmove', function () {
    if (swipeStart && carouselGestureBusy()) swipeStart.busy = true;
  }, { passive: true, capture: true });
  document.addEventListener('touchend', function (e) {
    var start = swipeStart; swipeStart = null;
    if (!start || start.busy || carouselGestureBusy() || !e.changedTouches.length) return;
    var dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    var host = start.host;
    // One group: the checked radio's (else the first one's) name.
    var all = Array.prototype.slice.call(host.querySelectorAll('input[type="radio"]'));
    var lead = all.filter(function (r) { return r.checked; })[0] || all[0];
    var radios = all.filter(function (r) { return !r.disabled && lead && r.name === lead.name; });
    if (radios.length < 2) return;
    var at = -1, box = host.getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + box.height / 2, best = Infinity;
    Array.prototype.forEach.call(host.querySelectorAll('[data-tdoc-carousel-for]'), function (item) {
      var r = item.getBoundingClientRect(), d = Math.abs(r.left + r.width / 2 - cx) + Math.abs(r.top + r.height / 2 - cy);
      var i = radios.indexOf(document.getElementById(item.getAttribute('data-tdoc-carousel-for')));
      if (i >= 0 && d < best) { best = d; at = i; }
    });
    if (at < 0) at = radios.findIndex(function (r) { return r.checked; });
    var next = radios[(Math.max(at, 0) + (dx < 0 ? 1 : -1) + radios.length) % radios.length];
    if (next.checked) { carouselRestart(host); return; }
    next.checked = true;
    next.dispatchEvent(new Event('change', { bubbles: true }));
  }, { passive: true, capture: true });

  // --- anchor resolution (faithful port of overlay.js collectTextNodes/
  //     findTextRange). Normalizes whitespace so multi-block/wrapped selections
  //     (Selection.toString gives "para1\n\npara2" but the raw DOM has "\n   ")
  //     resolve, with context to disambiguate repeated text. The crude raw
  //     indexOf this replaces silently failed on any cross-block selection —
  //     which is why comments showed no pin/highlight. ---
  function collectTextNodes() { return TS.collectTextNodes(document.body); }
  var normalizeNeedle = TS.normalizeNeedle, normalizeContext = TS.normalizeContext, locateAt = TS.locateAt;
  var rangeFromNorm = TS.rangeFromNorm, findNearContext = TS.findNearContext, findSurvivingFragment = TS.findSurvivingFragment;
  var blockForMoved = TS.blockForMoved, findTextRange = TS.findTextRange;
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
  // Whole-document comments share one pin beside the first title. This is
  // geometry only: inserting a spacer changed the author's article layout.
  function documentCommentsGeometry() {
    var root = findEditRoot();
    if (!root) return null;
    var heading = root.querySelector('h1');
    var rect = (heading || root).getBoundingClientRect();
    return { docY: rect.top + (window.scrollY || 0), left: rect.left,
      width: rect.width };
  }
  // The renderer owns these collections for the frame's lifetime. Mutate the
  // registered ranges so removal invalidates their old painted area. Replacing
  // a Highlight with a new empty object can leave stale pixels in Safari.
  var _anchorHighlight = HL ? new Highlight() : null;
  var _movedHighlight = HL ? new Highlight() : null;
  if (HL) {
    CSS.highlights.set('tdoc-anchor', _anchorHighlight);
    CSS.highlights.set('tdoc-anchor-moved', _movedHighlight);
  }
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
  // CSS Highlights are paint-only and have no mouseenter target. Send the id
  // under the pointer so the outer shell can light up the matching avatar,
  // without adding any status text to the highlighted document itself.
  var _hoverAnchorId = null, _hoverTimer = null, _hoverPoint = null;
  function reportAnchorHover(id) {
    if (id === _hoverAnchorId) return;
    _hoverAnchorId = id;
    post({ type: 'tdoc:anchorHover', id: id });
  }
  document.addEventListener('pointermove', function (event) {
    if (event.pointerType === 'touch' || interactionMode === 'edit') return;
    _hoverPoint = { x: event.clientX, y: event.clientY };
    if (_hoverTimer) return;
    _hoverTimer = setTimeout(function () {
      _hoverTimer = null;
      reportAnchorHover(_hoverPoint ? anchorIdAtPoint(_hoverPoint.x, _hoverPoint.y) : null);
    }, 50);
  }, { passive: true });
  document.addEventListener('pointerleave', function () {
    if (_hoverTimer) clearTimeout(_hoverTimer);
    _hoverTimer = null; _hoverPoint = null;
    reportAnchorHover(null);
  });
  window.addEventListener('scroll', function () { reportAnchorHover(null); }, { passive: true });
  function setActiveAnchor(id, scroll) {
    var target = id && _anchorTargets[id];
    if (_activeAnchorId !== (target ? id : null)) {
      for (var i = 0; i < _flashTimers.length; i++) clearTimeout(_flashTimers[i]);
      _flashTimers = [];
      if (HL) CSS.highlights.delete('tdoc-anchor-flash');
    }
    _activeAnchorId = target ? id : null;
    if (HL) CSS.highlights.delete('tdoc-anchor-active');
    if (!target) return;
    if (HL && target.range) CSS.highlights.set('tdoc-anchor-active', new Highlight(target.range));
    if (!scroll) return;
    if (target.element) hookCall('reveal', target.element);
    var rect = target.range ? target.range.getBoundingClientRect() : visibleFor(target.element).getBoundingClientRect();
    var top = rect.top + (window.scrollY || 0) - Math.max(80, window.innerHeight / 3);
    var before = window.scrollY || 0;
    try { window.scrollTo(0, Math.max(0, top)); } catch (e) {}
    // Where the frame does not scroll itself (a phone browser that sizes the
    // frame to its content and scrolls the page instead), scrollTo is a no-op;
    // scrollIntoView reaches whichever box actually scrolls.
    var after = window.scrollY || 0;
    var r2 = target.range ? target.range.getBoundingClientRect() : visibleFor(target.element).getBoundingClientRect();
    if (Math.abs(after - before) < 1 && (r2.top < 0 || r2.bottom > window.innerHeight)) {
      var node = (target.element && visibleFor(target.element)) || (target.range.startContainer.nodeType === 1 ? target.range.startContainer : target.range.startContainer.parentElement);
      try { node.scrollIntoView({ block: 'center' }); } catch (e) {}
    }
    flashActiveAnchor(id);
  }
  // Arriving at a comment's text from its card: blink the highlight twice so
  // the eye lands on it (Julie, 2026-10-13: on a phone the card just closed
  // and nothing said where to look).
  var _flashTimers = [];
  function flashActiveAnchor(id) {
    for (var i = 0; i < _flashTimers.length; i++) clearTimeout(_flashTimers[i]);
    _flashTimers = [];
    if (!HL) return;
    CSS.highlights.delete('tdoc-anchor-flash');
    var target = _anchorTargets[id];
    if (!target || !target.range) return;
    [160, 320, 480, 640].forEach(function (ms, n) {
      _flashTimers.push(setTimeout(function () {
        if (_activeAnchorId !== id) return;
        if (n % 2 === 0) CSS.highlights.set('tdoc-anchor-flash', new Highlight(target.range));
        else CSS.highlights.delete('tdoc-anchor-flash');
      }, ms));
    });
  }
  function reportPins(comments) {
    _lastComments = comments || [];
    _anchorTargets = {};
    var pins = [], hl = _anchorHighlight, hlMoved = _movedHighlight;
    if (hl) hl.clear();
    if (hlMoved) hlMoved.clear();
    // An anchor that cannot be placed still deserves a seat. Without a pin the
    // desktop rail has no coordinate to draw the card at, so the comment sits in
    // the data and nowhere on screen — while the phone drawer, which renders the
    // list directly, shows it.
    //
    // The seat goes near the END of the document, not the top. At the top a stack
    // of comments from an older version is the first thing beside the title,
    // which reads as "these matter most"; at the end it reads as what it is —
    // what the last revision left behind. Everything downstream is unchanged:
    // clustering, the rail, the dashed unanchored card, and the Re-anchor that
    // puts one back where it belongs.
    // Not the very last pixel: the rail culls a pin that falls outside the
    // viewport, and a seat pinned to the document's final row is never on
    // screen even when you scroll all the way down. Sit just above the end.
    //
    // Several lost seats must NOT share one Y. After a big rewrite many anchors
    // miss both their text and their neighbours, and a single seatY collapsed
    // them into one pile that looked like the comments had vanished. Step each
    // new seat up the page so the rail can show them as a stack.
    var seatY = Math.max(0, document.documentElement.scrollHeight - 160);
    var seatStep = 36;
    var seated = 0;
    function seat(c, extra) {
      var y = Math.max(0, seatY - seated * seatStep);
      seated++;
      var pin = { id: c.id, docY: y, lost: true, login: (c.author && c.author.login) || null,
        avatar_url: (c.author && c.author.avatar_url) || null, kind: (c.author && c.author.kind) || null,
        resolved: c.status === 'applied', deleted: !!c.deleted };
      if (extra) for (var k in extra) pin[k] = extra[k];
      pins.push(pin);
    }
    var documentPoint = documentCommentsGeometry();
    (comments || []).forEach(function (c) {
      // Skip before registering targets or painting exact/moved ranges: the
      // visibility switch governs every affordance, including element anchors.
      if (!c || c.hidden) return;
      if (!c.anchor || c.anchor.kind === 'document') {
        if (documentPoint) pins.push({ id: c.id, docY: documentPoint.docY,
          document: true, login: (c.author && c.author.login) || null,
          avatar_url: (c.author && c.author.avatar_url) || null,
          kind: (c.author && c.author.kind) || null,
          resolved: c.status === 'applied', deleted: !!c.deleted });
        return;
      }
      if (c.anchor.kind === 'element' && (c.anchor.selector || c.anchor.container || c.anchor.sheet)) {
        // The anchor adapters (selection/anchors/): a sheet's cell through
        // its registered adapter; otherwise the shared finder, where an old
        // cssPath still resolves, a slide is found by its stable id wherever
        // the deck put it, and a moved element by its words.
        var hit = resolveElementAnchor(c.anchor);
        var eel = hit.element;
        if (eel) {
          var box = c.anchor.region ? TS.regionRect(c.anchor, eel) : null;
          _anchorTargets[c.id] = { element: eel, region: box ? c.anchor.region : null };
          var er = box || visibleFor(eel).getBoundingClientRect();
          // A guess (twin slides, several elements showing its words) is
          // drawn like a moved text anchor: dashed card, Re-anchor.
          pins.push({ id: c.id, lost: hit.approximate || undefined, docY: er.top + (window.scrollY || 0), elementKey: box ? null : (c.anchor.selector || TS.containerKey(c.anchor)), elementTop: er.top + (window.scrollY || 0), elementHeight: er.height, login: (c.author && c.author.login) || null, avatar_url: (c.author && c.author.avatar_url) || null, kind: (c.author && c.author.kind) || null, resolved: c.status === 'applied', deleted: !!c.deleted });
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
      if (!r) {
        r = findSurvivingFragment(c.anchor, docView());
        approximate = !!r;
      }
      if (!r) return seat(c);
      _anchorTargets[c.id] = { range: r };
      // Rewritten words: mark the block that replaced this visible thread.
      if (approximate && hlMoved && !c.deleted) { var mv = blockForMoved(r); if (mv) hlMoved.add(mv); }
      if (hl && !c.deleted && !approximate) hl.add(r);
      var rect = r.getBoundingClientRect();
      // Second line of defence: findNearContext already measures its candidates,
      // but an exact hit can be invisible too (a rule moved into a hidden block).
      if (approximate && !rect.width && !rect.height) return seat(c);
      pins.push({ id: c.id, docY: rect.top + (window.scrollY || 0), lost: approximate || undefined, login: (c.author && c.author.login) || null, avatar_url: (c.author && c.author.avatar_url) || null, kind: (c.author && c.author.kind) || null, resolved: c.status === 'applied', deleted: !!c.deleted });
    });
    setActiveAnchor(_activeAnchorId, false);
    // Frame-local: the slides presenter counts the threads on the slide shown.
    try { document.dispatchEvent(new CustomEvent('tdoc:anchors-resolved', { detail: { targets: _anchorTargets, comments: (comments || []).filter(function (c) { return c && !c.hidden && !c.deleted; }).map(function (c) { return c.id; }) } })); } catch (x) {}
    post({ type: 'tdoc:pins', pins: pins, documentComments: documentPoint,
      scrollY: window.scrollY || 0, articleRight: Math.round(articleRight()), docHeight: document.documentElement.scrollHeight });
  }

  // Geometry can settle AFTER the first pin report (images/fonts load, layout
  // shifts): re-resolve + re-report so pins/cards move to the real article
  // edge instead of sticking mid-screen until the next comment arrives.
  var _geoTimer = null;
  function rereportPins() { if (_geoTimer) clearTimeout(_geoTimer); _geoTimer = setTimeout(function () { _view = null; _rangeCache = {}; reportPins(_lastComments); }, 150); }
  window.addEventListener('load', rereportPins);
  // A provider viewer moved what anchors are drawn on (the sheets grid
  // scrolled, sorted, or switched tab): place the pins again.
  document.addEventListener('tdoc:relayout', rereportPins);
  // The provider owns table readability for old and newly-authored versions.
  // Recompute from content/fonts/container geometry, not only window width:
  // a reader width toggle, an opened <details>, or an edit can change it.
  var tableLayoutTimer = null;
  function refreshTableLayout() {
    if (tableLayoutTimer) clearTimeout(tableLayoutTimer);
    tableLayoutTimer = setTimeout(function () {
      layoutTables();
      rereportPins();
      reportScroll();
    }, 80);
  }
  layoutTables();
  window.addEventListener('resize', refreshTableLayout);
  window.addEventListener('load', refreshTableLayout);
  document.addEventListener('toggle', refreshTableLayout, true);
  document.addEventListener('input', refreshTableLayout);
  if (document.fonts) {
    document.fonts.ready.then(refreshTableLayout);
    document.fonts.addEventListener('loadingdone', refreshTableLayout);
  }
  if (typeof ResizeObserver !== 'undefined') {
    try { new ResizeObserver(rereportPins).observe(document.body); } catch (e) {}
    try {
      var tableWidths = new WeakMap();
      var tableResize = new ResizeObserver(function (entries) {
        entries.forEach(function (entry) {
          var width = entry.contentRect.width;
          if (tableWidths.get(entry.target) !== width) {
            tableWidths.set(entry.target, width); refreshTableLayout();
          }
        });
      });
      tableResize.observe(document.body);
      document.querySelectorAll('body>.wrap,body>main,body>article,body>.content,body>.container').forEach(function (root) { tableResize.observe(root); });
    } catch (e) {}
  }
  new MutationObserver(function (records) {
    if (records.some(function (record) {
      var el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (el && el.closest('table')) return true;
      return Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).some(function (node) {
        return node.nodeType === 1 && (node.matches('table') || node.querySelector('table'));
      });
    })) refreshTableLayout();
  }).observe(document.body, { childList:true, characterData:true, subtree:true });

  // Only the tdoc reader design participates in the shell theme. Custom
  // designs keep their original palette, even if an old shell sends a theme.
  // Photos/video/canvas are inverted back for the default reader.
  var themeStyle = null;
  function applyTheme(theme) {
    if (!supportsTheme) return;
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
  var ATOMIC = 'img,svg,canvas,video,audio,pre,iframe,table,[data-tdoc-edit-atomic],[data-tdoc-excalidraw]';
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
  // The sheets viewer writes a cell edit into the author's table itself; it
  // tells the editor here, and the draft, dirty state and Save follow the
  // same path as typing in the page.
  document.addEventListener('tdoc:sheet-edit', function () {
    if (interactionMode !== 'edit') return;
    setDirty(true, true);
    reportDraft();
  });
  // The slide controls (slides-edit.js) add, copy, move and delete whole
  // slides; the same path again. A slide they add may carry an image slot,
  // which is atomic like any image: marked here exactly as enableEditing
  // marks the page, so the save cleans it the same way.
  document.addEventListener('tdoc:slides-edit', function (event) {
    if (interactionMode !== 'edit') return;
    var added = event.detail && event.detail.added;
    if (added && added.querySelectorAll) {
      var nodes = Array.prototype.slice.call(added.querySelectorAll(ATOMIC));
      if (added.matches && added.matches(ATOMIC)) nodes.unshift(added);
      nodes.forEach(function (node) {
        node.setAttribute('data-tdoc-editor-atomic', '');
        if (!node.hasAttribute('data-tdoc-editor-original-editable')) {
          node.setAttribute('data-tdoc-editor-original-editable', node.hasAttribute('contenteditable') ? node.getAttribute('contenteditable') : '__missing__');
        }
        node.setAttribute('contenteditable', 'false');
      });
    }
    setDirty(true, true);
    reportDraft();
  });
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
  function setInteractionMode(mode, opts) {
    var next = /^(read|comment|edit)$/.test(mode) ? mode : 'read';
    if (interactionMode === 'edit' && next !== 'edit') disableEditing();
    interactionMode = next;
    if (opts && typeof opts.elementComment === 'boolean') elementComment = opts.elementComment;
    if (opts && typeof opts.areaSelect === 'boolean') areaSelect = opts.areaSelect;
    if (next === 'edit') endPick(true);
    document.documentElement.setAttribute('data-tdoc-interaction-mode', next);
    clearSelectingCursor();
    if (HL) {
      if (next === 'comment') {
        CSS.highlights.set('tdoc-anchor', _anchorHighlight);
        CSS.highlights.set('tdoc-anchor-moved', _movedHighlight);
        // A mode message may arrive while the mobile drawer is closing after
        // a comment was chosen. Keep its focused anchor visible in Comment.
        if (_activeAnchorId) setActiveAnchor(_activeAnchorId, false);
      } else {
        CSS.highlights.delete('tdoc-anchor');
        CSS.highlights.delete('tdoc-anchor-moved');
        CSS.highlights.delete('tdoc-anchor-active');
        CSS.highlights.delete('tdoc-anchor-flash');
        for (var i = 0; i < _flashTimers.length; i++) clearTimeout(_flashTimers[i]);
        _flashTimers = [];
      }
    }
    if (HL && next !== 'comment') CSS.highlights.delete('tdoc-selecting');
    if (next === 'edit' || next !== 'comment' || !elementComment) { hideHover(); }
    if (next === 'edit') enableEditing();
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
    clone.removeAttribute('data-tdoc-slides');
    clone.removeAttribute('data-tdoc-presenting');
    clone.removeAttribute('data-tdoc-visual-open');
    clone.removeAttribute('data-tdoc-interaction-mode');
    return '<!doctype html>\n' + clone.outerHTML;
  }

  // --- the homepage demo's scripted Edit -----------------------------------
  // Only the shell's demo (shell/src/document/demo-agent.js DEMO_REWRITES,
  // the signed-out landing doc) sends these; no real doc ever gets one. The
  // shell names one paragraph by its text and the canned rewrite. The old
  // words are struck, the new ones typed in after them, then the struck words
  // fold away and the new text stays marked as the version compare marks an
  // insertion (version-diff.js markCss). Reduced motion: the end state at
  // once. Only this page's DOM changes; nothing is saved, and Undo (or a
  // reload) brings the paragraph back.
  //   { type:'tdoc:demoRewrite', id, before, after, view:{ top, bottom } }
  //     (view: the band of this frame the visitor can see, in its viewport)
  //     → { type:'tdoc:demoRewriteDone', id, ok }
  //   { type:'tdoc:demoRewriteShow', view } (bring the rewritten paragraph
  //     into a new band: a phone's drawer has reopened over the page)
  //   { type:'tdoc:demoRewriteUndo' }
  var demoRewrite = null; // { el, html, timers }
  function demoRewriteCss() {
    if (document.getElementById('tdoc-provider-demo-rewrite-style')) return;
    var st = document.createElement('style');
    st.id = 'tdoc-provider-demo-rewrite-style';
    st.setAttribute('data-tdoc-provider', '');
    st.textContent = ((window.TdocVersionDiff && window.TdocVersionDiff.markCss) || '') +
      '[data-tdoc-demo-rewrite] .tdoc-diff-del{transition:opacity .3s ease}' +
      '[data-tdoc-demo-rewrite="striking"] .tdoc-diff-del{animation:tdoc-demo-strike .45s ease both}' +
      '[data-tdoc-demo-rewrite="typing"] .tdoc-diff-del{opacity:.55}' +
      '[data-tdoc-demo-rewrite="folding"] .tdoc-diff-del{opacity:0}' +
      '[data-tdoc-demo-rewrite="typing"] .tdoc-diff-ins{box-shadow:inset -2px 0 currentColor;animation:tdoc-demo-caret .8s steps(1) infinite}' +
      '@keyframes tdoc-demo-strike{from{text-decoration-color:transparent;background-color:transparent}}' +
      '@keyframes tdoc-demo-caret{50%{box-shadow:none}}';
    (document.head || document.documentElement).appendChild(st);
  }
  function findDemoParagraph(text) {
    var want = normalizeNeedle(text);
    if (!want) return null;
    var list = document.body ? document.body.querySelectorAll('p, li, blockquote, figcaption, h1, h2, h3') : [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!el.closest('[data-tdoc-provider]') && normalizeNeedle(el.textContent) === want) return el;
    }
    return null;
  }
  function undoDemoRewrite() {
    if (!demoRewrite) return;
    demoRewrite.timers.forEach(clearTimeout);
    demoRewrite.el.innerHTML = demoRewrite.html;
    demoRewrite.el.removeAttribute('data-tdoc-demo-rewrite');
    demoRewrite = null;
    rereportPins();
  }
  // Bring the paragraph into the band the visitor can see (under the shell's
  // bar; on a phone the whole page while the drawer is closed, then the part
  // above it once it reopens): centred, or its top near the band's when it
  // is taller than the band.
  function showDemoParagraph(el, view, reduce) {
    var r = el.getBoundingClientRect();
    var band = view || {};
    var bandTop = Math.max(0, Number(band.top) || 0);
    var bandBottom = Math.min(window.innerHeight, Number(band.bottom) || window.innerHeight);
    if (bandBottom - bandTop < 60) { bandTop = 0; bandBottom = window.innerHeight; }
    var slack = bandBottom - bandTop - r.height;
    var y = (window.scrollY || 0) + r.top - bandTop - (slack > 16 ? slack / 2 : 8);
    try { window.scrollTo({ top: Math.max(0, y), behavior: reduce ? 'auto' : 'smooth' }); } catch (x) { window.scrollTo(0, Math.max(0, y)); }
  }
  function runDemoRewrite(d) {
    undoDemoRewrite();
    var el = findDemoParagraph(d.before);
    var after = String(d.after || '');
    if (!el || !after) { post({ type: 'tdoc:demoRewriteDone', id: d.id, ok: false }); return; }
    demoRewriteCss();
    var reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (x) {}
    var run = demoRewrite = { el: el, html: el.innerHTML, timers: [] };
    var later = function (ms, fn) { run.timers.push(setTimeout(fn, ms)); };
    showDemoParagraph(el, d.view, reduce);
    var del = document.createElement('del');
    del.className = 'tdoc-diff-del';
    del.textContent = normalizeNeedle(el.textContent);
    var ins = document.createElement('ins');
    ins.className = 'tdoc-diff-ins';
    var done = function () {
      if (del.parentNode) del.parentNode.removeChild(del);
      ins.textContent = after;
      el.setAttribute('data-tdoc-demo-rewrite', 'done');
      rereportPins();
      post({ type: 'tdoc:demoRewriteDone', id: d.id, ok: true });
    };
    el.textContent = '';
    el.appendChild(del);
    el.appendChild(ins);
    if (reduce) { done(); return; }
    el.setAttribute('data-tdoc-demo-rewrite', 'striking');
    var words = after.match(/\S+\s*/g) || [after];
    var step = 70;
    later(700, function () {
      el.setAttribute('data-tdoc-demo-rewrite', 'typing');
      words.forEach(function (_, i) {
        later(step * (i + 1), function () { ins.textContent = words.slice(0, i + 1).join(''); });
      });
      later(step * words.length + 500, function () {
        el.setAttribute('data-tdoc-demo-rewrite', 'folding');
        later(320, done);
      });
    });
  }

  // --- AI suggestions in the text (Ask/Edit v2, flag askEditV2) -------------
  // The shell sends edits the server has validated ({ id, find, replace }:
  // find is visible text, matched as the worker matches it -- whitespace
  // runs as one space, never across a block); each shows in place as the
  // version compare marks a change (version-diff.js textParts + markCss):
  // struck old words, new words after them. Only this page's DOM changes;
  // nothing here saves. Accept/reject go to the shell, which asks the
  // server, then tells the frame to settle the marks.
  //   { type:'tdoc:suggestShow', items:[{ id, find, replace, label }] }
  //     → { type:'tdoc:suggestShown', results:[{ id, ok, docY }] }
  //   { type:'tdoc:suggestClear', ids? }       put the original text back
  //   { type:'tdoc:suggestSettle', id, accepted } accepted: keep the new text
  //   { type:'tdoc:suggestFocus', id, scroll }  the one the review bar is on
  //   { type:'tdoc:suggestBusy', text, label }  shimmer + status pill on the
  //     passage being worked on (text null: the whole doc); label '' clears
  //   frame → shell: { type:'tdoc:suggestAction', id, action:'focus' } (a click on one)
  //                  { type:'tdoc:suggestRect', id, docY, left, right } (where it ends)
  // The same elements the worker never edits (SUGGEST_SKIP_TAGS), and
  // anything outside the HTML namespace.
  var SUGG_SKIP = { HEAD: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, TITLE: 1, SVG: 1, MATH: 1, IFRAME: 1, OBJECT: 1, CANVAS: 1, SELECT: 1, OPTION: 1, XMP: 1, NOEMBED: 1, NOFRAMES: 1, PLAINTEXT: 1 };
  var SUGG_BLOCK = {};
  'address article aside blockquote body br caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr html img li main nav ol p pre section summary table tbody td tfoot th thead tr ul button input label legend'
    .split(' ').forEach(function (t) { SUGG_BLOCK[t.toUpperCase()] = 1; });
  var suggs = {}; // id -> { kind:'one'|'many', els:[...], original, replace }
  var suggActive = null;
  var suggOn = false; // the shell has the feature on (it sent tdoc:suggestShow)
  function suggCss() {
    if (document.getElementById('tdoc-provider-sugg-style')) return;
    var st = document.createElement('style');
    st.id = 'tdoc-provider-sugg-style';
    st.setAttribute('data-tdoc-provider', '');
    st.textContent = ((window.TdocVersionDiff && window.TdocVersionDiff.markCss) || '') +
      '[data-tdoc-sugg]{cursor:pointer;border-radius:2px}' +
      '[data-tdoc-sugg-active] .tdoc-diff-ins,[data-tdoc-sugg-active] .tdoc-diff-del,.tdoc-diff-ins[data-tdoc-sugg-active],.tdoc-diff-del[data-tdoc-sugg-active]{outline:2px solid rgba(22,82,240,.45);outline-offset:1px}' +
      '[data-tdoc-sugg-busy]{background:linear-gradient(90deg,rgba(22,82,240,0) 0%,rgba(22,82,240,.10) 50%,rgba(22,82,240,0) 100%);background-size:200% 100%;animation:tdoc-sugg-shimmer 1.4s linear infinite;border-radius:4px}' +
      '@keyframes tdoc-sugg-shimmer{from{background-position:100% 0}to{background-position:-100% 0}}' +
      '@media (prefers-reduced-motion: reduce){[data-tdoc-sugg-busy]{animation:none;background:rgba(22,82,240,.07)}}' +
      '.tdoc-sugg-pill{position:absolute;z-index:2147483645;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:#fff;border:1px solid #dedee3;color:#1f2328;font:500 12px/1.3 system-ui,sans-serif;box-shadow:0 1px 2px rgba(0,0,0,.06),0 3px 10px rgba(0,0,0,.08);pointer-events:none;max-width:80vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.tdoc-sugg-pill::before{content:"";width:7px;height:7px;border-radius:50%;background:#1652f0;animation:tdoc-sugg-dot 1s ease-in-out infinite alternate}' +
      '@keyframes tdoc-sugg-dot{to{opacity:.3}}';
    (document.head || document.documentElement).appendChild(st);
  }
  function suggTextMap() {
    var chars = [];
    var last = function () { return chars[chars.length - 1]; };
    var brk = function () {
      var l = last();
      if (!l || l.c === '\n') return;
      if (l.c === ' ') { l.c = '\n'; l.node = null; return; }
      chars.push({ c: '\n', node: null });
    };
    var put = function (c, node, off) {
      if (/\s/.test(c)) {
        var l = last();
        if (!l || l.c === '\n') return;
        if (l.c === ' ') { if (l.node === node) l.end = off + 1; return; }
        chars.push({ c: ' ', node: node, off: off, end: off + 1 });
        return;
      }
      chars.push({ c: c, node: node, off: off, end: off + 1 });
    };
    var walk = function (el) {
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { var t = n.data; for (var i = 0; i < t.length; i++) put(t[i], n, i); }
        else if (n.nodeType === 1) {
          if (n.hasAttribute('data-tdoc-provider')) continue;
          var tag = String(n.tagName).toUpperCase();
          if (SUGG_SKIP[tag] || (n.namespaceURI && n.namespaceURI !== 'http://www.w3.org/1999/xhtml')) { brk(); continue; }
          var block = SUGG_BLOCK[tag];
          if (block) brk();
          walk(n);
          if (block) brk();
        }
      }
    };
    if (document.body) walk(document.body);
    return { chars: chars, text: chars.map(function (x) { return x.c; }).join('') };
  }
  function suggFind(map, text, unique) {
    var want = normalizeNeedle(text);
    if (!want) return null;
    var at = map.text.indexOf(want);
    if (at < 0) return null;
    if (unique && map.text.indexOf(want, at + 1) >= 0) return null;
    var runs = [];
    for (var k = at; k < at + want.length; k++) {
      var ch = map.chars[k];
      if (!ch.node) continue;
      var r = runs[runs.length - 1];
      if (r && r.node === ch.node) r.end = Math.max(r.end, ch.end);
      else runs.push({ node: ch.node, start: ch.off, end: ch.end });
    }
    return runs.length ? { at: at, runs: runs } : null;
  }
  function suggMark(tag, cls, id, text) {
    var el = document.createElement(tag);
    el.className = cls;
    el.setAttribute('data-tdoc-sugg', id);
    el.textContent = text;
    return el;
  }
  function suggRender(item, hit) {
    var id = String(item.id);
    var replace = String(item.replace || '');
    if (hit.runs.length === 1) {
      var run = hit.runs[0];
      var node = run.node;
      var mid = node.splitText(run.start);
      mid.splitText(run.end - run.start);
      var original = mid.data;
      var wrap = document.createElement('span');
      wrap.setAttribute('data-tdoc-sugg', id);
      var engine = window.TdocVersionDiff;
      var parts = engine ? engine.textParts(original, replace) : [{ kind: 'replace', before: original, after: replace }];
      if (engine && engine.isRewrite(parts)) {
        if (original) wrap.appendChild(suggMark('del', 'tdoc-diff-del tdoc-diff-block', id, original));
        if (replace) wrap.appendChild(suggMark('ins', 'tdoc-diff-ins tdoc-diff-block', id, replace));
      } else parts.forEach(function (p) {
        if (p.kind === 'equal') wrap.appendChild(document.createTextNode(p.before));
        else {
          if (p.before) wrap.appendChild(suggMark('del', 'tdoc-diff-del', id, p.before));
          if (p.after) wrap.appendChild(suggMark('ins', 'tdoc-diff-ins', id, p.after));
        }
      });
      mid.parentNode.replaceChild(wrap, mid);
      suggs[id] = { kind: 'one', els: [wrap], original: original, replace: replace };
      return wrap;
    }
    var els = [];
    var old = '';
    hit.runs.forEach(function (r) {
      var m = r.node.splitText(r.start);
      m.splitText(r.end - r.start);
      old += m.data;
      var del = suggMark('del', 'tdoc-diff-del', id, m.data);
      m.parentNode.replaceChild(del, m);
      els.push(del);
    });
    // Across inline elements the old words stay where they are; a rewrite's
    // new text still reads as its own block under them.
    var eng = window.TdocVersionDiff;
    var rewrite = eng && eng.isRewrite(eng.textParts(old, replace));
    var ins = suggMark('ins', rewrite ? 'tdoc-diff-ins tdoc-diff-block' : 'tdoc-diff-ins', id, replace);
    var lastDel = els[els.length - 1];
    lastDel.parentNode.insertBefore(ins, lastDel.nextSibling);
    els.push(ins);
    suggs[id] = { kind: 'many', els: els, replace: replace };
    return els[0];
  }
  function suggControlsOff() {
    Array.prototype.forEach.call(document.querySelectorAll('.tdoc-sugg-ctl'), function (n) { n.remove(); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-tdoc-sugg-active]'), function (n) { n.removeAttribute('data-tdoc-sugg-active'); });
  }
  function suggSettle(id, accepted) {
    var s = suggs[id];
    if (!s) return;
    if (suggActive === id) { suggControlsOff(); suggActive = null; }
    if (s.kind === 'one') {
      var el = s.els[0];
      if (el.parentNode) el.parentNode.replaceChild(document.createTextNode(accepted ? s.replace : s.original), el);
    } else {
      s.els.forEach(function (el) {
        if (!el.parentNode) return;
        if (el.tagName === 'INS') { if (accepted) el.parentNode.replaceChild(document.createTextNode(el.textContent), el); else el.remove(); }
        else if (accepted) el.remove();
        else el.parentNode.replaceChild(document.createTextNode(el.textContent), el);
      });
    }
    delete suggs[id];
  }
  function suggClear(ids) {
    Object.keys(suggs).forEach(function (id) { if (!ids || ids.indexOf(id) >= 0) suggSettle(id, false); });
  }
  function suggDocY(el) {
    var r = el.getBoundingClientRect();
    return r.top + (window.scrollY || 0);
  }
  function suggShow(items) {
    suggOn = true;
    suggClear();
    suggCss();
    var map = suggTextMap();
    var hits = [];
    var results = [];
    (items || []).forEach(function (item) {
      var hit = suggFind(map, item.find, true);
      if (hit) hits.push({ item: item, hit: hit });
      else results.push({ id: String(item.id), ok: false });
    });
    // Last in the text first: splitting a text node keeps the offsets before it.
    hits.sort(function (a, b) { return b.hit.at - a.hit.at; });
    var shown = [];
    hits.forEach(function (h) {
      try { shown.push({ id: String(h.item.id), el: suggRender(h.item, h.hit) }); } catch (x) { results.push({ id: String(h.item.id), ok: false }); }
    });
    // Text nobody can see (display:none, a closed details) is not offered for
    // review: Accept all must not accept what the person never saw.
    shown.forEach(function (s) {
      var seen = s.el.getClientRects().length > 0;
      if (!seen) suggSettle(s.id, false);
      results.push({ id: s.id, ok: seen, docY: seen ? suggDocY(s.el) : 0 });
    });
    rereportPins();
    post({ type: 'tdoc:suggestShown', results: results });
  }
  function suggFocus(id, scroll) {
    suggControlsOff();
    suggActive = null;
    var s = suggs[id];
    if (!s) return;
    suggActive = id;
    s.els.forEach(function (el) { el.setAttribute('data-tdoc-sugg-active', ''); });
    // Accept / Reject are the shell's (its chip and review bar): a click
    // in here could be the page's own script posting as this probe.
    var lastRect = s.els[s.els.length - 1].getBoundingClientRect();
    post({ type: 'tdoc:suggestRect', id: id, docY: lastRect.bottom + (window.scrollY || 0), left: lastRect.left, right: lastRect.right });
    if (scroll) {
      var r = s.els[0].getBoundingClientRect();
      if (r.top < 70 || r.bottom > window.innerHeight - 90) {
        try { window.scrollTo({ top: Math.max(0, (window.scrollY || 0) + r.top - window.innerHeight / 3), behavior: 'smooth' }); } catch (x) { window.scrollTo(0, Math.max(0, (window.scrollY || 0) + r.top - 120)); }
      }
    }
  }
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-tdoc-sugg]') : null;
    if (!t) return;
    var sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed) return;
    var id = t.getAttribute('data-tdoc-sugg');
    if (!suggs[id]) return;
    suggFocus(id, false);
    post({ type: 'tdoc:suggestAction', id: id, action: 'focus' });
  }, true);
  // Option (for double-tap Option: start a comment) and Esc (step back one
  // level) are the shell's keys too: a key pressed in the doc lands here, so
  // it is passed on. Not while typing in the doc, and never in Edit mode.
  document.addEventListener('keydown', function (e) {
    var key = String(e.key || '');
    if (key !== 'Alt' && key !== 'Escape') return;
    if (key === 'Escape' && (picking || gesture.pressing())) { gesture.cancel(); endPick(true); e.preventDefault(); return; }
    if (e.repeat || e.ctrlKey || e.metaKey || e.shiftKey || interactionMode === 'edit') return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(String(t.tagName || '')))) return;
    post({ type: 'tdoc:key', key: key });
  }, true);
  // ⌘K opens Ask AI (the shell decides; only where the flag is on). ⌘↵ and
  // Esc are the shell's: it takes focus when a suggestion is picked here.
  document.addEventListener('keydown', function (e) {
    if (!suggOn || interactionMode === 'edit') return;
    var mod = e.metaKey || e.ctrlKey;
    var key = String(e.key || '');
    if (mod && !e.shiftKey && !e.altKey && key.toLowerCase() === 'k') { post({ type: 'tdoc:suggestKey', key: 'k' }); e.preventDefault(); return; }
  }, true);
  var suggBusyEl = null;
  var suggPill = null;
  function suggBusy(text, label) {
    if (suggBusyEl) { suggBusyEl.removeAttribute('data-tdoc-sugg-busy'); suggBusyEl = null; }
    if (suggPill) { suggPill.remove(); suggPill = null; }
    if (!label) return;
    suggCss();
    var target = null;
    if (text) {
      var hit = suggFind(suggTextMap(), String(text).slice(0, 400), false);
      if (hit) {
        var n = hit.runs[0].node.parentElement;
        while (n && n !== document.body && !SUGG_BLOCK[String(n.tagName).toUpperCase()]) n = n.parentElement;
        target = n && n !== document.body ? n : hit.runs[0].node.parentElement;
      }
    }
    suggPill = document.createElement('div');
    suggPill.className = 'tdoc-sugg-pill';
    suggPill.setAttribute('data-tdoc-provider', '');
    suggPill.setAttribute('role', 'status');
    suggPill.textContent = String(label).slice(0, 120);
    document.body.appendChild(suggPill);
    if (target) {
      suggBusyEl = target;
      target.setAttribute('data-tdoc-sugg-busy', '');
      var r = target.getBoundingClientRect();
      suggPill.style.top = Math.max(0, r.top + (window.scrollY || 0) - 30) + 'px';
      suggPill.style.left = Math.max(8, r.left + (window.scrollX || 0)) + 'px';
      if (r.top < 60 || r.bottom > window.innerHeight) {
        try { window.scrollTo({ top: Math.max(0, (window.scrollY || 0) + r.top - 120), behavior: 'smooth' }); } catch (x) {}
      }
    } else {
      suggPill.style.position = 'fixed';
      suggPill.style.top = '12px';
      suggPill.style.left = '50%';
      suggPill.style.transform = 'translateX(-50%)';
    }
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data; if (!d || d.source !== 'tdoc-shell') return;
    if (d.type === 'tdoc:anchors') reportPins(d.comments);
    else if (d.type === 'tdoc:documentCommentsHeight') { /* old shells may still send this */ }
    else if (d.type === 'tdoc:clearPending') {
      if (HL) CSS.highlights.delete('tdoc-pending');
      // Drop the reader's own selection too. The browser paints it OVER our
      // anchor highlight, so after a comment is posted or an anchor is moved
      // the yellow would not appear until the reader happened to click away —
      // it looked as though the anchor had not moved at all.
      try { var s0 = window.getSelection(); if (s0) s0.removeAllRanges(); } catch (x0) {}
    }
    else if (d.type === 'tdoc:theme') applyTheme(d.theme);
    else if (d.type === 'tdoc:mode') setInteractionMode(d.mode, d);
    else if (d.type === 'tdoc:startPick') startPick();
    else if (d.type === 'tdoc:cancelPick') endPick(false);
    else if (d.type === 'tdoc:reanchorMode') {
      reanchorMode = !!d.active;
      document.documentElement.toggleAttribute('data-tdoc-reanchoring', reanchorMode);
      if (reanchorMode) {
        try { window.getSelection().removeAllRanges(); } catch (x) {}
      }
    }
    else if (d.type === 'tdoc:uiOpen') shellUiOpen = !!d.open;
    else if (d.type === 'tdoc:diagramApply') post({ type: 'tdoc:diagramApplied', requestId: d.requestId, ok: !!applyDiagram(d) });
    else if (d.type === 'tdoc:diagramInsert') post({ type: 'tdoc:diagramApplied', requestId: d.requestId, ok: !!insertDiagram(d) });
    else if (d.type === 'tdoc:editFormat') formatEdit(d.command, d.value);
    else if (d.type === 'tdoc:editRestore') {
      var restoreRoot = findEditRoot();
      if (restoreRoot && typeof d.bodyHtml === 'string') {
        restoreRoot.innerHTML = d.bodyHtml;
        prepareDiagrams();
        if (interactionMode === 'edit') { disableEditing(); enableEditing(); }
        var restoredHtml = draftBodyHtml();
        var restoredDirty = restoredHtml !== editBaselineHtml;
        setDirty(restoredDirty, false);
        post({ type: 'tdoc:editSnapshot', bodyHtml: restoredHtml, dirty: restoredDirty });
        refreshTableLayout();
        rereportPins();
      }
    }
    // Download (Word, CSV, Excel): the document as it is, without tdoc's UI.
    else if (d.type === 'tdoc:exportHtml') {
      post({ type: 'tdoc:exportHtml', requestId: d.requestId, html: serializeDocument() });
    }
    else if (d.type === 'tdoc:editSerialize') {
      post({ type: 'tdoc:editDocument', requestId: d.requestId, html: serializeDocument() });
    }
    else if (d.type === 'tdoc:demoRewrite') runDemoRewrite(d);
    else if (d.type === 'tdoc:demoRewriteShow') {
      if (demoRewrite) {
        var reduceShow = false;
        try { reduceShow = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (x) {}
        showDemoParagraph(demoRewrite.el, d.view, reduceShow);
      }
    }
    else if (d.type === 'tdoc:demoRewriteUndo') undoDemoRewrite();
    else if (d.type === 'tdoc:suggestShow') suggShow(d.items);
    else if (d.type === 'tdoc:suggestClear') { suggClear(Array.isArray(d.ids) ? d.ids.map(String) : null); rereportPins(); }
    else if (d.type === 'tdoc:suggestSettle') { suggSettle(String(d.id), d.accepted === true); rereportPins(); }
    else if (d.type === 'tdoc:suggestFocus') suggFocus(String(d.id), d.scroll !== false);
    else if (d.type === 'tdoc:suggestBusy') suggBusy(typeof d.text === 'string' ? d.text : null, typeof d.label === 'string' ? d.label : '');
    else if (d.type === 'tdoc:focusAnchor') setActiveAnchor(d.id, !!d.scroll);
    else if (d.type === 'tdoc:scrollTo') { try { window.scrollTo(0, Math.max(0, (d.docY || 0) - 80)); } catch (x) {} }
    else if (d.type === 'tdoc:scrollBy') { try { window.scrollBy(0, Number(d.deltaY) || 0); } catch (x) {} }
  });


  // --- tdoc's own feedback widget on this doc (feedbackDocFramePick) -------
  // The feedback widget (feedback/src/main.jsx), when it runs on a tdoc doc
  // page, lives in the shell's window above this frame and cannot see into
  // it (sandboxed, opaque origin). While it picks, it asks here what is under
  // a point, and where its comments' anchors are now, through the shared
  // selection code (TdocSelection) the doc's own picking uses.
  // Inbound: event.source === window.parent + { source:'tdoc-feedback' }; the
  // frame is served with frame-ancestors 'self', so the parent is always a
  // tdoc page. Everything goes out as data (selectors, words, rects in this
  // frame's viewport) and only to the parent; the widget treats it as
  // untrusted, since the author's own scripts share this window.
  //   widget → frame:
  //     { type:'tdoc:fbHover',   id, x, y }                → tdoc:fbHover { id, rect|null, onText }
  //     { type:'tdoc:fbPick',    id, kind:'element'|'text'|'box', x, y, x2, y2 | width, height }
  //                                                         → tdoc:fbPicked { id, anchor|null, rect|null }
  //     { type:'tdoc:fbAnchors', anchors:[{ id, selector, tag, text, container, quote, region }] }
  //                                                         → tdoc:fbPlaces { places:[{ id, rect }] } (again on scroll/resize)
  //     { type:'tdoc:fbReveal',  id }   { type:'tdoc:fbScroll', dx, dy }   { type:'tdoc:fbClear' }
  //   ids are the widget's per-page tokens, not comment ids.
  var fbState = { anchors: [], resolved: [], ticking: false, lastPlaces: '' };
  function fbNum(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function fbRect(r) { return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; }
  function fbExclude(el) { return isProbeUI(el); }
  function fbPickable(el) { return el && el !== document.body && el !== document.documentElement && !isProbeUI(el) ? el : null; }
  function fbDescribe(el) {
    var d = TS.describeElement(el);
    var out = { selector: hookCall('selector', el) || d.selector || cssPath(el) || el.localName, tag: d.tag, text: d.text, accessible_name: d.accessible_name };
    if (d.container) out.container = d.container;
    if (d.container_is_target) out.container_is_target = true;
    var r = el.getBoundingClientRect();
    out.rect = { x: Math.round(r.left + (window.scrollX || 0)), y: Math.round(r.top + (window.scrollY || 0)), width: Math.round(r.width), height: Math.round(r.height) };
    return out;
  }
  function fbHover(d) {
    var x = fbNum(d.x), y = fbNum(d.y);
    var el = fbPickable(frameElementAt(x, y));
    post({ type: 'tdoc:fbHover', id: String(d.id || ''), rect: el ? fbRect(clipRect(visibleFor(el))) : null, onText: frameStartsOnText(x, y) });
  }
  function fbPick(d) {
    var x = fbNum(d.x), y = fbNum(d.y), anchor = null, rect = null;
    if (d.kind === 'text') {
      var range = TS.rangeBetweenPoints({ x: x, y: y }, { x: fbNum(d.x2), y: fbNum(d.y2) });
      var holder = range ? range.commonAncestorContainer : null;
      if (holder && holder.nodeType === 3) holder = holder.parentElement;
      holder = fbPickable(holder) || (range ? document.body : null);
      var quote = holder ? TS.captureTextAnchor(range, TS.collectTextNodes(holder, fbExclude)) : null;
      if (quote) {
        anchor = fbDescribe(holder);
        anchor.quote = quote;
        rect = selectionRect(range);
        if (HL) { try { CSS.highlights.set('tdoc-pending', new Highlight(range.cloneRange())); } catch (e) {} }
      }
    } else if (d.kind === 'box') {
      var box = TS.toRect({ left: x, top: y, width: Math.max(0, fbNum(d.width)), height: Math.max(0, fbNum(d.height)) });
      var container = TS.enclosingFor(box, frameElementAt);
      // A box in the page's margin is not inside <body> (a centred column):
      // it is measured against the whole page.
      if (container === document.body && !TS.rectContains(document.body.getBoundingClientRect(), box)) container = document.documentElement;
      if (container) {
        anchor = TS.regionOf(box, container, { exclude: fbExclude, describe: fbDescribe });
        if (/ · (html|body)$/.test(anchor.label || '')) anchor.label = anchor.label.replace(/ · (html|body)$/, ' · page');
        rect = box;
      }
    }
    if (!anchor) {
      var el = fbPickable(frameElementAt(x, y));
      if (el) { anchor = fbDescribe(el); rect = clipRect(visibleFor(el)); }
    }
    post({ type: 'tdoc:fbPicked', id: String(d.id || ''), anchor: anchor, rect: fbRect(rect) });
  }
  // Each anchor found once (and again when the doc changes), measured on
  // every scroll.
  function fbResolve() {
    fbState.resolved = fbState.anchors.map(function (a) {
      var el = null, range = null;
      try { el = resolveElementAnchor(a).element; } catch (e) { el = null; }
      if (a.quote) {
        try { range = TS.findTextRange(a.quote, TS.collectTextNodes(el || document.body, fbExclude)); } catch (e) { range = null; }
        if (!range && el) { try { range = TS.findTextRange(a.quote, TS.collectTextNodes(document.body, fbExclude)); } catch (e) { range = null; } }
      }
      return { id: a.id, anchor: a, el: el, range: range };
    });
    if (HL) {
      var ranges = fbState.resolved.filter(function (r) { return r.range; }).map(function (r) { return r.range; });
      try {
        if (!ranges.length) CSS.highlights.delete('tdoc-fb-quote');
        else { var h = new Highlight(); ranges.forEach(function (r) { h.add(r); }); CSS.highlights.set('tdoc-fb-quote', h); }
      } catch (e) {}
    }
    fbPlaces();
  }
  function fbPlaces() {
    var places = [];
    fbState.resolved.forEach(function (r) {
      var rect = null;
      if (r.range) rect = r.range.getBoundingClientRect();
      else if (r.el && r.anchor.region) rect = TS.regionRect(r.anchor, visibleFor(r.el));
      else if (r.el && !r.anchor.quote) rect = clipRect(visibleFor(r.el));
      if (rect && (rect.width || rect.height)) places.push({ id: r.id, rect: fbRect(rect) });
    });
    // Nothing moved, nothing said.
    var key = JSON.stringify(places);
    if (key === fbState.lastPlaces) return;
    fbState.lastPlaces = key;
    post({ type: 'tdoc:fbPlaces', places: places });
  }
  function fbSchedule() {
    if (!fbState.anchors.length || fbState.ticking) return;
    fbState.ticking = true;
    requestAnimationFrame(function () { fbState.ticking = false; fbPlaces(); });
  }
  window.addEventListener('scroll', fbSchedule, { passive: true });
  window.addEventListener('resize', fbSchedule);
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data; if (!d || typeof d !== 'object' || d.source !== 'tdoc-feedback') return;
    if (d.type === 'tdoc:fbHover') fbHover(d);
    else if (d.type === 'tdoc:fbPick') fbPick(d);
    else if (d.type === 'tdoc:fbAnchors') {
      fbState.anchors = (Array.isArray(d.anchors) ? d.anchors : []).slice(0, 500).filter(function (a) { return a && typeof a === 'object' && a.id; });
      fbState.lastPlaces = '';
      fbResolve();
    }
    else if (d.type === 'tdoc:fbReveal') {
      var hit = fbState.resolved.filter(function (r) { return r.id === d.id; })[0];
      var target = hit && (hit.range || hit.el);
      if (target) {
        var r = target.getBoundingClientRect();
        try { window.scrollTo(0, Math.max(0, (window.scrollY || 0) + r.top - window.innerHeight / 3)); } catch (x) {}
      }
    }
    else if (d.type === 'tdoc:fbScroll') { try { window.scrollBy(fbNum(d.dx), fbNum(d.dy)); } catch (x) {} }
    else if (d.type === 'tdoc:fbClear') { if (HL) CSS.highlights.delete('tdoc-pending'); }
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

  // What Download offers: a sheet doc (only sheet tables, a title and a
  // note) downloads as CSV / Excel; a doc with prose, as Word and Markdown.
  function docShape() {
    var sheets = Array.prototype.filter.call(document.querySelectorAll('table[data-tdoc-sheet]'), function (t) { return !t.closest('[data-tdoc-provider]'); });
    if (!sheets.length || !document.body) return { sheets: 0, sheetDoc: false };
    var clone = document.body.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('[data-tdoc-provider], table[data-tdoc-sheet], script, style, template, noscript, h1, .sheet-note'), function (n) { n.remove(); });
    var prose = (clone.textContent || '').replace(/\s+/g, '');
    var media = clone.querySelector('img, svg, canvas, video, iframe, table');
    return { sheets: sheets.length, sheetDoc: !prose && !media };
  }
  prepareDiagrams();
  var shape = docShape();
  post({ type: 'tdoc:ready', height: document.documentElement.scrollHeight, supportsTheme: supportsTheme, defaultTheme: document.documentElement.getAttribute('data-tdoc-default-theme') || null, sheets: shape.sheets, sheetDoc: shape.sheetDoc });
  reportScroll(); // initial position so the shell can evaluate at-bottom for short docs
})();
