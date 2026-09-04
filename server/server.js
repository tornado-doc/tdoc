#!/usr/bin/env node
// tdoc local server — anonymous, $0, zero-config.
// Serves docs from ~/tdocs/<slug>/v<N>/index.html. No auth, no GitHub.
// Auth lives entirely in the published Worker. Node 18+, no deps.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');


// The server knows which Node is running it; a spawned child may not. When the
// server was started by absolute path — a launchd job, an editor, a desktop
// launcher, nohup from a shell that only loads nvm interactively — PATH can be
// the bare system default, and a version-managed node is not on it. The child
// then reports "node 18+ is not installed" on a machine that has Node 22. Put
// the running interpreter's directory in front of the child's PATH. See #259.
function childEnv() {
  const nodeDir = path.dirname(process.execPath);
  const current = process.env.PATH || '';
  const already = current.split(path.delimiter).includes(nodeDir);
  return already ? process.env : { ...process.env, PATH: `${nodeDir}${path.delimiter}${current}` };
}

const PORT = process.env.TDOC_PORT ? Number(process.env.TDOC_PORT) : 7878;
const ROOT = process.env.TDOC_DIR || path.join(os.homedir(), 'tdocs');
const frameProbeSource = require('./frame-probe-source');
// Shared shell builder keeps local and production boot markup identical.
const SHELL = require('./shell.js');
const { loadRuntimeAssets } = require('./runtime-assets.js');
const SHELL_RUNTIME = loadRuntimeAssets();
// Slugs that carry the onboarding modal. Product UI, injected under the same
// nonce as the overlay, because a doc's own <script> never runs.
const ONBOARD_SLUGS = new Set(['tornado-doc', 'tdoc-start']);
// Optional two-person local inbox (browser e2e). Off unless TDOC_E2E_USER is set.
const E2E_USER = String(process.env.TDOC_E2E_USER || '').trim();
const E2E_OWNER = String(process.env.TDOC_E2E_OWNER || E2E_USER || '').trim();

fs.mkdirSync(ROOT, { recursive: true });

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json', ...headers });
}
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

// The device code a running `tdoc-publish` is waiting on, or null. The CLI
// prints the code to stderr and blocks; we buffer the child's output until it
// exits, so stderr cannot reach the publish modal while it still matters. The
// CLI drops the code in this file instead.
//
// Three ways a file here can be lying, all checked: it outlived its own
// expiry, the process that wrote it is gone (SIGKILL beats the cleanup), or it
// belongs to a different slug than the one being published.
const PENDING_SIGNIN_FILE = path.join(os.homedir(), '.tdoc', 'pending-signin.json');
function pendingSignin(slug) {
  const p = readJson(PENDING_SIGNIN_FILE, null);
  if (!p || !p.user_code || !p.verification_uri) return null;
  if (!(Number(p.expires_at) > Date.now())) return null;
  if (!slug || (p.slug && p.slug !== slug)) return null;
  if (Number.isInteger(p.pid) && p.pid > 0) {
    // Signal 0 tests for existence without delivering anything. EPERM means it
    // exists and is not ours, which still counts as alive.
    try { process.kill(p.pid, 0); } catch (e) { if (e.code !== 'EPERM') return null; }
  }
  // Explicit whitelist, and it is a contract: the file also carries
  // device_code (what makes a sign-in resumable), which can REDEEM the
  // approval. The modal only ever needs the user-facing half. Never add
  // device_code here — test/publish-signin.test.js pins this.
  return {
    user_code: String(p.user_code),
    verification_uri: String(p.verification_uri),
    expires_at: Number(p.expires_at),
    opened: Boolean(p.opened),
    slug: p.slug || null,
  };
}
function e2eIdentity() {
  if (!E2E_USER) return null;
  return { login: E2E_USER, name: E2E_USER, avatar_url: '' };
}
function inboxFile(login) {
  return path.join(ROOT, `.inbox-${String(login).toLowerCase()}.json`);
}
// Mirrors the Worker's asTombstone: the words go, the name stays (GitHub's
// "user deleted this"), and everything the words earned goes with them.
function localTombstone(record) {
  const out = {
    ...record,
    text: '',
    deleted: true,
    reactions: {},
    mentions: [],
    status: 'open',
  };
  delete out.edited;
  delete out.applied_in;
  delete out.agent_status;
  delete out.agent_actor;
  return out;
}

// The Worker gets this for free — it folds, so a tombstone with nothing left
// under it simply stops being emitted. Local storage is written, not folded,
// so the collapse has to happen at delete time: drop tombstoned replies that
// no longer hold anything, repeatedly (a chain of them collapses), and then
// the record itself if it is a tombstone with an empty thread. Returns false
// when the whole comment should go.
function collapseLocalTombstones(comment) {
  const replies = comment.replies || [];
  for (let changed = true; changed;) {
    changed = false;
    for (let i = replies.length - 1; i >= 0; i--) {
      const r = replies[i];
      if (!r.deleted) continue;
      if (replies.some(other => other.parent_id === r.id)) continue;
      replies.splice(i, 1);
      changed = true;
    }
  }
  return !(comment.deleted && !replies.length);
}

function localRecordAuthor(comments, id) {
  for (const c of comments) {
    if (c.id === id) return c.author || null;
    for (const r of (c.replies || [])) if (r.id === id) return r.author || null;
  }
  return null;
}
function localDeliver(recipient, ev) {
  const who = recipient && String(recipient).trim().toLowerCase();
  const actor = ev.actor && ev.actor.login && String(ev.actor.login).trim().toLowerCase();
  if (!who || who === actor) return;
  const file = inboxFile(who);
  const inbox = readJson(file, { items: [] });
  const items = Array.isArray(inbox.items) ? inbox.items : [];
  const gk = ev.kind === 'mention' ? `mention:${ev.target_id || ev.slug}`
    : ev.kind === 'comment' ? `comment:${ev.slug}`
    : ev.kind === 'reply' ? `reply:${ev.target_id}`
    : ev.kind === 'reaction' ? `reaction:${ev.target_id}`
    : `other:${ev.slug}`;
  const existing = items.find(i => i && !i.read && i.group_key === gk);
  if (existing) {
    existing.count = (Number(existing.count) || 1) + 1;
    existing.at = ev.at;
    existing.actor = ev.actor;
    existing.comment_id = ev.comment_id || existing.comment_id;
    existing.thread_id = ev.thread_id || existing.thread_id;
    existing.preview = ev.preview != null ? ev.preview : existing.preview;
    existing.version = ev.version || existing.version;
    const rest = items.filter(i => i !== existing);
    writeJson(file, { items: [existing, ...rest].slice(0, 200) });
    return;
  }
  items.unshift({
    id: ev.id || `n_${Date.now()}`,
    kind: ev.kind, group_key: gk, slug: ev.slug, version: ev.version || 1,
    comment_id: ev.comment_id, thread_id: ev.thread_id || ev.comment_id,
    actor: ev.actor || null, preview: ev.preview || '', title: ev.title || ev.slug,
    at: ev.at || new Date().toISOString(), read: false, count: 1, emoji: ev.emoji || null,
  });
  writeJson(file, { items: items.slice(0, 200) });
}
// ── @mentions (mirror of worker.js — kept identical by test/no-drift) ──────
// A comment reaches people by NAME, not only by position in the thread. Any
// GitHub login can be named. The hosted worker gates delivery on whether that
// person can open the doc; a local doc has no access policy — it is served to
// whoever is at the keyboard — so every name here is simply delivered.
const MENTION_MAX_PER_COMMENT = 10;
const MENTION_RE = /(^|[^A-Za-z0-9_@\/-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/g;
// Mirrors the worker: "@dana@example.com" is a deliberate email tag, a bare
// address in prose is not.
const EMAIL_MENTION_RE = /(^|[^A-Za-z0-9_@\/-])@([^\s@]+@[^\s@]+\.[^\s@]+)/g;

function normalizeGithubLogin(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('github:')) s = s.slice('github:'.length);
  if (s.startsWith('@')) s = s.slice(1);
  // GitHub logins: alphanumeric + hyphen
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(s)) return null;
  return s;
}

function parseMentionLogins(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const seen = new Set();
  const add = (key) => { if (key && !seen.has(key)) { seen.add(key); out.push(key); } };
  // Email tags first, and blank their spans so the handle pass cannot re-read
  // the local part of an address as a handle.
  let source = text;
  const er = new RegExp(EMAIL_MENTION_RE.source, 'g');
  let m;
  while ((m = er.exec(source))) {
    const addr = String(m[2]).replace(/[.,;:!?)]+$/, '').toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) add(`email:${addr}`);
  }
  source = source.replace(new RegExp(EMAIL_MENTION_RE.source, 'g'), '$1');
  const re = new RegExp(MENTION_RE.source, 'g');
  while ((m = re.exec(source))) {
    // A GitHub login never ends in a hyphen, so `@dana-` names dana.
    const login = String(m[2]).replace(/-+$/, '').toLowerCase();
    add(login);
  }
  return out;
}

// Being named outranks sitting in the thread. Returns the login that should
// still get the positional notification (owner of the doc, author of the
// parent), or null when the mention already reached them — one row, not two.
function positionalRecipient(login, mentions) {
  const n = normalizeGithubLogin(login);
  if (n && (Array.isArray(mentions) ? mentions : []).includes(n)) return null;
  return login;
}

// The logins a single comment may act on: parsed in the order they were
// typed, deduped, and capped.
function mentionCandidates(text) {
  return parseMentionLogins(text).slice(0, MENTION_MAX_PER_COMMENT);
}

