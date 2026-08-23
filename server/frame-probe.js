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
          var cells = function (r) { return Array.prototype.map.call(r.children, function (c) { return walk(c, ctx).trim().replace(/\|/g, '\\|'); }); };
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
    if (!themeStyle) {
      themeStyle = document.createElement('style');
      themeStyle.textContent = 'html[data-tdoc-theme="dark"]{color-scheme:dark;background:#fff;filter:invert(1) hue-rotate(180deg);}html[data-tdoc-theme="dark"] button,html[data-tdoc-theme="dark"] input,html[data-tdoc-theme="dark"] select,html[data-tdoc-theme="dark"] textarea{color-scheme:light;}html[data-tdoc-theme="dark"] img:not([data-tdoc-dark="invert"]),html[data-tdoc-theme="dark"] video:not([data-tdoc-dark="invert"]),html[data-tdoc-theme="dark"] canvas:not([data-tdoc-dark="invert"]),html[data-tdoc-theme="dark"] iframe:not([data-tdoc-dark="invert"]){filter:invert(1) hue-rotate(180deg);}';
      (document.head || document.documentElement).appendChild(themeStyle);
    }
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data; if (!d || d.source !== 'tdoc-shell') return;
    if (d.type === 'tdoc:anchors') reportPins(d.comments);
    else if (d.type === 'tdoc:theme') applyTheme(d.theme);
    else if (d.type === 'tdoc:scrollTo') { try { window.scrollTo(0, Math.max(0, (d.docY || 0) - 80)); } catch (x) {} }
    else if (d.type === 'tdoc:copyDoc') {
      var clone = document.body.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll('script, style, noscript'), function (n) { n.remove(); });
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

  post({ type: 'tdoc:ready', height: document.documentElement.scrollHeight });
  reportScroll(); // initial position so the shell can evaluate at-bottom for short docs
})();
