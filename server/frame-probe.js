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
//     { type:'tdoc:pins',      pins:[{id,docY,login}], scrollY }
//   shell → frame:
//     { type:'tdoc:anchors',   comments:[...] }   // resolve → highlight → report pins
//     { type:'tdoc:scrollTo',  docY }
(function () {
  'use strict';
  function post(msg) {
    try { window.parent.postMessage(Object.assign({ source: 'tdoc-frame' }, msg), '*'); } catch (e) {}
  }
  var HL = !!(window.CSS && CSS.highlights && window.Highlight);
  if (HL) {
    var st = document.createElement('style');
    st.textContent = '::highlight(tdoc-anchor){background:rgba(255,214,0,.38);}';
    (document.head || document.documentElement).appendChild(st);
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
  function context(range, chars) {
    try {
      var before = (range.startContainer.textContent || '').slice(Math.max(0, range.startOffset - chars), range.startOffset);
      var after = (range.endContainer.textContent || '').slice(range.endOffset, range.endOffset + chars);
      return { before: before, after: after };
    } catch (e) { return { before: '', after: '' }; }
  }
  function reportSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    var text = sel.toString().trim();
    if (!text) return;
    var range = sel.getRangeAt(0);
    var ctx = context(range, 60);
    post({ type: 'tdoc:selection', text: text, context_before: ctx.before, context_after: ctx.after, rect: selectionRect(range) });
  }
  document.addEventListener('mouseup', function () { setTimeout(reportSelection, 0); }, true);
  document.addEventListener('touchend', function () { setTimeout(reportSelection, 0); }, true);
  document.addEventListener('mousedown', function () { post({ type: 'tdoc:cleared' }); }, true);

  // --- anchor resolution (minimal port of overlay.js collectTextNodes/findTextRange) ---
  function collectText() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var nodes = [], text = '', node;
    while ((node = walker.nextNode())) {
      var t = node.nodeValue || '';
      if (!t) continue;
      nodes.push({ node: node, start: text.length, len: t.length });
      text += t;
    }
    return { nodes: nodes, text: text };
  }
  function locate(model, off) {
    for (var i = 0; i < model.nodes.length; i++) {
      var n = model.nodes[i];
      if (off <= n.start + n.len) return { node: n.node, offset: Math.max(0, off - n.start) };
    }
    var last = model.nodes[model.nodes.length - 1];
    return last ? { node: last.node, offset: last.len } : null;
  }
  function rangeFor(model, anchor) {
    var needle = anchor && anchor.text;
    if (!needle) return null;
    var hay = model.text, before = anchor.context_before || '', best = -1, idx = -1, from = 0;
    while ((idx = hay.indexOf(needle, from)) !== -1) {
      if (best === -1) best = idx;
      if (before && hay.slice(Math.max(0, idx - before.length), idx) === before) { best = idx; break; }
      from = idx + 1;
    }
    if (best === -1) return null;
    var a = locate(model, best), b = locate(model, best + needle.length);
    if (!a || !b) return null;
    try { var r = document.createRange(); r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); return r; }
    catch (e) { return null; }
  }
  function reportPins(comments) {
    var model = collectText(), pins = [], hl = HL ? new Highlight() : null;
    (comments || []).forEach(function (c) {
      if (!c || !c.anchor || c.anchor.kind !== 'text') return;
      var r = rangeFor(model, c.anchor);
      if (!r) return;
      if (hl) hl.add(r);
      var rect = r.getBoundingClientRect();
      pins.push({ id: c.id, docY: rect.top + (window.scrollY || 0), login: (c.author && c.author.login) || null });
    });
    if (HL) CSS.highlights.set('tdoc-anchor', hl);
    post({ type: 'tdoc:pins', pins: pins, scrollY: window.scrollY || 0 });
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data; if (!d || d.source !== 'tdoc-shell') return;
    if (d.type === 'tdoc:anchors') reportPins(d.comments);
    else if (d.type === 'tdoc:scrollTo') { try { window.scrollTo(0, Math.max(0, (d.docY || 0) - 80)); } catch (x) {} }
  });

  // --- scroll sync ---------------------------------------------------------
  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return; ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      post({ type: 'tdoc:scroll', scrollY: window.scrollY || window.pageYOffset || 0, height: document.documentElement.scrollHeight });
    });
  }, { passive: true });

  post({ type: 'tdoc:ready', height: document.documentElement.scrollHeight });
})();
