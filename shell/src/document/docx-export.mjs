// Download as Word: a .docx built from the document's HTML, in the browser,
// with no library. A .docx is a zip of a few XML parts; this writes them
// (document, styles, numbering, relationships, the images) and stores them
// in a zip without compression, which Word, Pages, LibreOffice and Google
// Docs all open. Loaded only when a reader picks Download → Word.
//
// What maps: headings, paragraphs, bold / italic / underline / strike /
// inline code, links, bullet and numbered lists (nested), block quotes,
// code blocks, tables (header row repeats, colspan), images (embedded; SVG
// and WebP drawn to PNG), inline SVG figures (drawn to PNG), rules. What the
// browser cannot draw for us (a canvas, an interactive island, a video)
// becomes a line that links to the online document.
//
// No DOM globals here: the caller passes a parsed document and the two
// browser-only steps (loadImage, renderSvg), so an offline test runs it on
// a small DOM.

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const REL_LINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// A US Letter / A4-safe text column: 6.5in at 96 px per inch.
const PAGE_W_PX = 624;
const PAGE_H_PX = 860;
const EMU_PER_PX = 9525;
const COLUMN_TWIPS = 9360;

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'base',
  'button', 'input', 'select', 'textarea', 'option', 'datalist', 'dialog', 'map', 'area', 'track', 'source', 'param']);
