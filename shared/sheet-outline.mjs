// Sheets: the structure half. Row groups (an outline up to three levels
// deep), hidden rows and columns, and frozen rows and columns, as plain
// attributes on the sheet's own markup:
//
//   <table data-tdoc-sheet data-name="Budget" data-freeze-rows="1" data-freeze-cols="2">
//   <th data-key="c4" data-hidden>                                a column
//   <tr data-row="r7" data-group="2" data-collapsed="2">          a row
//
// data-group="1".."3" is a row's outline level. A group is a run of
// neighbouring rows at that level or deeper, so nested groups are runs inside
// runs, as in Excel and Google Sheets. data-collapsed on a group's first row
// lists the levels whose group starting there is collapsed by default: the
// default an editor saves. (The functions take any axis; the viewer groups
// rows only for now.) A reader's own expand / collapse is
// view state (the shell keeps it beside the #hash), never in the document.
// data-hidden hides a row or column for everyone until an editor unhides it.
// data-freeze-rows / data-freeze-cols freeze that many rows / columns
// (columns default to 1, the first, as before this markup existed).
//
// Every attribute is read through a cleaner: an unknown or out-of-range value
// reads as the default, so author HTML can never put a style or a script
// into the grid. Pure functions plus attribute writers on elements, no
// imports: inlined into the frame viewer like sheet-markup.mjs.

export const MAX_LEVEL = 3;
export const MAX_FREEZE = 10;
export function cleanLevel(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(MAX_LEVEL, n) : 0;
}
export function cleanFreeze(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(MAX_FREEZE, n) : fallback;
}
// "1 2" → bitmask of levels (bit L-1); anything else is dropped.
export function parseCollapsed(attr) {
  let mask = 0;
  String(attr || '').split(/[\s,]+/).forEach((p) => { const l = cleanLevel(p); if (l && String(l) === p) mask |= 1 << (l - 1); });
  return mask;
}
export function formatCollapsed(mask) {
  const out = [];
  for (let l = 1; l <= MAX_LEVEL; l++) if (mask & (1 << (l - 1))) out.push(l);
  return out.join(' ');
}

// ---- reading (DOM) -------------------------------------------------------------

// One axis (rows: their <tr>s, columns: their <th>s) as typed arrays.
export function readAxis(elements) {
  const n = elements.length;
  const level = new Uint8Array(n), hidden = new Uint8Array(n), collapsed = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const el = elements[i];
    if (!el || !el.hasAttribute) continue;
    // The fast path on a 10,000-row sheet: most rows carry none of these.
    if (el.hasAttribute('data-group')) { level[i] = cleanLevel(el.getAttribute('data-group')); if (level[i]) any = true; }
    if (el.hasAttribute('data-hidden')) { hidden[i] = 1; any = true; }
    if (el.hasAttribute('data-collapsed')) collapsed[i] = parseCollapsed(el.getAttribute('data-collapsed'));
  }
  return { level, hidden, collapsed, any };
}
export function readTable(table) {
  return {
    freezeRows: cleanFreeze(table.getAttribute('data-freeze-rows'), 0),
    freezeCols: cleanFreeze(table.getAttribute('data-freeze-cols'), 1),
  };
}

// ---- groups ------------------------------------------------------------------------

// Every group of an axis, outermost first within each start:
// [{ level, start, end, parent }], start/end inclusive in document order.
// parent is the index of the enclosing group one level up (-1 at level 1).
export function groupsOf(level) {
  const n = level.length, out = [];
  let open = [-1, -1, -1, -1];
  for (let i = 0; i <= n; i++) {
    const l = i < n ? level[i] : 0;
    // Close the groups deeper than this position's level, innermost first.
    for (let L = MAX_LEVEL; L >= 1; L--) {
      if (open[L] >= 0 && l < L) { out[open[L]].end = i - 1; open[L] = -1; }
    }
    for (let L = 1; L <= l; L++) {
      if (open[L] < 0) { open[L] = out.length; out.push({ level: L, start: i, end: i, parent: L > 1 ? open[L - 1] : -1 }); }
    }
  }
  return out;
}
export function maxLevel(groups) {
  let m = 0;
  for (let g = 0; g < groups.length; g++) if (groups[g].level > m) m = groups[g].level;
  return m;
}
// A group's key in view state: its level and its first row's id (column's key).
export function groupKey(group, ids) { return group.level + ':' + (ids[group.start] || '#' + group.start); }

// Is group g collapsed? The reader's own choice where they made one, else the
// document's default on its first element.
export function isCollapsed(group, axis, ids, view) {
  const k = groupKey(group, ids);
  if (view && Object.prototype.hasOwnProperty.call(view, k)) return !!view[k];
  return !!(axis.collapsed[group.start] & (1 << (group.level - 1)));
}

// 1 where an element is shown: not hidden, not inside a collapsed group.
export function shownMask(axis, groups, ids, view) {
  const n = axis.level.length, shown = new Uint8Array(n);
  for (let i = 0; i < n; i++) shown[i] = axis.hidden[i] ? 0 : 1;
  for (let g = 0; g < groups.length; g++) {
    const gr = groups[g];
    if (!isCollapsed(gr, axis, ids, view)) continue;
    for (let i = gr.start; i <= gr.end; i++) shown[i] = 0;
  }
  return shown;
}

