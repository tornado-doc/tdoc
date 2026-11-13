import { readDevMode } from './dev-mode.js';

// Feature flags. A new or uncertain feature ships behind a flag here: with
// `default: false` only accounts in dev mode see it (the avatar menu lists
// what dev mode is showing). Flip `default` to true once approved; delete the
// flag, and its checks, once the feature is stable.
export const FLAGS = Object.freeze({
  // Preview-card thumbnails in the doc grids (My docs, teams, public profile)
  // until the cards are real page screenshots. Link previews (OG / Twitter
  // cards) are server-side and always use the card.
  docThumbnails: Object.freeze({ label: 'Doc thumbnails', owner: 'julie', added: '2026-10-25', default: false }),
  // "Results in document text" under the hub search: body and comment
  // matches from /api/search. Indexing runs regardless; this gates the UI.
  fullTextSearch: Object.freeze({ label: 'Full-text search', owner: 'julie', added: '2026-10-25', default: false }),
  // One entry on phones: the comment button opens a drawer with Comments and
  // Ask AI tabs instead of a separate Ask AI button in the top bar. On in PR
  // previews so it can be tried before it ships.
  unifiedEntry: Object.freeze({ label: 'One comment + Ask AI entry on phones', owner: 'julie', added: '2026-10-26', default: true }),
  teamGuests: Object.freeze({ label: 'Team guests and seats', owner: 'julie', added: '2026-10-26', default: true }),
  // Try visibility-based read receipts in PR previews before enabling for
  // every document. The existing explicit read controls remain off-preview.
  autoReadComments: Object.freeze({ label: 'Read replies when seen', owner: 'julie', added: '2026-10-26', default: false, preview: true }),
  // "Connect in one click" for AI apps with no terminal (Claude connector,
  // ChatGPT custom MCP server, Cursor install link) on /start, /setup and
  // Settings, through the remote MCP server at /mcp. On for everyone since
  // tdoc.dev serves /mcp (TDOC_REMOTE_MCP=1 in wrangler.toml).
  remoteMcp: Object.freeze({ label: 'Connect AI apps (remote MCP)', owner: 'julie', added: '2026-10-28', default: true }),
  // Settings -> Delete account (self-serve). Owner-approved; the flag is the
  // off switch while it settles.
  deleteAccount: Object.freeze({ label: 'Delete account in Settings', owner: 'julie', added: '2026-10-28', default: true }),
  // The homepage demo's scripted Edit: Ask AI's Edit opens with a ready
  // request, sending it rewrites a paragraph in front of the visitor, then a
  // sign-up call to action (demo-agent.js DEMO_REWRITES). Landing doc only;
  // on in PR previews until approved.
  demoEditRewrite: Object.freeze({ label: 'Homepage demo: scripted Edit', owner: 'julie', added: '2026-11-01', default: true, preview: true }),
  // Feedback layer: drag a box to comment on an area (charts, canvases,
  // iframes, tiny or overlapping elements): a drag that starts where text
  // can't be selected draws a box, long-press-drag on phones. The client
  // runs on other sites, so "preview" is the tdoc origin that served
  // feedback.js, not the page, and dev mode is the signed-in viewer's, sent
  // with the widget's session (worker FEEDBACK_WIDGET_DEV_FLAGS).
  feedbackAreaSelect: Object.freeze({ label: 'Feedback: comment on an area', owner: 'julie', added: '2026-11-01', default: false, preview: true }),
  // Feedback widget on tdoc's own doc page: the doc is a sandboxed frame,
  // one element to the widget (the whole page). With this on, a click, a
  // drag over words, a box and the hover outline reach inside it (the frame
  // answers through the shared selection code, server/frame-probe.js
  // tdoc:fb*), and the anchor gains a `frame` part. Read like
  // feedbackAreaSelect: the tdoc origin that served feedback.js, and the
  // viewer's dev mode from the widget's session.
  feedbackDocFramePick: Object.freeze({ label: 'Feedback: pick inside a tdoc doc', owner: 'julie', added: '2026-11-10', default: false, preview: true }),
  // Ask/Edit v2: one Ask AI input (tdoc AI answers a question, or proposes
  // edits that show in the doc as red/green suggestions to accept or
  // reject). In a comment, @agent is the one way in (no Edit with AI).
  // Replaces Ask AI's Ask / Edit switch where it is on. Dev mode only (and
  // PR previews): the server enforces it too (worker askEditV2Allowed: the
  // boot's canSuggest, the routes, propose_edits, reply_as), so pinning the
  // flag in a browser shows nothing to anybody else.
  // Feedback widget: Share inside the widget (invite link, invite by email
  // or GitHub handle), the Join / Keep my own prompt an invite opens on the
  // site, and the space switcher. Approved by Julie (2026-11-03); off
  // switch while it settles. Like feedbackAreaSelect it is read for the
  // tdoc origin that served feedback.js.
  feedbackInvites: Object.freeze({ label: 'Feedback: share and invite from the widget', owner: 'julie', added: '2026-11-03', default: true }),
  askEditV2: Object.freeze({ label: 'Ask AI edits the doc (inline suggestions)', owner: 'julie', added: '2026-11-02', default: false, preview: true }),
  // Sheets: import a .csv / .tsv / .xlsx as a sheet (Create a doc, or a file
  // dropped on My docs) and edit a sheet's cells, rows, columns and tags in
  // Edit mode. Reading a sheet (<table data-tdoc-sheet>: grid, search,
  // filter, sort) does not depend on this flag. Approved by Julie
  // (2026-11-10): on for everyone; off switch while it settles.
  sheets: Object.freeze({ label: 'Sheets: import spreadsheets and edit cells', owner: 'julie', added: '2026-11-09', default: true }),
  // Sheet embeds: a <figure data-tdoc-embed="sheet" data-src="/d/<slug>">
  // in a page shows a live view of that sheet (its first rows, the saved
  // view applied, the comment count, Open), read under the SHEET's access
  // for the person reading (shell/src/document/sheet-embed.js, worker
  // /api/embed/sheet). Off: the figure is its fallback link, as in an export.
  // My docs layout A. Wide screens (>= 900px): left sidebar with types and
  // folders, Needs you, card grid / list table, Settings as its own page.
  // Phones: one column of rows, Needs you as a strip to swipe, views and
  // type / folder filters as chip rows, Settings as a list of sections.
  // Approved by Julie (2026-11-12) to ship behind dev mode first; on in PR
  // previews. Off, every width keeps the old one-column layout.
  myDocsA: Object.freeze({ label: 'New My docs layout', owner: 'julie', added: '2026-11-12', default: false, preview: true }),
  sheetEmbeds: Object.freeze({ label: 'Sheets embedded in pages (live, by reference)', owner: 'julie', added: '2026-11-11', default: false, preview: true }),
});

const PREVIEW_HOST = /^pr-[1-9]\d*-tdoc-preview\./;

export function isPreviewHostname(hostname) {
  return PREVIEW_HOST.test(String(hostname || ''));
}

function isPreviewHost() {
  return typeof location !== 'undefined' && isPreviewHostname(location.hostname);
}

export function isFeatureOn(name, devMode = readDevMode()) {
  const flag = Object.prototype.hasOwnProperty.call(FLAGS, name) ? FLAGS[name] : null;
  if (!flag) return false;
  // A page (tests, a support link) may pin a flag either way before boot.
  const pinned = typeof window !== 'undefined' && window.__TDOC_FLAGS__ ? window.__TDOC_FLAGS__[name] : undefined;
  if (typeof pinned === 'boolean') return pinned;
  return flag.default === true || Boolean(devMode && devMode.on) || (flag.preview === true && isPreviewHost());
}

// The flags dev mode adds over what everybody else sees.
export function devOnlyFlags() {
  return Object.entries(FLAGS)
    .filter(([, flag]) => flag.default !== true)
    .map(([name, flag]) => ({ name, label: flag.label }));
}
