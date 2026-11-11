// Publish-time block check (authoring/structure/components.md, "Blocks").
//
// A tdoc reads best as a sequence of blocks: prose in p / li / h* / td, the
// named house blocks (tdoc-tiles, tdoc-cards, aside.note, details, figure,
// diagram-box), and anything custom as ONE self-contained element marked
// data-tdoc-artifact (or a <figure>). This scan reports what falls outside
// that: text sitting loose in a wrapper <div>, and wrapper classes that are
// not house blocks. It is advice returned with a successful publish, never a
// refusal, so it errs towards saying nothing.
//
// One forward pass over the bytes with a small open-element stack; tables
// (sheets included, up to 8 MB), SVG, <pre>, raw-text elements and comments
// are skipped by jumping to their end. Work is capped (bytes and tags), and
// a capped scan says so rather than guessing about the rest.
//
// It also counts the rows of each sheet (<table data-tdoc-sheet>) as it jumps
// over it: in a prose doc, a sheet of 20 rows or fewer, 5 columns or fewer
// and short cells is a small reference table the reader takes in at a
// glance, and reads better as a plain <table> (authoring/structure/sheets.md,
// "Sheet or table"). A wide sheet or one with long cell text stays a sheet. A
// doc that is only its sheets (a title and a line or two around them) is a
// sheet doc and is left alone. Counting stops at the 21st row, so an 8 MB
// sheet costs no more.
//
// Shared by the worker (inlined by bin/tdoc-bundle at __TDOC_BLOCK_LINT__)
// and Node tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TdocBlockLint = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  var MAX_BYTES = 2 * 1024 * 1024;
  var MAX_TAGS = 100000;
  var MAX_DEPTH_SEARCH = 64;
  var MAX_SAMPLES = 5;
  var MAX_CLASSES = 8;
  // A sheet with at most this many body rows and columns, and no cell longer
  // than SHORT_CELL characters, in a prose doc, is a small table.
  var SMALL_SHEET_ROWS = 20, SMALL_SHEET_COLS = 5, SHORT_CELL = 80;
  // Text blocks outside the sheets past which a doc is prose, not a sheet doc
  // (the same rule as the viewer's compact embed, server/sheets-viewer.js).
  var PROSE_BLOCKS = 3;

  // Classes a wrapper may carry: the content roots and the house blocks.
  var KNOWN = {
    wrap: 1, content: 1, container: 1, 'tdoc-table-scroll': 1,
    'tdoc-tiles': 1, 'tdoc-tile': 1, 'tdoc-cards': 1, 'tdoc-card': 1,
    note: 1, 'diagram-box': 1, slide: 1, 'tdoc-artifact': 1,
  };
  // Elements whose direct text is fine: the text blocks.
  var TEXT_BLOCK = {
    p: 1, li: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, td: 1, th: 1,
    dt: 1, dd: 1, figcaption: 1, summary: 1, caption: 1, blockquote: 1,
    legend: 1, address: 1, option: 1, title: 1,
  };
  // Elements that group blocks: direct text here is loose, and a class here
  // names a wrapper.
  var WRAPPER = {
    div: 1, section: 1, article: 1, aside: 1, main: 1, header: 1, nav: 1,
    details: 1, hgroup: 1, form: 1, fieldset: 1, search: 1, body: 1, html: 1,
    ul: 1, ol: 1, dl: 1, footer: 1,
  };
  // Phrasing content: text inside these belongs to the nearest block above.
  var INLINE = {
    a: 1, abbr: 1, b: 1, bdi: 1, bdo: 1, cite: 1, code: 1, data: 1, dfn: 1,
    em: 1, i: 1, kbd: 1, mark: 1, q: 1, s: 1, samp: 1, small: 1, span: 1,
    strong: 1, sub: 1, sup: 1, time: 1, u: 1, var: 1, label: 1, button: 1,
    del: 1, ins: 1, ruby: 1, rt: 1, rp: 1, output: 1, font: 1, center: 1,
    nobr: 1, big: 1, tt: 1, strike: 1,
  };
  var VOID = {
    area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
    link: 1, meta: 1, source: 1, track: 1, wbr: 1, param: 1, keygen: 1,
  };
  // Skipped whole: their content is data, code, markup of another language,
  // or (tables) a plain block already. Jumped over to the matching close.
  var SKIP = {
    table: 1, svg: 1, math: 1, pre: 1, script: 1, style: 1, template: 1,
    noscript: 1, textarea: 1, select: 1, iframe: 1, object: 1, video: 1,
    audio: 1, canvas: 1, head: 1, xmp: 1, title: 1,
  };
  var RAW = { script: 1, style: 1, textarea: 1, xmp: 1, title: 1 };
  // Outside the sheets: text blocks that make a doc prose, and content that
  // makes it a doc on its own (a plain table, a figure, an image).
  var PROSE_TEXT = { p: 1, li: 1, blockquote: 1, dd: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1 };
  var DOC_CONTENT = { table: 1, figure: 1, details: 1, img: 1, video: 1, iframe: 1 };
  // Opening one of these closes an open <p> (HTML's implied end tag).
  var CLOSES_P = {
    address: 1, article: 1, aside: 1, blockquote: 1, details: 1, div: 1,
    dl: 1, fieldset: 1, figcaption: 1, figure: 1, footer: 1, form: 1,
    h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1, hgroup: 1, hr: 1,
    main: 1, nav: 1, ol: 1, p: 1, pre: 1, section: 1, table: 1, ul: 1,
  };

  // No alternative crosses a '<', so a failed match never reads past the next
  // tag: each byte is looked at a bounded number of times. (An attribute value
  // holding a raw '<' is legal but rare; that tag is read as text.)
  var TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,63})((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>/y;

  function attrRe(name) {
    return new RegExp('(?:^|\\s)' + name + '(?:\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>`]+)))?(?=[\\s/]|$)', 'i');
  }
  var CLASS_ATTR = attrRe('class');
  var SHEET_ATTR = attrRe('data-tdoc-sheet');
  var NAME_ATTR = attrRe('data-name');
  var ATOMIC_ATTR = attrRe('data-tdoc-(?:artifact|excalidraw)');
  function attr(attrs, re) {
    var m = re.exec(attrs);
    if (!m) return null;
    return m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] != null ? m[3] : '';
  }

  // Index just past the close of a skipped element, nested same-name opens
  // counted (a table inside a table). Raw-text elements end at the first close.
  function skipEnd(html, name, from) {
    if (RAW[name]) {
      var lower = html.indexOf('</' + name, from);
      if (lower === -1) {
        var re0 = new RegExp('</' + name + '\\b', 'ig');
        re0.lastIndex = from;
        var m0 = re0.exec(html);
        if (!m0) return html.length;
        lower = m0.index;
      }
      var gt0 = html.indexOf('>', lower);
      return gt0 === -1 ? html.length : gt0 + 1;
    }
    var re = new RegExp('<(/?)' + name + '(?=[\\s/>])', 'ig');
    re.lastIndex = from;
    var depth = 1, m;
    while ((m = re.exec(html))) {
      if (m[1]) depth--; else depth++;
      if (depth === 0) {
        var gt = html.indexOf('>', m.index);
        return gt === -1 ? html.length : gt + 1;
      }
    }
    return html.length;
  }

  // Body rows of the sheet between its open tag (from) and its end (to),
  // counted up to `cap`: a <tr> holding a <td> (a header row holds only <th>).
  // The next <td> is looked up once and kept until a row passes it, so each
  // byte of the table is read a bounded number of times.
  var TR = /<tr(?=[\s>])/ig, TD = /<td(?=[\s>])/ig, CELL = /<t[hd](?=[\s>])/ig;
  function sheetRows(html, from, to, cap) {
    var n = 0, td = null, tdAt = -1;
    TR.lastIndex = from;
    var tr = TR.exec(html);
    while (tr && tr.index < to && n < cap) {
      TR.lastIndex = tr.index + 3;
      var next = TR.exec(html);
      var rowEnd = next && next.index < to ? next.index : to;
      if (tdAt !== Infinity && tdAt < tr.index) {
        TD.lastIndex = tr.index + 3;
        td = TD.exec(html);
        tdAt = td && td.index < to ? td.index : Infinity;
      }
      if (tdAt < rowEnd) n++;
      tr = next;
    }
    return n;
  }
  // Columns: the cells of the first row (the header).
  function sheetCols(html, from, to) {
    TR.lastIndex = from;
    var tr = TR.exec(html);
    if (!tr || tr.index >= to) return 0;
    TR.lastIndex = tr.index + 3;
    var next = TR.exec(html);
    var end = next && next.index < to ? next.index : to;
    var n = 0, m;
    CELL.lastIndex = tr.index + 3;
    while ((m = CELL.exec(html)) && m.index < end) n++;
    return n;
  }
  // The longest body cell's text, in characters (called only on a small sheet).
  function longestCell(html, from, to) {
    var max = 0, at = from, m;
    while (true) {
      TD.lastIndex = at;
      m = TD.exec(html);
      if (!m || m.index >= to) return max;
      var close = html.indexOf('</td', m.index);
      var next = html.indexOf('<td', m.index + 3);
      var end = Math.min(close === -1 ? to : close, next === -1 ? to : next, to);
      var text = html.slice(m.index, end).replace(/^<td[^>]*>/i, '').replace(/<[^>]*>/g, '').replace(/&[#\w]+;/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > max) max = text.length;
      at = end;
    }
  }

  function hasText(s) {
    return /[^\s\u00a0]/.test(s.replace(/&(?:nbsp|#160|#xa0|zwj|zwnj|#8203);/gi, ''));
  }
  function snippet(s) {
    var t = s.replace(/\s+/g, ' ').trim();
    return t.length > 40 ? t.slice(0, 39) + '…' : t;
  }
  function label(el) {
    return el.name + (el.cls ? '.' + el.cls.split(/\s+/)[0] : '');
  }

  function lint(input) {
    var html = String(input || '');
    var bodyAt = html.search(/<body[\s>]/i);
    var start = bodyAt === -1 ? 0 : bodyAt;
    var end = html.length;
    var truncated = false;
    var skipped = 0;
    var custom = /<html\b[^>]*\bdata-tdoc-design=["']?custom\b/i.test(html.slice(0, Math.max(0, bodyAt === -1 ? 4096 : bodyAt)));

    var stack = [];
    var loose = 0, samples = [];
    var classes = {}, classOrder = [];
    var tags = 0;
    var pos = start;
    var sheets = [], proseBlocks = 0, docContent = false;

    function top() { return stack.length ? stack[stack.length - 1] : null; }
    function popTo(name, stopAt) {
      for (var k = stack.length - 1, n = 0; k >= 0 && n < MAX_DEPTH_SEARCH; k--, n++) {
        if (stopAt && stopAt[stack[k].name]) return false;
        if (stack[k].name === name) { stack.length = k; return true; }
      }
      return false;
    }
    function text(from, to) {
      if (to <= from) return;
      var el = top();
      if (!el) {
        var orphan = html.slice(from, to);
        if (hasText(orphan)) note({ name: 'body', cls: '' }, orphan);
        return;
      }
      if (el.exempt || !el.container || TEXT_BLOCK[el.container.name] || !WRAPPER[el.container.name]) return;
      var s = html.slice(from, to);
      if (hasText(s)) note(el.container, s);
    }
    function note(container, s) {
      loose++;
      if (samples.length >= MAX_SAMPLES) return;
      var where = label(container);
      for (var k = 0; k < samples.length; k++) if (samples[k].where === where) return;
      samples.push({ where: where, text: snippet(s) });
    }

    while (pos < end) {
      if (pos - start - skipped > MAX_BYTES) { truncated = true; break; }
      var lt = html.indexOf('<', pos);
      if (lt === -1 || lt >= end) { text(pos, end); break; }
      text(pos, lt);
      if (html.startsWith('<!--', lt)) {
        var ce = html.indexOf('-->', lt + 4);
        pos = ce === -1 ? end : ce + 3;
        continue;
      }
      if (html.charCodeAt(lt + 1) === 33 || html.charCodeAt(lt + 1) === 63) { // <! or <?
        var de = html.indexOf('>', lt);
        pos = de === -1 ? end : de + 1;
        continue;
      }
      TAG.lastIndex = lt;
      var m = TAG.exec(html);
      if (!m) { pos = lt + 1; continue; }
      if (++tags > MAX_TAGS) { truncated = true; break; }
      pos = TAG.lastIndex;
      var name = m[2].toLowerCase();
      var attrs = m[3];
      if (m[1]) { // close tag
        popTo(name);
        continue;
      }
      var parent = top();
      if (CLOSES_P[name] && parent && parent.name === 'p') { stack.pop(); parent = top(); }
      if (name === 'li') { popTo('li', { ul: 1, ol: 1, menu: 1 }); parent = top(); }
      if (name === 'dt' || name === 'dd') { if (!popTo('dt', { dl: 1 })) popTo('dd', { dl: 1 }); parent = top(); }
      var sheet = name === 'table' && attrs.indexOf('data-tdoc-sheet') !== -1 && attr(attrs, SHEET_ATTR) != null;
      if (!sheet && DOC_CONTENT[name] && !(parent && parent.exempt)) docContent = true;
      if (PROSE_TEXT[name] && !(parent && parent.exempt) && !/(?:^|\s)sheet-note(?:\s|$)/.test(attr(attrs, CLASS_ATTR) || '')) proseBlocks++;
      if (SKIP[name]) {
        if (!/\/\s*$/.test(attrs)) {
          var after = skipEnd(html, name, pos);
          if (sheet) {
            var shape = { name: attr(attrs, NAME_ATTR) || 'Sheet ' + (sheets.length + 1), rows: sheetRows(html, pos, after, SMALL_SHEET_ROWS + 1), cols: 0, small: false };
            if (shape.rows <= SMALL_SHEET_ROWS) shape.cols = sheetCols(html, pos, after);
            shape.small = shape.rows <= SMALL_SHEET_ROWS && shape.cols <= SMALL_SHEET_COLS && longestCell(html, pos, after) <= SHORT_CELL;
            sheets.push(shape);
          }
          skipped += after - pos; pos = after;
        }
        continue;
      }
      if (VOID[name] || /\/\s*$/.test(attrs)) continue;
      var cls = attrs ? (attr(attrs, CLASS_ATTR) || '').trim() : '';
      var exempt = !!(parent && parent.exempt) || name === 'figure'
        || (attrs.indexOf('data-tdoc-') !== -1 && attr(attrs, ATOMIC_ATTR) != null)
        || /(?:^|\s)(?:diagram-box|tdoc-artifact)(?:\s|$)/.test(cls);
      var el = { name: name, cls: cls, exempt: exempt, container: null };
      el.container = INLINE[name] ? (parent ? parent.container : null) : el;
      if (!exempt && cls && WRAPPER[name] && name !== 'ul' && name !== 'ol' && name !== 'dl') {
        var list = cls.split(/\s+/);
        for (var c = 0; c < list.length; c++) {
          var k = list[c];
          if (!k || KNOWN[k]) continue;
          if (!Object.prototype.hasOwnProperty.call(classes, k)) { classes[k] = 0; classOrder.push(k); }
          classes[k]++;
        }
      }
      // Past a sane depth, deeper elements are read as part of the last one.
      if (stack.length < 512) stack.push(el);
    }

    var unknown = classOrder
      .map(function (k) { return { name: k, count: classes[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
    var prose = docContent || proseBlocks >= PROSE_BLOCKS;
    var small = prose ? sheets.filter(function (x) { return x.small; }).map(function (x) { return { name: x.name, rows: x.rows, cols: x.cols }; }) : [];
    var result = {
      loose_text: loose,
      loose_text_samples: samples,
      unknown_classes: unknown.slice(0, MAX_CLASSES),
      unknown_class_count: unknown.length,
      custom_design: custom,
      small_sheets: small.slice(0, MAX_SAMPLES),
      small_sheet_count: small.length,
      truncated: truncated,
      warning: null,
    };
    result.warning = format(result);
    return result;
  }

  var FIX = 'Fix: put text in <p>/<li>/<h2-h4>, use the house blocks (tdoc-tiles, tdoc-cards, aside.note, details, figure, diagram-box), or make a custom component one block with data-tdoc-artifact. Guide: tdoc://authoring/structure/components.md';

  var SMALL = 'Small table in a doc: use a plain <table>; keep sheets for data people filter or sort, and for wide tables or long cell text';
  var SMALL_GUIDE = 'Guide: tdoc://authoring/structure/sheets.md';

  function format(r) {
    if (!r.loose_text && !r.unknown_class_count && !r.small_sheet_count) return null;
    var head = 'Block check (a warning only; the doc is published): ';
    var small = r.small_sheet_count ? SMALL + ' ('
      + r.small_sheets.map(function (x) { return '"' + snippet(x.name) + '" ' + x.rows + (x.rows === 1 ? ' row' : ' rows') + ' × ' + x.cols + (x.cols === 1 ? ' column' : ' columns'); }).join(', ')
      + (r.small_sheet_count > r.small_sheets.length ? ', …' : '') + '). ' + SMALL_GUIDE : null;
    if (!r.loose_text && !r.unknown_class_count) return head + small;
    var parts = [];
    if (r.loose_text) {
      parts.push(r.loose_text + ' loose text run' + (r.loose_text === 1 ? '' : 's') + ' outside p/li/h*/td ('
        + r.loose_text_samples.map(function (s) { return s.where + ' "' + s.text + '"'; }).join(', ')
        + (r.loose_text > r.loose_text_samples.length ? ', …' : '') + ')');
    }
    if (r.unknown_class_count) {
      parts.push(r.unknown_class_count + ' wrapper class' + (r.unknown_class_count === 1 ? '' : 'es') + ' that are not house blocks ('
        + r.unknown_classes.map(function (c) { return '.' + c.name + (c.count > 1 ? ' ×' + c.count : ''); }).join(', ')
        + (r.unknown_class_count > r.unknown_classes.length ? ', …' : '') + ')');
    }
    var lines = [head + parts.join('; ') + (r.truncated ? ' (first part of the doc only)' : '') + '.'];
    if (r.custom_design) lines.push('This doc is a custom design (--custom-template); a report reads better as a standard doc made of blocks.');
    lines.push(FIX);
    if (small) lines.push(small);
    return lines.join('\n');
  }

  return { lint: lint, KNOWN_CLASSES: Object.keys(KNOWN) };
});
