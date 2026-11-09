export const TOP_BAR_HEIGHT = 48;

export const QUICK_REACTIONS = [
  '👍',
  '❤️',
  '🔥',
  '🎉',
  '😂',
  '🤔',
  '👀',
  '🚀',
  '✅',
  '❌',
  '❓',
  '💬',
  '❗',
  'LGTM',
];

// The face for a person with no picture (an email sign-in, or the signed-out
// "You" on the homepage demo): the first letter of their name, drawn as the
// top bar's .tdoc-avatar-fallback. Agents always have a mark, so never here.
export function avatarInitial(author) {
  const name = String(author?.name || author?.handle || author?.login || '').trim();
  return (Array.from(name)[0] || '?').toUpperCase();
}

// Where faces and profile links come from when the page is not tdoc's own:
// the feedback widget runs inside someone else's app, whose CSP img-src
// names tdoc but not GitHub, Clerk or a logo CDN. Set (to the tdoc origin
// that served the widget) by feedback/src/main.jsx; null on tdoc's pages,
// which keep their relative and upstream URLs.
let tdocOrigin = null;
export function setTdocOrigin(origin) {
  let ok = false;
  try { ok = typeof origin === 'string' && /^https?:$/.test(new URL(origin).protocol) && new URL(origin).origin === origin; } catch (_) {}
  tdocOrigin = ok ? origin : null;
}

// A tdoc path (/@handle, /tdoc_logo.png) as a link that works on this page.
export function tdocUrl(path) {
  return tdocOrigin && typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? `${tdocOrigin}${path}` : path;
}

// Logins a comment carries that are not GitHub accounts (the worker's
// AVATAR_NOT_GITHUB): a face for one of these must not be a stranger's.
const NOT_GITHUB = new Set(['tdoc', 'tdoc-ai', 'tdoc-agent', 'agent', 'anon', 'anonymous', 'email-hidden', 'ghost']);
const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

