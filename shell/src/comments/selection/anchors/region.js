// A box drawn over part of an element (a chart, an image, a slide): stored
// as fractions of the element, so it follows the element when it resizes.
// Framework-free; the doc frame bundles it.
import { describeElement, selectorFor, shownText } from './element.js';

export function toRect(r) {
  return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height };
}
export function rectContains(outer, inner, slack) {
  var s = slack == null ? 2 : slack;
  return inner.left >= outer.left - s && inner.top >= outer.top - s && inner.right <= outer.right + s && inner.bottom <= outer.bottom + s;
}
export function rectOverlap(a, b) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}
export function boxBetween(a, b) {
  return toRect({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
}

// The smallest element that holds the whole box, from what is under its
// middle up. `elementAt(x, y)` is the caller's (it knows its own overlays).
export function enclosingFor(box, elementAt, root) {
  var stop = (root && root.body) || document.body;
  var el = elementAt(box.left + box.width / 2, box.top + box.height / 2);
  for (; el && el !== stop && el !== document.documentElement; el = el.parentElement) {
    if (rectContains(el.getBoundingClientRect(), box)) return el;
  }
  return stop;
}

// The words the box covers, in reading order.
export function textUnder(box, container, exclude) {
  var out = [];
  var length = 0;
  var skip = exclude || function () { return false; };
  var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  var range = document.createRange();
  for (var node = walker.nextNode(); node && length < 500; node = walker.nextNode()) {
    var parent = node.parentElement;
    if (!parent || skip(parent) || parent.closest('script,style,noscript,template') || !node.textContent.trim()) continue;
    range.selectNodeContents(node);
    var rects = range.getClientRects();
    var hit = false;
    for (var i = 0; i < rects.length; i++) if (rectOverlap(toRect(rects[i]), box) > 0) { hit = true; break; }
    if (!hit) continue;
    var words = node.textContent.replace(/\s+/g, ' ').trim();
    out.push(words); length += words.length + 1;
  }
  return out.join(' ').slice(0, 500);
}

// The named things mostly inside the box (a button, a canvas, a heading),
// what an agent can look for in the code.
var MEANINGFUL = 'a,button,input,select,textarea,label,img,svg,canvas,video,iframe,h1,h2,h3,h4,h5,h6,li,td,th,[role],[id],[aria-label],[data-testid]';
export function elementsUnder(box, container, exclude) {
  var out = [];
  var seen = [];
  var skip = exclude || function () { return false; };
  var nodes = [container].concat(Array.prototype.slice.call(container.querySelectorAll(MEANINGFUL), 0, 3000));
  for (var i = 0; i < nodes.length && out.length < 8; i++) {
    var el = nodes[i];
    if (el === container || skip(el) || (el.closest && el.closest('svg') && el.localName !== 'svg')) continue;
    var r = el.getBoundingClientRect();
    var area = r.width * r.height;
    if (!area || rectOverlap(toRect(r), box) / area < 0.6) continue;
    if (seen.some(function (parent) { return parent.contains(el); })) continue;
    seen.push(el);
    var item = { selector: selectorFor(el), tag: el.localName };
    var text = shownText(el).slice(0, 80);
    if (text) item.text = text;
    var name = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title');
    if (name) item.name = name.slice(0, 80);
    out.push(item);
  }
  return out;
}

// Fractions of the container, rounded and kept inside it.
function round4(n) { return Math.max(0, Math.min(1, Math.round(n * 10000) / 10000)); }

// The anchor for a box: the container's own description, the box in
// pixels and as fractions of the container, and what is under it.
// `text` is the text under the box: what every reader of an anchor shows.
export function regionOf(box, container, options) {
  var exclude = options && options.exclude;
  var base = (options && options.describe) ? options.describe(container) : describeElement(container);
  var c = container.getBoundingClientRect();
  var text = textUnder(box, container, exclude);
  var elements = elementsUnder(box, container, exclude);
  var rel = { x: Math.round(box.left - c.left), y: Math.round(box.top - c.top), width: Math.round(box.width), height: Math.round(box.height) };
  var frac = c.width && c.height
    ? { x: round4((box.left - c.left) / c.width), y: round4((box.top - c.top) / c.height), width: round4(box.width / c.width), height: round4(box.height / c.height) }
    : null;
  var what = text
    ? '“' + text.slice(0, 48) + (text.length > 48 ? '…' : '') + '”'
    : (elements[0] ? (elements[0].name || elements[0].tag) : (base.accessible_name || base.tag));
  var out = {};
  for (var k in base) out[k] = base[k];
  out.text = text;
  out.label = 'Area ' + rel.width + '×' + rel.height + ' · ' + what;
  out.region = { container_text: base.text, container_rect: base.rect, rel: rel, frac: frac, elements: elements };
  return out;
}

// Where a box is on screen now: its fractions of the element's box.
export function regionRect(anchor, el) {
  var region = anchor && anchor.region;
  if (!region || !el) return null;
  var c = el.getBoundingClientRect();
  if (region.frac) {
    return toRect({ left: c.left + region.frac.x * c.width, top: c.top + region.frac.y * c.height, width: region.frac.width * c.width, height: region.frac.height * c.height });
  }
  var rel = region.rel || {};
  return toRect({ left: c.left + (rel.x || 0), top: c.top + (rel.y || 0), width: rel.width || 0, height: rel.height || 0 });
}
