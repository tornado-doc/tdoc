// tdoc Cloudflare Worker — published view + GitHub Device Flow auth.
//
// Bindings (wrangler.toml):
//   DOCS   — R2 bucket (key: docs/<slug>/v<N>/index.html)
//   META   — KV namespace
// Vars:
//   GITHUB_CLIENT_ID — from wrangler [vars]; SoT is shared/github-oauth.js
// Secrets:
//   TDOC_UPLOAD_TOKEN — shared secret for /api/upload from `tdoc publish`
//
// IMPORTANT: This file contains placeholder strings (`__TDOC_BUILD_INFO__`,
// the chrome/shell/probe module and CSS placeholders below). bin/tdoc-bundle
// replaces them before deploy, producing worker/_worker.bundled.js. Do not
// deploy worker.js directly — the chrome/provenance would be missing.

// Cross-origin shell modules, inlined by bin/tdoc-bundle. The chrome + shell
// builder are inlined as CODE right here (Workers ban eval, so each self-
// registers on globalThis when it runs at module load); the chrome + probe are
// also kept as client strings for inlining into the shell / frame documents.
/* __TDOC_CHROME_MODULE__ */
/* __TDOC_SHELL_MODULE__ */
const CHROME_JS = `__TDOC_CHROME_JS__`;
const PROBE_JS = `__TDOC_PROBE_JS__`;
const CHROME_CSS = `__TDOC_CHROME_CSS__`;
const MANAGE_JS = `__TDOC_MANAGE_JS__`;
const READER_CSS = `__TDOC_READER_CSS__`;
const CHROME = (typeof globalThis !== 'undefined' && globalThis.TDOC_CHROME) || {};
const SHELL = (typeof globalThis !== 'undefined' && globalThis.TDOC_SHELL_BUILDER) || null;


const TDOC_BUILD_INFO = "__TDOC_BUILD_INFO__";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(init.headers || {}) },
  });
}
function text(body, init = {}) {
  return new Response(body, {
    status: init.status || 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...(init.headers || {}) },
  });
}
function html(body, init = {}) {
  return new Response(body, {
    status: init.status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...(init.headers || {}) },
  });
}

function runtimeInfo() {
  const b = TDOC_BUILD_INFO && typeof TDOC_BUILD_INFO === 'object' ? TDOC_BUILD_INFO : {};
  return {
    service: 'tdoc',
    mode: 'published',
    source_sha: b.source_sha || null,
    source_dirty: !!b.source_dirty,
    worker_sha: b.worker_sha || null,
    bundle_sha: b.bundle_sha || null,
    built_at: b.built_at || null,
    generated_by: b.generated_by || 'unknown',
  };
}

function parseCookie(req) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(/tdoc_sid=([a-f0-9]+)/);
  return m ? m[1] : null;
}
async function getSession(env, req) {
  const sid = parseCookie(req);
  if (!sid) return null;
  const raw = await env.META.get(`session:${sid}`);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return { id: sid, ...data };
  } catch { return null; }
}
// The worker operator = the GitHub login configured in TDOC_OWNER at deploy.
// On BYOK (hosted registration off) only that signed-in viewer sees /me.
// On hosted tdoc.dev, /me is per signed-in GitHub user; TDOC_OWNER still
// owns legacy docs with no hosted.github_login. Case-insensitive; if
// TDOC_OWNER is unset, nobody is operator.
function isOwnerSession(env, session) {
  const owner = (env.TDOC_OWNER || '').trim().toLowerCase();
  if (!owner || !session || !session.login) return false;
  return session.login.toLowerCase() === owner;
}
// Authorization for mutating a comment/reply: DENY by default. Allow only the
// record's author or the doc owner. Critically, a record with a null/absent
// author (legacy pre-event-log records produced by ensureEventLog) is NOT
// mutable by an arbitrary signed-in user — the previous `if (author && ...)`
// pattern short-circuited to "allow" on null, letting any GitHub session
// delete/re-anchor authorless legacy comments. Same logic for the three
// mutation sites, in one place.
function canMutate(record, session, env, meta) {
  if (isDocOwnerSession(env, session, meta)) return true;
  const who = record && record.author && record.author.login;
  return !!(who && session && session.login && who === session.login);
}

// ─────────────────────────────────────────────────────────────────────────
// Access policy (JUL-31)
//
// Product ladder on published docs:
//   public   — anyone with the link can read; may appear in future discovery
//   unlisted — anyone with the link can read; never listed in catalogs
//   private  — owner + allowlisted GitHub logins only (sign-in required)
//
// Pure-publish default for NEW meta written by tdoc-publish:
//   history_visibility = owner (readers see only the requested version)
// Missing/legacy meta without `access` stays world-readable for back-compat.
// ─────────────────────────────────────────────────────────────────────────
const ACCESS_VISIBILITIES = new Set(['public', 'unlisted', 'private']);
const ACCESS_COMMENTING = new Set(['owner', 'invited', 'signed_in', 'off']);
const ACCESS_HISTORY = new Set(['owner', 'invited', 'public']);
const ACCESS_PATCH_FIELDS = new Set(['visibility', 'commenting', 'history_visibility', 'allowed_users']);

function sessionLogin(session) {
  return session && typeof session.login === 'string' && session.login
    ? session.login.trim().toLowerCase()
    : null;
}

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

// Publisher GitHub login stamped on hosted-tenant meta. Empty on BYOK / legacy
// docs — those still belong to TDOC_OWNER.
function hostedGithubLogin(meta) {
  return meta && meta.hosted ? normalizeGithubLogin(meta.hosted.github_login) : null;
}

// True when this session owns this document:
//   - hosted: meta.hosted.github_login matches the session
//   - unhosted / legacy: the Worker operator (TDOC_OWNER)
function isDocOwnerSession(env, session, meta) {
  const login = sessionLogin(session);
  if (!login) return false;
  const hostedLogin = hostedGithubLogin(meta);
  if (hostedLogin) return hostedLogin === login;
  return isOwnerSession(env, session);
}

// Normalize meta.access. `legacy` chooses defaults when the field is absent:
//   true  → back-compat for already-published docs (public + full history)
//   false → product defaults for newly written policy objects
function normalizeAccess(raw, { legacy = true } = {}) {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const visibility = ACCESS_VISIBILITIES.has(a.visibility)
    ? a.visibility
    : (legacy ? 'public' : 'unlisted');
  const commenting = ACCESS_COMMENTING.has(a.commenting)
    ? a.commenting
    : 'signed_in';
  const history_visibility = ACCESS_HISTORY.has(a.history_visibility)
    ? a.history_visibility
    : (legacy ? 'public' : 'owner');
  const allowed = [];
  const seen = new Set();
  const srcList = Array.isArray(a.allowed_users) ? a.allowed_users : [];
  for (const item of srcList) {
    const login = normalizeGithubLogin(item);
    if (!login || seen.has(login)) continue;
    seen.add(login);
    allowed.push(login);
  }
  return { visibility, commenting, history_visibility, allowed_users: allowed };
}

function accessFromMeta(meta) {
  const has = meta && meta.access && typeof meta.access === 'object';
  return normalizeAccess(has ? meta.access : null, { legacy: !has });
}

function validateAccessWrite(access) {
  if (!access || typeof access !== 'object' || Array.isArray(access)) {
    return { error: 'access object required' };
  }
  const keys = Object.keys(access);
  const unknown = keys.filter((k) => !ACCESS_PATCH_FIELDS.has(k));
  if (unknown.length) return { error: 'invalid_access_field', fields: unknown };

  const out = {};
  if ('visibility' in access) {
    if (!ACCESS_VISIBILITIES.has(access.visibility)) {
      return { error: 'invalid_access_value', field: 'visibility' };
    }
    out.visibility = access.visibility;
  }
  if ('commenting' in access) {
    if (!ACCESS_COMMENTING.has(access.commenting)) {
      return { error: 'invalid_access_value', field: 'commenting' };
    }
    out.commenting = access.commenting;
  }
  if ('history_visibility' in access) {
    if (!ACCESS_HISTORY.has(access.history_visibility)) {
      return { error: 'invalid_access_value', field: 'history_visibility' };
    }
    out.history_visibility = access.history_visibility;
  }
  if ('allowed_users' in access) {
    if (!Array.isArray(access.allowed_users)) {
      return { error: 'invalid_access_value', field: 'allowed_users' };
    }
    const allowed = [];
    const seen = new Set();
    for (const item of access.allowed_users) {
      const login = normalizeGithubLogin(item);
      if (!login) return { error: 'invalid_access_value', field: 'allowed_users' };
      if (seen.has(login)) continue;
      seen.add(login);
      allowed.push(login);
    }
    out.allowed_users = allowed;
  }
  return { access: out };
}

function applyAccessPatch(meta, patch) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { error: 'missing_meta' };
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: 'access object required' };
  }
  const keys = Object.keys(patch);
  if (!keys.length) return { error: 'access patch required' };
  const validated = validateAccessWrite(patch);
  if (validated.error) return validated;

  // A remote access mutation creates/updates only the access policy. If the doc
  // has legacy meta without access, switch to product defaults instead of
  // carrying public-history legacy defaults into a newly managed policy.
  const base = meta.access && typeof meta.access === 'object'
    ? normalizeAccess(meta.access, { legacy: false })
    : normalizeAccess({}, { legacy: false });
  const next = normalizeAccess({ ...base, ...validated.access }, { legacy: false });
  return { meta: { ...meta, access: next }, access: next };
}

function isAllowlisted(access, session, env, meta) {
  if (isDocOwnerSession(env, session, meta)) return true;
  const login = sessionLogin(session);
  if (!login) return false;
  return (access.allowed_users || []).includes(login);
}

function canReadDoc(access, session, env, meta) {
  if (access.visibility === 'public' || access.visibility === 'unlisted') return true;
  return isAllowlisted(access, session, env, meta);
}

function canSeeHistory(access, session, env, meta) {
  if (access.history_visibility === 'public') return true;
  if (access.history_visibility === 'invited') return isAllowlisted(access, session, env, meta);
  // owner — the doc publisher (hosted GitHub login) or TDOC_OWNER on legacy docs
  return isDocOwnerSession(env, session, meta);
}

function canCommentOnDoc(access, session, env, meta) {
  if (access.commenting === 'off') return false;
  if (!sessionLogin(session)) return false;
  if (access.commenting === 'signed_in') return true;
  if (access.commenting === 'owner') return isDocOwnerSession(env, session, meta);
  if (access.commenting === 'invited') return isAllowlisted(access, session, env, meta);
  return false;
}