// GitHub's picture URL by numeric account id, as GitHub sign-in stores it.
const GITHUB_ID_AVATAR = /^https:\/\/avatars\.githubusercontent\.com\/u\/(\d{1,12})(?:[?#]|$)/;

// The face as the widget asks tdoc for it (worker avatarResponse): a person
// by GitHub account id when the stored picture names one (a renamed login
// can be taken by someone else; the id cannot), else by GitHub login; an
// agent by its mark's name; anything else nothing (the initial). Never a
// third-party URL, so the host page needs only tdoc.
function tdocFace(author, upstream) {
  if (!upstream) return '';
  const login = String(author?.login || '').trim().toLowerCase();
  if (author?.kind === 'system' || login === 'tdoc' || login === 'tdoc-ai') return `${tdocOrigin}/tdoc_logo.png`;
  if (upstream.startsWith('/') && !upstream.startsWith('//')) return `${tdocOrigin}${upstream}`;
  if (author?.kind === 'agent') {
    if (upstream.includes('simpleicons.org/claude/')) return `${tdocOrigin}/avatar/agent/claude`;
    if (upstream.includes('simpleicons.org/googlegemini/')) return `${tdocOrigin}/avatar/agent/gemini`;
    if (upstream.includes('simpleicons.org/cursor/')) return `${tdocOrigin}/avatar/agent/cursor`;
    if (upstream.startsWith('https://github.com/openai.png')) return `${tdocOrigin}/avatar/agent/openai`;
    return '';
  }
  const id = upstream.match(GITHUB_ID_AVATAR);
  if (id) return `${tdocOrigin}/avatar/u/${id[1]}`;
  return GITHUB_LOGIN.test(login) && !NOT_GITHUB.has(login) ? `${tdocOrigin}/avatar/${login}` : '';
}

export function avatarFor(author) {
  const upstream = upstreamAvatarFor(author);
  return tdocOrigin ? tdocFace(author, upstream) : upstream;
}

function upstreamAvatarFor(author) {
  const key = String(author?.login || author?.name || '').toLowerCase();
  // Product seed ("First reader here") and other system/tdoc rows use the
  // global mark — even when older comments stored an empty avatar_url. So
  // does tdoc AI's answer in a thread (Ask AI in a comment).
  if (key === 'tdoc' || key === 'tdoc-ai' || author?.kind === 'system') {
    // Filled light square (white field). Empty avatar_url on older seed rows
    // must not fall back to the stroke-only chrome mark.
    return author?.avatar_url || '/tdoc_logo.png';
  }
  if (author?.kind !== 'agent') return author?.avatar_url || '';
  if (key.includes('claude') || key.includes('anthropic')) {
    return 'https://cdn.simpleicons.org/claude/d97757';
  }
  // xAI's published logomark, served by both hosts at /grok_logo.svg. NOT
  // `github.com/xai-org.png`: that is the avatar of an org GitHub calls
  // "SpaceXAI Org", and it is the SpaceX X.
  if (key.includes('grok') || key.includes('xai')) return '/grok_logo.svg';
  if (key.includes('gemini')) return 'https://cdn.simpleicons.org/googlegemini/8e75b2';
  if (key.includes('cursor')) return 'https://cdn.simpleicons.org/cursor/000000';
  return 'https://github.com/openai.png';
}

// A sheet cell's identity beside its selector: table name, row id, column
// key (server/sheets-viewer.js hooks.anchor). Only short strings pass.
function sheetIdentity(sheet) {
  if (!sheet || typeof sheet !== 'object') return null;
  const out = {};
  for (const k of ['table', 'row', 'key']) {
    if (typeof sheet[k] === 'string' && sheet[k].length <= 200) out[k] = sheet[k];
  }
  return 'table' in out ? out : null;
}

export function anchorFromSelection(selection) {
  if (selection.kind === 'document') return null;
  if (selection.kind === 'element') {
    return {
      kind: 'element',
      selector: selection.selector,
      label: selection.label,
      ...(sheetIdentity(selection.sheet) ? { sheet: sheetIdentity(selection.sheet) } : {}),
    };
  }
  return {
    kind: 'text',
    text: selection.text,
    context_before: selection.context_before,
    context_after: selection.context_after,
    // Which occurrence of this text was selected, counted by the frame. The
    // resolver falls back to it when context cannot tell two matches apart;
    // an anchor written before this existed simply has no number, and
    // resolves the way it always did.
    ...(typeof selection.occurrence === 'number' && typeof selection.occurrences === 'number'
      ? { occurrence: selection.occurrence, occurrences: selection.occurrences }
      : {}),
  };
}

export function isDocumentComment(comment) {
  return !comment?.anchor || comment.anchor.kind === 'document';
}

export function layoutPins(pins, docHeight) {
  const rows = pins
    .map((pin) => ({ y: pin.docY, comment: pin }))
    .sort((left, right) => left.y - right.y);

  const elementGroups = new Map();
  for (const row of rows) {
    const key = row.comment.elementKey;
    if (!key) continue;
    if (!elementGroups.has(key)) elementGroups.set(key, []);
    elementGroups.get(key).push(row);
  }
  for (const group of elementGroups.values()) {
    if (group.length < 2) continue;
    const height = group[0].comment.elementHeight || 0;
    const usable = Math.max(0, height - 28);
    if (usable < 32) continue;
    const step = Math.max(32, usable / (group.length - 1));
    group.forEach((row, index) => {
      row.y = group[0].comment.elementTop + index * step;
    });
  }
  rows.sort((left, right) => left.y - right.y);
  const clusters = [];

  for (const row of rows) {
    const previous = clusters.at(-1);
    if (previous && row.y - previous.maxY <= 12
      && Boolean(previous.items[0].comment.document) === Boolean(row.comment.document)) {
      previous.items.push(row);
      previous.maxY = row.y;
      previous.y = (previous.items[0].y + row.y) / 2;
    } else {
      clusters.push({ y: row.y, maxY: row.y, items: [row] });
    }
  }

  const placed = [];
  let previousY = -Infinity;
  for (const cluster of clusters) {
    const y = Math.max(cluster.y, previousY + 32);
    if (y > (docHeight || 1e7) && placed.length) {
      placed.at(-1).items.push(...cluster.items);
      continue;
    }
    placed.push({
      ...cluster,
      y,
      key: cluster.items.map((item) => item.comment.id).sort().join('|'),
    });
    previousY = y;
  }
  return placed;
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return Promise.resolve(copied);
}