// The local stand-in for the worker's presence probe. A local tree has no
// accounts, so the honest analogue of "has used tdoc here" is "has written
// something here": an author line in some doc under TDOC_DIR. Inboxes are not
// consulted, for the same reason the worker skips them — a mention creates
// one, so it would answer its own question.
function localHasUsedTdoc(login) {
  const n = normalizeGithubLogin(login);
  if (!n) return false;
  let slugs = [];
  try { slugs = fs.readdirSync(ROOT); } catch { return false; }
  const seen = (author) => normalizeGithubLogin(author && author.login) === n;
  for (const slug of slugs) {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'comments.json'), 'utf8')); } catch { continue; }
    for (const c of (Array.isArray(list) ? list : [])) {
      if (!c) continue;
      if (seen(c.author)) return true;
      for (const r of (Array.isArray(c.replies) ? c.replies : [])) if (seen(r && r.author)) return true;
    }
  }
  return false;
}

// Same shape the worker returns. A local doc has no access policy, so nobody
// is ever invited or blocked — but "new to this doc" and "never used tdoc"
// are both real locally, so the composer still reports them.
function localMentionOutcome(comments, mentions) {
  const inside = new Set(localMentionable(comments).map((u) => u.login));
  return {
    notified: mentions,
    invited: [],
    blocked: [],
    newcomers: mentions
      .filter((login) => !inside.has(login))
      .map((login) => ({ login, invited: false, known: localHasUsedTdoc(login) })),
  };
}

// Local comments.json is already folded (no event log), so participants come
// straight off the records and their replies.
function localMentionable(comments) {
  const byLogin = new Map();
  const push = (author) => {
    const login = normalizeGithubLogin(author && author.login);
    if (!login) return;
    const prev = byLogin.get(login) || { login, name: '', avatar_url: '' };
    byLogin.set(login, {
      login,
      name: prev.name || (author && author.name) || '',
      avatar_url: prev.avatar_url || (author && author.avatar_url) || '',
    });
  };
  if (E2E_OWNER) push({ login: E2E_OWNER, name: E2E_OWNER });
  for (const c of (Array.isArray(comments) ? comments : [])) {
    if (!c) continue;
    push(c.author);
    for (const r of (c.replies || [])) push(r && r.author);
  }
  return [...byLogin.values()];
}

// Cap request bodies so a hostile/buggy client can't OOM the local server.
const MAX_BODY_BYTES = 1 << 20; // 1 MiB — comments are small
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let b = '', size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      b += d;
    });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// Single source of truth for slug validation. Every route that turns a slug
// into a filesystem path MUST run it through here first — otherwise
// `slug=../../etc` escapes ROOT via path.join (confirmed path-traversal on the
// comment routes). Returns the slug if safe, else null.
function safeSlug(slug) {
  return (typeof slug === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(slug)) ? slug : null;
}

// A doc created in the browser has no title yet — you type it into the page —
// so its slug cannot be derived from one. It gets an opaque id instead, the
// way Google Docs and Notion address a document: unique by construction, so
// there is no de-duplication question and no rename when the title changes.
// The caller supplies random bytes (crypto.getRandomValues / randomBytes).
// Duplicated in worker.js and server.js; test/no-drift.test.js pins them equal.
function blankDocSlug(bytes) {
  // No look-alike characters: a slug gets read aloud and retyped.
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[(Number(bytes && bytes[i]) || 0) % alphabet.length];
  return `d-${out}`;
}

