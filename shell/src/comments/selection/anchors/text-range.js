// Text anchors: a quote and the words around it, found again in a
// document that changed (whitespace, <br>, block boundaries, repeats,
// rewrites). Moved from the doc frame (server/frame-probe.js) so the doc and
// the feedback widget use one matcher. Framework-free and dependency-free:
// the doc frame bundles it (server/frame-probe-source.js).

export function contextAround(range, chars) {
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

export function placeInView(range, text, view) {
  try {
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


export function collectTextNodes(root, exclude) {
  var scope = root || document.body;
  var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      if (!n.parentElement) return NodeFilter.FILTER_REJECT;
      if (exclude && exclude(n.parentElement)) return NodeFilter.FILTER_REJECT;
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
    while (el && el !== scope && el !== document.body) {
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
export function normalizeNeedle(s) { return s ? s.replace(/\s+/g, ' ').trim() : ''; }
export function normalizeContext(s) { return s ? s.replace(/\s+/g, ' ') : ''; }
export function locateAt(nodes, off) {
  var lo = 0, hi = nodes.length - 1;
  while (lo <= hi) { var mid = (lo + hi) >> 1, n = nodes[mid];
    if (off < n.start) hi = mid - 1; else if (off > n.end) lo = mid + 1; else return { node: n.node, offset: off - n.start }; }
  return null;
}
export function commonSuffixLen(a, b) { var i = 0, m = Math.min(a.length, b.length); while (i < m && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }
export function commonPrefixLen(a, b) { var i = 0, m = Math.min(a.length, b.length); while (i < m && a[i] === b[i]) i++; return i; }
export function rangeFromNorm(view, normIdx, normLen) {
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
export var NEAR_CONTEXT_MIN = 12;
export function findNearContext(anchor, view) {
  if (!anchor || !view || !view.norm) return null;
  var before = normalizeContext(anchor.context_before).trim();
  var after = normalizeContext(anchor.context_after).trim();
  var best = null; // { at, len }

  // Suffixes of context_before: the end of it sat against the anchor.
  for (var lb = before.length; lb >= NEAR_CONTEXT_MIN; lb--) {
    var tail = before.slice(before.length - lb);
    var i = view.norm.indexOf(tail);
    if (i !== -1 && view.norm.indexOf(tail, i + 1) === -1) { best = { at: i + lb, len: lb, side: 'before' }; break; }
  }
  // Prefixes of context_after: the start of it sat against the anchor. Only
  // taken when it beats what the other side found — longer surviving run wins.
  for (var la = after.length; la >= NEAR_CONTEXT_MIN; la--) {
    if (best && la <= best.len) break;
    var head = after.slice(0, la);
    var j = view.norm.indexOf(head);
    if (j !== -1 && view.norm.indexOf(head, j + 1) === -1) { best = { at: j, len: la, side: 'after' }; break; }
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
    if (box.width || box.height) { candidate.tdocSide = best.side; return candidate; }
  }
  return null;
}

// Partial rewrites often leave a phrase of the original selection alive even
// when the whole sentence no longer matches. Prefer a unique surviving run
// of the anchor text over dumping the comment at the foot of the page.
export function findSurvivingFragment(anchor, view) {
  if (!anchor || !view || !view.norm) return null;
  // The scan is quadratic in the quote's length: a long quote is cut to
  // its first 256 characters, which is plenty to find a surviving phrase.
  var text = normalizeContext(anchor.text).trim().slice(0, 256);
  if (text.length < NEAR_CONTEXT_MIN) return null;
  var best = null;
  for (var len = Math.min(text.length, 64); len >= NEAR_CONTEXT_MIN; len--) {
    for (var start = 0; start + len <= text.length; start++) {
      var slice = text.slice(start, start + len);
      var i = view.norm.indexOf(slice);
      if (i === -1) continue;
      if (view.norm.indexOf(slice, i + 1) !== -1) continue;
      best = { at: i, len: len };
      break;
    }
    if (best) break;
  }
  if (!best) return null;
  var candidate = rangeFromNorm(view, best.at, best.len);
  if (!candidate) return null;
  var box = candidate.getBoundingClientRect();
  if (!(box.width || box.height)) return null;
  candidate.tdocSide = 'after';
  return candidate;
}

// The words a comment sat on are gone, but the block that replaced them is
// right there — after the surviving context_before, or before the surviving
// context_after. That block is what the comment is now about, so it gets a
// mark: "this was rewritten because of the thread beside it".
export var MOVED_BLOCK_SEL = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd, figcaption';
export var CONTENT_ROOT_SEL = '.wrap, main, article, .content, .container, body, html';
export function blockForMoved(r) {
  if (!r || !document.body) return null;
  var after = r.tdocSide === 'after';
  var node = after ? r.startContainer : r.endContainer;
  var offset = after ? r.startOffset : r.endOffset;
  var text = node && node.nodeType === 3 ? String(node.nodeValue || '') : '';
  var here = after ? text.slice(0, offset) : text.slice(offset);
  var t = null;
  if (here.trim()) {
    t = node; // the rewrite shares the block with the surviving context
  } else {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    walker.currentNode = node;
    var guard = 0;
    do { t = after ? walker.previousNode() : walker.nextNode(); } while (t && !String(t.nodeValue || '').trim() && guard++ < 64);
  }
  if (!t) return null;
  var el = t.nodeType === 1 ? t : t.parentElement;
  var block = el && el.closest ? el.closest(MOVED_BLOCK_SEL) : null;
  if (!block || block.matches(CONTENT_ROOT_SEL)) return null;
  try { var out = document.createRange(); out.selectNodeContents(block); return out; } catch (x) { return null; }
}

export function findTextRange(anchor, view) {
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

// The anchor for a selected range, measured in the same view findTextRange
// searches (quote, context, which occurrence).
export function captureTextAnchor(range, view) {
  var text = String(range.toString() || '').replace(/^\s+|\s+$/g, '');
  if (!text) return null;
  var placed = placeInView(range, text, view);
  var ctx = placed ? { before: placed.before, after: placed.after } : contextAround(range, 60);
  return {
    text: text.slice(0, 2000),
    context_before: ctx.before,
    context_after: ctx.after,
    occurrence: placed ? placed.occurrence : null,
    occurrences: placed ? placed.occurrences : null,
  };
}
