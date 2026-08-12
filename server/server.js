#!/usr/bin/env node
// tdoc local server — anonymous, $0, zero-config.
// Serves docs from ~/tdocs/<slug>/v<N>/index.html. No auth, no GitHub.
// Auth lives entirely in the published Worker. Node 18+, no deps.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
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
function agentIdentity(body = {}) {
  const fallbackLogin = process.env.TDOC_AGENT_LOGIN || process.env.USER || 'tdoc-agent';
  const fallbackName = process.env.TDOC_AGENT_NAME || fallbackLogin;
  const clean = (v, fallback) => {
    if (typeof v !== 'string') return fallback;
    const s = v.trim().slice(0, 80);
    return s || fallback;
  };
  const avatar = typeof body.agent_avatar_url === 'string' && /^https:\/\/[^ \n\r\t]+$/i.test(body.agent_avatar_url)
    ? body.agent_avatar_url
    : null;
  const login = clean(body.agent_login || body.agent_id, fallbackLogin);
  return { kind: 'agent', login, name: clean(body.agent_name, fallbackName), avatar_url: avatar };
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

function injectOverlay(html, slug, version) {
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
  const cfg = `<script>window.__TDOC__ = ${safeJsonForScript({
    slug, version, identity: null, authConfigured: false, mode: 'local', versions,
  })};</script>`;
  const inject = `${cfg}\n<script>${overlay}</script>`;
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
    const comments = readCommentFile(path.join(ROOT, slug, 'comments.json'));
    const open = comments.filter(c => c.status === 'open').length;
    return `<tr>
      <td><a href="/d/${encodeURIComponent(slug)}/v/${latest}">${escHtml(meta.title || slug)}</a></td>
      <td>${escHtml(slug)}</td>
      <td>v${latest}</td>
      <td>${open ? `<b>${open} open</b>` : '—'}</td>
    </tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>tdoc</title>
<style>
  body { font: 15px system-ui, -apple-system, sans-serif; max-width: 760px; margin: 60px auto; padding: 0 20px; color: #111; }
  h1 { font-size: 28px; margin: 0 0 4px; color: #1652f0; }
  .sub { color: #666; margin: 0 0 32px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eee; }
  th { font-size: 12px; text-transform: uppercase; color: #888; letter-spacing: 0.04em; }
  a { color: #1652f0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #888; padding: 40px 0; text-align: center; }
</style></head><body>
<h1>tdoc</h1><p class="sub">Prompt-native documents.</p>
${slugs.length === 0 ? '<p class="empty">No docs yet. Try <code>/tdoc new &lt;prompt&gt;</code>.</p>' :
  `<table><thead><tr><th>Title</th><th>Slug</th><th>Version</th><th>Comments</th></tr></thead><tbody>${rows}</tbody></table>`}
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
    return send(res, 200, injectOverlay(html, slug, Number(vStr)), { 'Content-Type': 'text/html; charset=utf-8' });
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
      const parent = comments.find(c => c.id === parent_id);
      if (!parent) return json(res, 404, { error: 'parent_not_found' });
      if (!Array.isArray(parent.replies)) parent.replies = [];
      // Persist the version the reply was made at so foldCommentsAtVersion can
      // scope it — without this the reply record has no `version` and the fold's
      // `r.version` check falls back to the parent's created_in, so replies were
      // never hidden on older versions (diverging from the worker).
      const reply = { id: `r_${Date.now()}`, parent_id, text, version: Number(version) || 1, author: null, created, reactions: {} };
      parent.replies.push(reply);
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
    const parent = all.find(c => c.id === parent_id);
    if (!parent) return json(res, 404, { error: 'parent_not_found' });
    if (!Array.isArray(parent.replies)) parent.replies = [];
    const agent = agentIdentity(body);
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
