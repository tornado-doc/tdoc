import { readDevMode } from './dev-mode.js';

// Feature flags. A new or uncertain feature ships behind a flag here: with
// `default: false` only accounts in dev mode see it (the avatar menu lists
// what dev mode is showing). Flip `default` to true once approved; delete the
// flag, and its checks, once the feature is stable.
//
// Every default-false flag carries `graduate_by: 'YYYY-MM-DD'` (a new flag:
// its `added` date + 7 days). On or after that date the flag is graduated
// (default: true) or the date is moved, with the reason in the PR
// (AGENTS.md; test/feature-flags.test.js fails without it).
export const FLAGS = Object.freeze({
  // "Results in document text" under the hub search: body and comment
  // matches from /api/search. Indexing runs regardless; this gates the UI.
  // Graduated 2026-11-16: on for everyone; the flag is the off switch.
  fullTextSearch: Object.freeze({ label: 'Full-text search', owner: 'julie', added: '2026-10-25', default: true }),
  // One entry on phones: the comment button opens a drawer with Comments and
  // Ask AI tabs instead of a separate Ask AI button in the top bar. On in PR
  // previews so it can be tried before it ships.
  unifiedEntry: Object.freeze({ label: 'One comment + Ask AI entry on phones', owner: 'julie', added: '2026-10-26', default: true }),
  teamGuests: Object.freeze({ label: 'Team guests and seats', owner: 'julie', added: '2026-10-26', default: true }),
  // Visibility-based read receipts: a thread is read once its card has been
  // in view (comment-area.js). Graduated 2026-11-16: on for everyone.
  autoReadComments: Object.freeze({ label: 'Read replies when seen', owner: 'julie', added: '2026-10-26', default: true }),
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
  // runs on other sites, so the widget reads it for the tdoc origin that
  // served feedback.js (feedback/src/main.jsx flagOn). Graduated
  // 2026-11-16: on for everyone.
  feedbackAreaSelect: Object.freeze({ label: 'Feedback: comment on an area', owner: 'julie', added: '2026-11-01', default: true }),
  // Feedback widget on tdoc's own doc page: the doc is a sandboxed frame,
  // one element to the widget (the whole page). With this on, a click, a
  // drag over words, a box and the hover outline reach inside it (the frame
  // answers through the shared selection code, server/frame-probe.js
  // tdoc:fb*), and the anchor gains a `frame` part. Read like
  // feedbackAreaSelect. Graduated 2026-11-16: on for everyone.
  feedbackDocFramePick: Object.freeze({ label: 'Feedback: pick inside a tdoc doc', owner: 'julie', added: '2026-11-10', default: true }),
  // Feedback widget: Share inside the widget (invite link, invite by email
  // or GitHub handle), the Join / Keep my own prompt an invite opens on the
  // site, and the space switcher. Approved by Julie (2026-11-03); off
  // switch while it settles. Like feedbackAreaSelect it is read for the
  // tdoc origin that served feedback.js.
  feedbackInvites: Object.freeze({ label: 'Feedback: share and invite from the widget', owner: 'julie', added: '2026-11-03', default: true }),
  // Ask/Edit v2: one Ask AI input (tdoc AI answers a question, or proposes
  // edits that show in the doc as red/green suggestions to accept or
  // reject). In a comment, @agent is the one way in (no Edit with AI).
  // Replaces Ask AI's Ask / Edit switch where it is on. Dev mode only (and
  // PR previews): the server enforces it too (worker askEditV2Allowed: the
  // boot's canSuggest, the routes, propose_edits, reply_as), so pinning the
  // flag in a browser shows nothing to anybody else. graduate_by 2026-11-30
  // (not added + 7): the owner wants it slower and correct first.
  askEditV2: Object.freeze({ label: 'Ask AI edits the doc (inline suggestions)', owner: 'julie', added: '2026-11-02', default: false, preview: true, graduate_by: '2026-11-30' }),
  // Sheets: import a .csv / .tsv / .xlsx as a sheet (Create a doc, or a file
  // dropped on My docs) and edit a sheet's cells, rows, columns and tags in
  // Edit mode. Reading a sheet (<table data-tdoc-sheet>: grid, search,
  // filter, sort) does not depend on this flag. Approved by Julie
  // (2026-11-10): on for everyone; off switch while it settles.
  sheets: Object.freeze({ label: 'Sheets: import spreadsheets and edit cells', owner: 'julie', added: '2026-11-09', default: true }),
  // My docs layout A. Wide screens (>= 900px): left sidebar with types and
  // folders, Needs you, card grid / list table, Settings as its own page.
  // Phones: one column of rows, Needs you as a strip to swipe, views and
  // type / folder filters as chip rows, Settings as a list of sections.
  // Graduated 2026-11-16: on for everyone. Off, every width keeps the old
  // one-column layout.
  myDocsA: Object.freeze({ label: 'New My docs layout', owner: 'julie', added: '2026-11-12', default: true }),
  // The progress pill on a comment handed to an agent: the current step in
  // plain words ("Claude is reading", "Claude updated the doc"); tapping it
  // opens the list of steps inside the comment; the tooltip holds the whole
  // line, from what tdoc records (comments/core/handoff-progress.js), plus
  // the agent's own one-line status when it posts one (report_progress).
  // Graduated 2026-11-16: on for everyone, and the server's progress
  // bookkeeping, /api/notify/progress and report_progress are open to every
  // caller. Off: Delivered -> On it -> replied, as before.
  agentProgress: Object.freeze({ label: 'Agent progress line on comments', owner: 'julie', added: '2026-11-12', default: true }),
  // New › Write it with your agent sends the sentence straight to one of the
  // person's own agents tdoc can push to (Raft, webhook, the tdoc app): a
  // private doc is made, the request handed to that agent, and the doc opens
  // with the progress line (agentProgress) until it publishes. Off: the copy
  // line only, as before. Server: /api/write-with-agent, open to every
  // signed-in person (writeWithAgentAllowed). On for everyone: approved by
  // Julie 2026-11-16; the flag is the off switch. Without agentProgress the
  // doc opens on the request comment with the plain Sent -> Delivered line.
  writeWithAgent: Object.freeze({ label: 'New: send the sentence to your agent', owner: 'julie', added: '2026-11-12', default: true, preview: true }),
  // New -> Doc -> "Write it with tdoc AI": one sentence, the built-in tdoc
  // AI (the Ask this doc model and its free allowance) drafts the doc and
  // publishes v1, private (write-with-ai.jsx, worker /api/write-with-ai).
  // Graduated 2026-11-16: on for everyone signed in; the server's
  // writeWithAiAllowed holds the same line (a person in a browser).
  writeWithTdocAi: Object.freeze({ label: 'Write with tdoc AI (New menu)', owner: 'julie', added: '2026-11-12', default: true }),
  // No Edit mode for people who may edit a prose doc or a sheet: click and type. A
  // selection brings up the editor bar's tools (and Comment), "/" on an empty
  // line the block menu, plain tables are typed into cell by cell. Drafts
  // stay in the browser and publish as a version after a pause or on leaving
  // (never over a newer version: the conflict dialog). A version published
  // while the doc is open replaces the page in place, once nobody is typing.
  // A sheet's grid is always editable for them (click selects, typing or a
  // double-click edits, structure menus as in Edit) and keeps Comment's ways
  // to comment (the cell's pill, its menu, a commented cell opens its thread);
  // a newer version shows the "just published" strip rather than a swap.
  // Slides keep their modes. Readers and commenters: unchanged.
  modelessEdit: Object.freeze({ label: 'Edit without Edit mode (autosave)', owner: 'julie', added: '2026-11-16', default: false, preview: true, graduate_by: '2026-11-23' }),
  // Sheet embeds: a <figure data-tdoc-embed="sheet" data-src="/d/<slug>">
  // in a page shows a live view of that sheet (its first rows, the saved
  // view applied, the comment count, Open), read under the SHEET's access
  // for the person reading (shell/src/document/sheet-embed.js, worker
  // /api/embed/sheet). Off: the figure is its fallback link, as in an export.
  sheetEmbeds: Object.freeze({ label: 'Sheets embedded in pages (live, by reference)', owner: 'julie', added: '2026-11-11', default: false, preview: true, graduate_by: '2026-11-23' }),
  // ⋯ › "Convert to Sheet": an editor turns a prose doc that holds sheet
  // tables into a sheet doc (title + sheet tables, the rest of the prose in
  // a .sheet-note), published as a new version (document/convert-to-sheet.js).
  // On for everyone (Julie, 2026-11-17): it is explicit, confirmed, and
  // undone by Restore in the version history. The flag is the off switch
  // until it settles; remove it by graduate_by.
  convertToSheet: Object.freeze({ label: 'Convert a doc to a sheet (⋯ menu)', owner: 'julie', added: '2026-11-17', default: true, graduate_by: '2026-11-24' }),
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
