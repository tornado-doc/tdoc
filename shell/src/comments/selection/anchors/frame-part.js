// What tdoc's doc frame says it picked, for the feedback widget on tdoc's own
// doc page (feedbackDocFramePick; feedback/src/main.jsx, server/frame-probe.js
// tdoc:fb*). The frame runs inside the author's document, so its answers are
// rebuilt here field by field: known keys only, strings on one line and cut,
// numbers finite, and the whole part small enough to store (ANCHOR_MAX_BYTES).
// Framework-free.

const fnum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
// Strings from the frame: one line (whitespace runs → one space), cut.
const fstr = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
export function cleanRect(r) {
  if (!r || typeof r !== 'object') return null;
  return { left: fnum(r.left), top: fnum(r.top), width: Math.max(0, fnum(r.width)), height: Math.max(0, fnum(r.height)) };
}
export function cleanBox(r, keys = ['x', 'y', 'width', 'height']) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  for (const k of keys) out[k] = fnum(r[k]);
  return out;
}
export function cleanFlat(o, max = 200) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 12)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (typeof v === 'string') out[fstr(k, 40)] = fstr(v, max);
    else if (typeof v === 'number' && Number.isFinite(v)) out[fstr(k, 40)] = v;
    else if (typeof v === 'boolean') out[fstr(k, 40)] = v;
  }
  return out;
}
// What the frame picked, as the anchor's `frame` part.
export function cleanFrameAnchor(a) {
  if (!a || typeof a !== 'object') return null;
  const out = { selector: fstr(a.selector, 500), tag: fstr(a.tag, 40), text: fstr(a.text, 500), accessible_name: fstr(a.accessible_name, 200) };
  if (!out.selector && !out.text) return null;
  if (a.label) out.label = fstr(a.label, 120);
  if (a.container) out.container = cleanFlat(a.container);
  if (a.container_is_target === true) out.container_is_target = true;
  if (a.rect) out.rect = cleanBox(a.rect);
  if (a.quote && typeof a.quote === 'object' && typeof a.quote.text === 'string' && a.quote.text.trim()) {
    out.quote = {
      text: fstr(a.quote.text, 2000), context_before: fstr(a.quote.context_before, 300), context_after: fstr(a.quote.context_after, 300),
      occurrence: Number.isInteger(a.quote.occurrence) ? a.quote.occurrence : null,
      occurrences: Number.isInteger(a.quote.occurrences) ? a.quote.occurrences : null,
    };
  }
  if (a.region && typeof a.region === 'object') {
    const r = a.region;
    out.region = {
      container_text: fstr(r.container_text, 500),
      rel: cleanBox(r.rel), frac: cleanBox(r.frac),
      elements: Array.isArray(r.elements) ? r.elements.slice(0, 8).map((e) => cleanFlat(e, 80)).filter(Boolean) : [],
    };
  }
  return fitFrameAnchor(out);
}
// A frame part that fits in a stored anchor (the server's ANCHOR_MAX_BYTES,
// 8192, with the outer context): what is under a box goes first, then the
// container, then the words around a quote, then the text itself.
export const FRAME_ANCHOR_BUDGET = 4096;
export function fitFrameAnchor(a) {
  const size = () => JSON.stringify(a).length;
  if (size() <= FRAME_ANCHOR_BUDGET) return a;
  if (a.region) { a.region.elements = []; a.region.container_text = a.region.container_text.slice(0, 120); }
  if (size() > FRAME_ANCHOR_BUDGET) delete a.container;
  if (size() > FRAME_ANCHOR_BUDGET && a.quote) { a.quote.context_before = a.quote.context_before.slice(-60); a.quote.context_after = a.quote.context_after.slice(0, 60); }
  if (size() > FRAME_ANCHOR_BUDGET) { a.text = a.text.slice(0, 200); a.accessible_name = a.accessible_name.slice(0, 80); }
  if (size() > FRAME_ANCHOR_BUDGET && a.quote) a.quote.text = a.quote.text.slice(0, 1000);
  if (size() > FRAME_ANCHOR_BUDGET) a.selector = a.selector.slice(0, 200);
  return a;
}
// The words to show for it, as for any anchor here.
export function frameLabel(a) {
  if (a.quote) return `“${a.quote.text.slice(0, 48)}${a.quote.text.length > 48 ? '…' : ''}”`;
  if (a.region) return a.label || 'Area';
  const text = String(a.text || '').trim();
  return a.accessible_name || (text ? `${a.tag || 'element'} · “${text.slice(0, 48)}${text.length > 48 ? '…' : ''}”` : (a.tag || 'element'));
}