async function loadDocMeta(env, slug) {
  try {
    const raw = await env.META.get(`meta:${slug}`);
    if (!raw) return null;
    const meta = JSON.parse(raw);
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

function accessDeniedHtml({ status, title, body, slug, version }) {
  const next = slug && version ? `/d/${encodeURIComponent(slug)}/v/${version}` : '/';
  return html(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · tdoc</title>
<style>
  body{font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;
    display:flex;align-items:center;justify-content:center;background:#fff;color:#111}
  .box{max-width:420px;padding:28px 24px;border:1px solid #e5e7eb;border-radius:12px}
  h1{font-size:18px;margin:0 0 8px}
  p{margin:0 0 14px;color:#444}
  a{color:#1652f0}
  .meta{font-size:12px;color:#888;margin-top:18px}
</style></head><body><div class="box">
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(body)}</p>
  <p><a href="${escapeHtml(next)}">Retry this link</a> after signing in from any page on this host that shows the tdoc bar.</p>
  <p class="meta">tdoc access control</p>
</div></body></html>`, { status });
}

// A CLI request proves who it is with the account token from
// ~/.tdoc/published.json, not with a browser cookie, so getSession() sees an
// anonymous visitor. Resolve the token exactly the way the upload path does and
// accept it when it owns THIS doc.
//
// This grants read access to precisely the set of docs the same token can
// already overwrite — requireDocWriteAccess compares the same two account ids —
// so it widens nothing. It deliberately does NOT produce a session: the caller
// keeps the real (possibly null) one, so no synthetic identity can be rendered
// into a page or attributed to a comment.
async function docOwnerToken(env, req, meta) {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const token = m[1];
  // Self-host: the worker's own admin token already writes anything here.
  if (env.TDOC_UPLOAD_TOKEN && await timingSafeEqual(token, env.TDOC_UPLOAD_TOKEN)) {
    return { kind: 'admin' };
  }
  const actor = await hostedTokenActor(env, token);
  if (!actor) return null;
  const ownerId = meta && meta.hosted && meta.hosted.account_id;
  if (!ownerId || ownerId !== actor.account_id) return null;
  return actor;
}

async function enforceDocAccess(env, req, slug, version) {
  const meta = await loadDocMeta(env, slug);
  // No meta yet (orphan R2 object) — treat as public so legacy uploads still work.
  const access = accessFromMeta(meta || {});
  const session = await getSession(env, req);
  if (canReadDoc(access, session, env, meta)) {
    return { ok: true, access, session, meta };
  }
  // Without this the owner is denied their own private doc from their own
  // terminal: /tdoc pull is the documented pre-step to /tdoc edit, and
  // FIRST-DOC.md publishes every new user's first doc as private. See #278.
  if (await docOwnerToken(env, req, meta)) {
    return { ok: true, access, session, meta, ownerToken: true };
  }
  if (!sessionLogin(session)) {
    return {
      ok: false,
      response: accessDeniedHtml({
        status: 401,
        title: 'Sign in required',
        body: 'This document is private. Sign in with GitHub, then open the link again. Only allowlisted accounts can read it.',
        slug, version,
      }),
    };
  }
  return {
    ok: false,
    response: accessDeniedHtml({
      status: 403,
      title: 'Access denied',
      body: `Signed in as ${session.login}, but this private document does not include you on the allowlist.`,
      slug, version,
    }),
  };
}
const TDOC_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" role="img" aria-label="tdoc">
  <!-- The mark, traced from the 1254px master. No background field: the ink is
       currentColor, so an inlined copy follows the surrounding text and the
       page-level dark invert turns it white on its own. A solid field would
       flip to a black box instead. -->
  <g transform="translate(0,1000) scale(1,-1)" fill="currentColor" fill-rule="evenodd">
    <path d="M748.54 760.56 c-1.59 -0.11 -6.24 -0.32 -10.32 -0.48 -8.89 -0.32 -16.27 -0.71 -20.77 -1.11
-3.6 -0.32 -10.26 -0.63 -21.03 -1.03 -3.78 -0.13 -7.59 -0.32 -8.47 -0.37 -2.7 -0.26 -10.66 -0.66 -20.5
-1.08 -5.16 -0.24 -10.69 -0.53 -12.3 -0.66 -1.59 -0.16 -6.11 -0.4 -10.05 -0.53 -7.35 -0.29 -12.94 -0.58
-20.5 -1.03 -6.53 -0.42 -13.36 -0.82 -18.25 -1.08 -2.41 -0.13 -6.85 -0.42 -9.92 -0.63 -3.04 -0.21 -8.28
-0.53 -11.64 -0.69 -3.33 -0.16 -7.94 -0.42 -10.19 -0.56 -6.14 -0.37 -17.38 -0.98 -26.32 -1.43 -10.42 -0.53
-21.35 -1.14 -23.02 -1.32 -0.71 -0.08 -3.52 -0.26 -6.22 -0.4 -2.7 -0.13 -6.19 -0.37 -7.8 -0.53 -3.76
-0.34 -9.37 -0.69 -19.58 -1.19 -4.5 -0.21 -10.11 -0.53 -12.43 -0.66 -8.17 -0.5 -13.28 -0.79 -18.92 -1.06
-3.12 -0.16 -6.27 -0.32 -7.01 -0.4 -1.51 -0.16 -15.08 -1.03 -24.74 -1.59 -3.57 -0.21 -8.49 -0.5 -10.98
-0.63 -2.46 -0.16 -6.69 -0.4 -9.39 -0.56 -2.7 -0.13 -5.71 -0.37 -6.75 -0.53 -1.01 -0.13 -3.99 -0.37 -6.61
-0.53 -4.92 -0.26 -10.66 -0.61 -17.99 -1.06 -2.33 -0.16 -6.48 -0.42 -9.26 -0.63 -6.98 -0.53 -12.04 -0.87
-20.63 -1.35 -4.07 -0.24 -9.18 -0.53 -11.38 -0.66 -2.17 -0.13 -5.16 -0.32 -6.61 -0.4 -1.46 -0.11 -3.6 -0.26
-4.76 -0.4 -2.83 -0.32 -13.25 -0.98 -18.65 -1.19 -4.1 -0.16 -6.85 -0.4 -16.01 -1.32 -2.04 -0.21 -5.66
-0.53 -8.07 -0.66 -2.41 -0.16 -6.35 -0.45 -8.78 -0.69 -2.43 -0.21 -6.38 -0.56 -8.73 -0.77 -2.38 -0.21 -5.56
-0.56 -7.09 -0.77 -1.53 -0.21 -4.79 -0.58 -7.28 -0.79 -2.46 -0.24 -5.21 -0.56 -6.06 -0.71 -2.8 -0.5
-4.97 -1.9 -6.4 -4.13 -1.96 -3.1 -2.41 -5.69 -1.46 -8.57 1.38 -4.1 3.36 -6.19 6.85 -7.25 1.69
-0.53 12.59 -0.53 17.78 0 2.12 0.21 5.45 0.53 7.41 0.66 1.96 0.16 3.76 0.34 3.99 0.42 0.37 0.11 3.57 0.42 11.48 1.16
1.46 0.13 3.97 0.42 5.56 0.66 1.61 0.21 3.76 0.5 4.76 0.66 1.03 0.13 2.8 0.32 3.97 0.4 1.16 0.11 3.54 0.34 5.29 0.53
1.75 0.21 5.08 0.5 7.41 0.66 2.33 0.16 5.61 0.4 7.28 0.56 1.67 0.13 4.89 0.37 7.14 0.5 2.25 0.16 5.34 0.37 6.88 0.53
1.53 0.13 3.86 0.32 5.16 0.4 1.32 0.11 3.94 0.34 5.82 0.56 1.9 0.19 4.34 0.37 5.42 0.37 1.08 0 3.47 0.11 5.29 0.26
1.83 0.13 5.82 0.42 8.86 0.66 8.44 0.61 18.94 1.43 22.35 1.75 1.67 0.13 5.05 0.37 7.51 0.5 2.46 0.13 5.4 0.37 6.48
0.5 1.11 0.16 2.96 0.34 4.13 0.42 5.4 0.34 10.16 0.71 14.29 1.06 5.53 0.48 10.98 0.9 15.9 1.19 2.06 0.11 5.26 0.34
7.14 0.5 9.44 0.82 16.43 1.3 26.69 1.88 2.62 0.13 5.24 0.32 5.82 0.4 1.19 0.16 7.22 0.56 14.02 0.93 2.49 0.13 6.3
0.37 8.47 0.53 7.65 0.53 15.9 1.03 18.92 1.19 1.67 0.08 4.71 0.26 6.75 0.4 2.04 0.13 7.33 0.42 11.77 0.66 4.44 0.21
11.69 0.63 16.14 0.93 8.54 0.56 19.44 1.16 28.84 1.59 7.22 0.34 14.05 0.71 19.44 1.06 2.33 0.13 7.57 0.45 11.64 0.66
4.07 0.24 9.21 0.53 11.38 0.66 2.2 0.16 7.3 0.45 11.38 0.66 4.07 0.21 10.21 0.56 13.62 0.79 10.4 0.66 17.38 1.06
35.98 1.98 2.83 0.13 6.48 0.37 8.07 0.5 1.61 0.16 4.76 0.34 7.01 0.42 2.25 0.08 6.06 0.26 8.47 0.4 2.41 0.16 6.98
0.4 10.19 0.53 3.2 0.13 8.57 0.37 11.9 0.53 3.36 0.13 7.57 0.37 9.39 0.53 1.83 0.13 4.92 0.37 6.88 0.53 1.96 0.16
4.81 0.4 6.35 0.53 1.53 0.13 3.92 0.24 5.29 0.26 3.49 0 5.4 0.69 7.57 2.72 1.35 1.24 1.75 1.83 2.2 3.15 1.8
5.32 -0.95 10.34 -6.61 12.09 -1.03 0.32 -4.39 0.32 -8.84 0z M681.22 710.03 c-0.5 -0.13 -3.17 -0.48 -5.95 -0.77 -2.75 -0.26 -6.51 -0.69 -8.33 -0.9
-1.83 -0.24 -5.08 -0.61 -7.28 -0.82 -4.18 -0.42 -6.72 -0.74 -14.68 -1.85 -2.7 -0.4 -6.32 -0.87 -8.07
-1.08 -1.75 -0.21 -4.42 -0.61 -5.95 -0.87 -3.07 -0.56 -6.56 -1.11 -10.98 -1.72 -4.74 -0.66 -9.79 -1.46
-13.89 -2.14 -2.12 -0.34 -5.03 -0.82 -6.48 -1.06 -5.53 -0.87 -7.72 -1.24 -9.79 -1.59 -2.51 -0.45 -9.31
-1.59 -12.83 -2.14 -1.38 -0.21 -3.23 -0.53 -4.1 -0.66 -0.87 -0.13 -2.78 -0.42 -4.23 -0.63 -1.46 -0.21 -3.07
-0.48 -3.57 -0.63 -0.5 -0.13 -2.3 -0.45 -3.97 -0.69 -1.67 -0.24 -4.89 -0.79 -7.14 -1.19 -2.25 -0.42 -4.76
-0.85 -5.56 -0.93 -1.53 -0.19 -15.24 -2.46 -19.05 -3.17 -1.24 -0.24 -2.91 -0.53 -3.7 -0.63 -0.79 -0.13 -2.94
-0.53 -4.76 -0.9 -1.83 -0.37 -4.26 -0.82 -5.42 -0.98 -1.16 -0.16 -3.36 -0.53 -4.89 -0.82 -1.53 -0.26
-3.84 -0.69 -5.16 -0.9 -1.3 -0.24 -3.2 -0.58 -4.23 -0.79 -4.34 -0.87 -6.14 -1.19 -6.72 -1.19 -0.34 0
-1.4 -0.16 -2.38 -0.37 -2.83 -0.63 -8.7 -1.72 -12.86 -2.41 -2.49 -0.42 -3.65 -0.63 -8.6 -1.59 -1.08 -0.19
-3.04 -0.56 -4.37 -0.79 -1.3 -0.24 -3.28 -0.61 -4.37 -0.82 -1.08 -0.21 -2.88 -0.56 -3.97 -0.77 -1.75 -0.34
-6.35 -1.19 -12.7 -2.38 -1.08 -0.19 -2.51 -0.42 -3.17 -0.53 -0.66 -0.11 -1.61 -0.29 -2.12 -0.4 -0.9 -0.24
-2.99 -0.58 -8.33 -1.46 -1.46 -0.24 -3.25 -0.61 -3.99 -0.82 -0.74 -0.21 -1.61 -0.37 -1.93 -0.37 -0.32 0 -1.32
-0.16 -2.22 -0.37 -0.9 -0.21 -2.78 -0.58 -4.15 -0.82 -2.7 -0.48 -5.61 -1.01 -8.6 -1.59 -1.01 -0.21 -2.99
-0.56 -4.37 -0.79 -1.38 -0.24 -3.33 -0.61 -4.37 -0.82 -4.29 -0.9 -5.69 -1.16 -8.07 -1.56 -1.38 -0.24
-3.28 -0.58 -4.23 -0.79 -3.07 -0.69 -5.9 -1.24 -9.39 -1.88 -1.88 -0.34 -5.21 -0.98 -7.41 -1.43 -2.17
-0.45 -4.97 -0.98 -6.22 -1.19 -1.24 -0.21 -3.07 -0.58 -4.1 -0.79 -1.75 -0.42 -2.57 -0.58 -7.54 -1.56 -1.08
-0.21 -2.75 -0.58 -3.7 -0.79 -0.95 -0.21 -3.25 -0.71 -5.16 -1.08 -5.5 -1.08 -8.86 -1.77 -10.71 -2.12
-1.51 -0.29 -4.84 -1.03 -10.98 -2.41 -1.01 -0.24 -2.57 -0.58 -3.44 -0.77 -0.87 -0.19 -2.41 -0.53 -3.44 -0.79
-4.1 -1.01 -7.22 -1.72 -8.86 -2.01 -4.95 -0.9 -8.02 -4.07 -8.41 -8.73 -0.21 -2.67 1.9 -6.35 4.44
-7.65 2.35 -1.19 5.61 -1.64 7.67 -1.06 0.5 0.16 2.49 0.53 4.37 0.82 1.9 0.32 4.21 0.71 5.16 0.93 0.95 0.21 2.96
0.61 4.5 0.9 6.32 1.22 6.69 1.27 15.34 3.07 1.08 0.21 2.83 0.56 3.84 0.77 3.31 0.69 5.77 1.22 7.94 1.72 1.16
0.29 3.73 0.82 5.69 1.22 1.96 0.37 7.09 1.38 11.38 2.25 4.29 0.87 9.37 1.88 11.24 2.25 5.24 0.98 6.16 1.16 8.6
1.69 1.24 0.26 3.02 0.61 3.97 0.77 0.95 0.13 3.15 0.56 4.89 0.9 1.75 0.37 3.94 0.79 4.89 0.98 2.2 0.4 4.76 0.9
7.94 1.56 3.62 0.74 11.83 2.33 15.21 2.91 5.03 0.9 11.88 2.2 12.04 2.28 0.08 0.05 2.51 0.5 5.42 1.03 2.91 0.53
6.19 1.14 7.28 1.32 1.08 0.21 2.99 0.58 4.23 0.82 5.13 0.95 12.67 2.3 14.29 2.54 0.95 0.13 2.25 0.37 2.91 0.5 1.67
0.4 9.6 1.83 15.21 2.75 1.16 0.21 3.97 0.74 6.22 1.19 2.25 0.48 7.91 1.48 12.59 2.28 4.66 0.79 9.97 1.72 11.77
2.09 1.8 0.34 3.94 0.71 4.74 0.82 1.4 0.16 4.37 0.66 12.54 2.12 2.2 0.4 5.05 0.87 6.35 1.06 1.32 0.21 3.41 0.56
4.66 0.79 1.24 0.24 3.62 0.66 5.29 0.93 1.67 0.26 4.52 0.74 6.35 1.06 1.83 0.29 4.26 0.71 5.42 0.93 1.16 0.19 3.07
0.5 4.23 0.66 1.16 0.16 3.36 0.53 4.89 0.79 1.53 0.26 4.15 0.74 5.82 1.03 1.67 0.29 5.13 0.82 7.67 1.22 2.54 0.37
5.24 0.77 5.95 0.9 0.74 0.16 2.57 0.45 4.1 0.69 1.53 0.24 3.86 0.61 5.16 0.79 1.32 0.21 3.57 0.56 5.03 0.79 1.46 0.21
4.84 0.74 7.54 1.16 2.7 0.45 5.98 0.93 7.28 1.08 1.32 0.16 3.62 0.5 5.16 0.79 1.53 0.26 3.49 0.58 4.37 0.66
0.87 0.11 3.39 0.48 5.56 0.85 2.2 0.34 5.69 0.87 7.8 1.14 2.12 0.29 4.6 0.63 5.56 0.79 0.95 0.13 2.67 0.37 3.84
0.5 1.16 0.13 4.26 0.56 6.88 0.93 2.62 0.37 6.14 0.87 7.8 1.11 1.67 0.24 4.87 0.71 7.09 1.06 2.22 0.34 5.13 0.71
6.48 0.79 6.88 0.48 10.4 3.31 11.22 9.02 0.34 2.51 -1.48 6.11 -3.86 7.59 -2.17 1.35 -6.27 1.9 -9.02 1.19z M683.47 634.13 c-3.04 -0.13 -7.65 -0.34 -10.19 -0.5 -2.54 -0.13 -7.3 -0.34 -10.58 -0.42
-5.71 -0.13 -10.05 -0.34 -20.63 -0.95 -2.7 -0.16 -6.85 -0.4 -9.26 -0.5 -2.41 -0.13 -6.14 -0.34 -8.33
-0.5 -2.17 -0.16 -6.59 -0.4 -9.79 -0.56 -3.2 -0.16 -9.02 -0.48 -12.96 -0.66 -3.92 -0.21 -9.63 -0.5
-12.7 -0.66 -3.04 -0.13 -6.22 -0.32 -7.01 -0.4 -1.85 -0.19 -15.11 -0.85 -23.41 -1.19 -3.49 -0.13 -7.96
-0.37 -9.92 -0.53 -1.96 -0.16 -6.06 -0.4 -9.13 -0.53 -6.35 -0.32 -15.95 -0.87 -25 -1.43 -3.41 -0.24
-8.31 -0.53 -10.85 -0.69 -2.54 -0.13 -6.06 -0.4 -7.8 -0.53 -3.6 -0.32 -23.07 -1.48 -30.82 -1.85 -2.83
-0.13 -6.93 -0.37 -9.13 -0.53 -2.17 -0.13 -6.59 -0.4 -9.79 -0.53 -12.54 -0.58 -21.01 -1.11 -29.89 -1.88
-5.08 -0.42 -10.98 -0.9 -13.1 -1.03 -2.12 -0.13 -5.45 -0.37 -7.41 -0.53 -1.96 -0.16 -5.66 -0.4 -8.2
-0.53 -5.16 -0.26 -14.29 -0.85 -23.25 -1.46 -3.25 -0.21 -7.86 -0.5 -10.19 -0.66 -7.57 -0.48 -15.29 -1.06
-18.02 -1.35 -1.46 -0.13 -4.07 -0.37 -5.82 -0.5 -4.52 -0.34 -11.06 -0.98 -13.23 -1.3 -1.01 -0.13 -3.86
-0.4 -6.35 -0.56 -2.46 -0.19 -4.97 -0.48 -5.58 -0.69 -3.12 -1.06 -5.53 -3.31 -6.46 -6.03 -0.63 -1.88
-0.66 -3.02 -0.13 -4.71 1.61 -5.34 6.19 -7.54 13.62 -6.56 1.96 0.26 5.19 0.5 15.61 1.19 19.37 1.3 25.45
1.75 34.13 2.54 1.67 0.16 4.84 0.37 7.01 0.5 4.21 0.24 19.76 1.32 28.57 1.98 9.26 0.71 16.75 1.19 23.15 1.46 3.41
0.16 6.4 0.32 6.61 0.4 0.21 0.08 2.72 0.24 5.56 0.4 11.14 0.56 23.15 1.3 30.56 1.85 1.9 0.13 4.81 0.32 6.48 0.4
1.67 0.08 4.29 0.26 5.82 0.4 1.53 0.13 4.92 0.37 7.54 0.53 9.66 0.56 24.39 1.46 30.29 1.88 3.99 0.26 8.2 0.48
19.44 1.03 3.07 0.13 7.41 0.37 9.66 0.5 2.25 0.16 7.14 0.4 10.85 0.56 3.7 0.16 9.1 0.48 11.96 0.69 2.88 0.21 6.32
0.37 7.67 0.37 1.35 0 3.47 0.11 4.71 0.26 1.24 0.13 4.92 0.37 8.2 0.53 3.28 0.13 10.19 0.5 15.34 0.79 5.16 0.29
11.72 0.66 14.55 0.79 2.83 0.13 7.35 0.37 10.05 0.53 2.7 0.16 7.99 0.45 11.77 0.66 3.78 0.21 8.92 0.53 11.38 0.66
7.04 0.4 14.5 0.77 21.69 1.06 10.4 0.42 16.98 0.77 19.63 1.06 1.35 0.16 3.49 0.26 4.79 0.26 6.24 0 10.11 3.52
10.11 9.18 0 3.36 -1.64 5.95 -4.76 7.54 l-1.72 0.87 -4.89 0.03 c-2.7 0.03 -7.38 -0.05 -10.45 -0.16z M666.67 589.13 c-0.5 -0.13 -3.73 -0.58 -7.14 -1.03 -11.56 -1.46 -14.68 -1.88 -17.72 -2.38
-1.67 -0.26 -4.34 -0.69 -5.95 -0.93 -1.59 -0.24 -3.49 -0.53 -4.23 -0.69 -4.95 -0.9 -7.22 -1.3 -9.66
-1.67 -1.53 -0.24 -3.57 -0.61 -4.52 -0.82 -0.98 -0.21 -2.06 -0.4 -2.43 -0.4 -0.37 0 -1.53 -0.16 -2.59 -0.37
-1.08 -0.21 -3.2 -0.58 -4.74 -0.82 -2.54 -0.4 -4.37 -0.74 -7.67 -1.46 -0.66 -0.16 -2.09 -0.4 -3.17 -0.53
-2.49 -0.32 -6.3 -1.01 -6.59 -1.16 -0.21 -0.16 -2.67 -0.58 -5.45 -0.98 -1.01 -0.13 -2.75 -0.42 -3.84 -0.66
-3.73 -0.74 -5.95 -1.14 -8.33 -1.56 -2.46 -0.42 -3.47 -0.63 -10.45 -1.98 -2.25 -0.42 -5.11 -0.98 -6.35
-1.19 -1.24 -0.24 -2.83 -0.53 -3.57 -0.66 -0.71 -0.16 -3.33 -0.63 -5.82 -1.06 -4.37 -0.79 -6.64 -1.22
-10.71 -2.01 -1.08 -0.21 -2.99 -0.56 -4.23 -0.77 -1.24 -0.21 -3.07 -0.58 -4.1 -0.79 -1.01 -0.24 -2.8 -0.58
-3.97 -0.79 -1.16 -0.21 -3.12 -0.56 -4.37 -0.79 -1.24 -0.24 -3.02 -0.53 -3.97 -0.69 -0.95 -0.13 -2.06 -0.37
-2.51 -0.5 -0.42 -0.13 -2.41 -0.56 -4.37 -0.9 -1.96 -0.37 -4.63 -0.9 -5.95 -1.19 -1.3 -0.26 -3.39 -0.69
-4.63 -0.93 -3.86 -0.74 -8.76 -1.69 -11.35 -2.25 -1.35 -0.32 -3.31 -0.66 -4.37 -0.82 -1.03 -0.13 -2.83
-0.45 -3.99 -0.69 -4.42 -0.9 -5.63 -1.14 -8.6 -1.67 -1.67 -0.32 -3.81 -0.74 -4.76 -0.95 -0.95 -0.21
-3.1 -0.61 -4.76 -0.93 -1.67 -0.32 -3.99 -0.74 -5.16 -0.95 -1.16 -0.21 -2.59 -0.5 -3.17 -0.63 -1.56 -0.37
-19.6 -3.99 -21.3 -4.29 -0.79 -0.13 -2.17 -0.4 -3.04 -0.61 -0.87 -0.19 -3.54 -0.74 -5.95 -1.19 -2.41
-0.45 -5.13 -0.98 -6.08 -1.19 -1.64 -0.37 -5.26 -1.06 -11.77 -2.28 -1.59 -0.29 -3.39 -0.63 -3.97 -0.77
-1.14 -0.29 -5.21 -1.08 -8.86 -1.75 -1.24 -0.21 -2.67 -0.5 -3.17 -0.63 -1.61 -0.42 -14.34 -2.96 -16.53
-3.33 -1.16 -0.19 -3.36 -0.61 -4.89 -0.98 -1.53 -0.34 -3.78 -0.85 -5.03 -1.08 -5.37 -1.03 -17.04 -3.39
-19.84 -3.99 -5.66 -1.22 -6.75 -1.43 -8.86 -1.85 -1.16 -0.24 -2.7 -0.58 -3.44 -0.79 -2.12 -0.58 -3.99
-0.95 -5.77 -1.19 -3.7 -0.45 -6.98 -2.99 -8.2 -6.35 -0.87 -2.33 -0.45 -5.74 0.95 -7.75 0.66 -0.95
3.2 -2.67 4.76 -3.2 1.69 -0.58 5 -0.53 8.12 0.08 1.38 0.29 3.6 0.71 4.89 0.95 1.32 0.24 3.15 0.58 4.1
0.79 0.95 0.21 2.72 0.56 3.97 0.79 1.24 0.24 3.02 0.61 3.97 0.79 3.86 0.85 5.53 1.19 7.8 1.69 1.32 0.26 3.28 0.63
4.37 0.82 1.08 0.16 2.94 0.53 4.1 0.79 1.16 0.29 3.25 0.71 4.63 0.95 1.38 0.24 3.52 0.66 4.76 0.95 2.94 0.63 6.48
1.38 10.71 2.2 1.9 0.37 5.16 1.01 7.28 1.46 2.12 0.42 4.84 0.98 6.08 1.22 1.24 0.24 3.02 0.58 3.97 0.77 0.95 0.19
3.33 0.66 5.29 1.03 1.96 0.4 4.05 0.82 4.63 0.95 0.58 0.13 1.53 0.32 2.12 0.4 0.58 0.08 2.25 0.45 3.7 0.79 1.46 0.34
4.42 0.93 6.56 1.3 2.17 0.37 4.02 0.74 4.15 0.82 0.11 0.08 0.9 0.24 1.77 0.37 2.86 0.42 9.18 1.61 12.65 2.38 1.9 0.42
4.92 1.03 6.75 1.38 1.83 0.32 4.07 0.74 5.03 0.93 0.95 0.19 3.33 0.63 5.29 1.01 1.96 0.37 4.34 0.85 5.29 1.06
3.57 0.77 4.44 0.95 7.54 1.48 1.75 0.29 3.65 0.66 4.23 0.79 4.15 0.95 8.99 1.96 10.45 2.12 0.95 0.11 3.28 0.5
5.16 0.87 3.12 0.66 5.16 1.06 8.99 1.77 0.74 0.13 2.75 0.48 4.5 0.79 2.99 0.5 4.47 0.82 8.6 1.72 0.95 0.19
2.86 0.56 4.23 0.79 1.38 0.24 3.23 0.58 4.1 0.79 0.87 0.19 2.72 0.56 4.1 0.79 1.38 0.26 3.6 0.69 4.89 0.95 2.3
0.45 4.58 0.87 9.26 1.69 1.16 0.21 3.2 0.63 4.5 0.93 1.32 0.29 4.18 0.85 6.35 1.19 6.08 0.98 8.62 1.43 9.1
1.56 0.24 0.08 1.19 0.26 2.14 0.4 3.49 0.53 5.19 0.85 6.75 1.22 0.87 0.21 2.91 0.56 4.5 0.79 1.61 0.24 3.33 0.56 3.84
0.69 0.53 0.13 3.1 0.61 5.69 1.06 5.26 0.93 5.82 1.01 10.19 1.83 1.67 0.29 4.05 0.71 5.29 0.93 1.24 0.19 3.25 0.56
4.5 0.79 1.24 0.24 3.02 0.53 3.92 0.66 0.93 0.16 2.2 0.37 2.78 0.53 0.61 0.13 2.3 0.42 3.76 0.66 4.18 0.69 6.98 1.19
8.99 1.59 1.03 0.21 3.04 0.58 4.5 0.79 1.46 0.24 3.49 0.58 4.5 0.79 1.03 0.21 3.02 0.56 4.44 0.79 1.4 0.21 3.73 0.58
5.16 0.79 1.4 0.24 3.17 0.53 3.89 0.66 0.74 0.16 2.46 0.45 3.84 0.66 1.38 0.24 3.47 0.58 4.63 0.79 1.16 0.21 3.25 0.56
4.63 0.79 1.38 0.21 3.52 0.56 4.76 0.79 4.71 0.85 7.06 1.22 8.73 1.38 1.93 0.16 4.5 1.22 6.06 2.43 0.58 0.48 1.35
1.51 1.9 2.57 0.85 1.69 0.9 1.96 0.9 4.39 -0.03 2.57 -0.03 2.59 -1.06 4.1 -0.58 0.82 -1.56 1.88 -2.17 2.35 -2.09 1.59
-6.14 2.35 -8.81 1.67z M617.2 527.51 c-1.08 -0.29 -3.52 -0.69 -5.42 -0.93 -3.39 -0.4 -4.34 -0.56 -11.11 -1.83
-1.88 -0.37 -3.97 -0.71 -4.63 -0.82 -1.19 -0.16 -3.65 -0.69 -6.35 -1.32 -0.79 -0.21 -2.41 -0.56 -3.57 -0.79
-4.66 -0.9 -8.52 -1.75 -10.45 -2.25 -1.08 -0.29 -10.5 -2.3 -12.96 -2.78 -7.8 -1.48 -11.48 -2.25
-13.62 -2.83 -1.53 -0.4 -3.17 -0.77 -16.01 -3.39 -6.32 -1.3 -13.36 -2.78 -15.61 -3.28 -2.25 -0.5
-5.29 -1.16 -6.75 -1.48 -1.46 -0.29 -3.78 -0.79 -5.16 -1.08 -5.53 -1.19 -7.35 -1.59 -9.39 -1.96 -3.47
-0.69 -6.01 -1.22 -7.54 -1.61 -0.79 -0.19 -3.84 -0.82 -6.75 -1.4 -13.41 -2.7 -21.19 -4.34 -30.29
-6.38 -2.54 -0.58 -5.69 -1.24 -7.01 -1.46 -1.3 -0.24 -3.39 -0.66 -4.63 -0.93 -1.24 -0.26 -3.2 -0.69
-4.37 -0.93 -1.16 -0.24 -2.78 -0.61 -3.57 -0.79 -0.79 -0.19 -2.41 -0.56 -3.57 -0.79 -4.02 -0.87 -5.56 -1.22
-7.14 -1.59 -0.87 -0.21 -2.54 -0.56 -3.7 -0.79 -2.65 -0.53 -10.34 -2.22 -15.61 -3.44 -2.17 -0.48 -4.68
-1.03 -5.56 -1.22 -0.87 -0.16 -2.96 -0.66 -4.63 -1.08 -1.67 -0.42 -3.57 -0.87 -4.23 -1.01 -1.22 -0.21 -2.75
-0.56 -5.16 -1.19 -2.75 -0.74 -4.87 -1.19 -5.48 -1.19 -0.79 0 -3.62 -0.9 -4.89 -1.56 -1.46 -0.74
-3.39 -2.86 -4.07 -4.39 -0.32 -0.71 -0.63 -2.14 -0.71 -3.12 -0.24 -3.2 1.24 -5.95 4.18 -7.72 1.43
-0.87 1.77 -0.95 4.15 -1.08 1.88 -0.13 3.25 -0.03 4.97 0.29 1.32 0.24 3.33 0.61 4.5 0.79 1.16 0.19 3.28 0.66 4.71
1.03 1.43 0.37 2.88 0.69 3.25 0.69 0.37 0 1.46 0.19 2.43 0.4 0.98 0.24 2.62 0.61 3.62 0.82 1.03 0.24 2.57 0.56 3.44 0.77
2.25 0.5 4.05 0.87 5.29 1.06 0.58 0.11 1.59 0.32 2.25 0.53 0.66 0.19 2.14 0.56 3.31 0.79 1.16 0.24 2.78 0.61 3.57 0.79
1.4 0.34 2.8 0.66 7.14 1.59 3.94 0.87 5.45 1.22 6.88 1.56 0.79 0.21 2.41 0.58 3.57 0.82 1.16 0.24 2.65 0.56 3.31
0.71 0.66 0.16 1.67 0.37 2.25 0.48 0.58 0.11 1.59 0.32 2.25 0.48 0.66 0.16 2.14 0.48 3.31 0.71 1.16 0.24 2.88 0.61 3.84 0.79
0.95 0.21 2.67 0.58 3.84 0.82 1.16 0.24 2.7 0.58 3.41 0.79 0.69 0.21 1.61 0.37 2.01 0.37 0.42 0 1.08 0.13 1.51 0.29 0.4 0.16
1.35 0.4 2.06 0.5 0.74 0.13 1.85 0.37 2.51 0.53 2.75 0.71 4.23 1.03 6.75 1.46 1.46 0.24 3.25 0.61 3.97 0.79 0.74 0.21
2.33 0.56 3.57 0.82 1.24 0.24 2.91 0.58 3.7 0.79 1.51 0.34 3.57 0.79 7.28 1.56 1.16 0.24 2.83 0.58 3.7 0.79 1.51
0.34 2.91 0.63 7.67 1.59 1.16 0.24 2.72 0.58 3.44 0.79 1.27 0.34 2.59 0.63 7.41 1.59 1.16 0.24 2.88 0.61 3.84 0.79
0.95 0.21 2.67 0.56 3.84 0.79 1.16 0.24 2.88 0.61 3.84 0.79 0.95 0.21 2.38 0.5 3.17 0.66 0.79 0.19 2.46 0.56 3.68 0.82
1.24 0.26 2.54 0.5 2.91 0.5 0.37 0 1.43 0.19 2.38 0.4 4.07 0.93 7.35 1.64 11.93 2.51 1.53 0.29 3.07 0.63 3.44 0.77
0.37 0.13 1.56 0.4 2.65 0.63 3.65 0.74 6.19 1.3 7.94 1.67 0.95 0.19 2.67 0.56 3.84 0.79 1.16 0.24 3.07 0.63 4.23
0.93 1.96 0.45 9.1 1.88 13.89 2.75 1.08 0.21 2.83 0.56 3.84 0.79 2.28 0.5 5.63 1.16 7.43 1.46 1.38 0.21 4.68 0.95
6.06 1.35 0.45 0.11 2.04 0.45 3.57 0.77 1.53 0.29 3.54 0.69 4.5 0.9 6.24 1.4 7.83 1.75 10.32 2.12 1.53 0.24 3.02
0.42 3.31 0.42 0.29 0 1.38 0.4 2.38 0.87 4.5 2.17 6.69 6.9 5.16 11.06 -0.77 2.04 -2.51 3.97 -4.42 4.89
-1.96 0.98 -5.82 1.14 -8.81 0.37z M501.06 445.45 c-2.54 -0.16 -17.67 -0.29 -33.6 -0.32 -16.8 -0.05 -31.75 -0.21 -35.58 -0.37
-3.62 -0.16 -8.57 -0.32 -10.98 -0.32 -5.08 -0.03 -7.09 -0.37 -9.05 -1.59 -2.49 -1.51 -4.44 -4.76 -4.44
-7.38 0 -3.17 2.54 -6.83 5.63 -8.04 0.9 -0.34 2.25 -0.74 2.96 -0.82 1.19 -0.16 37.14 0.16 63.1 0.56 5.61
0.08 17.38 0.03 26.19 -0.16 16.01 -0.32 67.3 -0.63 99.47 -0.63 18.12 0 19.02 0.05 21.46 1.3 1.46 0.71 3.94 3.36
3.94 4.15 0.03 0.32 0.19 0.87 0.4 1.24 0.56 1.01 0.48 3.41 -0.19 5.13 -1.03 2.75 -3.7 5 -6.69 5.66 -0.71 0.16
-4.6 0.34 -8.6 0.42 -3.99 0.08 -12.46 0.26 -18.78 0.42 -10.03 0.24 -45.42 0.63 -79.76 0.93 -5.95 0.03 -12.94
-0.05 -15.48 -0.19z M581.61 398.65 c-0.42 -0.13 -3.23 -0.61 -6.22 -1.06 -2.99 -0.42 -5.61 -0.85 -5.82 -0.9
-0.21 -0.05 -3.12 -0.61 -6.48 -1.19 -3.33 -0.58 -6.9 -1.24 -7.94 -1.48 -1.01 -0.21 -2.57 -0.56 -3.44 -0.77
-0.87 -0.19 -2.54 -0.56 -3.7 -0.79 -3.57 -0.74 -5.74 -1.22 -7.28 -1.59 -0.79 -0.19 -2.46 -0.56 -3.7 -0.79
-2.67 -0.53 -6.67 -1.38 -8.86 -1.88 -0.87 -0.21 -2.35 -0.5 -3.31 -0.63 -0.93 -0.16 -2.12 -0.4 -2.65 -0.53
-0.5 -0.13 -2.12 -0.5 -3.57 -0.79 -1.46 -0.32 -2.99 -0.69 -3.44 -0.82 -0.42 -0.13 -2.28 -0.53 -4.1 -0.93
-1.83 -0.37 -4.37 -0.93 -5.69 -1.22 -1.3 -0.26 -4.1 -0.85 -6.22 -1.3 -2.12 -0.42 -4.74 -1.01 -5.82
-1.3 -2.51 -0.63 -6.11 -1.43 -8.99 -1.98 -1.24 -0.24 -3.25 -0.69 -4.5 -0.98 -1.24 -0.29 -3.68 -0.79
-5.42 -1.14 -1.75 -0.34 -4.31 -0.87 -5.69 -1.19 -1.38 -0.32 -3.1 -0.66 -3.84 -0.82 -0.71 -0.13 -2.14 -0.42
-3.17 -0.66 -1.01 -0.21 -2.62 -0.58 -3.57 -0.77 -0.95 -0.19 -2.54 -0.53 -3.57 -0.79 -1.01 -0.24 -2.62 -0.58
-3.57 -0.77 -1.93 -0.4 -3.41 -0.77 -13.89 -3.36 -8.07 -2.01 -9.21 -2.49 -11.38 -4.6 -1.06 -1.03 -1.51
-1.72 -1.93 -3.02 -0.71 -2.12 -0.74 -3.47 -0.05 -5.45 1.75 -5.08 6.88 -6.93 14.68 -5.26 1.03 0.24 3.23 0.69
4.89 1.03 2.75 0.56 8.23 1.83 12.7 2.94 0.95 0.24 2.2 0.53 2.78 0.63 0.58 0.11 1.96 0.4 3.04 0.66 1.08 0.24 3.31
0.71 4.89 1.08 4.44 0.95 5.98 1.3 10.85 2.43 2.49 0.58 5.03 1.14 5.69 1.24 0.66 0.08 2.62 0.5 4.37 0.93 3.6 0.85
5.45 1.27 11.11 2.38 2.2 0.45 4.97 1.03 6.22 1.32 8.57 1.93 14.31 3.17 16.03 3.44 0.71 0.11 2.33 0.45 3.57 0.77
1.22 0.29 4.6 1.03 7.51 1.64 2.91 0.58 6.01 1.24 6.88 1.43 0.87 0.19 3.49 0.71 5.82 1.19 2.33 0.48 4.95 1.01
5.82 1.19 4.31 0.95 7.09 1.53 9.26 1.88 1.32 0.21 3.47 0.63 4.76 0.93 1.32 0.29 3.23 0.71 4.23 0.93 1.03 0.21 2.62
0.58 3.57 0.79 2.01 0.42 6.9 1.46 9.87 2.06 1.14 0.24 2.35 0.42 2.7 0.42 1.11 0 3.52 1.06 4.87 2.12 1.67 1.32
2.75 2.91 3.31 4.81 0.56 1.93 0.53 2.96 -0.11 5.03 -0.63 2.06 -2.28 3.89 -4.5 4.95 -1.19 0.56 -1.88 0.69
-3.84 0.74 -1.3 0.03 -2.72 -0.05 -3.17 -0.21z M561.38 337.3 c-1.08 -0.26 -3.36 -0.79 -5.03 -1.19 -1.67 -0.4 -5 -1.11 -7.41 -1.59
-2.41 -0.48 -6.56 -1.43 -9.26 -2.12 -2.7 -0.69 -5.37 -1.35 -5.95 -1.48 -0.58 -0.13 -1.88 -0.48 -2.91
-0.77 -1.01 -0.29 -3.39 -0.95 -5.29 -1.46 -1.88 -0.5 -4.74 -1.27 -6.35 -1.69 -6.32 -1.72 -8.02 -2.17
-10.32 -2.7 -2.94 -0.69 -4.97 -1.24 -6.35 -1.69 -0.58 -0.21 -2.72 -0.82 -4.76 -1.35 -2.04 -0.53 -4.95
-1.32 -6.48 -1.72 -1.53 -0.42 -4.39 -1.19 -6.35 -1.72 -1.96 -0.5 -4.15 -1.11 -4.89 -1.3 -0.71 -0.19
-3.47 -1.01 -6.08 -1.8 -5.16 -1.56 -9.63 -2.83 -10.05 -2.83 -0.63 -0.03 -2.86 -1.85 -3.81 -3.15
-1.51 -2.04 -2.25 -4.52 -1.9 -6.56 0.34 -2.22 0.93 -3.47 2.22 -4.79 2.41 -2.49 5.61 -3.2 10.24 -2.33
2.88 0.58 5.85 1.3 8.86 2.22 1.46 0.42 3.39 0.93 4.31 1.08 0.9 0.19 2.17 0.5 2.78 0.71 0.61 0.24 2.43 0.74 4.02
1.16 1.61 0.4 3.86 1.03 5.03 1.43 1.16 0.37 3.07 0.9 4.23 1.19 2.88 0.69 5.95 1.53 6.9 1.88 0.42 0.16 1.43 0.45
2.22 0.66 0.79 0.19 3.31 0.85 5.56 1.46 9.68 2.62 22.54 5.95 29.23 7.54 3.86 0.9 6.08 1.48 13.23 3.47 5
1.38 8.04 2.14 9.37 2.35 4.89 0.82 8.28 4.95 7.88 9.71 -0.29 3.57 -2.51 6.16 -6.27 7.33 -2.04 0.66
-3.92 0.66 -6.61 0.03z M548.15 279.74 c-0.66 -0.13 -3.97 -1.11 -6.61 -1.98 -0.79 -0.24 -3.23 -0.95 -5.42 -1.56
-2.17 -0.61 -4.74 -1.38 -5.69 -1.72 -0.95 -0.37 -3.33 -1.16 -5.29 -1.83 -1.96 -0.63 -5.9 -2.04 -8.73
-3.07 -2.83 -1.06 -5.69 -2.06 -6.35 -2.25 -0.66 -0.19 -2.2 -0.71 -3.44 -1.19 -1.24 -0.48 -3.15 -1.19
-4.23 -1.59 -1.08 -0.4 -2.94 -1.08 -4.1 -1.53 -1.16 -0.42 -2.59 -0.93 -3.17 -1.11 -1.08 -0.32 -2.57 -0.87
-8.2 -3.07 -1.75 -0.66 -3.76 -1.4 -4.47 -1.64 -0.87 -0.29 -1.85 -0.93 -2.94 -1.96 -4.97 -4.63 -3.62
-12.22 2.54 -14.47 2.49 -0.93 6.24 -0.71 9.63 0.48 0.45 0.16 2.04 0.71 3.57 1.24 1.53 0.53 4.44 1.56 6.48 2.28 2.04
0.71 5.03 1.77 6.61 2.33 1.61 0.56 4.23 1.48 5.82 2.06 1.61 0.56 3.99 1.43 5.29 1.88 1.32 0.48 2.67 0.98 3.04
1.08 0.37 0.13 1.67 0.61 2.91 1.06 1.24 0.45 2.78 0.98 3.44 1.16 0.66 0.21 2.57 0.87 4.23 1.48 1.67 0.61 5 1.8 7.41
2.65 2.41 0.85 4.97 1.8 5.69 2.12 0.74 0.32 2.46 0.87 3.84 1.22 4.71 1.22 7.3 3.02 7.96 5.53 0.16 0.58 0.48
1.51 0.66 2.06 1.22 3.31 -0.87 7.54 -4.71 9.47 -1.51 0.77 -4.18 1.16 -5.77 0.87z"/>
  </g>
</svg>
`;
const TDOC_LOGO_PNG_B64 = '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';
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

// Infer the host coding-agent from env (Claude Code, Codex, Grok, Cursor, Gemini).
// The published Worker only sees request JSON, so local server + tdoc-agent-reply
// run this against process.env and stamp login before the request leaves the machine.
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
function rand(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Gated diagnostic logging. The device-flow poll path was instrumented during
// an incident and left noisy console.log calls in production (visible in
// `wrangler tail`). Gate them behind TDOC_DEBUG so they're off by default but
// recoverable. Genuine error branches stay as console.error, unconditionally.
function debug(env, ...args) {
  if (env && env.TDOC_DEBUG) console.log(...args);
}

// Escape `</script>` and HTML comment terminators so a malicious or stray value
// inside the JSON payload can't break out of the surrounding <script> block.
function safeJsonForScript(obj) {
  return JSON.stringify(obj).replace(/<\/script>/gi, '<\\/script>').replace(/<!--/g, '<\\!--');
}

// Full HTML escaping for interpolating untrusted strings into markup (text OR
// attribute context). The catalog/index pages previously escaped only `<`,
// leaving `"`/`'`/`&` unprotected in attribute contexts (#33 hardening).
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Make an untrusted string safe to interpolate inside an HTML comment (or an
// HTML-comment-delimited marker). Comment text and author logins are
// attacker-controllable (any signed-in user can post a comment), so without
// this a `-->` in a comment would break out of the comment context and inject
// live markup into the fork/export document served on the worker origin.
//
// HTML comments do NOT decode entities, so we can't entity-escape — we must
// neutralize the byte sequences that open/close a comment. We break the `--`
// run (the only thing that can form `-->` or start `<!--`) with a backslash,
// which is unambiguous to a human/agent reader and cannot terminate the
// comment. Applied once, at every interpolation point — escaping as one layer,
// not a per-spot patch.
function forHtmlComment(s) {
  return String(s == null ? '' : s).replace(/--/g, '-\\-');
}

// ─────────────────────────────────────────────────────────────────────────
// Artifact identity (`data-tdoc-aid`)
//
// THE PROBLEM: positional CSS selectors silently drift when /tdoc edit
// restructures HTML. A comment anchored to `div > svg:nth-of-type(1)` will
// resolve to a different artifact in the next version with no indication.
//
// THE FIX: at upload time, the worker stamps every commentable artifact in
// the published HTML with `data-tdoc-aid="<content-hash>"`. The hash is
// derived from the artifact's TAG + NORMALIZED INNER CONTENT (whitespace
// collapsed, existing data-tdoc-* attrs stripped so the hash doesn't
// include itself). The SAME ARTIFACT IN A DIFFERENT VERSION HAS THE SAME
// AID. Comments anchor by aid; resolution is identity-first; drift is
// impossible because the aid is the artifact, not a path through the DOM.
//
// The set of commentable artifacts matches the overlay's COMMENTABLE.
// Includes leaf media + semantic blocks the author signaled are a unit.
// Plus: any element with `data-tdoc-artifact` or a class containing
// `tdoc-artifact` is stamped regardless of tag (the explicit opt-in path).
// NOTE: `article` is intentionally omitted — it's the doc CONTENT ROOT
// in some authoring patterns (per ARTICLE_ROOT_SEL in overlay.js); making
// it commentable would make the whole doc one big artifact. Use `section`
// or `data-tdoc-artifact` to mark sub-blocks instead.
const STAMPABLE_TAGS = [
  'img','svg','canvas','video','pre','figure','iframe',
  'section','aside','blockquote','table','details',
];
// 53-bit string hash (public-domain cyrb53), identical to the one in the
// overlay so identities computed on either side agree.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
// Compute an aid from a raw HTML substring representing one artifact element.
// Strips data-tdoc-* attrs from the open tag (so an aid doesn't include
// itself), strips comments, collapses whitespace inside.
function aidFor(tag, innerHtml, openAttrs) {
  // Keep author-meaningful intrinsics (viewBox / src / alt / aria-label /
  // title) as part of identity — they're what makes a `<svg>` *this* svg.
  const intrinsics = ['viewBox','src','alt','aria-label','title']
    .map(a => {
      const m = new RegExp('\\b' + a + '\\s*=\\s*"([^"]*)"', 'i').exec(openAttrs || '');
      return m ? a + '=' + m[1] : '';
    })
    .filter(Boolean).join('|');
  const norm = (innerHtml || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\sdata-tdoc-[\w-]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cyrb53(tag + '|' + intrinsics + '|' + norm);
}
// Elements whose body is raw text (CDATA-like): their content is NOT markup,
// so a `</section>` or `>` inside them must never be treated as a tag. The
// close scanner skips over these element bodies entirely.
const RAW_TEXT_TAGS = ['script', 'style', 'textarea', 'title'];

// Given the index of a `<` that begins an open tag, return the index just past
// its closing `>`, treating `>` inside single/double-quoted attribute values
// as ordinary text. Returns -1 if no terminator is found. This fixes the
// finding where `<img alt="a > b">` (a `>` inside an attribute) made the naive
// `[^>]*>` regex stop early and mis-compute element offsets.
function attrAwareOpenTagEnd(html, lt) {
  let i = lt + 1, quote = null;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i + 1;
  }
  return -1;
}

// From `pos`, return the index just past the closing `>` of the next raw-text
// element body that starts at/after `pos`, if `pos` is right at a raw-text open
// tag; else null. Used to leap over <script>/<style> bodies so their unescaped
// `</section>`-like content can't desync the depth counter.
function skipRawTextBodyAt(html, openTag, attrs, openEnd) {
  if (!RAW_TEXT_TAGS.includes(openTag)) return null;
  if (/\/\s*$/.test(attrs)) return openEnd; // self-closed (rare/invalid) — nothing to skip
  const closeRe = new RegExp(`</${openTag}\\s*>`, 'i');
  closeRe.lastIndex = openEnd;
  const m = closeRe.exec(html.slice(openEnd));
  return m ? openEnd + m.index + m[0].length : html.length;
}

// --- #24 dry-run instrumentation -------------------------------------------
// The hardened stampAids() above fixes real regex bugs (`>` in an attribute,
// `</tag>` inside <script>/<style>). For ORDINARY HTML it produces aids
// identical to the legacy parser; it differs ONLY on the edge-case HTML the
// legacy parser mis-parsed (those inputs are valid HTML but rare). Because `aid`
// is the anchor key for stored comments, we MEASURE the blast radius before
// assuming it's safe: compute the aid SETS with both parsers and report how many
// live comments anchor to an aid the legacy parser produced but the hardened one
// no longer does (set membership — never an index-paired old→new map, which
// could mis-pair when the parsers diverge). This logs only — it never mutates
// (it folds deep copies). (Design: docs/DESIGN-aid-migration.md. Empirically 0
// across current docs.)
function stampAidsLegacy(rawHtml) {
  const headRe = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const headings = [];
  let hmatch;
  while ((hmatch = headRe.exec(rawHtml))) {
    headings.push({ end: hmatch.index + hmatch[0].length,
      text: hmatch[2].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim() });
  }
  function nearestHeadingAt(idx) {
    let best = null;
    // Use <= so a heading whose close tag ends exactly at the next
    // element's open (no whitespace between) is still "before" it.
    for (const h of headings) { if (h.end <= idx) best = h.text; else break; }
    return best;
  }
  // Find every open tag of every stampable kind in document order.
  // For non-void tags, find its matching close (same-tag depth count).
  // Collect [openStart, openEnd, closeEnd, tag, attrs, innerHtml] per element.
  const elements = [];
  const seenOpens = new Set();   // dedupe across passes (tag pass + opt-in pass)
  function harvest(openStart, openEnd, tagLower, attrs) {
    if (seenOpens.has(openStart)) return;
    const isVoid = /^(img|iframe)$/i.test(tagLower) || /\/\s*$/.test(attrs);
    let closeEnd = openEnd, innerHtml = '';
    if (!isVoid) {
      const closeRe = new RegExp(`</${tagLower}\\s*>|<${tagLower}\\b[^>]*>`, 'gi');
      closeRe.lastIndex = openEnd;
      let depth = 1, c;
      while ((c = closeRe.exec(rawHtml))) {
        if (c[0][1] === '/') { depth--; if (depth === 0) { closeEnd = c.index + c[0].length; break; } }
        else depth++;
      }
      innerHtml = rawHtml.slice(openEnd, closeEnd - (`</${tagLower}>`.length));
    }
    seenOpens.add(openStart);
    elements.push({ openStart, openEnd, closeEnd, tag: tagLower, attrs, innerHtml, isVoid });
  }
  // Pass 1: every known stampable tag.
  for (const tag of STAMPABLE_TAGS) {
    const openRe = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
    let m;
    while ((m = openRe.exec(rawHtml))) harvest(m.index, m.index + m[0].length, tag, m[1] || '');
  }
  // Pass 2: opt-in markers (any tag with data-tdoc-artifact or class
  // containing `tdoc-artifact`). Authors mark composed cards/widgets this
  // way so they're commentable as a unit.
  const optInRe = /<([a-z][\w-]*)\b([^>]*\b(?:data-tdoc-artifact\b|class\s*=\s*"[^"]*\btdoc-artifact\b[^"]*")[^>]*)>/gi;
  let om;
  while ((om = optInRe.exec(rawHtml))) {
    const tagLower = om[1].toLowerCase();
    harvest(om.index, om.index + om[0].length, tagLower, om[2] || '');
  }
  // Compute aid per element (uses cleaned attrs + inner content with any
  // existing data-tdoc-aid stripped, so re-stamping is idempotent).
  const aids = [];
  for (const e of elements) {
    const cleanedAttrs = e.attrs.replace(/\s+data-tdoc-aid\s*=\s*"[^"]*"/gi, '');
    // For nested commentables we hash the OUTER's content even though it
    // contains an inner commentable — that's correct, "outer artifact" is
    // a different identity than "inner artifact". We just strip any
    // data-tdoc-aid attributes from the inner before hashing so the
    // hash is stable across re-stampings.
    const cleanedInner = e.innerHtml.replace(/\sdata-tdoc-aid\s*=\s*"[^"]*"/gi, '');
    e._cleanedAttrs = cleanedAttrs;
    e._aid = aidFor(e.tag, cleanedInner, cleanedAttrs);
    aids.push({
      aid: e._aid, tag: e.tag,
      head: e.innerHtml.slice(0, 80),
      heading: nearestHeadingAt(e.openStart),
    });
  }
  // Apply stamps in REVERSE order so earlier offsets stay valid as we mutate.
  elements.sort((a, b) => b.openStart - a.openStart);
  let out = rawHtml;
  for (const e of elements) {
    const stampedOpen = e.isVoid
      ? `<${e.tag}${e._cleanedAttrs} data-tdoc-aid="${e._aid}"${/\/\s*$/.test(e.attrs) ? '/' : ''}>`
      : `<${e.tag}${e._cleanedAttrs} data-tdoc-aid="${e._aid}">`;
    out = out.slice(0, e.openStart) + stampedOpen + out.slice(e.openEnd);
  }
  return { html: out, aids };
}

// Returns { changed, affectedComments, samples } describing aid drift between
// the legacy and current parser for this HTML, scoped to comments whose LIVE
// anchor target disappears under the hardened parser. Pure measurement; no
// mutation.
//
// Pairing-free by design: we do NOT try to build an old→new aid map by index
// (the two parsers can emit different element counts/order on exactly the edge-
// case HTML this measures, which would fabricate wrong mappings). Instead we use
// SET MEMBERSHIP, which can't mis-pair:
//   - legacySet = aids the legacy parser produced for this HTML (what stored
//     comments were anchored against).
//   - currentSet = aids the hardened parser produces now.
//   - A comment is "at risk" iff its live element aid is in legacySet but NOT in
//     currentSet — i.e. the fix made its anchor target's aid vanish, so reconcile
//     will have to rebind it. (If the aid is still present, the fix didn't move
//     that comment's target — safe.)
function measureAidDrift(rawHtml, comments) {
  let legacy, current;
  try { legacy = stampAidsLegacy(rawHtml).aids; } catch { return { changed: 0, affectedComments: 0, samples: [] }; }
  try { current = stampAids(rawHtml).aids; } catch { return { changed: 0, affectedComments: 0, samples: [] }; }
  const legacySet = new Set(legacy.map(a => a.aid));
  const currentSet = new Set(current.map(a => a.aid));
  // count of legacy aids that no longer exist under the hardened parser
  let changed = 0;
  for (const aid of legacySet) if (!currentSet.has(aid)) changed++;

  let affected = 0; const samples = [];
  for (const c of (Array.isArray(comments) ? comments : [])) {
    // Use the LIVE folded anchor (after replaying anchor_changed events), not the
    // raw created-event anchor — a comment already re-anchored must not be
    // counted against its stale original aid.
    //
    // CRITICAL: snapshotAt → ensureEventLog backfills eids IN PLACE, so we fold a
    // DEEP COPY. This keeps measureAidDrift strictly read-only — it must never
    // mutate the caller's list (the upload handler diffs before/after and would
    // otherwise persist an incidental eid-backfill from this log-only check).
    let anchor = null;
    try {
      if (Array.isArray(c && c.events)) {
        const copy = JSON.parse(JSON.stringify(c));
        anchor = snapshotAt(copy, Infinity)?.anchor || null;
      } else {
        anchor = c && c.anchor;
      }
    } catch { anchor = c && c.anchor; }
    const aid = anchor && anchor.kind === 'element' ? (anchor.aid || null) : null;
    // At risk iff its target existed under legacy but is gone under the fix.
    if (aid && legacySet.has(aid) && !currentSet.has(aid)) {
      affected++;
      if (samples.length < 5) samples.push({ id: c.id, lostAid: aid });
    }
  }
  return { changed, affectedComments: affected, samples };
}
// ---------------------------------------------------------------------------


// Walk the HTML and stamp `data-tdoc-aid` on every commentable element.
// Returns { html: <stamped>, aids: [{aid, tag, head, heading}] }.
//
// Two-pass design — the previous one-pass version was wrong: when an outer
// commentable (e.g. <figure>) contains an inner one (e.g. <svg>), naive
// regex walking skipped past the inner element's close tag. We now run
// SEPARATE passes per tag, so an svg inside a figure gets stamped just
// like a free-standing svg. Both are valid anchor targets.
function stampAids(rawHtml) {
  const headRe = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const headings = [];
  let hmatch;
  while ((hmatch = headRe.exec(rawHtml))) {
    headings.push({ end: hmatch.index + hmatch[0].length,
      text: hmatch[2].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim() });
  }
  function nearestHeadingAt(idx) {
    let best = null;
    // Use <= so a heading whose close tag ends exactly at the next
    // element's open (no whitespace between) is still "before" it.
    for (const h of headings) { if (h.end <= idx) best = h.text; else break; }
    return best;
  }
  // Find every open tag of every stampable kind in document order.
  // For non-void tags, find its matching close (same-tag depth count).
  // Collect [openStart, openEnd, closeEnd, tag, attrs, innerHtml] per element.
  const elements = [];
  const seenOpens = new Set();   // dedupe across passes (tag pass + opt-in pass)
  function harvest(openStart, openEnd, tagLower, attrs) {
    if (seenOpens.has(openStart)) return;
    const isVoid = /^(img|iframe)$/i.test(tagLower) || /\/\s*$/.test(attrs);
    let closeEnd = openEnd, innerHtml = '';
    if (!isVoid) {
      // Depth-count matching open/close tags of THIS tag name, but:
      //  - skip over raw-text element bodies (<script>/<style>/...) so their
      //    unescaped content can't contain a fake close tag, and
      //  - resolve each open tag's end attribute-aware (a `>` inside an
      //    attribute value isn't the tag end).
      const openSameRe = new RegExp(`<${tagLower}\\b`, 'gi');
      const closeSameRe = new RegExp(`</${tagLower}\\s*>`, 'gi');
      const rawOpenRe = new RegExp(`<(${RAW_TEXT_TAGS.join('|')})\\b`, 'gi');
      let depth = 1, scan = openEnd, foundCloseEnd = -1;
      while (scan < rawHtml.length) {
        closeSameRe.lastIndex = scan;
        openSameRe.lastIndex = scan;
        rawOpenRe.lastIndex = scan;
        const mc = closeSameRe.exec(rawHtml);
        const mo = openSameRe.exec(rawHtml);
        const mr = rawOpenRe.exec(rawHtml);
        // pick the earliest of: a close, a nested same-tag open, a raw-text open
        const next = [mc, mo, mr].filter(Boolean).sort((a, b) => a.index - b.index)[0];
        if (!next) break;
        if (next === mr) {
          // leap over the raw-text body so its content can't desync depth
          const rTag = mr[1].toLowerCase();
          const rEnd = attrAwareOpenTagEnd(rawHtml, mr.index);
          if (rEnd < 0) break;
          const skipTo = skipRawTextBodyAt(rawHtml, rTag, rawHtml.slice(mr.index, rEnd), rEnd);
          scan = skipTo != null ? skipTo : rEnd;
          continue;
        }
        if (next === mc) {
          depth--; if (depth === 0) { foundCloseEnd = mc.index + mc[0].length; break; }
          scan = mc.index + mc[0].length;
        } else { // nested same-tag open
          depth++;
          const oEnd = attrAwareOpenTagEnd(rawHtml, mo.index);
          scan = oEnd < 0 ? mo.index + mo[0].length : oEnd;
        }
      }
      if (foundCloseEnd >= 0) closeEnd = foundCloseEnd;
      innerHtml = rawHtml.slice(openEnd, closeEnd - (`</${tagLower}>`.length));
    }
    seenOpens.add(openStart);
    elements.push({ openStart, openEnd, closeEnd, tag: tagLower, attrs, innerHtml, isVoid });
  }
  // Pass 1: every known stampable tag. Find the `<tag\b` start, then resolve
  // the open tag's true end attribute-aware so a `>` inside an attribute value
  // doesn't truncate the attrs (which would corrupt the stamp + the aid).
  for (const tag of STAMPABLE_TAGS) {
    const openRe = new RegExp(`<${tag}\\b`, 'gi');
    let m;
    while ((m = openRe.exec(rawHtml))) {
      const end = attrAwareOpenTagEnd(rawHtml, m.index);
      if (end < 0) continue;
      const attrs = rawHtml.slice(m.index + 1 + tag.length, end - 1);
      harvest(m.index, end, tag, attrs);
    }
  }
  // Pass 2: opt-in markers (any tag with data-tdoc-artifact or class
  // containing `tdoc-artifact`). Authors mark composed cards/widgets this
  // way so they're commentable as a unit. Match the tag name + a quick
  // attribute presence check, then resolve the real end attribute-aware.
  const optInProbe = /<([a-z][\w-]*)\b/gi;
  let om;
  while ((om = optInProbe.exec(rawHtml))) {
    const tagLower = om[1].toLowerCase();
    const end = attrAwareOpenTagEnd(rawHtml, om.index);
    if (end < 0) continue;
    const attrs = rawHtml.slice(om.index + 1 + om[1].length, end - 1);
    if (/\bdata-tdoc-artifact\b/i.test(attrs) || /class\s*=\s*"[^"]*\btdoc-artifact\b[^"]*"/i.test(attrs)) {
      harvest(om.index, end, tagLower, attrs);
    }
  }
  // Compute aid per element (uses cleaned attrs + inner content with any
  // existing data-tdoc-aid stripped, so re-stamping is idempotent).
  const aids = [];
  for (const e of elements) {
    const cleanedAttrs = e.attrs.replace(/\s+data-tdoc-aid\s*=\s*"[^"]*"/gi, '');
    // For nested commentables we hash the OUTER's content even though it
    // contains an inner commentable — that's correct, "outer artifact" is
    // a different identity than "inner artifact". We just strip any
    // data-tdoc-aid attributes from the inner before hashing so the
    // hash is stable across re-stampings.
    const cleanedInner = e.innerHtml.replace(/\sdata-tdoc-aid\s*=\s*"[^"]*"/gi, '');
    e._cleanedAttrs = cleanedAttrs;
    e._aid = aidFor(e.tag, cleanedInner, cleanedAttrs);
    aids.push({
      aid: e._aid, tag: e.tag,
      head: e.innerHtml.slice(0, 80),
      heading: nearestHeadingAt(e.openStart),
    });
  }
  // Apply stamps in REVERSE order so earlier offsets stay valid as we mutate.
  elements.sort((a, b) => b.openStart - a.openStart);
  let out = rawHtml;
  for (const e of elements) {
    const stampedOpen = e.isVoid
      ? `<${e.tag}${e._cleanedAttrs} data-tdoc-aid="${e._aid}"${/\/\s*$/.test(e.attrs) ? '/' : ''}>`
      : `<${e.tag}${e._cleanedAttrs} data-tdoc-aid="${e._aid}">`;
    out = out.slice(0, e.openStart) + stampedOpen + out.slice(e.openEnd);
  }
  return { html: out, aids };
}

// Reconcile open comment anchors against the freshly-stamped artifact set.
// Mutates `comments` in-place (returns it). Behavior:
//   • If the comment's anchor already targets a known aid (either stored
//     in `anchor.aid` or the selector is `[data-tdoc-aid="..."]`), it's
//     authoritative — leave it.
//   • If the comment has a `fingerprint` that matches one aid by content,
//     stamp `anchor.aid = <that aid>` so future resolution is identity-first.
//   • Otherwise (legacy positional selector + no fingerprint), try a
//     best-effort backfill: tag must match and the nearestHeading hint (if
//     present) must match too. Single high-confidence candidate → adopt;
//     ambiguous or missing → mark `anchor.kind = "lost"` so the comment
//     renders unanchored INSTEAD OF SILENTLY POINTING AT THE WRONG ARTIFACT.
// Reconcile anchors at upload time of version V. For each comment that is
// ALIVE at V, look at its snapshot's anchor; if the aid no longer resolves
// in this version's stamped artifacts, attempt to find the right aid by
// fingerprint + heading and APPEND an `anchor_changed` event stamped at V.
// We never mutate older events — older versions keep their own anchors.
//
// Result: per-version anchor mapping is naturally encoded in the event log.
// A comment created on v5 with aid X, then rebound on v7 to aid Y, will
// resolve to X on v5/v6 (via its `created` event) and to Y on v7+ (via the
// new `anchor_changed` event). This replaces aid_history.
function reconcileAnchors(comments, aidsInVersion, V) {
  if (!Array.isArray(comments)) return comments;
  ensureMigrated(comments);
  const byAid = new Map(aidsInVersion.map(a => [a.aid, a]));
  const version = Number(V) || 1;
  const now = new Date().toISOString();

  for (const c of comments) {
    const snap = snapshotAt(c, version);
    if (!snap || snap.deleted) continue;
    const a = snap.anchor;
    // Element anchors can drift; `lost` anchors can RECOVER if the artifact
    // returns in a later version. Both must run through the fingerprint match
    // below. Previously `lost` anchors hit `a.kind !== 'element'` → continue,
    // so once lost they were orphaned forever even when the target came back.
    // (text anchors are resolved client-side, not here.)
    if (!a || (a.kind !== 'element' && a.kind !== 'lost')) continue;

    const knownAid = a.aid
      || (a.selector && /\[data-tdoc-aid="([\w]+)"\]/.exec(a.selector || '')?.[1]);
    // Already valid in this version → nothing to do. (lost anchors have no aid,
    // so they always fall through to the re-bind attempt.)
    if (knownAid && byAid.has(knownAid)) continue;

    // Try fingerprint + heading match against this version's artifacts.
    const fp = a.fingerprint;
    const wantTag = (fp && fp.tag) || (a.label || '').toLowerCase();
    const wantHead = a.fallback && a.fallback.nearestHeading && a.fallback.nearestHeading.text;
    const candidates = aidsInVersion.filter(x =>
      (!wantTag || x.tag === wantTag) &&
      (!wantHead || (x.heading || '').toLowerCase() === wantHead.toLowerCase())
    );
    let newAid = null;
    if (candidates.length === 1) newAid = candidates[0].aid;
    else if (candidates.length === 0) {
      const tagOnly = aidsInVersion.filter(x => !wantTag || x.tag === wantTag);
      if (tagOnly.length === 1) newAid = tagOnly[0].aid;
    }

    if (newAid) {
      // Append the rebind as an event at THIS version. Older folds are
      // unchanged.
      appendEvent(c, {
        kind: 'anchor_changed', at_version: version, at: now, by: 'reconcile',
        reset_status: false,
        anchor: {
          kind: 'element',
          aid: newAid,
          selector: `[data-tdoc-aid="${newAid}"]`,
          label: a.label || (fp && fp.tag) || 'element',
          ...(fp ? { fingerprint: fp } : {}),
          ...(a.fallback ? { fallback: a.fallback } : {}),
        },
      });
    } else if (a.kind !== 'lost') {
      // No confident match AND it wasn't already lost → mark it lost in this
      // version. Older versions keep their valid anchors (they fold to earlier
      // anchor_changed/created events that still resolve). If it was ALREADY
      // lost and still has no candidate, do nothing — re-appending an identical
      // lost event every publish would bloat the log for no benefit.
      appendEvent(c, {
        kind: 'anchor_changed', at_version: version, at: now, by: 'reconcile',
        reset_status: false,
        anchor: {
          kind: 'lost',
          reason: candidates.length > 1 ? 'ambiguous' : 'no_candidate',
          ...(a.label ? { label: a.label } : {}),
          ...(fp ? { fingerprint: fp } : {}),
          ...(a.fallback ? { fallback: a.fallback } : {}),
        },
      });
    }
  }
  return comments;
}

// ─────────────────────────────────────────────────────────────────────────
// CSP (owner-manage-via-session hardening)
//
// A published doc is arbitrary author HTML served on our own origin. Once
// owner mutations (delete / access) can be authorized by the owner's SESSION
// COOKIE alone (see authorizeOwnerMutation below), a malicious <script> or
// onclick= embedded in a doc's HTML could ride that cookie to silently
// delete/modify docs (confused-deputy) — the browser sends the cookie on any
// same-origin fetch/XHR the page's own script issues, no user gesture needed.
//
// FIX: every doc-serving response carries a CSP that runs ONLY our own
// nonced overlay script and blocks everything else — author <script> tags,
// inline event-handler attributes (onclick=...), and javascript: URLs all
// lack the nonce and there is no 'unsafe-inline' to fall back to. Verified
// fact (2026-08): 0 of 36 published doc versions use <script>, so this
// breaks no known content.
//
// 'strict-dynamic' lets the nonced overlay script load further scripts of
// its own choosing (it doesn't today, but this keeps the policy from being
// a maintenance trap if it ever needs to). object-src/base-uri are locked
// down too (classic plugin/base-tag CSP-bypass vectors) — nothing else is
// restricted, so author CSS/images/fonts/etc. are untouched.
// frame-src 'self': the shell document embeds author content only via the
// same-origin /frame route (itself sandboxed to an opaque origin), and can
// never be made to frame anything else.
function cspHeader(nonce) {
  return `script-src 'nonce-${nonce}' 'strict-dynamic'; frame-src 'self'; object-src 'none'; base-uri 'none';`;
}

// The author document is served from /d/<slug>/v/<n>/frame under a CSP
// `sandbox` (opaque origin) so its CSS/DOM can never touch the shell chrome.
// Same isolation the widget islands use, applied to the whole author doc; only
// our own nonced probe runs inside (author JS stays inert).
function frameCspHeader(nonce) {
  return `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts`;
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

// Download (/export) stamps the reader template as a static <style> so the
// saved file matches the published reading column. READER_CSS is the
// standalone server/reader.css inlined by the bundler (empty when unbundled).
function readerCssSource() {
  return (typeof READER_CSS === 'string' && READER_CSS.indexOf('__TDOC_') !== 0) ? READER_CSS : '';
}
function injectReaderCss(html, css) {
  if (!css) return html;
  const tag = `<style id="tdoc-reader">${css}</style>\n`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}</head>`);
  return tag + html;
}

// Render one published doc version as the cross-origin SHELL: chrome (bar,
// footer, composer, pins, cards) in this outer document; the author content
// isolated in the same-origin, sandboxed /frame iframe. Mirrors the local
// server's shellDocument, built from the SAME shared modules (SHELL/CHROME) so
// local and production render 1:1. The published-mode bar + client cfg carry
// the same fields the old overlay boot used, so identity/owner/manage/share behave as
// before once the shell client wires them.
function shellDocumentWorker(rawHtml, slug, version, identity, versions, isOwner, ownerManage, nonce, isLanding, canSeeMyDocsFlag, isCatalog, webAuth, stars, viewerStar) {
  // Unbundled worker (raw worker.js in tests): no shell builder inlined — serve
  // the author document bare rather than injecting anything.
  if (!SHELL) return rawHtml;
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const vlist = Array.isArray(versions) && versions.length ? versions : [{ n: version }];
  let title = slug;
  const cfg = {
    slug, version,
    identity: identity || null,
    isOwner: !!isOwner,
    canSeeMyDocs: !!canSeeMyDocsFlag,
    isLanding: !!isLanding,
    isCatalog: !!isCatalog,
    ownerManage: isOwner ? (ownerManage || null) : null,
    authConfigured: true,
    webAuth: !!webAuth,
    mode: 'published',
    versions: vlist,
    runtime: runtimeInfo(),
  };
  // Onboarding modal ships wherever its trigger is (landing/start slug, or any
  // doc carrying the /start CTA) — same rule the old overlay boot used.
  const hasCta = /<a[^>]+href="\/start"/.test(rawHtml || '');
  const onboardJs = ((slug === LANDING_SLUG || slug === START_SLUG || hasCta) && nonce) ? ONBOARD_JS : '';
  const barInner = CHROME.buildBar ? CHROME.buildBar({ mode: 'published', slug, version, versions: vlist, isLanding: !!isLanding, isCatalog: !!isCatalog, stars: stars, viewerStar: viewerStar || null }) : '';
  // Old-version strip — published + multi-version + viewing an old one (1:1
  // with the overlay: fork/landing and the latest version itself get nothing).
  let oldverHtml = '';
  const latestVersion = vlist.length ? Math.max(...vlist.map(v => Number(v.n) || 0)) : version;
  if (!isLanding && vlist.length > 1 && typeof version === 'number' && version < latestVersion) {
    const latestUrl = `/d/${encodeURIComponent(slug)}/v/${latestVersion}`;
    oldverHtml = `<div class="tdoc-oldver-strip"><span>You're viewing v${version} — the latest is <a href="${latestUrl}">v${latestVersion}</a></span></div>`;
  }
  const footerInner = CHROME.buildFooter ? CHROME.buildFooter() : '';
  return SHELL.shellHtml({
    title,
    frameSrc: `/d/${encodeURIComponent(slug)}/v/${version}/frame`,
    nonceAttr,
    chromeCssStr: (typeof CHROME_CSS === 'string' && CHROME_CSS.indexOf('__TDOC_') !== 0) ? CHROME_CSS : '',
    barInner, footerInner, oldverHtml,
    chromeJs: CHROME_JS,
    authCfgJson: safeJsonForScript(cfg),
    cfgJson: safeJsonForScript(cfg),
    signinJs: SIGNIN_JS,
    manageJs: (typeof MANAGE_JS === 'string' && MANAGE_JS.indexOf('__TDOC_') !== 0) ? MANAGE_JS : '',
    onboardJs,
  });
}

// Site chrome for PLAIN pages (/me): the page's own content stays inline (it is
// tdoc-generated, not author content — no sandbox needed), and we add the
// shared bar component + theme/identity wiring. The shell client script runs
// dormant here: with no .tdoc-doc-frame in the DOM, all comment machinery is
// message-driven and never activates; only the bar wiring (theme, menus,
// identity, sign-in) is live. One chrome, two page kinds.
function injectSiteChrome(rawHtml, cfg, nonce) {
  if (!SHELL || !CHROME.buildBar) return rawHtml;   // unbundled worker — serve bare
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const barInner = CHROME.buildBar({ mode: 'published', slug: cfg.slug || '', version: cfg.version || 0, versions: [], isLanding: !!cfg.isLanding, isCatalog: !!cfg.isCatalog, stars: cfg.stars });
  const chromeCssTag = `<style>${(typeof CHROME_CSS === 'string' && CHROME_CSS.indexOf('__TDOC_') !== 0) ? CHROME_CSS : ''}</style>`;
  const bootCfg = { ...cfg, runtime: cfg.runtime || runtimeInfo() };
  const scripts =
    `<script${nonceAttr}>${CHROME_JS}</script>\n` +
    `<script${nonceAttr}>window.__TDOC__ = ${safeJsonForScript(bootCfg)};</script>\n` +
    `<script${nonceAttr}>window.__TDOC_SHELL__ = ${safeJsonForScript(bootCfg)};</script>\n` +
    `<script${nonceAttr}>${SIGNIN_JS}</script>\n` +
    `<script${nonceAttr}>${SHELL.shellScript()}</script>`;
  let out = rawHtml;
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => `${m}\n${chromeCssTag}`) : chromeCssTag + out;
  out = /<body[^>]*>/i.test(out) ? out.replace(/<body[^>]*>/i, (m) => `${m}\n<div class="tdoc-bar">${barInner}</div>`) : `<div class="tdoc-bar">${barInner}</div>` + out;
  out = out.includes('</body>') ? out.replace('</body>', `${scripts}\n</body>`) : out + scripts;
  return out;
}

// The doc whose latest version IS the site homepage (#127). tdoc.dev/ renders
// this published tdoc rather than a hardcoded marketing page, so the landing
// page is authored, reviewed, and versioned through tdoc itself.
const LANDING_SLUG = 'tornado-doc';

// The doc behind `/start`: the same onboarding, written as a page, for anyone
// who has scripting off or who wants to read the steps before running them.
const START_SLUG = 'tdoc-start';
// `/templates` — the template gallery: pick a look, copy a prompt, hand it to
// your agent. Same landing-doc mechanism as `/start`.
const TEMPLATES_SLUG = 'tdoc-templates';

// The onboarding modal, bundled in by bin/tdoc-bundle. Kept as a placeholder
// here so the source file stays readable and the bundle stays one artifact.
const ONBOARD_JS = `__TDOC_ONBOARD_JS__`;

// The one GitHub device-flow client, shared by the overlay and the neutral
// landing page so a fix or a new provider lands once. See server/signin.js.
const SIGNIN_JS = `__TDOC_SIGNIN_JS__`;

// Render one published doc version as a full overlay page. Extracted so `/`
// (the homepage) and `/d/<slug>/v/<n>` render through the SAME path — access
// gate, version picker, owner-manage payload, nonce + CSP — instead of the
// homepage growing a parallel copy that drifts.
//
// Returns { ok, response }. `ok:false` carries the real 401/403/404 response
// for the /d/ route to pass through; the homepage ignores it and falls back to
// the neutral page, because `/` must never dead-end on an access screen.
// Live GitHub star count for the landing header. Fetched server-side because
// the doc CSP (default-src 'none') blocks a browser fetch to api.github.com.
// Cached at the edge for an hour via cf.cacheTtl, so it is one refresh per hour
// per POP, not per pageview — GitHub's rate limit is never in play. Best-effort:
// any failure returns null and the header simply shows the mark with no count.
async function fetchStars(env) {
  const repo = (env && env.GITHUB_REPO) || 'tornado-doc/tdoc';
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { 'User-Agent': 'tdoc-landing', 'Accept': 'application/vnd.github+json' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const n = Number(d && d.stargazers_count);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function serveDocVersion(env, req, slug, version, isLanding) {
  const gate = await enforceDocAccess(env, req, slug, version);
  if (!gate.ok) return { ok: false, response: gate.response };
  const obj = await env.DOCS.get(`docs/${slug}/v${version}/index.html`);
  if (!obj) return { ok: false, response: text(`Not found: ${slug} v${version}`, { status: 404 }) };
  const raw = await obj.text();
  const session = gate.session;
  const identity = session ? { login: session.login, avatar_url: session.avatar_url, name: session.name } : null;
  // Pure-publish: version picker only for callers allowed by history_visibility.
  let versions = [{ n: version, created: null }];
  try {
    const meta = gate.meta;
    if (meta && Array.isArray(meta.versions)
        && (gate.ownerToken || canSeeHistory(gate.access, session, env, meta))) {
      versions = meta.versions.map(v => ({ n: v.n, created: v.created || null }));
    } else if (meta && Array.isArray(meta.versions)) {
      const hit = meta.versions.find(v => Number(v.n) === version);
      versions = [{ n: version, created: (hit && hit.created) || null }];
    }
  } catch {}
  const isOwner = isDocOwnerSession(env, session, gate.meta);
  // JUL-36: owner-only manage data (Delete / Unpublish / visibility switch),
  // computed fresh on THIS request and embedded only for the owner. A
  // non-owner's bootCfg carries `ownerManage: null` — the overlay's manage
  // menu never builds a single DOM node without it, so there is nothing to
  // hide, only nothing rendered. Kept separate from `isOwner` (also still
  // sent) so the manage UI's data dependency is explicit and single-source.
  let ownerManage = null;
  if (isOwner) {
    let commentCount = 0;
    try {
      const list = await readComments(env, slug);
      ensureMigrated(list);
      for (const c of historyList(list)) {
        commentCount += 1 + (Array.isArray(c.replies) ? c.replies.length : 0);
      }
    } catch {}
    ownerManage = { access: gate.access, versionCount: versions.length, commentCount };
  }
  const nonce = rand(16);
  // Every doc — the landing docs included — renders as the cross-origin shell
  // (full migration; the overlay monolith is being deleted). Homepage SEO is
  // handled by the crawlable-content-URL plan (#258, separate PR). Stars are
  // landing-only chrome (the bar's GitHub star count).
  const stars = isLanding ? await fetchStars(env) : null;
  // Viewer star state for the bar (beside the title, Google-Docs style):
  // only for signed-in readers on non-landing pages. One KV get; sign-in
  // elsewhere reloads the page, so server-rendered state stays fresh.
  let viewerStar = null;
  if (!isLanding && sessionLogin(session)) {
    try {
      viewerStar = { starred: (await loadStars(env, sessionLogin(session))).some((i) => i.slug === slug) };
    } catch {}
  }
  const render = shellDocumentWorker;
  return {
    ok: true,
    // session rides along so the /d/ route can record the visit (recents)
    // without a second session lookup.
    session,
    response: html(render(raw, slug, version, identity, versions, isOwner, ownerManage, nonce, isLanding, canSeeMyDocs(env, session, requestOrigin(req)), false, !!env.GITHUB_CLIENT_SECRET, stars, viewerStar), {
      headers: { 'Content-Security-Policy': cspHeader(nonce) },
    }),
  };
}

// `/` — the homepage. Renders the LANDING_SLUG doc at its LATEST version, so
// the canonical URL stays `https://tdoc.dev/` forever: publishing v2 changes
// what the homepage says without changing the URL that search engines and
// inbound links point at.
//
// Fails safe. If the doc was never published to this worker, was unpublished,
// or is access-gated, the visitor gets the neutral branded page below rather
// than a 404 or a sign-in wall. Every worker deployed from this repo runs this
// code, but only tdoc.dev has the doc — everyone else's `/` keeps the neutral
// page with no configuration.
async function landingResponse(env, req, slug = LANDING_SLUG) {
  try {
    const meta = await loadDocMeta(env, slug);
    const latest = meta?.versions?.[meta.versions.length - 1]?.n;
    if (!latest) return html(landingHtml(env));
    const res = await serveDocVersion(env, req, slug, Number(latest), true);
    return res.ok ? res.response : html(landingHtml(env));
  } catch {
    return html(landingHtml(env));
  }
}

// Neutral landing page served at `/` when the landing doc is unavailable, and
// on every self-hosted worker that has no such doc. No catalog, no slug list —
// just brand + sign-in (when auth is configured) + a link to the open-source
// project. Docs are link-only. `notice` is an optional toast reason when we
// bounce users here from /me or an unknown path.
function landingHtml(env, notice) {
  const authOk = !!(env && String(env.GITHUB_CLIENT_ID || '').trim());
  const authWeb = !!(env && env.GITHUB_CLIENT_SECRET);
  const toastMsg = ({
    me: 'My docs is only available after you sign in as the worker owner.',
    signin: 'Sign in with GitHub to continue.',
    notfound: 'That page was not found. Sign in or open a doc from its shared link.',
  })[notice] || '';
  const toastJson = JSON.stringify(toastMsg);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tdoc</title>
<style>
  body { font: 15px system-ui, -apple-system, sans-serif; min-height: 100vh;
    margin: 0; display: flex; flex-direction: column; align-items: center;
    justify-content: center; color: #111; background: #fff; gap: 10px; }
  h1 { font-size: 30px; margin: 0; color: #1652f0; }
  p { color: #666; margin: 0; }
  a { color: #1652f0; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .sub { margin-top: 14px; font-size: 13px; color: #888; }
  .actions { display: flex; gap: 10px; align-items: center; margin-top: 18px; }
  button.signin { font: inherit; padding: 8px 16px; border-radius: 8px; border: none;
    background: #1652f0; color: #fff; font-weight: 600; cursor: pointer; }
  button.signin:hover { background: #1245d0; }
  button.signin:disabled { opacity: 0.6; cursor: default; }
  #toast { position: fixed; top: 16px; right: 16px; max-width: min(360px, calc(100vw - 32px));
    background: #111; color: #fff; padding: 12px 14px; border-radius: 10px; font-size: 13px;
    line-height: 1.4; box-shadow: 0 8px 24px rgba(0,0,0,0.18); opacity: 0;
    transform: translateY(-6px); transition: opacity .18s, transform .18s; pointer-events: none; }
  #toast.show { opacity: 1; transform: translateY(0); }
  .status { font-size: 13px; color: #888; min-height: 1.2em; }
</style></head><body>
  <h1>tdoc</h1>
  <p>Prompt-native, commentable documents.</p>
  <div class="actions">
    ${authOk ? '<button type="button" class="signin" id="signin">Sign in with GitHub</button>' : ''}
  </div>
  <p class="status" id="status"></p>
  <p class="sub">Open a document from its shared link ·
    <a href="https://github.com/tornado-doc/tdoc">github.com/tornado-doc/tdoc</a></p>
  <div id="toast" role="status" aria-live="polite"></div>
<script>window.__TDOC__ = { authConfigured: true, webAuth: ${authWeb ? 'true' : 'false'}, signinReturn: '/me' };</script>
<script>${SIGNIN_JS}</script>
<script>
  // One shared sign-in (server/signin.js): web redirect flow when webAuth is on,
  // else the device-code modal. On the redirect path __tdocSignIn navigates away
  // and never resolves, so the .then below only runs on the device path.
  (function () {
    var btn = document.getElementById('signin');
    if (!btn || !window.__tdocSignIn) return;
    btn.onclick = function () {
      btn.disabled = true;
      window.__tdocSignIn().then(function () { location.href = '/me'; },
        function () { btn.disabled = false; });
    };
  })();
</script>
</body></html>`;
}

function authDoneHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tdoc — signed in</title>
<style>
  body { font: 15px system-ui, -apple-system, sans-serif; min-height: 100vh; margin: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    color: #111; background: #fff; gap: 8px; }
  h1 { font-size: 22px; margin: 0; color: #1652f0; }
  p { color: #666; margin: 0; }
</style></head><body>
  <h1>You're signed in</h1>
  <p>You can close this tab and return to tdoc.</p>
</body></html>`;
}

// Web OAuth redirect flow (browsers). Device flow stays for CLIs; this is the
// hop that phones need — GitHub sends the visitor straight back here after
// Approve, so nobody is stranded on GitHub's "Congratulations" page. Active
// only when GITHUB_CLIENT_SECRET is set (the token exchange requires it), so a
// deploy without the secret silently keeps the device flow.
function authErrorHtml(msg) {
  const safe = String(msg || 'Sign-in failed.').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tdoc — sign-in</title>
<style>
  body { font: 15px system-ui, -apple-system, sans-serif; min-height: 100vh; margin: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    color: #111; background: #fff; gap: 8px; text-align: center; padding: 0 20px; }
  h1 { font-size: 22px; margin: 0; color: #c3452f; }
  p { color: #666; margin: 0; }
  a { color: #1652f0; }
</style></head><body>
  <h1>Sign-in failed</h1>
  <p>${safe}</p>
  <p><a href="/">Back to tdoc</a></p>
</body></html>`;
}

// Only ever redirect to a same-origin path we produced. Reject absolute URLs
// and protocol-relative (`//evil.com`) targets so a crafted `?return=` can't
// bounce a signed-in visitor off-site. Falls back to the site root.
function sanitizeReturn(raw) {
  if (typeof raw !== 'string' || !raw) return '/';
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return '/';
  if (/[\x00-\x1f]/.test(raw)) return '/';
  return raw;
}

// 302 that can also set cookies — no existing helper does both at once.
function redirectTo(location, cookies) {
  const h = new Headers({ Location: location });
  (cookies || []).forEach((c) => h.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers: h });
}

// /me — the owner's doc catalog. JUL-36 tail (2026-08-13): this used to be a
// dense access-control table (visibility/history/commenting/allowed_users
// dropdowns + Save) gated by an admin-token field. Both are GONE now:
//   - access controls moved to the doc-page Share panel (overlay.js
//     showManageModal, PATCH /api/doc/access) — a single doc's own page is
//     the right place to manage that doc, not a spreadsheet of every doc.
//   - the admin-token field is gone because DELETE /api/doc now accepts the
//     owner's session cookie (authorizeOwnerMutation) — safe because of the
//     CSP set on every doc response (see cspHeader()). /me is gated by
//     canSeeMyDocs (hosted: any signed-in GitHub user; BYOK: TDOC_OWNER),
//     so its own fetches are already same-origin + cookied.
// What's left: title, slug, version, search, multi-select batch delete, and
// a quiet ⋯ Delete. No access data of any kind is computed or emitted here
// (gate: response HTML must not contain `allowed_users` — there is nothing
// here that could).
// ---- personal docs state: stars, recents, folders ----
// Per-user KV values, same shape discipline as the notifications inbox: one
// small JSON blob per login, get→mutate→put, capped lists, only the four KV
// ops the Vercel shim implements. Stars and recents are viewer-scoped (they
// follow the signed-in reader across docs they do not own); folders organize
// only the viewer's own catalog on /me.
const RECENTS_MAX = 30;
const STARS_MAX = 200;
const FOLDERS_MAX = 50;
const FOLDER_NAME_MAX = 60;
// A reload of the doc already at the head of the recents list within this
// window does not rewrite KV — visits are a signal, not an access log.
const RECENT_REVISIT_MS = 5 * 60 * 1000;

function personalKey(prefix, login) {
  const n = normalizeGithubLogin(login);
  return n ? `${prefix}:${n}` : null;
}

async function loadPersonal(env, key) {
  if (!key) return null;
  try {
    const raw = await env.META.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function personalItems(state) {
  if (!state || !Array.isArray(state.items)) return [];
  return state.items.filter((i) => i && typeof i.slug === 'string');
}

async function loadStars(env, login) {
  return personalItems(await loadPersonal(env, personalKey('stars', login)));
}

async function loadRecents(env, login) {
  return personalItems(await loadPersonal(env, personalKey('recents', login)));
}

async function setDocStar(env, login, slug, starred) {
  const key = personalKey('stars', login);
  if (!key) return;
  const items = personalItems(await loadPersonal(env, key)).filter((i) => i.slug !== slug);
  if (starred) items.unshift({ slug, at: new Date().toISOString() });
  await env.META.put(key, JSON.stringify({ items: items.slice(0, STARS_MAX) }));
}

async function recordDocVisit(env, login, slug) {
  const key = personalKey('recents', login);
  if (!key || !isValidSlug(slug)) return;
  const items = personalItems(await loadPersonal(env, key));
  if (items[0] && items[0].slug === slug
      && Date.now() - (Date.parse(items[0].at) || 0) < RECENT_REVISIT_MS) return;
  const next = [{ slug, at: new Date().toISOString() }, ...items.filter((i) => i.slug !== slug)];
  await env.META.put(key, JSON.stringify({ items: next.slice(0, RECENTS_MAX) }));
}

function normalizeFolderState(state) {
  const folders = state && Array.isArray(state.folders)
    ? state.folders.filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string')
    : [];
  const ids = new Set(folders.map((f) => f.id));
  const docs = {};
  if (state && state.docs && typeof state.docs === 'object') {
    for (const [slug, fid] of Object.entries(state.docs)) {
      // Drop mappings to folders that no longer exist — docs fall back to root.
      if (typeof fid === 'string' && ids.has(fid)) docs[slug] = fid;
    }
  }
  return { folders, docs };
}

async function loadFolderState(env, login) {
  return normalizeFolderState(await loadPersonal(env, personalKey('folders', login)));
}

async function saveFolderState(env, login, state) {
  const key = personalKey('folders', login);
  if (!key) return;
  await env.META.put(key, JSON.stringify(normalizeFolderState(state)));
}

function validFolderName(name) {
  const n = String(name == null ? '' : name).replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!n || n.length > FOLDER_NAME_MAX) return null;
  return n;
}

// /me needs to know whether a recent/starred doc — possibly someone else's —
// is still readable by this viewer. Policy evaluation stays out here so the
// catalog renderer never touches access data; it only sees the verdict.
function docReadableBy(env, session, meta) {
  return canReadDoc(accessFromMeta(meta || {}), session, env, meta);
}

async function indexHtml(env, session, origin, nonce) {
  // Catalog is title/slug/version from KV meta only. Do NOT HEAD R2 or fold
  // comment logs here — that was N serial Durable-Object + R2 round trips
  // per page load. Search + batch select are client-side over the rendered
  // rows (no extra KV/R2 work). Delete confirm is immediate (no comment
  // pre-flight) so the catalog stays snappy.
  let list = [];
  let cursor;
  do {
    const r = await env.META.list({ prefix: 'meta:', cursor });
    list = list.concat(r.keys);
    cursor = r.cursor;
    if (r.list_complete) break;
  } while (cursor);

  const hosted = hostedRegistrationEnabled(env, origin);
  const catalog = await Promise.all(list.map(async (k) => {
    const slug = k.name.slice('meta:'.length);
    const metaRaw = await env.META.get(k.name);
    let meta = {};
    try { meta = JSON.parse(metaRaw || '{}'); } catch {}
    const versions = Array.isArray(meta.versions) ? meta.versions : [];
    const latest = versions[versions.length - 1]?.n || 1;
    const created = meta.created || versions[0]?.created || '';
    const updated = versions[versions.length - 1]?.created || created;
    return { slug, title: meta.title || slug, latest, created, updated, meta };
  }));
  const docs = catalog.filter((row) => {
    if (hosted) return isDocOwnerSession(env, session, row.meta);
    // BYOK operator catalog: keep other people's hosted copies off the list (#146).
    const hostedLogin = hostedGithubLogin(row.meta);
    if (hostedLogin && hostedLogin !== sessionLogin(session)) return false;
    return true;
  });
  // Newest activity first — the catalog default. The sort select re-orders
  // client-side off each row's data-updated/data-created attributes.
  docs.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  const visible = docs;

  // Viewer-scoped state: stars and recents may point at docs the viewer does
  // not own (a colleague's shared doc). Rows render only for docs that still
  // exist on this worker AND are still readable by this viewer.
  const viewerLogin = sessionLogin(session);
  const [starItems, recentItems, folderState] = viewerLogin
    ? await Promise.all([loadStars(env, viewerLogin), loadRecents(env, viewerLogin), loadFolderState(env, viewerLogin)])
    : [[], [], { folders: [], docs: {} }];
  const bySlug = new Map(catalog.map((r) => [r.slug, r]));
  const starredSet = new Set(starItems.map((i) => i.slug));
  const readableRow = (slug) => {
    const row = bySlug.get(slug);
    return row && docReadableBy(env, session, row.meta) ? row : null;
  };
  const recentRows = recentItems
    .map((i) => { const r = readableRow(i.slug); return r && { ...r, at: i.at }; })
    .filter(Boolean);
  const starRows = starItems
    .map((i) => { const r = readableRow(i.slug); return r && { ...r, at: i.at }; })
    .filter(Boolean);

  const day = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '');
  const starBtn = (slug) => `<button class="star-btn${starredSet.has(slug) ? ' is-starred' : ''}" data-slug="${escapeHtml(slug)}" aria-pressed="${starredSet.has(slug)}" aria-label="${starredSet.has(slug) ? 'Unstar' : 'Star'} ${escapeHtml(slug)}">${starredSet.has(slug) ? '★' : '☆'}</button>`;

  // Location model (Drive-style, one level for now — a folder `parent`
  // field is reserved for nesting): folders render as rows above the doc
  // list, filed docs leave the root view, navigation is ?folder=<id>.
  const folderById = new Map(folderState.folders.map((f) => [f.id, f]));
  const folderCounts = {};
  for (const row of visible) {
    const fid = folderState.docs[row.slug];
    if (fid) folderCounts[fid] = (folderCounts[fid] || 0) + 1;
  }
  const locHint = (slug) => {
    const f = folderById.get(folderState.docs[slug]);
    return f ? `<span class="loc-hint" hidden> · in ${escapeHtml(f.name)}</span>` : '';
  };

  const rows = visible.map(({ slug, title, latest, created, updated }) => `<div class="doc-row" data-slug="${escapeHtml(slug)}" data-title="${escapeHtml(title)}" data-created="${escapeHtml(created)}" data-updated="${escapeHtml(updated)}" data-folder="${escapeHtml(folderState.docs[slug] || '')}">
      <label class="row-check">
        <input type="checkbox" class="doc-check" aria-label="Select ${escapeHtml(title)}">
      </label>
      <div class="doc-info">
        <a class="doc-title" href="/d/${encodeURIComponent(slug)}/v/${latest}">${escapeHtml(title)}</a>
        <div class="doc-meta">${escapeHtml(slug)} · v${latest}${day(updated) ? ` · updated ${day(updated)}` : ''}${locHint(slug)}</div>
      </div>
      <div class="row-actions">
        ${starBtn(slug)}
        <button class="row-menu-btn" aria-label="More actions" aria-haspopup="true" aria-expanded="false">⋯</button>
        <div class="row-menu" hidden>
          <button class="row-move" data-slug="${escapeHtml(slug)}" data-title="${escapeHtml(title)}">Move to folder…</button>
          <button class="row-delete" data-slug="${escapeHtml(slug)}" data-title="${escapeHtml(title)}">Delete…</button>
        </div>
      </div>
    </div>`);

  // Recent / Starred panes: read-only rows (no select, no manage menu — the
  // viewer may not own these docs), a byline for someone else's doc, and the
  // same star toggle.
  const flatRow = (row, label) => {
    const owner = hostedGithubLogin(row.meta);
    const by = owner && owner !== viewerLogin ? `by ${owner} · ` : '';
    return `<div class="doc-row flat-row" data-slug="${escapeHtml(row.slug)}" data-title="${escapeHtml(row.title)}">
      <div class="doc-info">
        <a class="doc-title" href="/d/${encodeURIComponent(row.slug)}/v/${row.latest}">${escapeHtml(row.title)}</a>
        <div class="doc-meta">${escapeHtml(by)}${label} ${day(row.at)}</div>
      </div>
      <div class="row-actions">${starBtn(row.slug)}</div>
    </div>`;
  };
  const recentList = recentRows.map((r) => flatRow(r, 'visited')).join('');
  const starList = starRows.map((r) => flatRow(r, 'starred')).join('');

  const folderRows = folderState.folders
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map((f) => {
      const n = folderCounts[f.id] || 0;
      return `<div class="doc-row folder-row" data-folder-id="${escapeHtml(f.id)}" data-name="${escapeHtml(f.name)}" role="button" tabindex="0" aria-label="Open folder ${escapeHtml(f.name)}">
      <span class="folder-ico" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>
      <div class="doc-info">
        <span class="doc-title">${escapeHtml(f.name)}</span>
        <div class="doc-meta">${n} ${n === 1 ? 'doc' : 'docs'}</div>
      </div>
      <div class="row-actions">
        <button class="row-menu-btn" aria-label="Folder actions" aria-haspopup="true" aria-expanded="false">⋯</button>
        <div class="row-menu" hidden>
          <button class="folder-rename" data-id="${escapeHtml(f.id)}">Rename…</button>
          <button class="folder-delete" data-id="${escapeHtml(f.id)}" data-name="${escapeHtml(f.name)}">Delete folder…</button>
        </div>
      </div>
    </div>`;
    }).join('');
  const foldersJson = JSON.stringify(folderState.folders.map((f) => ({ id: f.id, name: f.name }))).replace(/</g, '\\u003c');

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My docs</title>
<style>
  :root {
    --td-accent: #1652f0; --td-accent-hover: #1245d0; --td-accent-tint: #e8eeff;
    --td-danger: #b42318; --td-danger-hover: #931c14; --td-danger-tint: #fdeceb; --td-ok: #087443;
    --td-ink: #111; --td-muted: #666; --td-line: #eee; --td-surface: #f7f7f7;
  }
  body { font: 15px system-ui, -apple-system, sans-serif; margin: 0; color: var(--td-ink); }
  .wrap { max-width: 680px; margin: 0 auto; padding: 24px 20px 48px; }
  h1 { font-size: 28px; margin: 0 0 24px; color: var(--td-accent); }
  a { color: var(--td-accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #888; padding: 40px 0; text-align: center; border: 1px dashed var(--td-line); border-radius: 12px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 0 0 12px; }
  .toolbar input[type="search"] { flex: 1 1 220px; min-width: 0; font: inherit; padding: 8px 12px; border: 1px solid var(--td-line); border-radius: 8px; background: #fff; color: var(--td-ink); }
  .toolbar input[type="search"]:focus { outline: 2px solid var(--td-accent-tint); border-color: var(--td-accent); }
  .batch-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin: 0 0 8px; min-height: 32px; }
  .select-all { display: inline-flex; align-items: center; gap: 8px; color: var(--td-muted); font-size: 13px; cursor: pointer; user-select: none; }
  .batch-delete { display: none; font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--td-danger); background: #fff; color: var(--td-danger); }
  .batch-delete.is-visible { display: inline-block; }
  .batch-delete:hover { background: var(--td-danger); color: #fff; }
  .batch-delete:disabled { opacity: 0.5; cursor: default; }
  .doc-list { display: flex; flex-direction: column; }
  .doc-list[hidden], .doc-row[hidden], .empty[hidden] { display: none !important; }
  /* Create-a-doc: /me is where someone lands after publishing, so it is also
     where they come back to make the next one. The button teaches rather than
     creates, because nothing here can create a doc — their agent writes it. */
  .page-hd { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0 0 12px; }
  .page-hd h1 { margin: 0; }
  .mk-btn { margin-left: auto; border: 0; border-radius: 999px; background: var(--td-accent); color: #fff;
    font: inherit; font-weight: 650; padding: 9px 16px; cursor: pointer; }
  .mk-bg { position: fixed; inset: 0; background: rgba(16,18,26,.55); display: grid; place-items: center;
    z-index: 99999; padding: 20px; }
  .mk-bg[hidden] { display: none; }
  .mk { width: min(480px, 100%); background: #fff; border-radius: 16px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(16,18,26,.28); text-align: left; }
  .mk-hd { display: flex; align-items: center; padding: 17px 20px; border-bottom: 1px solid var(--td-line); }
  .mk-hd strong { font-size: 15px; }
  .mk-hd button { margin-left: auto; border: 0; background: none; font-size: 20px; line-height: 1;
    color: #767c8b; cursor: pointer; }
  .mk-bd { padding: 18px 20px; }
  .mk-bd ol { margin: 0; padding-left: 18px; color: #5b6070; font-size: 14px; }
  .mk-bd li { margin: 0 0 9px; }
  .mk-bd b { color: var(--td-ink); }
  .mk-say { display: block; margin: 6px 0 0; padding: 9px 11px; background: #f5f6f8;
    border: 1px solid var(--td-line); border-radius: 8px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--td-ink); }
  .mk-ft { padding: 14px 20px; border-top: 1px solid var(--td-line); font-size: 12.5px; color: #767c8b; }
  .doc-row { display: flex; align-items: center; gap: 12px; padding: 13px 4px; border-bottom: 1px solid var(--td-line); }
  .doc-row.is-selected { background: var(--td-accent-tint); border-radius: 8px; }
  .row-check { display: flex; align-items: center; flex-shrink: 0; cursor: pointer; }
  /* Drive-style quiet checkboxes: the box keeps its slot (no layout jump) but
     stays invisible until the row is hovered/focused, or while any selection
     is active (.is-selecting on the list). Touch devices have no hover to
     reveal with, so they keep the boxes always visible. */
  @media (hover: hover) {
    .doc-list:not(.is-selecting) .row-check { opacity: 0; transition: opacity .12s; }
    .doc-list:not(.is-selecting) .doc-row:hover .row-check,
    .doc-list:not(.is-selecting) .doc-row:focus-within .row-check { opacity: 1; }
  }
  .row-check input, .select-all input { width: 15px; height: 15px; accent-color: var(--td-accent); cursor: pointer; }
  .doc-info { min-width: 0; flex: 1 1 auto; }
  .doc-title { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .doc-meta { color: var(--td-muted); font-size: 12px; margin-top: 2px; }
  button { font: inherit; cursor: pointer; transition: border-color .12s, background .12s, color .12s; }
  /* Delete lives behind a quiet ⋯ overflow — the catalog reads as a clean list,
     not a management console. Faint by default, clearer on row hover. */
  .row-actions { position: relative; flex-shrink: 0; margin-left: auto; }
  .row-menu-btn { border: none; background: none; color: #ccc; font-size: 20px; line-height: 1; padding: 2px 8px; border-radius: 6px; }
  .doc-row:hover .row-menu-btn { color: var(--td-muted); }
  .row-menu-btn:hover, .row-menu-btn[aria-expanded="true"] { background: var(--td-line); color: var(--td-ink); }
  .row-menu { position: absolute; right: 0; top: 100%; margin-top: 4px; min-width: 128px; background: #fff; border: 1px solid var(--td-line); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.12); padding: 4px; z-index: 10; }
  .row-menu[hidden] { display: none; }
  .row-delete { display: block; width: 100%; text-align: left; border: none; background: none; color: var(--td-danger); padding: 8px 12px; border-radius: 6px; white-space: nowrap; }
  .row-delete:hover { background: var(--td-danger-tint); }
  /* Styled confirm modal — replaces window.confirm() (JUL-36). Overlay.js
     supplies the site bar; this modal stays local because catalog delete
     is not a document Share flow. */
  .tdoc-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 1000000; display: flex; align-items: center; justify-content: center; font: 14px system-ui, sans-serif; }
  .tdoc-modal { background: #fff; color: var(--td-ink); border-radius: 12px; padding: 26px; width: 420px; max-width: calc(100vw - 32px); box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
  .tdoc-modal h3 { margin: 0 0 10px; font-size: 18px; }
  .tdoc-modal p { margin: 0 0 14px; color: #444; line-height: 1.5; }
  .tdoc-modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
  .tdoc-modal button { padding: 8px 16px; border-radius: 6px; border: 1px solid #ccc; background: #fff; }
  .tdoc-modal button:hover { border-color: #999; }
  .tdoc-modal button.danger { background: var(--td-danger); border-color: var(--td-danger); color: #fff; }
  .tdoc-modal button.danger:hover { background: var(--td-danger-hover); border-color: var(--td-danger-hover); }
  .tdoc-modal button.primary { background: var(--td-accent); border-color: var(--td-accent); color: #fff; font-weight: 600; }
  .tdoc-modal button.primary:hover { background: var(--td-accent-hover); border-color: var(--td-accent-hover); }
  .tdoc-modal input[type="text"] { width: 100%; box-sizing: border-box; font: inherit; padding: 8px 10px; border: 1px solid var(--td-line); border-radius: 8px; margin: 0 0 14px; }
  .tdoc-modal input[type="text"]:focus { outline: 2px solid var(--td-accent-tint); border-color: var(--td-accent); }
  /* Google-Docs-style views: My docs / Recent / Starred are pure visibility
     switches over the already-rendered page — no fetch on tab change. */
  .tabs { display: flex; gap: 4px; margin: 0 0 16px; border-bottom: 1px solid var(--td-line); }
  .tab { border: none; background: none; font: inherit; font-weight: 600; color: var(--td-muted); padding: 8px 12px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab:hover { color: var(--td-ink); }
  .tab.is-active { color: var(--td-accent); border-bottom-color: var(--td-accent); }
  .pane[hidden] { display: none !important; }
  .toolbar select { -webkit-appearance: none; appearance: none; font: inherit; padding: 8px 30px 8px 12px;
    border: 1px solid var(--td-line); border-radius: 8px; color: var(--td-ink); cursor: pointer;
    background: #fff url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%23666' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 11px center;
    background-size: 11px; }
  .toolbar select:hover { border-color: #ccc; }
  .toolbar select:focus { outline: 2px solid var(--td-accent-tint); border-color: var(--td-accent); }
  .folder-row { cursor: pointer; }
  .folder-row:hover { background: var(--td-surface); }
  .folder-ico { display: flex; align-items: center; color: var(--td-muted); flex-shrink: 0; padding: 0 2px; }
  .folder-row:hover .folder-ico { color: var(--td-accent); }
  .folder-rename { display: block; width: 100%; text-align: left; border: none; background: none; color: var(--td-ink); padding: 8px 12px; border-radius: 6px; white-space: nowrap; }
  .folder-rename:hover { background: var(--td-surface); }
  .folder-delete { display: block; width: 100%; text-align: left; border: none; background: none; color: var(--td-danger); padding: 8px 12px; border-radius: 6px; white-space: nowrap; }
  .folder-delete:hover { background: var(--td-danger-tint); }
  .crumbs { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; font-size: 14px; }
  .crumbs[hidden] { display: none !important; }
  .crumb-root { border: none; background: none; font: inherit; color: var(--td-accent); padding: 2px 6px; border-radius: 6px; cursor: pointer; }
  .crumb-root:hover { background: var(--td-accent-tint); }
  .crumbs .sep { color: #c0c0c4; user-select: none; }
  .crumbs .cur { font-weight: 600; }
  .new-folder-btn { font: inherit; font-size: 13px; padding: 8px 12px; border-radius: 8px; border: 1px dashed var(--td-line); background: #fff; color: var(--td-muted); white-space: nowrap; }
  .new-folder-btn:hover { border-color: var(--td-accent); color: var(--td-accent); }
  .loc-hint { color: var(--td-muted); }
  .loc-hint[hidden] { display: none !important; }
  .folder-row[hidden] { display: none !important; }
  .star-btn { border: none; background: none; font-size: 17px; color: #ccc; padding: 2px 6px; border-radius: 6px; line-height: 1; }
  .doc-row:hover .star-btn { color: var(--td-muted); }
  .star-btn:hover { background: var(--td-line); color: #f5a623; }
  .star-btn.is-starred, .doc-row:hover .star-btn.is-starred { color: #f5a623; }
  .batch-actions { display: flex; gap: 8px; }
  .batch-move { display: none; font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--td-accent); background: #fff; color: var(--td-accent); }
  .batch-move.is-visible { display: inline-block; }
  .batch-move:hover { background: var(--td-accent); color: #fff; }
  .batch-move:disabled { opacity: 0.5; cursor: default; }
  .row-move { display: block; width: 100%; text-align: left; border: none; background: none; color: var(--td-ink); padding: 8px 12px; border-radius: 6px; white-space: nowrap; }
  .row-move:hover { background: var(--td-surface); }
  .move-list { display: flex; flex-direction: column; gap: 4px; margin: 0 0 14px; max-height: 40vh; overflow: auto; }
  .move-list button { text-align: left; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--td-line); background: #fff; }
  .move-list button:hover { background: var(--td-accent-tint); border-color: var(--td-accent); }
</style>
</head><body>
<div class="wrap">
<div class="page-hd"><h1>My docs</h1><button class="mk-btn" id="mk-open" type="button">Create a doc</button></div>
<div class="tabs" role="tablist">
  <button type="button" class="tab is-active" data-pane="pane-mine" role="tab" aria-selected="true">My docs</button>
  <button type="button" class="tab" data-pane="pane-recent" role="tab" aria-selected="false">Recent</button>
  <button type="button" class="tab" data-pane="pane-starred" role="tab" aria-selected="false">Starred</button>
</div>
<section class="pane" id="pane-mine">
${rows.length === 0 ? '<p class="empty">No published docs yet. Hit <b>Create a doc</b> to see how, or <a href="/templates">browse templates</a> for a look to start from.</p>' :
  `<div class="toolbar">
    <input type="search" id="doc-search" placeholder="Search title or slug…" autocomplete="off" aria-label="Search docs">
    <select id="doc-sort" aria-label="Sort docs">
      <option value="updated">Last updated</option>
      <option value="created">Created</option>
      <option value="title">Title</option>
    </select>
    <button type="button" id="new-folder" class="new-folder-btn">+ New folder</button>
  </div>
  <div class="crumbs" id="crumbs" hidden>
    <button type="button" class="crumb-root" id="crumb-root">My docs</button>
    <span class="sep" aria-hidden="true">/</span>
    <span class="cur" id="crumb-name"></span>
  </div>
  <div class="batch-bar">
    <label class="select-all"><input type="checkbox" id="select-all"> <span id="select-all-label">Select all</span></label>
    <span class="batch-actions">
      <button type="button" id="batch-move" class="batch-move">Move</button>
      <button type="button" id="batch-delete" class="batch-delete">Delete selected</button>
    </span>
  </div>
  <div id="folder-rows">${folderRows}</div>
  <div class="doc-list">${rows.join('')}</div>
  <p id="no-match" class="empty" hidden>No matches.</p>`}
</section>
<section class="pane" id="pane-recent" hidden>
  ${recentList ? `<div class="doc-list">${recentList}</div>` : '<p class="empty">Docs you open show up here.</p>'}
</section>
<section class="pane" id="pane-starred" hidden>
  ${starList ? `<div class="doc-list">${starList}</div>` : '<p class="empty">Star docs to find them again quickly.</p>'}
</section>
</div>

<div class="mk-bg" id="mk-bg" hidden>
  <div class="mk" role="dialog" aria-modal="true" aria-label="Create a doc">
    <div class="mk-hd"><strong>Create a doc</strong><button type="button" id="mk-x" aria-label="Close">&times;</button></div>
    <div class="mk-bd">
      <ol>
        <li>Open the AI you already use.
          <span class="mk-say">Use tdoc to make me a one page summary of this quarter, with a chart of weekly signups.</span>
        </li>
        <li>It writes the page, publishes it, and hands you the link.</li>
        <li>Send that link to anyone. They comment on the page, and your AI answers them.</li>
      </ol>
    </div>
    <div class="mk-ft">Want a specific look first? <a href="/templates">Browse templates</a>. &nbsp;·&nbsp; Not set up yet? <a href="/start">Start here</a>.</div>
  </div>
</div>
<script${nonce ? ` nonce="${nonce}"` : ''}>
  // Create-a-doc tutorial. /me cannot create anything — the doc is written by
  // the user's own agent — so this explains where creation actually happens.
  (function () {
    var bg = document.getElementById('mk-bg');
    var openBtn = document.getElementById('mk-open');
    if (!bg || !openBtn) return;
    function show(on) { bg.hidden = !on; if (on) document.getElementById('mk-x').focus(); }
    openBtn.onclick = function () { show(true); };
    document.getElementById('mk-x').onclick = function () { show(false); };
    bg.addEventListener('click', function (e) { if (e.target === bg) show(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !bg.hidden) show(false); });
  })();

  // Tabs + stars — wired independently of the catalog block below, which
  // bails out early when the viewer has no docs of their own (Recent and
  // Starred can still have rows in that case).
  (function () {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) {
          var active = t === tab;
          t.classList.toggle('is-active', active);
          t.setAttribute('aria-selected', String(active));
          var pane = document.getElementById(t.dataset.pane);
          if (pane) pane.hidden = !active;
        });
      });
    });

    // Star toggle: optimistic flip (every button for the same slug, across
    // panes), revert on failure. Session cookie authorizes /api/star.
    // One BroadcastChannel instance for this page: posts our own star changes
    // (so open doc tabs repaint their bar star) and hears other tabs' changes
    // (a channel never delivers a message back to the instance that sent it).
    var channel = null;
    try { channel = new BroadcastChannel('tdoc-doc-state'); } catch (e) {}
    function paintStar(slug, on) {
      document.querySelectorAll('.star-btn').forEach(function (b) {
        if (b.dataset.slug !== slug) return;
        b.classList.toggle('is-starred', on);
        b.textContent = on ? '★' : '☆';
        b.setAttribute('aria-pressed', String(on));
      });
    }
    function starredEmpty(pane) {
      if (!pane.querySelector('.doc-row')) {
        pane.innerHTML = '<p class="empty">Star docs to find them again quickly.</p>';
      }
    }
    // A fresh star must show up when the user flips to the Starred tab NOW —
    // the server render is behind us. Clone the essentials from any rendered
    // row for that slug (My docs or Recent) into a flat row, DOM-built.
    function addToStarredPane(slug) {
      var pane = document.getElementById('pane-starred');
      if (!pane) return;
      var rows = Array.prototype.slice.call(document.querySelectorAll('.doc-row'));
      if (rows.some(function (r) { return r.dataset.slug === slug && pane.contains(r); })) return;
      var src = null;
      rows.forEach(function (r) { if (!src && r.dataset.slug === slug && r.querySelector('.doc-title')) src = r; });
      if (!src) return;
      var list = pane.querySelector('.doc-list');
      if (!list) {
        pane.innerHTML = '<div class="doc-list"></div>';
        list = pane.querySelector('.doc-list');
      }
      var row = document.createElement('div');
      row.className = 'doc-row flat-row';
      row.dataset.slug = slug;
      row.dataset.title = src.dataset.title || slug;
      var info = document.createElement('div');
      info.className = 'doc-info';
      var a = document.createElement('a');
      a.className = 'doc-title';
      a.href = src.querySelector('.doc-title').href;
      a.textContent = src.dataset.title || slug;
      var meta = document.createElement('div');
      meta.className = 'doc-meta';
      meta.textContent = 'starred ' + new Date().toISOString().slice(0, 10);
      info.appendChild(a);
      info.appendChild(meta);
      var actions = document.createElement('div');
      actions.className = 'row-actions';
      var b = document.createElement('button');
      b.className = 'star-btn is-starred';
      b.dataset.slug = slug;
      b.setAttribute('aria-pressed', 'true');
      b.textContent = '★';
      actions.appendChild(b);
      row.appendChild(info);
      row.appendChild(actions);
      list.insertBefore(row, list.firstChild);
    }
    document.addEventListener('click', async function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.star-btn') : null;
      if (!btn) return;
      e.stopPropagation();
      var slug = btn.dataset.slug;
      var starred = !btn.classList.contains('is-starred');
      paintStar(slug, starred);
      try {
        var res = await fetch('/api/star', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: slug, starred: starred }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var pane = document.getElementById('pane-starred');
        if (starred) {
          addToStarredPane(slug);
        } else if (pane) {
          // Unstarring removes the row from the Starred pane right away.
          pane.querySelectorAll('.doc-row').forEach(function (row) {
            if (row.dataset.slug === slug) row.remove();
          });
          starredEmpty(pane);
        }
        if (channel) { try { channel.postMessage({ type: 'star', slug: slug, starred: starred }); } catch (e2) {} }
      } catch (err) {
        paintStar(slug, !starred);
      }
    });

    // Server-rendered pages go stale two ways: a bfcache Back into an old
    // copy, and star changes made from a doc page in another tab. Reload on
    // both signals (deferred to the next focus while hidden) — this page has
    // no client data layer to patch instead (deliberate; see issue #287).
    var stale = false;
    window.addEventListener('pageshow', function (e) { if (e.persisted) location.reload(); });
    if (channel) channel.addEventListener('message', function (ev) {
      var d = ev.data || {};
      if (d.type !== 'star') return;
      if (document.hidden) stale = true;
      else location.reload();
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && stale) location.reload();
    });
  })();

(() => {
  // Tiny top-right toast — no third-party runtime on the privileged /me page.
  function toast(message, kind = '') {
    if (!message) return;
    document.querySelectorAll('.tdoc-toast').forEach((n) => n.remove());
    const t = document.createElement('div');
    t.className = 'tdoc-toast';
    t.textContent = message;
    t.setAttribute('role', 'status');
    t.style.cssText = 'position:fixed;top:62px;right:18px;z-index:1000001;background:' +
      (kind === 'error' ? '#b42318' : '#1652f0') +
      ';color:#fff;padding:12px 16px;border-radius:8px;font:14px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.18)';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }
  // Styled confirm — replaces window.confirm(). Resolves true/false; never
  // silently proceeds (Cancel and the backdrop both resolve false).
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
      goBtn.className = danger ? 'danger' : 'primary';
      const done = (v) => { bg.remove(); resolve(v); };
      bg.querySelector('[data-act="cancel"]').onclick = () => done(false);
      bg.addEventListener('click', (e) => { if (e.target === bg) done(false); });
      goBtn.onclick = () => done(true);
      document.body.appendChild(bg);
    });
  }
  // Styled text prompt (folder names) — same modal chrome as showConfirm.
  // Resolves the trimmed value, or null on cancel/backdrop.
  function showPrompt({ title, confirmLabel, value = '', placeholder = '' }) {
    return new Promise((resolve) => {
      const bg = document.createElement('div');
      bg.className = 'tdoc-modal-bg';
      bg.innerHTML = '<div class="tdoc-modal">' +
        '<h3></h3><input type="text" maxlength="60">' +
        '<div class="actions">' +
          '<button type="button" data-act="cancel">Cancel</button>' +
          '<button type="button" data-act="go"></button>' +
        '</div></div>';
      bg.querySelector('h3').textContent = title;
      const input = bg.querySelector('input');
      input.value = value;
      input.placeholder = placeholder;
      const goBtn = bg.querySelector('[data-act="go"]');
      goBtn.textContent = confirmLabel;
      goBtn.className = 'primary';
      const done = (v) => { bg.remove(); resolve(v); };
      const go = () => { const v = input.value.trim(); if (v) done(v); };
      bg.querySelector('[data-act="cancel"]').onclick = () => done(null);
      bg.querySelector('[data-act="go"]').onclick = go;
      bg.addEventListener('click', (e) => { if (e.target === bg) done(null); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      document.body.appendChild(bg);
      input.focus();
    });
  }
  // Folder picker for Move — a button per destination, DOM-built (no
  // innerHTML with user-named folders). Resolves {folder} or null.
  function pickFolder(title) {
    return new Promise((resolve) => {
      const bg = document.createElement('div');
      bg.className = 'tdoc-modal-bg';
      const box = document.createElement('div');
      box.className = 'tdoc-modal';
      const h = document.createElement('h3');
      h.textContent = title;
      box.appendChild(h);
      const done = (v) => { bg.remove(); resolve(v); };
      const listBox = document.createElement('div');
      listBox.className = 'move-list';
      const add = (id, name) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = name;
        b.onclick = () => done({ folder: id });
        listBox.appendChild(b);
      };
      add('', 'My docs (no folder)');
      FOLDERS.forEach((f) => add(f.id, f.name));
      box.appendChild(listBox);
      const actions = document.createElement('div');
      actions.className = 'actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.onclick = () => done(null);
      actions.appendChild(cancel);
      box.appendChild(actions);
      bg.appendChild(box);
      bg.addEventListener('click', (e) => { if (e.target === bg) done(null); });
      document.body.appendChild(bg);
    });
  }
  async function moveDocs(slugs, folder) {
    const res = await fetch('/api/folders/move', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slugs, folder: folder || null }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  }
  // ⋯ overflow menu — one open at a time; a click anywhere else closes it.
  function closeMenus(except) {
    document.querySelectorAll('.row-menu').forEach((m) => {
      if (m === except) return;
      m.hidden = true;
      m.previousElementSibling.setAttribute('aria-expanded', 'false');
    });
  }
  document.querySelectorAll('.row-menu-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      const willOpen = menu.hidden;
      closeMenus(willOpen ? menu : null);
      menu.hidden = !willOpen;
      btn.setAttribute('aria-expanded', String(willOpen));
    });
  });
  document.addEventListener('click', () => closeMenus(null));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(null); });

  // Delete: no token — the browser is already signed in as the owner (this
  // page 302s away for anyone else), so the session cookie alone authorizes
  // DELETE /api/doc (authorizeOwnerMutation in worker.js). Plain same-origin
  // fetch sends the cookie automatically; no Authorization header needed.
  // Confirm copy stays quiet ("This can't be undone.") — no version/comment
  // inventory, no infra jargon, no pre-flight comment fetch.
  async function deleteDoc(slug) {
    const res = await fetch('/api/doc?slug=' + encodeURIComponent(slug), {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      let body = {};
      try { body = await res.json(); } catch {}
      throw new Error(body.error || ('HTTP ' + res.status));
    }
  }
  document.querySelectorAll('.row-delete').forEach((button) => {
    button.addEventListener('click', async () => {
      closeMenus(null);
      const slug = button.dataset.slug;
      const title = button.dataset.title || slug;
      const proceed = await showConfirm({
        title: 'Delete "' + title + '"?',
        body: "This can't be undone.",
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!proceed) return;
      try {
        await deleteDoc(slug);
      } catch {
        toast("Couldn't delete", 'error');
        return;
      }
      button.closest('.doc-row').remove();
      applySearch();
      toast('Deleted');
    });
  });

  // Search + batch select — client-side only over the already-rendered rows.
  // No access data, no extra KV/R2; keep the catalog fast (#115).
  const listEl = document.querySelector('#pane-mine .doc-list');
  if (!listEl) return;
  const search = document.getElementById('doc-search');
  const selectAll = document.getElementById('select-all');
  const selectAllLabel = document.getElementById('select-all-label');
  const batchDelete = document.getElementById('batch-delete');
  const batchMove = document.getElementById('batch-move');
  const noMatch = document.getElementById('no-match');
  const FOLDERS = ${foldersJson};
  let activeFolder = '';

  function visibleRows() {
    return Array.from(listEl.querySelectorAll('.doc-row')).filter((row) => !row.hidden);
  }
  function selectedRows() {
    return Array.from(listEl.querySelectorAll('.doc-row')).filter((row) => {
      const box = row.querySelector('.doc-check');
      return box && box.checked;
    });
  }
  function syncBatchUi() {
    const visible = visibleRows();
    const selected = selectedRows();
    const n = selected.length;
    listEl.classList.toggle('is-selecting', n > 0);
    selected.forEach((row) => row.classList.add('is-selected'));
    listEl.querySelectorAll('.doc-row').forEach((row) => {
      const box = row.querySelector('.doc-check');
      if (!(box && box.checked)) row.classList.remove('is-selected');
    });
    batchDelete.classList.toggle('is-visible', n > 0);
    batchDelete.textContent = n <= 1 ? 'Delete' : ('Delete ' + n);
    batchMove.classList.toggle('is-visible', n > 0);
    batchMove.textContent = n <= 1 ? 'Move' : ('Move ' + n);
    const allVisibleChecked = visible.length > 0 && visible.every((row) => {
      const box = row.querySelector('.doc-check');
      return box && box.checked;
    });
    const someVisibleChecked = visible.some((row) => {
      const box = row.querySelector('.doc-check');
      return box && box.checked;
    });
    selectAll.checked = allVisibleChecked;
    selectAll.indeterminate = someVisibleChecked && !allVisibleChecked;
    selectAllLabel.textContent = allVisibleChecked ? 'Deselect all' : 'Select all';
    selectAll.disabled = visible.length === 0;
    if (!listEl.querySelector('.doc-row')) {
      search.closest('.toolbar').hidden = true;
      selectAll.closest('.batch-bar').hidden = true;
      listEl.insertAdjacentHTML('afterend', '<p class="empty">No published docs yet.</p>');
      listEl.remove();
      if (noMatch) noMatch.hidden = true;
    }
  }
  function applySearch() {
    const q = (search.value || '').trim().toLowerCase();
    const searching = !!q;
    let shown = 0;
    listEl.querySelectorAll('.doc-row').forEach((row) => {
      const hay = ((row.dataset.title || '') + ' ' + (row.dataset.slug || '')).toLowerCase();
      // Browsing shows the current location only; searching goes global,
      // with the "in <folder>" hint on so filed docs are never lost.
      const inLoc = searching || (row.dataset.folder || '') === activeFolder;
      const match = (!q || hay.includes(q)) && inLoc;
      row.hidden = !match;
      const hint = row.querySelector('.loc-hint');
      if (hint) hint.hidden = !searching;
      if (match) shown += 1;
      else {
        const box = row.querySelector('.doc-check');
        if (box) box.checked = false;
      }
    });
    let foldersShown = 0;
    if (folderRowsEl) {
      folderRowsEl.querySelectorAll('.folder-row').forEach((fr) => {
        const vis = !searching && !activeFolder;
        fr.hidden = !vis;
        if (vis) foldersShown += 1;
      });
    }
    if (crumbsEl) {
      crumbsEl.hidden = !activeFolder;
      const cur = FOLDERS.find((f) => f.id === activeFolder);
      if (crumbName) crumbName.textContent = (cur && cur.name) || '';
    }
    if (noMatch) {
      noMatch.textContent = !searching && activeFolder ? 'This folder is empty.' : 'No matches.';
      noMatch.hidden = shown > 0 || (!searching && !activeFolder && foldersShown > 0);
    }
    listEl.hidden = shown === 0;
    syncBatchUi();
  }

  search.addEventListener('input', applySearch);
  listEl.addEventListener('change', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('doc-check')) syncBatchUi();
  });
  selectAll.addEventListener('change', () => {
    const on = selectAll.checked;
    visibleRows().forEach((row) => {
      const box = row.querySelector('.doc-check');
      if (box) box.checked = on;
    });
    syncBatchUi();
  });
  batchDelete.addEventListener('click', async () => {
    const rows = selectedRows();
    if (!rows.length) return;
    const proceed = await showConfirm({
      title: rows.length === 1
        ? ('Delete "' + (rows[0].dataset.title || rows[0].dataset.slug) + '"?')
        : ('Delete ' + rows.length + ' docs?'),
      body: "This can't be undone.",
      confirmLabel: rows.length === 1 ? 'Delete' : ('Delete ' + rows.length),
      danger: true,
    });
    if (!proceed) return;
    batchDelete.disabled = true;
    let ok = 0, failed = 0;
    for (const row of rows) {
      try {
        await deleteDoc(row.dataset.slug);
        row.remove();
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    batchDelete.disabled = false;
    applySearch();
    if (failed && ok) toast("Deleted " + ok + " · couldn't delete " + failed, 'error');
    else if (failed) toast("Couldn't delete", 'error');
    else toast('Deleted');
  });

  // Sort — re-orders the rendered rows off their data attributes; the server
  // default is last-updated-first, matching the select's initial value.
  const sortSel = document.getElementById('doc-sort');
  sortSel.addEventListener('change', () => {
    const key = sortSel.value;
    const all = Array.from(listEl.querySelectorAll('.doc-row'));
    all.sort((a, b) => {
      if (key === 'title') {
        return (a.dataset.title || '').localeCompare(b.dataset.title || '', undefined, { sensitivity: 'base' });
      }
      return (b.dataset[key] || '').localeCompare(a.dataset[key] || '');
    });
    all.forEach((row) => listEl.appendChild(row));
  });

  // Folders are places (Drive-style, one level): folder rows sit above the
  // doc list at the root, clicking one navigates into it (?folder=<id> via
  // pushState), the breadcrumb walks back. Create/rename/delete reload the
  // page (rows and FOLDERS are server-rendered); move updates rows in place.
  const folderRowsEl = document.getElementById('folder-rows');
  const crumbsEl = document.getElementById('crumbs');
  const crumbName = document.getElementById('crumb-name');
  function setFolder(id, push) {
    activeFolder = FOLDERS.some((f) => f.id === id) ? id : '';
    if (push) {
      const url = activeFolder ? '?folder=' + encodeURIComponent(activeFolder) : location.pathname;
      history.pushState({ folder: activeFolder }, '', url);
    }
    applySearch();
  }
  window.addEventListener('popstate', () => {
    setFolder(new URLSearchParams(location.search).get('folder') || '', false);
  });
  if (folderRowsEl) {
    folderRowsEl.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('.row-actions')) return;
      const fr = e.target && e.target.closest ? e.target.closest('.folder-row') : null;
      if (fr) setFolder(fr.dataset.folderId, true);
    });
    folderRowsEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const fr = e.target && e.target.closest ? e.target.closest('.folder-row') : null;
      if (fr) { e.preventDefault(); setFolder(fr.dataset.folderId, true); }
    });
  }
  const crumbRoot = document.getElementById('crumb-root');
  if (crumbRoot) crumbRoot.addEventListener('click', () => setFolder('', true));
  document.getElementById('new-folder').addEventListener('click', async () => {
    const name = await showPrompt({ title: 'New folder', confirmLabel: 'Create', placeholder: 'Folder name' });
    if (!name) return;
    const res = await fetch('/api/folders', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) { toast("Couldn't create folder", 'error'); return; }
    location.reload();
  });
  document.querySelectorAll('.folder-rename').forEach((button) => {
    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeMenus(null);
      const cur = FOLDERS.find((f) => f.id === button.dataset.id);
      const name = await showPrompt({ title: 'Rename folder', confirmLabel: 'Rename', value: cur ? cur.name : '' });
      if (!name) return;
      const res = await fetch('/api/folders', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: button.dataset.id, name }),
      });
      if (!res.ok) { toast("Couldn't rename folder", 'error'); return; }
      location.reload();
    });
  });
  document.querySelectorAll('.folder-delete').forEach((button) => {
    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeMenus(null);
      const proceed = await showConfirm({
        title: 'Delete folder "' + (button.dataset.name || '') + '"?',
        body: 'Docs inside move back to My docs. No documents are deleted.',
        confirmLabel: 'Delete folder',
        danger: true,
      });
      if (!proceed) return;
      const res = await fetch('/api/folders?id=' + encodeURIComponent(button.dataset.id), {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) { toast("Couldn't delete folder", 'error'); return; }
      location.reload();
    });
  });
  document.querySelectorAll('.row-move').forEach((button) => {
    button.addEventListener('click', async () => {
      closeMenus(null);
      const pick = await pickFolder('Move "' + (button.dataset.title || button.dataset.slug) + '" to…');
      if (!pick) return;
      try {
        await moveDocs([button.dataset.slug], pick.folder);
      } catch {
        toast("Couldn't move", 'error');
        return;
      }
      const row = button.closest('.doc-row');
      row.dataset.folder = pick.folder || '';
      setRowHint(row, pick.folder || '');
      applySearch();
      toast('Moved');
    });
  });
  batchMove.addEventListener('click', async () => {
    const rows = selectedRows();
    if (!rows.length) return;
    const pick = await pickFolder(rows.length === 1
      ? ('Move "' + (rows[0].dataset.title || rows[0].dataset.slug) + '" to…')
      : ('Move ' + rows.length + ' docs to…'));
    if (!pick) return;
    batchMove.disabled = true;
    try {
      await moveDocs(rows.map((row) => row.dataset.slug), pick.folder);
    } catch {
      batchMove.disabled = false;
      toast("Couldn't move", 'error');
      return;
    }
    batchMove.disabled = false;
    rows.forEach((row) => {
      row.dataset.folder = pick.folder || '';
      setRowHint(row, pick.folder || '');
      const box = row.querySelector('.doc-check');
      if (box) box.checked = false;
    });
    applySearch();
    toast('Moved');
  });
  // Keep the search-time location hint honest after an in-place move.
  function setRowHint(row, folderId) {
    let hint = row.querySelector('.loc-hint');
    const f = FOLDERS.find((x) => x.id === folderId);
    if (!f) { if (hint) hint.remove(); return; }
    if (!hint) {
      hint = document.createElement('span');
      hint.className = 'loc-hint';
      hint.hidden = true;
      const meta = row.querySelector('.doc-meta');
      if (meta) meta.appendChild(hint);
    }
    hint.textContent = ' · in ' + f.name;
  }
  // Boot into the location the URL names (?folder=<id>; unknown ids fall
  // back to the root) — this first applySearch also hides filed docs.
  setFolder(new URLSearchParams(location.search).get('folder') || '', false);
  syncBatchUi();
})();
</script>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────
// EVENT-LOG COMMENT MODEL (v0.2)
//
// Each comment is stored as { id, author, created_in, created, events: [...] }.
// Events: created, text_edited, anchor_changed, marked_applied, deleted,
//   reaction_added, reaction_removed, reply_added, reply_text_edited,
//   reply_deleted, reply_reaction_added, reply_reaction_removed.
// Every event carries `at_version` and `at` (ISO timestamp).
//
// THE FUNDAMENTAL RULE: every version is a snapshot. Reading a comment "as
// of version N" folds events with at_version <= N. Mutations NEVER overwrite
// past state — they append a new event. Going back to an older version
// shows the comment exactly as it existed then; going forward shows the
// latest state.
//
// Agent emoji (✅🟡❓) is rendered at fold time from marked_applied events,
// not stored as a reaction record. That way the agent verdict is per-version
// just like any other status.

const AGENT_STATUS_EMOJI = { applied: '✅', partial: '🟡', question: '❓' };

function isFiniteVersion(v) {
  return Number.isFinite(v) && v >= 0;
}

// Build a fresh `created` event from a legacy record. Used in lazy migration.
function legacyToEvents(c) {
  const events = [];
  const at = c.created || new Date().toISOString();
  const v = Number(c.version) || 1;
  events.push({
    kind: 'created', at_version: v, at,
    anchor: c.anchor || null,
    text: c.text || '',
  });
  if (c.status === 'applied') {
    events.push({
      kind: 'marked_applied', at_version: Number(c.applied_in) || v, at,
      applied_in: Number(c.applied_in) || v,
      by: 'tdoc-agent',
      agent_status: 'applied',
    });
  }
  // Reactions become add events stamped at the comment's create version.
  if (c.reactions && typeof c.reactions === 'object') {
    for (const emoji of Object.keys(c.reactions)) {
      const users = c.reactions[emoji] || [];
      for (const login of users) {
        events.push({ kind: 'reaction_added', at_version: v, at, by: login, emoji });
      }
    }
  }
  // Replies become reply_added events. Each carries its own author + text,
  // and reactions are folded into reply_reaction_added events.
  if (Array.isArray(c.replies)) {
    for (const r of c.replies) {
      events.push({
        kind: 'reply_added', at_version: Number(r.version) || v, at: r.created || at,
        reply: {
          id: r.id, author: r.author || null, text: r.text || '',
          agent_status: r.agent_status || null,
        },
      });
      if (r.reactions && typeof r.reactions === 'object') {
        for (const emoji of Object.keys(r.reactions)) {
          for (const login of (r.reactions[emoji] || [])) {
            events.push({
              kind: 'reply_reaction_added', at_version: Number(r.version) || v,
              at: r.created || at, reply_id: r.id, by: login, emoji,
            });
          }
        }
      }
    }
  }
  return events;
}

// Backfill `eid` on any event that lacks one (legacy records, events built by
// object literals that bypassed appendEvent). Idempotent. Mutates in place;
// returns true if anything changed. This guarantees dedupEvents (the
// convergence point) always has an eid to key on.
function backfillEids(events) {
  // Reaction/state kinds whose eid is DETERMINISTIC (no random component). Their
  // eid format changed (kind dropped, at_version added — see eventEid), so
  // events stored under an old-format eid must be RECOMPUTED, not just filled
  // when missing. Recomputing is safe because these eids are pure functions of
  // the event's own fields; one-shot kinds (which embed Math.random) are never
  // recomputed, only backfilled when absent. Kept inside the function so the
  // test harness's per-function VM extraction stays self-contained.
  const DETERMINISTIC_EID_KINDS = new Set([
    'reaction_added', 'reaction_removed',
    'reply_reaction_added', 'reply_reaction_removed',
    'marked_applied', 'marked_open', 'deleted',
  ]);
  let changed = false;
  if (!Array.isArray(events)) return false;
  for (const e of events) {
    if (!e) continue;
    if (!e.eid) { e.eid = eventEid(e); changed = true; continue; }
    // Migrate events whose deterministic eid format has since changed.
    if (DETERMINISTIC_EID_KINDS.has(e.kind)) {
      const want = eventEid(e);
      if (e.eid !== want) { e.eid = want; changed = true; }
    }
  }
  return changed;
}

// If a record doesn't have `events[]`, build one in-place. Returns true if
// the record was migrated OR had eids backfilled (caller may want to persist).
function ensureEventLog(c) {
  if (c && Array.isArray(c.events)) return backfillEids(c.events);
  if (!c || !c.id) return false;
  const events = legacyToEvents(c);
  backfillEids(events);
  c.events = events;
  c.created_in = events[0]?.at_version || Number(c.version) || 1;
  // Author + created are immutable identity, keep them at the top level.
  c.author = c.author || (events[0]?.reply ? events[0].reply.author : null) || null;
  c.created = c.created || events[0]?.at || new Date().toISOString();
  return true;
}

// Fold a comment record into its snapshot AS OF version V.
// Returns the flat shape today's overlay already understands:
//   { id, version, author, created, anchor, text, status, applied_in,
//     replies, reactions, deleted, created_in }
// Returns null if the comment did not yet exist at V.
function snapshotAt(c, V) {
  ensureEventLog(c);
  if (!Array.isArray(c.events) || c.events.length === 0) return null;
  const at = isFiniteVersion(V) ? V : Infinity;
  if (c.created_in != null && c.created_in > at) return null;
  // Default snapshot scaffold.
  const snap = {
    id: c.id,
    author: c.author,
    created: c.created,
    created_in: c.created_in,
    version: c.created_in,
    anchor: null,
    text: '',
    status: 'open',
    applied_in: undefined,
    replies: [],
    reactions: {},
    deleted: false,
  };
  // Reply folds keyed by reply id, in insertion order.
  const replyOrder = [];
  const replyById = new Map();
  // Replay events deduped by eid (convergence under concurrent appends — see
  // dedupEvents) and STABLE-SORTED by at_version. The old code replayed in
  // physical append order assuming it was monotonic in version, but
  // anchor_changed/reconcile can append an event stamped at an OLDER version
  // after a newer one (e.g. re-anchoring while viewing an old version, or a
  // republish reconcile), letting a backdated event wrongly win the latest
  // snapshot. Sorting by at_version with a stable tiebreak (original index)
  // makes the fold order-independent of write order.
  const ordered = dedupEvents(c.events)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => ((a.e.at_version || 0) - (b.e.at_version || 0)) || (a.i - b.i))
    .map(x => x.e);
  for (const e of ordered) {
    if (!e || !isFiniteVersion(e.at_version) || e.at_version > at) continue;
    switch (e.kind) {
      case 'created':
        snap.anchor = e.anchor || null;
        snap.text = e.text || '';
        break;
      case 'text_edited':
        snap.text = e.text || '';
        break;
      case 'anchor_changed':
        snap.anchor = e.anchor || null;
        // Re-anchor resets the agent verdict (matches prior PATCH behavior).
        if (e.reset_status) { snap.status = 'open'; snap.applied_in = undefined; }
        break;
      case 'marked_applied':
        snap.status = 'applied';
        snap.applied_in = e.applied_in || e.at_version;
        snap._agentVerdict = e.agent_status || 'applied';
        snap._agentActor = e.by || 'tdoc-agent';
        break;
      case 'marked_open':
        snap.status = 'open';
        snap.applied_in = undefined;
        snap._agentVerdict = e.agent_status || null;
        snap._agentActor = e.by || 'tdoc-agent';
        break;
      case 'deleted':
        snap.deleted = true;
        break;
      case 'reaction_added': {
        if (!e.emoji || !e.by) break;
        const u = snap.reactions[e.emoji] || [];
        if (!u.includes(e.by)) u.push(e.by);
        snap.reactions[e.emoji] = u;
        break;
      }
      case 'reaction_removed': {
        if (!e.emoji || !e.by) break;
        const u = snap.reactions[e.emoji] || [];
        const idx = u.indexOf(e.by);
        if (idx >= 0) u.splice(idx, 1);
        if (u.length) snap.reactions[e.emoji] = u; else delete snap.reactions[e.emoji];
        break;
      }
      case 'reply_added': {
        if (!e.reply || !e.reply.id) break;
        const r = {
          id: e.reply.id, parent_id: e.reply.parent_id || c.id,
          author: e.reply.author || null,
          text: e.reply.text || '',
          agent_status: e.reply.agent_status || null,
          created: e.at,
          reactions: {},
          deleted: false,
        };
        replyOrder.push(r.id);
        replyById.set(r.id, r);
        break;
      }
      case 'reply_text_edited': {
        const r = replyById.get(e.reply_id);
        if (r) r.text = e.text || '';
        break;
      }
      case 'reply_deleted': {
        const r = replyById.get(e.reply_id);
        if (r) r.deleted = true;
        break;
      }
      case 'reply_reaction_added': {
        const r = replyById.get(e.reply_id);
        if (!r || !e.emoji || !e.by) break;
        const u = r.reactions[e.emoji] || [];
        if (!u.includes(e.by)) u.push(e.by);
        r.reactions[e.emoji] = u;
        break;
      }
      case 'reply_reaction_removed': {
        const r = replyById.get(e.reply_id);
        if (!r || !e.emoji || !e.by) break;
        const u = r.reactions[e.emoji] || [];
        const idx = u.indexOf(e.by);
        if (idx >= 0) u.splice(idx, 1);
        if (u.length) r.reactions[e.emoji] = u; else delete r.reactions[e.emoji];
        break;
      }
    }
  }
  // Apply the agent emoji synthetically so the UI behavior (✅/🟡/❓ on the
  // parent card) matches today without storing it as a real reaction event.
  if (snap._agentVerdict && AGENT_STATUS_EMOJI[snap._agentVerdict]) {
    const emoji = AGENT_STATUS_EMOJI[snap._agentVerdict];
    const actor = snap._agentActor || 'tdoc-agent';
    const u = snap.reactions[emoji] || [];
    if (!u.includes(actor)) u.push(actor);
    snap.reactions[emoji] = u;
  }
  delete snap._agentVerdict;
  snap.replies = replyOrder.map(id => replyById.get(id)).filter(r => r && !r.deleted);
  return snap;
}

// Fold the full list at version V, filter out alive comments only.
// `V = Infinity` (or undefined) = latest snapshot, no version filter.
function snapshotList(list, V) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    const s = snapshotAt(c, V);
    if (s && !s.deleted) out.push(s);
  }
  return out;
}

// Fold EVERY comment that ever existed across ALL versions, regardless of the
// version it was created in. This is the durable, lossless view used by
// `tdoc-pull` so that pulling never drops comments anchored to an older
// version (snapshotList at latest would hide a comment created on v3 once the
// doc is on v5). Each comment is folded at Infinity (its richest state).
// Deleted comments are still excluded — a delete is an intentional removal,
// not version scoping.
function historyList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    const s = snapshotAt(c, Infinity);
    if (s && !s.deleted) out.push(s);
  }
  return out;
}

// Helper used by all mutating endpoints: ensure the list is migrated to the
// event-log shape before we touch it. Returns the (possibly mutated) list.
function ensureMigrated(list) {
  let dirty = false;
  for (const c of list) {
    if (ensureEventLog(c)) dirty = true;
  }
  return dirty;
}

// Append an event to a comment record (auto-creates events[] if missing).
// Stamp a stable event id so the log converges under concurrent appends.
// Cloudflare KV has no atomic compare-and-set (the only true serialization is
// a Durable Object — tracked separately), so two writers can each read, append,
// and write, with last-write-wins clobbering one append. We make that tolerable
// instead of corrupting: every event carries an `eid`, and the fold dedups by
// it (see dedupEvents). Some events are *naturally idempotent* and get a
// DETERMINISTIC eid so a concurrent duplicate collapses to one:
//   reaction add/remove → reaction:<emoji>:<by>:<at_version>      (toggle converges)
//   reply reaction      → rreaction:<reply_id>:<emoji>:<by>:<at_version>
//   marked_applied/marked_open  → status:<at_version>       (state, not history)
//   deleted                     → deleted:<at_version>      (terminal, not a toggle)
// One-shot events (created, reply_added, text_edited, anchor_changed) get a
// unique eid so each is preserved.
//
// Reaction eids deliberately DROP the add-vs-remove kind and INCLUDE at_version:
//   - dropping kind makes a toggle converge: [add, remove, add] collapses to one
//     slot whose LAST event (add) wins, instead of add and remove living in two
//     independent slots that fold to a stale "removed" (the add→remove→add
//     data-loss bug).
//   - including at_version keeps each version's reaction independent, so a
//     reaction on v1 and a different toggle on v3 don't clobber each other
//     (snapshots stay immutable).
//
// Agent status eids drop the kind for the SAME reason (#229). marked_applied
// and marked_open are a toggle, not two facts: an agent that answers a comment
// with `question`, gets a reply, and then applies it emits [applied, open,
// applied]. Under `<kind>:<at_version>` those landed in two slots, and because
// dedupEvents re-seats each slot at its FIRST occurrence, the newest verdict
// was carried but placed ahead of the older one — so `open` folded last and
// won. The verdict could never converge back to applied within one version,
// and question→applied is the normal progression, so ✅/🟡/❓ lied permanently.
// `deleted` keeps its own slot: it is terminal, not a toggle.
function eventEid(e) {
  switch (e.kind) {
    case 'reaction_added':
    case 'reaction_removed':
      return `reaction:${e.emoji}:${e.by}:${e.at_version}`;
    case 'reply_reaction_added':
    case 'reply_reaction_removed':
      return `rreaction:${e.reply_id}:${e.emoji}:${e.by}:${e.at_version}`;
    case 'marked_applied':
    case 'marked_open':
      return `status:${e.at_version}`;
    case 'deleted':
      return `${e.kind}:${e.at_version}`;
    default:
      return `${e.kind}:${e.at}:${Math.random().toString(36).slice(2, 10)}`;
  }
}
function appendEvent(c, event) {
  if (!Array.isArray(c.events)) c.events = [];
  if (!event.eid) event.eid = eventEid(event);
  c.events.push(event);
}
// Collapse events sharing an eid, keeping the last occurrence (last write wins
// per-event, which is correct for the deterministic-eid state events and
// harmless for unique-eid history events). Returns a new array in original
// order of first appearance. This is the convergence point: merging two
// concurrently-written logs and folding through dedupEvents yields the same
// result regardless of which write landed last.
function dedupEvents(events) {
  if (!Array.isArray(events)) return [];
  const lastByEid = new Map();
  for (const e of events) { if (e && e.eid) lastByEid.set(e.eid, e); }
  const out = [], emitted = new Set();
  for (const e of events) {
    if (!e) continue;
    const id = e.eid;
    if (id == null) { out.push(e); continue; }
    if (emitted.has(id)) continue;
    emitted.add(id);
    out.push(lastByEid.get(id));
  }
  return out;
}

// Permanently collapse each comment's event log to its deduped form. Called at
// publish time so the STORED value stops growing unboundedly toward KV's 25MB
// cap (superseded reaction toggles, duplicate-eid events from concurrent
// writes). This is a no-op for correctness — the read-time fold already dedups
// — it only shrinks what's persisted. Returns true if anything was compacted.
function compactComments(comments) {
  let changed = false;
  if (!Array.isArray(comments)) return false;
  for (const c of comments) {
    if (!c || !Array.isArray(c.events)) continue;
    backfillEids(c.events);
    const compacted = dedupEvents(c.events);
    if (compacted.length !== c.events.length) { c.events = compacted; changed = true; }
  }
  return changed;
}

// Parse the version query param. Returns Infinity when missing/invalid so
// caller gets the latest snapshot (matches pre-versioned behavior). The
// sentinel string 'all' requests the full cross-version history (used by
// tdoc-pull) so callers can opt out of version scoping entirely.
function parseVersionParam(url) {
  const v = url.searchParams.get('version');
  if (v == null || v === '') return Infinity;
  if (v === 'all') return 'all';
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : Infinity;
}

// Coerce a version from a request body to a non-negative integer, defaulting to
// `fallback` (1) for missing/invalid input. Unlike `Number(version) || 1`, this
// preserves a legitimate 0 — matching parseVersionParam's accept rule — so a
// body-driven write can't silently land on the wrong snapshot.
function coerceBodyVersion(version, fallback = 1) {
  const n = Number(version);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Slugs are used as R2/KV key segments and Durable Object names. Constrain them
// to a strict kebab-case allowlist so a request body can't escape the intended
// `docs/<slug>/…` keyspace or inject odd characters into a storage key.
function isValidSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
}

// Object keys that, if accepted as a reaction emoji, would resolve to inherited
// Object.prototype members when used as a reaction bucket key — throwing or
// polluting the fold. Rejected at the /api/reactions boundary.
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'hasOwnProperty', 'toString', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']);

// ---- GitHub helpers ----

async function ghPost(path, formObj) {
  const body = new URLSearchParams(formObj).toString();
  const r = await fetch(`https://github.com${path}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'tdoc-worker',
    },
    body,
  });
  const ct = r.headers.get('content-type') || '';
  const raw = await r.text();
  // GitHub sometimes returns form-encoded even with Accept: application/json
  // (notably the device-flow endpoints). Detect and parse both shapes.
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return { error: 'gh_parse', error_description: raw.slice(0, 200) }; }
  }
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of params) out[k] = v;
  if (!Object.keys(out).length) return { error: 'gh_empty', error_description: `status=${r.status} ct=${ct}` };
  return out;
}
async function ghUser(token) {
  const r = await fetch('https://api.github.com/user', {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'tdoc-worker',
    },
  });
  return r.json();
}

// Constant-time string compare. Hashes both sides with SHA-256 and XOR-folds
// the digests, so it neither short-circuits on the first differing byte nor
// leaks length — removing the (theoretical, network-noise-dominated) timing
// side channel of a raw `===` on the shared secret.
async function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha), vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s || '')));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function requestOrigin(reqOrUrl) {
  if (typeof reqOrUrl === 'string') {
    try { return new URL(reqOrUrl).origin; } catch { return ''; }
  }
  if (reqOrUrl && reqOrUrl.url) {
    try { return new URL(reqOrUrl.url).origin; } catch { return ''; }
  }
  return '';
}

// Explicit 1/true/yes: on (wrangler dev). Explicit 0/false/no: off.
// Unset: only the hosted product hostname (tdoc.dev) — BYOK stays single-owner.
function hostedRegistrationEnabled(env, origin) {
  const v = String((env && (env.TDOC_HOSTED_REGISTRATION || env.TDOC_HOSTED_SIGNUP)) || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return origin === 'https://tdoc.dev';
}

function canSeeMyDocs(env, session, origin) {
  if (!sessionLogin(session)) return false;
  if (hostedRegistrationEnabled(env, origin)) return true;
  return isOwnerSession(env, session);
}

function hostedMaxDocs(env) {
  const n = Number(env && env.TDOC_HOSTED_MAX_DOCS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
}

function hostedMaxUploadBytes(env) {
  const n = Number(env && env.TDOC_HOSTED_MAX_UPLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2 * 1024 * 1024;
}

function utf8ByteLength(s) {
  return new TextEncoder().encode(String(s || '')).byteLength;
}

async function countHostedDocs(env, accountId, stopAt) {
  if (!accountId || !env.META) return 0;
  let n = 0;
  let cursor;
  do {
    const r = await env.META.list({ prefix: 'meta:', cursor });
    for (const k of r.keys || []) {
      let meta = null;
      try {
        const raw = await env.META.get(k.name);
        if (raw) meta = JSON.parse(raw);
      } catch {}
      if (meta && meta.hosted && meta.hosted.account_id === accountId) {
        n++;
        if (stopAt && n >= stopAt) return n;
      }
    }
    cursor = r.cursor;
    if (r.list_complete) break;
  } while (cursor);
  return n;
}

function envFlagTrue(v) {
  const s = String(v || '').toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

// Browser "Duplicate" may write a new slug for a signed-in GitHub user.
// Open that path on the hosted product (tdoc.dev) and when an operator
// explicitly opts in. Self-host / BYOK stays owner-only so a personal
// worker is not a write surface for every GitHub login. CLI hosted
// signup (TDOC_HOSTED_REGISTRATION) remains a separate, closed switch.
function hostedAccountCopiesEnabled(env, req) {
  if (envFlagTrue(env && env.TDOC_ACCOUNT_COPY)) return true;
  if (hostedRegistrationEnabled(env, requestOrigin(req))) return true;
  try {
    const host = new URL(req.url).hostname.toLowerCase();
    return host === 'tdoc.dev' || host.endsWith('.tdoc.dev');
  } catch {
    return false;
  }
}

// `${source}-copy`, `${source}-copy-2`, … clipped to isValidSlug's 64-char cap.
function nextDuplicateSlug(sourceSlug, n) {
  if (!isValidSlug(sourceSlug) || !Number.isInteger(n) || n < 1) return null;
  const suffix = n === 1 ? '-copy' : `-copy-${n}`;
  const maxBase = 64 - suffix.length;
  if (maxBase < 1) return null;
  const base = sourceSlug.slice(0, maxBase).replace(/-+$/g, '');
  if (!base) return null;
  const candidate = `${base}${suffix}`;
  return isValidSlug(candidate) ? candidate : null;
}

async function hostedAccountForGithub(env, login) {
  const norm = normalizeGithubLogin(login);
  if (!norm || !env || !env.META) return null;
  const primary = `hosted-account:${norm}`;
  const legacy = `hosted-github:${norm}`;
  let rec = null;
  try {
    const raw = await env.META.get(primary);
    if (raw) rec = JSON.parse(raw);
  } catch {}
  if (!(rec && typeof rec.account_id === 'string' && rec.account_id)) {
    try {
      const raw = await env.META.get(legacy);
      if (raw) rec = JSON.parse(raw);
    } catch {}
  }
  if (!(rec && typeof rec.account_id === 'string' && rec.account_id)) {
    rec = {
      account_id: `acct_${rand(12)}`,
      github_login: norm,
      created: new Date().toISOString(),
    };
  } else {
    rec = {
      account_id: rec.account_id,
      github_login: norm,
      created: rec.created || new Date().toISOString(),
    };
  }
  await env.META.put(primary, JSON.stringify(rec));
  return rec;
}

async function sourceHasWidgets(env, slug, version) {
  try {
    const r = await env.DOCS.list({ prefix: `docs/${slug}/v${version}/widgets/` });
    return { ok: true, has: Array.isArray(r.objects) && r.objects.length > 0 };
  } catch (e) {
    return { ok: false, response: json({ error: 'doc_bytes_check_failed', message: e.message || String(e) }, { status: 503 }) };
  }
}

async function issueHostedToken(env, body = {}) {
  const github_login = normalizeGithubLogin(body.login);
  if (!github_login) {
    return { error: 'sign_in_required', status: 401 };
  }
  const account = await hostedAccountForGithub(env, github_login);
  if (!account) return { error: 'sign_in_required', status: 401 };
  const token = `tdoc_${rand(24)}`;
  const tokenHash = await sha256Hex(token);
  const record = {
    account_id: account.account_id,
    github_login,
    created: new Date().toISOString(),
  };
  if (typeof body.label === 'string' && body.label.trim()) {
    record.label = body.label.trim().slice(0, 80);
  }
  await env.META.put(`hosted-token:${tokenHash}`, JSON.stringify(record));
  return { token, record };
}

async function hostedTokenActor(env, token) {
  if (!env || !env.META) return null;
  const tokenHash = await sha256Hex(token);
  let record = null;
  try {
    const raw = await env.META.get(`hosted-token:${tokenHash}`);
    if (raw) record = JSON.parse(raw);
  } catch {}
  if (!record || typeof record.account_id !== 'string' || !record.account_id) return null;
  const github_login = normalizeGithubLogin(record.github_login);
  return { kind: 'hosted', account_id: record.account_id, token_hash: tokenHash, github_login };
}

async function hostedOwnerOp(env, slug, op) {
  if (!env.COMMENTS) {
    return { ok: false, status: 503, error: 'hosted_owner_store_unavailable' };
  }
  try {
    const stub = env.COMMENTS.get(env.COMMENTS.idFromName(slug));
    const r = await stub.fetch('https://do/owner', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, op }),
    });
    let body;
    try {
      body = await r.json();
    } catch {
      return { ok: false, status: 503, error: 'hosted_owner_store_unavailable' };
    }
    if (!body || typeof body !== 'object') {
      return { ok: false, status: 503, error: 'hosted_owner_store_unavailable' };
    }
    return body;
  } catch (e) {
    return {
      ok: false,
      status: 503,
      error: 'hosted_owner_store_unavailable',
      message: e.message || String(e),
    };
  }
}

async function docBytesExist(env, slug) {
  try {
    const r = await env.DOCS.list({ prefix: `docs/${slug}/` });
    return { ok: true, exists: Array.isArray(r.objects) && r.objects.length > 0 };
  } catch (e) {
    return { ok: false, response: json({ error: 'doc_bytes_check_failed', message: e.message || String(e) }, { status: 503 }) };
  }
}

// Returns { ok, actor, response }. Admin = the provider-wide TDOC_UPLOAD_TOKEN
// (self-host CLI). Hosted = an account-scoped token minted at /api/hosted/token.
// Hosted success here is identity only — slug ACL is requireDocWriteAccess /
// authorizeOwnerMutation. Do not treat a hosted actor as a global owner.
async function requireUploadAuth(req, env) {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return { ok: false, response: json({ error: 'unauthorized' }, { status: 401 }) };
  const token = m[1];
  if (env.TDOC_UPLOAD_TOKEN && await timingSafeEqual(token, env.TDOC_UPLOAD_TOKEN)) return { ok: true, actor: { kind: 'admin' } };
  const hostedActor = await hostedTokenActor(env, token);
  if (hostedActor) return { ok: true, actor: hostedActor };
  return { ok: false, response: json({ error: 'unauthorized' }, { status: 401 }) };
}

// Slug-scoped write ACL for a hosted account token. Admin actors skip it.
// opts.create: first publish / retry. Does NOT claim an empty slug — the
// upload route claims after validation so a 400 cannot park the slug forever.
async function requireDocWriteAccess(env, actor, slug, opts = {}) {
  const meta = await loadDocMeta(env, slug);
  if (!actor || actor.kind === 'admin') return { ok: true, meta };
  const accountId = meta && meta.hosted && meta.hosted.account_id;
  if (opts.create) {
    if (!meta) {
      const bytes = await docBytesExist(env, slug);
      if (!bytes.ok) return { ok: false, response: bytes.response };
      if (bytes.exists) {
        const verified = await hostedOwnerOp(env, slug, { kind: 'verify_owner', account_id: actor.account_id });
        if (verified.ok) return { ok: true, meta: null };
        // Orphan / other-owner bytes are "slug taken" (409), not "not doc
        // owner" (403). Preserve DO/store failures as 503 so callers fail closed.
        if (
          verified.status === 503
          || verified.error === 'hosted_owner_store_unavailable'
          || verified.error === 'owner_store_conflict'
        ) {
          return {
            ok: false,
            response: json(
              { error: verified.error || 'hosted_owner_store_unavailable' },
              { status: verified.status || 503 },
            ),
          };
        }
        return { ok: false, response: json({ error: 'slug_taken' }, { status: 409 }) };
      }
      return { ok: true, meta: null };
    }
    if (!accountId) return { ok: false, response: json({ error: 'slug_taken' }, { status: 409 }) };
    if (accountId !== actor.account_id) {
      return { ok: false, response: json({ error: 'not_doc_owner' }, { status: 403 }) };
    }
    const verified = await hostedOwnerOp(env, slug, { kind: 'verify_owner', account_id: actor.account_id });
    if (!verified.ok) return { ok: false, response: json({ error: verified.error || 'not_doc_owner' }, { status: verified.status || 403 }) };
    return { ok: true, meta };
  }
  if (!meta) return { ok: false, response: json({ error: 'not_found' }, { status: 404 }) };
  if (!accountId) return { ok: false, response: json({ error: 'slug_taken' }, { status: 409 }) };
  if (accountId !== actor.account_id) return { ok: false, response: json({ error: 'not_doc_owner' }, { status: 403 }) };
  const verified = await hostedOwnerOp(env, slug, { kind: 'verify_owner', account_id: actor.account_id });
  if (!verified.ok) return { ok: false, response: json({ error: verified.error || 'not_doc_owner' }, { status: verified.status || 403 }) };
  return { ok: true, meta };
}

function stampHostedOwnership(meta, actor) {
  if (!actor || actor.kind !== 'hosted') return meta;
  const hosted = {
    ...((meta && meta.hosted && typeof meta.hosted === 'object') ? meta.hosted : {}),
    account_id: actor.account_id,
  };
  if (actor.github_login) hosted.github_login = actor.github_login;
  return {
    ...(meta || {}),
    hosted,
  };
}

// Combined write gate for browser-facing admin routes (DELETE /api/doc,
// PATCH /api/doc/access). One of:
//   - signed in as the doc publisher (hosted.github_login, or TDOC_OWNER on
//     unhosted/legacy docs; CSP makes the cookie path safe);
//   - provider-wide upload token (self-host CLI, global admin);
//   - hosted account token AND requireDocWriteAccess for `slug`.
//
// Hosted tokens are NOT global owners. `slug` must be known before this
// runs whenever a hosted token might be in play. Returns { ok: true, actor,
// session, meta? } or { ok: false, response }.
async function authorizeOwnerMutation(req, env, slug) {
  const session = await getSession(env, req);
  const meta = slug ? await loadDocMeta(env, slug) : null;
  if (isDocOwnerSession(env, session, meta)) return { ok: true, session, actor: { kind: 'owner_session' }, meta };
  const auth = await requireUploadAuth(req, env);
  if (!auth.ok) return { ok: false, response: auth.response };
  if (auth.actor.kind === 'admin') return { ok: true, session: null, actor: auth.actor, meta };
  if (!slug) return { ok: false, response: json({ error: 'slug required' }, { status: 400 }) };
  const writeGate = await requireDocWriteAccess(env, auth.actor, slug);
  if (!writeGate.ok) return writeGate;
  return { ok: true, session: null, actor: auth.actor, meta: writeGate.meta };
}

// ===========================================================================
// #34 — Per-slug write serialization via a Durable Object.
//
// PROBLEM: every comment mutation does get(comments:slug) → JSON.parse → mutate
// → put(comments:slug) on a single KV value with no compare-and-set. Two
// concurrent writers each read the same base, append independently, and the
// second put clobbers the first — a lost update, defeating the append-only log.
//
// FIX (Option A — DO owns the writes): all mutations for one slug run INSIDE a
// single Durable Object instance (idFromName(slug)). Cloudflare guarantees a DO
// processes requests single-threaded, so same-slug get→mutate→put can't
// overlap. The race is impossible by construction — no lock, no watchdog, no
// stuck-lock failure mode.
//
// The mutation LOGIC stays in one shared place: applyCommentOp(list, op, ...).
// Endpoints build a serializable `op` descriptor; the DO replays it atomically.
// A KV fallback (when the DO binding is absent) keeps the worker functional
// before/without the migration — same code path, just not serialized.
// ===========================================================================

// Resolve a comment id that may be a top-level thread OR a reply inside one.
// Nested replies still live on the root thread's event log; parent_id on the
// reply record is the immediate parent (HN/Reddit-style threading).
function findCommentThread(list, id) {
  if (!id || !Array.isArray(list)) return null;
  const top = list.find(c => c && c.id === id);
  if (top) return { root: top, parentId: id, parentIsRoot: true };
  for (const c of list) {
    const ev = (c.events || []).find(e => e.kind === 'reply_added' && e.reply && e.reply.id === id);
    if (ev) return { root: c, parentId: id, parentIsRoot: false };
  }
  return null;
}

function recordAuthor(list, id) {
  if (!id || !Array.isArray(list)) return null;
  const top = list.find(c => c && c.id === id);
  if (top) return top.author || null;
  for (const c of list) {
    const ev = (c.events || []).find(e => e.kind === 'reply_added' && e.reply && e.reply.id === id);
    if (ev) return ev.reply.author || null;
  }
  return null;
}

// Per-user inbox (same host, cross-doc). KV key inbox:<github-login>.
// Rows are aggregated by group_key so a viral doc does not write 40 lines.
const INBOX_MAX = 200;
const INBOX_PAGE = 20;

function inboxKey(login) {
  const n = normalizeGithubLogin(login);
  return n ? `inbox:${n}` : null;
}

function inboxGroupKey(kind, slug, targetId) {
  if (kind === 'comment') return `comment:${slug}`;
  if (kind === 'reply') return `reply:${targetId}`;
  if (kind === 'reaction') return `reaction:${targetId}`;
  return `other:${slug || 'x'}`;
}

function emptyInbox() { return { items: [] }; }

function inboxUnread(inbox) {
  const items = inbox && Array.isArray(inbox.items) ? inbox.items : [];
  return items.filter(i => i && !i.read).length;
}

function applyInboxEvent(inbox, ev) {
  const items = inbox && Array.isArray(inbox.items) ? inbox.items.slice() : [];
  const gk = inboxGroupKey(ev.kind, ev.slug, ev.target_id || ev.comment_id);
  const existing = items.find(i => i && !i.read && i.group_key === gk);
  if (existing) {
    existing.count = (Number(existing.count) || 1) + 1;
    existing.at = ev.at;
    existing.actor = ev.actor || existing.actor;
    existing.comment_id = ev.comment_id || existing.comment_id;
    existing.thread_id = ev.thread_id || existing.thread_id;
    existing.preview = ev.preview != null ? ev.preview : existing.preview;
    if (ev.emoji) existing.emoji = ev.emoji;
    existing.version = ev.version || existing.version;
    const rest = items.filter(i => i !== existing);
    return { items: [existing, ...rest].slice(0, INBOX_MAX) };
  }
  const row = {
    id: ev.id,
    kind: ev.kind,
    group_key: gk,
    slug: ev.slug,
    version: ev.version || 1,
    comment_id: ev.comment_id,
    thread_id: ev.thread_id || ev.comment_id,
    actor: ev.actor || null,
    preview: ev.preview || '',
    title: ev.title || ev.slug,
    at: ev.at,
    read: false,
    count: 1,
    emoji: ev.emoji || null,
  };
  return { items: [row, ...items].slice(0, INBOX_MAX) };
}

function markInboxRead(inbox, { ids, comment_id } = {}) {
  const items = (inbox && Array.isArray(inbox.items) ? inbox.items : []).map((i) => {
    if (!i) return i;
    if (Array.isArray(ids) && ids.includes(i.id)) return { ...i, read: true };
    if (comment_id && i.comment_id === comment_id) return { ...i, read: true };
    return i;
  });
  return { items };
}

function pageInbox(inbox, { offset = 0, limit = INBOX_PAGE } = {}) {
  const items = inbox && Array.isArray(inbox.items) ? inbox.items.filter(Boolean) : [];
  const unread = items.filter(i => !i.read);
  const read = items.filter(i => i.read);
  const ordered = unread.concat(read);
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.min(50, Math.max(1, Number(limit) || INBOX_PAGE));
  return {
    items: ordered.slice(off, off + lim),
    unread: unread.length,
    has_more: off + lim < ordered.length,
  };
}

// Reddit-style: top-level comment → doc owner; reply → direct parent author
// only; reaction → author of that item. Never notify the actor.
function inboxRecipients({ kind, actorLogin, ownerLogin, parentAuthorLogin, targetAuthorLogin }) {
  const actor = sessionLogin({ login: actorLogin });
  const out = [];
  const push = (login) => {
    const n = sessionLogin({ login });
    if (!n || n === actor) return;
    if (!out.includes(n)) out.push(n);
  };
  if (kind === 'comment') push(ownerLogin);
  else if (kind === 'reply') push(parentAuthorLogin);
  else if (kind === 'reaction') push(targetAuthorLogin);
  return out;
}

// Apply one comment operation to the in-memory list. PURE w.r.t. I/O: it only
// mutates `list` and returns { status, body }. Both the DO path and the KV
// fallback call this, so mutation logic is defined exactly once.
//   op = { kind, ... } — see each endpoint for the shape it builds.
function applyCommentOp(list, op) {
  ensureMigrated(list);
  const now = op.at || new Date().toISOString();
  switch (op.kind) {
    case 'create': {
      const entry = {
        id: op.id, author: op.author, created: now, created_in: op.version,
        events: [{ kind: 'created', at_version: op.version, at: now, anchor: op.anchor || null, text: op.text }],
      };
      backfillEids(entry.events);
      list.push(entry);
      return { status: 200, body: snapshotAt(entry, op.version) };
    }
    case 'reply': {
      const thread = findCommentThread(list, op.parent_id);
      if (!thread) return { status: 404, body: { error: 'parent_not_found' } };
      appendEvent(thread.root, { kind: 'reply_added', at_version: op.version, at: now,
        reply: { id: op.reply_id, author: op.author, text: op.text, agent_status: null, parent_id: op.parent_id } });
      return { status: 200, body: { id: op.reply_id, parent_id: op.parent_id, thread_id: thread.root.id, author: op.author, text: op.text, created: now, version: op.version } };
    }
    case 'patch_anchor': {
      // Authorization is enforced UPSTREAM in the worker (canMutate, which needs
      // session+env). The DO/applyCommentOp only serializes the write.
      const target = list.find(c => c.id === op.id);
      if (!target) return { status: 404, body: { error: 'not_found' } };
      appendEvent(target, { kind: 'anchor_changed', at_version: op.version, at: now, reset_status: op.reset_status, anchor: op.anchor, by: op.actor && op.actor.login });
      return { status: 200, body: snapshotAt(target, op.version) };
    }
    case 'react': {
      // The add-vs-remove toggle is computed HERE, inside the serialized write,
      // from the authoritative freshly-read list — NOT upstream. Computing it in
      // the worker would reintroduce the exact toggle race #34 fixes (two
      // concurrent toggles both seeing "not reacted" → double add).
      let host = list.find(c => c.id === op.comment_id);
      let isReply = false, replyId = null;
      if (!host) {
        for (const c of list) {
          const reAdded = (c.events || []).find(e => e.kind === 'reply_added' && e.reply?.id === op.comment_id);
          if (reAdded) { host = c; isReply = true; replyId = op.comment_id; break; }
        }
      }
      if (!host) return { status: 404, body: { error: 'not_found' } };
      const snap = snapshotAt(host, op.version);
      if (!snap) return { status: 404, body: { error: 'not_visible_at_version' } };
      const cur = isReply ? (snap.replies.find(r => r.id === replyId)?.reactions || {}) : snap.reactions;
      const had = (cur[op.emoji] || []).includes(op.by);
      const evt = { at_version: op.version, at: now, emoji: op.emoji, by: op.by };
      if (isReply) { evt.kind = had ? 'reply_reaction_removed' : 'reply_reaction_added'; evt.reply_id = replyId; }
      else { evt.kind = had ? 'reaction_removed' : 'reaction_added'; }
      appendEvent(host, evt);
      const fresh = snapshotAt(host, op.version);
      const reactions = isReply ? (fresh.replies.find(r => r.id === replyId)?.reactions || {}) : fresh.reactions;
      return { status: 200, body: { ok: true, reactions, added: !had } };
    }
    case 'delete': {
      // Authorization enforced upstream (worker resolves target + canMutate
      // before building this op). The DO only serializes the soft-delete write.
      const top = list.find(c => c.id === op.id);
      if (top) {
        appendEvent(top, { kind: 'deleted', at_version: op.version, at: now, by: op.actor.login });
        return { status: 200, body: { ok: true } };
      }
      for (const c of list) {
        ensureEventLog(c);
        const re = (c.events || []).find(e => e.kind === 'reply_added' && e.reply?.id === op.id);
        if (re) {
          appendEvent(c, { kind: 'reply_deleted', at_version: op.version, at: now, reply_id: op.id, by: op.actor.login });
          return { status: 200, body: { ok: true } };
        }
      }
      return { status: 404, body: { error: 'not_found' } };
    }
    case 'raw_events': {
      // pre-built events array to append to a specific comment (agent/reply path)
      const target = list.find(c => c.id === op.id);
      if (!target) return { status: 404, body: { error: 'not_found' } };
      for (const ev of op.events) appendEvent(target, ev);
      return { status: 200, body: op.responseBody || { ok: true } };
    }
    case 'wipe': {
      // Admin: drop ALL comments for the slug. Serialized through the DO so it
      // can't race a concurrent mutation into a nondeterministic final state.
      // Signals the DO to delete the key (handled specially in the DO/fallback).
      return { status: 200, body: { ok: true, deleted: list.length }, __wipe: true };
    }
    case 'publish_merge': {
      // Publish-time: non-destructively merge tdoc-publish's local comments
      // (add by id only if absent — never overwrite/delete worker comments),
      // then reconcile anchors against the new artifact set + compact. Same
      // logic the upload handler used inline; now serialized through the DO.
      let merged = 0;
      if (Array.isArray(op.localComments) && op.localComments.length) {
        const have = new Set(list.map(c => c && c.id).filter(Boolean));
        for (const lc of op.localComments) {
          if (!lc || !lc.id || have.has(lc.id)) continue;
          ensureEventLog(lc);
          list.push(lc);
          have.add(lc.id);
          merged++;
        }
      }
      if (list.length) {
        reconcileAnchors(list, op.aids || [], op.version);
        compactComments(list);
      }
      return { status: 200, body: { mergedComments: merged } };
    }
    default:
      return { status: 400, body: { error: 'unknown_op' } };
  }
}

// Parse a stored comments value defensively. A corrupt KV/DO value (malformed
// JSON, or JSON that isn't an array) must NOT turn every comment operation for
// that slug into a permanent 500 — we log and fall back to an empty list so the
// slug self-heals on the next write. (#33 hardening.)
function safeParseList(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v;
    console.error('[comments] stored value is not an array — treating as empty');
    return [];
  } catch (e) {
    console.error('[comments] corrupt stored value, treating as empty:', e.message);
    return [];
  }
}

// Run a comment mutation for `slug`, serialized per-slug through the DO. Returns
// { status, body }. `op` must be JSON-serializable.
//
// IMPORTANT: the DO stores the comment list in state.storage (input-gated), NOT
// in KV. Cloudflare's input gates only serialize Durable Object STORAGE
// operations — KV reads/writes inside a DO still interleave across concurrent
// requests, which silently loses updates (the bug a KV-based DO had). With
// state.storage the get→mutate→put is gated and concurrent same-slug writes
// serialize correctly.
async function loadInbox(env, login) {
  const key = inboxKey(login);
  if (!key) return { key: null, inbox: emptyInbox() };
  try {
    const raw = await env.META.get(key);
    if (!raw) return { key, inbox: emptyInbox() };
    const parsed = JSON.parse(raw);
    return { key, inbox: parsed && Array.isArray(parsed.items) ? parsed : emptyInbox() };
  } catch {
    return { key, inbox: emptyInbox() };
  }
}

async function deliverInbox(env, recipientLogin, ev) {
  const recips = inboxRecipients({
    kind: ev.kind,
    actorLogin: ev.actor && ev.actor.login,
    ownerLogin: ev.kind === 'comment' ? recipientLogin : '',
    parentAuthorLogin: ev.kind === 'reply' ? recipientLogin : '',
    targetAuthorLogin: ev.kind === 'reaction' ? recipientLogin : '',
  });
  const at = ev.at || new Date().toISOString();
  for (const who of recips) {
    const { key, inbox } = await loadInbox(env, who);
    if (!key) continue;
    const next = applyInboxEvent(inbox, {
      ...ev,
      id: ev.id || `n_${Date.now()}_${rand(4)}`,
      at,
    });
    await env.META.put(key, JSON.stringify(next));
  }
}

async function mutateComments(env, slug, op) {
  if (env.COMMENTS) {
    const stub = env.COMMENTS.get(env.COMMENTS.idFromName(slug));
    const r = await stub.fetch('https://do/mutate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, op }),
    });
    return r.json();
  }
  // Fallback (DO binding absent): direct KV read-modify-write. NOT serialized,
  // but keeps the worker functional without the DO. The DO path is the norm.
  const cKey = `comments:${slug}`;
  const raw = await env.META.get(cKey);
  const list = safeParseList(raw);
  const res = applyCommentOp(list, op);
  if (res.status === 200) {
    if (res.__wipe) await env.META.delete(cKey);
    else await env.META.put(cKey, JSON.stringify(list));
  }
  const { __wipe, ...clean } = res;
  return clean;
}

// Read the comment list for `slug` from the DO (the source of truth). Returns
// the raw list array; callers fold it (snapshotList / historyList). When the DO
// binding is absent, falls back to reading KV directly.
async function readComments(env, slug) {
  if (env.COMMENTS) {
    const stub = env.COMMENTS.get(env.COMMENTS.idFromName(slug));
    const r = await stub.fetch('https://do/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    const out = await r.json();
    return Array.isArray(out.list) ? out.list : [];
  }
  const raw = await env.META.get(`comments:${slug}`);
  return safeParseList(raw);
}

// The Durable Object: single-threaded, input-gated owner of one slug's comment
// list. The list lives in state.storage under key 'list'. On first touch it is
// lazily migrated in from the legacy KV value (comments:<slug>) so existing
// comments are preserved with zero data loss; the KV value is left intact as a
// backstop. All same-slug reads/writes funnel through this one instance.
export class CommentsStore {
  constructor(state, env) { this.state = state; this.env = env; }

  // Resolve the list for `slug` from DO storage INSIDE transaction txn, doing
  // the one-time legacy-KV migration on first touch. DO storage is the SOLE
  // source of truth — there is no KV mirror (Codex P2: a post-commit KV mirror
  // can finish out of order and silently lose a committed update, and was never
  // a reliable fallback). Fails CLOSED on a corrupt stored value rather than
  // silently discarding recoverable data (Codex P2: safeParseList-on-write =
  // silent loss): an absent KV value is a genuinely empty doc ([]); a
  // present-but-corrupt one throws so the write is rejected and the bytes are
  // preserved for recovery.
  async _loadInTxn(txn, slug) {
    const list = await txn.get('list');
    if (list === undefined) {
      const raw = await this.env.META.get(`comments:${slug}`);
      if (raw == null) return [];                 // empty doc, not corruption
      let parsed; try { parsed = JSON.parse(raw); } catch { throw new Error('legacy_kv_corrupt'); }
      if (!Array.isArray(parsed)) throw new Error('legacy_kv_corrupt');
      return parsed;
    }
    if (!Array.isArray(list)) throw new Error('do_storage_corrupt'); // fail closed
    return list;
  }

  async fetch(req) {
    const u = new URL(req.url);
    let payload;
    try { payload = await req.json(); } catch { return Response.json({ list: [] }); }
    const { slug, op } = payload;

    // OWNER: atomic hosted slug ownership claim/verify/release. Lives in the
    // same per-slug Durable Object as comments so first-publish claim is
    // strongly serialized; KV is not the authority. release_owner runs from
    // DELETE /api/doc so a deleted slug can be republished.
    if (u.pathname === '/owner') {
      let out = { ok: false, status: 400, error: 'bad_owner_op' };
      try {
        await this.state.storage.transaction(async (txn) => {
          const current = await txn.get('hostedOwner');
          if (op && op.kind === 'release_owner') {
            await txn.delete('hostedOwner');
            out = { ok: true };
            return;
          }
          const accountId = op && typeof op.account_id === 'string' ? op.account_id : '';
          if (!accountId) {
            out = { ok: false, status: 400, error: 'account_id_required' };
            return;
          }
          if (op.kind === 'claim_owner') {
            if (current === undefined) {
              await txn.put('hostedOwner', accountId);
              out = { ok: true };
            } else if (current === accountId) {
              out = { ok: true };
            } else {
              out = { ok: false, status: 403, error: 'not_doc_owner' };
            }
            return;
          }
          if (op.kind === 'verify_owner') {
            if (current === accountId) out = { ok: true };
            else out = { ok: false, status: 403, error: 'not_doc_owner' };
          }
        });
      } catch (e) {
        return Response.json({ ok: false, status: 409, error: 'owner_store_conflict', message: e.message || String(e) });
      }
      return Response.json(out);
    }

    // READ: resolve inside a transaction so a concurrent first-touch mutation
    // can't commit between a non-transactional get and a write-back (Codex P1:
    // the old _load() seeded KV→DO storage outside any txn, so a read could
    // clobber an already-committed mutation). A first-touch migration is
    // persisted (seeds the canonical store) but only when storage was empty —
    // never an overwrite. On a corrupt value, return [] for DISPLAY only; the
    // stored bytes are left intact.
    if (u.pathname === '/read') {
      let list = [];
      try {
        await this.state.storage.transaction(async (txn) => {
          const empty = (await txn.get('list')) === undefined;
          list = await this._loadInTxn(txn, slug);
          if (empty) await txn.put('list', list);
        });
      } catch { list = []; }
      return Response.json({ list });
    }

    // MUTATE: atomic read-modify-write via state.storage.transaction(). Storage
    // ops inside it are input-gated, so concurrent same-slug mutations
    // serialize. (Prior attempts failed: KV-inside-DO wasn't gated → lost
    // updates; blockConcurrencyWhile around the handler 500'd under load.)
    let out;
    try {
      await this.state.storage.transaction(async (txn) => {
        const list = await this._loadInTxn(txn, slug);
        const res = applyCommentOp(list, op);
        if (res.status === 200) await txn.put('list', res.__wipe ? [] : list);
        out = { res };
      });
    } catch (e) {
      // Corrupt stored value → reject the write, preserve the bytes. 409 so the
      // caller knows it's a recoverable conflict, not a transient 500.
      if (e && /corrupt/.test(e.message || '')) {
        // Mirror the success path's {status, body} shape — the caller reads
        // res.body, so a flat {error} here would reach the client as an empty
        // 409 body and the reason would be silently lost.
        return Response.json({ status: 409, body: { error: 'comments_store_corrupt', message: 'stored comments are corrupt; manual recovery required' } });
      }
      throw e;
    }
    const { __wipe, ...clean } = out.res;
    return Response.json(clean);
  }
}

// Preview Worker (#148): KV has no bucket-level TTL. Cap every META write at
// 14 days when TDOC_PREVIEW=1 so ghost meta cannot outlive the R2 lifecycle.
const PREVIEW_KV_TTL_SECONDS = 14 * 24 * 60 * 60;
function applyPreviewKvTtl(env) {
  if (!env || env.TDOC_PREVIEW !== '1' || !env.META || env.META.__tdocPreviewTtl) return;
  const inner = env.META.put.bind(env.META);
  env.META.put = (key, value, extra) => {
    const opts = extra ? { ...extra } : {};
    if (opts.expirationTtl == null && opts.expiration == null) {
      opts.expirationTtl = PREVIEW_KV_TTL_SECONDS;
    } else if (typeof opts.expirationTtl === 'number') {
      opts.expirationTtl = Math.min(opts.expirationTtl, PREVIEW_KV_TTL_SECONDS);
    }
    return inner(key, value, opts);
  };
  env.META.__tdocPreviewTtl = true;
}

export default {
  async fetch(req, env, ctx) {
    applyPreviewKvTtl(env);
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (p === '/api/ping') return json({ ok: true, service: 'tdoc' });
    if (p === '/api/runtime') return json({ ok: true, runtime: runtimeInfo() });
    if (p === '/tdoc_logo.svg' && method === 'GET') {
      return new Response(TDOC_LOGO_SVG, {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (p === '/tdoc_logo.png' && method === 'GET') {
      const bin = Uint8Array.from(atob(TDOC_LOGO_PNG_B64), (c) => c.charCodeAt(0));
      return new Response(bin, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    // ---- landing (NO public catalog) ----
    // `/` never lists docs. Docs are only reachable via their direct link.
    // The homepage itself is a published tdoc (see landingResponse), falling
    // back to a neutral branded page pointing at the open-source project.
    //
    // `?notice=…` keeps the neutral page. It is a toast for someone we
    // bounced here from /me or an unknown path, and the landing doc has
    // nowhere to show it — losing the message would be worse than losing
    // the marketing page for that one request.
    if (p === '/' && (method === 'GET' || method === 'HEAD')) {
      const notice = (url.searchParams.get('notice') || '').trim();
      if (notice) return html(landingHtml(env, notice));
      return landingResponse(env, req);
    }

    // `/start` is the homepage CTA's no-script destination: the same
    // onboarding written as a page. Same fail-safe as `/` — if that doc is
    // missing, the visitor gets the neutral page, never a 404.
    if (p === '/start' && (method === 'GET' || method === 'HEAD')) {
      return landingResponse(env, req, START_SLUG);
    }

    // `/templates` — the template gallery. Same fail-safe as `/start`: a
    // missing doc yields the neutral landing page, never a 404. No onboarding
    // modal (TEMPLATES_SLUG is intentionally not in the withOnboard gate).
    if (p === '/templates' && (method === 'GET' || method === 'HEAD')) {
      return landingResponse(env, req, TEMPLATES_SLUG);
    }

    // Web OAuth callback. With a `code` this is the redirect flow: exchange it
    // for a token (needs the client secret), mint the same session the device
    // flow does, and 302 the visitor back to the page they started from — one
    // tab, no "Congratulations" dead end. Without a code it's the device-flow
    // soft landing GitHub may bounce to after Approve; keep the friendly page.
    if (p === '/auth/github/callback' && method === 'GET') {
      const code = url.searchParams.get('code');
      if (!code) return html(authDoneHtml());
      const state = url.searchParams.get('state');
      // Anchor to a cookie-pair boundary so a cookie merely ending in
      // "tdoc_oauth" (e.g. "xtdoc_oauth=") can't supply the nonce.
      const cookieNonce = (/(?:^|;\s*)tdoc_oauth=([a-f0-9]+)/.exec(req.headers.get('cookie') || '') || [])[1];
      if (!state || !cookieNonce || state !== cookieNonce) {
        return html(authErrorHtml('Sign-in could not be verified (state mismatch). Please try again.'), { status: 400 });
      }
      if (!env.GITHUB_CLIENT_SECRET) {
        return html(authErrorHtml('Web sign-in is not configured on this host.'), { status: 500 });
      }
      const ret = sanitizeReturn(await env.META.get(`oauthstate:${state}`));
      await env.META.delete(`oauthstate:${state}`);
      try {
        const r = await ghPost('/login/oauth/access_token', {
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${url.origin}/auth/github/callback`,
        });
        if (r.error || !r.access_token) {
          return html(authErrorHtml('GitHub sign-in failed: ' + (r.error_description || r.error || 'no token returned')), { status: 400 });
        }
        const user = await ghUser(r.access_token);
        if (!user.login) return html(authErrorHtml('GitHub returned no account.'), { status: 500 });
        const sid = rand(24);
        const session = {
          login: user.login,
          avatar_url: user.avatar_url,
          name: user.name || user.login,
          created: new Date().toISOString(),
        };
        await env.META.put(`session:${sid}`, JSON.stringify(session), { expirationTtl: 60 * 60 * 24 * 30 });
        return redirectTo(ret, [
          `tdoc_sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
          'tdoc_oauth=; Path=/; Max-Age=0',
        ]);
      } catch (e) {
        return html(authErrorHtml('Sign-in error: ' + e.message), { status: 500 });
      }
    }
    // Static soft landing (device flow, or the OAuth App's callback URL).
    if (p === '/auth/done' && method === 'GET') {
      return html(authDoneHtml());
    }

    // ---- owner catalog ----
    // BYOK (registration off): `/me` lists every doc on THIS worker, but only
    // for TDOC_OWNER. Hosted tdoc.dev (registration on): any signed-in GitHub
    // user sees *their* slugs (meta.hosted.github_login). Everyone else is
    // sent to the landing page (with a toast) — never to github.com, and
    // never a public catalog.
    if (p === '/me' && method === 'GET') {
      const s = await getSession(env, req);
      if (!canSeeMyDocs(env, s, url.origin)) {
        const notice = sessionLogin(s) ? 'me' : 'signin';
        return new Response(null, {
          status: 302,
          headers: { Location: `/?notice=${notice}` },
        });
      }
      const nonce = rand(16);
      const page = await indexHtml(env, s, url.origin, nonce);
      const identity = { login: s.login, avatar_url: s.avatar_url, name: s.name };
      // /me is a PLAIN site page (tdoc-generated content, no author HTML): the
      // shared bar + identity wiring go in via injectSiteChrome, no iframe.
      return html(injectSiteChrome(page, {
        slug: '', version: 0, identity, isOwner: false, canSeeMyDocs: true,
        isCatalog: true, authConfigured: true, webAuth: !!env.GITHUB_CLIENT_SECRET, mode: 'published', versions: [],
      }, nonce), {
        headers: { 'Content-Security-Policy': cspHeader(nonce) },
      });
    }

    // ---- interactive island (sandboxed widget) ----
    // Separate HTML resource so author JS can run without inheriting the host
    // document CSP (srcdoc/blob cannot). Must be Dest=iframe: top-level,
    // embed, and frame loads are 403 so this URL cannot become a same-origin
    // script gadget. Unique origin is also on the widget CSP (sandbox). No overlay.
    const widgetMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/widget\/([^/]+)\/?$/);
    if (widgetMatch && (method === 'GET' || method === 'HEAD')) {
      const [, slug, vStr, name] = widgetMatch;
      if (!isValidSlug(slug) || !isValidWidgetName(name)) {
        return text('invalid slug or widget', { status: 400 });
      }
      const dest = req.headers.get('sec-fetch-dest');
      if (!isWidgetFrameRequest(dest)) {
        return text('widget must be framed', { status: 403 });
      }
      const gate = await enforceDocAccess(env, req, slug, Number(vStr));
      if (!gate.ok) return gate.response;
      const obj = await env.DOCS.get(`docs/${slug}/v${vStr}/widgets/${name}.html`);
      if (!obj) return text(`Not found: ${slug} v${vStr} widget ${name}`, { status: 404 });
      const raw = method === 'HEAD' ? '' : await obj.text();
      return html(raw, {
        headers: {
          'Content-Security-Policy': widgetCspHeader(),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Vary': 'Sec-Fetch-Dest',
        },
      });
    }

    // ---- author document frame (shell mode) ----
    // The author content, isolated in an opaque-origin sandboxed iframe that the
    // shell embeds. Gated on Sec-Fetch-Dest: iframe like widgets, so it can never
    // be loaded top-level — only inside the shell. Access-gated identically to
    // the doc view. Only our nonced probe runs inside; author JS stays inert.
    const frameMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/frame\/?$/);
    if (frameMatch && (method === 'GET' || method === 'HEAD')) {
      const [, slug, vStr] = frameMatch;
      if (!isValidSlug(slug)) return text('invalid slug', { status: 400 });
      if (!isWidgetFrameRequest(req.headers.get('sec-fetch-dest'))) {
        return text('document frame must be framed', { status: 403 });
      }
      const gate = await enforceDocAccess(env, req, slug, Number(vStr));
      if (!gate.ok) return gate.response;
      const obj = await env.DOCS.get(`docs/${slug}/v${vStr}/index.html`);
      if (!obj) return text(`Not found: ${slug} v${vStr}`, { status: 404 });
      const nonce = rand(16);
      let body = '';
      if (method !== 'HEAD') {
        body = forceWidgetSandbox(await obj.text());
        // Legacy template-reliant docs (published before creation-time baking):
        // no #tdoc-reader block AND no styling of their own reading column →
        // inject the reader CSS into the FRAME RESPONSE (never into storage).
        // Self-contained docs are excluded by the max-width check; the template
        // is :where() zero-specificity, so author CSS always wins.
        if (!body.includes('id="tdoc-reader"') && !body.includes('max-width')) {
          const rcss = (typeof READER_CSS === 'string' && READER_CSS.indexOf('__TDOC_') !== 0) ? READER_CSS : '';
          if (rcss) {
            const rtag = `<style id="tdoc-reader">${rcss}</style>`;
            body = /<\/head>/i.test(body) ? body.replace(/<\/head>/i, `${rtag}</head>`) : rtag + body;
          }
        }
        const tag = `<script nonce="${nonce}">${PROBE_JS}</script>`;
        body = body.includes('</body>') ? body.replace('</body>', `${tag}\n</body>`) : body + tag;
      }
      return html(body, {
        headers: {
          'Content-Security-Policy': frameCspHeader(nonce),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Vary': 'Sec-Fetch-Dest',
        },
      });
    }

    // ---- doc view ----
    const docMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/?$/);
    if (docMatch && (method === 'GET' || method === 'HEAD')) {
      const [, slug, vStr] = docMatch;
      const res = await serveDocVersion(env, req, slug, Number(vStr));
      // Google-Docs-style recents: remember the visit — owned or not — for
      // the signed-in viewer's /me Recent tab. Only successful reads count
      // (the access gate already passed), HEAD probes and anonymous readers
      // don't, and the KV write never blocks the response.
      if (res.ok && method === 'GET' && sessionLogin(res.session)) {
        const record = recordDocVisit(env, res.session.login, slug).catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(record);
        else await record;
      }
      return res.response;
    }

    // ---- doc export / fork ----
    // /export → forces a file download (Content-Disposition: attachment) unless
    //           ?download=0. Stamps overlay reader CSS (no bar/comments) so the
    //           file matches the published reading column.
    // /fork   → returns the SAME bundled HTML but boots the overlay in
    //           mode:"fork" (read-only renderable view with comments mirrored
    //           from the embedded JSON). No /api calls, no auth, no publish.
    //
    // Both routes return:
    //   1. A leading agent-readable banner (HTML comment) listing every
    //      comment + reply + reaction grouped by anchor.
    //   2. A <script type="application/json" id="tdoc-fork-comments"> block
    //      with the full comments JSON (so agents can parse it reliably).
    //   3. Inline <!--TDOC-COMMENT id--> markers wrapped around each comment's
    //      anchor text so agents can locate the right region for "apply this
    //      comment" requests.
    const exportMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/(export|fork)\/?$/);
    if (exportMatch && method === 'GET') {
      const [, slug, vStr, kind] = exportMatch;
      const gate = await enforceDocAccess(env, req, slug, Number(vStr));
      if (!gate.ok) return gate.response;
      const obj = await env.DOCS.get(`docs/${slug}/v${vStr}/index.html`);
      if (!obj) return text(`Not found: ${slug} v${vStr}`, { status: 404 });
      let html = await obj.text();

      const rawList = await readComments(env, slug);
      ensureMigrated(rawList);
      // Snapshot the comments AS OF this exported version. snapshotList only
      // ever yields status 'open' or 'applied' (never 'resolved'), so the old
      // `!== 'resolved'` filter here was a no-op. We intentionally export ALL
      // snapshotted comments — including agent-applied ones — so the fork/export
      // carries the full resolution history, not just still-open items.
      const openComments = snapshotList(rawList, Number(vStr));

      // 1. Build the agent-readable banner.
      const reactionsText = (rs) => {
        if (!rs) return '';
        const parts = Object.entries(rs).filter(([, u]) => u && u.length > 0)
          .map(([e, u]) => `${forHtmlComment(e)} (${u.length})`); // escape: a reaction value like '-->' must not break out of the HTML comment
        return parts.length ? `    reactions: ${parts.join(', ')}\n` : '';
      };
      let banner = `<!--
  ===== tdoc fork export =====
  slug: ${forHtmlComment(slug)}
  version: ${forHtmlComment(vStr)}
  exported: ${new Date().toISOString()}

  ## How to use this file
  Save it as ~/tdocs/<your-new-slug>/v1/index.html (or anywhere you like).
  Comments below are read-only metadata bundled with the fork. Agents can
  read them to apply changes — say "apply all comments to this doc" and the
  agent will find the anchored regions (marked with TDOC-COMMENT html
  comments inline below) and modify them accordingly.

  ## Comments included in this export
  ${openComments.length} comment(s).
`;
      for (let i = 0; i < openComments.length; i++) {
        const c = openComments[i];
        const who = c.author?.login ? `@${forHtmlComment(c.author.login)}` : 'anonymous';
        const anchor = c.anchor?.kind === 'element'
          ? `(on ${forHtmlComment(c.anchor.label || c.anchor.selector || 'element')})`
          : c.anchor?.text ? `(on text: "${forHtmlComment(c.anchor.text.replace(/"/g, '\\"').slice(0, 120))}")` : '(no anchor)';
        banner += `\n  [${i + 1}] ${who} ${anchor}\n    "${forHtmlComment(c.text.replace(/\n/g, ' '))}"\n${reactionsText(c.reactions)}`;
        if (Array.isArray(c.replies)) {
          for (const r of c.replies) {
            const rWho = r.author?.login ? `@${forHtmlComment(r.author.login)}` : 'anonymous';
            banner += `      ↳ ${rWho}: "${forHtmlComment(r.text.replace(/\n/g, ' '))}"\n${reactionsText(r.reactions).replace(/^/gm, '  ')}`;
          }
        }
      }
      banner += `\n  ===== end tdoc fork export =====\n-->\n`;

      // 2. Embed structured JSON for programmatic parsing.
      const jsonBlock = `<script type="application/json" id="tdoc-fork-comments">${
        safeJsonForScript({ slug, version: Number(vStr), exported: new Date().toISOString(), comments: openComments })
      }</script>\n`;

      // 3. Inline TDOC-COMMENT markers around anchored text. Done with simple
      //    text replacement; if the same text appears multiple times, we mark
      //    only the first occurrence (matches the live anchor behavior).
      for (const c of openComments) {
        if (c.anchor?.kind !== 'text' && !c.anchor?.text) continue;
        const needle = c.anchor.text;
        if (!needle || needle.length < 2) continue;
        const idx = html.indexOf(needle);
        if (idx === -1) continue;
        const replacement = `<!--TDOC-COMMENT id="${forHtmlComment(c.id)}" by="${forHtmlComment(c.author?.login || 'anonymous')}"-->${needle}<!--/TDOC-COMMENT-->`;
        html = html.slice(0, idx) + replacement + html.slice(idx + needle.length);
      }

      // Both kinds are STATIC now. /fork's interactive overlay mode is retired
      // (dead route — Duplicate is the product feature; agents read the banner
      // + JSON block, which both kinds still carry). Bake the reading-column
      // CSS so the page/file looks like the published doc.
      const nonce = rand(16);
      const bodyHtml = injectReaderCss(html, readerCssSource());

      const finalHtml = banner + jsonBlock + bodyHtml;
      const dl = url.searchParams.get('download');
      // /export defaults to attachment; /fork defaults to inline. Either can be
      // overridden with ?download=1 / ?download=0.
      const defaultAttach = kind === 'export';
      const forceDownload = dl === '1' || (defaultAttach && dl !== '0');
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': cspHeader(nonce) };
      if (forceDownload) headers['Content-Disposition'] = `attachment; filename="${slug}-v${vStr}.html"`;
      return new Response(finalHtml, { status: 200, headers });
    }

    // ---- account duplicate (published reader) ----
    // Content snapshot only: one new slug, v1, no comments, no history, no
    // widget islands. Download stays on /export. This is the hosted "make a
    // copy in my account" path (#146), not a file download.
    if (p === '/api/doc/duplicate' && method === 'POST') {
      const session = await getSession(env, req);
      if (!sessionLogin(session)) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const slug = body && body.slug;
      const version = Number(body && body.version);
      if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      if (!Number.isInteger(version) || version < 1) return json({ error: 'invalid_version' }, { status: 400 });
      const gate = await enforceDocAccess(env, req, slug, version);
      if (!gate.ok) return json({ error: 'access_denied' }, { status: gate.response.status || 403 });
      const ownerCopy = isOwnerSession(env, session);
      if (!ownerCopy && !hostedAccountCopiesEnabled(env, req)) {
        return json({
          error: 'account_copy_unavailable',
          message: 'Account copies on this host are limited to the worker owner. Use Download for an offline HTML file.',
        }, { status: 403 });
      }
      const widgets = await sourceHasWidgets(env, slug, version);
      if (!widgets.ok) return widgets.response;
      if (widgets.has) {
        return json({
          error: 'islands_not_supported',
          message: 'Docs with interactive widgets cannot be duplicated in v1. Use Download for the host HTML.',
        }, { status: 409 });
      }
      const obj = await env.DOCS.get(`docs/${slug}/v${version}/index.html`);
      if (!obj) return json({ error: 'not_found' }, { status: 404 });
      const rawHtml = await obj.text();

      let actor = { kind: 'owner_session' };
      if (!ownerCopy) {
        const acct = await hostedAccountForGithub(env, session.login);
        if (!acct) return json({ error: 'account_copy_unavailable' }, { status: 403 });
        actor = { kind: 'hosted', account_id: acct.account_id, github_login: acct.github_login };
      }
      if (actor.kind === 'hosted') {
        const maxBytes = hostedMaxUploadBytes(env);
        const size = utf8ByteLength(rawHtml);
        if (size > maxBytes) {
          return json({ error: 'quota_upload_bytes', limit: maxBytes, size }, { status: 413 });
        }
        const limit = hostedMaxDocs(env);
        const used = await countHostedDocs(env, actor.account_id, limit);
        if (used >= limit) {
          return json({ error: 'quota_docs', limit, used }, { status: 403 });
        }
      }

      let newSlug = null;
      for (let n = 1; n <= 99; n++) {
        const candidate = nextDuplicateSlug(slug, n);
        if (!candidate) continue;
        const existsMeta = await loadDocMeta(env, candidate);
        if (existsMeta) continue;
        const bytes = await docBytesExist(env, candidate);
        if (!bytes.ok) return bytes.response;
        if (bytes.exists) continue;
        if (actor.kind === 'hosted') {
          const claimed = await hostedOwnerOp(env, candidate, { kind: 'claim_owner', account_id: actor.account_id });
          if (!claimed.ok) {
            if (
              claimed.status === 503
              || claimed.error === 'hosted_owner_store_unavailable'
              || claimed.error === 'owner_store_conflict'
            ) {
              return json({ error: claimed.error || 'hosted_owner_store_unavailable' }, { status: claimed.status || 503 });
            }
            continue;
          }
        }
        newSlug = candidate;
        break;
      }
      if (!newSlug) return json({ error: 'slug_exhausted' }, { status: 409 });

      const now = new Date().toISOString();
      const srcMeta = gate.meta || {};
      const srcTitle = typeof srcMeta.title === 'string' && srcMeta.title.trim() ? srcMeta.title.trim() : slug;
      const title = / \(copy\)$/i.test(srcTitle) ? srcTitle : `${srcTitle} (copy)`;
      let incoming = {
        title,
        slug: newSlug,
        created: now,
        versions: [{ n: 1, created: now, prompt: `Duplicated from ${slug} v${version}` }],
        source: { slug, version },
        duplicated_by: session.login,
        access: normalizeAccess({}, { legacy: false }),
      };
      incoming = stampHostedOwnership(incoming, actor);

      const { html: stampedHtml } = stampAids(rawHtml);
      const r2Key = `docs/${newSlug}/v1/index.html`;
      try {
        await env.DOCS.put(r2Key, stampedHtml, {
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
        });
      } catch (e) {
        return json({ error: 'r2_put_failed', message: e.message }, { status: 500 });
      }
      const verify = await env.DOCS.head(r2Key);
      if (!verify) return json({ error: 'r2_write_lost' }, { status: 500 });
      await env.META.put(`meta:${newSlug}`, JSON.stringify(incoming));
      return json({ ok: true, slug: newSlug, version: 1, url: `/d/${newSlug}/v/1` });
    }

    // ---- auth ----
    if (p === '/api/auth/me' && method === 'GET') {
      const s = await getSession(env, req);
      return json({
        identity: s ? { login: s.login, avatar_url: s.avatar_url, name: s.name } : null,
        isOwner: isOwnerSession(env, s), // worker operator; overlay must not clobber per-doc isOwner
        canSeeMyDocs: canSeeMyDocs(env, s, url.origin),
        authConfigured: true,
      });
    }

    // Web redirect flow, step 1: stash where to land afterwards against a CSRF
    // nonce, then send the browser to GitHub's authorize page. The browser only
    // reaches here when cfg.webAuth is on (secret configured); the guard keeps a
    // stray hit from 500ing.
    if (p === '/api/auth/web/login' && method === 'GET') {
      if (!env.GITHUB_CLIENT_SECRET) return redirectTo('/?notice=signin');
      const ret = sanitizeReturn(url.searchParams.get('return'));
      const nonce = rand(16);
      await env.META.put(`oauthstate:${nonce}`, ret, { expirationTtl: 600 });
      const gh = new URL('https://github.com/login/oauth/authorize');
      gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
      gh.searchParams.set('redirect_uri', `${url.origin}/auth/github/callback`);
      gh.searchParams.set('scope', 'read:user');
      gh.searchParams.set('state', nonce);
      return redirectTo(gh.toString(), [
        `tdoc_oauth=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      ]);
    }

    if (p === '/api/auth/device/start' && method === 'POST') {
      try {
        const r = await ghPost('/login/device/code', {
          client_id: env.GITHUB_CLIENT_ID,
          scope: 'read:user',
        });
        if (r.error) return json({ error: r.error, message: r.error_description }, { status: 400 });
        return json({
          device_code: r.device_code,
          user_code: r.user_code,
          verification_uri: r.verification_uri,
          verification_uri_complete: r.verification_uri_complete || null,
          expires_in: r.expires_in,
          interval: r.interval,
        });
      } catch (e) {
        return json({ error: 'github_unreachable', message: e.message }, { status: 500 });
      }
    }

    if (p === '/api/auth/device/poll' && method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}
      if (!body.device_code) return json({ error: 'device_code required' }, { status: 400 });
      try {
        const r = await ghPost('/login/oauth/access_token', {
          client_id: env.GITHUB_CLIENT_ID,
          device_code: body.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        // Log the response shape (visible in `wrangler tail`) so we can debug
        // the post-approval path that's been hanging on "Waiting…".
        debug(env, '[poll] gh response keys:', Object.keys(r).join(','), 'error:', r.error || 'none', 'has_token:', !!r.access_token);
        // GitHub returns errors *with* a 200 status. Pending states must keep
        // polling; everything else is a real failure surfaced to the user.
        if (r.error === 'authorization_pending' || r.error === 'slow_down') {
          // Pass GitHub's suggested interval back to the client so it can
          // back off when slow_down is signaled (RFC 8628 §3.5).
          return json({ pending: true, error: r.error, interval: Number(r.interval) || null });
        }
        if (r.error) {
          return json({ error: r.error, message: r.error_description || r.error }, { status: 400 });
        }
        if (!r.access_token) return json({ pending: true });
        debug(env, '[poll] got access_token, fetching /user');
        const user = await ghUser(r.access_token);
        debug(env, '[poll] gh /user response keys:', Object.keys(user).join(','), 'login:', user.login || 'none');
        if (!user.login) return json({ error: 'no_user', message: user.message || 'GitHub /user returned no login' }, { status: 500 });
        const sid = rand(24);
        // Store only the identity we actually use. The GitHub access token is
        // intentionally NOT persisted: nothing downstream reads session.token,
        // and keeping a read:user token at rest for 30 days is needless
        // exposure (data minimization).
        const session = {
          login: user.login,
          avatar_url: user.avatar_url,
          name: user.name || user.login,
          created: new Date().toISOString(),
        };
        // 30 day TTL
        await env.META.put(`session:${sid}`, JSON.stringify(session), { expirationTtl: 60 * 60 * 24 * 30 });
        return json(
          { ok: true, identity: { login: user.login, avatar_url: user.avatar_url, name: user.name || user.login } },
          { headers: { 'Set-Cookie': `tdoc_sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}` } }
        );
      } catch (e) {
        return json({ error: 'github_unreachable', message: e.message }, { status: 500 });
      }
    }

    if (p === '/api/auth/logout' && method === 'POST') {
      const sid = parseCookie(req);
      if (sid) await env.META.delete(`session:${sid}`);
      return json({ ok: true }, { headers: { 'Set-Cookie': 'tdoc_sid=; Path=/; Max-Age=0' } });
    }

    // ---- inbox (signed-in, this host, all docs) ----
    if (p === '/api/notifications' && method === 'GET') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      const key = inboxKey(s.login);
      if (!key) return json({ error: 'sign_in_required' }, { status: 401 });
      let inbox = emptyInbox();
      try {
        const raw = await env.META.get(key);
        if (raw) inbox = JSON.parse(raw);
      } catch { inbox = emptyInbox(); }
      const offset = Number(url.searchParams.get('offset') || 0);
      return json(pageInbox(inbox, { offset }));
    }
    if (p === '/api/notifications/unread' && method === 'GET') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      const key = inboxKey(s.login);
      if (!key) return json({ unread: 0 });
      let inbox = emptyInbox();
      try {
        const raw = await env.META.get(key);
        if (raw) inbox = JSON.parse(raw);
      } catch { inbox = emptyInbox(); }
      return json({ unread: inboxUnread(inbox) });
    }
    if (p === '/api/notifications/read' && method === 'POST') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      const key = inboxKey(s.login);
      if (!key) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      let inbox = emptyInbox();
      try {
        const raw = await env.META.get(key);
        if (raw) inbox = JSON.parse(raw);
      } catch { inbox = emptyInbox(); }
      inbox = markInboxRead(inbox, { ids: body.ids, comment_id: body.comment_id });
      await env.META.put(key, JSON.stringify(inbox));
      return json({ ok: true, unread: inboxUnread(inbox) });
    }

    // ---- personal docs state (stars / folders) ----
    // Viewer-scoped, cookie-authorized: stars follow the signed-in reader
    // across any doc they can read; folders organize only their own catalog.
    // No cross-user state is ever touched — each login mutates its own
    // stars:<login> / folders:<login> KV value.
    if (p === '/api/star' && method === 'POST') {
      const s = await getSession(env, req);
      if (!sessionLogin(s)) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const slug = body.slug;
      const starred = !!body.starred;
      if (!slug || !isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      if (starred) {
        // Star only docs that exist here and that this viewer can read —
        // otherwise /api/star is an existence oracle for private slugs.
        const meta = await loadDocMeta(env, slug);
        if (!meta || !docReadableBy(env, s, meta)) return json({ error: 'not_found' }, { status: 404 });
      }
      await setDocStar(env, s.login, slug, starred);
      return json({ ok: true, slug, starred });
    }

    if (p === '/api/folders' && method === 'POST') {
      const s = await getSession(env, req);
      if (!sessionLogin(s)) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const name = validFolderName(body.name);
      if (!name) return json({ error: 'invalid_name' }, { status: 400 });
      const state = await loadFolderState(env, s.login);
      if (state.folders.length >= FOLDERS_MAX) return json({ error: 'too_many_folders' }, { status: 400 });
      if (state.folders.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
        return json({ error: 'duplicate_name' }, { status: 400 });
      }
      const folder = { id: `f_${Date.now()}_${rand(4)}`, name, created: new Date().toISOString() };
      state.folders.push(folder);
      await saveFolderState(env, s.login, state);
      return json({ ok: true, folder: { id: folder.id, name: folder.name } });
    }

    if (p === '/api/folders' && method === 'PATCH') {
      const s = await getSession(env, req);
      if (!sessionLogin(s)) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const name = validFolderName(body.name);
      if (!name) return json({ error: 'invalid_name' }, { status: 400 });
      const state = await loadFolderState(env, s.login);
      const folder = state.folders.find((f) => f.id === body.id);
      if (!folder) return json({ error: 'not_found' }, { status: 404 });
      if (state.folders.some((f) => f !== folder && f.name.toLowerCase() === name.toLowerCase())) {
        return json({ error: 'duplicate_name' }, { status: 400 });
      }
      folder.name = name;
      await saveFolderState(env, s.login, state);
      return json({ ok: true, folder: { id: folder.id, name: folder.name } });
    }

    if (p === '/api/folders' && method === 'DELETE') {
      const s = await getSession(env, req);
      if (!sessionLogin(s)) return json({ error: 'sign_in_required' }, { status: 401 });
      const id = url.searchParams.get('id');
      const state = await loadFolderState(env, s.login);
      if (!state.folders.some((f) => f.id === id)) return json({ error: 'not_found' }, { status: 404 });
      state.folders = state.folders.filter((f) => f.id !== id);
      // normalizeFolderState in the save path drops the now-orphaned doc
      // mappings, so the docs fall back to the root ("All docs").
      await saveFolderState(env, s.login, state);
      return json({ ok: true });
    }

    if (p === '/api/folders/move' && method === 'POST') {
      const s = await getSession(env, req);
      if (!sessionLogin(s)) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const folderId = body.folder == null ? null : String(body.folder);
      const slugs = Array.isArray(body.slugs) ? body.slugs : [];
      if (!slugs.length || slugs.length > 100 || !slugs.every((x) => typeof x === 'string' && isValidSlug(x))) {
        return json({ error: 'invalid_slugs' }, { status: 400 });
      }
      const state = await loadFolderState(env, s.login);
      if (folderId && !state.folders.some((f) => f.id === folderId)) {
        return json({ error: 'folder_not_found' }, { status: 404 });
      }
      // Folders shelve the viewer's OWN catalog — moving someone else's doc
      // is meaningless here and refused rather than silently recorded.
      for (const slug of slugs) {
        const meta = await loadDocMeta(env, slug);
        if (!meta || !isDocOwnerSession(env, s, meta)) {
          return json({ error: 'not_owner', slug }, { status: 403 });
        }
      }
      for (const slug of slugs) {
        if (folderId) state.docs[slug] = folderId;
        else delete state.docs[slug];
      }
      await saveFolderState(env, s.login, state);
      return json({ ok: true, moved: slugs.length, folder: folderId });
    }

    // ---- hosted publish token bootstrap ----
    // Hosted/OOB users should not create Cloudflare resources or receive the
    // provider-wide TDOC_UPLOAD_TOKEN. The central Worker mints an account-
    // scoped upload token bound to the caller's GitHub login. Same login
    // remints the same account_id so a lost ~/.tdoc/published.json is
    // recoverable. Unset env: on for https://tdoc.dev only; explicit 0 disables.
    if (p === '/api/hosted/token' && method === 'POST') {
      if (!hostedRegistrationEnabled(env, url.origin)) {
        return json({ error: 'hosted_registration_disabled' }, { status: 403 });
      }
      const session = await getSession(env, req);
      const login = sessionLogin(session);
      // Additive `hint` so a stale CLI that just prints the error body still
      // gets an actionable next step. A current CLI ran the device flow and
      // sent a session cookie, so it never lands here; one that hits this
      // without showing a device code is out of date. Fail-open: no new
      // rejection, just a clearer 401.
      if (!login) return json({
        error: 'sign_in_required',
        hint: 'Hosted publish needs a GitHub sign-in. If your tdoc CLI did not show a device code to approve, it is out of date — run: /tdoc update --yes',
      }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const issued = await issueHostedToken(env, { ...body, login });
      if (issued.error) return json({ error: issued.error }, { status: issued.status || 401 });
      return json({
        ok: true,
        token: issued.token,
        account_id: issued.record.account_id,
        github_login: issued.record.github_login,
        base: url.origin,
      });
    }

    // ---- comments ----
    if (p === '/api/comments' && method === 'GET') {
      const slug = url.searchParams.get('slug');
      if (!slug) return json({ error: 'slug required' }, { status: 400 });
      // Same read gate as the HTML routes: private docs don't leak comments.
      const gate = await enforceDocAccess(env, req, slug, parseVersionParam(url) || 1);
      if (!gate.ok) return json({ error: 'access_denied' }, { status: gate.response.status || 403 });
      // Read from the DO (source of truth; it lazily migrates from KV on first
      // touch). Migrate-in-memory for this response only — never persist from a
      // read (writes go through the DO).
      const list = await readComments(env, slug);
      ensureMigrated(list);
      const V = parseVersionParam(url);
      // `?version=all` returns every comment across all versions (lossless,
      // used by tdoc-pull). A numeric/absent version returns that version's
      // snapshot (used by the overlay viewing a specific /v/<n>).
      return json(V === 'all' ? historyList(list) : snapshotList(list, V));
    }

    if (p === '/api/comments' && method === 'POST') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, version, anchor, text: commentText, parent_id } = body;
      if (!slug || !commentText) return json({ error: 'slug and text required' }, { status: 400 });
      if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      {
        const meta = await loadDocMeta(env, slug);
        const access = accessFromMeta(meta || {});
        if (!canReadDoc(access, s, env, meta)) return json({ error: 'access_denied' }, { status: 403 });
        if (!canCommentOnDoc(access, s, env, meta)) return json({ error: 'commenting_disabled' }, { status: 403 });
      }
      const author = { login: s.login, avatar_url: s.avatar_url, name: s.name };
      const created = new Date().toISOString();
      const V = coerceBodyVersion(version);
      // Serialized through the per-slug DO (mutation logic lives once in
      // applyCommentOp). create + reply are both id-stamped here so the
      // response is deterministic regardless of where the write runs.
      const op = parent_id
        ? { kind: 'reply', slug, parent_id, reply_id: `r_${Date.now()}_${rand(4)}`, author, text: commentText, version: V, at: created }
        : { kind: 'create', slug, id: `c_${Date.now()}_${rand(4)}`, author, text: commentText, anchor: anchor || null, version: V, at: created };
      const res = await mutateComments(env, slug, op);
      if (res.status === 200) {
        const meta = await loadDocMeta(env, slug);
        const title = (meta && meta.title) || slug;
        if (!parent_id) {
          await deliverInbox(env, hostedGithubLogin(meta) || env.TDOC_OWNER, {
            kind: 'comment', slug, version: V, comment_id: op.id, thread_id: op.id,
            actor: author, preview: commentText, title, at: created,
          });
        } else {
          const list = await readComments(env, slug);
          const parentA = recordAuthor(list, parent_id);
          await deliverInbox(env, parentA && parentA.login, {
            kind: 'reply', slug, version: V, comment_id: op.reply_id,
            thread_id: res.body && res.body.thread_id, target_id: parent_id,
            actor: author, preview: commentText, title, at: created,
          });
        }
      }
      return json(res.body, { status: res.status });
    }

    // Re-anchor a comment. Only the original author can re-anchor their own
    // comment. Appends an `anchor_changed` event stamped at the current
    // version, so OLDER versions still resolve to the previous anchor.
    if (p === '/api/comments' && method === 'PATCH') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, id, anchor, version } = body;
      if (!slug || !id || !anchor) return json({ error: 'slug, id, anchor required' }, { status: 400 });
      // Auth read (canMutate needs session+env): resolve the target up front.
      // The serialized write then runs through the DO. A target deleted between
      // this check and the write is harmless — applyCommentOp returns 404.
      const authList = await readComments(env, slug);
      ensureMigrated(authList);
      const target = authList.find(c => c.id === id);
      if (!target) return json({ error: 'not_found' }, { status: 404 });
      const meta = await loadDocMeta(env, slug);
      if (!canMutate(target, s, env, meta)) return json({ error: 'not_author' }, { status: 403 });
      const V = coerceBodyVersion(version, target.created_in || 1);
      const res = await mutateComments(env, slug, {
        kind: 'patch_anchor', slug, id, anchor, reset_status: true, version: V, actor: { login: s.login },
      });
      return json(res.body, { status: res.status });
    }

    // Admin: wipe ALL comments for a slug (doc owner only — uses the same
    // upload token as /api/upload, so it can be invoked from the publish
    // tooling or an agent that holds the token). Hosted tokens are
    // slug-scoped via requireDocWriteAccess below; the provider admin
    // token remains global. Triggered by ?all=1 on DELETE /api/comments.
    if (p === '/api/comments' && method === 'DELETE'
        && url.searchParams.get('all') === '1') {
      const auth = await requireUploadAuth(req, env);
      if (!auth.ok) return auth.response;
      const slug = url.searchParams.get('slug');
      if (!slug) return json({ error: 'slug required' }, { status: 400 });
      if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const writeGate = await requireDocWriteAccess(env, auth.actor, slug);
      if (!writeGate.ok) return writeGate.response;
      // Serialized wipe (through the DO) so it can't race a concurrent mutation.
      const res = await mutateComments(env, slug, { kind: 'wipe', slug });
      return json(res.body, { status: res.status });
    }
    // Soft-delete: append a `deleted` event at the current version. The
    // record is preserved; older versions still see the comment as it was.
    // Author-only. ?version=N to stamp the delete at a specific version
    // (defaults to Infinity, meaning "delete forward from now" which the
    // overlay supplies as the current view's version).
    if (p === '/api/comments' && method === 'DELETE') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      const slug = url.searchParams.get('slug');
      const id = url.searchParams.get('id');
      if (!slug || !id) return json({ error: 'slug and id required' }, { status: 400 });
      const V = parseVersionParam(url);
      const stampVersion = Number.isFinite(V) ? V : 999999;  // "forever" if unspecified
      // Auth read up front (canMutate needs session+env): find the target
      // (top-level OR reply) and verify the actor can delete it. The serialized
      // soft-delete write then runs through the DO; a target removed in between
      // is harmless (applyCommentOp returns 404).
      const authList = await readComments(env, slug);
      ensureMigrated(authList);
      const meta = await loadDocMeta(env, slug);
      let authorized = false;
      const top = authList.find(c => c.id === id);
      if (top) {
        if (!canMutate(top, s, env, meta)) return json({ error: 'not_author' }, { status: 403 });
        authorized = true;
      } else {
        for (const c of authList) {
          ensureEventLog(c);
          const reply = (c.events || []).find(e => e.kind === 'reply_added' && e.reply && e.reply.id === id);
          if (reply) {
            if (!canMutate(reply.reply, s, env, meta)) return json({ error: 'not_author' }, { status: 403 });
            authorized = true;
            break;
          }
        }
      }
      if (!authorized) return json({ error: 'not_found' }, { status: 404 });
      const res = await mutateComments(env, slug, {
        kind: 'delete', slug, id, version: stampVersion, actor: { login: s.login },
      });
      return json(res.body, { status: res.status });
    }

    // ---- reactions: toggle emoji on a comment OR reply ----
    // Versioned: appends reaction_added or reaction_removed at the current
    // view's version. ?version=N (or body.version) tags the event so older
    // versions don't see the reaction.
    if (p === '/api/reactions' && method === 'POST') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, comment_id, emoji, version } = body;
      if (!slug || !comment_id || !emoji) return json({ error: 'slug, comment_id, emoji required' }, { status: 400 });
      if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      if (typeof emoji !== 'string' || emoji.length > 8 || emoji.length === 0) return json({ error: 'invalid_emoji' }, { status: 400 });
      // `emoji` is used as an object key in the reaction fold; reject keys that
      // would resolve to Object.prototype members (e.g. `valueOf`, `toString`,
      // `__proto__`) and throw or pollute when read as a reaction bucket.
      if (RESERVED_OBJECT_KEYS.has(emoji)) return json({ error: 'invalid_emoji' }, { status: 400 });
      const V = coerceBodyVersion(version);
      // No upstream read: the toggle (add vs remove) is decided inside the
      // serialized write so concurrent toggles can't both add. Any signed-in
      // user may react, so there's no author check to do here.
      const res = await mutateComments(env, slug, {
        kind: 'react', slug, comment_id, emoji, by: s.login, version: V,
      });
      if (res.status === 200 && res.body && res.body.added) {
        const list = await readComments(env, slug);
        const target = recordAuthor(list, comment_id);
        const thread = findCommentThread(list, comment_id);
        const meta = await loadDocMeta(env, slug);
        await deliverInbox(env, target && target.login, {
          kind: 'reaction', slug, version: V, comment_id,
          thread_id: thread && thread.root && thread.root.id, target_id: comment_id,
          actor: { login: s.login, avatar_url: s.avatar_url, name: s.name },
          title: (meta && meta.title) || slug, emoji,
        });
      }
      return json(res.body, { status: res.status });
    }

    // ---- agent reply (from `tdoc edit` after applying a comment) ----
    // Authenticated with the same upload token as /api/upload — only the doc
    // owner's machine has it, so this can't be spoofed by readers. Posts a
    // reply on the parent comment, attributed to the supplied agent identity
    // with `tdoc-agent` kept as the compatibility fallback.
    // status values: 'applied', 'partial', 'question'. The status appears as
    // a visible badge on the reply and also flips the parent comment's
    // status to 'applied' / 'open' so the dashboard reflects it.
    if (p === '/api/agent/reply' && method === 'POST') {
      const auth = await requireUploadAuth(req, env);
      if (!auth.ok) return auth.response;
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, parent_id, text: replyText, status: agentStatus, applied_in,
              bind_anchor_aid } = body;
      if (!slug || !parent_id || !replyText) return json({ error: 'slug, parent_id, text required' }, { status: 400 });
      if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const writeGate = await requireDocWriteAccess(env, auth.actor, slug);
      if (!writeGate.ok) return writeGate.response;
      // Resolve parent + its current anchor up front (the optional rebind needs
      // the folded anchor for label/fallback). agent/reply is upload-token-authed
      // (owner-only), so concurrency here is negligible; the serialized write
      // still funnels through the DO so it can't clobber a concurrent user write.
      const authList = await readComments(env, slug);
      ensureMigrated(authList);
      const thread = findCommentThread(authList, parent_id);
      if (!thread) return json({ error: 'parent_not_found' }, { status: 404 });
      const parent = thread.root;

      const verdict = ['applied', 'partial', 'question'].includes(agentStatus) ? agentStatus : null;
      const agent = agentIdentity(body, env);
      const V = coerceBodyVersion(applied_in, parent.created_in || 1);
      const now = new Date().toISOString();
      const replyId = `r_${Date.now()}_${rand(4)}`;

      const events = [{
        kind: 'reply_added', at_version: V, at: now,
        reply: { id: replyId, author: agent, text: replyText, agent_status: verdict, parent_id },
      }];
      if (verdict === 'applied') {
        events.push({ kind: 'marked_applied', at_version: V, at: now, applied_in: V, by: agent.login, agent_status: 'applied' });
      } else if (verdict === 'partial' || verdict === 'question') {
        events.push({ kind: 'marked_open', at_version: V, at: now, by: agent.login, agent_status: verdict });
      }
      if (bind_anchor_aid && typeof bind_anchor_aid === 'string') {
        const cur = snapshotAt(parent, V) || {};
        const fallback = cur.anchor?.fallback;
        const label = cur.anchor?.label || 'svg';
        events.push({
          kind: 'anchor_changed', at_version: V, at: now, by: agent.login, reset_status: false,
          anchor: { kind: 'element', aid: bind_anchor_aid, selector: `[data-tdoc-aid="${bind_anchor_aid}"]`, label, ...(fallback ? { fallback } : {}) },
        });
      }
      const res = await mutateComments(env, slug, {
        kind: 'raw_events', slug, id: parent.id, events,
        responseBody: { id: replyId, parent_id, thread_id: parent.id, text: replyText, author: agent, agent_status: verdict, created: now, reactions: {} },
      });
      return json(res.body, { status: res.status });
    }

    // ---- admin upload (from `tdoc publish`) ----
    if (p === '/api/upload' && method === 'POST') {
      const auth = await requireUploadAuth(req, env);
      if (!auth.ok) return auth.response;
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, version, html: doc, meta, comments: localComments } = body;
      if (!slug || !version || !doc) return json({ error: 'slug, version, html required' }, { status: 400 });
      // html must be a string — a non-string doc would throw inside stampAids()
      // and surface as a generic 500 (Codex P3).
      if (typeof doc !== 'string') return json({ error: 'html must be a string' }, { status: 400 });
      // slug + version become R2/KV key segments and the DO name. Validate them
      // (even though this route is upload-token-gated) so a malformed body can't
      // escape the `docs/<slug>/v<N>/` keyspace or build a junk storage key.
      if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const verNum = Number(version);
      if (!Number.isInteger(verNum) || verNum < 1) return json({ error: 'invalid_version' }, { status: 400 });
      const writeGate = await requireDocWriteAccess(env, auth.actor, slug, { create: true });
      if (!writeGate.ok) return writeGate.response;
      if (auth.actor && auth.actor.kind === 'hosted') {
        const maxBytes = hostedMaxUploadBytes(env);
        const size = utf8ByteLength(doc);
        if (size > maxBytes) {
          return json({ error: 'quota_upload_bytes', limit: maxBytes, size }, { status: 413 });
        }
        if (!writeGate.meta) {
          const limit = hostedMaxDocs(env);
          const used = await countHostedDocs(env, auth.actor.account_id, limit);
          if (used >= limit) {
            return json({ error: 'quota_docs', limit, used }, { status: 403 });
          }
        }
      }
      // Validate write-side access policy before writing doc bytes. Read paths
      // stay tolerant for legacy/corrupt stored meta; writes must fail closed.
      // Hosted claim happens AFTER this so a 400 cannot park the slug.
      let incoming = null;
      if (meta || (auth.actor && auth.actor.kind === 'hosted')) {
        incoming = (meta && typeof meta === 'object') ? { ...meta } : {};
        const prev = writeGate.meta;
        if (!incoming.access && prev && prev.access) {
          incoming.access = prev.access;
        }
        if (incoming.access) {
          const validatedAccess = validateAccessWrite(incoming.access);
          if (validatedAccess.error) {
            return json({ error: validatedAccess.error, ...(validatedAccess.field ? { field: validatedAccess.field } : {}), ...(validatedAccess.fields ? { fields: validatedAccess.fields } : {}) }, { status: 400 });
          }
          incoming.access = normalizeAccess(validatedAccess.access, { legacy: false });
        }
        incoming = stampHostedOwnership(incoming, auth.actor);
      }
      if (auth.actor && auth.actor.kind === 'hosted') {
        const claimed = await hostedOwnerOp(env, slug, { kind: 'claim_owner', account_id: auth.actor.account_id });
        if (!claimed.ok) return json({ error: claimed.error || 'owner_claim_failed' }, { status: claimed.status || 409 });
      }
      // Identity-stamp every commentable artifact with a content-hashed
      // data-tdoc-aid. The SAME artifact in a different version has the
      // SAME aid — so a comment anchored by aid resolves identity-first
      // and cannot drift onto a different artifact.
      const { html: stampedHtml, aids } = stampAids(doc);
      const r2Key = `docs/${slug}/v${verNum}/index.html`;
      try {
        await env.DOCS.put(r2Key, stampedHtml, {
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
        });
      } catch (e) {
        console.error('[upload] R2 put failed:', e.message);
        return json({ error: 'r2_put_failed', message: e.message }, { status: 500 });
      }
      // Verify the write actually landed before we tell the caller "ok".
      // The previous handler returned ok: true even when the binding was
      // silently dropping writes — leaving us with KV meta but no R2 doc.
      const verify = await env.DOCS.head(r2Key);
      if (!verify) {
        console.error('[upload] R2 write did not persist:', r2Key);
        return json({ error: 'r2_write_lost', message: 'PUT succeeded but the key is not readable. Re-deploy the worker; the R2 binding may be stale.' }, { status: 500 });
      }
      const widgets = body.widgets;
      if (widgets != null) {
        if (typeof widgets !== 'object' || Array.isArray(widgets)) {
          return json({ error: 'widgets must be an object of name → html' }, { status: 400 });
        }
        const names = Object.keys(widgets);
        if (names.length > 32) return json({ error: 'too many widgets' }, { status: 400 });
        for (const wname of names) {
          if (!isValidWidgetName(wname)) return json({ error: 'invalid_widget_name', name: wname }, { status: 400 });
          const whtml = widgets[wname];
          if (typeof whtml !== 'string') return json({ error: 'widget html must be a string', name: wname }, { status: 400 });
          if (whtml.length > 512 * 1024) return json({ error: 'widget too large', name: wname }, { status: 400 });
          const wKey = `docs/${slug}/v${verNum}/widgets/${wname}.html`;
          try {
            await env.DOCS.put(wKey, whtml, {
              httpMetadata: { contentType: 'text/html; charset=utf-8' },
            });
          } catch (e) {
            console.error('[upload] R2 widget put failed:', e.message);
            return json({ error: 'r2_put_failed', message: e.message }, { status: 500 });
          }
        }
      }
      if (incoming) {
        try {
          await env.META.put(`meta:${slug}`, JSON.stringify(incoming));
        } catch (e) {
          console.error('[upload] META put failed:', e.message);
          return json({ error: 'meta_put_failed', message: e.message || String(e) }, { status: 500 });
        }
      }
      // Reconcile existing open comments against the new artifact set:
      // bind by aid where possible; mark lost where the artifact is gone
      // or ambiguous. This is the ENFORCED publish-time invariant — no
      // agent honesty required, no silent re-anchoring to wrong artifacts.
      let mergedLocal = 0;
      try {
        // #24 dry-run (read-only logging): measure how many live comments anchor
        // to an aid the hardened parser changes vs the legacy parser. >0 on a
        // real doc → that doc needs the aid migration in docs/DESIGN-aid-
        // migration.md. Reads its own copy, never mutates. Empirically 0.
        try {
          const drift = measureAidDrift(doc, await readComments(env, slug));
          if (drift.affectedComments > 0) {
            console.warn(`[aid-drift] slug=${slug} v=${version} changedAids=${drift.changed} affectedComments=${drift.affectedComments} samples=${JSON.stringify(drift.samples)} — these anchors will rebind via reconcile; see docs/DESIGN-aid-migration.md`);
          } else {
            console.log(`[aid-drift] slug=${slug} v=${version} changedAids=${drift.changed} affectedComments=0 (safe)`);
          }
        } catch (e) {
          console.error('[aid-drift] measurement failed (non-fatal):', e.message);
        }

        // Serialized merge + reconcile + compact through the per-slug DO. The
        // merge is non-destructive (add-by-id-if-absent; never overwrite/delete
        // worker comments), mirroring tdoc-pull so round-trips converge.
        const res = await mutateComments(env, slug, {
          kind: 'publish_merge', slug, localComments: localComments || [], aids, version: verNum,
        });
        mergedLocal = (res.body && res.body.mergedComments) || 0;
      } catch (e) {
        console.error('[upload] comment merge/reconcile failed (non-fatal):', e.message);
      }
      return json({ ok: true, url: `/d/${slug}/v/${verNum}`, size: verify.size, aids: aids.length, mergedComments: mergedLocal });
    }

    // ---- admin access mutation ----
    // Remote storage is the source of truth: access policy must be mutable
    // without a local meta.json or full document re-upload. Authorized by
    // authorizeOwnerMutation: the owner's session (browser, doc-page Share
    // panel / /me) OR the upload token (CLI) — see its doc comment for why
    // the session path is safe (CSP blocks author scripts on every response).
    if (p === '/api/doc/access' && method === 'PATCH') {
      // Body is parsed before auth so we can pass slug into the hosted ACL
      // gate. Cap Content-Length first — an access patch is always tiny; do
      // not buffer an arbitrary JSON body for an anonymous caller.
      const ACCESS_PATCH_MAX_BYTES = 16 * 1024;
      const clRaw = req.headers.get('content-length');
      if (clRaw != null && clRaw !== '') {
        const cl = Number(clRaw);
        if (!Number.isFinite(cl) || cl < 0 || cl > ACCESS_PATCH_MAX_BYTES) {
          return json({ error: 'payload_too_large' }, { status: 413 });
        }
      }
      let body = {};
      try { body = await req.json(); } catch {}
      const topKeys = Object.keys(body || {});
      const unknownTop = topKeys.filter((k) => k !== 'slug' && k !== 'access');
      if (unknownTop.length) return json({ error: 'invalid_field', fields: unknownTop }, { status: 400 });
      const { slug, access } = body || {};
      if (!slug) return json({ error: 'slug required' }, { status: 400 });
      if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      // Slug must be known before the hosted ACL check inside the shared gate.
      const auth = await authorizeOwnerMutation(req, env, slug);
      if (!auth.ok) return auth.response;
      const meta = auth.meta || await loadDocMeta(env, slug);
      if (!meta) return json({ error: 'not_found' }, { status: 404 });
      const next = applyAccessPatch(meta, access);
      if (next.error) {
        return json({ error: next.error, ...(next.field ? { field: next.field } : {}), ...(next.fields ? { fields: next.fields } : {}) }, { status: 400 });
      }
      await env.META.put(`meta:${slug}`, JSON.stringify(next.meta));
      return json({ ok: true, slug, access: next.access });
    }

    // ---- admin delete ----
    // Authorized by authorizeOwnerMutation: the owner's session (browser,
    // /me or the doc-page Share panel) OR the upload token (CLI's
    // tdoc-delete) — see its doc comment for why the session path is safe.
    if (p === '/api/doc' && method === 'DELETE') {
      const slug = url.searchParams.get('slug');
      if (!slug) return json({ error: 'slug required' }, { status: 400 });
      if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const auth = await authorizeOwnerMutation(req, env, slug);
      if (!auth.ok) return auth.response;
      // delete all R2 versions
      let cursor;
      do {
        const r = await env.DOCS.list({ prefix: `docs/${slug}/`, cursor });
        for (const o of r.objects) await env.DOCS.delete(o.key);
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      await env.META.delete(`meta:${slug}`);
      // Wipe comments through the DO (the canonical store), not just the KV
      // mirror (Codex P1: deleting only KV left DO storage populated, so
      // delete-then-recreate resurrected old comments). The wipe op clears
      // state.storage; the legacy KV value is removed too as cleanup.
      await mutateComments(env, slug, { kind: 'wipe' });
      await env.META.delete(`comments:${slug}`);
      // Free the hosted slug reservation so the original owner (or anyone)
      // can republish. Data is already gone; do this last. If COMMENTS is
      // absent (Vercel), there was never a hostedOwner key — ignore the 503.
      // If the DO is present and release fails, do not report success: the
      // slug would stay parked while the API lied.
      const released = await hostedOwnerOp(env, slug, { kind: 'release_owner' });
      if (env.COMMENTS && released && released.ok === false) {
        return json(
          { error: released.error || 'owner_release_failed' },
          { status: released.status || 503 },
        );
      }
      return json({ ok: true });
    }

    // Browser navigations to unknown paths bounce to the landing page with a
    // toast — not a raw 404 and never github.com. API-ish methods stay 404.
    if (method === 'GET' || method === 'HEAD') {
      return new Response(null, {
        status: 302,
        headers: { Location: '/?notice=notfound' },
      });
    }
    return text('Not found', { status: 404 });
  },
};
