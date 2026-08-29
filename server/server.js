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
const FRAME_PROBE_PATH = path.join(__dirname, 'frame-probe.js');
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
function e2eIdentity() {
  if (!E2E_USER) return null;
  return { login: E2E_USER, name: E2E_USER, avatar_url: '' };
}
function inboxFile(login) {
  return path.join(ROOT, `.inbox-${String(login).toLowerCase()}.json`);
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
  const gk = ev.kind === 'comment' ? `comment:${ev.slug}`
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
// Cap request bodies so a hostile/buggy client can't OOM the local server.
const MAX_BODY_BYTES = 1 << 20; // 1 MiB — comments are small
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '', size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
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
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'meta.json'), 'utf8'));
    if (meta && meta.title) title = meta.title;
    if (Array.isArray(meta.versions) && meta.versions.length) versions = meta.versions.map((v) => ({ n: v.n }));
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
    isOwner,
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
      capabilities: { folders: false, delete: false, star: false },
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
      // Legacy template-reliant docs (published before creation-time baking):
      // no #tdoc-reader block AND no styling of their own reading column →
      // inject the reader CSS into the FRAME RESPONSE (never into storage).
      // Self-contained docs are excluded by the max-width check, and the
      // template is :where() zero-specificity, so author CSS always wins.
      if (!body.includes('id="tdoc-reader"') && !body.includes('max-width')) {
        const rcss = readerCss();
        if (rcss) {
          const rtag = `<style id="tdoc-reader">${rcss}</style>`;
          body = /<\/head>/i.test(body) ? body.replace(/<\/head>/i, `${rtag}</head>`) : rtag + body;
        }
      }
      // Inject the anchoring probe — the only tdoc code allowed into the author
      // DOM. Nonced so it runs under the frame CSP while author <script> stays
      // inert (same guarantee as the single-origin path).
      try {
        const probe = fs.readFileSync(FRAME_PROBE_PATH, 'utf8');
        const tag = `<script nonce="${nonce}">${probe}</script>`;
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
      const reply = { id: `r_${Date.now()}`, parent_id, text, version: Number(version) || 1, author: e2eIdentity(), created, reactions: {} };
      thread.replies.push(reply);
      writeJson(file, comments);
      if (E2E_USER) {
        const parentA = localRecordAuthor(comments, parent_id);
        let title = slug;
        try { title = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'meta.json'), 'utf8')).title || slug; } catch {}
        localDeliver(parentA && parentA.login, {
          kind: 'reply', slug, version: Number(version) || 1, comment_id: reply.id,
          thread_id: thread.id, target_id: parent_id, actor: reply.author, preview: text, title, at: created,
        });
      }
      return json(res, 200, reply);
    }
    const entry = {
      id: `c_${Date.now()}`,
      version: version || 1,
      anchor: anchor || null,
      text,
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
      localDeliver(E2E_OWNER, {
        kind: 'comment', slug, version: Number(version) || 1, comment_id: entry.id,
        thread_id: entry.id, actor: entry.author, preview: text, title, at: created,
      });
    }
    return json(res, 200, entry);
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
    const top = all.find(c => c.id === id);
    if (top) {
      writeJson(file, all.filter(c => c.id !== id));
      return json(res, 200, { ok: true });
    }
    for (const c of all) {
      if (!Array.isArray(c.replies)) continue;
      if (c.replies.some(r => r.id === id)) {
        c.replies = c.replies.filter(r => r.id !== id);
        writeJson(file, all);
        return json(res, 200, { ok: true });
      }
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
    const proc = spawn(bin, args, { env: childEnv() });
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
    // Spawn hardening: an `error` listener (so an EACCES doesn't crash the whole
    // server with an unhandled 'error' event), a hard timeout (SIGTERM→SIGKILL)
    // so a hung wrangler/curl can't leave the HTTP response pending forever, and
    // a bounded output buffer so runaway child output can't OOM us. wrangler
    // legitimately needs the inherited env (CLOUDFLARE_* creds), so we keep it
    // but this endpoint is now origin/CSRF-gated above.
    const proc = spawn(bin, [slug], { env: childEnv() });
    let out = '', err = '', settled = false, killed = false;
    const CAP = 256 * 1024; // 256 KiB of captured output is plenty
    const append = (buf, d) => (buf.length < CAP ? buf + d : buf);
    const settle = (status, obj) => { if (settled) return; settled = true; clearTimeout(timer); json(res, status, obj); };
    const timer = setTimeout(() => { killed = true; proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 3000); }, 180000);
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
