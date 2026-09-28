// Bounded, deterministic sequence matching shared by the frame and Node tests.
// IDs win when both versions have them. Equal content anchors unkeyed blocks;
// only the gaps between those anchors are treated as replacements.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TdocVersionDiff = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function same(a, b) {
    if (a.key && b.key) return a.key === b.key && a.kind === b.kind;
    return a.kind === b.kind && a.fingerprint === b.fingerprint;
  }
  function align(before, after) {
    var anchors = [], n = before.length, m = after.length;
    if (n * m <= 250000) {
      var dp = Array.from({ length: n + 1 }, function () { return new Uint16Array(m + 1); });
      for (var i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = same(before[i], after[j]) ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
      i = 0; j = 0;
      while (i < n && j < m) {
        if (same(before[i], after[j])) { anchors.push([i++, j++]); }
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
        else j++;
      }
    } else {
      // Large documents keep linear memory and use unique monotonic anchors.
      var positions = new Map(), previous = -1;
      after.forEach(function (b, index) {
        var k = b.kind + ':' + (b.key || b.fingerprint);
        positions.set(k, positions.has(k) ? -1 : index);
      });
      before.forEach(function (a, index) {
        var next = positions.get(a.kind + ':' + (a.key || a.fingerprint));
        if (next > previous && same(a, after[next])) { anchors.push([index, next]); previous = next; }
      });
    }
    var result = [], x = 0, y = 0;
    anchors.concat([[n, m]]).forEach(function (pair) {
      while (x < pair[0] || y < pair[1]) {
        var a = before[x], b = after[y];
        if (x < pair[0] && y < pair[1] && a.kind === b.kind && !(a.key && b.key && a.key !== b.key)) {
          result.push({ before: x++, after: y++ });
        } else if (x < pair[0]) result.push({ before: x++, after: null });
        else result.push({ before: null, after: y++ });
      }
      if (x < n && y < m) result.push({ before: x++, after: y++ });
    });
    return result;
  }
  function textParts(before, after) {
    // Word boundaries keep a replacement readable (written → drafted rather
    // than alternating individual letters). Segmenter also handles CJK. The
    // fallback preserves Unicode and whitespace exactly on older engines.
    var segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity:'word' }) : null;
    var tokens = function (text) { return segmenter ? Array.from(segmenter.segment(text), function(s) { return s.segment; }) : (text.match(/[\p{L}\p{N}]+|\s+|[^\p{L}\p{N}\s]/gu) || []); };
    var a = tokens(before), b = tokens(after);
    var nodes = function (chars) { return chars.map(function (c) { return { kind: 'char', fingerprint: c }; }); };
    var parts = [];
    align(nodes(a), nodes(b)).forEach(function (p) {
      var old = p.before === null ? '' : a[p.before], next = p.after === null ? '' : b[p.after];
      var kind = old === next ? 'equal' : old && next ? 'replace' : old ? 'delete' : 'insert';
      var last = parts[parts.length - 1];
      if (last && last.kind === kind) { last.before += old; last.after += next; }
      else parts.push({ kind: kind, before: old, after: next });
    });
    return parts;
  }
  return { align: align, textParts: textParts };
});
