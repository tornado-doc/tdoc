// Sheet embeds: a page shows a live view of a standalone sheet doc BY
// REFERENCE, the way a linked Google Sheet sits in a Google Doc. The page
// holds only the reference; the sheet stays the single source of truth.
//
//   <figure data-tdoc-embed="sheet" data-src="/d/q3-pipeline" data-tab="Deals"
//           data-view="<the #sheet= view of a sheet link>" data-rows="10">
//     <a href="/d/q3-pipeline">Q3 pipeline</a>
//   </figure>
//
// Without the viewer (an export, a feed reader, an old version in the
// compare) the figure is its link. With it, the doc frame asks the shell
// for the sheet's data; the shell asks the server, which applies the SHEET's
// access rules for the person reading (server: /api/embed/sheet), and the
// frame draws the rows as text. No HTML from the sheet ever runs in the page.
//
// This file is the reference half: reading and validating a reference. It
// inlines into the frame probe (server/frame-probe-source.js), so: no
// imports, `export` on declarations only. The data half (pulling one tab's
// rows out of a sheet's HTML) is shared/sheet-embed-data.mjs.

export const EMBED_ATTR = 'data-tdoc-embed';
export const EMBED_SELECTOR = '[data-tdoc-embed="sheet"]';
// Rows an embed shows: data-rows, clamped. The sheet page has the rest.
export const EMBED_DEFAULT_ROWS = 10;
export const EMBED_MAX_ROWS = 50;
// Columns an embed shows at most (data-columns may pick which).
export const EMBED_MAX_COLUMNS = 12;
// Embeds one page may ask for: one request each.
export const EMBED_MAX_PER_PAGE = 20;
const MAX_TAB_CHARS = 200;
const MAX_VIEW_CHARS = 4000;
const MAX_COLUMNS_CHARS = 1000;

// A slug as the server stores it (worker isValidSlug).
export function isEmbedSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
}

function clean(value, max) {
  // Control characters out; the rest is text the server validates again.
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

// data-src → { slug, tab, view } or null. Only a tdoc doc address resolves:
//   q3-pipeline                     a bare slug
//   /d/q3-pipeline                  the doc's path (what agents write)
//   /d/q3-pipeline?sheet=2          the sheet page of tab 2 (1-based)
//   /d/q3-pipeline#sheet=<view>     a link to a filtered view
//   https://<host>/d/q3-pipeline    a full link, when `host` is one of `hosts`
// Anything else (another site, /d/<slug>/v/3, a path that is not a doc) is
// null: an embed is always the sheet's latest version on this tdoc, and
// nothing is ever fetched from an address the page names.
export function parseEmbedSrc(src, hosts) {
  const s = clean(src, 600);
  if (!s) return null;
  if (isEmbedSlug(s)) return { slug: s, tab: 0, view: '' };
  let rest = s;
  const abs = /^https?:\/\/([^/?#]+)(\/[^]*)?$/i.exec(s);
  if (abs) {
    const host = abs[1].toLowerCase();
    const allowed = (Array.isArray(hosts) ? hosts : []).map((h) => String(h || '').toLowerCase());
    if (!allowed.includes(host)) return null;
    rest = abs[2] || '';
  }
  const m = /^\/d\/([a-z0-9][a-z0-9-]{0,63})\/?(\?[^#]*)?(#.*)?$/.exec(rest);
  if (!m) return null;
  let tab = 0;
  if (m[2]) {
    const n = Number(/[?&]sheet=(\d{1,4})(?:&|$)/.exec(m[2])?.[1]);
    if (Number.isInteger(n) && n > 0 && n <= 1000) tab = n;
  }
  let view = '';
  if (m[3]) {
    const hv = /[#&]sheet=([^&]*)/.exec(m[3]);
    if (hv) view = hv[1].slice(0, MAX_VIEW_CHARS);
  }
  return { slug: m[1], tab, view };
}

function clampRows(value) {
  const n = Number(String(value == null ? '' : value).trim());
  if (!Number.isFinite(n) || n < 1) return EMBED_DEFAULT_ROWS;
  return Math.min(EMBED_MAX_ROWS, Math.floor(n));
}

// One reference, from an element's attributes (`get(name)` returns an
// attribute or null): { slug, tab, tabIndex, view, rows, columns } or null
// when it names no doc this tdoc can resolve.
export function readEmbedRef(get, hosts) {
  if (clean(get(EMBED_ATTR), 20).toLowerCase() !== 'sheet') return null;
  const src = parseEmbedSrc(get('data-src'), hosts);
  if (!src) return null;
  const view = clean(get('data-view'), MAX_VIEW_CHARS) || src.view;
  const columns = clean(get('data-columns'), MAX_COLUMNS_CHARS);
  return {
    slug: src.slug,
    tab: clean(get('data-tab'), MAX_TAB_CHARS),
    tabIndex: src.tab,
    view,
    rows: clampRows(get('data-rows')),
    columns,
  };
}

// The same reference as a request (what the shell sends the server, and
// what the server reads back): every value checked and bounded again.
export function embedQuery(ref) {
  const out = new URLSearchParams();
  out.set('slug', ref.slug);
  if (ref.tab) out.set('tab', ref.tab);
  if (ref.tabIndex) out.set('sheet', String(ref.tabIndex));
  if (ref.view) out.set('view', ref.view);
  out.set('rows', String(ref.rows || EMBED_DEFAULT_ROWS));
  if (ref.columns) out.set('columns', ref.columns);
  return out.toString();
}

// URLSearchParams (or anything with get) → a reference, or null.
export function embedRefFromQuery(params) {
  const slug = clean(params.get('slug'), 64);
  if (!isEmbedSlug(slug)) return null;
  const n = Number(clean(params.get('sheet'), 5));
  return {
    slug,
    tab: clean(params.get('tab'), MAX_TAB_CHARS),
    tabIndex: Number.isInteger(n) && n > 0 && n <= 1000 ? n : 0,
    view: clean(params.get('view'), MAX_VIEW_CHARS),
    rows: clampRows(params.get('rows')),
    columns: clean(params.get('columns'), MAX_COLUMNS_CHARS),
  };
}

// Where "Open" goes: the sheet page, on the embedded tab, with the view.
export function embedSheetHref(slug, tabNumber, view) {
  let href = `/d/${slug}`;
  if (tabNumber > 1) href += `?sheet=${tabNumber}`;
  if (view) href += `#sheet=${view}`;
  return href;
}
