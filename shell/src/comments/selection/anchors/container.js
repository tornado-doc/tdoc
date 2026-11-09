// Where an anchor lives: a page of an app, a slide of a deck, later a tab of
// a sheet, or the whole document. Framework-free and dependency-free: the doc
// frame bundles this file into its injected script (server/frame-probe-source.js).

export var SLIDE_SELECTOR = '[data-tdoc-slide]';

// A short, stable hash of a string (FNV-1a, base 36).
export function stableHash(value) {
  var h = 0x811c9dc5;
  var s = String(value || '');
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

function squash(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

// A slide's identity that survives the deck being reordered: the author's
// own id or data-tdoc-slide value when there is one, else a hash of its
// heading (or its first words). Never its position, except to tell apart
// slides that would otherwise share an id (two "Q&A" slides): then the id
// carries its place among those twins ("h:abc~2").
function baseSlideId(slide) {
  var own = slide.getAttribute('data-tdoc-slide');
  if (own && own !== 'true' && own !== '') return 'v:' + own;
  if (slide.id) return 'id:' + slide.id;
  var heading = slide.querySelector && slide.querySelector('h1,h2,h3,h4,[role="heading"]');
  var words = squash(heading ? heading.textContent : slide.textContent).slice(0, 160);
  return words ? 'h:' + stableHash(words) : '';
}
function twinsOf(slide, base) {
  var doc = slide.ownerDocument || document;
  var all = doc.querySelectorAll(SLIDE_SELECTOR);
  var out = [];
  for (var i = 0; i < all.length; i++) if (baseSlideId(all[i]) === base) out.push(all[i]);
  return out;
}
export function slideId(slide) {
  if (!slide || slide.nodeType !== 1) return '';
  var base = baseSlideId(slide);
  if (!base) return '';
  var twins = twinsOf(slide, base);
  return twins.length > 1 ? base + '~' + (twins.indexOf(slide) + 1) : base;
}

// The container an element sits in, if it is one tdoc knows ({kind, id}).
export function containerFor(el) {
  var node = el && el.nodeType === 3 ? el.parentElement : el;
  var slide = node && node.closest ? node.closest(SLIDE_SELECTOR) : null;
  if (slide) { var id = slideId(slide); if (id) return { kind: 'slide', id: id }; }
  return null;
}

// The element a container id names now, wherever the deck has put it:
// { element, approximate }. An exact id is certain. When it is gone but
// slides with its base id remain (a twin was added or removed), the one at
// the same place among them is a guess, and says so.
export function matchContainer(container, root) {
  if (!container || container.kind !== 'slide' || !container.id) return { element: null, approximate: false };
  var scope = root || document;
  var slides = scope.querySelectorAll ? scope.querySelectorAll(SLIDE_SELECTOR) : [];
  for (var i = 0; i < slides.length; i++) if (slideId(slides[i]) === container.id) return { element: slides[i], approximate: false };
  var m = /^(.*?)(?:~(\d+))?$/.exec(container.id);
  var base = m[1], place = Number(m[2] || 1);
  var twins = [];
  for (var j = 0; j < slides.length; j++) if (baseSlideId(slides[j]) === base) twins.push(slides[j]);
  if (!twins.length) return { element: null, approximate: false };
  return { element: twins[Math.min(place, twins.length) - 1], approximate: true };
}
export function findContainer(container, root) {
  return matchContainer(container, root).element;
}

// One key per container, for grouping lists and counting "N comments on this
// slide": the page of a product anchor, the slide, a sheet's tab, else the
// whole document. Anchors from before containers existed group by page, or
// fall under the document.
export function containerKey(anchor) {
  if (!anchor || anchor.kind === 'document') return 'document';
  if (anchor.kind === 'product') return 'page:' + (anchor.url || '');
  var c = anchor.container;
  if (c && c.kind && c.id) return c.kind + ':' + c.id;
  // A sheet's anchor names its table ({ table, row, key }, sheets #973), or
  // a tab by name.
  if (anchor.sheet) return 'sheet:' + (typeof anchor.sheet === 'object' ? (anchor.sheet.table || '') : anchor.sheet);
  return 'body';
}
