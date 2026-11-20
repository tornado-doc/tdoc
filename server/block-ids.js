// Stable block ids across versions (shell flag stableBlockIds, "block-first"
// step 2). A version's top-level blocks get ids that follow the same block
// into the next version even when its words changed a little or blocks were
// inserted above it. The ids live in a sidecar beside the version
// (docs/<slug>/v<N>/blocks.json); the stored HTML is never touched.
//
// Segmentation: the content root's element children, opening wrapper divs
// that only group (a lone wrapper, or a div/section with class wrap,
// content or container and nothing else), never a house block. Matching one
// version to the next, in order of strength:
//   1. equal text, in order (LCS on the normalized text's hash; tag ignored,
//      so a <p> that became a one-item list keeps its id);
//   2. between those anchors, similar text in order (token Jaccard >= 0.6
//      for the same tag, >= 0.75 across tags);
//   3. moved blocks: equal text anywhere, then similar text anywhere;
//   4. splits and merges: the larger part of a split block keeps its id, a
//      merged block keeps the id of its largest source.
// Measured on real version pairs (#block-first evidence): step 1 + 2 keep
// 99.5% of unchanged or lightly edited blocks.
//
// Everything is bounded: documents over MAX_HTML bytes or MAX_BLOCKS blocks
// get no sidecar; exact matching is linear past EXACT_CELLS; and one work
// budget (WORK_BUDGET: cells, plus tokens per comparison, after a free
// size-ratio prefilter) is shared by every fuzzy step: spent, matching stops
// and the rest is new. Pure and deterministic: the
// same HTML and previous sidecar always give the same ids, so a sidecar can
// be rebuilt and a race between two builders writes the same bytes.
//
// Shared by the worker (inlined by bin/tdoc-bundle at __TDOC_BLOCK_IDS__,
// parse5 from TdocParse5) and Node tests (parse5 passed in).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TdocBlockIds = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  var FORMAT = 1;
  var MAX_HTML = 1536 * 1024;
  var MAX_BLOCKS = 4000;
  var MAX_TEXT = 1024 * 1024;
  var EXACT_CELLS = 400000;
  var GAP_CELLS = 250000;
  var FUZZ = 0.6;
  var FUZZ_CROSS_TAG = 0.75;
  var SKIP = { script: 1, style: 1, link: 1, meta: 1, template: 1, noscript: 1, title: 1, base: 1 };
  var GROUP = { div: 1, section: 1, article: 1, main: 1, header: 1, footer: 1, hgroup: 1 };
  var CONTAINER_CLS = { wrap: 1, content: 1, container: 1 };
  // Elements whose text reads as its own line: a space on each side, so two
  // paragraphs never run their words together.
  var BLOCKISH = {
    address: 1, article: 1, aside: 1, blockquote: 1, br: 1, caption: 1, dd: 1, details: 1, div: 1, dl: 1, dt: 1,
    fieldset: 1, figcaption: 1, figure: 1, footer: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1, hr: 1,
    li: 1, main: 1, nav: 1, ol: 1, p: 1, pre: 1, section: 1, summary: 1, table: 1, tbody: 1, td: 1, tfoot: 1,
    th: 1, thead: 1, tr: 1, ul: 1
  };
  var CJK = /[぀-ヿ㐀-鿿가-힯]/;

  function attr(n, name) {
    var list = n.attrs || [];
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i].value;
    return null;
  }
  function classes(n) { return (attr(n, 'class') || '').split(/\s+/).filter(Boolean); }
  function directText(n) {
    return (n.childNodes || []).some(function (c) { return c.nodeName === '#text' && /[^\s ]/.test(c.value); });
  }
  // The element children a block list is made of. The frame filters the
  // live DOM the same way (selection/anchors/block.js).
  function elementKids(n) {
    return (n.childNodes || []).filter(function (c) {
      return c.tagName && !SKIP[c.tagName] && attr(c, 'data-tdoc-provider') == null
        && (attr(c, 'id') || '').indexOf('tdoc-') !== 0;
    });
  }
  function house(n) {
    var c = classes(n);
    if (n.tagName === 'figure') return 'figure';
    if (n.tagName === 'details') return 'details';
    if (attr(n, 'data-tdoc-artifact') != null || attr(n, 'data-tdoc-excalidraw') != null || c.indexOf('tdoc-artifact') !== -1) return 'artifact';
    if (c.indexOf('diagram-box') !== -1) return 'diagram-box';
    if (c.indexOf('tdoc-tiles') !== -1 || c.indexOf('tdoc-tile') !== -1) return 'tiles';
    if (c.indexOf('tdoc-cards') !== -1 || c.indexOf('tdoc-card') !== -1) return 'cards';
    if (c.indexOf('note') !== -1 && n.tagName !== 'p') return 'note';
    return null;
  }
  function transparent(n) {
    if (!GROUP[n.tagName] || house(n)) return false;
    return classes(n).every(function (x) { return CONTAINER_CLS[x]; }) && attr(n, 'style') == null && !directText(n);
  }
  function textOf(n, out) {
    if (n.nodeName === '#text') { out.push(n.value); return; }
    if (!n.tagName && n.nodeName !== '#document-fragment') return;
    if (n.tagName && (SKIP[n.tagName] || attr(n, 'data-tdoc-provider') != null)) return;
    var spaced = n.tagName && BLOCKISH[n.tagName];
    if (spaced) out.push(' ');
    if (n.tagName === 'img') out.push(' ' + (attr(n, 'alt') || '') + ' ');
    var kids = n.childNodes || [];
    for (var i = 0; i < kids.length; i++) textOf(kids[i], out);
    if (spaced) out.push(' ');
  }
  // Lower case, whitespace (and no-break spaces) collapsed: what equality and
  // quote search compare.
  function norm(s) { return String(s || '').toLowerCase().replace(/[\s ]+/g, ' ').trim(); }
  // Without any whitespace: what the frame compares against an element's
  // textContent, which puts no space between two paragraphs.
  function squash(s) { return String(s || '').toLowerCase().replace(/[\s ]+/g, ''); }
  function hash(s) {
    // FNV-1a, two lanes: 64 bits as 13 base-36 digits is plenty for a doc.
    var a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      a ^= c; a = Math.imul(a, 0x01000193);
      b ^= c; b = Math.imul(b, 0x5bd1e995); b ^= b >>> 15;
    }
    return (a >>> 0).toString(36) + (b >>> 0).toString(36);
  }
  function tokens(t) {
    var out = new Set();
    var words = t.match(/[\p{L}\p{N}]+/gu) || [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (CJK.test(w)) {
        if (w.length === 1) out.add(w);
        for (var k = 0; k < w.length - 1; k++) out.add(w.slice(k, k + 2));
      } else out.add(w);
    }
    return out;
  }
  function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    var small = a.size < b.size ? a : b, large = small === a ? b : a, inter = 0;
    small.forEach(function (x) { if (large.has(x)) inter++; });
    return inter / (a.size + b.size - inter);
  }
  // Share of a's tokens found in b.
  function containment(a, b) {
    if (!a.size) return 0;
    var inter = 0;
    a.forEach(function (x) { if (b.has(x)) inter++; });
    return inter / a.size;
  }

  function findBody(doc) {
    var html = (doc.childNodes || []).find(function (n) { return n.nodeName === 'html'; });
    return html && (html.childNodes || []).find(function (n) { return n.nodeName === 'body'; });
  }

  // The blocks of one version: [{ tag, path, t }], path the element-child
  // indices (elementKids) from <body>. null when the document is too big to
  // keep ids for.
  function segment(html, parse5) {
    html = String(html || '');
    if (html.length > MAX_HTML) return null;
    var body = findBody(parse5.parse(html));
    if (!body) return [];
    var rootNode = body, prefix = [];
    for (;;) {
      var kids = elementKids(rootNode);
      if (kids.length === 1 && GROUP[kids[0].tagName] && !house(kids[0]) && !directText(rootNode)) {
        rootNode = kids[0]; prefix.push(0);
      } else break;
    }
    var out = [], total = 0, over = false;
    (function walk(n, path) {
      var kids = elementKids(n);
      for (var i = 0; i < kids.length && !over; i++) {
        var p = path.concat(i);
        if (transparent(kids[i])) { walk(kids[i], p); continue; }
        var parts = [];
        textOf(kids[i], parts);
        var t = norm(parts.join(''));
        if (!t) continue;
        total += t.length;
        if (out.length >= MAX_BLOCKS || total > MAX_TEXT) { over = true; return; }
        out.push({ tag: kids[i].tagName, path: p, t: t });
      }
    })(rootNode, prefix);
    return over ? null : out;
  }

  // Longest common subsequence over a precomputed weight table (w[i*m+j] >
  // 0 for a possible pair). n*m cells; the caller keeps that under budget.
  function lcs(n, m, w) {
    var W = m + 1;
    var dp = new Float64Array((n + 1) * W);
    var i, j;
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) {
      var best = Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      var x = w[i * m + j];
      if (x > 0 && dp[(i + 1) * W + j + 1] + x > best) best = dp[(i + 1) * W + j + 1] + x;
      dp[i * W + j] = best;
    }
    var pairs = [];
    i = 0; j = 0;
    while (i < n && j < m) {
      var y = w[i * m + j];
      if (y > 0 && dp[i * W + j] === dp[(i + 1) * W + j + 1] + y) { pairs.push([i, j]); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  // The matcher's one budget, shared by every step: a cell costs 1, a token
  // comparison costs the smaller token count. Spent, the fuzzy steps stop
  // and whatever is left is new. Exact matching is linear past EXACT_CELLS.
  var WORK_BUDGET = 600000;
  function meter(budget) {
    return { left: budget == null ? WORK_BUDGET : budget, spent: 0, out: false };
  }
  function charge(m, cost) {
    if (m.out) return false;
    if (m.left < cost) { m.out = true; return false; }
    m.left -= cost; m.spent += cost;
    return true;
  }
  // Similarity of two blocks for the fuzzy steps, or 0. The size ratio is a
  // free prefilter: Jaccard >= t needs min/max >= t.
  function similar(o, n, m) {
    var need = o.tag === n.tag ? FUZZ : FUZZ_CROSS_TAG;
    var a = o.tok.size, b = n.tok.size;
    if (!a || !b || Math.min(a, b) / Math.max(a, b) < need) return 0;
    if (!charge(m, Math.min(a, b))) return 0;
    var s = jaccard(o.tok, n.tok);
    return s >= need ? s : 0;
  }
  function prepBlock(b) {
    if (!b.h) b.h = hash(b.t);
    if (!b.tok) b.tok = tokens(b.t);
    return b;
  }

  // Which old block each new block continues: mn[j] = i, or -1 (new).
  // O and N: [{ tag, t }]; h and tok are filled in here. `budget`: work
  // units (default WORK_BUDGET); `work` in the result says what was spent.
  function match(O, N, budget) {
    O.forEach(prepBlock); N.forEach(prepBlock);
    var m0 = meter(budget);
    var n = O.length, m = N.length;
    var mo = new Array(n).fill(-1), mn = new Array(m).fill(-1), kind = new Array(m).fill('new');
    function pair(i, j, k) { mo[i] = j; mn[j] = i; kind[j] = k; }
    // 1. Equal text, in order.
    if (n * m <= EXACT_CELLS && charge(m0, n * m)) {
      var w = new Uint8Array(n * m);
      for (var i0 = 0; i0 < n; i0++) for (var j0 = 0; j0 < m; j0++) if (O[i0].h === N[j0].h) w[i0 * m + j0] = 1;
      lcs(n, m, w).forEach(function (p) { pair(p[0], p[1], 'exact'); });
    } else {
      // Linear: hashes unique on both sides, taken while they ascend.
      var countO = new Map(), countN = new Map(), at = new Map(), last = -1;
      O.forEach(function (b) { countO.set(b.h, (countO.get(b.h) || 0) + 1); });
      N.forEach(function (b, j) { countN.set(b.h, (countN.get(b.h) || 0) + 1); at.set(b.h, j); });
      O.forEach(function (b, i) {
        if (countO.get(b.h) !== 1 || countN.get(b.h) !== 1) return;
        var j = at.get(b.h);
        if (j > last) { pair(i, j, 'exact'); last = j; }
      });
    }
    // 2. Similar text, in order, inside each gap between equal blocks.
    var anchors = [[-1, -1]];
    mn.forEach(function (i, j) { if (i >= 0) anchors.push([i, j]); });
    anchors.push([n, m]);
    for (var a = 0; a < anchors.length - 1 && !m0.out; a++) {
      var OI = [], NJ = [], x;
      for (x = anchors[a][0] + 1; x < anchors[a + 1][0]; x++) OI.push(x);
      for (x = anchors[a][1] + 1; x < anchors[a + 1][1]; x++) NJ.push(x);
      if (!OI.length || !NJ.length || OI.length * NJ.length > GAP_CELLS || !charge(m0, OI.length * NJ.length)) continue;
      var gw = new Float64Array(OI.length * NJ.length);
      for (var p = 0; p < OI.length; p++) for (var q = 0; q < NJ.length; q++) gw[p * NJ.length + q] = similar(O[OI[p]], N[NJ[q]], m0);
      if (m0.out) break;
      lcs(OI.length, NJ.length, gw).forEach(function (pq) { pair(OI[pq[0]], NJ[pq[1]], 'fuzzy'); });
    }
    // 3. Moved: equal text anywhere (linear), then similar text anywhere.
    var byHash = new Map();
    O.forEach(function (b, i) {
      if (mo[i] >= 0) return;
      if (!byHash.has(b.h)) byHash.set(b.h, []);
      byHash.get(b.h).push(i);
    });
    N.forEach(function (b, j) {
      if (mn[j] >= 0) return;
      var free = byHash.get(b.h);
      if (free && free.length) pair(free.shift(), j, 'moved');
    });
    var leftO = [], leftN = [];
    O.forEach(function (b, i) { if (mo[i] < 0) leftO.push(i); });
    N.forEach(function (b, j) { if (mn[j] < 0) leftN.push(j); });
    if (!m0.out && leftO.length && leftN.length && leftO.length * leftN.length <= GAP_CELLS && charge(m0, leftO.length * leftN.length)) {
      var cands = [];
      for (var k = 0; k < leftN.length && !m0.out; k++) {
        for (var l = 0; l < leftO.length && !m0.out; l++) {
          var sim = similar(O[leftO[l]], N[leftN[k]], m0);
          if (sim) cands.push([sim, leftO[l], leftN[k]]);
        }
      }
      if (!m0.out) {
        cands.sort(function (p1, q1) { return q1[0] - p1[0] || p1[1] - q1[1] || p1[2] - q1[2]; });
        cands.forEach(function (c) { if (mo[c[1]] < 0 && mn[c[2]] < 0) pair(c[1], c[2], 'moved'); });
      }
      leftO = leftO.filter(function (i) { return mo[i] < 0; });
      leftN = leftN.filter(function (j) { return mn[j] < 0; });
    }
    // 4. Splits: an old block whose words now sit in several new ones. The
    // largest part keeps the id. Merges: a new block made of several old
    // ones keeps the id of the largest.
    function contains(small, big) {
      if (!charge(m0, small.tok.size)) return 0;
      return containment(small.tok, big.tok);
    }
    if (!m0.out && leftO.length && leftN.length && leftO.length * leftN.length <= GAP_CELLS) {
      leftO.forEach(function (i) {
        var o = O[i];
        if (m0.out || o.tok.size < 4) return;
        var parts = leftN.filter(function (j) { return mn[j] < 0 && N[j].tok.size >= 2 && N[j].tok.size <= o.tok.size && contains(N[j], o) >= 0.8; });
        if (!parts.length || m0.out) return;
        var union = new Set();
        parts.forEach(function (j) { N[j].tok.forEach(function (t) { union.add(t); }); });
        if (containment(o.tok, union) < 0.5) return;
        var biggest = parts.reduce(function (p1, q1) { return N[q1].tok.size > N[p1].tok.size ? q1 : p1; });
        pair(i, biggest, 'split');
      });
      leftN.forEach(function (j) {
        if (m0.out || mn[j] >= 0) return;
        var nb = N[j];
        if (nb.tok.size < 4) return;
        var parts = leftO.filter(function (i) { return mo[i] < 0 && O[i].tok.size >= 2 && O[i].tok.size <= nb.tok.size && contains(O[i], nb) >= 0.8; });
        if (!parts.length || m0.out) return;
        var union = new Set();
        parts.forEach(function (i) { O[i].tok.forEach(function (t) { union.add(t); }); });
        if (containment(nb.tok, union) < 0.5) return;
        var biggest = parts.reduce(function (p1, q1) { return O[q1].tok.size > O[p1].tok.size ? q1 : p1; });
        pair(biggest, j, 'merge');
      });
    }
    return { mn: mn, mo: mo, kind: kind, work: m0.spent, exhausted: m0.out };
  }

  // A new block's id: short, from the version, its place and its words, so a
  // rebuild gives the same one. Unique within the doc's ids seen so far.
  function freshId(version, index, h, used) {
    for (var salt = 0; ; salt++) {
      var id = 'b' + hash(version + ':' + index + ':' + h + (salt ? ':' + salt : '')).slice(0, 9);
      if (!used.has(id)) return id;
    }
  }

  function prevBlocks(s) {
    return s && Array.isArray(s.blocks) ? s.blocks.map(function (b) { return { id: b.id, tag: b.tag, t: String(b.t || ''), h: b.h }; }) : [];
  }

  // The sidecar for `version` from its HTML and the previous version's
  // sidecar (or null). opts: { keep: { newIndex: oldId } the editor already
  // knows, used before the matcher; also: a second sidecar (a restore's
  // source version) for blocks the previous one did not match; doc, sha:
  // the doc's identity and these bytes' hash, recorded for readers to
  // check; budget: matcher work units }. null when the document is too big.
  function build(html, prev, version, parse5, opts) {
    opts = opts || {};
    var blocks = segment(html, parse5);
    if (!blocks) return null;
    var ids = new Array(blocks.length).fill(null);
    var used = new Set();
    var work = 0;
    [prev, opts.also].forEach(function (side) {
      var old = prevBlocks(side);
      old.forEach(function (b) { used.add(b.id); });
      var want = [], at = [];
      blocks.forEach(function (b, j) { if (!ids[j]) { want.push(b); at.push(j); } });
      if (!old.length || !want.length) return;
      var taken = new Set(ids.filter(Boolean));
      var res = match(old, want, opts.budget);
      work += res.work;
      res.mn.forEach(function (i, k) { if (i >= 0 && !taken.has(old[i].id)) ids[at[k]] = old[i].id; });
    });
    var keep = opts.keep;
    if (keep && typeof keep === 'object') {
      Object.keys(keep).forEach(function (k) {
        var j = Number(k);
        if (Number.isInteger(j) && j >= 0 && j < blocks.length && typeof keep[k] === 'string' && keep[k]) ids[j] = keep[k];
      });
    }
    var seen = new Set();
    var out = blocks.map(function (b, j) {
      var h = b.h || hash(b.t);
      var id = ids[j];
      if (!id || seen.has(id)) { id = freshId(version, j, h, used); used.add(id); }
      seen.add(id);
      return { id: id, tag: b.tag, path: b.path, h: h, t: b.t };
    });
    var sidecar = { format: FORMAT, version: version, blocks: out };
    if (opts.doc) sidecar.doc = String(opts.doc);
    if (opts.sha) sidecar.sha = String(opts.sha);
    Object.defineProperty(sidecar, 'work', { value: work, enumerable: false });
    return sidecar;
  }

  function validSidecar(s) {
    return Boolean(s && s.format === FORMAT && Array.isArray(s.blocks)
      && s.blocks.every(function (b) { return b && typeof b.id === 'string' && typeof b.t === 'string' && Array.isArray(b.path); }));
  }

  function commonSuffix(a, b) {
    var k = 0;
    while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
    return k;
  }
  function commonPrefix(a, b) {
    var k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    return k;
  }

  // What locate() reads of a sidecar, computed once per sidecar object.
  var PREPPED = typeof WeakMap === 'function' ? new WeakMap() : null;
  function prepped(sidecar) {
    var hit = PREPPED && PREPPED.get(sidecar);
    if (hit) return hit;
    var starts = [], doc = '';
    sidecar.blocks.forEach(function (b, i) { if (i) doc += ' '; starts.push(doc.length); doc += b.t; });
    var out = { doc: doc, starts: starts, tok: null };
    if (PREPPED) PREPPED.set(sidecar, out);
    return out;
  }
  function blockTokens(sidecar) {
    var pre = prepped(sidecar);
    if (!pre.tok) pre.tok = sidecar.blocks.map(function (b) { return tokens(b.t); });
    return pre.tok;
  }

  // The block a text anchor ({ text, context_before, context_after }) sits
  // in, as an index into sidecar.blocks, or -1. Exact words first (the
  // context picks between repeats; a quote across blocks counts for the one
  // it starts in). Else, for a quote of 4 words or more, the one block
  // holding most of its words (with its context's words as a tiebreak); a
  // tie is no answer.
  function locate(sidecar, anchor) {
    if (!validSidecar(sidecar) || !anchor) return -1;
    var q = norm(anchor.text);
    if (!q) return -1;
    var pre = prepped(sidecar), doc = pre.doc, starts = pre.starts;
    var before = norm(anchor.context_before).slice(-60), after = norm(anchor.context_after).slice(0, 60);
    var best = -1, bestScore = -1;
    for (var at = doc.indexOf(q), hits = 0; at !== -1 && hits < 200; at = doc.indexOf(q, at + 1), hits++) {
      var score = commonSuffix(doc.slice(Math.max(0, at - 60), at).trim(), before)
        + commonPrefix(doc.slice(at + q.length, at + q.length + 60).trim(), after);
      if (score > bestScore) { bestScore = score; best = at; }
    }
    if (best >= 0) {
      var lo = 0, hi = starts.length - 1;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (starts[mid] <= best) lo = mid; else hi = mid - 1; }
      return lo;
    }
    var qt = tokens(q);
    if (qt.size < 4) return -1;
    var ct = tokens(before + ' ' + after);
    var toks = blockTokens(sidecar);
    var pick = -1, top = -1, second = -1;
    toks.forEach(function (bt, i) {
      var s = containment(qt, bt);
      if (s < 0.6) return;
      var total = s + 0.2 * containment(ct, bt);
      if (total > top) { second = top; top = total; pick = i; }
      else if (total > second) second = total;
    });
    return pick >= 0 && top - second > 1e-9 ? pick : -1;
  }

  // Where block `id` is in a sidecar, as the frame needs it: the path to
  // try first, the tag, the opening words and the length of its words (to
  // check it, and to find the block by when the path misses), and whether
  // the quote is still there.
  function place(sidecar, id, quote) {
    if (!validSidecar(sidecar) || !id) return null;
    for (var i = 0; i < sidecar.blocks.length; i++) {
      var b = sidecar.blocks[i];
      if (b.id !== id) continue;
      var q = norm(quote);
      var words = squash(b.t);
      return { id: id, index: i, path: b.path, tag: b.tag, head: words.slice(0, 80), len: words.length, quote_found: Boolean(q) && b.t.indexOf(q) !== -1, excerpt: b.t.slice(0, 160) };
    }
    return null;
  }

  return {
    FORMAT: FORMAT,
    MAX_HTML: MAX_HTML,
    WORK_BUDGET: WORK_BUDGET,
    segment: segment,
    match: match,
    build: build,
    locate: locate,
    place: place,
    validSidecar: validSidecar,
    norm: norm,
    squash: squash,
    tokens: tokens,
    jaccard: jaccard,
    hash: hash,
  };
});
