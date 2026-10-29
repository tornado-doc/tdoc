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
  // Settings, through the remote MCP server at /mcp. On in PR previews (where
  // the worker serves /mcp); prod stays CLI-only until the owner flips it and
  // sets TDOC_REMOTE_MCP=1 on the worker.
  remoteMcp: Object.freeze({ label: 'Connect AI apps (remote MCP)', owner: 'julie', added: '2026-10-28', default: false, preview: true }),
  // Settings -> Delete account (self-serve). Owner-approved; the flag is the
  // off switch while it settles.
  deleteAccount: Object.freeze({ label: 'Delete account in Settings', owner: 'julie', added: '2026-10-28', default: true }),
});

const PREVIEW_HOST = /^pr-[1-9]\d*-tdoc-preview\./;

function isPreviewHost() {
  return typeof location !== 'undefined' && PREVIEW_HOST.test(location.hostname || '');
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
