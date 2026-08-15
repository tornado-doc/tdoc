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

const PORT = process.env.TDOC_PORT ? Number(process.env.TDOC_PORT) : 7878;
const ROOT = process.env.TDOC_DIR || path.join(os.homedir(), 'tdocs');
const OVERLAY_PATH = path.join(__dirname, 'overlay.js');

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
  // tdoc project mark — tdoc-agent and any login that didn't match a host.
  return 'https://github.com/tornado-doc.png';
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
  return `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none';`;
}

function injectOverlay(html, slug, version, nonce) {
  const overlay = fs.readFileSync(OVERLAY_PATH, 'utf8');
  // Hand the overlay the full version list so the bar can offer a version
  // picker. Read straight from meta.json; ignore failures and fall back to
  // the current version only.
  let versions = [{ n: version }];
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, slug, 'meta.json'), 'utf8'));
    if (Array.isArray(meta.versions) && meta.versions.length) {
      versions = meta.versions.map(v => ({ n: v.n, created: v.created || null }));
    }
  } catch {}
  // nonce is stamped onto BOTH injected <script> tags so only they run under
  // the CSP set by cspHeader() above — author content in `html` has no nonce
  // and is inert.
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const cfg = `<script${nonceAttr}>window.__TDOC__ = ${safeJsonForScript({
    slug, version, identity: null, authConfigured: false, mode: 'local', versions,
  })};</script>`;
  const inject = `${cfg}\n<script${nonceAttr}>${overlay}</script>`;
  if (html.includes('</body>')) return html.replace('</body>', `${inject}\n</body>`);
  return html + inject;
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
    const comments = readCommentFile(path.join(ROOT, slug, 'comments.json'));
    const open = comments.filter(c => c.status === 'open').length;
    return `<tr>
      <td><a href="/d/${encodeURIComponent(slug)}/v/${latest}">${escHtml(meta.title || slug)}</a></td>
      <td>${escHtml(slug)}</td>
      <td>v${latest}</td>
      <td>${open ? `<b>${open} open</b>` : '—'}</td>
      <td><button class="del" data-slug="${escHtml(slug)}" data-versions="${versionCount}" data-comments="${comments.length}">Delete</button></td>
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
  `<table><thead><tr><th>Title</th><th>Slug</th><th>Version</th><th>Comments</th><th></th></tr></thead><tbody>${rows}</tbody></table>`}
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
  // Irreversible: name exactly what disappears before acting.
  const proceed = await showConfirm({
    title: 'Delete "' + slug + '"?',
    body: 'This permanently removes <b>' + b.dataset.versions + ' version(s)</b> and <b>' + b.dataset.comments +
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

  if (p === '/') return send(res, 200, indexPage(), { 'Content-Type': 'text/html; charset=utf-8' });

  const docMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/?$/);
  if (docMatch) {
    const [, rawSlug, vStr] = docMatch;
    const slug = safeSlug(rawSlug);
    if (!slug) return send(res, 400, 'invalid slug');
    const file = path.join(ROOT, slug, `v${vStr}`, 'index.html');
    if (!fs.existsSync(file)) return send(res, 404, `Not found: ${slug} v${vStr}`);
    const html = fs.readFileSync(file, 'utf8');
    const nonce = crypto.randomBytes(16).toString('hex');
    return send(res, 200, injectOverlay(html, slug, Number(vStr), nonce), {
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
      const reply = { id: `r_${Date.now()}`, parent_id, text, version: Number(version) || 1, author: null, created, reactions: {} };
      thread.replies.push(reply);
      writeJson(file, comments);
      return json(res, 200, reply);
    }
    const entry = {
      id: `c_${Date.now()}`,
      version: version || 1,
      anchor: anchor || null,
      text,
      author: null,
      status: 'open',
      created,
      replies: [],
      reactions: {}
    };
    comments.push(entry);
    writeJson(file, comments);
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
    const me = 'anon';
    const idx = users.indexOf(me);
    if (idx >= 0) users.splice(idx, 1);
    else users.push(me);
    if (users.length === 0) delete target.reactions[emoji];
    else target.reactions[emoji] = users;
    writeJson(file, all);
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
    const proc = spawn(bin, args, { env: process.env });
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
    const proc = spawn(bin, [slug], { env: process.env });
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
