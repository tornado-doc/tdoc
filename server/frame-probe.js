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
(function () {
  'use strict';
  function post(msg) {
    try { window.parent.postMessage(Object.assign({ source: 'tdoc-frame' }, msg), '*'); } catch (e) {}
  }
  var HL = !!(window.CSS && CSS.highlights && window.Highlight);
  if (HL) {
    var st = document.createElement('style');
    st.textContent = '::highlight(tdoc-anchor){background:rgba(255,214,0,.38);} ::highlight(tdoc-pending){background:rgba(255,214,0,.55);}';
    (document.head || document.documentElement).appendChild(st);
  }
  // Element-comment affordances live IN the frame (they hug author artifacts).
  // Colors are inlined (the frame has no :root chrome tokens); look matches the
  // overlay's .tdoc-hover-outline / .tdoc-comment-pill.
  (function () {
    var s = document.createElement('style');
    s.textContent =
      '.tdoc-hover-outline{position:absolute;pointer-events:none;z-index:2147483644;border:2px dashed #4f46e5;border-radius:4px;background:rgba(79,70,229,.08);box-sizing:border-box;}' +
      '.tdoc-comment-pill{position:absolute;z-index:2147483645;width:30px;height:30px;padding:0;background:rgba(255,255,255,.96);color:#4f46e5;border:1px solid #dedee3;border-radius:999px;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.06),0 3px 10px rgba(0,0,0,.08);display:inline-flex;align-items:center;justify-content:center;line-height:1;}' +
      '.tdoc-comment-pill:hover{background:#4f46e5;color:#fff;border-color:#4f46e5;}' +
      '.tdoc-comment-pill svg{width:14px;height:14px;stroke:currentColor;}';
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
    // Paint the pending anchor so it stays visibly marked while the composer
    // (in the shell document) has focus; cleared on cancel/close (#281 parity).
    if (HL) { try { CSS.highlights.set('tdoc-pending', new Highlight(range.cloneRange())); } catch (e) {} }
    post({ type: 'tdoc:selection', text: text, context_before: ctx.before, context_after: ctx.after, rect: selectionRect(range) });
  }
  // Links: a click inside the sandboxed frame would navigate the FRAME (nested
  // shell / 404), not the page. Intercept and hand navigation to the shell,
  // which navigates the top document (or opens a tab for target=_blank).
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;                    // in-page anchors stay in the frame
    if (!/^(https?:\/\/|\/(?!\/))/i.test(href)) return;             // javascript:/data: etc. — let CSP kill them
    e.preventDefault(); e.stopPropagation();
    post({ type: 'tdoc:navigate', href: href, blank: a.getAttribute('target') === '_blank' });
  }, true);

  document.addEventListener('mouseup', function () { setTimeout(reportSelection, 0); }, true);
  document.addEventListener('touchend', function () { setTimeout(reportSelection, 0); }, true);
  document.addEventListener('mousedown', function (e) {
    // Clicking our own comment pill must not fire the clear (it opens the
    // composer) — everything else in the doc clears the shell's open UI.
    if (e.target && e.target.closest && e.target.closest('.tdoc-comment-pill')) return;
    if (HL) CSS.highlights.delete('tdoc-pending');
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
    hoverPill.setAttribute('aria-label', 'Comment on this');
    hoverPill.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
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
    var nodes = [], total = '', norm = '', normToRaw = [], prevWasSpace = false;
    while (walker.nextNode()) {
      var n = walker.currentNode, start = total.length, v = n.nodeValue;
      nodes.push({ node: n, start: start, end: start + v.length });
      total += v;
      for (var i = 0; i < v.length; i++) {
        var ch = v.charCodeAt(i);
        var isWs = ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d || ch === 0xa0;
        if (isWs) { if (!prevWasSpace && norm.length) { norm += ' '; normToRaw.push(start + i); prevWasSpace = true; } }
        else { norm += v[i]; normToRaw.push(start + i); prevWasSpace = false; }
      }
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
  function findTextRange(anchor, view) {
    if (!anchor || !anchor.text || anchor.text.length < 2 || !view.norm) return null;
    var needleN = normalizeNeedle(anchor.text); if (needleN.length < 2) return null;
    var hits = [];
    for (var i = 0; (i = view.norm.indexOf(needleN, i)) !== -1; i += Math.max(1, needleN.length)) { hits.push(i); if (hits.length > 64) break; }
    if (!hits.length) return null;
    if (hits.length === 1) return rangeFromNorm(view, hits[0], needleN.length); // unique → accept
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
    return (bestIdx === -1 || bestScore === 0) ? null : rangeFromNorm(view, bestIdx, needleN.length);
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
  var _view = null, _rangeCache = {};
  var _lastComments = [];   // re-report pins when layout settles (images/fonts)
  function docView() { return _view || (_view = collectTextNodes()); }
  function reportPins(comments) {
    _lastComments = comments || [];
    var pins = [], hl = HL ? new Highlight() : null;
    (comments || []).forEach(function (c) {
      if (!c || !c.anchor) return;
      if (c.anchor.kind === 'element' && c.anchor.selector) {
        var eel = null; try { eel = document.querySelector(c.anchor.selector); } catch (x) {}
        if (eel) {
          var er = eel.getBoundingClientRect();
          pins.push({ id: c.id, docY: er.top + (window.scrollY || 0), elementKey: c.anchor.selector, elementTop: er.top + (window.scrollY || 0), elementHeight: er.height, login: (c.author && c.author.login) || null, avatar_url: (c.author && c.author.avatar_url) || null, kind: (c.author && c.author.kind) || null, resolved: c.status === 'applied' });
        }
        return;
      }
      if (c.anchor.kind !== 'text') return;
      var key = (c.anchor.text || '') + '\u0000' + (c.anchor.context_before || '') + '\u0000' + (c.anchor.context_after || '');
      var r = (key in _rangeCache) ? _rangeCache[key] : (_rangeCache[key] = findTextRange(c.anchor, docView()));
      if (!r) return;
      if (hl) hl.add(r);
      var rect = r.getBoundingClientRect();
      pins.push({ id: c.id, docY: rect.top + (window.scrollY || 0), login: (c.author && c.author.login) || null, avatar_url: (c.author && c.author.avatar_url) || null, kind: (c.author && c.author.kind) || null, resolved: c.status === 'applied' });
    });
    if (HL) CSS.highlights.set('tdoc-anchor', hl);
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
    else if (d.type === 'tdoc:clearPending') {
      if (HL) CSS.highlights.delete('tdoc-pending');
      // Drop the reader's own selection too. The browser paints it OVER our
      // anchor highlight, so after a comment is posted or an anchor is moved
      // the yellow would not appear until the reader happened to click away —
      // it looked as though the anchor had not moved at all.
      try { var s0 = window.getSelection(); if (s0) s0.removeAllRanges(); } catch (x0) {}
    }
    else if (d.type === 'tdoc:theme') applyTheme(d.theme);
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