// The document a "start from scratch" create writes as v1. Deliberately empty,
// heading included: the author types the title into the page, and the save path
// reads it back out. Both placeholders paint only while the editor is live
// (`html[data-tdoc-editing]`), so a reader of a still-empty doc sees a blank
// page rather than instructions meant for its author. They are :empty rules
// rather than seeded text, so the hints come back whenever a line is cleared.
// Duplicated in worker.js and server.js; test/no-drift.test.js pins them equal.
function blankDocHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Untitled</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #fff; color: #17171a;
    font: 17px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  /* The editor's focus ring frames this element. On a doc with content that is
     the whole page; on a blank one, without a floor, it would draw a small box
     around two empty lines — and clicking below it would miss the editor. */
  main { max-width: 46rem; margin: 0 auto; padding: 4.5rem 1.5rem 8rem; min-height: 60vh; }
  h1 { font-size: 2.1rem; line-height: 1.25; margin: 0 0 1.5rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.35rem; margin: 2.5rem 0 .75rem; letter-spacing: -0.01em; }
  p { margin: 0 0 1.15rem; }
  a { color: #2f5bea; }
  blockquote { margin: 0 0 1.15rem; padding-left: 1rem; border-left: 3px solid #e4e4e9; color: #55555f; }
  code { background: #f3f3f6; padding: .12em .35em; border-radius: 4px;
    font: .88em ui-monospace, "SF Mono", Menlo, monospace; }
  html[data-tdoc-editing] [data-tdoc-placeholder]:empty::before {
    content: attr(data-tdoc-placeholder);
    color: #b0b0ba;
    pointer-events: none;
  }
  /* An empty block is zero pixels tall, so without a floor the placeholder
     paragraph is unclickable: the click falls through to <main> and the caret
     stays wherever it was. */
  html[data-tdoc-editing] [data-tdoc-placeholder]:empty {
    min-height: 1.75em;
  }
  /* Put the caret in a line and its hint steps aside — it has said what it had
     to say. frame-probe marks the line, and only once the reader has moved the
     caret themselves, so the guidance survives the first paint. */
  html[data-tdoc-editing] [data-tdoc-placeholder][data-tdoc-caret]:empty::before {
    content: none;
  }
</style>
</head>
<body>
<main>
<h1 data-tdoc-placeholder="Untitled"></h1>
<p data-tdoc-placeholder="Start writing…"></p>
</main>
</body>
</html>
`;
}

// The document's own first <h1> is the title. Reading it back on every browser
// save is what lets an author name an untitled doc by typing into the page, and
// rename it later the same way. Returns '' when there is no usable heading, so
// callers can leave the stored title alone rather than blanking it.
// Duplicated in worker.js and server.js; test/no-drift.test.js pins them equal.
function titleFromDocument(html) {
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(String(html == null ? '' : html));
  if (!match) return '';
  const text = match[1]
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;| /g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    // One pass of <[^>]*> cannot be trusted on nested or malformed markup
    // (`<<script>>` leaves `<script`), and decoding entities just above can
    // put an angle bracket back. A title is a label, never markup, so every
    // surviving bracket is dropped and the result provably carries none.
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 120);
}

// Keep <title> in step with the heading the author just edited, so the browser
// tab, the exported file and the hub all agree. Only rewrites an existing tag —
// a document without one is left exactly as its author wrote it.
// Duplicated in worker.js and server.js; test/no-drift.test.js pins them equal.
function syncDocumentTitle(html, title) {
  const safe = String(title == null ? '' : title)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return String(html == null ? '' : html)
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, () => `<title>${safe}</title>`);
}

function latestLocalVersion(slug, meta) {
  const declared = Array.isArray(meta && meta.versions)
    ? meta.versions.map((item) => Number(item && item.n) || 0)
    : [];
  let stored = [];
  try {
    stored = fs.readdirSync(path.join(ROOT, slug), { withFileTypes: true })
      .filter((item) => item.isDirectory() && /^v\d+$/.test(item.name))
      .map((item) => Number(item.name.slice(1)) || 0);
  } catch {}
  return Math.max(0, ...declared, ...stored);
}

// Guard for state-mutating local requests. The local server has no auth (by
// design — it's localhost-only), so a drive-by web page must not be able to
// drive it via CSRF. A cross-origin page can only send a CORS-"simple" POST
// (text/plain, no custom headers) without a preflight; requiring JSON
// content-type defeats that, and rejecting non-local Origins closes the rest.
// Returns true if the request is allowed to mutate.
function isLocalMutation(req) {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') return false;
  const origin = req.headers['origin'];
  if (origin) {
    try {
      const h = new URL(origin).hostname;
      if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return false;
    } catch { return false; }
  }
  return true;
}

// Escape `</script>` and HTML comment terminators so a malicious or stray value
// inside the JSON payload can't break out of the surrounding <script> block.
// Replace the acting agent's reaction on a comment with the emoji for the new
// status. Also removes legacy `tdoc-agent` reactions first so old state
// can't outlive the new outcome (e.g. an "applied" ✅ after a later
// "question" outcome on the same comment).
const AGENT_STATUS_EMOJI = { applied: '✅', partial: '🟡', question: '❓' };
// The emoji set the agent uses as a verdict marker — used by the per-version
// fold to strip a stale verdict off snapshots where the comment reads 'open'.
const AGENT_VERDICT_EMOJI = new Set(Object.values(AGENT_STATUS_EMOJI));
function isAnthropicCompanyMark(url) {
  return typeof url === 'string' && /(?:^|\/\/)(?:www\.)?github\.com\/anthropics(?:\.png)?(?:[/?#]|$)/i.test(url);
}
function logoForAgentLogin(login) {
  const key = String(login || '').toLowerCase();
  if (key.includes('grok') || key.includes('xai')) return 'https://github.com/xai-org.png';
  if (key.includes('claude') || key.includes('anthropic')) return 'https://cdn.simpleicons.org/claude/d97757';
  if (key.includes('codex') || key.includes('openai') || key.includes('chatgpt') || key === 'gpt' || key.startsWith('gpt-')) {
    return 'https://github.com/openai.png';
  }
  if (key.includes('gemini') || key.includes('bard')) return 'https://cdn.simpleicons.org/googlegemini/8e75b2';
  if (key.includes('cursor') || key.includes('composer')) return 'https://cdn.simpleicons.org/cursor/000000';
  // tdoc project mark (assets/tdoc_logo.svg, served at /tdoc_logo.svg).
  return '/tdoc_logo.svg';
}

function isGenericAgentLogin(login) {
  const k = String(login || '').trim().toLowerCase();
  return !k || k === 'tdoc-agent' || k === 'agent';
}

function detectAgentRuntime(env) {
  const e = env || {};
  const present = (names) => names.some((n) => {
    const v = e[n];
    return v != null && String(v).trim() !== '';
  });
  // Session/host markers only — never API keys. Order is the priority when
  // more than one host is visible in the same process (rare).
  if (present(['GROK_AGENT', 'GROK_SESSION_ID', 'GROK_BUILD', 'XAI_AGENT'])) {
    return { login: 'grok', name: 'Grok' };
  }
  if (present(['CLAUDE_CODE', 'CLAUDE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'])) {
    return { login: 'claude', name: 'Claude' };
  }
  if (present(['CODEX_SESSION_ID', 'CODEX_CLI', 'OPENAI_CODEX', 'CODEX_HOME'])) {
    return { login: 'codex', name: 'Codex' };
  }
  if (present(['CURSOR_TRACE_ID', 'CURSOR_AGENT', 'COMPOSER_SESSION'])) {
    return { login: 'cursor', name: 'Cursor' };
  }
  if (present(['GEMINI_CLI', 'GEMINI_SESSION_ID'])) {
    return { login: 'gemini', name: 'Gemini' };
  }
  return null;
}

function agentIdentity(body = {}, env = {}) {
  const detected = detectAgentRuntime(env);
  const clean = (v, fallback) => {
    if (typeof v !== 'string') return fallback;
    const s = v.trim().slice(0, 80);
    return s || fallback;
  };
  const rawLogin = typeof (body.agent_login || body.agent_id) === 'string'
    ? String(body.agent_login || body.agent_id).trim()
    : '';
  const rawName = typeof body.agent_name === 'string' ? body.agent_name.trim() : '';
  const login = (!isGenericAgentLogin(rawLogin) ? rawLogin : '')
    || (detected && detected.login)
    || env.TDOC_AGENT_LOGIN
    || 'tdoc-agent';
  const name = (!isGenericAgentLogin(rawName) ? rawName : '')
    || (detected && detected.name)
    || env.TDOC_AGENT_NAME
    || login;
  let avatar = typeof body.agent_avatar_url === 'string' && /^https:\/\/[^ \n\r\t]+$/i.test(body.agent_avatar_url)
    ? body.agent_avatar_url
    : null;
  if (isAnthropicCompanyMark(avatar)) avatar = null;
  if (!avatar) avatar = logoForAgentLogin(login);
  return { kind: 'agent', login: clean(login, 'tdoc-agent'), name: clean(name, login), avatar_url: avatar };
}
function setAgentReaction(target, status, actor = 'tdoc-agent') {
  if (!target.reactions) target.reactions = {};
  const agentUsers = new Set(['tdoc-agent', actor].filter(Boolean));
  for (const emoji of Object.keys(target.reactions)) {
    const users = target.reactions[emoji] || [];
    for (let i = users.length - 1; i >= 0; i--) {
      if (agentUsers.has(users[i])) users.splice(i, 1);
    }
    if (users.length === 0) delete target.reactions[emoji];
    else target.reactions[emoji] = users;
  }
  const next = AGENT_STATUS_EMOJI[status];
  if (!next) return;
  const u = target.reactions[next] || [];
  if (!u.includes(actor)) u.push(actor);
  target.reactions[next] = u;
}

function safeJsonForScript(obj) {
  return JSON.stringify(obj).replace(/<\/script>/gi, '<\\/script>').replace(/<!--/g, '<\\!--');
}

// CSP (owner-manage-via-session hardening, mirrors worker/worker.js).
//
// Local docs are anonymous/no-auth by design, so this route isn't guarding a
// session cookie today — but the local server shares overlay.js with the
// published worker, and a doc authored locally is the same bytes that later
// get published. Blocking author <script>/onclick here too means what a doc
// author sees locally matches what ships (no "worked in dev, XSS in prod"
// surprise), and costs nothing since 0 published docs use <script>.
function cspHeader(nonce) {
  // frame-src 'self': the shell document embeds the author content only via the
  // same-origin /frame route (which is itself sandboxed to an opaque origin).
  // Locking it to 'self' means the shell can never be made to frame anything else.
  return `script-src 'nonce-${nonce}' 'strict-dynamic'; frame-src 'self'; object-src 'none'; base-uri 'none';`;
}

// Interactive islands (#138). Host documents keep cspHeader(); computation
// lives in a separately served HTML resource framed with sandbox="allow-scripts"
// (never allow-same-origin). srcdoc/blob inherit the parent CSP and cannot
// run author JS — these must be real URLs.
function isValidWidgetName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}
function widgetCspHeader() {
  // NO frame-ancestors: the author document embeds widgets from inside the
  // sandboxed /frame, whose origin is OPAQUE — 'self' can never match it, so
  // the browser would refuse every widget ("refused to connect"). The Sec-
  // Fetch-Dest gate (must load as an iframe), the widget's own sandbox
  // (opaque origin, no credentials), and enforceDocAccess remain the controls.
  return "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; worker-src 'none'; form-action 'none'; sandbox allow-scripts";
}
function isWidgetFrameRequest(dest) {
  return String(dest || '').toLowerCase() === 'iframe';
}
function forceWidgetSandbox(html) {
  if (typeof html !== 'string') return html;
  return html.replace(/<iframe\b([^>]*?)>/gi, (full, attrs) => {
    const srcM = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!srcM) return full;
    const src = String(srcM[1] || srcM[2] || srcM[3] || '').trim();
    let path;
    try {
      const u = new URL(src, 'https://tdoc-widget-src.invalid');
      if (u.hostname !== 'tdoc-widget-src.invalid') return full;
      path = u.pathname;
    } catch {
      return full;
    }
    if (!/^\/d\/[a-z0-9][a-z0-9-]{0,63}\/v\/\d+\/widget\/[a-z0-9][a-z0-9-]{0,63}\/?$/i.test(path)) return full;
    const stripped = attrs.replace(/\s*sandbox\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    return '<iframe sandbox="allow-scripts"' + stripped + '>';
  });
}

// --- Cross-origin iframe "shell" (single path; see PLAN.md). ---
// The author document is served from /d/<slug>/v/<n>/frame under a CSP `sandbox`
// (opaque origin) so its CSS/DOM can never touch the overlay chrome, which lives
// in the shell document. Same isolation mechanism as widget islands, applied to
// the whole doc. Only our own nonced scripts run in the frame (author JS stays
// inert, exactly as in the single-origin path); the sandbox directive is what
// makes the origin opaque.
function frameCspHeader(nonce) {
  return `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts`;
}

// Reader CSS remains provider-enforced inside the isolated author frame.
// A table only scrolls sideways when it sits inside .tdoc-table-scroll, and
// adding that wrapper is the author's job. A document whose agent skipped it
// pushes the WHOLE page sideways on a phone — 482px of it on a real doc, with
// five tables and none of them wrapped. A table cannot be its own scroll
// container while it lays out as a table, so on narrow viewports it becomes a
// block that scrolls itself; wrapped tables keep the wrapper's behaviour.
//
// This rides in at serve time rather than living only in reader.css because
// documents bake their reader CSS at creation: changing that file alone fixes
// nothing that is already published. Kept byte-identical in server.js —
// test/reader-patch-drift.test.js holds the two together.
// A table only scrolls when it sits in .tdoc-table-scroll, and adding that
// wrapper was the author's job — a doc whose agent skipped it pushed the whole
// page sideways. CSS alone cannot fix that: making the table itself the scroller
// (display:block) leaves its row groups to size independently, and the header
// stops lining up with the body. Wrapping is the only thing that keeps all
// three — no page overflow, columns at their natural width, header aligned.
// Kept byte-identical in server.js; test/reader-patch-drift.test.js holds them
// together.
function wrapBareTables(html) {
  if (typeof html !== 'string' || html.indexOf('<table') === -1) return html;
  var out = '', i = 0;
  while (i < html.length) {
    var at = html.toLowerCase().indexOf('<table', i);
    if (at === -1) { out += html.slice(i); break; }
    var before = html.slice(i, at);
    var already = /<div[^>]*class="[^"]*tdoc-table-scroll[^"]*"[^>]*>\s*$/i.test(out + before);
    var depth = 0, j = at, end = -1;
    while (j < html.length) {
      var open = html.toLowerCase().indexOf('<table', j);
      var close = html.toLowerCase().indexOf('</table', j);
      if (close === -1) break;
      if (open !== -1 && open < close) { depth++; j = open + 6; continue; }
      depth--;
      if (depth === 0) { end = html.indexOf('>', close); break; }
      j = close + 7;
    }
    if (end === -1) { out += html.slice(i); break; }
    var table = html.slice(at, end + 1);
    out += before + (already ? table : '<div class="tdoc-table-scroll">' + table + '</div>');
    i = end + 1;
  }
  return out;
}

const READER_PATCH_CSS = '.tdoc-table-scroll{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}.tdoc-table-scroll>table{max-width:none}';

const READER_CSS_PATH = path.join(__dirname, 'reader.css');
function readerCss() {
  try { return fs.readFileSync(READER_CSS_PATH, 'utf8'); } catch { return ''; }
}

// Local preview of the landing header's live star count (from main). Production
// fetches this in the Cloudflare Worker (edge-cached); here we refresh hourly.
// Threaded into the shell cfg so a landing bar variant can consume it.
let cachedStars = null;
async function refreshStars() {
  try {
    const r = await fetch('https://api.github.com/repos/tornado-doc/tdoc', { headers: { 'User-Agent': 'tdoc-local', 'Accept': 'application/vnd.github+json' } });
    if (r.ok) { const d = await r.json(); const n = Number(d && d.stargazers_count); if (Number.isFinite(n)) cachedStars = n; }
  } catch {}
}
refreshStars(); const _starTimer = setInterval(refreshStars, 3600e3); if (_starTimer.unref) _starTimer.unref();

// P1: the shell renders a top bar + embeds the author frame. P2 adds the
// postMessage anchoring bridge + comment chrome (composer/pins/cards) here.
function shellDocument(slug, version, nonce) {
  let title = slug, versions = [{ n: version }];
  let latestVersion = version;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'meta.json'), 'utf8'));
    if (meta && meta.title) title = meta.title;
    if (Array.isArray(meta.versions) && meta.versions.length) versions = meta.versions.map((v) => ({ n: v.n }));
    latestVersion = latestLocalVersion(slug, meta) || version;
  } catch {}
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const frameSrc = `/d/${encodeURIComponent(slug)}/v/${version}/frame`;
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const ident = e2eIdentity();
  const isOwner = !!(ident && E2E_OWNER && ident.login.toLowerCase() === E2E_OWNER.toLowerCase());
  const isLanding = slug === 'tornado-doc';
  const cfgJson = safeJsonForScript({
    slug,
    title,
    version,
    mode: 'local',
    versions,
    identity: ident,
    // The local server is anonymous by design and records nobody as a document's
    // owner, so there is never a name to show here. Declared rather than omitted
    // so the shell reads the same shape from both hosts.
    author: null,
    isOwner,
    canEdit: !isLanding && Number(version) === Number(latestVersion),
    canComment: true,
    authConfigured: false,
    webAuth: false,
    isLanding,
    onboarding: ONBOARD_SLUGS.has(slug),
    stars: cachedStars,
  });
  return SHELL.shellHtml({
    title,
    nonceAttr,
    cfgJson,
    bootJson: safeJsonForScript({ frameSrc, oldVersion: null }),
    runtimeJsPath: SHELL_RUNTIME.js.path,
    runtimeCssPath: SHELL_RUNTIME.css.path,
  });
}

function localDocsData() {
  const docs = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !safeSlug(entry.name)) continue;
    const slug = entry.name;
    const meta = readJson(path.join(ROOT, slug, 'meta.json'), {});
    const versions = Array.isArray(meta.versions) ? meta.versions : [];
    const latest = versions.length
      ? Number(versions[versions.length - 1].n) || 1
      : fs.readdirSync(path.join(ROOT, slug), { withFileTypes: true })
        .filter((item) => item.isDirectory() && /^v\d+$/.test(item.name))
        .map((item) => Number(item.name.slice(1))).sort((a, b) => b - a)[0] || 1;
    const created = meta.created || versions[0]?.created || '';
    const updated = versions[versions.length - 1]?.created || created;
    docs.push({ slug, title: meta.title || slug, latest, created, updated, owner: '', starred: false, folder: '' });
  }
  docs.sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || a.title.localeCompare(b.title));
  return { docs, recent: [], starred: [], folders: [] };
}

function localHubDocument(nonce) {
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  return SHELL.appHtml({
    title: 'My docs',
    nonceAttr,
    runtimeJsPath: SHELL_RUNTIME.js.path,
    runtimeCssPath: SHELL_RUNTIME.css.path,
    bootJson: safeJsonForScript({
      page: 'docs-hub',
      identity: e2eIdentity(),
      capabilities: { folders: false, delete: false, star: false, create: true },
      ...localDocsData(),
    }),
  });
}


// Always returns an array for a comments file. A comments.json that parses to a
// non-array (corrupt / hand-edited to `{}`) would otherwise crash the .filter/
// .find/.push that follow every read (#33 hardening).
function readCommentFile(file) {
  const v = readJson(file, []);
  return Array.isArray(v) ? v : [];
}

// Fold the flat comment list to a per-version SNAPSHOT, matching the worker's
// event-fold semantics (worker.js snapshotAt): reading a doc "as of version N"
// shows each comment exactly as it existed then. The local store is a flat
// record (not an event log), but it carries enough fields to fold:
//   - created_in > N        → the comment didn't exist yet → hide it.
//   - applied_in > N        → it wasn't resolved yet at N → show status 'open'
//                             and drop applied_in (no "✓ fixed" on a past version).
//   - replies made after N  → fold out (a reply added in v4 isn't on v3).
// Without this the local dev server returned the LATEST status for every
// version, so resolving a comment in v4 made it look resolved on v2/v3 too.
function foldCommentsAtVersion(comments, version) {
  const V = Number(version);
  if (!Number.isFinite(V)) return comments; // no version → latest state (back-compat)
  const out = [];
  for (const c of comments) {
    const createdIn = Number(c.created_in != null ? c.created_in : c.version) || 1;
    if (createdIn > V) continue; // didn't exist yet at version V
    const appliedIn = c.applied_in != null ? Number(c.applied_in) : null;
    const resolvedByV = c.status === 'applied' && appliedIn != null && appliedIn <= V;
    // Reactions are stored flat (no per-reaction version), so spreading `...c`
    // would carry the CURRENT reactions — including the agent verdict emoji
    // (✅/🟡/❓ written by setAgentReaction) — onto every past snapshot. On a
    // version where the comment folds to 'open' that's a contradictory
    // "resolved" emoji, so drop the agent verdict there.
    let reactions = c.reactions;
    if (!resolvedByV && reactions) {
      const filtered = {};
      for (const [emoji, users] of Object.entries(reactions)) {
        const agentActor = c.agent_actor || 'tdoc-agent';
        const rest = Array.isArray(users) ? users.filter(u => !((u === 'tdoc-agent' || u === agentActor) && AGENT_VERDICT_EMOJI.has(emoji))) : users;
        if (rest && rest.length) filtered[emoji] = rest;
      }
      reactions = filtered;
    }
    const snap = {
      ...c,
      status: resolvedByV ? 'applied' : 'open',
      applied_in: resolvedByV ? appliedIn : undefined,
      reactions,
      replies: Array.isArray(c.replies)
        ? c.replies.filter(r => (Number(r.version != null ? r.version : createdIn) || createdIn) <= V)
        : [],
    };
    out.push(snap);
  }
  return out;
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function indexPage() {
  const slugs = fs.readdirSync(ROOT).filter(f => {
    try { return fs.statSync(path.join(ROOT, f)).isDirectory() && !f.startsWith('.'); }
    catch { return false; }
  });
  const rows = slugs.map(slug => {
    const meta = readJson(path.join(ROOT, slug, 'meta.json'), { title: slug, versions: [] });
    const latest = meta.versions?.[meta.versions.length - 1]?.n || 1;
    const versionCount = Array.isArray(meta.versions) && meta.versions.length ? meta.versions.length : 1;
    return `<tr>
      <td><a href="/d/${encodeURIComponent(slug)}/v/${latest}">${escHtml(meta.title || slug)}</a></td>
      <td>${escHtml(slug)}</td>
      <td>v${latest}</td>
      <td><button class="del" data-slug="${escHtml(slug)}" data-versions="${versionCount}">Delete</button></td>
    </tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>tdoc</title>
<style>
  :root {
    --td-accent: #1652f0; --td-accent-hover: #1245d0;
    --td-danger: #b42318; --td-danger-hover: #931c14;
    --td-ink: #111; --td-muted: #666; --td-line: #eee;
  }
  body { font: 15px system-ui, -apple-system, sans-serif; max-width: 760px; margin: 60px auto; padding: 0 20px; color: var(--td-ink); }
  h1 { font-size: 28px; margin: 0 0 4px; color: var(--td-accent); }
  .sub { color: var(--td-muted); margin: 0 0 32px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--td-line); }
  th { font-size: 12px; text-transform: uppercase; color: #888; letter-spacing: 0.04em; }
  a { color: var(--td-accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #888; padding: 40px 0; text-align: center; }
  .del { font: 12px system-ui; color: var(--td-danger); background: none; border: 1px solid #e0c9c9; border-radius: 6px; padding: 3px 9px; cursor: pointer; transition: background .12s, color .12s; }
  .del:hover { background: var(--td-danger); color: #fff; border-color: var(--td-danger); }
  /* Styled confirm modal — replaces window.confirm() (JUL-36). Standalone
     copy of the doc overlay's .tdoc-modal-bg/.tdoc-modal visual language;
     this page doesn't load overlay.js. */
  .tdoc-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 1000; display: flex; align-items: center; justify-content: center; font: 14px system-ui, sans-serif; }
  .tdoc-modal { background: #fff; color: var(--td-ink); border-radius: 12px; padding: 26px; width: 420px; max-width: calc(100vw - 32px); box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
  .tdoc-modal h3 { margin: 0 0 10px; font-size: 18px; }
  .tdoc-modal p { margin: 0 0 14px; color: #444; line-height: 1.5; }
  .tdoc-modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
  .tdoc-modal button { font: inherit; cursor: pointer; padding: 8px 16px; border-radius: 6px; border: 1px solid #ccc; background: #fff; }
  .tdoc-modal button.danger { background: var(--td-danger); border-color: var(--td-danger); color: #fff; }
  .tdoc-modal button.danger:hover { background: var(--td-danger-hover); border-color: var(--td-danger-hover); }
</style></head><body>
<h1>tdoc</h1><p class="sub">Prompt-native documents.</p>
${slugs.length === 0 ? '<p class="empty">No docs yet. Try <code>/tdoc new &lt;prompt&gt;</code>.</p>' :
  `<table><thead><tr><th>Title</th><th>Slug</th><th>Version</th><th></th></tr></thead><tbody>${rows}</tbody></table>`}
<script>
function showConfirm({ title, body, confirmLabel, danger }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'tdoc-modal-bg';
    bg.innerHTML = '<div class="tdoc-modal">' +
      '<h3></h3><p></p>' +
      '<div class="actions">' +
        '<button type="button" data-act="cancel">Cancel</button>' +
        '<button type="button" data-act="go"></button>' +
      '</div></div>';
    bg.querySelector('h3').textContent = title;
    bg.querySelector('p').innerHTML = body;
    const goBtn = bg.querySelector('[data-act="go"]');
    goBtn.textContent = confirmLabel;
    if (danger) goBtn.className = 'danger';
    const done = (v) => { bg.remove(); resolve(v); };
    bg.querySelector('[data-act="cancel"]').onclick = () => done(false);
    bg.addEventListener('click', (e) => { if (e.target === bg) done(false); });
    goBtn.onclick = () => done(true);
    document.body.appendChild(bg);
  });
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.del');
  if (!b) return;
  const slug = b.dataset.slug;
  let comments = 0;
  try {
    const r = await fetch('/api/comments?slug=' + encodeURIComponent(slug));
    if (r.ok) {
      const list = await r.json();
      if (Array.isArray(list)) {
        for (const c of list) comments += 1 + (Array.isArray(c.replies) ? c.replies.length : 0);
      }
    }
  } catch {}
  // Irreversible: name exactly what disappears before acting.
  const proceed = await showConfirm({
    title: 'Delete "' + slug + '"?',
    body: 'This permanently removes <b>' + b.dataset.versions + ' version(s)</b> and <b>' + comments +
      ' comment(s)</b> — the local copy AND the published copy (if any). No undo.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!proceed) return;
  b.disabled = true; b.textContent = 'Deleting…';
  const r = await fetch('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) });
  if (r.ok) { b.closest('tr').remove(); }
  else { const d = await r.json().catch(() => ({})); alert('Delete failed: ' + (d.error || r.status)); b.disabled = false; b.textContent = 'Delete'; }
});
</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
 try {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // `service` is the identity marker health checks grep for — a foreign
  // process answering 200 on this port must not pass as tdoc (seen in the
  // wild: a daemon from another product bound 7878).
  if (p === '/api/ping') return json(res, 200, { ok: true, service: 'tdoc' });

  if (p === '/api/notifications' && req.method === 'GET') {
    const ident = e2eIdentity();
    if (!ident) return json(res, 401, { error: 'sign_in_required' });
    const inbox = readJson(inboxFile(ident.login), { items: [] });
    const items = Array.isArray(inbox.items) ? inbox.items.filter(Boolean) : [];
    const unread = items.filter(i => !i.read);
    const ordered = unread.concat(items.filter(i => i.read));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    return json(res, 200, {
      items: ordered.slice(offset, offset + 20),
      unread: unread.length,
      has_more: offset + 20 < ordered.length,
    });
  }
  if (p === '/api/notifications/unread' && req.method === 'GET') {
    const ident = e2eIdentity();
    if (!ident) return json(res, 401, { error: 'sign_in_required' });
    const inbox = readJson(inboxFile(ident.login), { items: [] });
    const items = Array.isArray(inbox.items) ? inbox.items : [];
    return json(res, 200, { unread: items.filter(i => i && !i.read).length });
  }
  if (p === '/api/notifications/read' && req.method === 'POST') {
    const ident = e2eIdentity();
    if (!ident) return json(res, 401, { error: 'sign_in_required' });
    const body = await readBody(req);
    const file = inboxFile(ident.login);
    const inbox = readJson(file, { items: [] });
    const items = (Array.isArray(inbox.items) ? inbox.items : []).map((i) => {
      if (!i) return i;
      if (Array.isArray(body.ids) && body.ids.includes(i.id)) return { ...i, read: true };
      if (body.comment_id && i.comment_id === body.comment_id) return { ...i, read: true };
      return i;
    });
    writeJson(file, { items });
    return json(res, 200, { ok: true, unread: items.filter(i => i && !i.read).length });
  }

  if (p === '/favicon.svg') {
    const logoPath = path.join(__dirname, '..', 'assets', 'favicon.svg');
    if (!fs.existsSync(logoPath)) return send(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(logoPath), {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
  }

  // Home-screen icons and the manifest that points at them (server/shell.js).
  const HOME_ICONS = {
    '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
    '/icon-192.png': ['icon-192.png', 'image/png'],
    '/icon-512.png': ['icon-512.png', 'image/png'],
    '/site.webmanifest': ['site.webmanifest', 'application/manifest+json; charset=utf-8'],
  };
  if (HOME_ICONS[p]) {
    const [name, type] = HOME_ICONS[p];
    const iconPath = path.join(__dirname, '..', 'assets', name);
    if (!fs.existsSync(iconPath)) return send(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(iconPath), {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
  }

  if (p === '/tdoc_logo.svg') {
    const logoPath = path.join(__dirname, '..', 'assets', 'tdoc_logo.svg');
    if (!fs.existsSync(logoPath)) return send(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(logoPath), {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
  }
  if (p === '/tdoc_logo.png') {
    const logoPath = path.join(__dirname, '..', 'assets', 'tdoc_logo.png');
    if (!fs.existsSync(logoPath)) return send(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(logoPath), {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
    });
  }

  const runtimeAsset = [SHELL_RUNTIME.js, SHELL_RUNTIME.css].find((asset) => asset.path === p);
  if (runtimeAsset && (req.method === 'GET' || req.method === 'HEAD')) {
    const body = req.method === 'HEAD' ? '' : fs.readFileSync(runtimeAsset.file);
    return send(res, 200, body, {
      'Content-Type': runtimeAsset.type,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
  }

  if ((p === '/' || p === '/me') && (req.method === 'GET' || req.method === 'HEAD')) {
    const nonce = crypto.randomBytes(16).toString('hex');
    return send(res, 200, req.method === 'HEAD' ? '' : localHubDocument(nonce), {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': cspHeader(nonce),
    });
  }

  // Match the hosted `/start` contract by reusing the existing tdoc-start
  // document route. Resolve the current version from its metadata so the local
  // onboarding handoff does not go stale when the tutorial is revised.
  if (p === '/start' && (req.method === 'GET' || req.method === 'HEAD')) {
    const meta = readJson(path.join(ROOT, 'tdoc-start', 'meta.json'), {});
    const versions = Array.isArray(meta.versions) ? meta.versions : [];
    const latest = versions.map((item) => Number(item && item.n)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (!latest) return send(res, 404, 'Not found: tdoc-start');
    res.writeHead(302, { Location: `/d/tdoc-start/v/${latest}`, 'Cache-Control': 'no-store' });
    return res.end();
  }

  const widgetMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/widget\/([^/]+)\/?$/);
  if (widgetMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
    }
    const [, rawSlug, vStr, rawName] = widgetMatch;
    const slug = safeSlug(rawSlug);
    if (!slug || !isValidWidgetName(rawName)) return send(res, 400, 'invalid slug or widget');
    const dest = req.headers['sec-fetch-dest'];
    if (!isWidgetFrameRequest(dest)) return send(res, 403, 'widget must be framed');
    const file = path.join(ROOT, slug, `v${vStr}`, 'widgets', `${rawName}.html`);
    if (!fs.existsSync(file)) return send(res, 404, `Not found: ${slug} v${vStr} widget ${rawName}`);
    const body = req.method === 'HEAD' ? '' : fs.readFileSync(file, 'utf8');
    return send(res, 200, body, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': widgetCspHeader(),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Vary': 'Sec-Fetch-Dest',
    });
  }

  // Author document frame (shell mode). Served under a CSP `sandbox` (opaque
  // origin), gated on Sec-Fetch-Dest: iframe like widgets, so it can only be
  // loaded inside the shell — never top-level.
  const frameMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/frame\/?$/);
  if (frameMatch) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
    }
    const [, rawSlug, vStr] = frameMatch;
    const slug = safeSlug(rawSlug);
    if (!slug) return send(res, 400, 'invalid slug');
    if (!isWidgetFrameRequest(req.headers['sec-fetch-dest'])) return send(res, 403, 'document frame must be framed');
    const file = path.join(ROOT, slug, `v${vStr}`, 'index.html');
    if (!fs.existsSync(file)) return send(res, 404, `Not found: ${slug} v${vStr}`);
    const nonce = crypto.randomBytes(16).toString('hex');
    let body = '';
    if (req.method !== 'HEAD') {
      body = forceWidgetSandbox(fs.readFileSync(file, 'utf8'));
      // Documents created before creation-time baking carry no #tdoc-reader
      // block, so the reading template is supplied in the FRAME RESPONSE
      // (never written back to storage).
      //
      // There is deliberately no second condition. This used to also require
      // that the document not contain the string "max-width" anywhere, as a
      // proxy for "this document styles itself" — and it punished exactly the
      // documents that followed the authoring contract: one `@media
      // (max-width: 520px)` breakpoint, which the contract asks for, and a
      // document that wrote no font-family (because the contract says the
      // template owns typography) lost the template and rendered in Times New
      // Roman. The proxy is unnecessary: the template is :where()
      // zero-specificity throughout, so a document that does style itself
      // wins every property it declares and is unaffected by the injection.
      // Tag match, not substring: a doc whose PROSE quotes id="tdoc-reader"
      // (tdoc's own design docs do) must still receive the template. Mirrors
      // hasReaderBlock() in worker.js.
      if (!/<style[^>]*\bid="tdoc-reader"/i.test(body)) {
        const rcss = readerCss();
        if (rcss) {
          const rtag = `<style id="tdoc-reader">${rcss}</style>`;
          // Callback so a `$` in the template stays literal (see bin/tdoc-bake).
          body = /<\/head>/i.test(body) ? body.replace(/<\/head>/i, () => `${rtag}</head>`) : rtag + body;
        }
      }
      body = wrapBareTables(body);
      if (body.indexOf('id="tdoc-reader-patch"') === -1) {
        const ptag = `<style id="tdoc-reader-patch">${READER_PATCH_CSS}</style>`;
        // Anchor on the OPENING tag — see the matching comment in worker.js:
        // the baked reader CSS quotes `</head>` in a comment, and a first-match
        // replace on the closing tag buries the style inside it.
        body = /<head[^>]*>/i.test(body)
          ? body.replace(/<head[^>]*>/i, (open) => `${open}${ptag}`)
          : ptag + body;
      }
      // Inject the anchoring probe — the only tdoc code allowed into the author
      // DOM. Nonced so it runs under the frame CSP while author <script> stays
      // inert (same guarantee as the single-origin path).
      try {
        const probe = frameProbeSource();
        const tag = `<script id="tdoc-frame-probe" data-tdoc-provider nonce="${nonce}">${probe}</script>`;
        body = body.includes('</body>') ? body.replace('</body>', `${tag}\n</body>`) : body + tag;
      } catch {}
    }
    return send(res, 200, body, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': frameCspHeader(nonce),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Vary': 'Sec-Fetch-Dest',
    });
  }

  const docMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/?$/);
  if (docMatch) {
    const [, rawSlug, vStr] = docMatch;
    const slug = safeSlug(rawSlug);
    if (!slug) return send(res, 400, 'invalid slug');
    const file = path.join(ROOT, slug, `v${vStr}`, 'index.html');
    if (!fs.existsSync(file)) return send(res, 404, `Not found: ${slug} v${vStr}`);
    const nonce = crypto.randomBytes(16).toString('hex');
    // Single path: every doc renders the cross-origin shell (chrome in the outer
    // document, author content isolated in the /frame iframe). The legacy
    // single-origin overlay-injection path is gone — see the git history / PLAN.md.
    return send(res, 200, shellDocument(slug, Number(vStr), nonce), {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': cspHeader(nonce),
    });
  }

  // A title is a property of the document, not of its text: renaming edits the
  // meta record and leaves the body and the version history alone (#383).
  if (p === '/api/doc/title' && req.method === 'PATCH') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    const clean = typeof body.title === 'string' ? body.title.trim() : '';
    if (!slug) return json(res, 400, { error: 'invalid or missing slug' });
    if (!clean) return json(res, 400, { error: 'title_required' });
    if (clean.length > 120) return json(res, 400, { error: 'title_too_long', limit: 120 });
    const metaFile = path.join(ROOT, slug, 'meta.json');
    const meta = readJson(metaFile, null);
    if (!meta || typeof meta !== 'object') return json(res, 404, { error: 'not_found' });
    const stage = `${metaFile}.title-${crypto.randomBytes(6).toString('hex')}`;
    try {
      fs.writeFileSync(stage, JSON.stringify({ ...meta, title: clean }, null, 2) + '\n');
      fs.renameSync(stage, metaFile);
    } catch (error) {
      try { fs.rmSync(stage, { force: true }); } catch {}
      console.error('[rename] meta write failed:', error && error.message ? error.message : error);
      return json(res, 500, { error: 'rename_failed' });
    }
    return json(res, 200, { ok: true, slug, title: clean });
  }

  // Start from scratch: the local twin of the worker's /api/doc/create. The
  // document is staged under a dot-prefixed directory (which the hub listing
  // skips, since safeSlug rejects a dot) and renamed into place, so a half
  // written doc never appears in My docs.
  if (p === '/api/doc/create' && req.method === 'POST') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    // Opaque ids don't collide in practice; the loop is here so that when one
    // does, the answer is another id rather than a failed create.
    let slug = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = blankDocSlug(crypto.randomBytes(8));
      if (fs.existsSync(path.join(ROOT, candidate))) continue;
      slug = candidate;
      break;
    }
    if (!slug) return json(res, 409, { error: 'slug_exhausted' });

    const now = new Date().toISOString();
    const docRoot = path.join(ROOT, slug);
    const stageDir = path.join(ROOT, `.create-${crypto.randomBytes(6).toString('hex')}`);
    try {
      fs.mkdirSync(path.join(stageDir, 'v1'), { recursive: true });
      fs.writeFileSync(path.join(stageDir, 'v1', 'index.html'), blankDocHtml());
      fs.writeFileSync(path.join(stageDir, 'meta.json'), JSON.stringify({
        // Renamed by the first save that finds a heading in the document, and
        // by every save after it. This is the only kind of document whose
        // heading is authoritative for its title.
        title: 'Untitled',
        created_from: 'blank',
        slug,
        created: now,
        versions: [{
          n: 1,
          created: now,
          prompt: 'Created from scratch in the browser',
          source: 'browser',
          // The mark the first save consumes: this v1 is scaffolding, not
          // something an author wrote.
          blank: true,
          ...(E2E_USER ? { author: E2E_USER } : {}),
        }],
      }, null, 2) + '\n');
      fs.renameSync(stageDir, docRoot);
    } catch (error) {
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
      // The message can carry a filesystem path or a stack; log it here and
      // hand the browser the code alone.
      console.error('[create] blank doc write failed:', error && error.message ? error.message : error);
      return json(res, 500, { error: 'create_failed' });
    }
    return json(res, 200, {
      ok: true,
      slug,
      version: 1,
      url: `/d/${encodeURIComponent(slug)}/v/1?edit=1`,
    });
  }

  // Explicit human save. Keystrokes stay in a browser draft; this endpoint is
  // the only local-browser path that creates a full document snapshot.
  if (p === '/api/doc/versions' && req.method === 'POST') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req, MAX_DOCUMENT_BYTES + 64 * 1024);
    const slug = safeSlug(body.slug);
    const baseVersion = Number(body.baseVersion);
    const doc = body.html;
    if (!slug || !Number.isInteger(baseVersion) || baseVersion < 1 || typeof doc !== 'string') {
      return json(res, 400, { error: 'slug, baseVersion, html required' });
    }
    if (Buffer.byteLength(doc, 'utf8') > MAX_DOCUMENT_BYTES) {
      return json(res, 413, { error: 'payload_too_large', limit: MAX_DOCUMENT_BYTES });
    }
    if (!/<html[\s>]/i.test(doc) || !/<body[\s>]/i.test(doc)) {
      return json(res, 400, { error: 'invalid_document_html' });
    }
    if (/data-tdoc-provider|id=["']tdoc-frame-probe["']/i.test(doc)) {
      return json(res, 400, { error: 'provider_markup_forbidden' });
    }

    const docRoot = path.join(ROOT, slug);
    const metaFile = path.join(docRoot, 'meta.json');
    if (!fs.existsSync(docRoot) || !fs.existsSync(metaFile)) {
      return json(res, 404, { error: 'not_found' });
    }
    const meta = readJson(metaFile, null);
    if (!meta || typeof meta !== 'object') return json(res, 409, { error: 'meta_corrupt' });
    const latest = latestLocalVersion(slug, meta);
    if (latest !== baseVersion) {
      return json(res, 409, { error: 'version_conflict', baseVersion, latestVersion: latest });
    }

    // The blank page a browser create lays down is scaffolding, not a version
    // anyone wrote. The first real save becomes v1 rather than appending v2, so
    // a document's history starts with the first thing someone actually wrote.
    // Bounded by construction: it needs the mark the create route set, the doc
    // must still have only that one version, and the record this save writes
    // carries no mark — so no document can replace twice.
    const priorVersions = Array.isArray(meta.versions) ? meta.versions : [];
    const replacesScaffold = priorVersions.length === 1
      && Number(priorVersions[0] && priorVersions[0].n) === 1
      && Boolean(priorVersions[0] && priorVersions[0].blank)
      && baseVersion === 1;

    const nextVersion = replacesScaffold ? 1 : latest + 1;
    const finalDir = path.join(docRoot, `v${nextVersion}`);
    if (!replacesScaffold && fs.existsSync(finalDir)) {
      return json(res, 409, { error: 'version_conflict', baseVersion, latestVersion: nextVersion });
    }
    const stageDir = path.join(docRoot, `.v${nextVersion}-browser-${crypto.randomBytes(6).toString('hex')}`);
    const now = new Date().toISOString();
    let nextTitle = '';
    try {
      fs.mkdirSync(stageDir, { recursive: false });
      const widgetFrom = `/d/${slug}/v/${baseVersion}/widget/`;
      const widgetTo = `/d/${slug}/v/${nextVersion}/widget/`;
      const rewritten = doc.split(widgetFrom).join(widgetTo);
      // A document created blank IS its heading — that is where its author
      // typed the title, and it keeps following the heading. Every other
      // document has a title of its own, which renaming changes; its first h1
      // may not even be a title, so a save must never re-read it. An empty or
      // missing h1 leaves the stored title alone rather than blanking it.
      nextTitle = meta.created_from === 'blank' ? titleFromDocument(rewritten) : '';
      fs.writeFileSync(path.join(stageDir, 'index.html'),
        nextTitle ? syncDocumentTitle(rewritten, nextTitle) : rewritten);
      const baseWidgets = path.join(docRoot, `v${baseVersion}`, 'widgets');
      if (fs.existsSync(baseWidgets)) fs.cpSync(baseWidgets, path.join(stageDir, 'widgets'), { recursive: true });
      // Replacing the scaffold means the target directory already exists; swap
      // it out of the way first so the rename is still the atomic step, and
      // keep the old one until the new one is in place.
      let displaced = null;
      if (replacesScaffold && fs.existsSync(finalDir)) {
        displaced = path.join(docRoot, `.v1-replaced-${crypto.randomBytes(6).toString('hex')}`);
        fs.renameSync(finalDir, displaced);
      }
      fs.renameSync(stageDir, finalDir);
      if (displaced) fs.rmSync(displaced, { recursive: true, force: true });

      const nextMeta = {
        ...meta,
        ...(nextTitle ? { title: nextTitle } : {}),
        versions: [
          // Dropping the scaffold's record is what clears its `blank` mark.
          ...priorVersions.filter((item) => Number(item && item.n) !== nextVersion),
          { n: nextVersion, created: now, prompt: 'Browser edit', source: 'browser', ...(E2E_USER ? { author: E2E_USER } : {}) },
        ].sort((a, b) => Number(a.n) - Number(b.n)),
      };
      const metaStage = `${metaFile}.browser-${crypto.randomBytes(6).toString('hex')}`;
      fs.writeFileSync(metaStage, JSON.stringify(nextMeta, null, 2) + '\n');
      fs.renameSync(metaStage, metaFile);
    } catch (error) {
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch {}
      return json(res, 500, { error: 'version_write_failed', message: error.message || String(error) });
    }
    return json(res, 200, {
      ok: true,
      version: nextVersion,
      url: `/d/${encodeURIComponent(slug)}/v/${nextVersion}`,
    });
  }

  // Who the composer offers after `@` — the doc's own people, same as hosted.
  if (p === '/api/mentions' && req.method === 'GET') {
    const slug = safeSlug(url.searchParams.get('slug'));
    if (!slug) return json(res, 400, { error: 'invalid or missing slug' });
    const comments = readCommentFile(path.join(ROOT, slug, 'comments.json'));
    const viewer = normalizeGithubLogin(e2eIdentity() && e2eIdentity().login);
    return json(res, 200, { users: localMentionable(comments).filter((u) => u.login !== viewer) });
  }

  // --- COMMENTS (anonymous) ---
  if (p === '/api/comments' && req.method === 'GET') {
    const slug = safeSlug(url.searchParams.get('slug'));
    if (!slug) return json(res, 400, { error: 'invalid or missing slug' });
    const all = readCommentFile(path.join(ROOT, slug, 'comments.json'));
    // Fold to the requested version's snapshot so past versions keep their
    // historical status (matches the worker). Missing version → latest state.
    const ver = url.searchParams.get('version');
    return json(res, 200, ver != null ? foldCommentsAtVersion(all, ver) : all);
  }

  if (p === '/api/comments' && req.method === 'POST') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    const { version, anchor, text, parent_id } = body;
    if (!slug || !text) return json(res, 400, { error: 'invalid slug or missing text' });
    const file = path.join(ROOT, slug, 'comments.json');
    const comments = readCommentFile(file);
    const created = new Date().toISOString();
    // Resolved server-side, before the write, so the card chips exactly the
    // names that were notified.
    const me = normalizeGithubLogin(e2eIdentity() && e2eIdentity().login);
    const mentions = mentionCandidates(text).filter((login) => login !== me);
    if (parent_id) {
      const thread = comments.find(c => c.id === parent_id)
        || comments.find(c => (c.replies || []).some(r => r.id === parent_id));
      if (!thread) return json(res, 404, { error: 'parent_not_found' });
      if (!Array.isArray(thread.replies)) thread.replies = [];
      // Persist the version the reply was made at so foldCommentsAtVersion can
      // scope it — without this the reply record has no `version` and the fold's
      // `r.version` check falls back to the parent's created_in, so replies were
      // never hidden on older versions (diverging from the worker).
      // parent_id is the immediate parent (top-level or another reply).
      const reply = { id: `r_${Date.now()}`, parent_id, text, mentions, version: Number(version) || 1, author: e2eIdentity(), created, reactions: {} };
      thread.replies.push(reply);
      writeJson(file, comments);
      if (E2E_USER) {
        const parentA = localRecordAuthor(comments, parent_id);
        let title = slug;
        try { title = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'meta.json'), 'utf8')).title || slug; } catch {}
        const ev = {
          slug, version: Number(version) || 1, comment_id: reply.id,
          thread_id: thread.id, target_id: reply.id, actor: reply.author, preview: text, title, at: created,
        };
        for (const who of mentions) localDeliver(who, { ...ev, kind: 'mention' });
        const parentLogin = positionalRecipient(parentA && parentA.login, mentions);
        if (parentLogin) localDeliver(parentLogin, { ...ev, kind: 'reply', target_id: parent_id });
      }
      return json(res, 200, { ...reply, mention_outcome: localMentionOutcome(comments, mentions) });
    }
    const entry = {
      id: `c_${Date.now()}`,
      version: version || 1,
      anchor: anchor || null,
      text,
      mentions,
      author: e2eIdentity(),
      status: 'open',
      created,
      replies: [],
      reactions: {}
    };
    comments.push(entry);
    writeJson(file, comments);
    if (E2E_USER && E2E_OWNER) {
      let title = slug;
      try { title = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'meta.json'), 'utf8')).title || slug; } catch {}
      const ev = {
        slug, version: Number(version) || 1, comment_id: entry.id,
        thread_id: entry.id, target_id: entry.id, actor: entry.author, preview: text, title, at: created,
      };
      for (const who of mentions) localDeliver(who, { ...ev, kind: 'mention' });
      const owner = positionalRecipient(E2E_OWNER, mentions);
      if (owner) localDeliver(owner, { ...ev, kind: 'comment' });
    }
    return json(res, 200, { ...entry, mention_outcome: localMentionOutcome(comments, mentions) });
  }

  // Agent reply: posts a reply attributed to the acting agent, updates the
  // parent comment's status, AND drops a status emoji on the parent's
  // reactions row. Each status maps to a different emoji so the user can
  // tell at a glance from the comment list which were addressed:
  //   applied  -> ✅
  //   partial  -> 🟡
  //   question -> ❓
  // The agent always clears its previous emoji on this comment first, so a
  // stale "applied" emoji can't outlive a later "question" outcome.
  // NOTE: local preview does NOT gate a repeated agent reply the way the
  // published Worker does (#349). It cannot: a delete here removes the reply
  // from the array outright, so there is no record that the agent ever
  // answered — the Worker's event log is what makes "already answered, and
  // deleted since" a knowable thing. Local preview is one person on one
  // machine; the loop this protects against is a published doc being pulled
  // and regenerated.
  if (p === '/api/agent/reply' && req.method === 'POST') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    const { parent_id, text, status: agentStatus, applied_in } = body;
    if (!slug || !parent_id || !text) return json(res, 400, { error: 'invalid slug or missing parent_id/text' });
    const file = path.join(ROOT, slug, 'comments.json');
    const all = readCommentFile(file);
    const parent = all.find(c => c.id === parent_id)
      || all.find(c => (c.replies || []).some(r => r.id === parent_id));
    if (!parent) return json(res, 404, { error: 'parent_not_found' });
    if (!Array.isArray(parent.replies)) parent.replies = [];
    const agent = agentIdentity(body, process.env);
    parent.agent_actor = agent.login;
    const reply = {
      id: `r_${Date.now()}`,
      parent_id,
      text,
      // Scope the agent reply to the version it was applied at (falls back to
      // the request version, then 1) so the fold can hide it on earlier ones.
      version: Number(applied_in != null ? applied_in : body.version) || 1,
      author: agent,
      agent_status: ['applied', 'partial', 'question'].includes(agentStatus) ? agentStatus : null,
      created: new Date().toISOString(),
      reactions: {},
    };
    parent.replies.push(reply);
    if (agentStatus === 'applied') {
      parent.status = 'applied';
      if (applied_in) parent.applied_in = applied_in;
    } else if (agentStatus === 'question' || agentStatus === 'partial') {
      parent.status = 'open';
    }
    setAgentReaction(parent, agentStatus, agent.login);
    writeJson(file, all);
    return json(res, 200, reply);
  }

  // Re-anchor an existing comment without changing its text/thread state.
  // Used by the "click unanchored, then select new text" flow. Also clears
  // the agent's prior status emoji + flips the comment back to "open" — a
  // re-anchor means the comment now points at different text, so any old
  // agent verdict is stale.
  if (p === '/api/comments' && req.method === 'PATCH') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    const { id, anchor } = body;
    // Marking a thread handled, and taking it back. The local store is the flat
    // comment list rather than an event log, so this writes the folded fields
    // the worker's marked_applied/marked_open events produce; legacyToEvents
    // replays them when the doc is published.
    if (typeof body.resolved === 'boolean') {
      if (!slug || !id) return json(res, 400, { error: 'invalid slug or missing id' });
      const file = path.join(ROOT, slug, 'comments.json');
      const all = readCommentFile(file);
      const top = all.find(c => c.id === id);
      if (!top) return json(res, 404, { error: 'not_found' });
      if (body.resolved) {
        top.status = 'applied';
        top.applied_in = Number(body.version) || top.version || 1;
        top.resolved_by = e2eIdentity() ? e2eIdentity().login : '';
      } else {
        top.status = 'open';
        delete top.applied_in;
        delete top.resolved_by;
      }
      writeJson(file, all);
      return json(res, 200, top);
    }

    // Editing a comment's text. Local preview is anonymous — there is no
    // session to check the author against, the way the worker does — so the
    // affordance the shell shows is the gate. `edited` is what the card reads
    // to mark it, and legacyToEvents replays it as a text_edited event when
    // this comment is published.
    if (typeof body.text === 'string') {
      const text = body.text.trim();
      if (!slug || !id || !text) return json(res, 400, { error: 'invalid slug or missing id/text' });
      const file = path.join(ROOT, slug, 'comments.json');
      const all = readCommentFile(file);
      const edited = new Date().toISOString();
      const top = all.find(c => c.id === id);
      if (top) {
        top.text = text;
        top.edited = edited;
        writeJson(file, all);
        return json(res, 200, top);
      }
      for (const c of all) {
        const reply = (c.replies || []).find(r => r.id === id);
        if (reply) {
          reply.text = text;
          reply.edited = edited;
          writeJson(file, all);
          return json(res, 200, reply);
        }
      }
      return json(res, 404, { error: 'not_found' });
    }
    if (!slug || !id || !anchor) return json(res, 400, { error: 'invalid slug or missing id/anchor' });
    const file = path.join(ROOT, slug, 'comments.json');
    const all = readCommentFile(file);
    const target = all.find(c => c.id === id);
    if (!target) return json(res, 404, { error: 'not_found' });
    target.anchor = anchor;
    target.status = 'open';
    delete target.applied_in;
    setAgentReaction(target, null, target.agent_actor || 'tdoc-agent');
    delete target.agent_actor;
    writeJson(file, all);
    return json(res, 200, target);
  }

  if (p === '/api/comments' && req.method === 'DELETE') {
    // DELETE carries no body, so the JSON content-type check doesn't apply;
    // a cross-origin DELETE is not a CORS-simple request, but reject non-local
    // Origins explicitly for defense in depth.
    const dOrigin = req.headers['origin'];
    if (dOrigin) {
      try { const h = new URL(dOrigin).hostname; if (!['localhost','127.0.0.1','::1'].includes(h)) return json(res, 403, { error: 'forbidden' }); }
      catch { return json(res, 403, { error: 'forbidden' }); }
    }
    const slug = safeSlug(url.searchParams.get('slug'));
    const id = url.searchParams.get('id');
    if (!slug || !id) return json(res, 400, { error: 'invalid slug or missing id' });
    const file = path.join(ROOT, slug, 'comments.json');
    const all = readCommentFile(file);
    // Same rule the Worker folds (#354): a record that still holds replies
    // keeps its slot as a tombstone — text gone, author kept — so deleting
    // your own words never takes everyone else's off the page. A record with
    // nothing under it goes for real. Local storage is flat, not an event log,
    // so the tombstone is written rather than folded.
    const top = all.find(c => c.id === id);
    if (top) {
      if ((top.replies || []).length) {
        writeJson(file, all.map(c => (c.id === id ? localTombstone(c) : c)));
      } else {
        writeJson(file, all.filter(c => c.id !== id));
      }
      return json(res, 200, { ok: true });
    }
    for (const c of all) {
      if (!Array.isArray(c.replies)) continue;
      const reply = c.replies.find(r => r.id === id);
      if (!reply) continue;
      const hasChildren = c.replies.some(r => r.parent_id === id && !r.deleted);
      c.replies = hasChildren
        ? c.replies.map(r => (r.id === id ? localTombstone(r) : r))
        : c.replies.filter(r => r.id !== id);
      const keep = collapseLocalTombstones(c);
      writeJson(file, keep ? all : all.filter(x => x.id !== c.id));
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not_found' });
  }

  // Reactions: anonymous on local, keyed by an "anon" pseudo-user so toggling works
  if (p === '/api/reactions' && req.method === 'POST') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    const { comment_id, emoji } = body;
    if (!slug || !comment_id || !emoji) return json(res, 400, { error: 'invalid slug or missing comment_id/emoji' });
    if (emoji.length === 0 || emoji.length > 8) return json(res, 400, { error: 'invalid_emoji' });
    const file = path.join(ROOT, slug, 'comments.json');
    const all = readCommentFile(file);
    function findTarget(list) {
      for (const c of list) {
        if (c.id === comment_id) return c;
        if (Array.isArray(c.replies)) {
          for (const r of c.replies) if (r.id === comment_id) return r;
        }
      }
      return null;
    }
    const target = findTarget(all);
    if (!target) return json(res, 404, { error: 'not_found' });
    if (!target.reactions) target.reactions = {};
    const users = target.reactions[emoji] || [];
    const me = E2E_USER || 'anon';
    const idx = users.indexOf(me);
    const added = idx < 0;
    if (idx >= 0) users.splice(idx, 1);
    else users.push(me);
    if (users.length === 0) delete target.reactions[emoji];
    else target.reactions[emoji] = users;
    writeJson(file, all);
    if (added && E2E_USER && target.author && target.author.login) {
      let title = slug;
      try { title = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'meta.json'), 'utf8')).title || slug; } catch {}
      const thread = all.find(c => c.id === comment_id || (c.replies || []).some(r => r.id === comment_id));
      const V = Number(body.version) || Number(target.version) || Number(thread && thread.version) || 1;
      localDeliver(target.author.login, {
        kind: 'reaction', slug, version: V, comment_id, thread_id: thread && thread.id,
        target_id: comment_id, actor: e2eIdentity(), title, emoji,
      });
    }
    return json(res, 200, { ok: true, reactions: target.reactions });
  }

  // --- PUBLISH ---
  // Shells out to bin/tdoc-publish <slug>. Returns { url }. Slow (20–60s on
  // first run); the browser modal shows a "this can take a minute" hint.
  // Honor TDOC_DRY_PUBLISH=1 for tests — echoes "would publish <slug>" and
  // returns a fake URL without invoking wrangler.
  if (p === '/api/delete' && req.method === 'POST') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    if (!slug) return json(res, 400, { error: 'invalid slug' });
    if (!fs.existsSync(path.join(ROOT, slug))) return json(res, 404, { error: 'not found' });
    const bin = path.join(__dirname, '..', 'bin', 'tdoc-delete');
    if (!fs.existsSync(bin)) return json(res, 500, { error: 'tdoc-delete script not found' });
    // Same spawn hardening as /api/publish: error listener, hard timeout,
    // bounded output. Deleting is quick; 60s covers a slow unpublish curl.
    const args = body.published === false ? [slug, '--local-only'] : [slug];
    const proc = spawn('bash', [bin, ...args], { env: childEnv() });
    let out = '', err = '', settled = false, killed = false;
    const CAP = 64 * 1024;
    const append = (buf, d) => (buf.length < CAP ? buf + d : buf);
    const settle = (status, obj) => { if (settled) return; settled = true; clearTimeout(timer); json(res, status, obj); };
    const timer = setTimeout(() => { killed = true; proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 3000); }, 60000);
    proc.on('error', (e) => settle(500, { error: 'delete_spawn_failed', detail: String(e && e.message || e) }));
    proc.stdout.on('data', d => { out = append(out, d); });
    proc.stderr.on('data', d => { err = append(err, d); });
    proc.on('close', (code) => {
      if (killed) return settle(504, { error: 'delete_timeout', stdout: out, stderr: err });
      if (code !== 0) return settle(500, { error: 'delete_failed', code, stdout: out, stderr: err });
      settle(200, { ok: true, stdout: out });
    });
    return;
  }

  // Read-only companion to POST /api/publish: what is the pending publish
  // blocked on? Answers with the device code so the modal can show it while
  // the POST is still in flight. GET, so no isLocalMutation gate — the server
  // is loopback-only by design (TDOC_HOST) and this reveals nothing a reader
  // of the terminal it was printed to does not already have.
  if (p === '/api/publish/signin' && req.method === 'GET') {
    const slug = safeSlug(url.searchParams.get('slug') || '');
    return json(res, 200, { signin: pendingSignin(slug) });
  }

  if (p === '/api/publish' && req.method === 'POST') {
    if (!isLocalMutation(req)) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req);
    const slug = safeSlug(body.slug);
    if (!slug) return json(res, 400, { error: 'invalid slug' });
    if (process.env.TDOC_DRY_PUBLISH === '1') {
      return json(res, 200, {
        ok: true,
        dry: true,
        url: `https://example.workers.dev/d/${slug}/v/1`,
        stdout: `would publish ${slug}\n`,
      });
    }
    const bin = path.join(__dirname, '..', 'bin', 'tdoc-publish');
    if (!fs.existsSync(bin)) return json(res, 500, { error: 'tdoc-publish script not found' });
    // Spawned through bash, not exec'd: the skill checkout can live on a
    // noexec mount (Codex skills dir), where the x bit is set but direct exec
    // is EACCES.
    // Spawn hardening: an `error` listener (so an EACCES doesn't crash the whole
    // server with an unhandled 'error' event), a hard timeout (SIGTERM→SIGKILL)
    // so a hung wrangler/curl can't leave the HTTP response pending forever, and
    // a bounded output buffer so runaway child output can't OOM us. wrangler
    // legitimately needs the inherited env (CLOUDFLARE_* creds), so we keep it
    // but this endpoint is now origin/CSRF-gated above.
    const proc = spawn('bash', [bin, slug], { env: childEnv() });
    let out = '', err = '', settled = false, killed = false;
    const CAP = 256 * 1024; // 256 KiB of captured output is plenty
    const append = (buf, d) => (buf.length < CAP ? buf + d : buf);
    const settle = (status, obj) => { if (settled) return; settled = true; clearInterval(timer); json(res, status, obj); };
    // A deadline that a live sign-in can push back, rather than a single
    // setTimeout. 180s is right for a publish that only has to upload, and
    // wrong for a first publish: the GitHub device code lives up to 15
    // minutes, and killing the child at 180s used to abort the sign-in the
    // human was still walking through. So: while a device code for this slug
    // is pending, the deadline sits just past its expiry, and the moment the
    // code is approved or dies the normal 180s budget applies again from now.
    const GRACE = 180000;
    let deadline = Date.now() + GRACE;
    let signingIn = false;
    const timer = setInterval(() => {
      const pending = pendingSignin(slug);
      if (pending) {
        signingIn = true;
        deadline = Math.max(deadline, pending.expires_at + 15000);
      } else if (signingIn) {
        // The sign-in just resolved — approved, denied, or expired. Whatever
        // is left is an ordinary upload, so it gets an ordinary budget from
        // here. Without this the pushed-out deadline would stand, and a
        // wrangler that hangs after a successful sign-in would spin the modal
        // for the rest of the code's 15 minutes instead of failing at 180s.
        signingIn = false;
        deadline = Date.now() + GRACE;
      }
      if (Date.now() < deadline) return;
      killed = true;
      clearInterval(timer);
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 3000);
    }, 1000);
    proc.on('error', (e) => settle(500, { error: 'publish_spawn_failed', detail: String(e && e.message || e) }));
    proc.stdout.on('data', d => { out = append(out, d); });
    proc.stderr.on('data', d => { err = append(err, d); });
    proc.on('close', (code) => {
      if (killed) return settle(504, { error: 'publish_timeout', stdout: out, stderr: err });
      if (code !== 0) return settle(500, { error: 'publish_failed', code, stdout: out, stderr: err });
      // tdoc-publish ends with "Published: <URL>"
      const m = out.match(/Published:\s*(https?:\/\/\S+)/);
      settle(200, { ok: true, url: m ? m[1] : null, stdout: out });
    });
    return;
  }

  send(res, 404, 'Not found');
 } catch (e) {
  // Body too large, malformed request, or unexpected throw — respond cleanly
  // instead of crashing the server with an unhandled rejection.
  const tooBig = e && /too large/i.test(String(e.message));
  if (!res.headersSent) json(res, tooBig ? 413 : 500, { error: tooBig ? 'payload_too_large' : 'internal_error' });
 }
});

// Bind to loopback only. The local server has no auth by design; binding all
// interfaces (the Node default when host is omitted) would expose the
// unauthenticated comment + publish API to the local network.
const HOST = process.env.TDOC_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`tdoc server: http://localhost:${PORT}  (root: ${ROOT})`);
  console.log(`mode: local (anonymous, no auth) — bound to ${HOST}`);
});
