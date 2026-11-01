// Comparison runs only in disposable, sandboxed reader frames. The normal
// reader's comments, editor, stored source and widgets are never mutated.
(function () {
  'use strict';
  if (new URLSearchParams(location.search).get('tdoc_compare') !== '1') return;
  var engine = window.TdocVersionDiff, model, elements = [], applied = false;
  var maxBytes = 2000000, maxUnits = 2000, changes = [], controlled = [];
  var scrollAnchors = [], scrollTick = 0, followedScroll = null;
  var css = document.createElement('style');
  css.dataset.tdocProvider = '';
  css.textContent = '[data-tdoc-change="add"]{background:rgba(37,168,91,.16)!important;outline:1px solid rgba(37,168,91,.48);outline-offset:2px}'+
    '[data-tdoc-change="delete"]{background:rgba(219,58,75,.13)!important;outline:1px solid rgba(219,58,75,.42);outline-offset:2px}'+
    '[data-tdoc-change="modify"]{outline:2px solid #c18b1d;outline-offset:3px}'+
    '.tdoc-diff-ins{text-decoration:none;background:rgba(37,168,91,.16)!important;padding:1px 2px}.tdoc-diff-del{text-decoration:line-through;background:rgba(219,58,75,.13)!important;padding:1px 2px;margin-inline-end:.15em}'+
    'td>.tdoc-diff-del,td>.tdoc-diff-ins{display:block}'+
    '.tdoc-diff-label{display:block!important;font:12px/1.5 system-ui!important;margin:8px 0!important;color:inherit!important;opacity:.8}'+
    '.tdoc-diff-label button{font:inherit;color:inherit;text-decoration:underline;border:0;background:none;padding:0;cursor:pointer}'+
    '[data-tdoc-diagram-open],.tdoc-comment-pill,.tdoc-hover-outline{display:none!important}'+
    'iframe{pointer-events:none!important}html{scroll-behavior:auto!important}';
  document.head.appendChild(css);
  function post(data) { parent.postMessage(Object.assign({ source: 'tdoc-compare' }, data), '*'); }
  function norm(s) { return s.replace(/\s+/g, ' ').trim(); }
  function key(el) { return el.id || el.getAttribute('data-aid') || ''; }
  function label(el, message, previousAnchor) {
    var note = document.createElement('span'); note.className = 'tdoc-diff-label';
    note.dataset.tdocProvider = ''; note.textContent = message;
    if (previousAnchor !== undefined) {
      var link = document.createElement('button'); link.type = 'button'; link.textContent = 'View previous';
      link.addEventListener('click', function() { post({type:'previous',anchor:previousAnchor}); });
      note.append(' · ',link);
    }
    el.before(note);
  }
  function cleanClone(el) {
    var clone = el.cloneNode(true);
    clone.querySelectorAll('[data-tdoc-provider],script,style,noscript').forEach(function (n) { n.remove(); });
    return clone;
  }
  function collect() {
    var root = document.querySelector('[data-tdoc-content],article,main,.wrap') || document.body;
    var selector = 'h1,h2,h3,h4,h5,h6,p,li,pre,table,svg,img,iframe,video,canvas,blockquote,figcaption';
    elements = [];
    function visit(el) {
      if (el.matches('[data-tdoc-provider],script,style,nav,noscript')) return;
      if (el.matches(selector) || Array.from(el.childNodes).some(function (n) { return n.nodeType === 3 && norm(n.textContent); })) { elements.push(el); return; }
      Array.from(el.children).forEach(visit);
    }
    Array.from(root.children).forEach(visit);
    if (elements.length > maxUnits) throw new Error('This document has too many blocks for detailed comparison.');
    var units = elements.map(function (el) {
      var clone = cleanClone(el), tag = el.localName;
      var assets = (el.matches('img,iframe,video,source,image,use') ? [el] : []).concat(Array.from(el.querySelectorAll('img,iframe,video,source,image,use'))).map(function(n) {
        var src = n.getAttribute('src') || n.getAttribute('href') || n.getAttribute('xlink:href') || '';
        if (!src || src[0] === '#' || src.startsWith('data:')) return '';
        try { return new URL(src,document.baseURI).href; } catch (_) { return src; }
      }).filter(Boolean);
      return { kind: tag, key: key(el), text: clone.textContent || '', tree: treeOf(inertCopy(clone)), rowKeys: tag === 'table' ? Array.from(el.rows).map(key) : null, svg: tag === 'svg' ? svgModel(clone) : null, fingerprint: clone.outerHTML + assets.join('\n'), external: assets.length > 0 };
    });
    var keys = new Map();
    units.forEach(function(u) { if (u.key) keys.set(u.key,(keys.get(u.key)||0)+1); });
    units.forEach(function(u) { if (keys.get(u.key)>1) u.key=''; });
    if (JSON.stringify(units).length > maxBytes) throw new Error('This document is too large for detailed comparison.');
    var duration = 0, unsupported = !!root.querySelector('iframe,canvas,video,img[src$=".gif"]');
    var animations = document.getAnimations ? document.getAnimations().filter(function (a) { return !a.effect?.target?.closest('[data-tdoc-provider]'); }) : [];
    controlled = [];
    animations.forEach(function (a) {
      try {
        a.pause(); a.currentTime = 0;
        var t = a.effect.getComputedTiming(), length = t.endTime;
        if (!Number.isFinite(length)) { unsupported = true; return; }
        controlled.push(a); duration = Math.max(duration, length / 1000);
      } catch (_) { unsupported = true; }
    });
    // SMIL and JS/widget timelines cannot be controlled by the WAAPI clock.
    root.querySelectorAll('svg').forEach(function (s) { if (s.querySelector('animate,animateMotion,animateTransform,set')) { unsupported = true; s.pauseAnimations?.(); } });
    return { units: units, duration: Math.min(duration, 120), limited: duration > 120, external: units.some(function(u) { return u.external; }), animationCount: controlled.length, unsupported: unsupported,
      styles: Array.from(document.querySelectorAll('style:not([data-tdoc-provider])')).map(function (s) { return s.textContent; }).join('\n').slice(0, maxBytes) };
  }
  function mark(el, kind) {
    el.setAttribute('data-tdoc-change', kind); changes.push(el);
  }
  function rangeAt(el, start, end) {
    var walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), node, offset = 0, range = document.createRange(), found = false;
    while ((node = walk.nextNode())) {
      if (node.parentElement?.closest('[data-tdoc-provider],script,style')) continue;
      var next = offset + node.textContent.length;
      if (!found && start <= next) { range.setStart(node, Math.max(0, start - offset)); found = true; }
      if (found && end <= next) { range.setEnd(node, Math.max(0, end - offset)); return range; }
      offset = next;
    }
    return null;
  }
  function textDiff(el, oldText, newText, side, inline) {
    if (inline && !newText && oldText) { var removed = document.createElement('del'); removed.className = 'tdoc-diff-del'; removed.textContent = oldText; el.append(removed); changes.push(el); return; }
    var parts = engine.textParts(oldText, newText), offset = 0, edits = [];
    parts.forEach(function (p) {
      var text = side === 'before' ? p.before : p.after;
      if (p.kind !== 'equal') edits.push({ start: offset, end: offset + text.length, old: p.before });
      offset += text.length;
    });
    edits.reverse().forEach(function (edit) {
      var range = rangeAt(el, edit.start, edit.end); if (!range) return;
      var fragment = document.createDocumentFragment();
      if (inline && edit.old) { var del = document.createElement('del'); del.className = 'tdoc-diff-del'; del.textContent = edit.old; fragment.append(del); }
      if (edit.end > edit.start) {
        var span = document.createElement(side === 'before' ? 'del' : 'ins');
        span.className = side === 'before' ? 'tdoc-diff-del' : 'tdoc-diff-ins'; span.append(range.extractContents()); fragment.append(span);
      }
      range.insertNode(fragment);
    });
    changes.push(el);
  }
  // Historical markup is never inserted as HTML. Rebuild a deliberately
  // narrow inert vocabulary, with no URLs, IDs, scripts or event attributes.
  function inertCopy(source) {
    if (source.nodeType === Node.TEXT_NODE) return document.createTextNode(source.textContent);
    if (source.nodeType !== Node.ELEMENT_NODE) return document.createTextNode('');
    if (/^(script|style|iframe|object|embed|svg|img|video|audio|canvas|input|button|form|link|meta)$/i.test(source.localName)) {
      return document.createTextNode('[Previous ' + source.localName + ' — view previous version]');
    }
    var tag = /^(p|div|span|h[1-6]|strong|em|b|i|code|pre|blockquote|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|br|figcaption|figure)$/.test(source.localName) ? source.localName : 'span';
    var copy = document.createElement(tag);
    if (/^(td|th)$/.test(tag)) ['colspan','rowspan'].forEach(function (a) { if (/^\d{1,3}$/.test(source.getAttribute(a) || '')) copy.setAttribute(a, source.getAttribute(a)); });
    source.childNodes.forEach(function (child) { copy.append(inertCopy(child)); }); return copy;
  }
  // Exchange an inert node description, never HTML to be parsed at a sink.
  function treeOf(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    return { tag: node.localName, children: Array.from(node.childNodes).map(treeOf),
      colspan: node.getAttribute('colspan'), rowspan: node.getAttribute('rowspan') };
  }
  function nodeOf(tree) {
    if (typeof tree === 'string') return document.createTextNode(tree);
    var tag = /^(p|div|span|h[1-6]|strong|em|b|i|code|pre|blockquote|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|br|figcaption|figure)$/.test(tree?.tag) ? tree.tag : 'span';
    var node = document.createElement(tag);
    if (/^(td|th)$/.test(tag)) ['colspan','rowspan'].forEach(function(a) { if (/^\d{1,3}$/.test(tree[a] || '')) node.setAttribute(a,tree[a]); });
    (Array.isArray(tree?.children) ? tree.children : []).forEach(function(child) { node.append(nodeOf(child)); });
    return node;
  }
  function peerElement(unit) {
    var node = nodeOf(unit.tree);
    if (node.localName === 'table' && Array.isArray(unit.rowKeys)) Array.from(node.rows).forEach(function(row,i) { if (typeof unit.rowKeys[i] === 'string') row.setAttribute('data-aid',unit.rowKeys[i]); });
    return node;
  }
  function svgModel(el) {
    var drawing = 'path,rect,circle,ellipse,line,polyline,polygon,text,use,image';
    return { complete: Array.from(el.querySelectorAll(drawing)).every(function(n) { return !!key(n); }),
      nodes: Array.from(el.querySelectorAll('[id],[data-aid]')).map(function(n) { return { key:key(n), markup:n.outerHTML }; }) };
  }
  function descriptor(el, type, k) { return { kind: type, key: k || '', fingerprint: norm(el.textContent) }; }
  function tableDiff(el, other, side, inline) {
    var oldTable = side === 'before' ? el : other, newTable = side === 'after' ? el : other;
    // Spanning/complex tables have no unambiguous rectangular cell mapping.
    if (oldTable.querySelector('[rowspan],[colspan],table') || newTable.querySelector('[rowspan],[colspan],table')) return false;
    var oldRows = Array.from(oldTable.rows), newRows = Array.from(newTable.rows);
    var headers = function (rows) { return rows[0] && Array.from(rows[0].cells).every(function (c) { return c.tagName === 'TH'; }) ? Array.from(rows[0].cells) : null; };
    var ah = headers(oldRows), bh = headers(newRows); if (!ah || !bh) return false;
    function unique(values) { return values.every(Boolean) && new Set(values).size === values.length; }
    var akeys = ah.map(function (c) { return norm(c.textContent); }), bkeys = bh.map(function (c) { return norm(c.textContent); });
    var ar = oldRows.slice(1).map(function (r) { return key(r) || norm(r.cells[0]?.textContent || ''); });
    var br = newRows.slice(1).map(function (r) { return key(r) || norm(r.cells[0]?.textContent || ''); });
    if (!unique(akeys) || !unique(bkeys) || !unique(ar) || !unique(br)) return false;
    var cols = engine.align(ah.map(function (c,i) { return descriptor(c,'col',akeys[i]); }), bh.map(function (c,i) { return descriptor(c,'col',bkeys[i]); }));
    var rows = engine.align(oldRows.map(function (r,i) { return descriptor(r,'row',i === 0 ? '__header' : ar[i-1]); }), newRows.map(function (r,i) { return descriptor(r,'row',i === 0 ? '__header' : br[i-1]); }));
    rows.forEach(function (p, index) {
      var a = p.before === null ? null : oldRows[p.before], b = p.after === null ? null : newRows[p.after], own = side === 'before' ? a : b;
      if (!a || !b) {
        if (own) {
          mark(own, a ? 'delete' : 'add');
          if (inline && b) {
            var existing = Array.from(b.cells);
            cols.forEach(function (c,ci) { if (c.after === null) { var blank = document.createElement('td'); blank.textContent = '—'; var following = cols.slice(ci+1).find(function(v) { return v.after !== null; }); if (following) existing[following.after].before(blank); else b.append(blank); } });
          }
        }
        else if (inline && a) {
          var next = rows.slice(index+1).find(function (r) { return r.after !== null; });
          var copy = document.createElement('tr');
          cols.forEach(function(c) { if (c.before !== null && a.cells[c.before]) copy.append(inertCopy(a.cells[c.before])); else { var blank=document.createElement('td'); blank.textContent='—'; copy.append(blank); } });
          mark(copy, 'delete');
          if (next) newRows[next.after].before(copy); else (el.tBodies[0] || el).append(copy);
        }
        return;
      }
      var ac = Array.from(a.cells), bc = Array.from(b.cells);
      cols.forEach(function (c, ci) {
        var x = c.before === null ? null : ac[c.before], y = c.after === null ? null : bc[c.after], cell = side === 'before' ? x : y;
        if (!x || !y) {
          if (cell) mark(cell, x ? 'delete' : 'add');
          else if (inline && x) { var clone = inertCopy(x), after = cols.slice(ci+1).find(function (v) { return v.after !== null; }); mark(clone,'delete'); if (after && bc[after.after]) bc[after.after].before(clone); else b.append(clone); }
        } else if (x.textContent !== y.textContent) textDiff(cell,x.textContent,y.textContent,side,inline);
      });
    });
    return true;
  }
  function svgDiff(el, ownModel, peerModel, side) {
    if (!ownModel?.complete || !peerModel?.complete || !ownModel.nodes.length || !peerModel.nodes.length) return false;
    var ownKeys = new Set(ownModel.nodes.map(function(n) { return n.key; }));
    var peers = new Map(peerModel.nodes.map(function(n) { return [n.key,n.markup]; }));
    if (ownKeys.size !== ownModel.nodes.length || peers.size !== peerModel.nodes.length) return false;
    var originals = new Map(ownModel.nodes.map(function(n) { return [n.key,n.markup]; }));
    el.querySelectorAll('[id],[data-aid]').forEach(function(node) {
      var peer = peers.get(key(node));
      if (peer === undefined) mark(node,side === 'before' ? 'delete' : 'add');
      else if (originals.get(key(node)) !== peer) mark(node,'modify');
    });
    return true;
  }
  // The shared block order provides a position independent of each version's
  // pixel height. Insertions stretch the space between the surrounding anchors.
  function scrollPoints() {
    var max = Math.max(0, document.documentElement.scrollHeight - innerHeight), last = 0;
    return [0].concat(scrollAnchors.map(function(el) {
      last = Math.max(last, Math.min(max, el.getBoundingClientRect().top + scrollY));
      return last;
    }), [max]);
  }
  function scrollPosition(points) {
    var y = Math.max(0, scrollY), end = points.length - 1;
    if (y <= 0) return 0;
    if (y >= points[end] - 1) return end;
    var i = 0;
    while (i < end - 1 && points[i + 1] <= y) i++;
    return i + (y - points[i]) / Math.max(1, points[i + 1] - points[i]);
  }
  addEventListener('scroll', function() {
    if (!applied) return;
    if (followedScroll !== null) {
      var following = Math.abs(scrollY - followedScroll) < 1;
      followedScroll = null;
      if (following) return;
    }
    if (!scrollTick) scrollTick = requestAnimationFrame(function() {
      scrollTick = 0;
      post({type:'scroll', position:scrollPosition(scrollPoints())});
    });
  }, {passive:true});
  function followScroll(position) {
    if (!applied) return;
    cancelAnimationFrame(scrollTick); scrollTick = 0;
    var points = scrollPoints(), end = points.length - 1;
    var p = Math.max(0, Math.min(end, position)), i = Math.min(end - 1, Math.floor(p));
    scrollTo(0, points[i] + (points[i + 1] - points[i]) * (p - i));
    // Suppress only the resulting scroll event, not subsequent user input.
    followedScroll = scrollY;
  }
  function apply(peer, side, inline) {
    if (applied) return; applied = true;
    if (!peer || !Array.isArray(peer.units) || peer.units.length > maxUnits || JSON.stringify(peer).length > maxBytes * 3) throw new Error('Comparison data is unavailable.');
    var before = side === 'before' ? model.units : peer.units, after = side === 'after' ? model.units : peer.units;
    var pairs = engine.align(before, after), count = 0, trailingCopy = null;
    scrollAnchors = pairs.filter(function(p) { return p.before !== null && p.after !== null; })
      .map(function(p) { return elements[side === 'before' ? p.before : p.after]; });
    pairs.forEach(function (p, index) {
      var a = p.before === null ? null : before[p.before], b = p.after === null ? null : after[p.after];
      var ownIndex = side === 'before' ? p.before : p.after, own = ownIndex === null ? null : elements[ownIndex];
      if (a && b && a.fingerprint === b.fingerprint) return;
      count++;
      if (!a || !b) {
        if (own) mark(own, a ? 'delete' : 'add');
        else if (inline && a) {
          var copy = inertCopy(peerElement(a)); if (copy.nodeType !== Node.ELEMENT_NODE) { var wrap = document.createElement('p'); wrap.append(copy); copy = wrap; }
          mark(copy,'delete'); var next = pairs.slice(index+1).find(function (q) { return q.after !== null; });
          if (next) elements[next.after].before(copy);
          else { if (trailingCopy) trailingCopy.after(copy); else if (elements.length) elements[elements.length-1].after(copy); else document.body.append(copy); trailingCopy = copy; }
          label(copy,'− Removed in this version', /^(svg|img|iframe|video|canvas)$/.test(a.kind) ? a.key : undefined);
        }
        return;
      }
      var other = peerElement(side === 'before' ? b : a);
      if (a.kind === 'table') {
        var previouslyMarked = changes.length;
        if (tableDiff(own,other,side,inline)) {
          if (changes.length === previouslyMarked) { mark(own,'modify'); label(own,'Table formatting changed'); }
          return;
        }
      }
      if (a.kind === 'svg') { var svgMarks = changes.length; if (!svgDiff(own,(side === 'before' ? a : b).svg,(side === 'before' ? b : a).svg,side) || changes.length === svgMarks) mark(own,'modify'); label(own,'Graphic changed',side === 'after' ? a.key : undefined); return; }
      if (/^(svg|img|iframe|video|canvas|table)$/.test(a.kind)) { mark(own,'modify'); label(own,'Artifact changed',side === 'after' ? a.key : undefined); return; }
      if (a.text !== b.text) textDiff(own,a.text,b.text,side,inline);
      else { mark(own,'modify'); label(own,a.external || b.external ? 'Linked artifact or formatting changed' : 'Formatting changed'); }
    });
    post({ type:'result', count:count, styleChanged:peer.styles !== model.styles });
  }
  // All commands are authenticated by the embedding window, never by origin:
  // document frames have opaque origins and may contain nested widget frames.
  addEventListener('message', function (event) {
    var d = event.data;
    if (event.source !== parent || !d || d.source !== 'tdoc-compare-shell') return;
    try {
      if (d.type === 'snapshot') { if (!model) model = collect(); post({ type:'snapshot', model:model }); }
      else if (d.type === 'apply' && model) apply(d.peer,d.side,!!d.inline);
      else if (d.type === 'scroll' && Number.isFinite(d.position)) followScroll(d.position);
      else if (d.type === 'time' && Number.isFinite(d.time)) controlled.forEach(function (a) { a.pause(); a.currentTime = Math.max(0,Math.min(120,d.time))*1000; });
      else if (d.type === 'motion') {
        var animated = controlled.find(function(a) { return a.effect?.target; })?.effect.target;
        (animated?.closest('svg,figure') || animated)?.scrollIntoView({block:'center'});
      }

    } catch (error) { post({ type:'error', message:error.message || 'Could not compare this document.' }); }
  });
  // Never let reviewing a comparison submit a form or edit a linked artifact.
  document.addEventListener('click',function(e){ if (e.target.closest('a,button,input,select,textarea')) e.preventDefault(); },true);
  document.addEventListener('submit',function(e){ e.preventDefault(); },true);
  document.addEventListener('beforeinput',function(e){ e.preventDefault(); },true);
})();