const EMBED = new Set(['canvas', 'iframe', 'video', 'audio', 'object', 'embed', 'math']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul', 'caption', 'legend']);

// ---- XML -------------------------------------------------------------------

function xml(text) {
  return String(text == null ? '' : text)
    // Characters XML 1.0 cannot carry, and unpaired surrogates.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- DOM helpers (DOMParser documents and test/helpers/mini-dom alike) ----

const tagOf = (node) => (node && node.nodeType === 1 ? String(node.localName || node.tagName || '').toLowerCase() : '');
const kids = (node) => Array.prototype.slice.call(node.childNodes || []);
const attr = (node, name) => (node.getAttribute ? node.getAttribute(name) : null);
function textOf(node) {
  if (node.nodeType === 3) return node.data != null ? node.data : node.textContent || '';
  if (node.nodeType !== 1 || SKIP.has(tagOf(node))) return '';
  if (tagOf(node) === 'br') return '\n';
  return kids(node).map(textOf).join('');
}
function hidden(node) {
  if (node.nodeType !== 1) return false;
  if (node.hasAttribute && (node.hasAttribute('hidden') || node.hasAttribute('data-tdoc-provider'))) return true;
  if (attr(node, 'aria-hidden') === 'true' && tagOf(node) !== 'svg') return true;
  const style = String(attr(node, 'style') || '').replace(/\s+/g, '').toLowerCase();
  return style.includes('display:none') || style.includes('visibility:hidden');
}
function findBody(doc) {
  if (doc.body) return doc.body;
  const stack = [doc];
  while (stack.length) {
    const n = stack.shift();
    if (tagOf(n) === 'body') return n;
    stack.push(...kids(n).filter((c) => c.nodeType === 1));
  }
  return doc.documentElement || doc;
}
function sameFormat(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) if (Boolean((a || {})[k]) !== Boolean((b || {})[k]) || ((a || {})[k] || '') !== ((b || {})[k] || '')) return false;
  return true;
}
function px(value) {
  const m = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(String(value || ''));
  return m ? Number(m[1]) : 0;
}

// ---- zip (stored) ------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const utf8 = (s) => new TextEncoder().encode(s);

// files: [{ name, data: Uint8Array | string }] → Uint8Array (a stored zip).
export function zipStore(files, date = new Date()) {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = utf8(file.name);
    const data = typeof file.data === 'string' ? utf8(file.data) : file.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // names are UTF-8
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}

// ---- the document ------------------------------------------------------------

// options: { title, docUrl, baseUrl, loadImage(url) → { bytes, type:'png'|'jpeg'|'gif', width, height } | null,
//            renderSvg(svgElement) → same | null }
export async function htmlToDocx(doc, options = {}) {
  const { title = '', docUrl = '', baseUrl = '' } = options;
  const loadImage = options.loadImage || (async () => null);
  const renderSvg = options.renderSvg || (async () => null);
  const rels = [];
  const media = [];
  const nums = [];
  let drawingId = 0;
  const linkIds = new Map();

  const relId = () => `rId${rels.length + 3}`; // rId1 styles, rId2 numbering
  const linkRel = (href) => {
    if (linkIds.has(href)) return linkIds.get(href);
    const id = relId();
    rels.push(`<Relationship Id="${id}" Type="${REL_LINK}" Target="${xml(href)}" TargetMode="External"/>`);
    linkIds.set(href, id);
    return id;
  };
  const resolve = (u) => {
    const s = String(u || '').trim();
    if (!s) return '';
    if (/^(data:|blob:)/i.test(s)) return s;
    try { return new URL(s, baseUrl || undefined).href; } catch { return s; }
  };
  const linkable = (u) => /^(https?:|mailto:)/i.test(u);

  // An image as a run. `size` is the natural size in CSS px; the drawing
  // keeps the author's width/height attributes when given, never wider than
  // the text column.
  function imageRun(img, alt, want) {
    const ext = img.type === 'jpeg' ? 'jpeg' : img.type === 'gif' ? 'gif' : 'png';
    const name = `image${media.length + 1}.${ext}`;
    media.push({ name, bytes: img.bytes });
    const id = relId();
    rels.push(`<Relationship Id="${id}" Type="${REL_IMAGE}" Target="media/${name}"/>`);
    let w = want.width || img.width || PAGE_W_PX;
    let h = want.height || (img.width ? (img.height * w) / img.width : img.height) || w * 0.6;
    if (want.width && !want.height && img.width) h = (img.height * w) / img.width;
    if (want.height && !want.width && img.height) { w = (img.width * want.height) / img.height; h = want.height; }
    const scale = Math.min(1, PAGE_W_PX / w, PAGE_H_PX / h);
    const cx = Math.max(1, Math.round(w * scale * EMU_PER_PX));
    const cy = Math.max(1, Math.round(h * scale * EMU_PER_PX));
    drawingId += 1;
    return { kind: 'xml', xml: `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${drawingId}" name="Picture ${drawingId}" descr="${xml(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>` };
  }

  function newNum(ordered, start, level) {
    const id = nums.length + 1;
    nums.push({ id, abstract: ordered ? 1 : 0, start: ordered ? start : null, level });
    return id;
  }

  // ---- runs and paragraphs ----
  function runXml(run) {
    if (run.kind === 'xml') return run.xml;
    if (run.kind === 'br') return '<w:r><w:br/></w:r>';
    const f = run.fmt || {};
    let pr = '';
    if (f.code) pr += '<w:rStyle w:val="CodeChar"/>';
    else if (f.link) pr += '<w:rStyle w:val="Hyperlink"/>';
    // In the order the schema wants them (Word refuses a file otherwise).
    if (f.b) pr += '<w:b/>';
    if (f.i) pr += '<w:i/>';
    if (f.s) pr += '<w:strike/>';
    if (f.muted) pr += '<w:color w:val="6B6B76"/>';
    if (f.mark) pr += '<w:highlight w:val="yellow"/>';
    if (f.u && !f.link) pr += '<w:u w:val="single"/>';
    if (f.sup) pr += '<w:vertAlign w:val="superscript"/>';
    else if (f.sub) pr += '<w:vertAlign w:val="subscript"/>';
    const parts = String(run.text).split('\t').map((t) => (t ? `<w:t xml:space="preserve">${xml(t)}</w:t>` : ''));
    return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}${parts.join('<w:tab/>')}</w:r>`;
  }
  function runsXml(runs) {
    let out = '';
    let i = 0;
    while (i < runs.length) {
      const link = runs[i].fmt && runs[i].fmt.link;
      if (!link) { out += runXml(runs[i]); i++; continue; }
      let inner = '';
      while (i < runs.length && runs[i].fmt && runs[i].fmt.link === link) { inner += runXml(runs[i]); i++; }
      out += `<w:hyperlink r:id="${link}" w:history="1">${inner}</w:hyperlink>`;
    }
    return out;
  }
  function paragraphXml({ style, num, indent, border, keepNext }, runs) {
    let pr = '';
    if (style) pr += `<w:pStyle w:val="${style}"/>`;
    if (keepNext) pr += '<w:keepNext/>';
    if (num) pr += `<w:numPr><w:ilvl w:val="${num.ilvl}"/><w:numId w:val="${num.numId}"/></w:numPr>`;
    if (border) pr += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D0D0D7"/></w:pBdr>';
    if (indent) pr += `<w:ind w:left="${indent}"/>`;
    return `<w:p>${pr ? `<w:pPr>${pr}</w:pPr>` : ''}${runsXml(runs)}</w:p>`;
  }

  // A paragraph being filled with inline content. Whitespace collapses the
  // way a browser collapses it: no run starts or ends a paragraph with a
  // space, and two spaces never meet across runs.
  function makeBlockWriter(out) {
    let runs = [];
    let pending = null;
    const w = {
      out,
      open(props) { pending = props; },
      text(text, fmt) {
        let t = String(text).replace(/[ \t\n\r\f\v]+/g, ' ');
        const last = runs.length ? runs[runs.length - 1] : null;
        const prevSpace = !runs.length || (last.kind === 'br') || (last.kind === 'text' && / $/.test(last.text));
        if (prevSpace) t = t.replace(/^ /, '');
        if (!t) return;
        // One run for text that reads the same as the run before it.
        if (last && last.kind === 'text' && sameFormat(last.fmt, fmt)) { last.text += t; return; }
        runs.push({ kind: 'text', text: t, fmt });
      },
      raw(run) { runs.push(run); },
      flush(props) {
        while (runs.length && runs[runs.length - 1].kind === 'text' && / $/.test(runs[runs.length - 1].text)) {
          const last = runs[runs.length - 1];
          last.text = last.text.replace(/ +$/, '');
          if (!last.text) runs.pop(); else break;
        }
        while (runs.length && runs[runs.length - 1].kind === 'br') runs.pop();
        const p = props || pending || {};
        if (runs.length) {
          if (p.num && p.num.used) { out.push(paragraphXml({ ...p, num: null, indent: 720 * (p.num.ilvl + 1) }, runs)); }
          else { out.push(paragraphXml(p, runs)); if (p.num) p.num.used = true; }
        }
        runs = [];
      },
      get empty() { return !runs.length; },
    };
    return w;
  }

  function placeholder(w, ctx, what) {
    w.flush(ctx.para);
    w.text(`${what}: see it in the online document`, { i: true, muted: true });
    if (docUrl) {
      w.text(' ', {});
      w.text(docUrl, { link: linkRel(docUrl) });
    }
    w.flush({ style: 'Caption' });
  }

  async function image(node, w, ctx) {
    const alt = String(attr(node, 'alt') || '').trim();
    const src = resolve(attr(node, 'src') || attr(node, 'data-src') || '');
    const want = { width: px(attr(node, 'width')), height: px(attr(node, 'height')) };
    let img = null;
    if (src) { try { img = await loadImage(src); } catch { img = null; } }
    if (img && img.bytes && img.bytes.length) { w.raw(imageRun(img, alt, want)); return; }
    // Could not fetch it (another site that does not allow it): its words
    // and where it lives.
    const label = alt ? `[Image: ${alt}]` : '[Image]';
    if (linkable(src)) w.text(label, { ...ctx.fmt, link: linkRel(src) });
    else w.text(label, { ...ctx.fmt, i: true });
  }

  async function svgFigure(node, w, ctx) {
    let img = null;
    try { img = await renderSvg(node); } catch { img = null; }
    const label = String(attr(node, 'aria-label') || '').trim() || (kids(node).find((c) => tagOf(c) === 'title') ? textOf(kids(node).find((c) => tagOf(c) === 'title')).trim() : '');
    if (img && img.bytes && img.bytes.length) {
      const want = { width: px(attr(node, 'width')), height: px(attr(node, 'height')) };
      w.raw(imageRun(img, label, want));
      return;
    }
    placeholder(w, ctx, label ? `Figure “${label}”` : 'Figure');
  }

  async function table(node, out, ctx) {
    const rows = [];
    const collect = (el, head) => {
      for (const c of kids(el)) {
        const t = tagOf(c);
        if (t === 'tr') rows.push({ tr: c, head });
        else if (t === 'thead') collect(c, true);
        else if (t === 'tbody' || t === 'tfoot') collect(c, false);
      }
    };
    collect(node, false);
    const caption = kids(node).find((c) => tagOf(c) === 'caption');
    if (caption && textOf(caption).trim()) out.push(paragraphXml({ style: 'Caption', keepNext: true }, [{ kind: 'text', text: textOf(caption).replace(/\s+/g, ' ').trim(), fmt: { b: true } }]));
    if (!rows.length) return;
    const cellsOf = (tr) => kids(tr).filter((c) => tagOf(c) === 'td' || tagOf(c) === 'th');
    const width = Math.max(1, ...rows.map((r) => cellsOf(r.tr).reduce((n, c) => n + Math.max(1, Number(attr(c, 'colspan')) || 1), 0)));
    const colW = Math.floor(COLUMN_TWIPS / width);
    let xmlRows = '';
    let leading = true;
    for (const r of rows) {
      const cells = cellsOf(r.tr);
      const isHead = r.head || (cells.length && cells.every((c) => tagOf(c) === 'th'));
      // Only header rows at the top repeat on each page.
      const repeat = isHead && leading;
      if (!isHead) leading = false;
      let tcs = '';
      let used = 0;
      for (const c of cells) {
        const span = Math.min(width - used, Math.max(1, Number(attr(c, 'colspan')) || 1));
        if (span <= 0) break;
        used += span;
        const inner = [];
        await blocks(c, inner, { ...ctx, para: {}, fmt: { ...ctx.fmt, b: ctx.fmt.b || tagOf(c) === 'th' }, list: null });
        if (!inner.length || !/<w:p[ >]/.test(inner[inner.length - 1])) inner.push('<w:p/>');
        tcs += `<w:tc><w:tcPr><w:tcW w:w="${colW * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="F4F4F6"/>' : ''}</w:tcPr>${inner.join('')}</w:tc>`;
      }
      for (; used < width; used++) tcs += `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`;
      xmlRows += `<w:tr>${repeat ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${tcs}</w:tr>`;
    }
    out.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${colW}"/>`.repeat(width)}</w:tblGrid>${xmlRows}</w:tbl>`);
    // Two tables in a row would merge into one in Word.
    out.push('<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>');
  }

  function codeBlock(node, out) {
    const text = textOf(node).replace(/^\n/, '').replace(/\s+$/, '');
    const runs = [];
    text.split('\n').forEach((line, i) => {
      if (i) runs.push({ kind: 'br' });
      if (line) runs.push({ kind: 'text', text: line, fmt: {} });
    });
    out.push(paragraphXml({ style: 'Code' }, runs));
  }

  // Walk `node`'s children into `out` (an array of block XML strings).
  async function blocks(node, out, ctx) {
    const w = makeBlockWriter(out);
    w.open(ctx.para);
    const visit = async (n, c) => {
      if (n.nodeType === 3) { w.text(n.data != null ? n.data : n.textContent, c.fmt); return; }
      if (n.nodeType !== 1 || hidden(n)) return;
      const t = tagOf(n);
      if (SKIP.has(t)) return;
      if (t === 'br') { w.raw({ kind: 'br' }); return; }
      if (t === 'img') { await image(n, w, c); return; }
      if (t === 'svg') {
        // A small inline icon is decoration; a drawing is a figure.
        const small = (px(attr(n, 'width')) && px(attr(n, 'width')) < 32) || attr(n, 'aria-hidden') === 'true';
        if (small) return;
        await svgFigure(n, w, c);
        return;
      }
      if (EMBED.has(t)) {
        const label = String(attr(n, 'title') || attr(n, 'aria-label') || '').trim();
        placeholder(w, c, label ? `Interactive content “${label}”` : t === 'video' || t === 'audio' ? 'Media' : 'Interactive content');
        return;
      }
      if (!BLOCK.has(t)) {
        const fmt = { ...c.fmt };
        if (t === 'b' || t === 'strong') fmt.b = true;
        else if (t === 'i' || t === 'em' || t === 'cite' || t === 'dfn' || t === 'var') fmt.i = true;
        else if (t === 'u' || t === 'ins') fmt.u = true;
        else if (t === 's' || t === 'del' || t === 'strike') fmt.s = true;
        else if (t === 'code' || t === 'kbd' || t === 'samp' || t === 'tt') fmt.code = true;
        else if (t === 'sup') fmt.sup = true;
        else if (t === 'sub') fmt.sub = true;
        else if (t === 'mark') fmt.mark = true;
        else if (t === 'a') {
          const href = resolve(attr(n, 'href'));
          if (linkable(href)) fmt.link = linkRel(href);
        }
        const style = String(attr(n, 'style') || '').toLowerCase();
        if (/font-weight\s*:\s*(bold|[6-9]00)/.test(style)) fmt.b = true;
        if (/font-style\s*:\s*italic/.test(style)) fmt.i = true;
        for (const k of kids(n)) await visit(k, { ...c, fmt });
        return;
      }
      // A block: finish the paragraph in progress, then write this one.
      w.flush();
      w.open(c.para);
      if (/^h[1-6]$/.test(t)) {
        const inner = [];
        await blocks(n, inner, { ...c, para: { style: `Heading${t[1]}` }, list: null });
        out.push(...inner);
      } else if (t === 'p' || t === 'summary' || t === 'dt' || t === 'legend' || t === 'figcaption' || t === 'caption') {
        const para = t === 'figcaption' || t === 'caption' ? { style: 'Caption' } : c.para;
        const fmt = t === 'summary' || t === 'dt' ? { ...c.fmt, b: true } : c.fmt;
        await blocks(n, out, { ...c, para, fmt });
      } else if (t === 'pre') {
        codeBlock(n, out);
      } else if (t === 'hr') {
        out.push(paragraphXml({ border: true }, []));
      } else if (t === 'blockquote') {
        await blocks(n, out, { ...c, para: { style: 'Quote' } });
      } else if (t === 'dd') {
        await blocks(n, out, { ...c, para: { ...c.para, indent: 720 } });
      } else if (t === 'ul' || t === 'ol') {
        const level = c.list ? Math.min(8, c.list.ilvl + 1) : 0;
        const start = Number(attr(n, 'start')) || 1;
        const numId = newNum(t === 'ol', start, level);
        for (const li of kids(n)) {
          if (tagOf(li) !== 'li' || hidden(li)) {
            if (li.nodeType === 1 && !hidden(li)) await blocks({ childNodes: [li] }, out, c);
            continue;
          }
          const num = { numId, ilvl: level, used: false };
          await blocks(li, out, { ...c, para: { style: 'ListParagraph', num }, list: num });
        }
      } else if (t === 'li') {
        await blocks(n, out, c);
      } else if (t === 'table') {
        await table(n, out, c);
      } else {
        await blocks(n, out, c);
      }
      w.open(c.para);
    };
    for (const k of kids(node)) await visit(k, ctx);
    w.flush();
  }

  const body = findBody(doc);
  const out = [];
  const hasH1 = (function find(n) { return tagOf(n) === 'h1' && !hidden(n) ? true : kids(n).some((c) => c.nodeType === 1 && !hidden(c) && !SKIP.has(tagOf(c)) && find(c)); })(body);
  if (title && !hasH1) out.push(paragraphXml({ style: 'Title' }, [{ kind: 'text', text: title, fmt: {} }]));
  await blocks(body, out, { para: {}, fmt: {}, list: null });
  if (!out.length) out.push('<w:p/>');

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${out.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const files = [
    { name: '[Content_Types].xml', data: contentTypes(media) },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'docProps/core.xml', data: coreXml(title) },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: STYLES_XML },
    { name: 'word/numbering.xml', data: numberingXml(nums) },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${rels.join('')}</Relationships>` },
    ...media.map((m) => ({ name: `word/media/${m.name}`, data: m.bytes })),
  ];
  return zipStore(files);
}

function contentTypes(media) {
  const exts = new Set(media.map((m) => m.name.split('.').pop()));
  const defaults = [...exts].map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${defaults}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
}

function coreXml(title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>tdoc</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

const BULLETS = ['•', '◦', '▪'];
const ORDERED = ['decimal', 'lowerLetter', 'lowerRoman'];
function numberingXml(nums) {
  // Bullets share one definition. Each numbered list gets its own, so it
  // counts from its own start (an <ol start="3"> reads 3, 4, …) in every
  // reader, not only those that honour a start override.
  const levels = (ordered, startLevel = -1, start = 1) => Array.from({ length: 9 }, (_, l) => {
    const fmt = ordered ? ORDERED[l % 3] : 'bullet';
    const text = ordered ? `%${l + 1}.` : BULLETS[l % 3];
    return `<w:lvl w:ilvl="${l}"><w:start w:val="${l === startLevel ? start : 1}"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  }).join('');
  let abstracts = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>`;
  const instances = nums.map((n) => {
    if (n.start == null) return `<w:num w:numId="${n.id}"><w:abstractNumId w:val="0"/></w:num>`;
    abstracts += `<w:abstractNum w:abstractNumId="${n.id}"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true, n.level, n.start)}</w:abstractNum>`;
    return `<w:num w:numId="${n.id}"><w:abstractNumId w:val="${n.id}"/><w:lvlOverride w:ilvl="${n.level}"><w:startOverride w:val="${n.start}"/></w:lvlOverride></w:num>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W_NS}">${abstracts}${instances}</w:numbering>`;
}

const heading = (n, size, space) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${space}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="17171A"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:color w:val="1A1A1A"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="17171A"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>${heading(1, 36, 360)}${heading(2, 30, 320)}${heading(3, 26, 280)}${heading(4, 24, 240)}${heading(5, 22, 200)}${heading(6, 22, 200)}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D0D0D7"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:color w:val="4A4A55"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F4F6"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/><w:ind w:left="144" w:right="144"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:i/><w:color w:val="55555F"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:color w:val="1652F0"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F4F4F6"/></w:rPr></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="D0D0D7"/><w:left w:val="single" w:sz="4" w:space="0" w:color="D0D0D7"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D0D0D7"/><w:right w:val="single" w:sz="4" w:space="0" w:color="D0D0D7"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="D0D0D7"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D0D0D7"/></w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;
