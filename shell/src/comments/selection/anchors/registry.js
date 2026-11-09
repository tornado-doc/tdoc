// Anchor adapters by kind. The doc page and the widget ship element, region
// and text-range; a sheet registers its cell-range adapter the same way
// (registerAnchorAdapter('sheet-range', { resolve, rectOf, describe })) without
// touching these files. Framework-free; the doc frame bundles it.
var ADAPTERS = {};

// adapter: { match(anchor) -> bool, resolve(anchor, ctx) -> target|null,
//            rectOf(target, anchor) -> DOMRect-like|null }
export function registerAnchorAdapter(kind, adapter) {
  if (!kind || !adapter || typeof adapter.resolve !== 'function') throw new Error('anchor adapter needs a kind and resolve()');
  ADAPTERS[kind] = adapter;
}

export function anchorAdapters() {
  var out = [];
  for (var kind in ADAPTERS) out.push({ kind: kind, adapter: ADAPTERS[kind] });
  return out;
}

// The adapter for an anchor: one that claims it (match), else one named by
// its kind.
export function adapterFor(anchor) {
  if (!anchor) return null;
  for (var kind in ADAPTERS) {
    var a = ADAPTERS[kind];
    if (a.match && a.match(anchor)) return a;
  }
  return ADAPTERS[anchor.kind] || null;
}