// The view order with hidden rows out, and (unless `flat`: a sort is on, so
// groups do not hold together) rows in collapsed groups out too.
export function applyToOrder(order, axis, shown, flat) {
  if (!axis.any) return order;
  const out = [];
  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    if (flat ? !axis.hidden[r] : shown[r]) out.push(r);
  }
  return Int32Array.from ? Int32Array.from(out) : out;
}

// Where each group sits in a view that keeps document order (no sort):
// for every group with a row the filters let through, its first and last
// shown positions (i0..i1, empty when collapsed) and `at`, the position its
// marker goes at (the first shown row after it starts). Hidden runs too.
// order: the view order (shown rows), pass: 1 where the filters let a row through.
export function spans(groups, axis, ids, view, order, pass) {
  const n = axis.level.length;
  // next[r]: the view position of the first shown row at or after r.
  const posOf = new Int32Array(n).fill(-1);
  for (let i = 0; i < order.length; i++) posOf[order[i]] = i;
  const next = new Int32Array(n + 1);
  next[n] = order.length;
  for (let r = n - 1; r >= 0; r--) next[r] = posOf[r] >= 0 ? posOf[r] : next[r + 1];
  // passCount prefix: how many rows the filters let through before r.
  const pre = new Int32Array(n + 1);
  for (let r = 0; r < n; r++) pre[r + 1] = pre[r] + (pass ? pass[r] : 1);
  const collapsed = groups.map((g) => isCollapsed(g, axis, ids, view));
  const out = [];
  for (let g = 0; g < groups.length; g++) {
    const gr = groups[g];
    const count = pre[gr.end + 1] - pre[gr.start];
    if (!count) continue;
    // Inside a collapsed group: its outer marker stands for it.
    let p = gr.parent, under = false;
    while (p >= 0) { if (collapsed[p]) { under = true; break; } p = groups[p].parent; }
    if (under) continue;
    const i0 = next[gr.start], i1 = next[gr.end + 1] - 1;
    out.push({ g, level: gr.level, collapsed: collapsed[g], at: i0, i0, i1: collapsed[g] ? i0 - 1 : i1, count, key: groupKey(gr, ids) });
  }
  // Runs of hidden rows (not in a collapsed group): a marker each.
  const hiddenRuns = [];
  for (let r = 0; r < n; r++) {
    if (!axis.hidden[r]) continue;
    const s = r;
    while (r + 1 < n && axis.hidden[r + 1]) r++;
    hiddenRuns.push({ start: s, end: r, at: next[s], count: r - s + 1 });
  }
  return { groups: out, hidden: hiddenRuns };
}

// Which groups to collapse to show only levels below `k` (Excel's level
// buttons): k = 1 shows only rows outside every group, maxLevel + 1 all.
export function viewForLevel(groups, ids, k) {
  const view = {};
  groups.forEach((g) => { view[groupKey(g, ids)] = g.level >= k; });
  return view;
}

// ---- changing structure (pure) ---------------------------------------------------

// The levels after grouping (delta 1) or ungrouping (-1) the range a..b.
export function regroup(level, a, b, delta) {
  const out = Uint8Array.from(level);
  for (let i = Math.max(0, a); i <= Math.min(level.length - 1, b); i++) out[i] = Math.max(0, Math.min(MAX_LEVEL, out[i] + delta));
  return out;
}

// ---- writing (DOM attributes, and markup strings) ---------------------------------

export function writeLevel(el, level) {
  const l = cleanLevel(level);
  if (l) el.setAttribute('data-group', String(l)); else el.removeAttribute('data-group');
  // A collapsed default deeper than the element's level means nothing.
  const c = parseCollapsed(el.getAttribute('data-collapsed')) & ((1 << l) - 1);
  if (c) el.setAttribute('data-collapsed', formatCollapsed(c)); else el.removeAttribute('data-collapsed');
}
export function writeHidden(el, hidden) {
  if (hidden) el.setAttribute('data-hidden', ''); else el.removeAttribute('data-hidden');
}
export function writeCollapsed(el, level, on) {
  let c = parseCollapsed(el.getAttribute('data-collapsed'));
  const bit = 1 << (cleanLevel(level) - 1);
  c = on ? c | bit : c & ~bit;
  if (c) el.setAttribute('data-collapsed', formatCollapsed(c)); else el.removeAttribute('data-collapsed');
}
export function writeFreeze(table, rows, cols) {
  if (rows !== undefined) { const r = cleanFreeze(rows, 0); if (r) table.setAttribute('data-freeze-rows', String(r)); else table.removeAttribute('data-freeze-rows'); }
  if (cols !== undefined) { const c = cleanFreeze(cols, 1); if (c === 1) table.removeAttribute('data-freeze-cols'); else table.setAttribute('data-freeze-cols', String(c)); }
}
// The same attributes as markup, for writers that build strings (an
// importer): { level, hidden, collapsed: [levels] } → ' data-group="2" …'.
export function structureAttrs(o) {
  const l = cleanLevel(o && o.level);
  let mask = 0;
  ((o && o.collapsed) || []).forEach((x) => { const v = cleanLevel(x); if (v && v <= l) mask |= 1 << (v - 1); });
  return (l ? ` data-group="${l}"` : '') + (mask ? ` data-collapsed="${formatCollapsed(mask)}"` : '') + (o && o.hidden ? ' data-hidden' : '');
}
