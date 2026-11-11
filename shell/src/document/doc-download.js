// Download: PDF, Word, Markdown, and for a sheet doc CSV and Excel (flag
// docDownload). The converters load only when a reader picks one:
//   PDF       the browser's print of the reading column (/export), with the
//             print rules below: no tdoc chrome, the author's colours kept,
//             no heading left at the foot of a page, one slide per page.
//   Word      docx-export.mjs, from the document's HTML (the frame sends it).
//   Markdown  the server's /export.md: the same conversion as
//             `Accept: text/markdown`, as a file, the document's text only.
//   CSV/Excel sheet-export.mjs (+ SheetJS, already used for import).
import { readHashView } from './sheet-hash.js';

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadUrl(href, filename) {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

// ---- PDF ---------------------------------------------------------------------

// Added to the export page only while it prints, so every document, baked
// before these rules or after, prints the same way.
export const PRINT_CSS = `@media print {
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; break-inside: avoid; }
  p, li, blockquote { orphans: 3; widows: 3; }
  pre, blockquote, figure, img, svg, tr, .tdoc-callout, [data-tdoc-artifact] { break-inside: avoid; page-break-inside: avoid; }
  img, svg, video, canvas, iframe { max-width: 100% !important; }
  pre { white-space: pre-wrap !important; overflow: visible !important; word-break: break-word; }
  .tdoc-table-scroll { overflow: visible !important; }
  thead { display: table-header-group; }
  table[data-tdoc-sheet] th { position: static !important; }
  html:has([data-tdoc-slide]) body, html:has([data-tdoc-slide]) :is(main, article, .wrap, .content, .container, .deck) { max-width: none !important; margin: 0 !important; padding: 0 !important; }
  [data-tdoc-slide] { page: tdoc-slide; break-after: page; break-inside: avoid; width: 100% !important; max-width: 100% !important; height: auto !important; margin: 0 !important; transform: none !important; }
  [data-tdoc-slide]:last-of-type { break-after: auto; }
  @page tdoc-slide { size: landscape; margin: 10mm; }
}`;

export function printDocument(src, { onDone } = {}) {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  frame.src = src;
  frame.onload = () => {
    try {
      const doc = frame.contentDocument;
      if (doc && doc.head) {
        const style = doc.createElement('style');
        style.id = 'tdoc-print';
        style.textContent = PRINT_CSS;
        doc.head.appendChild(style);
      }
    } catch {}
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    onDone?.();
    window.setTimeout(() => frame.remove(), 1_000);
  };
  document.body.appendChild(frame);
  return frame;
}

// ---- Word --------------------------------------------------------------------

function sniff(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  return '';
}

// Any image the browser can draw, as a PNG the size it would show at.
async function rasterize(blob, size = null) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('image')); img.src = url; });
    const width = (size && size.width) || img.naturalWidth || 600;
    const height = (size && size.height) || img.naturalHeight || Math.round(width * 0.6);
    const scale = Math.min(2, 4096 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png) return null;
    return { bytes: new Uint8Array(await png.arrayBuffer()), type: 'png', width, height };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadImage(src) {
  let url;
  try { url = new URL(src, location.href); } catch { return null; }
  if (!/^(https?:|data:|blob:)$/.test(url.protocol)) return null;
  const own = url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === location.origin;
  const response = await fetch(url.href, own ? { credentials: 'same-origin' } : { mode: 'cors', credentials: 'omit' });
  if (!response.ok) return null;
  const blob = await response.blob();
  if (blob.size > 20 * 1024 * 1024) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const type = sniff(bytes);
  if (!type) return rasterize(blob); // SVG, WebP, AVIF: Word wants PNG
  try {
    const bitmap = await createImageBitmap(blob);
    const out = { bytes, type, width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return out;
  } catch {
    return rasterize(blob);
  }
}

// An inline <svg> figure (a chart, a diagram) drawn to PNG. The document's
// own <style> rules go in with it, so classes the author styled keep their
// colours.
function svgRenderer(doc) {
  const css = Array.prototype.map.call(doc.querySelectorAll('style:not([data-tdoc-provider])'), (s) => s.textContent || '').join('\n').slice(0, 200_000);
  return async (node) => {
    const svg = node.cloneNode(true);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const box = String(node.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const attrPx = (name) => { const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(node.getAttribute(name) || ''); return m ? Number(m[1]) : 0; };
    let width = attrPx('width') || (box.length === 4 ? box[2] : 0) || 600;
    let height = attrPx('height') || (box.length === 4 && box[2] ? (box[3] * width) / box[2] : 0) || Math.round(width * 0.6);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    if (css) {
      const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = css;
      svg.insertBefore(style, svg.firstChild);
    }
    const text = new XMLSerializer().serializeToString(svg);
    return rasterize(new Blob([text], { type: 'image/svg+xml' }), { width, height });
  };
}

export async function buildWord(html, { title, docUrl, baseUrl }) {
  const { htmlToDocx, DOCX_MIME } = await import('./docx-export.mjs');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const bytes = await htmlToDocx(doc, { title, docUrl, baseUrl, loadImage, renderSvg: svgRenderer(doc) });
  return new Blob([bytes], { type: DOCX_MIME });
}

// ---- Sheets ------------------------------------------------------------------

export async function buildSheetFile(html, kind, { slug }) {
  const mod = await import('./sheet-export.mjs');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const sheets = mod.sheetsFromDocument(doc);
  if (!sheets.length) throw new Error('This document has no sheet to download.');
  if (kind === 'csv') {
    let active = '';
    try {
      const { decodeView } = await import('../../../shared/sheet-query.mjs');
      active = decodeView(readHashView()).active;
    } catch {}
    const sheet = mod.activeSheet(sheets, active);
    return { blob: new Blob([mod.sheetCsv(sheet)], { type: `${mod.CSV_MIME};charset=utf-8` }), filename: mod.sheetFileName(slug, sheet, sheets, 'csv') };
  }
  const XLSX = await import('xlsx/dist/xlsx.mini.min.js').then((m) => m.default || m);
  return { blob: new Blob([mod.xlsxBytes(XLSX, sheets)], { type: mod.XLSX_MIME }), filename: `${slug}.xlsx` };
}
