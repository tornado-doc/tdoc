// Sheets: cell styles to and from an .xlsx file. SheetJS (the community
// build tdoc ships) writes number formats and merged cells but not cell
// styles, and reads a cell's fill but not its font, alignment or borders.
// So this reads and writes those parts of the workbook's XML itself, through
// the zip reader SheetJS carries (XLSX.CFB):
//
//   export: styleXlsx(XLSX, bytes, sheets) adds bold / italic /
//     strikethrough, text colour, fill, borders and alignment to the cells of
//     a workbook SheetJS wrote (its number formats kept);
//   import: readXlsxStyles(XLSX, wb) gives each worksheet's cell styles as
//     tdoc formats (shared/sheet-format.mjs), colours to the nearest palette
//     colour, from a workbook read with { bookFiles: true }.
//
// Colours are the palette's (shared/sheet-query.mjs TAG_COLORS): an export
// writes them as RGB, an import maps any RGB or theme colour to the nearest
// one (near-white fills and near-black text are no colour).
import { TAG_COLORS } from './sheet-query.mjs';
import { COLORS, EDGES } from './sheet-format.mjs';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder('utf-8').decode(b);
const rgbOf = (hex) => `FF${hex.replace('#', '').toUpperCase()}`;

export function colName(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
function colIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

// Parts read at most this large, and lists at most this long: a crafted
// workbook costs bounded time (Excel itself caps cell formats at 64,000).
export const MAX_PART = 8 * 1024 * 1024;
export const MAX_ITEMS = 65000;

// The inner text of the first <tag …>…</tag> (or '' ), by plain search.
function block(xml, tag) {
  let i = 0;
  for (;;) {
    i = xml.indexOf(`<${tag}`, i);
    if (i === -1) return '';
    const ch = xml.charAt(i + tag.length + 1);
    if (ch === '>' || ch === ' ' || ch === '/' || ch === '\n' || ch === '\t' || ch === '\r') break;
    i += tag.length + 1;
  }
  const gt = xml.indexOf('>', i);
  if (gt === -1 || xml.charAt(gt - 1) === '/') return '';
  const end = xml.indexOf(`</${tag}>`, gt);
  return end === -1 ? '' : xml.slice(gt + 1, end);
}
// Each <tag …/> or <tag …>…</tag> in `inner`, in one forward pass (no
// backtracking regex), at most MAX_ITEMS.
function items(inner, tag) {
  const out = [];
  let i = 0;
  while (out.length < MAX_ITEMS) {
    i = inner.indexOf(`<${tag}`, i);
    if (i === -1) break;
    const ch = inner.charAt(i + tag.length + 1);
    if (!(ch === '>' || ch === ' ' || ch === '/' || ch === '\n' || ch === '\t' || ch === '\r')) { i += tag.length + 1; continue; }
    const gt = inner.indexOf('>', i);
    if (gt === -1) break;
    if (inner.charAt(gt - 1) === '/') { out.push(inner.slice(i, gt + 1)); i = gt + 1; continue; }
    const end = inner.indexOf(`</${tag}>`, gt);
    if (end === -1) break;
    out.push(inner.slice(i, end + tag.length + 3));
    i = end + tag.length + 3;
  }
  return out;
}

function entry(cfb, path) {
  for (let i = 0; i < cfb.FullPaths.length; i++) if (cfb.FullPaths[i].replace(/^Root Entry\//, '').replace(/^\//, '') === path) return cfb.FileIndex[i];
  return null;
}

// ---- export -------------------------------------------------------------------

// The style part of a format (what SheetJS does not write), as a key, or ''.
function styleKey(f) {
  if (!f) return '';
  const parts = [f.b ? 'b' : '', f.i ? 'i' : '', f.s ? 's' : '', f.color || '', f.fill || '', f.align || '', f.valign || '', f.border || ''];
  return parts.some(Boolean) ? parts.join('|') : '';
}

// sheets: [{ cells: Map('A2' → format) }] in workbook order. The bytes of
// the same workbook with those styles; unchanged when there are none.
export function styleXlsx(XLSX, bytes, sheets) {
  if (!sheets.some((s) => s.cells && s.cells.size)) return bytes;
  const cfb = XLSX.CFB.read(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { type: 'buffer' });
  const stylesEntry = entry(cfb, 'xl/styles.xml');
  if (!stylesEntry) return bytes;
  let styles = dec(stylesEntry.content);
  const fonts = items(block(styles, 'fonts'), 'font');
  const fills = items(block(styles, 'fills'), 'fill');
  const borders = items(block(styles, 'borders'), 'border');
  const xfs = items(block(styles, 'cellXfs'), 'xf');
  const fontAt = new Map(), fillAt = new Map(), borderAt = new Map(), xfAt = new Map();
  const font = (f) => {
    const key = `${f.b ? 'b' : ''}${f.i ? 'i' : ''}${f.s ? 's' : ''}:${f.color || ''}`;
    if (key === ':') return 0;
    if (!fontAt.has(key)) {
      const color = f.color ? `<color rgb="${rgbOf(TAG_COLORS[f.color][1])}"/>` : '<color theme="1"/>';
      fonts.push(`<font>${f.b ? '<b/>' : ''}${f.i ? '<i/>' : ''}${f.s ? '<strike/>' : ''}<sz val="12"/>${color}<name val="Calibri"/><family val="2"/><scheme val="minor"/></font>`);
      fontAt.set(key, fonts.length - 1);
    }
    return fontAt.get(key);
  };
  const fill = (name) => {
    if (!name) return 0;
    if (!fillAt.has(name)) {
      fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${rgbOf(TAG_COLORS[name][0])}"/><bgColor indexed="64"/></patternFill></fill>`);
      fillAt.set(name, fills.length - 1);
    }
    return fillAt.get(name);
  };
  const border = (edges) => {
    if (!edges) return 0;
    if (!borderAt.has(edges)) {
      const has = (e) => edges.split(' ').indexOf(e) !== -1;
      const side = (tag, e) => (has(e) ? `<${tag} style="thin"><color auto="1"/></${tag}>` : `<${tag}/>`);
      borders.push(`<border>${side('left', 'l')}${side('right', 'r')}${side('top', 't')}${side('bottom', 'b')}<diagonal/></border>`);
      borderAt.set(edges, borders.length - 1);
    }
    return borderAt.get(edges);
  };
  // One cellXfs entry per (SheetJS's own entry, style): its number format kept.
  const xf = (base, f) => {
    const key = `${base}#${styleKey(f)}`;
    if (!xfAt.has(key)) {
      const num = (/numFmtId="(\d+)"/.exec(xfs[base] || '') || [, '0'])[1];
      const fo = font(f), fi = fill(f.fill), bo = border(f.border);
      const al = f.align || f.valign ? `<alignment${f.align ? ` horizontal="${f.align}"` : ''}${f.valign ? ` vertical="${f.valign === 'middle' ? 'center' : f.valign}"` : ''}/>` : '';
      xfs.push(`<xf numFmtId="${num}" fontId="${fo}" fillId="${fi}" borderId="${bo}" xfId="0" applyNumberFormat="1"${fo ? ' applyFont="1"' : ''}${fi ? ' applyFill="1"' : ''}${bo ? ' applyBorder="1"' : ''}${al ? ' applyAlignment="1">' + al + '</xf>' : '/>'}`);
      xfAt.set(key, xfs.length - 1);
    }
    return xfAt.get(key);
  };
  sheets.forEach((sheet, i) => {
    if (!sheet.cells || !sheet.cells.size) return;
    const se = entry(cfb, `xl/worksheets/sheet${i + 1}.xml`);
    if (!se) return;
    const xml = dec(se.content).replace(/<c r="([A-Z]+\d+)"([^>]*?)(\/?)>/g, (m, ref, rest, close) => {
      const f = sheet.cells.get(ref);
      if (!styleKey(f)) return m;
      const s = /\ss="(\d+)"/.exec(rest);
      const base = s ? Number(s[1]) : 0;
      const attrs = rest.replace(/\ss="\d+"/, '');
      return `<c r="${ref}" s="${xf(base, f)}"${attrs}${close}>`;
    });
    se.content = enc(xml);
  });
  const put = (tag, list) => {
    const i = styles.indexOf(`<${tag}`), end = styles.indexOf(`</${tag}>`, i);
    if (i === -1 || end === -1) return;
    styles = `${styles.slice(0, i)}<${tag} count="${list.length}">${list.join('')}</${tag}>${styles.slice(end + tag.length + 3)}`;
  };
  put('fonts', fonts); put('fills', fills); put('borders', borders); put('cellXfs', xfs);
  stylesEntry.content = enc(styles);
  return new Uint8Array(XLSX.CFB.write(cfb, { fileType: 'zip', type: 'array', compression: true }));
}

// ---- import -------------------------------------------------------------------

function hexRgb(hex) {
  const h = String(hex || '').replace(/^#/, '').slice(-6);
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function tint(rgb, t) {
  if (!t) return rgb;
  return rgb.map((v) => Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t));
}
function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue * 60, s, l];
}
const HUES = [['red', 0], ['orange', 30], ['yellow', 52], ['green', 125], ['teal', 172], ['blue', 215], ['purple', 270], ['pink', 325], ['red', 360]];
// The palette colour nearest an RGB colour, or '' for none: a fill near
// white, text near black, are the default.
export function nearestColor(rgb, kind) {
  if (!rgb) return '';
  const [hue, s, l] = hsl(rgb);
  if (kind === 'fill' && l > 0.95) return '';
  if (kind === 'color' && l < 0.22) return '';
  if (s < 0.18 || l > 0.97 || l < 0.08) return 'gray';
  let best = 'gray', d = 999;
  HUES.forEach(([name, at]) => { const x = Math.abs(hue - at); if (x < d) { d = x; best = name; } });
  return COLORS.indexOf(best) !== -1 ? best : '';
}

function attrsOf(tag) {
  const o = {};
  tag.replace(/([\w:]+)="([^"]*)"/g, (m, k, v) => { o[k] = v; return m; });
  return o;
}
// The theme's colours in Excel's index order (lt1, dk1, lt2, dk2, accents…).
function themeColors(xml) {
  const scheme = block(xml || '', 'a:clrScheme');
  if (!scheme) return [];
  const list = [];
  scheme.replace(/<a:(\w+)>\s*<a:(?:srgbClr val|sysClr[^>]*lastClr)="([0-9A-Fa-f]{6})"/g, (m, name, hex) => { list.push(hex); return m; });
  if (list.length >= 4) { const [dk1, lt1, dk2, lt2] = list; list[0] = lt1; list[1] = dk1; list[2] = lt2; list[3] = dk2; }
  return list;
}
function colorOf(tag, theme) {
  if (!tag) return null;
  const a = attrsOf(tag);
  let rgb = a.rgb ? hexRgb(a.rgb) : a.theme != null && theme[Number(a.theme)] ? hexRgb(theme[Number(a.theme)]) : null;
  if (rgb && a.tint) rgb = tint(rgb, Number(a.tint) || 0);
  return rgb;
}

// From a workbook read with { bookFiles: true }: Map(sheet name → Map('A1' →
// format)), only cells with a style worth keeping. Empty when the workbook
// cannot be read this way.
export function readXlsxStyles(XLSX, wb, { maxRows = Infinity } = {}) {
  const out = new Map();
  // A part over MAX_PART is not read (styles.xml of a real workbook is
  // kilobytes); a worksheet's own XML is read only up to its row limit.
  const file = (path, cap = MAX_PART) => {
    const f = wb.files && (wb.files[path] || wb.files[`/${path}`]);
    if (!f || !f.content || f.content.length > cap) return null;
    return dec(f.content instanceof Uint8Array ? f.content : new Uint8Array(f.content));
  };
  try {
    const book = file('xl/workbook.xml'), rels = file('xl/_rels/workbook.xml.rels'), styles = file('xl/styles.xml');
    if (!book || !rels || !styles) return out;
    const theme = themeColors(file('xl/theme/theme1.xml'));
    const fonts = items(block(styles, 'fonts'), 'font').map((x) => {
      const on = (t) => new RegExp(`<${t}(?:\\s+val="(?:1|true)")?\\s*/>`).test(x);
      const rgb = colorOf((/<color\b[^>]*\/>/.exec(x) || [])[0], theme);
      return { b: on('b'), i: on('i'), s: on('strike'), color: nearestColor(rgb, 'color') };
    });
    const fills = items(block(styles, 'fills'), 'fill').map((x) => {
      if (!/patternType="solid"/.test(x)) return '';
      return nearestColor(colorOf((/<fgColor\b[^>]*\/>/.exec(x) || [])[0], theme), 'fill');
    });
    const borders = items(block(styles, 'borders'), 'border').map((x) => {
      const has = (side) => new RegExp(`<${side}\\s+style="(?!none)[^"]+"`).test(x);
      return EDGES.filter((e) => has({ t: 'top', r: 'right', b: 'bottom', l: 'left' }[e])).join(' ');
    });
    const xfs = items(block(styles, 'cellXfs'), 'xf').map((x) => {
      const a = attrsOf(x.slice(0, x.indexOf('>') + 1));
      const al = attrsOf((/<alignment\b[^>]*>/.exec(x) || [''])[0]);
      const fo = fonts[Number(a.fontId) || 0] || {};
      const f = {};
      if (fo.b) f.b = true; if (fo.i) f.i = true; if (fo.s) f.s = true; if (fo.color) f.color = fo.color;
      const fi = fills[Number(a.fillId) || 0]; if (fi) f.fill = fi;
      const bo = borders[Number(a.borderId) || 0]; if (bo) f.border = bo;
      if (['left', 'center', 'right'].indexOf(al.horizontal) !== -1) f.align = al.horizontal;
      const v = { top: 'top', center: 'middle', bottom: 'bottom' }[al.vertical];
      if (v && v !== 'bottom') f.valign = v; // bottom is Excel's default
      return Object.keys(f).length ? f : null;
    });
    if (!xfs.some(Boolean)) return out;
    const targets = {};
    rels.replace(/<Relationship\b[^>]*>/g, (tag) => { const a = attrsOf(tag); if (a.Id && a.Target) targets[a.Id] = a.Target.replace(/^\/?xl\//, '').replace(/^\//, ''); return tag; });
    book.replace(/<sheet\b[^>]*>/g, (tag) => {
      const a = attrsOf(tag);
      const target = targets[a['r:id']];
      // The worksheet part SheetJS already read (its size is the import's
      // own limit); scanned once, cell tags only, up to the row limit.
      const xml = target && file(`xl/${target}`, Infinity);
      if (!xml) return tag;
      const cells = new Map();
      const re = /<c r="([A-Z]{1,3})(\d{1,7})"([^>]*)>/g;
      let m;
      while ((m = re.exec(xml))) {
        if (Number(m[2]) > maxRows) break;
        const sm = /\ss="(\d{1,5})"/.exec(m[3]);
        const f = sm && xfs[Number(sm[1])];
        if (f) cells.set(m[1] + m[2], f);
      }
      if (cells.size) out.set(a.name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"), cells);
      return tag;
    });
  } catch {
    return new Map();
  }
  return out;
}
export { colIndex };
