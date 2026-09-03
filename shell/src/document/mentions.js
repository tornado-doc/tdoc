// @mentions — the pure half. The worker owns the truth (it resolves who a
// comment actually notified); these helpers only decide what the composer
// offers and which spans of a posted comment render as a chip.

// Same shape as MENTION_RE in worker.js: a GitHub login at a word boundary.
const MENTION_PATTERN = /(^|[^A-Za-z0-9_@/-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/g;
// Mirrors EMAIL_MENTION_RE in worker.js: "@addr" is a deliberate tag. Tried
// first when splitting, so an address tag is one chip and never half-read as
// a mention of its local part.
const EMAIL_MENTION_PATTERN = /(^|[^A-Za-z0-9_@/-])@([^\s@]+@[^\s@]+\.[^\s@]+)/g;

// The `@token` being typed immediately before the caret, or null. Requires a
// word boundary before the `@`, so typing an email address never opens the
// picker.
export function mentionQueryAt(text, caret) {
  const upto = String(text || '').slice(0, Math.max(0, caret));
  const match = /(?:^|[^A-Za-z0-9_@/-])@([A-Za-z0-9-]{0,39})$/.exec(upto);
  if (!match) return null;
  return { query: match[1], start: upto.length - match[1].length - 1 };
}

// People whose login or display name contains the query, best-effort ranked:
// a prefix hit before a substring hit, alphabetical inside each group.
export function matchMentionable(people, query) {
  const q = String(query || '').trim().toLowerCase();
  const rank = (person) => {
    const login = String(person.login || '').toLowerCase();
    const name = String(person.name || '').toLowerCase();
    if (!q) return 0;
    if (login.startsWith(q) || name.startsWith(q)) return 0;
    if (login.includes(q) || name.includes(q)) return 1;
    return -1;
  };
  return (Array.isArray(people) ? people : [])
    .map((person) => ({ person, r: rank(person) }))
    .filter((row) => row.r >= 0)
    .sort((a, b) => (a.r - b.r) || String(a.person.login).localeCompare(String(b.person.login)))
    .slice(0, 6)
    .map((row) => row.person);
}

// Replace the token under the caret with `@login `, and report where the caret
// belongs afterwards.
export function insertMention(text, query, login) {
  const source = String(text || '');
  const start = Math.max(0, Number(query?.start) || 0);
  const end = start + 1 + String(query?.query || '').length;
  const rest = source.slice(end);
  // One space after the name, never two: `@da| about it` already has one.
  const spaced = /^\s/.test(rest);
  const inserted = `@${login}${spaced ? '' : ' '}`;
  return {
    text: source.slice(0, start) + inserted + rest,
    caret: start + inserted.length + (spaced ? 1 : 0),
  };
}

// Split posted text into plain strings and the mentions that RESOLVED — the
// server's list, not a fresh guess. A name that reached nobody stays plain
// text, so a chip is always a promise that somebody was told.
export function splitMentions(text, mentions) {
  const source = String(text || '');
  const notified = new Set((Array.isArray(mentions) ? mentions : [])
    .map((login) => String(login || '').toLowerCase())
    .filter(Boolean));
  if (!notified.size) return source ? [{ type: 'text', value: source }] : [];

  // Both tag shapes, found in one left-to-right sweep. The email pattern is
  // consulted first at each position so "@dana@example.com" is one chip.
  const spans = [];
  for (const [pattern, kind] of [[EMAIL_MENTION_PATTERN, 'email'], [MENTION_PATTERN, 'handle']]) {
    const re = new RegExp(pattern.source, 'g');
    let match;
    while ((match = re.exec(source))) {
      const token = match[2];
      const key = kind === 'email'
        ? `email:${token.replace(/[.,;:!?)]+$/, '').toLowerCase()}`
        // A GitHub login never ends in a hyphen, so `@dana-` resolves to
        // dana — the chip still shows the token the author typed.
        : token.replace(/-+$/, '').toLowerCase();
      if (!notified.has(key)) continue;
      const at = match.index + match[1].length;
      spans.push({ at, end: at + 1 + token.length, token, login: key });
    }
  }
  spans.sort((a, b) => a.at - b.at);
  const parts = [];
  let last = 0;
  for (const span of spans) {
    if (span.at < last) continue; // an email span already covered this handle
    if (span.at > last) parts.push({ type: 'text', value: source.slice(last, span.at) });
    parts.push({ type: 'mention', value: `@${span.token}`, login: span.login });
    last = span.end;
  }
  if (last < source.length) parts.push({ type: 'text', value: source.slice(last) });
  return parts;
}
