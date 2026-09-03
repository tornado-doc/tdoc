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

// Cross-origin shell builder is inlined as code. The frame probe remains a
// framework-free string injected only into isolated author frames.
/* __TDOC_SHELL_MODULE__ */
const PROBE_JS = `__TDOC_PROBE_JS__`;
const READER_CSS = `__TDOC_READER_CSS__`;
const SHELL_RUNTIME_JS_PATH = "__TDOC_SHELL_RUNTIME_JS_PATH__";
const SHELL_RUNTIME_JS = `__TDOC_SHELL_RUNTIME_JS__`;
const SHELL_RUNTIME_CSS_PATH = "__TDOC_SHELL_RUNTIME_CSS_PATH__";
const SHELL_RUNTIME_CSS = `__TDOC_SHELL_RUNTIME_CSS__`;
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
  // Compare on the actor key so an email-keyed author can edit their own
  // comment. Case: `who` is stored as written, and actorKey lowercases the
  // email half — so normalize both sides rather than trusting the stored
  // casing, which is how the old raw === comparison quietly disagreed with
  // sessionLogin everywhere else.
  const me = actorKey(session);
  if (!who || !me) return false;
  return String(who).toLowerCase() === String(me).toLowerCase();
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
// A session is "someone" if it carries a GitHub login OR a provider-attested
// email (an OIDC sign-in has no GitHub-shaped login and never will). Gates
// that mean "any authenticated human" use this; gates that specifically need
// a handle (comment authorship, handle ACLs) keep sessionLogin until the
// identity surface widens deliberately.
function sessionPrincipal(session) {
  return sessionLogin(session) || normalizeEmail(session && session.email) || '';
}

// The stable key an identity is recorded under: a GitHub handle stays a bare
// handle (every comment, inbox and allowlist entry ever written uses that
// shape, and none of them are getting rewritten), and an identity with no
// handle takes an `email:` prefix. The prefix is what keeps the two
// namespaces from colliding — a handle can never contain "@", so
// `email:a@b.com` can never be mistaken for a GitHub user, and vice versa.
// normalizeGithubLogin already strips a `github:` prefix, so this is the
// namespacing hook the original author left, finally used.
function actorKey(session) {
  const login = sessionLogin(session);
  if (login) return login;
  const email = normalizeEmail(session && session.email);
  return email ? `email:${email}` : '';
}

// Render an actor key for humans: an email-keyed identity shows its local
// part, never the full address — a comment thread is visible to every reader
// of the doc, and leaking someone's address there is not something they
// opted into by commenting.
function actorDisplayName(session) {
  if (session && session.name) return session.name;
  const login = sessionLogin(session);
  if (login) return login;
  const email = normalizeEmail(session && session.email);
  return email ? email.split('@')[0] : '';
}

function isDocOwnerSession(env, session, meta) {
  // account_id is the canonical identity (phase 1), so compare it first —
  // this is what makes a doc published through an email-keyed account
  // manageable from the browser by the same person, whatever button they
  // signed in with.
  const acct = session && session.account_id;
  const docAcct = meta && meta.hosted && meta.hosted.account_id;
  if (acct && docAcct && acct === docAcct) return true;
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
    const login = normalizeInvitee(item);
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
      const login = normalizeInvitee(item);
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
  const allowed = access.allowed_users || [];
  // Two shapes match, because two shapes get invited: legacy entries are
  // GitHub handles, new ones are email addresses (D2). A session offers
  // whichever of the two it has — and an email-keyed session matches a bare
  // address in the list, not the `email:`-prefixed actor key, because what
  // the doc owner typed into the invite box is an address.
  const login = sessionLogin(session);
  if (login && allowed.includes(login)) return true;
  const email = normalizeEmail(session && session.email);
  return !!(email && allowed.includes(email));
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
  // Was sessionLogin: an OIDC visitor could publish and approve a pairing but
  // could not leave a single comment — the one thing tdoc exists for.
  if (!sessionPrincipal(session)) return false;
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
  if (!sessionPrincipal(session)) {
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
      body: `Signed in as ${actorDisplayName(session)}, but this private document does not include you on the allowlist.`,
      slug, version,
    }),
  };
}
const TDOC_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="201.2 205.2 597.6 597.6" role="img" aria-label="tdoc">
  <!-- The favicon crops to the mark itself. The full logo carries 23% margin,
       which at a 16px tab slot leaves the strokes too thin to separate — they
       washed out to a smudge at 89/255 opacity. Cropped, the same drawing
       reaches 224 at the 32px a retina tab actually renders. -->
  <style>
    /* A tab strip is dark in dark mode and the mark would vanish into it.
       currentColor cannot help here: a favicon has no surrounding text to
       inherit from, so the swap is explicit. */
    path { fill: #0a0a0a; }
    @media (prefers-color-scheme: dark) { path { fill: #f5f5f5; } }
  </style>
  <g transform="translate(0,1000) scale(1,-1)"  fill-rule="evenodd">
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

const TDOC_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="201.2 205.2 597.6 597.6" role="img" aria-label="tdoc">
  <!-- The viewBox is the mark's own bounds plus 6%. It used to be the full
       1000 square, which left 23% margin baked into the file: at the 24px bar
       and the 16px tab slot the drawing was only about half the box and its
       strokes washed out — 108/255 peak ink at 24px against the old mark's
       255. Consumers add their own padding in CSS; the file should not.
       No background field: the ink is currentColor, so an inlined copy
       follows the surrounding text and the page-level dark invert turns it
       white on its own. A solid field would flip to a black box instead. -->
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
const TDOC_LOGO_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAw1klEQVR42u19a1Bj93m+QHckIQQCBAghQFdAiOWyZndJWseu3WzTWXccT5zWH9Lp9EPcNG3Hmc5kMm0n0/aDJ55J07H9NTNtpjupk9l6c2lcj+06G+8utwV0l0ASIInbCiSB0F3o/+Htnv/JOZKQBCwSvO8HRssKIXSe5z3P773W5XI5BhraZbV6/AjQkABoaEgANDQkABoaEgANDQmAhoYEQENDAqChIQHQ0JAAaGhIADS0i2Ms/AjQqtzylqsR3yQe1NfX19XVlfvidVgMh/b0oUxBHR2EuVyujmQlvv7R0VF9fT0SAO3p+eNCmKbirK4OnHRlvzSbzWYymUwmk81ms9lsKpWKxWKHh4cHBwfRaDSRSLDZbKPR2NHRgXcAtNOBMnwF4BJuuAKNQfHQsVgskUikUqlUKpVOp+FrIpEAQEej0YODg3A4vLu7Gw6HAd+xWCwWi8Xj8UQikUgk4vF4KpXKPLF0Og0v3tnZ+dd//dff+ta3ynqfSIALiOZCj8nqojLFDD9+dHSUTqeTyWQymYzH47FYDJAKj6PR6OHh4eHhIWAaYE188+DgAKCcJNnJ//y6uv9D8ve+971vfetbpWshJEBtoDnvZSIjuDJ1kSIZYBfs4IntkwxQDlBOJpPpdDqTyaRSqWQymUgkCE9cGXzJD4ivefVVoTMxk8nM5XIdHR1ms1kikQDPMQpUA6KZEBt5j32l+2kCi+BWQVcAdqMkA2RHnhjxBAB0JpM5OjqqDMSlHFiLY/ok7vjo6CiXywWDQa/XiwR4eqGMQg6pUBCjREBnMpl4PA4+GOQEKAqALHyfcNJwEIzH46Au4EEsFstmsxW7ZJBJpQgq4sH5qgl4zxwOp6WlhYF5gIoDc4WuIuU4WDqUQTGDf00mk6CJCWVMCIxIJLK3tweHPwA9KGzAdCqVOom6oH8lszcvrEHrV8+VyiuTKE/IZDI3b95UKBS5XK5ETci6JMfBQpGNctEMSoNwsXD+C4VChD4mZAYBcfIRMB6PE0ojk8mU9Xcde2zNS+Yit6lzBHGhx8QDyjsn316K/C23bt3613/914sWBi1RLFYc3EilUoBXImpBxCsIsUEYAWUC3xX7ZoruP/Z2VG1Xio7avJ88nGUJO8mvY7PZIpGosbGxsbFRLBY3NTVJJJKmpiY+ny8QCIxG482bN+EoXANh0GO1B/E3lBvfyGazcApMpVKHh4eEVgYnTTyORCKhUGhnZ2drawuC05VF5Sh35EIyo7iArkLHTMcQ+d1Wpo7q6+u5XC6Px+NwOFwul8/n8/n8hoYGoVAoEokEAkFDQ0NDQwMAuqGhQfDE4AlisRieD18L4aosD3gmBCh0TKwsv81gMIgMCAQ3EokEqGfCPRMxjTDJ9vf3iWhdWX9m8dtIKYfgc8dxcViTBUbF7x+gzOfzeU9MIBCIRCIAq1AoFAqFgF0KiJubm0UiEZfLZT6xymK4EPYpSyWeJgEKnaJKfBO5XC4Wi0UiEVDGAGsIRYdCITgObm1tbW1t7e/vE7lA4lB44cVGiV75tAQGk8nk8XgNJCNQKxaLG5+YWCwG7QFPIJwx0OCETpPyVxTicwXHttMkANCOiJEVeg4A+uDgIBgMhkIhcMm7u7vBYHB7e3tnZ2dnZyccDhOJcfDTZxfcOHdM0wGd9/oR77MCjQEqmcVisdlsNpvN4/EI7wtQJnwzoaRFT0woFPJ4PC6Xy+VyQZ9wOJyT+MS8gYfiMZzzuS5lIYOcYU4kEhCTDoVCGxsba2trgUBge3sb/Dd8hTNi6cfEQnePY8V0tZ0CyUqjYt/M+20D0QzYBa/c1NTU1NQECCbEBuGbORwO64mdlsYoKy5ZE1YGAcDxu93uH/7wh7Ozs48fPwag7+/vV5BYySugqwrZhW61oDqKgyPva4LMED4xwvsS0oLikokTIWFMJvO0NMaxEcnaxfSZEAB8/8OHD1955RW/319EYeeNPVdnuINygcs9F7JYLHDMPB6PDFxCY7S2tra0tBDgBplBtgocM919kOMexU8LDLTKCADPicfjU1NTCwsLHA4nm82ePIzwFBR2ZWdEJpNJqOeGhgZCcojFYolE0tLS0vzEIBTd2NgIeqNcD10823pGxz60sjPBR0dHTCbzww8/XFhYYDKZJ0n9nKIaKQTu4rKVzWaDShaJRM3NzWQ0S58YIUWABmXBrpDSKBTVOYmqQXtKBIBr6XQ6y43flwjuQjmX0jP5LBYLIhg8Hq+pqam5uVkikUgkEnjQ0tIilUoB642NjfBMPp8vFApLjNjS31KhHpHT/YjQqoIAcEV7e3vLLZCiBwoIt00cIouDm8PhQKYQnHFzc7NMJuvo6GhrawMog0QhzpFCoZDD4bDZ7BI9a96zbJHkLtolPQPU1dWFw+HR0VGv18tms6HOtkg8AYBevBy3vr5eLBa3tbVJpdLm5mZQ2CBLWlpaJBIJkUqEDGKh7HdxcBc/IyKsGWdW50JxcESDS8XNaOcfBbp9+/Zrr71W1k0AYnlCoVAqlcpksu7ubrlcrlQqOzo6pFKpWCwGtc1isUpX2BQpktdJI7KfDtDpKC+lfKvcip0qygPcvXv3X/7lX9bX15PJJDh4JpMJAUFAeVtbW3Nzc1tbm1wul8lkra2tra2tEokEaj/KzbkUwjfaOXp0qLYvgvJsNgvp/0gk8vjxY7/fv7y8HAgE+Hz+2NjYK6+80tLSUiUcKC8TTLzpcDicSCTgVsBkMiHxfqxEIaR/oUIGtKqCO4GNQp4rmUw+fvx4a2trZ2dnc3MzEAgEAoH19fWdnR1IkkYiEfpPGQyGn/3sZz09PRWM8TlnAoCrLhLoIEcAybWfKEuqXMaQNUxeUO7v7+/u7vp8Pr/fv76+vrq66vF41tbW9vb29vf3i0TGKWWIdXV16XT6T/7kT370ox/VJAGKxNoR3zUE9yL9Q9lsdmdnZ3d3d3193eFwOJ1Oj8fj8Xi2t7djsVjeS095nSJJUkC8VCq1Wq1SqfTchRDrVErP0WrCuwNMKdcunU77fD6AuMvlWllZ8fv9oGryTjoB9U+BeLm1q6XHqXE4Llolwr1Q41EkEtnZ2VlZWXG73W63e2VlBVz77u5u8UknZKxXVqoNX1ksViqV+vznPy+RSGpYAqFVD9yLxGQikQicTV0uF3h3l8vl8/ni8TgjXwVUZUWBRRL8dXV1dML09vb+8pe/1Ol0SAC0CsVMXv1wcHAQCAS8Xq/NZnM4HB6PZ2Njw+/3R6PRvHAnF1NVVrFLrwcpFM5msVgikUgul3/uc5974403+vr6ajIMivY0HTw4zkIt1OFwOBgMrq6uulwuu91utVrdbjcMaDlWyVSGdXKGq8jr8Hi8xsbGjo4OpVKpVCr7+/tVKlV3dzdUZ0GsvCYTYWhPR77njcyEw+HNzU2v12s2m+12++rq6tra2vb2Nl3MkOOYlcGdomGKdP8IBILW1lapVNrd3d3f39/f39/d3d3V1SWXy8ViMZvNZuTLkRXvp0UCoJ5h5HI5v99vt9udTqfdbnc4HD6fLxAIFNHuFQt3yh2mUL0jk8lsb2/v7e1VKpV9fX39/f0KhaK9vb29vb3QKELySxWp/EUCXLr4DMX/ZTKZYDC4trbmcDhcLhcEZ3w+387OTilhmdKvIB2FeeHO4XAkEolMJlMoFD09PSqVSqVS9fT0QLNE3qotSgtEDWX3kQBnm2zKG58Jh8MbGxubm5sWi8VsNjscjuXl5WAwSMciOTJTrnc/NhrDeFKtKJPJOjs7+/r61Gp1X19fb29vX19fS0tLXqyTK3wrGPGEBLjgkoau4LPZ7O7urtfr9Xg8VqvVZDI5nU6/3x+LxRgFckyVRWYocKTXotfV1YnF4s7OTpDsWq1WrVZ3dXV1dXXllTHk2q3a8utIgPMM0USj0Z2dHZfLZbPZwMf7fL7d3V3K4COyFoJXqxjueZVMXV2dRCLp6OjQarUajUatVut0up6eHmgbujAaBglw/pImFAoFAgGHwzE3N2ez2ZaXl9fX1+kO/oR65lgxAx0XarV6aGhIrVYrFIq+vr729nb6iCvK8fQyt3EiARjFmxPokubo6GhjY2NlZcXpdFosFqvVur6+7vP56BWRRHymgtMqGZR5o5BCoVClUqnVanDtKpWqs7Ozs7OTHnyE1jyyX8dSLiRAwbs/3cFDXaTT6YRSAovFEggEHj9+XGgya7kOvpRAZFNTk0wm02q1gHWVSqVUKltbWwUCAXp3JEDlkgYqAihP2NjY8Pl8NpttaWnJ4/GYTKZAIEAfXVqxpCHrGWLCEuO3E0w9PT1KpVKtVkMmFZKp9AG05JsDwh0JUEmUJh6P+3w+r9frcrlMJpPdbl9bW8s7/Q6WL5QraY7VM2w2WyaT9fb29vb26nS6wcFBeIzeHQlwJpUFUFawvLxss9kWFhYWFxdhCDujQJPHSSRNXj0DsciBgQGA+9DQUFdXV3NzM3p3JMAp+Hh6ZUE4HA4EAk6nc3p6GsLwgUCAcmatuISGOFlCCJ8efWexWJ2dnXK5fGBgwGAwwLG1u7uby+UyCuSYEO5IgBOpmlAotLy8bLfbFxcXTSYTSBrK7iPytOqTnFnpiBeJRJBP1Wq1o6OjGo1GLpdLpdIiwRmcDIAEOFGsZm9vz+v1zs/PLy4uWq1Wr9e7vb1N8fGVSRpK6JAuadhstlQq1Wq1BoNBp9Pp9fq+vj6pVEpX8ISkQQePBDipj49EIh6Px263z83NWSwWh8OxtbVF6WGtLEpzbMqpsbERytyHhoYgKNnf39/c3ExPFyDckQCnJuUjkQgRhl9aWoJmVgriIU1LlBVUFqWhSJq6urrm5mYoAB4YGBgeHtZqtUqlkh6RhIBmZVsA0S41AfLuHctkMhsbGxaLZWFhYXZ2dmFhYWtr67RUTRFJw+Fw2traVCrVwMAAIF6lUkmlUkqGleLgUcEjASpHP3nvmMfjWVhYuHfvHoTkw+Hw6aoaeuKJxWLJ5XKFQnHlypXR0VGdTqdWqyUSCYZokABPQ/PU1dWtra3duXPn/v37NpvN7XaTt6BWFqsp7uO5XK5Coejv79fr9ePj4wMDA93d3fR6YEA8OngkwNn6/v/6r/96/fXXNzc3KcLmFBEvEAg6OjqGhoYMBoPBYBgaGurs7BSLxXmPH4h4JMDTQ//KysrVq1dDoRCLxSprmVdxVdPQ0NDf36/RaEZGRgYHB+HYSpndS/AEJc3Z5eMZJYzTrMnRiKf1Ab3//vuA/lK2ZJODoRTQCwSCvr4+rVY7MDBgNBo1Gk1fX9+xiMf9XKXjuPSdn4UcSiGgn+94rHMejbi1tUUMmmQUHkQD2CULGxaLJZPJdDrdyMjIxMTE6OhoV1cXn88vHom/tIgvBN9C66EYxy1LLsWy2SysSU8/sWw2m81mM5kMtBYxGAyFQsHn889xTNC5SaBsNstkMt9///2XXnqJxWJRek/zZqA6Ozt7e3uNRuOVK1egkoxSQHbhc0+F9ornxfSpZCRyuVwsFovH44lEIpFIJJPJeDwei8X29/cPDg7gazQaPTw8jMViiUQCEA9PhmfCf8ErpNNp8jXK5XIGg+HNN998/vnnz4sD50YA+L3ZbPa111778Y9/nFfwyGQyjUYDFTXDw8NKpVImkxWJ1dQc4ikILr7g9SR/YC6XS6fTmUwmHo8DLskWj8cPDw/JmD44OIhEIpFIJBqNAnbj8XgymUwmk+QY3alYQ0PDBx98MDU1dS5a6DyjQED6w8PDt99++7333vP7/UKhcHh4eGBgQK1W6/X63t7e1tbWQlmzqkJ8oTMfGeJ5d2aW+1sIRQGONhQKAWTB0R4+MfLjaDR6cHAQDoej0Sj5x0GTVDb+tsj+47y3o0IwY7FY6XT61VdfvX379qUjABkWmUwmEonweDx6Ddm5+Hj6lTsLmZHL5QiwEpDd39+PRCLwFTwxgW/CYcfj8Wg0GovFUqlU3p6y0q34zsYKDsFlGZPJPDo6unHjxr17985FBZ3zIZgYPclisSAVRYnVFFlQdXaqg4yJ0i/J0dFRJpPJZrOJRILsfeFrNBolkB0Oh8Ph8N7eHiCbrEkqGL1PH9RMbi8+1hNX/BtPcVl6e3v7eU3MPf8FGUSrIfmfJzkUkjeUVRzWyGaz4GgTiUQsFjt4YgBowh8fHh7C9wmHfXh4mEwmQWOAlSUz8qoLYsNuEZdc8Tj/U0dzkZgS8bcQbxXC36+99trp3lhqb0NMXjjSZTRl9x7lp0rxH0dHR+BxwSsDuMPh8C7JQqEQbPkMh8P7+/uxWAwidyfxzUX+QMqDaihPLPTB5lX8RTKYx/4tLS0t3/72t1966SUYUHBJq0HzNs6WuE8c4srJZBIADU6aiGOQoQweGqJ1hOwuK6ZRosw4O8V8EjSXeOs7yc0E7t5gPJLx+Xw+n9/Q0CAQCEQiUVtbm1Qq5fP5MplscnJSoVBc6mI4IifCyLeGFs580Wj08ePHOzs7Ozs7jx8/JmMatAfEN5LJJHwt9xRIAQpFSlUDjo91yUVkUmXrMDgcDpvN5nA4HA6Hy+UKBILGxsbGxkaRSNTY2CgWi+GxUCgUCoUCgUAoFDY0NADK+Xw+m81msVgsFgsesNnsQlf5fDPBVXEH2Nra8ng8oVAoGAzu7u5ubm76/f5gMAjLlsPh8OHhYTqdLqttt9BnenJwnCKa6YqCEkw8FXHP4XBEIhHgknDJ4IwJAzSLRKKGhgbCYcPTANaw1/EkSM37t5z7sozzTITV1dUlEol/+qd/+rd/+zefz1dWAVyJYcpzxHQh0V8xoJlMJrhScLfgdxtIBjhuamoC9wyoBaCDe+bxeFwul8fjnTA3TJmMVJzPVb5a93wIQAxY/vM///Mf/vCHZCmSd9/y04R1oStHEUj0oFNZUAYsAhwbGhpAXYjFYkJaAMoFTwykBXhx0CQgTvKuISoRxMU/1UJMxvHojNMqBProo4+ef/55iIGedTS6iNigRzMYlab0CSkMKkIkEkml0ubm5qampqamJrJoJkwkEvF4vJMEQI592/T2Bqz9PucwKFyt6elpCPVUlpCno7nQdaUQ7FiIE6EMNpvd2NgokUhAHBOeGPw0iI2mpibiCWAgtcuVtnlFfynqApsZao8AcMG6u7vzRgDoF5viqvPuhDsW1qA3wBobG1taWpqfmEQioYQ1CChzuVxQHeU6afoI0bzlQEX8NNoFPwOEQqFr1665XC5iRHORjZxFTCgUgoYGl9zc3AyOmeyeQWwQxuFw8i7AYpS8N6CyQzAaEuC3or+zs7N/9md/Zjab6UWCbDa7oaEBHDMReAZMg0kkEsA6EehobGwsC3YU3X8siBHTZTk43BJZUiR0f3//o48+crlcR0dHEomkra1NIpGA/25oaOA+sRIVCKH1C/U64VnwjCoLySMFyH18JWb0L2kirPQsIHljYSktfGhnOnceLkQRr5ROpysL0V66TDBF99NPveitq3Z5FIPBSCaT+/v7m09sdXV1eXl5eXk5Ho8rFIpXX331tddeg+QJJsLQanidPTj1UCi0tbUFEPd6vT6fb319fWdnBzon877y66+//vbbb2MmGK16vTujQNdRMBjc2Njwer1LS0tmsxnWLDx+/DjvDBvKhhEC8dls9he/+MXNmzch+8nAPADaecGdgCYcTCkueX9/3+PxwBZ7q9Vqt9s3Nze3trbo1bX0bTrEvg8GrdK2vr7earXevHmTgYkwtHOU7/QFC3t7e2tra0tLS1ar1el0rq6uBoNB+n5vygjuQlgvlB7JZrP0xfRIALQz3ydCQXwgEID1rwsLCwsLC6DgDw4O8vps8pGgrDItcsNQfX19Op0WCATPPfdc1Z4BkAAXQcHTER+PxwOBwMrKyvLysslkMplMPp9vZ2eH7rkhDU9sFck7kqzc9SLE0CehUPjWW29pNJrz7XrBQ/DFj0jC7lebzWY2m61Wq9ls3tjYyOvgK9v9mnddWt5XkEqlbW1t3d3dRqPxq1/96sjISNXGQJEAtb3O3u/3OxyO+fl5m80GkqbQ7tdyl3uXuA+TwWA0NjbCehG9Xj80NKRWq3t6ejo6OogsWNX6fiRA1SGe0B70M2symYTgDPh4p9O5sbFBXqpwwt2vdLjnVf8CgaCrq0uj0Wg0Glil093dLZPJ6OPMgDDn3vGIBKj2xBM4SDpKoDfabrebTCaLxeJ0Ojc3NykLo064zr74+lcGgyEWi1tbW/v6+gYHB/V6vUqlUiqVLS0tjY2NjHwlWLU4mRgJcD6pVnpKaHt72+PxmEympaUlt9vtdrvzShpooKtA0hyrZ5hMZldXV3d3d19f39DQECC+p6eHsmaBwpZaH8SNBDifVOvR0dHu7i6ss19aWlpcXFxbW/P5fIWGJpxQ0tAdfH19vVgsVigUarUaVmIODg52dnbS52/TN8BepNIsJMBT2uydy+V2dnaIsgKTyeR0Ond3dymeuLI1mKXs9xYKhaBnYLXCwMCARqNpaWnhcrmXeaM9EuCsAjXpdNrn83k8nkePHoGD93q99GPrSRa/Ep44b6taa2srHFjHx8cHBwd7enp6enroSdlLvvAYCXBqwfhEIuHz+cxmM+yyd7lcGxsbe3t7eVOtBOxOZZ0948nuV9AzRqPRYDDIZLL29nYOh5NXzxD3qEteZ44EqFzV7O/v+/3+xcVF0DNOpzMQCOzv7xeqGyOHSk6o4JlMZmdnp1Kp1Ov1Go0GVmLK5fK88ZnLo2eQAGeramKxmNvtdrlci4uLZrPZ5XJ5PB5KsWTFx9bii185HE5PT49SqdTpdEajkVDweQ+sJ1lCgwRAH///LRqNrq6uWq1Wh8OxtLTkdDrX1tYODw9PjnjyDsy8Il4kEimVSsg3GY1GrVYrl8spSwHhB4+Oji5kfAYJcLbpp7xFwuFwOBAIWK1Wi8VitVpNJpPf76eMUK8s91Rc0jAYDIlEolAohoaGIEpjNBq7urp4PF6RbDHCHQlQno+np5+CweDa2try8vKjR4/MZrPb7V5dXU2n06eI+LyShsFgdHZ2KhQKjUYDkkatViuVSnq6ABU8EuA0i2og/WSz2SwWy8LCgsfj2djYoPT4ETXxp+jj+Xx+R0eHSqWC5d5DQ0NQRVNc0iDikQDllRjQER8Khfx+P3SBmEwmu90eDAZP7uMpp0y6iOfz+W1tbQaD4ZlnnjEYDAMDA21tbWKxGKM0SIAzVzUOh8PlcpnNZrvdvrKysr6+TkH8SdJPRK835X95PJ5KpdLr9bDIvqenp7e3l4548tZXFPFIgFOI1YTDYbfbbbfbbTbbwsKCw+FYXV1lFOj0KzcYXyRQ09TUBHFJnU43PDys0WjoqVb61teqRTx93nBZy9qQAGcl5ek51729PZ/PB1Eas9lsNpu3t7cphZMV+HhyaLJQoEYulw8PDxuNRtho39bWRqmlqRVJc6x0zLvPHAlwPpvzEomE1+tdWVmZmZmZm5tzuVxra2sUEXJyHU9XNW1tbRqNRq1WQ6Cmr6+vp6eHMla6hkR8cemYy+WCweDOzs76+jpMAWKxWBMTEy+//DKfz7+oHKg6AhAf9ObmptPpdLlcn3322ezsrM/ni0ajp6tqKIivq6trbm7W6/UGg2FkZGR4eLi7u7urq6tQoKYmIvFkflJupPv7+z6fz+l0QprP5XLBYkLKZJQXXnjh9u3bEonkQp5YqosAgP5IJPKd73znP//zP4PBIPntVezj4QfzFgm3t7crlcorV66MjIwMDg729/e3t7dTgFJbPr5Io9nBwUEgEJidnZ2enrbZbG63u/ggIHicTqe/+c1v/uAHP6jy7t6aJwC8k2Qy+corr/z85z8nS/myEE8+a9JVTWdnp1arHRwcHBkZ0Wg0KpVKJpNRME0up6n+S15c2LjdbrPZPD8/v7S0tLKy4vV6iyS26Ydg+PPVavX8/LxAILh4QohVVTdrJpN5586dn//85ywWC1B47AQyCkwpOVcmk9ne3q7VamFmgcFg6O3tLaRqCChU4QjL0mdg7e7uulwui8WyuLi4sLCwvLwcDAaLHJZKmQJ08l3FSIBSbXZ2lsjCHntyJa4fmScdHR0QqxkZGRkZGdHr9ZSqSXpFTd629GoTNuSYGBnx29vbq6urFosF6pesVuv29jb5A6kA8cTrs1isVCo1NTUlFAovpASqOgKIxeKjoyNKpIWegSLTAyrjVSrV+Pj4yMiISqXq6OhgFC4Srq+vr3Ifn1fYEO85k8lA/dL09PT9+/dtNpvf72fkazQra7Zh3jRfKpUaGhr6+7//+4t6B6iiMwA4mJmZmampqXQ6TVxvugoSi8UwuWBsbOzq1au9vb2FimpqqO+pSLIvk8ns7OzY7Xar1To/P7+4uLi+vk4ZkVJZTIx8c6DwRCAQSCSSP/iDP/i7v/u7rq4uDIM+vSjQT37ykzfeeGN9fZ1Bam+Vy+VGoxGqDLRaLb3Zj4jV1EqdcPEGS+ign5mZWVhYsFgsbreb0l1ZBLuVNc4LBAKFQjE2NjYxMaHT6Xp7e4niJUyEPW0ObG1t/e///m8oFBKLxXK5HE6ueaOTNVRUUxzx8Xjc5XJZrdbZ2VmTyeRyuYoLm9JjYkU6iZVKpdFoHBsbGx4eVqlU/f39lA4EojSVwcBSiPPenFeLhZNk90w5eCQSia2tLRiR8ujRI7vdvra2RonKV9BBT1nSSP4vNpstk8kGBwcHBgb0ev3g4KBKpWptbS1SvHTha/WqtBaIcvFqC/HEEkU6jf1+v8vlmp+ft1gsZrPZ4/FEIpGTF3RQYmIM0qiIrq6u/v5+g8EAiNfpdJDTxXps7Al+GpWq29vbUKk6Pz8Pi1i2t7eLTDssV9jQa1RlMplKpRoeHp6cnNTr9Wq1unhJNo5FQQKc5szDcDjs8XhgNNDMzAx0nJ2wib54rxnExAYHB0dHR5955pm+vj5KTIxYRIuzgJAAJwJ93gKbVCrl8/lMJtPDhw9NJpPNZtvc3CzUf5N3hFu5hdkgbPR6/fj4uNFoHB0d7ejooMTE0McjAc5wQND6+rrb7bZYLDMzM1ardXl5mVKpSoRrSqwjKB6u4XA4/f39XV1dAwMDIGz6+/tFIlFNx8SQALUUsQmFQjabbXFxcXFxcWlpaW1tbWdn5xSFDQXxLBYLwjVQ0AGF2RQpf9nCNUiAp1pHmUqlVldXoY4SIpWBQIAM0xMinq6FYDA/9JrBriHKGCxEPBLgbMOUGxsbLpfLZDLNz89DhzFlCFy5eajiMUqRSNTf369Wq8fHx69evQoNlhiuQQKcobahhCljsZjP51taWpqfn79///7y8jIlRnmSqDzdzXO53M7OzsHBQYPBMDk5aTAYOjo6yJlXDNcgAU7T8i5p29vbc7lc9+7dm5ubg85XcvL1JMIm7wS41tZWtVo9MTEB5Qb9/f2UsRHkEiaEOxLg9HuLGQzG1tbW0tIS9BY7nU6v10t382UJGzJYKefXhoYGvV4PdXswu7y7uxulPBLgHOxXv/rVnTt3wM1TslHlgr6IsGGxWJ2dnRMTExCY1+v1SqUyb6UqIh4J8PSap775zW++++67FWsbciqKHrGRy+WwiIWI2FAKbIjbQvUvyr3kxrpgfw80Fr/zzjvvvvsuUUoJ3y+lvZgSmCd+RCgUQmPx+Pg4FJZRms5yuRwcOcCqv+MM7QISALK22Wz23//930HkUMY+H1s8THj6+vr69vZ2mNM/OTk5NjamUCjIwoYSsamrq6O0caIhAc7H0ul0KBQq0lMPoAefDV8ZT6bb9vb2joyMXLt27cqVKzqdTiqV5hU2AHp080iAKjvQ1NXlcjkul6tWq91uN5vNhjsAEVMHxJNzUh0dHeDmIUyp1Wopsz7JqShEPB6Ca+AMUF9f/+DBg5s3b1LaxhlPBtwODQ3pdLrBwcHx8fH+/v68xcO4gwgJUNsZgJmZmTfffHN5efno6KipqUmn0+n1eq1WOzw83NXVRfblGJhHAjAuahYsk8lks1mKqsEaG7SLnwgjyxjcvYV2SYvhiHZvvNJoWA5dNnOKf+fkr3kWcbATPhOnQlxqg7PBZS7MJNeJXIYyVSRAQSZA9UQmk0mn06lUKp1OZ7NZ+D7kgOErxcitwIzfbguGHwGDl0qn04lEIplMwosT2QlI1RHGZDLz/hMeUP5J/lnK61CezGKxiK/woFDZ0gUejYjZ+9+6wO+9996dO3c2NjYSiQTANJVKpVKpZDKZSqWyT4zAMQFrCgFKH+R2FlZPM4IqxANWAYP/4nA4PB5PLBZ/7nOf++M//mMej3dhOZBDe+KY/+qv/uopaHS61ZdgdSXYGb3nL37xi7u7u2TCXyRDCcTIZrNMJvPu3bu3bt2CCSh5/XfFH9RT/oRLYULe5+T9JuwIe+ONN956660LuSADS9X/L1dw+/Zt8KOQOyPrnBM6vyq8pR/ls2wBq6+v/+///u9YLAYVhEiAixnxBI2L90NGgQLbY7sp8BBc2wT4yle+8uMf/xiOgJT5JRXI6wp+pALunTVdoQA2lUpdu3ZNJBJdSAmEh+D/kwTZbPYb3/gGugO6jYyMrKyswEeEh+ALHgb9j//4jzt37mxtbVGCNnlj6vTIOjnaCI+JKDtxT6CwDlINxMGDOH7kPYTQY6/0wwmxI4x4kDc4W7xhiMVicblcsVg8Pj7+l3/5l+3t7bgj7DLWQdTE2iXyGy7yoHTVRA7OXvhEGBKAcewsrXIrhUrHHBlVhR6fLxUhCoSlEJe9Eq5KasWqMKWABEBDY2AeAA0NCYCGhgRAQ0MCoKEhAdDQGFgLhMaoikwZMR8Ap1UzMAx64Tt6i8AdJ2UgAS7mosu8cE8mk+FweHV1dW1t7ejoSKfTjYyM4OeGBLiYiy4ZDMbGxobf73c4HHa73ev1rq6uer3eYDAItXFcLvfrX//6m2++yWaz8T6ABKg9N0+pzMnlcn6/H5a6Li0tOZ1On8/n9/sLlbgBDd58882//du/vZj1/UiACy9swuGw2+2GnfWzs7PLy8u7u7uMAmv8KKcCJpOZy+W0Wu38/Dyfz7/AZZ4MjALV9Np6Mi4TicTa2prNZpuenrZYLFar1e/3k5ffkElCWYCQ97ccHBwcHh7y+Xz82JEAVSRsyE0zXq/XZDJZLBaz2Wy32z0eD2VtPWXRZYk9u0wmM51ODw0NtbS0oPtHCXQ+GyzzCpu9vT2v17u4uDg/Pz87O+v1einC5iRLvMm/XSAQ/M///M/169fxDIB3gKctbIivDAYjmUx6PB6Hw7GwsGA2m5eWltbX18mOnKLjS3TzBOgpa//Arl69+s///M/Xr1+H9X54gfAO8FTPr6FQyOFwmEym+/fvm0ymlZWVaDR6wrX1RZZ4M5nMrq4u2Ac1MjLS19c3Pj7O4/HQ9yMBThn0hYRNNBoNBAJLS0uPHj169OiR3W7f3Nws7uZPgngGgyGRSPr6+q5cuXLlypWrV6/29fU1NzczaGvU8KohAU5T2BCWyWR8Pp/T6Zyenl5cXHQ4HKurq4lEgnISPUXEt7S09Pb2Dg8Pj4yMaDQanU4nl8vzLkG75JPfkQBnBfpgMGgymcxm8+zsrM1mW11dDYVC9HHNpc9LpBxeKTFNgUCg1WoHBweNRqPRaFSpVD09PRRYA09wHxQSgHEq68ZgBz2DNCpwbW1tbm5ubm4O3HwgEDh5xIa8s578X0KhUC6XDw8PDw8PG43GgYGBjo4OShSfuDMg6JEAZzIzK5fLOZ3OhYWFBw8ezM7OWq3Wg4OD0xI2lPBOXV2dQqHo7e0dGxsbHx8fGhpSqVQ8Ho+Rb209Ih4JcLb28OHD999//9NPP7VYLGTQlytsKEdeiptvbm4m1ncbDIb+/v62tjYKFWFsESIeCfD0klbf+c533nrrLcLdlhumJEflKT8iFAplMhlI+atXr46MjHR0dJDjM7jBGwnAON+tGe+88843vvENGJJMTOEsZZgU8ASmyZL/F6Ly165dGx0d1Wq1SqWyoaEhr7DBcA0DM8Hn6P6ZTGYmk/nRj34EQCRXnpWi5gkcC4VCvV4/MjIyNjY2ODioVqvb29uLCBtKfAkNCcA4x60Qe3t7eQcSEm6eECrkebodHR0Gg2F8fHx0dHR4eLi7u5vL5RYRNiwWXgUkQFXpwrq6o6MjPp8/OTnpcrk4HA5xB8jr5kUikV6vNxgMY2NjBoNBr9e3tLQUETbo5vEMwKj+2H99fb3D4XjxxRfX19fpDGltbR0YGDAajZOTk0ajUavVUuoLAPR4fkUC1HYGYGVl5Qc/+MHs7Gw0GhWLxSqVCuSNXq+nqHlCCAETEPRIgAuVBctkMiwWiwJrdPNIgMtVBwFLiogYJYIeCYBLk6puKhZxU8ILhwS4vDWqWPePBLjIqozef5PNZjc2NjY3N8VisVarvdjL7ZAAl7TpjOLmI5GIz+dbWlqam5t78ODB8vJyNBrlcrnPPPPMP/7jP05OTiIHkAA1L28ooF9fX3c4HNPT048ePbLZbF6vN51O03+8ubn53r17AwMDqIWQADU/93NjY2NxcfHBgweffvqp3W4PBoMMWscZuSKDxWKl0+m/+Iu/ePvtt6GwDz9bBpZC1AToCcWyv79vsVg+/vjje/fuLSwsPH78uFDHGQRn6Sdgj8eDsVokQA3IegKj6XTaarU+ePDg17/+9fz8vNvtJpANoC9xRlB9fX06nVapVE9/uzBKILTjnT3Z02ezWbvdPjc3Nz09PTMzY7Vak8kk47c7LenDIIp0FcNrCgSChw8fDg0N4RkA7wDVqHC2trYWFxc//fTTjz76yG63kydkkduLi3t6ogoDGEI8WaPRfO973xsaGsIJcHgHqKIYzv7+vtVq/eyzz37zm9/MzMxsbm5W0FNPGX5IfL+trW1oaGhycnJ0dPTZZ59tbm5G348EYJxLloqiRiBq+fHHH09PT6+srFBES1mgp4yQ4HK5AwMDN27c+L3f+73R0VG5XI6ZYCTAOXcREM5+bm7uV7/61SeffGKz2WKxWLmyvpCnb2ho6O3tvXbt2rVr15555hmVSkV0nBHPxJZiJMD51E47nc779+9/8sknDx8+XF5eLlfhFPH0g4ODExMTN27cuHLlilqtJrdZElXZ6PKRAOeJ/u9///vf/e53I5EIGfclKhzALmVurkajmZycnJqampiY0Ol0HA4Hhx8iAapU+fz0pz/98pe/XIGzpyicnp6e8fHxGzduXL9+Xa/XNzY2Yv8NEqAGRmhNTU1NT0/DPJVynX1TU9PY2NjU1NT169cnJiYkEgmCnoF5gBqaIgGbG+lTPimgJ0frORyOTqcbGxt79tlnb9y40dfXR0kS46QgJEDNmEAgkEgku7u7MBCOaJgkFA5BjLa2tvHx8eeff/4LX/iCVqslRt5SAjiIeyRALQ0R4vF4f/qnf/rtb38bvkNezctgMCQSydDQ0NjY2Be+8IWJiQmZTJY3gIOgxzNADR8DstnsP/zDP7z77rvhcBjuCTqdbmJi4nd+53cmJib6+/vzKhyU9UiAC2Ver9flcrFYrJ6eHrlcTh7qD84eU1RIgItc/IPz4ZAADKwFQtAjAdDQGBgFQnvaw1HQ8A5wuRrKiDAUyi0kwEXuHqZ4erfbPTc3l0gkDAbD6OgofkpIgIs/DCuVSlmt1nv37n3wwQefffYZlJ2y2eyvfe1r3//+92HdGN4HkAAXrZcyEok8ePDgww8//Pjjj202WyqVYjyplyae//rrr7/zzjvYBYYEuDij2KPR6MOHD+/evfvLX/4SKu0Y+RrKAPGNjY1LS0sKhQI5wMAoUI3inqgYnZube++9937xi1/Y7XZ69zCl4BS+mUqlyI04aEiA2jvaWiyWu3fv3r17d25ujkA59JSR60kpBjuMFQoFjMHCMwASoGZwD2JmdXX1Zz/72Z07d2ZmZg4PD0vEPbGzHvpvvva1r/H5fNQ/eAaoGYkfCoU++eSTn/zkJx9++CEx7PbYHmJgDnmiRG9v79e//vW/+Zu/IY9YREMCVBf0ibqgVCp17969O3fufPDBB8SMoGMHpRBnAKJ7WK1Wv/DCC88///zU1JRUKsUPGQlQ7cOClpeX7969e/v27fn5ebKMORb3DFKnpVQqffbZZ19++eUvfvGLRL88DkBHAlQ1+ufm5r773e9++umnBwcHFIlffGAEgXs+n3/9+vVXX331hRdeUCgU2GCABKgZ9N+7d+/WrVuhUOhY3BNoJnDPZrOnpqa+9KUv/f7v//7AwAD5LIG4RwIwqr9PMpPJPPvss5999hmbzc5kMoU+bboWGhkZeemll/7wD//wypUrxLJuekUQGgPDoFVLgPr6eofDsbi4WFdXlxf99KOtRqO5efPmrVu3rl27Rgw/hDET2DWPBKjhqYlk9JNxD2pHLpc/99xzt27d+t3f/V1iKhbgHkekoASqYQmUTqefe+653/zmN2w2mwjwE/5eKpV+/vOf/6M/+qMXX3yxtbUVj7ZIgAt4CJ6fn//KV75CrmYTCoXXr19/+eWXX3zxxZ6eHjzaIgEuuP7Z3t7+6U9/6nK5+Hy+Xq+/du2aWq0mV0Yg7pEAl2JrRvEmLzQkwEUugCOPS0HcIwHQ0M7f0A+hIQHQ0JAAaGhIADQ0JAAaGhIADQ0JgIaGBEBDQwKgoSEB0NCQAGhoSAA0NCQAGhoSAA0NCYCGVqP2/wANS+S8H/nN7wAAAABJRU5ErkJggg==';
// Add to Home Screen never reads the SVG favicon: iOS takes apple-touch-icon,
// Android takes the manifest's PNGs. Both sit on the reader's wallpaper, so
// unlike the mark itself they carry a field (assets/*.png, drawn from
// assets/tdoc_logo.svg at 68% of the box so the maskable safe zone holds).
const TDOC_HOME_ICONS = {
  '/apple-touch-icon.png': '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',
  '/icon-192.png': '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',
  '/icon-512.png': 'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAQAElEQVR4nOzdeXDU933/8Q+EQydISAjEIQkhLt23BMhgC4MBF4wdk5RM2kzxxEmapG3cZNJp0/xjT9ukM27rNJ1J6hn3SFzXNcUmlPtGSEISugUCcegCCYEAgYTEZX6v7qb6kRhjJLTSd/fzfPyx89VKdDrJ5P167+uz+90x9+/fNwAA+4w2AAArEQAAYCkCAAAsRQAAgKUIAACwFAEAAJYiAADAUgQAAFiKAAAASxEAAGApAgAALEUAAIClCAAAsBQBAACWIgAAwFIEAABYigAAAEsRAABgKQIAACxFAACApQgAALAUAQAAliIAAMBSBAAAWIoAAABLEQAAYCkCAAAsRQAAgKUIAACwFAEAAJYiAADAUgQAAFiKAAAASxEAAGApAgAALEUAAIClCAAAsBQBAACWIgAAwFIEAABYigAAAEsRAABgKQIAACxFAACApQgAALAUAQAAliIAAMBSBAAAWIoAAABLEQAAYCkCAAAsRQAAgKUIAACwFAEAAJYiAADAUgQAAFiKAAAASxEAAGApAgAALEUAAIClCAAAsBQBAACWIgAAwFIEAABYigAAAEsRAABgKQIAACxFAACApQgAALAUAQAAliIAAMBSBAAAWIoAAABLEQAAYCkCAAAsRQAAgKUIAACwFAEAAJYiAADAUgQAAFiKAAAASxEAAGApAgAALEUAAIClCAAAsBQBAACWIgAAwFIEAABYigAAAEsRAABgKQIAACxFAACApQgAALAUAQAAliIAAMBSBAAAWIoAAABLEQAAYCkCAAAsRQAAgKXGGADwHufPn29ubr5z546uZ86cOWvWLIPBIgAADJPr169PmDBBFxcuXNAQv337tvvJjo6OS5cu3b171/1nvb29165du3LlSldXV/+TN2/ePH78eF9f32/933zmmWe+853vLFu2zGDgRt2/f98AwGPr6ek5depUWlqa+8eqqipNauOa0SdOnNCjpoomeJeL5vvVq1evuHxyfA+Vt95665VXXjEYIAIAgGlraztz5syNGzcqKio0EzTitaFrK/+tP7t3756eVwljnKegoKA/k/CYCADAu2kiX7x4UbWJ+0ct2hrcly9f/vjjj93PdHZ2PviMHi+76C+ND1m1atUHH3xgMBAEAOA4tbW1jY2N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rq6ud955R6NfnY/xgIiIiC9+8Yt/+Id/yPSHYxEAsMupU6dU8hw8eLC8vPzJT3c/ad68eZmZmStWrHj55ZcN4GwEAKxw9erV//zP//yP//iPsrIy4wEJCQnPP//85z//+cTERAN4CQIAPu7dd999//33PVTxBwYGLlmy5NVXX+Vt/vBGBAB81vHjx7/85S+fPHnSeMCaNWvWr1+vld8AXosAgG+qq6vLz8/v7u42Q0oNzx/90R+tW7dOu78BvBxvA4UPunHjxsKFCx/nTm2Pb8OGDX/6p3+6YMECA/gKXgHAB7399ttDNf1ffPHF733veykpKQbwOQQAfFB5ebl5AgEBAatWrVq7dq2OdidMmGAAH0UAwAf5+fmZQVm5cuWrr7763HPPGcACBAB8UFJS0oD+Pioq6uWXX/7617/Op3ZhFQ6B4YOuXbuWkJCgx0f/WV5enir+NWvWMPdhJwIAvqmyslIlfmdn50N/+4UvfGHjxo1PPfWUASxGAMBntbe3/8mf/MmuXbtu3bqlHT8xMTE/Pz85OTktLY1vaAEMAQAA1hptAABWIgAAwFIEAABYigAAAEsRAABgKQIAACxFAACApQgAALAUAQAAliIAAMBSBAAAWIoAAABLEQAAYCkCAAAsRQAAgKUIAACwFAEAAJYiAADAUgQAAFiKAAAASxEAAGApAgAALEUAAIClCAAAsBQBAACWIgAAwFIEAABYigAAAEsRAABgKQIAACxFAACApQgAALAUAQAAliIAAMBSBAAAWIoAAABLEQAAYCkCAAAsRQAAgKUIAACwFAEAAJYiAADAUgQAAFiKAAAASxEAAGApAgAALEUAAIClCAAAsBQBAACWIgAAwFIEAABYigAAAEsRAABgKQIAACxFAACApQgAALAUAQAAliIAAMBSBAAAWIoAAABLEQAAYCkCAAAsRQAAgKUIAACwFAEAAJYiAADAUgQAAFiKAAAASxEAAGApAgAALEUAAIClCAAAsBQBAACWIgAAwFIEAABYigAAAEsRAABgKQIAACxFAACApQgAALAUAQAAliIAAMBSBAAAWIoAAABLEQAAYCkCAAAsRQAAgKUIAACwFAEAAJYiAADAUgQAAFiKAAAASxEAAGApAgAALEUAAIClCAAAsBQBAACWIgAAwFIEAABYigAAAEsRAABgKQIAACxFAACApQgAALAUAQAAliIAAMBS/w8AAP//axVIagAAAAZJREFUAwDvMjlAZ8nH1AAAAABJRU5ErkJggg==',
};
const TDOC_WEBMANIFEST = `{
  "name": "tdoc",
  "short_name": "tdoc",
  "start_url": "/",
  "scope": "/",
  "display": "minimal-ui",
  "background_color": "#ffffff",
  "theme_color": "#ffffff",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}`;
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
// Whether the document CARRIES the baked reading template — as an actual
// <style> tag, not as prose. A substring check false-positives on any document
// whose text discusses the mechanism (tdoc's own design docs quote
// id="tdoc-reader" in code samples), and a false positive here means an
// unbaked document is skipped. Every bake/skip decision uses this one test so
// the write side and the read side cannot disagree.
const READER_BLOCK_RE = /<style[^>]*\bid="tdoc-reader"/i;
function hasReaderBlock(html) {
  return READER_BLOCK_RE.test(html);
}

// The document-content invariants, in ONE place. Every path that stores a
// version of a document — /api/upload, the browser Save inside the Durable
// Object, and duplicate — goes through this. It exists because there used to
// be no function named "store a version": each writer assembled the invariants
// itself, which is how the browser Save path shipped without baking and how
// nobody ever recorded a content hash (there was nowhere to put it).
//
// What it guarantees about the stored bytes:
//   1. The reading template is baked in, stamped with its generation
//      (data-tdoc-template), so the file is self-contained however old the
//      client that produced it. No-op when the document already carries the
//      block, and when this worker is unbundled (tests on raw worker.js).
//   2. Artifact aids are stamped (comment anchor identity).
//   3. `sha` is the hash of the EXACT bytes stored — what a client compares
//      against to know whether its local copy is current.
// Widget HTML must NOT come through here: widgets are sandboxed islands with
// their own CSP, and the reading template does not belong in them.
async function prepareDocVersion(rawHtml) {
  let html = String(rawHtml);
  const css = readerCssSource();
  if (css && !hasReaderBlock(html)) {
    const stamp = (await sha256Hex(css)).slice(0, 8);
    const tag = `<style id="tdoc-reader" data-tdoc-template="${stamp}">${css}</style>\n`;
    // Callback so a `$` in the template stays literal.
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${tag}</head>`) : tag + html;
  }
  const stamped = stampAids(html);
  const sha = (await sha256Hex(stamped.html)).slice(0, 16);
  return { html: stamped.html, aids: stamped.aids, sha };
}

function injectReaderCss(html, css) {
  if (!css) return html;
  // Documents have been self-contained since creation-time baking landed, so
  // most already carry the block. Stamping a second copy is 8KB of duplicate
  // CSS and a duplicate id in every downloaded file.
  if (hasReaderBlock(html)) return html;
  const tag = `<style id="tdoc-reader">${css}</style>\n`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, () => `${tag}</head>`);
  return tag + html;
}

// Render one published doc version as the cross-origin SHELL: chrome (bar,
// footer, composer, pins, cards) in this outer document; the author content
// stays isolated in the same-origin, sandboxed /frame iframe.
function shellDocumentWorker(rawHtml, slug, version, identity, versions, isOwner, ownerManage, nonce, isLanding, canSeeMyDocsFlag, isCatalog, webAuth, stars, viewerStar, versionWritesEnabled, commentWritesEnabled, docMeta, oidc) {
  // Unbundled worker (raw worker.js in tests): no shell builder inlined — serve
  // the author document bare rather than injecting anything.
  if (!SHELL) return rawHtml;
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const vlist = Array.isArray(versions) && versions.length ? versions : [{ n: version }];
  // The document's own title, which the bar and the browser tab both show.
  // This used to be the slug and nothing ever reassigned it, so every hosted
  // document was named after its URL. That read as a title only while slugs
  // were agent-picked words; a browser-created doc's slug is an opaque id.
  // The slug remains the fallback for a doc whose meta carries no title.
  const docTitle = docMeta && docMeta.title;
  const title = typeof docTitle === 'string' && docTitle.trim() ? docTitle.trim() : slug;
  // Who the document belongs to, shown beside its title. Only hosted publishes
  // record a person; a doc from before hosted accounts, the landing doc, and
  // everything on a self-hosted worker have nobody to name, and name nobody
  // rather than guessing from versions[].author (which only browser edits set).
  const author = hostedGithubLogin(docMeta) || null;
  const cfg = {
    slug,
    title,
    version,
    identity: identity || null,
    author,
    isOwner: !!isOwner,
    canEdit: !!versionWritesEnabled && !!isOwner && !isLanding,
    canComment: !!commentWritesEnabled,
    canSeeMyDocs: !!canSeeMyDocsFlag,
    isLanding: !!isLanding,
    isCatalog: !!isCatalog,
    ownerManage: isOwner ? (ownerManage || null) : null,
    authConfigured: true,
    webAuth: !!webAuth,
    // The provider seat, so the doc shell's sign-in goes through the same
    // single door as /activate and the landing — this was the last surface
    // still steering people to the first-party GitHub flow.
    oidcAuth: !!(oidc && oidc.enabled),
    oidcLabel: (oidc && oidc.label) || '',
    mode: 'published',
    versions: vlist,
    stars: stars || null,
    viewerStar: viewerStar || null,
    runtime: runtimeInfo(),
  };
  const hasCta = /<a[^>]+href="\/start"/.test(rawHtml || '');
  cfg.onboarding = slug === LANDING_SLUG || slug === START_SLUG || hasCta;

  let oldVersion = null;
  const latestVersion = vlist.length ? Math.max(...vlist.map(v => Number(v.n) || 0)) : version;
  cfg.canEdit = cfg.canEdit && Number(version) === Number(latestVersion);
  if (!isLanding && vlist.length > 1 && typeof version === 'number' && version < latestVersion) {
    oldVersion = {
      current: version,
      latest: latestVersion,
      latestUrl: `/d/${encodeURIComponent(slug)}/v/${latestVersion}`,
    };
  }
  return SHELL.shellHtml({
    title,
    nonceAttr,
    cfgJson: safeJsonForScript(cfg),
    bootJson: safeJsonForScript({
      frameSrc: `/d/${encodeURIComponent(slug)}/v/${version}/frame`,
      oldVersion,
    }),
    runtimeJsPath: SHELL_RUNTIME_JS_PATH,
    runtimeCssPath: SHELL_RUNTIME_CSS_PATH,
  });
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
  const identity = sessionPrincipal(session)
    ? { login: actorKey(session), avatar_url: session.avatar_url || '', name: actorDisplayName(session) }
    : null;
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
  if (!isLanding && actorKey(session)) {
    try {
      viewerStar = { starred: (await loadStars(env, actorKey(session))).some((i) => i.slug === slug) };
    } catch {}
  }
  const render = shellDocumentWorker;
  return {
    ok: true,
    // session rides along so the /d/ route can record the visit (recents)
    // without a second session lookup.
    session,
    response: html(render(raw, slug, version, identity, versions, isOwner, ownerManage, nonce, isLanding, canSeeMyDocs(env, session, requestOrigin(req)), false, !!env.GITHUB_CLIENT_SECRET, stars, viewerStar, !!env.COMMENTS, canCommentOnDoc(gate.access, session, env, gate.meta), gate.meta, { enabled: !!oidcConfig(env), label: (oidcConfig(env) || {}).label || '' }), {
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
    if (!latest) return neutralLandingResponse(env);
    const res = await serveDocVersion(env, req, slug, Number(latest), true);
    return res.ok ? res.response : neutralLandingResponse(env);
  } catch {
    return neutralLandingResponse(env);
  }
}

// Neutral landing page served at `/` when the landing doc is unavailable, and
// on every self-hosted worker that has no such doc. No catalog, no slug list —
// just brand + sign-in (when auth is configured) + a link to the open-source
// project. Docs are link-only. `notice` is an optional toast reason when we
// bounce users here from /me or an unknown path.
function neutralLandingResponse(env, notice) {
  const messages = {
    me: 'My docs is only available after you sign in as the worker owner.',
    signin: 'Sign in with GitHub to continue.',
    notfound: 'That page was not found. Sign in or open a doc from its shared link.',
  };
  const nonce = rand(16);
  return html(SHELL.appHtml({
    title: 'tdoc',
    nonceAttr: ` nonce="${nonce}"`,
    runtimeJsPath: SHELL_RUNTIME_JS_PATH,
    runtimeCssPath: SHELL_RUNTIME_CSS_PATH,
    bootJson: safeJsonForScript({
      page: 'neutral-landing',
      authConfigured: !!String(env?.GITHUB_CLIENT_ID || '').trim(),
      webAuth: !!env?.GITHUB_CLIENT_SECRET,
      oidcAuth: !!oidcConfig(env),
      oidcLabel: (oidcConfig(env) || {}).label || '',
      notice: messages[notice] || '',
    }),
  }), { headers: { 'Content-Security-Policy': cspHeader(nonce) } });
}

// Web OAuth redirect flow (browsers). Device flow stays for CLIs; this is the
// hop that phones need — GitHub sends the visitor straight back here after
// Approve, so nobody is stranded on GitHub's "Congratulations" page. Active
// only when GITHUB_CLIENT_SECRET is set (the token exchange requires it), so a
// deploy without the secret silently keeps the device flow.
// ---- CLI pairing (tdoc-owned sign-in handoff) -------------------------------
// The device-flow MECHANISM without the provider: the CLI shows a short code,
// the human approves it at /activate in their own browser (signed in however
// they like), and the poll returns an account-scoped upload token. tdoc issues
// the code, so no provider is wired into the CLI at all — this is what lets
// GitHub become just one button on /activate, next to whatever comes later.
//
// Not full OAuth, on purpose: the CLI is first-party, so there is no client
// registration, no scopes, no redirect URI. Two endpoints and one page.
//
// Threat model (see the design doc, tdoc.dev/d/tdoc-auth-refactor):
//   - code guessing: 28^8 ≈ 3.8e11 codes, 10-minute TTL, per-IP mint limits,
//     and a per-code strike cap that burns the record — guessing needs the
//     matching pair_secret anyway, which never leaves the CLI.
//   - approval phishing: /activate names the terminal (its label) and the
//     signed-in account before the confirm button.
//   - replay: single redemption — the record is deleted the moment a poll
//     collects the token.
// The KV counters are per-colo approximations (KV is eventually consistent);
// they are the baseline, and a Cloudflare zone rate-limit rule on
// /api/cli/pair/* is the belt-and-braces an operator adds in the dashboard.

// No 0/O, 1/I/L, U/V ambiguity — this code is read off one screen and typed
// into another, sometimes over a shoulder or a screenshot.
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ2345679';
const PAIR_TTL_SECONDS = 600;
const PAIR_MAX_STRIKES = 5;

function pairCode() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const pick = [...buf].map((b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]);
  return `${pick.slice(0, 4).join('')}-${pick.slice(4).join('')}`;
}

function normalizePairCode(raw) {
  const v = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length !== 8) return null;
  return `${v.slice(0, 4)}-${v.slice(4)}`;
}

// Fixed-window KV counter. Approximate by design (per-colo, eventually
// consistent) — good enough to make brute force boring, not an SLA.
async function rateLimited(env, bucket, limit, windowSeconds) {
  if (!env || !env.META) return false;
  const windowId = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `rl:${bucket}:${windowId}`;
  let count = 0;
  try { count = Number(await env.META.get(key)) || 0; } catch {}
  if (count >= limit) return true;
  try { await env.META.put(key, String(count + 1), { expirationTtl: windowSeconds * 2 }); } catch {}
  return false;
}

function clientIp(req) {
  return req.headers.get('cf-connecting-ip') || 'unknown';
}

// JSON POSTs from the /activate page carry the browser's Origin; a cross-site
// page cannot fake it. Absent Origin (curl, the CLI) is fine — those requests
// carry no ambient session cookie worth stealing via CSRF anyway, and approve
// (the only session-cookie-authenticated pair route) demands a match.
function sameOrigin(req, url) {
  const o = req.headers.get('origin');
  return !o || o === url.origin;
}

// ---- OIDC provider seat --------------------------------------------------
// One adapter, any spec-compliant issuer. The deployment decision is Clerk
// (used strictly as an OIDC provider — never as a session layer), but nothing
// here knows that: swap the three env values and a different issuer sits in
// the same seat. The discipline that keeps this rug-pull-proof, per the
// design doc: we store only what the issuer ATTESTS about an email
// (userinfo's email + email_verified), the issuer's user IDs never become
// keys, and the GitHub button stays direct — if this vendor vanishes, sign-in
// degrades to GitHub while the seat is re-filled, and no account moves.
// One sign-in surface. GitHub lives INSIDE the provider's modal like every
// other method — there is no parallel first-party GitHub path on a host that
// has this seat configured. What made the parallel path tempting was
// migration: a legacy account is found by GitHub handle, and the OIDC
// userinfo carries neither handle nor GitHub id. This call is the bridge —
// the provider's backend API knows which GitHub account the user connected,
// so a double-miss (no sub index, no email index) resolves through the
// GitHub identity instead of minting a stranger account. Config-gated on
// CLERK_SECRET_KEY; absent, the lookup quietly answers null and only
// genuinely new users are affected (they were getting fresh accounts anyway).
async function clerkExternalGithub(env, sub) {
  const key = String(env && env.CLERK_SECRET_KEY || '').trim();
  const id = String(sub || '').trim();
  if (!key || !id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  try {
    const r = await fetch(`https://api.clerk.com/v1/users/${id}`, {
      headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json', 'User-Agent': 'tdoc-worker' },
    });
    if (!r.ok) return null;
    const u = await r.json();
    const gh = (u && Array.isArray(u.external_accounts) ? u.external_accounts : [])
      .find((a) => a && /github/i.test(String(a.provider || '')));
    if (!gh) return null;
    const ghId = gh.provider_user_id ? String(gh.provider_user_id) : null;
    const handle = normalizeGithubLogin(gh.username);
    if (!ghId && !handle) return null;
    return { ghId, handle };
  } catch {
    return null;
  }
}

function oidcConfig(env) {
  const issuer = String(env && env.OIDC_ISSUER || '').trim().replace(/\/$/, '');
  const clientId = String(env && env.OIDC_CLIENT_ID || '').trim();
  const clientSecret = String(env && env.OIDC_CLIENT_SECRET || '').trim();
  if (!/^https:\/\//.test(issuer) || !clientId || !clientSecret) return null;
  return { issuer, clientId, clientSecret, label: String(env.OIDC_LABEL || 'Email').trim() || 'Email' };
}

// Per-isolate discovery cache. Discovery is static config on the issuer's
// side; refetching it per sign-in would add a round trip for nothing.
let OIDC_DISCOVERY = { issuer: null, doc: null };
async function oidcDiscovery(cfg) {
  if (OIDC_DISCOVERY.issuer === cfg.issuer && OIDC_DISCOVERY.doc) return OIDC_DISCOVERY.doc;
  const r = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'tdoc-worker' },
  });
  if (!r.ok) throw new Error(`oidc discovery ${r.status}`);
  const doc = await r.json();
  if (!doc || !doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
    throw new Error('oidc discovery incomplete');
  }
  OIDC_DISCOVERY = { issuer: cfg.issuer, doc };
  return doc;
}

function authStatusResponse(message, { error = false, status = 200 } = {}) {
  const nonce = rand(16);
  return html(SHELL.appHtml({
    title: error ? 'tdoc - sign-in failed' : 'tdoc - signed in',
    nonceAttr: ` nonce="${nonce}"`,
    runtimeJsPath: SHELL_RUNTIME_JS_PATH,
    runtimeCssPath: SHELL_RUNTIME_CSS_PATH,
    bootJson: safeJsonForScript({
      page: 'status',
      title: error ? 'Sign-in failed' : "You're signed in",
      message,
      error,
    }),
  }), {
    status,
    headers: { 'Content-Security-Policy': cspHeader(nonce) },
  });
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
// Folders nest via `parent`; depth is capped so a pathological chain can
// never make path-walking expensive (cycles are stripped on normalize).
const FOLDER_DEPTH_MAX = 4;
// A reload of the doc already at the head of the recents list within this
// window does not rewrite KV — visits are a signal, not an access log.
const RECENT_REVISIT_MS = 5 * 60 * 1000;

// Stars, recents and folders are per-identity too, so they take actor keys
// for the same reason the inbox does.
function personalKey(prefix, login) {
  const n = normalizeActorKey(login);
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
  // Parent pointers must reference an existing folder, never self, and never
  // close a cycle — a broken pointer degrades to root, losing nothing.
  const byId = new Map(folders.map((f) => [f.id, f]));
  for (const f of folders) {
    if (f.parent != null && (typeof f.parent !== 'string' || !ids.has(f.parent) || f.parent === f.id)) delete f.parent;
  }
  for (const f of folders) {
    const seen = new Set([f.id]);
    let cur = f;
    while (cur && cur.parent) {
      if (seen.has(cur.parent)) { delete cur.parent; break; }
      seen.add(cur.parent);
      cur = byId.get(cur.parent);
    }
  }
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

function folderDepth(state, id) {
  const byId = new Map(state.folders.map((f) => [f.id, f]));
  let depth = 0;
  const seen = new Set();
  let cur = byId.get(id);
  while (cur && depth <= FOLDER_DEPTH_MAX + 1) {
    depth += 1;
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = cur.parent ? byId.get(cur.parent) : null;
  }
  return depth;
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

async function indexData(env, session, origin) {
  let keys = [];
  let cursor;
  do {
    const page = await env.META.list({ prefix: 'meta:', cursor });
    keys = keys.concat(page.keys);
    cursor = page.cursor;
    if (page.list_complete) break;
  } while (cursor);

  const catalog = await Promise.all(keys.map(async (key) => {
    const slug = key.name.slice('meta:'.length);
    let meta = {};
    try { meta = JSON.parse(await env.META.get(key.name) || '{}'); } catch {}
    const versions = Array.isArray(meta.versions) ? meta.versions : [];
    return {
      slug,
      title: meta.title || slug,
      latest: versions[versions.length - 1]?.n || 1,
      created: meta.created || versions[0]?.created || '',
      updated: versions[versions.length - 1]?.created || meta.created || versions[0]?.created || '',
      owner: hostedGithubLogin(meta) || '',
      meta,
    };
  }));

  const hosted = hostedRegistrationEnabled(env, origin);
  const viewer = sessionLogin(session);
  // Personal state is keyed on the actor (so an email identity has stars and
  // recents at all); the BYOK owner column stays a handle comparison, since
  // row.owner is a github_login and always will be for those docs.
  const viewerKey = actorKey(session);
  const mine = catalog.filter((row) => {
    if (hosted) return isDocOwnerSession(env, session, row.meta);
    return !row.owner || row.owner === viewer;
  }).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));

  const [starItems, recentItems, folderState] = viewerKey
    ? await Promise.all([loadStars(env, viewerKey), loadRecents(env, viewerKey), loadFolderState(env, viewerKey)])
    : [[], [], { folders: [], docs: {} }];
  const starred = new Set(starItems.map((item) => item.slug));
  const bySlug = new Map(catalog.map((row) => [row.slug, row]));
  const savedRows = (items) => items.map((item) => {
    const row = bySlug.get(item.slug);
    return row && docReadableBy(env, session, row.meta) ? { ...row, at: item.at } : null;
  }).filter(Boolean);
  const publicRow = (row) => ({
    slug: row.slug,
    title: row.title,
    latest: row.latest,
    created: row.created,
    updated: row.updated,
    owner: row.owner,
    starred: starred.has(row.slug),
  });

  return {
    docs: mine.map((row) => ({ ...publicRow(row), folder: folderState.docs[row.slug] || '' })),
    recent: savedRows(recentItems).map(publicRow),
    starred: savedRows(starItems).map(publicRow),
    folders: folderState.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      parent: folder.parent || '',
    })),
  };
}

// Agent verdict → emoji, rendered at fold time by snapshotAt (never stored as
// a reaction event) so the ✅/🟡/❓ on a card is per-version like any status.
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
  // A comment the local server edited carries `edited` and the NEW text on one
  // flat record. Replay it as an edit of the same text so the marker survives
  // the publish merge instead of arriving as an original that was never touched.
  if (c.edited) {
    events.push({ kind: 'text_edited', at_version: v, at: c.edited, text: c.text || '' });
  }
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
      if (r.edited) {
        events.push({
          kind: 'reply_text_edited', at_version: Number(r.version) || v,
          at: r.edited, reply_id: r.id, text: r.text || '',
        });
      }
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
    mentions: [],
    edited: null,
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
        snap.mentions = Array.isArray(e.mentions) ? e.mentions : [];
        break;
      case 'text_edited':
        snap.text = e.text || '';
        snap.edited = e.at || snap.edited;
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
          mentions: Array.isArray(e.reply.mentions) ? e.reply.mentions : [],
          edited: null,
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
        if (r) { r.text = e.text || ''; r.edited = e.at || r.edited; }
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
  snap.replies = keepThread(replyOrder, replyById).map(r => (r.deleted ? asTombstone(r) : r));
  return snap;
}

// Which replies survive the fold. An alive reply always does. A DELETED one
// does too when something that survives still hangs off it — otherwise the
// answers to it would vanish with it, and a conversation would lose its middle.
// Resolved to a fixpoint, so a deleted reply whose only child was itself
// deleted-and-dropped goes as well.
function keepThread(order, byId) {
  const keep = new Set(order.filter(id => byId.get(id) && !byId.get(id).deleted));
  for (let changed = true; changed;) {
    changed = false;
    for (const id of order) {
      if (keep.has(id)) continue;
      if (order.some(k => keep.has(k) && byId.get(k).parent_id === id)) {
        keep.add(id);
        changed = true;
      }
    }
  }
  return order.filter(id => keep.has(id)).map(id => byId.get(id));
}

// What is left of a comment or reply whose text was taken down but whose slot
// is still holding a thread together. The name stays — this is GitHub's "user
// deleted this", not an anonymous [deleted]: a thread reads as a conversation
// between people, and blanking who spoke rewrites the other replies' meaning.
// Everything the words earned goes with the words: reactions, the agent
// verdict, mentions, the edited marker. The anchor stays so the surviving
// replies are still reachable where the conversation happened.
function asTombstone(record) {
  return {
    ...record,
    text: '',
    deleted: true,
    reactions: {},
    mentions: [],
    edited: null,
    agent_status: null,
    status: 'open',
    applied_in: undefined,
  };
}

// Fold the full list at version V, filter out alive comments only.
// `V = Infinity` (or undefined) = latest snapshot, no version filter.
function snapshotList(list, V) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    const s = snapshotAt(c, V);
    if (!s) continue;
    // A deleted comment that still holds replies stays as a tombstone; deleting
    // your own words must not be a way to take everyone else's off the page.
    // One with nothing under it disappears, as it always has.
    if (s.deleted && !s.replies.length) continue;
    out.push(s.deleted ? asTombstone(s) : s);
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

// Has this agent already answered here, and has a human said anything since?
//
// A folded comment is not enough to answer that. When a human deletes the
// agent's reply — or rewrites it — every folded view loses it, so the next
// generation round reads a thread it has never answered and answers it again,
// in the same place, with the same words. The event log still holds the
// reply_added, so the gate reads the log rather than the snapshot: what a
// human removed is exactly what has to be remembered.
//
// Open again only when a HUMAN REPLIES after the agent's last word on this
// thread. Nothing else counts, and in particular EDITING THE COMMENT DOES NOT:
// a person fixing their own typo has not asked a second time, and an answered
// comment that changes shape is not a new comment. Deleting or editing the
// agent's own answer does not count either — that is the clearest "I have
// dealt with this" there is, not an invitation to repeat it.
//
// The one exception is a re-anchor, which the product already treats as
// reopening (patch_anchor resets status to open, and SKILL.md says /tdoc edit
// picks it up again): the comment now points at different text, so it is no
// longer the same place.
//
// Returns { allowed, reason }. Reasons are stable strings the CLI prints.
function agentReplyGate(record, agentLogin) {
  if (!record) return { allowed: false, reason: 'parent_not_found' };
  ensureEventLog(record);
  // Same ordering the fold uses — by version, ties broken by append order —
  // so "who spoke last" means the same thing here as it does on the card.
  // Timestamps are not the tiebreak: two events in one round land in the same
  // millisecond, and a tie must not read as "nobody has answered since".
  const ordered = dedupEvents(record.events)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => ((a.e.at_version || 0) - (b.e.at_version || 0)) || (a.i - b.i))
    .map((x) => x.e);
  const isAgentAuthor = (author) => !!(author && author.kind === 'agent');
  let answered = false;   // this agent has spoken at least once
  let theirTurn = true;   // a human has moved since it last did
  let deleted = false;
  for (const e of ordered) {
    if (!e) continue;
    switch (e.kind) {
      case 'deleted':
        deleted = true;
        break;
      case 'reply_added':
        if (!e.reply) break;
        if (isAgentAuthor(e.reply.author) && e.reply.author.login === agentLogin) {
          answered = true;
          theirTurn = false;
        } else if (!isAgentAuthor(e.reply.author)) {
          theirTurn = true;
        }
        break;
      case 'text_edited':
        // Rewriting the comment is not asking again. Whoever edited it, the
        // question the agent already answered is still the question.
        break;
      case 'anchor_changed':
        // The agent's own re-anchor (bind_anchor_aid) is not a human turn.
        if (e.by !== agentLogin) theirTurn = true;
        break;
      case 'reply_deleted':
      case 'reply_text_edited':
        // A human removing or rewriting the agent's answer keeps the gate SHUT.
        // It is the clearest "I have dealt with this" there is, not a request
        // to hear the same thing again.
        break;
      default:
        break;
    }
  }
  if (deleted) return { allowed: false, reason: 'comment_deleted' };
  if (!answered) return { allowed: true, reason: 'first_reply' };
  if (theirTurn) return { allowed: true, reason: 'human_replied_since' };
  return { allowed: false, reason: 'already_answered' };
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
// The merge key's gatekeeper. Loose on purpose — the provider already proved
// deliverability; this only guards KV key hygiene (no spaces/control chars,
// exactly one @, bounded length) and canonicalizes case.
function normalizeEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  if (v.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null;
  return v;
}

// The signed-in user's verified email, or null. Requires the user:email
// scope; a token minted before the scope widened gets [] or 403 here, and
// null is the correct answer — the account simply gains its email key on a
// later sign-in (migration is lazy by design).
async function ghVerifiedEmail(token) {
  try {
    const r = await fetch('https://api.github.com/user/emails', {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'tdoc-worker',
      },
    });
    if (!r.ok) return null;
    const list = await r.json();
    if (!Array.isArray(list)) return null;
    const hit = list.find((e) => e && e.primary && e.verified && typeof e.email === 'string')
      || list.find((e) => e && e.verified && typeof e.email === 'string');
    return hit ? normalizeEmail(hit.email) : null;
  } catch {
    return null;
  }
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
  if (!sessionPrincipal(session)) return false;
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

function latestVersionNumber(meta) {
  const versions = Array.isArray(meta && meta.versions) ? meta.versions : [];
  return versions.reduce((latest, item) => Math.max(latest, Number(item && item.n) || 0), 0);
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

// Read-only twin of hostedAccountForGithub: resolves an existing account and
// never mints one. Sign-in goes through THIS — a commenter is not a
// publisher, and hasUsedTdoc treats hosted-account presence as "has
// registered", so minting on sign-in would both fill KV with spectator
// accounts and make every second commenter read as an established user.
// ---- provider identities ------------------------------------------------
// An account is reached three ways, and only one of them is authoritative:
//
//   account-idp:<provider>:<sub>  → account_id   authoritative. `sub` is the
//       provider's own immutable id (GitHub's numeric user id, Clerk's
//       user_xxx). It is never reused and never edited by the user.
//   hosted-account:<login>        → account_id   legacy, and unsafe alone: a
//       GitHub login can be RENAMED and the old name becomes available for
//       anyone to register. Kept so existing accounts resolve, and upgraded
//       to an idp index the first time their owner signs in.
//   account-email:<email>         → account_id   a merge hint, used only when
//       no idp index exists yet. Addresses change hands (a company reassigns
//       a departed employee's mailbox), so treating one as proof of identity
//       forever is how someone inherits an account they never owned.
//
// Storing `sub` is not vendor lock-in: account_id is ours and every doc,
// token and permission hangs off it. Drop a provider and its idp index
// becomes dead weight — the account is untouched, and its owner walks back in
// through the email hint on whatever provider replaces it.
function idpKey(provider, sub) {
  const p = String(provider || '').trim().toLowerCase();
  const id = String(sub || '').trim();
  if (!/^[a-z0-9_-]{1,32}$/.test(p) || !id || id.length > 128) return null;
  return `account-idp:${p}:${id}`;
}

async function accountIdByIdp(env, provider, sub) {
  const key = idpKey(provider, sub);
  if (!key || !env || !env.META) return null;
  try {
    const rec = JSON.parse(await env.META.get(key));
    if (rec && typeof rec.account_id === 'string' && rec.account_id) return rec.account_id;
  } catch {}
  return null;
}

async function accountIdByEmail(env, email) {
  const norm = normalizeEmail(email);
  if (!norm || !env || !env.META) return null;
  try {
    const rec = JSON.parse(await env.META.get(`account-email:${norm}`));
    if (rec && typeof rec.account_id === 'string' && rec.account_id) return rec.account_id;
  } catch {}
  return null;
}

// Record how this person got in, and make that route findable next time.
// Also moves the email index off any address this identity no longer
// attests: leaving the old pointer live is exactly the window in which a
// recycled address inherits the account.
async function linkIdentity(env, account, { provider, sub, email, handle }) {
  if (!env || !env.META || !account || !account.account_id) return account;
  const key = idpKey(provider, sub);
  const norm = normalizeEmail(email);
  const now = new Date().toISOString();

  if (key) {
    await env.META.put(key, JSON.stringify({ account_id: account.account_id, created: now }));
  }

  const identities = Array.isArray(account.identities) ? account.identities.slice() : [];
  const at = identities.findIndex((i) => i && i.provider === provider && String(i.sub) === String(sub));
  const entry = {
    provider,
    sub: String(sub || ''),
    ...(norm ? { email: norm } : {}),
    ...(handle ? { handle } : {}),
    last_seen: now,
  };
  if (at >= 0) identities[at] = { ...identities[at], ...entry };
  else identities.push({ ...entry, linked_at: now });
  account.identities = identities;

  if (norm) {
    const previous = normalizeEmail(account.email);
    if (previous && previous !== norm) {
      // Only retract a pointer that still names us; another account may have
      // legitimately claimed the address since.
      try {
        const stale = JSON.parse(await env.META.get(`account-email:${previous}`));
        if (stale && stale.account_id === account.account_id) {
          await env.META.delete(`account-email:${previous}`);
        }
      } catch {}
    }
    const existing = await accountIdByEmail(env, norm);
    if (!existing || existing === account.account_id) {
      await env.META.put(`account-email:${norm}`, JSON.stringify({ account_id: account.account_id, created: now }));
      account.email = norm;
    }
  }
  return account;
}

async function lookupHostedAccount(env, login) {
  const norm = normalizeGithubLogin(login);
  if (!norm || !env || !env.META) return null;
  for (const key of [`hosted-account:${norm}`, `hosted-github:${norm}`]) {
    try {
      const rec = JSON.parse(await env.META.get(key));
      if (rec && typeof rec.account_id === 'string' && rec.account_id) return rec;
    } catch {}
  }
  return null;
}

async function hostedAccountForGithub(env, login, verifiedEmail = null, githubId = null) {
  const norm = normalizeGithubLogin(login);
  if (!norm || !env || !env.META) return null;
  const primary = `hosted-account:${norm}`;
  // The numeric id first: a GitHub login can be renamed and the freed name
  // registered by somebody else, so the handle index alone would hand that
  // stranger the original owner's account. The id is immutable and never
  // reissued. Falls back to the handle for accounts that predate this.
  let rec = null;
  if (githubId) {
    const id = await accountIdByIdp(env, 'github', githubId);
    if (id) {
      // Known id: that account, whatever handle it wears today.
      try { rec = JSON.parse(await env.META.get(`hosted-account:${norm}`)); } catch {}
      if (!rec || rec.account_id !== id) rec = { account_id: id, github_login: norm, created: new Date().toISOString() };
    } else {
      // Unknown id. The handle index may still name an account — but it was
      // written for whoever held this handle BEFORE, and a freed GitHub name
      // can be registered by anyone. Claim it only if it has no stable owner
      // yet (a legacy account, upgraded here); if it already belongs to a
      // different id, this is a different person wearing a recycled name and
      // they start clean.
      const legacy = await lookupHostedAccount(env, login);
      if (legacy) {
        const owner = (legacy.identities || []).find((i) => i && i.provider === 'github');
        if (!owner) rec = legacy;
      }
    }
  }
  if (!rec && !githubId) rec = await lookupHostedAccount(env, login);
  if (!rec) {
    rec = {
      account_id: `acct_${rand(12)}`,
      github_login: norm,
      created: new Date().toISOString(),
    };
  } else {
    // Spread first: the record is about to grow fields this function does not
    // know about (email today, linked identities later), and the old
    // fixed-three-field rewrite silently dropped anything extra on every
    // sign-in — data written once and erased on next login.
    rec = {
      ...rec,
      account_id: rec.account_id,
      github_login: norm,
      created: rec.created || new Date().toISOString(),
    };
  }
  // Record the identity and refresh its indexes. First writer still wins on
  // the email hint: if it already names a DIFFERENT account this one does not
  // take it, because stealing it would point a stranger's future sign-ins at
  // these docs. Verified-only is enforced upstream — callers pass what the
  // provider attested, never anything the client typed.
  if (githubId) {
    rec = await linkIdentity(env, rec, {
      provider: 'github', sub: String(githubId), email: verifiedEmail, handle: norm,
    });
  } else {
    const email = normalizeEmail(verifiedEmail);
    if (email && rec.email !== email) {
      const existing = await accountIdByEmail(env, email);
      if (!existing || existing === rec.account_id) {
        await env.META.put(`account-email:${email}`, JSON.stringify({
          account_id: rec.account_id, created: new Date().toISOString(),
        }));
        rec.email = email;
      }
    }
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

// The account home for someone with no GitHub login at all (an OIDC
// sign-in). The account-email index doubles as the record: for GitHub-born
// accounts it is a pointer ({account_id}) whose record lives at
// hosted-account:<login>; for email-born accounts it IS the record. Minting
// only ever needs account_id, so both shapes serve.
async function hostedAccountForEmail(env, verifiedEmail, idp = null) {
  const email = normalizeEmail(verifiedEmail);
  if (!email || !env || !env.META) return null;
  // The stable identity wins when we have one, so an account survives its
  // owner changing their address at the provider.
  let rec = null;
  if (idp && idp.sub) {
    const id = await accountIdByIdp(env, idp.provider, idp.sub);
    if (id) rec = { account_id: id, created: new Date().toISOString() };
  }
  if (!rec) {
    try { rec = JSON.parse(await env.META.get(`account-email:${email}`)); } catch {}
  }
  if (!(rec && typeof rec.account_id === 'string' && rec.account_id)) {
    rec = { account_id: `acct_${rand(12)}`, created: new Date().toISOString() };
  }
  // This is where a brand-new account is born, so it is also where its
  // identity is first written down — after this the email index is only ever
  // a hint, never the thing that proves who someone is.
  if (idp && idp.sub) rec = await linkIdentity(env, rec, { ...idp, email });
  else {
    rec.email = email;
    await env.META.put(`account-email:${email}`, JSON.stringify({ account_id: rec.account_id, created: rec.created }));
  }
  return rec;
}

async function issueHostedToken(env, body = {}, verifiedEmail = null, idp = null) {
  const github_login = normalizeGithubLogin(body.login);
  // Two doors to an account, one canonical identity behind both: a GitHub
  // login keys the legacy registry; an attested email (an OIDC approver) keys
  // the email registry. Neither is ever taken from the client body — login
  // comes from the session route-side, email as its own trusted argument.
  let account = null;
  if (github_login) {
    account = await hostedAccountForGithub(env, github_login, verifiedEmail, idp && idp.provider === 'github' ? idp.sub : null);
  } else if (normalizeEmail(verifiedEmail)) {
    account = await hostedAccountForEmail(env, verifiedEmail, idp);
  } else {
    return { error: 'sign_in_required', status: 401 };
  }
  if (!account) return { error: 'sign_in_required', status: 401 };
  const token = `tdoc_${rand(24)}`;
  const tokenHash = await sha256Hex(token);
  const record = {
    account_id: account.account_id,
    ...(github_login ? { github_login } : {}),
    created: new Date().toISOString(),
  };
  if (typeof body.label === 'string' && body.label.trim()) {
    record.label = body.label.trim().slice(0, 80);
  }
  await env.META.put(`hosted-token:${tokenHash}`, JSON.stringify(record));
  // "Has this account ever connected a terminal?" — one key, so the future
  // browser-side gate (pairing is a sideshow at sign-in, enforced only when
  // a feature actually needs a terminal) has something O(1) to ask.
  try {
    let t = null;
    try { t = JSON.parse(await env.META.get(`account-terminal:${account.account_id}`)); } catch {}
    await env.META.put(`account-terminal:${account.account_id}`, JSON.stringify({
      first: (t && t.first) || record.created, last: record.created,
    }));
  } catch {}
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

// Resolve a comment id to the record that carries its author — the top-level
// comment, or the reply object stored on its thread's reply_added event.
// Returns null only when the id exists nowhere, which callers must tell apart
// from a record whose author is missing (legacy; mutable by nobody).
function findRecord(list, id) {
  if (!id || !Array.isArray(list)) return null;
  const top = list.find(c => c && c.id === id);
  if (top) return top;
  for (const c of list) {
    const ev = (c.events || []).find(e => e.kind === 'reply_added' && e.reply && e.reply.id === id);
    if (ev) return ev.reply;
  }
  return null;
}

function recordAuthor(list, id) {
  const record = findRecord(list, id);
  return (record && record.author) || null;
}

// Editing is the author's ALONE — deliberately not canMutate(), which also
// grants the doc owner. Rewriting somebody else's words under their name is
// not a power owning the document confers. That holds for an agent's words
// too: nobody rewrites what the agent said, including the person it ran for.
function isRecordAuthor(record, session) {
  const who = record && record.author && record.author.login;
  const me = actorKey(session);
  if (!who || !me) return false;
  return String(who).toLowerCase() === String(me).toLowerCase();
}

function isAgentRecord(record) {
  return !!(record && record.author && record.author.kind === 'agent');
}

// Deleting is the author's — and an agent's words belong to the person whose
// token it ran on. /api/agent/reply is authed with the doc's upload token, so
// an agent is not a third party with speech of its own; it is the owner
// writing through a tool. Reading it that way answers "whose words are these"
// rather than punching a hole in "deletion belongs to whoever wrote it", and
// it keeps the flow #349 describes possible: a person clearing an AI comment
// they did not want.
function mayDelete(record, session, env, meta) {
  if (isRecordAuthor(record, session)) return true;
  return isAgentRecord(record) && isDocOwnerSession(env, session, meta);
}

// Per-user inbox (same host, cross-doc). KV key inbox:<github-login>.
// Rows are aggregated by group_key so a viral doc does not write 40 lines.
const INBOX_MAX = 200;
const INBOX_PAGE = 20;

// Accepts either shape of actor key. normalizeGithubLogin rejects anything
// with an "@" in it, so routing an email identity through it alone silently
// produced null — i.e. an email-keyed reader would never receive a single
// notification, with nothing to see in any log.
// An invite entry is whatever the doc owner typed into the box: a GitHub
// handle (legacy, and still valid) or an email address (D2). Stored bare in
// both cases — an address is what the owner recognises when they look at the
// list later, and isAllowlisted matches a session against either shape.
function normalizeInvitee(item) {
  const raw = String(item || '').trim();
  // Not "contains @" — a handle may be written "@Bob", which is a handle
  // wearing a sigil, not an address. An address is the shape with something
  // on BOTH sides of a single @, so try the handle reading first (it also
  // strips the "@" and "github:" prefixes) and fall through to email only
  // when what is left cannot be a handle.
  const asLogin = normalizeGithubLogin(raw);
  if (asLogin) return asLogin;
  return normalizeEmail(raw);
}

function normalizeActorKey(who) {
  const raw = String(who || '').trim().toLowerCase();
  if (raw.startsWith('email:')) {
    const email = normalizeEmail(raw.slice('email:'.length));
    return email ? `email:${email}` : null;
  }
  return normalizeGithubLogin(raw);
}

function inboxKey(login) {
  const n = normalizeActorKey(login);
  return n ? `inbox:${n}` : null;
}

function inboxGroupKey(kind, slug, targetId) {
  // A mention is addressed to you by name, so it keeps its own row: rolling it
  // into `comment:<slug>` would let a busy doc swallow the one notification
  // that was actually about you.
  if (kind === 'mention') return `mention:${targetId || slug}`;
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
// only; reaction → author of that item; mention → everyone named in the text.
// Never notify the actor.
function inboxRecipients({ kind, actorLogin, ownerLogin, parentAuthorLogin, targetAuthorLogin, mentionLogins }) {
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
  else if (kind === 'mention') for (const login of (Array.isArray(mentionLogins) ? mentionLogins : [])) push(login);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// @mentions
//
// A comment reaches people by NAME, not only by position in the thread. Any
// GitHub login can be named — the composer searches GitHub itself — but the
// gate on DELIVERY is whether that person can actually open the doc:
//
//   public / unlisted   anyone can read it, so anyone named is notified
//   private, invited    already on the allowlist, notified
//   private, stranger   the OWNER naming them is an invite (they go on the
//                       allowlist, then get notified); anyone else naming
//                       them changes nothing — plain text, no notification
//
// The last row is the one that matters: an inbox row carries the doc title
// and a line of the comment, so notifying a stranger about a private doc
// would hand them content they are not allowed to open.
//
// Mentions are resolved on the SERVER from the posted text. A client-supplied
// list would let a crafted request notify anyone.
// ─────────────────────────────────────────────────────────────────────────

// One comment cannot notify an unbounded crowd.
const MENTION_MAX_PER_COMMENT = 10;
// Ceiling for the allowlist growing by @mention. Not applied retroactively to
// a list an owner built by hand in the Share panel.
const MENTION_INVITE_ALLOWLIST_MAX = 100;

// GitHub login shape: alphanumeric plus inner hyphens, 39 max. The leading
// group swallows the preceding character so `a@b` (an email) and `@@x` don't
// match, and so two mentions separated by one space both do.
const MENTION_RE = /(^|[^A-Za-z0-9_@\/-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/g;

function parseMentionLogins(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const seen = new Set();
  const re = new RegExp(MENTION_RE.source, 'g');
  let m;
  while ((m = re.exec(text))) {
    // A GitHub login never ends in a hyphen, so `@dana-` names dana.
    const login = String(m[2]).replace(/-+$/, '').toLowerCase();
    if (!login || seen.has(login)) continue;
    seen.add(login);
    out.push(login);
  }
  return out;
}

// The logins a single comment may act on: parsed in the order they were
// typed, deduped, and capped.
function mentionCandidates(text) {
  return parseMentionLogins(text).slice(0, MENTION_MAX_PER_COMMENT);
}

// Everyone who has written on this doc, newest record last. Reads the raw
// event log rather than a snapshot so the author of a DELETED comment still
// counts as someone you can talk to.
function commentParticipants(list) {
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
  for (const c of (Array.isArray(list) ? list : [])) {
    if (!c) continue;
    push(c.author);
    for (const e of (Array.isArray(c.events) ? c.events : [])) {
      if (e && e.kind === 'reply_added' && e.reply) push(e.reply.author);
    }
    for (const r of (Array.isArray(c.replies) ? c.replies : [])) push(r && r.author);
  }
  return [...byLogin.values()];
}

// Who this session may name. `includeAllowed` is the requester's own insider
// status: the private-doc allowlist is not public roster material, so a
// signed-in stranger on a public doc gets the owner and the people who have
// already spoken, and nothing that would let them enumerate the invite list.
function mentionableUsers({ ownerLogin, allowedUsers, participants, includeAllowed = true }) {
  const byLogin = new Map();
  const push = (entry) => {
    const login = normalizeGithubLogin(entry && entry.login);
    if (!login) return;
    const prev = byLogin.get(login) || { login, name: '', avatar_url: '' };
    byLogin.set(login, {
      login,
      name: prev.name || (entry && entry.name) || '',
      avatar_url: prev.avatar_url || (entry && entry.avatar_url) || '',
    });
  };
  push({ login: ownerLogin });
  if (includeAllowed) for (const u of (Array.isArray(allowedUsers) ? allowedUsers : [])) push({ login: u });
  for (const p of (Array.isArray(participants) ? participants : [])) push(p);
  return [...byLogin.values()];
}

// Being named outranks sitting in the thread. Returns the login that should
// still get the positional notification (owner of the doc, author of the
// parent), or null when the mention already reached them — one row, not two.
function positionalRecipient(login, mentions) {
  const n = normalizeGithubLogin(login);
  if (n && (Array.isArray(mentions) ? mentions : []).includes(n)) return null;
  return login;
}

// Split the named logins by what can actually happen to them.
//   canRead(login)  — can that person open this doc as it stands
//   canInvite       — may THIS commenter widen the allowlist (owner only)
//   inviteBudget    — how many more the allowlist may take
// `notified` includes `invited`: an invite is only worth anything if the
// mention that triggered it also lands.
function classifyMentions(logins, { canRead, canInvite = false, inviteBudget = 0 } = {}) {
  const notified = [];
  const invited = [];
  const blocked = [];
  for (const login of (Array.isArray(logins) ? logins : [])) {
    if (canRead(login)) { notified.push(login); continue; }
    if (canInvite && invited.length < inviteBudget) {
      invited.push(login);
      notified.push(login);
      continue;
    }
    blocked.push(login);
  }
  return { notified, invited, blocked };
}

// Has this login ever actually used tdoc on THIS host? Read-only on purpose,
// and two tempting sources are deliberately not consulted:
//   - `inbox:` — a mention CREATES it, so the probe would answer its own
//     question and every second mention would read as an established user.
//   - hostedAccountForGithub() — it MINTS an account when none exists, so
//     probing with it would manufacture the very record it reports.
// What is left is evidence the person came here themselves: a doc they opened
// while signed in, a doc they starred, or a hosted account they registered.
// `false` is the safe answer — it tells the author to send the link, which is
// never wrong, only sometimes unnecessary.
const PRESENCE_PREFIXES = ['recents', 'stars', 'hosted-account', 'hosted-github'];
async function hasUsedTdoc(env, login) {
  const n = normalizeGithubLogin(login);
  if (!n || !env || !env.META) return false;
  for (const prefix of PRESENCE_PREFIXES) {
    if (await env.META.get(`${prefix}:${n}`)) return true;
  }
  return false;
}

// Which of the notified were not already part of this document. These are the
// only people the author may still have to reach by hand — everyone else
// (the owner, the allowlist, anyone already in the thread) has their own
// reason to come back. Each carries whether they have ever used tdoc, because
// that decides whether the mention can find them on its own.
async function describeNewcomers(env, { notified = [], invited = [], insiders = [] } = {}) {
  const inside = new Set(insiders.map(normalizeGithubLogin).filter(Boolean));
  const out = [];
  for (const login of notified) {
    if (inside.has(login)) continue;
    out.push({ login, invited: invited.includes(login), known: await hasUsedTdoc(env, login) });
  }
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
        events: [{ kind: 'created', at_version: op.version, at: now, anchor: op.anchor || null, text: op.text,
          mentions: Array.isArray(op.mentions) ? op.mentions : [] }],
      };
      backfillEids(entry.events);
      list.push(entry);
      return { status: 200, body: snapshotAt(entry, op.version) };
    }
    case 'reply': {
      const thread = findCommentThread(list, op.parent_id);
      if (!thread) return { status: 404, body: { error: 'parent_not_found' } };
      appendEvent(thread.root, { kind: 'reply_added', at_version: op.version, at: now,
        reply: { id: op.reply_id, author: op.author, text: op.text, agent_status: null, parent_id: op.parent_id,
          mentions: Array.isArray(op.mentions) ? op.mentions : [] } });
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
    case 'edit_text': {
      // Authorization enforced upstream (the worker resolves the target and
      // checks it is the author's own record). The DO only serializes the
      // write. Stamped at the viewed version like every other event, so an
      // older version keeps the words it was published with.
      const top = list.find(c => c.id === op.id);
      if (top) {
        appendEvent(top, { kind: 'text_edited', at_version: op.version, at: now, text: op.text, by: op.actor.login });
        return { status: 200, body: snapshotAt(top, op.version) };
      }
      for (const c of list) {
        ensureEventLog(c);
        const re = (c.events || []).find(e => e.kind === 'reply_added' && e.reply?.id === op.id);
        if (re) {
          appendEvent(c, { kind: 'reply_text_edited', at_version: op.version, at: now, reply_id: op.id, text: op.text, by: op.actor.login });
          const snap = snapshotAt(c, op.version);
          return { status: 200, body: (snap && snap.replies.find(r => r.id === op.id)) || { ok: true } };
        }
      }
      return { status: 404, body: { error: 'not_found' } };
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
    // A mention has no single recipient — it carries its own list.
    mentionLogins: ev.kind === 'mention' ? ev.mentions : [],
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

async function createBrowserVersion(env, slug, payload) {
  if (!env.COMMENTS) {
    return { status: 503, body: { error: 'version_store_unavailable' } };
  }
  const stub = env.COMMENTS.get(env.COMMENTS.idFromName(slug));
  try {
    const response = await stub.fetch('https://do/version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, op: payload }),
    });
    const body = await response.json();
    return { status: response.status, body };
  } catch (error) {
    return { status: 503, body: { error: 'version_store_unavailable', message: error.message || String(error) } };
  }
}

async function versionReservationOp(env, slug, op) {
  if (!env.COMMENTS) return { ok: false, status: 503, error: 'version_store_unavailable' };
  try {
    const stub = env.COMMENTS.get(env.COMMENTS.idFromName(slug));
    const response = await stub.fetch('https://do/version-lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, op }),
    });
    const body = await response.json();
    return { ...body, status: response.status };
  } catch (error) {
    return { ok: false, status: 503, error: 'version_store_unavailable', message: error.message || String(error) };
  }
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

  async _reserveVersion(baseVersion, metaLatest) {
    let result;
    const reservationId = rand(8);
    const started = Date.now();
    await this.state.storage.transaction(async (txn) => {
      let cursor = await txn.get('versionCursor');
      if (!cursor || typeof cursor !== 'object') cursor = { latest: metaLatest, pending: null };

      if (cursor.pending) {
        const committed = metaLatest >= Number(cursor.pending.next || 0);
        const stale = started - Number(cursor.pending.started || 0) > 60_000;
        if (committed || stale) cursor = { latest: Math.max(metaLatest, Number(cursor.latest) || 0), pending: null };
        else {
          result = { ok: false, status: 409, body: { error: 'save_in_progress', latestVersion: Number(cursor.latest) || metaLatest } };
          return;
        }
      }

      cursor.latest = Math.max(metaLatest, Number(cursor.latest) || 0);
      if (cursor.latest !== baseVersion) {
        result = { ok: false, status: 409, body: { error: 'version_conflict', baseVersion, latestVersion: cursor.latest } };
        return;
      }
      const next = baseVersion + 1;
      cursor.pending = { id: reservationId, base: baseVersion, next, started };
      await txn.put('versionCursor', cursor);
      result = { ok: true, id: reservationId, next };
    });
    return result;
  }

  async _finishVersion(reservation, committed) {
    await this.state.storage.transaction(async (txn) => {
      const cursor = await txn.get('versionCursor');
      if (!cursor || !cursor.pending || cursor.pending.id !== reservation.id) return;
      await txn.put('versionCursor', {
        latest: committed ? reservation.next : reservation.next - 1,
        pending: null,
      });
    });
  }

  async _copyVersionWidgets(slug, baseVersion, nextVersion) {
    const fromPrefix = `docs/${slug}/v${baseVersion}/widgets/`;
    let cursor;
    do {
      const page = await this.env.DOCS.list({ prefix: fromPrefix, cursor });
      for (const item of page.objects || []) {
        const source = await this.env.DOCS.get(item.key);
        if (!source) continue;
        const target = `docs/${slug}/v${nextVersion}/widgets/${item.key.slice(fromPrefix.length)}`;
        await this.env.DOCS.put(target, await source.text(), {
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
        });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  async _saveVersion(slug, op) {
    const meta = await loadDocMeta(this.env, slug);
    if (!meta) return { status: 404, body: { error: 'not_found' } };
    const metaLatest = latestVersionNumber(meta);
    // The blank page a browser create lays down is scaffolding, not a version
    // anyone wrote. The first real save becomes v1 rather than appending v2, so
    // a document's history starts with the first thing someone actually wrote.
    // Bounded by construction: it needs the mark the create route set, the doc
    // must still have only that one version, and the save that takes this path
    // writes a version record without the mark — so no document can replace
    // twice. Docs created before the mark existed keep the old behaviour.
    const priorVersions = Array.isArray(meta.versions) ? meta.versions : [];
    const replacesScaffold = priorVersions.length === 1
      && Number(priorVersions[0] && priorVersions[0].n) === 1
      && Boolean(priorVersions[0] && priorVersions[0].blank)
      && Number(op.baseVersion) === 1;
    const reservation = replacesScaffold
      ? { ok: true, next: 1 }
      : await this._reserveVersion(op.baseVersion, metaLatest);
    if (!reservation.ok) return { status: reservation.status, body: reservation.body };

    let committed = false;
    try {
      const widgetFrom = `/d/${slug}/v/${op.baseVersion}/widget/`;
      const widgetTo = `/d/${slug}/v/${reservation.next}/widget/`;
      const rewritten = String(op.html).split(widgetFrom).join(widgetTo);
      // A document created blank IS its heading — that is where its author
      // typed the title, and it keeps following the heading. Every other
      // document has a title of its own, which renaming changes; its first h1
      // may not even be a title (tdoc-start's is a tagline), so a save must
      // never re-read it. An empty or missing h1 leaves the stored title alone
      // rather than blanking it.
      const nextTitle = meta.created_from === 'blank' ? titleFromDocument(rewritten) : '';
      const stamped = await prepareDocVersion(nextTitle ? syncDocumentTitle(rewritten, nextTitle) : rewritten);
      // Nothing to carry across when the target IS the source; a scaffold has
      // no widgets either way.
      if (!replacesScaffold) await this._copyVersionWidgets(slug, op.baseVersion, reservation.next);
      const key = `docs/${slug}/v${reservation.next}/index.html`;
      await this.env.DOCS.put(key, stamped.html, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      });
      const verify = await this.env.DOCS.head(key);
      if (!verify) throw new Error('version_write_lost');

      const now = new Date().toISOString();
      const versions = (Array.isArray(meta.versions) ? meta.versions : [])
        .filter((item) => Number(item && item.n) !== reservation.next);
      versions.push({
        n: reservation.next,
        created: now,
        prompt: 'Browser edit',
        source: 'browser',
        sha: stamped.sha,
        ...(op.actorLogin ? { author: op.actorLogin } : {}),
      });
      versions.sort((a, b) => Number(a.n) - Number(b.n));
      await this.env.META.put(`meta:${slug}`, JSON.stringify({
        ...meta,
        ...(nextTitle ? { title: nextTitle } : {}),
        versions,
      }));
      committed = true;
      // META is the commit point. Cursor cleanup is recoverable bookkeeping:
      // reporting a failed save after META committed would make the browser
      // retry a snapshot that already exists.
      if (!replacesScaffold) {
        try {
          await this._finishVersion(reservation, true);
        } catch (error) {
          console.error('[browser-save] version cursor finalize failed (recoverable):', error.message || String(error));
        }
      }

      // Comments are an independent event log. Reconcile the authoritative
      // list after the snapshot commits; a concurrent comment is included by
      // the transaction rather than being overwritten by the save.
      try {
        await this.state.storage.transaction(async (txn) => {
          const list = await this._loadInTxn(txn, slug);
          const result = applyCommentOp(list, {
            kind: 'publish_merge', localComments: [], aids: stamped.aids, version: reservation.next,
          });
          if (result.status === 200) await txn.put('list', list);
        });
      } catch (error) {
        console.error('[browser-save] comment reconcile failed (non-fatal):', error.message || String(error));
      }
      return {
        status: 200,
        body: { ok: true, version: reservation.next, url: `/d/${slug}/v/${reservation.next}` },
      };
    } catch (error) {
      if (!committed && !replacesScaffold) {
        try { await this._finishVersion(reservation, false); } catch {}
      }
      return { status: 500, body: { error: 'version_write_failed', message: error.message || String(error) } };
    }
  }

  async fetch(req) {
    const u = new URL(req.url);
    let payload;
    try { payload = await req.json(); } catch { return Response.json({ list: [] }); }
    const { slug, op } = payload;

    if (u.pathname === '/version') {
      const result = await this._saveVersion(slug, op || {});
      return Response.json(result.body, { status: result.status });
    }

    if (u.pathname === '/version-lock') {
      if (op && op.kind === 'reserve') {
        const meta = await loadDocMeta(this.env, slug);
        if (!meta) return Response.json({ error: 'not_found' }, { status: 404 });
        const result = await this._reserveVersion(Number(op.baseVersion), latestVersionNumber(meta));
        return Response.json(result.ok ? result : result.body, { status: result.ok ? 200 : result.status });
      }
      if (op && op.kind === 'finish' && op.reservation) {
        await this._finishVersion(op.reservation, !!op.committed);
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'bad_version_lock_op' }, { status: 400 });
    }

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
    if (p === SHELL_RUNTIME_JS_PATH && (method === 'GET' || method === 'HEAD')) {
      return new Response(method === 'HEAD' ? null : SHELL_RUNTIME_JS, {
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (p === SHELL_RUNTIME_CSS_PATH && (method === 'GET' || method === 'HEAD')) {
      return new Response(method === 'HEAD' ? null : SHELL_RUNTIME_CSS, {
        headers: {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (p === '/favicon.svg' && method === 'GET') {
      return new Response(TDOC_FAVICON_SVG, {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (p === '/tdoc_logo.svg' && method === 'GET') {
      return new Response(TDOC_LOGO_SVG, {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (TDOC_HOME_ICONS[p] && method === 'GET') {
      const bin = Uint8Array.from(atob(TDOC_HOME_ICONS[p]), (c) => c.charCodeAt(0));
      return new Response(bin, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
      });
    }
    if (p === '/site.webmanifest' && method === 'GET') {
      return new Response(TDOC_WEBMANIFEST, {
        headers: {
          'Content-Type': 'application/manifest+json; charset=utf-8',
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
      if (notice) return neutralLandingResponse(env, notice);
      return landingResponse(env, req);
    }

    // `/start` is the homepage CTA's no-script destination: the same
    // onboarding written as a page. Same fail-safe as `/` — if that doc is
    // missing, the visitor gets the neutral page, never a 404.
    // The pairing approval page. Everything meaningful happens through the
    // session + the pair/* API; this only ships the shell page with the code
    // prefilled (normalized — a mangled ?code renders an empty field, never
    // an error page).
    if (p === '/activate' && (method === 'GET' || method === 'HEAD')) {
      const session = await getSession(env, req);
      const nonce = rand(16);
      return html(SHELL.appHtml({
        title: 'tdoc - connect a terminal',
        nonceAttr: ` nonce="${nonce}"`,
        runtimeJsPath: SHELL_RUNTIME_JS_PATH,
        runtimeCssPath: SHELL_RUNTIME_CSS_PATH,
        bootJson: safeJsonForScript({
          page: 'activate',
          code: normalizePairCode(url.searchParams.get('code')) || '',
          identity: sessionPrincipal(session)
            ? { login: session.login || null, name: session.name || session.login || session.email, avatar_url: session.avatar_url || '' }
            : null,
          webAuth: !!env?.GITHUB_CLIENT_SECRET,
          authConfigured: !!String(env?.GITHUB_CLIENT_ID || '').trim(),
          oidcAuth: !!oidcConfig(env),
          oidcLabel: (oidcConfig(env) || {}).label || '',
        }),
      }), { headers: { 'Content-Security-Policy': cspHeader(nonce) } });
    }

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
      if (!code) return authStatusResponse('You can close this tab and return to tdoc.');
      const state = url.searchParams.get('state');
      // Anchor to a cookie-pair boundary so a cookie merely ending in
      // "tdoc_oauth" (e.g. "xtdoc_oauth=") can't supply the nonce.
      const cookieNonce = (/(?:^|;\s*)tdoc_oauth=([a-f0-9]+)/.exec(req.headers.get('cookie') || '') || [])[1];
      if (!state || !cookieNonce || state !== cookieNonce) {
        return authStatusResponse('Sign-in could not be verified (state mismatch). Please try again.', { error: true, status: 400 });
      }
      if (!env.GITHUB_CLIENT_SECRET) {
        return authStatusResponse('Web sign-in is not configured on this host.', { error: true, status: 500 });
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
          return authStatusResponse('GitHub sign-in failed: ' + (r.error_description || r.error || 'no token returned'), { error: true, status: 400 });
        }
        const user = await ghUser(r.access_token);
        if (!user.login) return authStatusResponse('GitHub returned no account.', { error: true, status: 500 });
        // The only moment the GitHub token exists is now, so the verified
        // email is read now; it is the merge key that routes every sign-in
        // method to one account. Resolve-don't-mint: sign-in must not create
        // hosted accounts (see lookupHostedAccount).
        const email = await ghVerifiedEmail(r.access_token);
        // user.id is GitHub's immutable identifier; user.login is a display
        // name the owner can change — and whose old value anyone may then
        // register. Resolve on the id, falling back to the handle for
        // accounts that predate it.
        const ghId = user.id ? String(user.id) : null;
        const existing = (ghId && await accountIdByIdp(env, 'github', ghId))
          ? true : await lookupHostedAccount(env, user.login);
        const account = existing ? await hostedAccountForGithub(env, user.login, email, ghId) : null;
        const sid = rand(24);
        const session = {
          login: user.login,
          avatar_url: user.avatar_url,
          name: user.name || user.login,
          created: new Date().toISOString(),
          ...(account ? { account_id: account.account_id } : {}),
          ...(email ? { email } : {}),
          // Kept so a later token mint can link the identity even when this
          // sign-in found no account to attach it to yet.
          ...(ghId ? { idp: { provider: 'github', sub: ghId } } : {}),
        };
        await env.META.put(`session:${sid}`, JSON.stringify(session), { expirationTtl: 60 * 60 * 24 * 30 });
        return redirectTo(ret, [
          `tdoc_sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
          'tdoc_oauth=; Path=/; Max-Age=0',
        ]);
      } catch (e) {
        return authStatusResponse('Sign-in error: ' + e.message, { error: true, status: 500 });
      }
    }
    // Static soft landing (device flow, or the OAuth App's callback URL).
    if (p === '/auth/done' && method === 'GET') {
      return authStatusResponse('You can close this tab and return to tdoc.');
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
      const identity = { login: actorKey(s), avatar_url: s.avatar_url || '', name: actorDisplayName(s) };
      const data = await indexData(env, s, url.origin);
      return html(SHELL.appHtml({
        title: 'My docs',
        nonceAttr: ` nonce="${nonce}"`,
        runtimeJsPath: SHELL_RUNTIME_JS_PATH,
        runtimeCssPath: SHELL_RUNTIME_CSS_PATH,
        bootJson: safeJsonForScript({
          page: 'docs-hub',
          identity,
          runtime: runtimeInfo(),
          // Mirrors the /api/doc/create gate: offering "start from scratch" on a
          // host that will 403 it is worse than not offering it.
          capabilities: { create: isOwnerSession(env, s) || hostedAccountCopiesEnabled(env, req) },
          ...data,
        }),
      }), {
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
    // ---- raw stored bytes (agent read path) ----
    // The document's stored bytes, exactly as R2 holds them. This is how an
    // agent reads the source of truth before an edit, instead of trusting a
    // possibly-stale local copy (AGENTS.md line one vs the old /tdoc edit
    // step 2, which read local and faithfully imitated a 26-byte stale file).
    //
    // Served as text/plain with nosniff, NEVER text/html: author HTML on this
    // shared origin outside the sandboxed /frame would be stored XSS. Access
    // is the same gate as every other doc read. ETag is the sha of the stored
    // bytes (recorded at write by prepareDocVersion; computed here for
    // pre-existing storage), so a client that already holds the current copy
    // pays one conditional request and gets 304, no body.
    const rawMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/raw\/?$/);
    if (rawMatch && (method === 'GET' || method === 'HEAD')) {
      const [, slug, vStr] = rawMatch;
      if (!isValidSlug(slug)) return text('invalid slug', { status: 400 });
      const gate = await enforceDocAccess(env, req, slug, Number(vStr));
      if (!gate.ok) return gate.response;
      const obj = await env.DOCS.get(`docs/${slug}/v${vStr}/index.html`);
      if (!obj) return text(`Not found: ${slug} v${vStr}`, { status: 404 });
      const body = await obj.text();
      const meta = gate.meta || await loadDocMeta(env, slug);
      const entry = (Array.isArray(meta && meta.versions) ? meta.versions : []).find((v) => Number(v.n) === Number(vStr));
      const sha = (entry && typeof entry.sha === 'string' && /^[0-9a-f]{16}$/.test(entry.sha))
        ? entry.sha
        : (await sha256Hex(body)).slice(0, 16);
      const etag = `"${sha}"`;
      const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
        'ETag': etag,
      };
      const inm = req.headers.get('if-none-match');
      if (inm && inm.split(',').map((s2) => s2.trim()).includes(etag)) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(method === 'HEAD' ? null : body, { status: 200, headers });
    }

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
        // Documents created before creation-time baking carry no #tdoc-reader
        // block, so the reading template is supplied in the FRAME RESPONSE
        // (never written back to storage). No second condition: see the
        // matching comment in server/server.js — the old "and contains no
        // max-width" proxy starved the documents that followed the contract,
        // and :where() zero-specificity makes the injection harmless to a
        // document that styles itself.
        if (!hasReaderBlock(body)) {
          const rcss = (typeof READER_CSS === 'string' && READER_CSS.indexOf('__TDOC_') !== 0) ? READER_CSS : '';
          if (rcss) {
            const rtag = `<style id="tdoc-reader">${rcss}</style>`;
            // Callback so a `$` in the template stays literal (see bin/tdoc-bake).
            body = /<\/head>/i.test(body) ? body.replace(/<\/head>/i, () => `${rtag}</head>`) : rtag + body;
          }
        }
        const tag = `<script id="tdoc-frame-probe" data-tdoc-provider nonce="${nonce}">${PROBE_JS}</script>`;
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
    // ---- create a blank doc ----
    // Everything /api/doc/duplicate does except read a source document: claim a
    // derived slug, charge it to the caller's hosted quota, write v1 and the
    // meta record. The browser had no way to make a document before this; edit
    // mode could only ever change one that already existed.
    if (p === '/api/doc/create' && method === 'POST') {
      const session = await getSession(env, req);
      if (!sessionLogin(session)) return json({ error: 'sign_in_required' }, { status: 401 });
      const ownerCreate = isOwnerSession(env, session);
      let actor = { kind: 'owner_session' };
      if (!ownerCreate) {
        // Same door as /api/doc/duplicate: a self-hosted worker keeps writes to
        // its owner unless it has opted into hosted accounts. tdoc.dev is open.
        if (!hostedAccountCopiesEnabled(env, req)) {
          return json({
            error: 'account_create_unavailable',
            message: 'This host only lets its owner create documents. Publish from the CLI instead.',
          }, { status: 403 });
        }
        // Not a precondition — this mints the account on first use. A null here
        // means the account store itself is unreachable.
        const acct = await hostedAccountForGithub(env, session.login, session && session.email);
        if (!acct) return json({ error: 'hosted_account_unavailable' }, { status: 503 });
        actor = { kind: 'hosted', account_id: acct.account_id, github_login: acct.github_login };
      }

      const html = blankDocHtml();
      if (actor.kind === 'hosted') {
        const maxBytes = hostedMaxUploadBytes(env);
        const size = utf8ByteLength(html);
        if (size > maxBytes) return json({ error: 'quota_upload_bytes', limit: maxBytes, size }, { status: 413 });
        const limit = hostedMaxDocs(env);
        const used = await countHostedDocs(env, actor.account_id, limit);
        if (used >= limit) return json({ error: 'quota_docs', limit, used }, { status: 403 });
      }

      // Opaque ids don't collide in practice; the loop is here so that when one
      // does, the answer is another id rather than a failed create.
      let newSlug = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = blankDocSlug(crypto.getRandomValues(new Uint8Array(8)));
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
      let incoming = {
        // Renamed by the first save that finds a heading in the document, and
        // by every save after it — see _saveVersion. This is the only kind of
        // document whose heading is authoritative for its title.
        title: 'Untitled',
        created_from: 'blank',
        slug: newSlug,
        created: now,
        // The mark the first save consumes: this v1 is scaffolding, not
        // something an author wrote.
        versions: [{ n: 1, created: now, prompt: 'Created from scratch in the browser', blank: true }],
        created_by: session.login,
      };
      incoming = stampHostedOwnership(incoming, actor);

      const { html: stampedHtml, sha: blankSha } = await prepareDocVersion(html);
      incoming.versions[0].sha = blankSha;
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
      return json({ ok: true, slug: newSlug, version: 1, url: `/d/${newSlug}/v/1?edit=1` });
    }

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
        const acct = await hostedAccountForGithub(env, session.login, session && session.email);
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
        // Deliberately NOT inherited from the source: on tdoc.dev a reader may
        // duplicate someone else's doc, and a copy that carried a public policy
        // would republish it. hosted-oob-behavior asserts this defaults
        // unlisted. Creating a doc from scratch is the case that should match
        // a CLI publish; duplicating is not.
        access: normalizeAccess({}, { legacy: false }),
      };
      incoming = stampHostedOwnership(incoming, actor);

      const { html: stampedHtml, sha: dupSha } = await prepareDocVersion(rawHtml);
      incoming.versions[0].sha = dupSha;
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
      gh.searchParams.set('scope', 'read:user user:email');
      gh.searchParams.set('state', nonce);
      return redirectTo(gh.toString(), [
        `tdoc_oauth=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      ]);
    }

    // ---- CLI pairing routes (see the pairing block above) ----
    if (p === '/api/cli/pair/start' && method === 'POST') {
      if (await rateLimited(env, `pairstart:${clientIp(req)}`, 20, 600)) {
        return json({ error: 'slow_down' }, { status: 429 });
      }
      let body = {};
      try { body = await req.json(); } catch {}
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
      const user_code = pairCode();
      const pair_secret = `pairsec_${rand(24)}`;
      const record = {
        secret_hash: await sha256Hex(pair_secret),
        status: 'pending',
        strikes: 0,
        label,
        created: new Date().toISOString(),
      };
      await env.META.put(`pair:${user_code}`, JSON.stringify(record), { expirationTtl: PAIR_TTL_SECONDS + 60 });
      return json({
        user_code,
        pair_secret,
        verification_uri: `${url.origin}/activate`,
        verification_uri_complete: `${url.origin}/activate?code=${user_code}`,
        expires_in: PAIR_TTL_SECONDS,
        interval: 5,
      });
    }

    if (p === '/api/cli/pair/poll' && method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}
      const code = normalizePairCode(body.user_code);
      if (!code) return json({ error: 'expired_token' }, { status: 400 });
      let record = null;
      try { record = JSON.parse(await env.META.get(`pair:${code}`)); } catch {}
      if (!record) return json({ error: 'expired_token' }, { status: 400 });
      const okSecret = await timingSafeEqual(record.secret_hash, await sha256Hex(String(body.pair_secret || '')));
      if (!okSecret) {
        // A wrong secret is someone who saw the code but was never the CLI.
        // Strike the record, and burn it before guesses get interesting.
        record.strikes = (record.strikes || 0) + 1;
        if (record.strikes >= PAIR_MAX_STRIKES) await env.META.delete(`pair:${code}`);
        else await env.META.put(`pair:${code}`, JSON.stringify(record), { expirationTtl: PAIR_TTL_SECONDS });
        return json({ error: 'expired_token' }, { status: 400 });
      }
      if (record.status !== 'approved') return json({ error: 'authorization_pending' });
      if (!hostedRegistrationEnabled(env, url.origin)) {
        await env.META.delete(`pair:${code}`);
        return json({ error: 'hosted_registration_disabled' }, { status: 403 });
      }
      // Single redemption: the record dies before the token leaves, so a
      // replayed poll (or a second reader of the code) collects nothing.
      await env.META.delete(`pair:${code}`);
      const approved = record.approved || {};
      const issued = await issueHostedToken(env, { login: approved.login, label: record.label }, approved.email, approved.idp);
      if (issued.error) return json({ error: issued.error }, { status: issued.status || 401 });
      return json({
        ok: true,
        token: issued.token,
        account_id: issued.record.account_id,
        github_login: issued.record.github_login,
        base: url.origin,
        identity: { login: approved.login, name: approved.name || approved.login },
      });
    }

    if (p === '/api/cli/pair/lookup' && method === 'POST') {
      // Signed-in only, and rate-limited: this is what lets /activate name
      // the asking terminal before the human commits. It never returns the
      // secret or the status of somebody else's guessing game.
      if (!sameOrigin(req, url)) return json({ error: 'forbidden' }, { status: 403 });
      const session = await getSession(env, req);
      if (!sessionPrincipal(session)) return json({ error: 'sign_in_required' }, { status: 401 });
      if (await rateLimited(env, `pairlook:${session.id}`, 30, 600)) {
        return json({ error: 'slow_down' }, { status: 429 });
      }
      let body = {};
      try { body = await req.json(); } catch {}
      const code = normalizePairCode(body.user_code);
      let record = null;
      try { record = JSON.parse(await env.META.get(`pair:${code}`)); } catch {}
      if (!code || !record || record.status !== 'pending') {
        return json({ ok: false, error: 'unknown_code' }, { status: 404 });
      }
      return json({ ok: true, label: record.label || '', created: record.created });
    }

    if (p === '/api/cli/pair/approve' && method === 'POST') {
      if (!sameOrigin(req, url)) return json({ error: 'forbidden' }, { status: 403 });
      const session = await getSession(env, req);
      if (!sessionPrincipal(session)) return json({ error: 'sign_in_required' }, { status: 401 });
      if (await rateLimited(env, `pairok:${session.id}`, 10, 600)) {
        return json({ error: 'slow_down' }, { status: 429 });
      }
      let body = {};
      try { body = await req.json(); } catch {}
      const code = normalizePairCode(body.user_code);
      let record = null;
      try { record = JSON.parse(await env.META.get(`pair:${code}`)); } catch {}
      if (!code || !record || record.status !== 'pending') {
        return json({ ok: false, error: 'unknown_code' }, { status: 404 });
      }
      // The approver's identity is a server-side snapshot of THEIR session —
      // nothing in the request body can pose as it, same discipline as the
      // hosted-token mint.
      record.status = 'approved';
      record.approved = {
        login: session.login || null,
        idp: session.idp || null,
        name: session.name || session.login || (session.email ? String(session.email).split('@')[0] : ''),
        email: session.email || null,
      };
      await env.META.put(`pair:${code}`, JSON.stringify(record), { expirationTtl: PAIR_TTL_SECONDS });
      return json({ ok: true, label: record.label || '' });
    }

    if (p === '/api/auth/oidc/login' && method === 'GET') {
      const cfg = oidcConfig(env);
      if (!cfg) return redirectTo('/?notice=signin');
      const nonce = rand(16);
      const ret = sanitizeReturn(url.searchParams.get('return'));
      await env.META.put(`oauthstate:oidc:${nonce}`, ret, { expirationTtl: 600 });
      let auth;
      try { auth = new URL((await oidcDiscovery(cfg)).authorization_endpoint); }
      catch (e) { return authStatusResponse('Sign-in is not available right now: ' + e.message, { error: true, status: 502 }); }
      auth.searchParams.set('client_id', cfg.clientId);
      auth.searchParams.set('redirect_uri', `${url.origin}/auth/oidc/callback`);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('scope', 'openid email profile');
      auth.searchParams.set('state', nonce);
      return redirectTo(auth.toString(), [
        `tdoc_oidcst=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      ]);
    }

    if (p === '/auth/oidc/callback' && method === 'GET') {
      const cfg = oidcConfig(env);
      if (!cfg) return redirectTo('/?notice=signin');
      const code = url.searchParams.get('code');
      const state = String(url.searchParams.get('state') || '');
      const cookieState = (req.headers.get('cookie') || '').match(/(?:^|;\s*)tdoc_oidcst=([a-f0-9]+)/);
      if (!code || !state || !cookieState || cookieState[1] !== state) {
        return authStatusResponse('Sign-in could not be verified (state mismatch). Please try again.', { error: true, status: 400 });
      }
      const ret = sanitizeReturn(await env.META.get(`oauthstate:oidc:${state}`));
      await env.META.delete(`oauthstate:oidc:${state}`);
      try {
        const disc = await oidcDiscovery(cfg);
        const tr = await fetch(disc.token_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'tdoc-worker' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: `${url.origin}/auth/oidc/callback`,
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
          }).toString(),
        });
        const tok = await tr.json().catch(() => null);
        if (!tr.ok || !tok || !tok.access_token) {
          return authStatusResponse('Sign-in failed: ' + ((tok && (tok.error_description || tok.error)) || `token exchange ${tr.status}`), { error: true, status: 400 });
        }
        // userinfo over TLS from the issuer we were configured with — the
        // spec-sanctioned alternative to verifying the id_token signature,
        // and the same trust shape as the GitHub /user call above it.
        const ur = await fetch(disc.userinfo_endpoint, {
          headers: { 'Authorization': `Bearer ${tok.access_token}`, 'Accept': 'application/json', 'User-Agent': 'tdoc-worker' },
        });
        const user = await ur.json().catch(() => null);
        const email = normalizeEmail(user && user.email);
        // Verified only — the account-takeover rule, same as everywhere else.
        if (!email || user.email_verified !== true) {
          return authStatusResponse('This sign-in did not come with a verified email, so it cannot be used here.', { error: true, status: 403 });
        }
        // Resolve-don't-mint, same as GitHub sign-in: an account exists only
        // once something is published.
        //
        // The issuer's `sub` IS stored, and is checked first. An earlier
        // version deliberately refused to, reasoning that storing a vendor's
        // id is lock-in — which had it backwards. Lock-in is about who owns
        // the ACCOUNT, and account_id is ours; `sub` is just the one
        // identifier a provider guarantees never changes and never reuses,
        // which is exactly what an address does not guarantee. Without it,
        // a mailbox handed to a new person hands them the old owner's docs.
        const sub = user && user.sub ? String(user.sub) : null;
        let account_id = sub ? await accountIdByIdp(env, 'oidc', sub) : null;
        // No idp link yet: this provider is new to an existing account, so
        // the verified address is the merge hint that connects them. Used
        // once — the link written at mint time makes later sign-ins exact.
        if (!account_id) account_id = await accountIdByEmail(env, email);
        // Still nothing, and the visitor may be a legacy GitHub publisher
        // whose account predates the email index. Ask the provider which
        // GitHub identity they connected and resolve through that.
        let bridged = null;
        if (!account_id && sub) {
          bridged = await clerkExternalGithub(env, sub);
          if (bridged) {
            if (bridged.ghId) account_id = await accountIdByIdp(env, 'github', bridged.ghId);
            if (!account_id && bridged.handle) {
              const legacy = await lookupHostedAccount(env, bridged.handle);
              // Same guard as the direct flow: a handle whose account already
              // has a stable GitHub owner is not claimable through a name.
              const owned = legacy && (legacy.identities || []).some((i) => i && i.provider === 'github');
              if (legacy && !owned) account_id = legacy.account_id;
            }
            if (account_id) {
              // Write the links NOW, not at mint: the whole point is that the
              // very next sign-in resolves exactly, and this person may read
              // and comment for weeks before they ever mint a token.
              let rec = bridged.handle ? await lookupHostedAccount(env, bridged.handle) : null;
              if (!rec || rec.account_id !== account_id) rec = { account_id, created: new Date().toISOString() };
              if (bridged.ghId) rec = await linkIdentity(env, rec, { provider: 'github', sub: bridged.ghId, email, handle: bridged.handle || undefined });
              rec = await linkIdentity(env, rec, { provider: 'oidc', sub, email });
              if (bridged.handle) await env.META.put(`hosted-account:${bridged.handle}`, JSON.stringify(rec));
            }
          }
        }
        const sid = rand(24);
        const session = {
          name: (user.name || user.given_name || email.split('@')[0]),
          avatar_url: typeof user.picture === 'string' ? user.picture : '',
          email,
          oidc: true,
          created: new Date().toISOString(),
          ...(account_id ? { account_id } : {}),
          ...(sub ? { idp: { provider: 'oidc', sub } } : {}),
        };
        await env.META.put(`session:${sid}`, JSON.stringify(session), { expirationTtl: 60 * 60 * 24 * 30 });
        return redirectTo(ret, [
          `tdoc_sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
          'tdoc_oidcst=; Path=/; Max-Age=0',
        ]);
      } catch (e) {
        return authStatusResponse('Sign-in error: ' + e.message, { error: true, status: 500 });
      }
    }

    if (p === '/api/auth/device/start' && method === 'POST') {
      try {
        const r = await ghPost('/login/device/code', {
          client_id: env.GITHUB_CLIENT_ID,
          scope: 'read:user user:email',
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
        const email = await ghVerifiedEmail(r.access_token);
        const ghId = user.id ? String(user.id) : null;
        const existing = (ghId && await accountIdByIdp(env, 'github', ghId))
          ? true : await lookupHostedAccount(env, user.login);
        const account = existing ? await hostedAccountForGithub(env, user.login, email, ghId) : null;
        const sid = rand(24);
        // Store only the identity we actually use. The GitHub access token is
        // intentionally NOT persisted: nothing downstream reads session.token,
        // and keeping a token at rest for 30 days is needless exposure. The
        // verified email IS stored: it is the merge key (and what email-based
        // invites will match), attested by the provider, not user-typed.
        const session = {
          login: user.login,
          avatar_url: user.avatar_url,
          name: user.name || user.login,
          created: new Date().toISOString(),
          ...(account ? { account_id: account.account_id } : {}),
          ...(email ? { email } : {}),
          // Kept so a later token mint can link the identity even when this
          // sign-in found no account to attach it to yet.
          ...(ghId ? { idp: { provider: 'github', sub: ghId } } : {}),
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
      const key = inboxKey(actorKey(s));
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
      const key = inboxKey(actorKey(s));
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
      const key = inboxKey(actorKey(s));
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
      if (!actorKey(s)) return json({ error: 'sign_in_required' }, { status: 401 });
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
      await setDocStar(env, actorKey(s), slug, starred);
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
      const parentId = body.parent == null || body.parent === '' ? null : String(body.parent);
      if (parentId) {
        if (!state.folders.some((f) => f.id === parentId)) return json({ error: 'parent_not_found' }, { status: 404 });
        if (folderDepth(state, parentId) >= FOLDER_DEPTH_MAX) return json({ error: 'too_deep' }, { status: 400 });
      }
      // Names are unique among SIBLINGS (Drive semantics) — the same name
      // under two different parents is fine.
      if (state.folders.some((f) => (f.parent || null) === parentId && f.name.toLowerCase() === name.toLowerCase())) {
        return json({ error: 'duplicate_name' }, { status: 400 });
      }
      const folder = { id: `f_${Date.now()}_${rand(4)}`, name, created: new Date().toISOString(), ...(parentId ? { parent: parentId } : {}) };
      state.folders.push(folder);
      await saveFolderState(env, s.login, state);
      return json({ ok: true, folder: { id: folder.id, name: folder.name, parent: parentId } });
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
      if (state.folders.some((f) => f !== folder && (f.parent || null) === (folder.parent || null) && f.name.toLowerCase() === name.toLowerCase())) {
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
      const gone = state.folders.find((f) => f.id === id);
      if (!gone) return json({ error: 'not_found' }, { status: 404 });
      // Contents move UP ONE LEVEL — docs and subfolders reparent to the
      // deleted folder's parent (root when it had none). Documents are
      // never deleted by a folder deletion.
      const up = gone.parent || null;
      for (const [slug, fid] of Object.entries(state.docs)) {
        if (fid === id) {
          if (up) state.docs[slug] = up;
          else delete state.docs[slug];
        }
      }
      for (const f of state.folders) {
        if (f.parent === id) {
          if (up) f.parent = up;
          else delete f.parent;
        }
      }
      state.folders = state.folders.filter((f) => f.id !== id);
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
      const principal = sessionPrincipal(session);
      // Additive `hint` so a stale CLI that just prints the error body still
      // gets an actionable next step. A current CLI ran the device flow and
      // sent a session cookie, so it never lands here; one that hits this
      // without showing a device code is out of date. Fail-open: no new
      // rejection, just a clearer 401.
      if (!principal) return json({
        error: 'sign_in_required',
        hint: 'Hosted publish needs a GitHub sign-in. If your tdoc CLI did not show a device code to approve, it is out of date — run: /tdoc update --yes',
      }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      // session.email is the provider-attested address captured at sign-in —
      // passed as its own argument so nothing in the client-controlled body
      // can pose as it. This is what gives a brand-new publisher their email
      // merge key at the moment their account is minted.
      const issued = await issueHostedToken(env, { ...body, login }, session && session.email, session && session.idp);
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

    // Who the composer offers after `@`. Same gate as posting a comment: if
    // you cannot comment here, there is nobody for you to name.
    if (p === '/api/mentions' && method === 'GET') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      const slug = url.searchParams.get('slug');
      if (!slug || !isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const meta = await loadDocMeta(env, slug);
      const access = accessFromMeta(meta || {});
      if (!canReadDoc(access, s, env, meta)) return json({ error: 'access_denied' }, { status: 403 });
      if (!canCommentOnDoc(access, s, env, meta)) return json({ error: 'commenting_disabled' }, { status: 403 });
      const list = await readComments(env, slug);
      const me = sessionLogin(s);
      const users = mentionableUsers({
        ownerLogin: hostedGithubLogin(meta) || env.TDOC_OWNER,
        allowedUsers: access.allowed_users,
        participants: commentParticipants(list),
        includeAllowed: isAllowlisted(access, s, env, meta),
      }).filter((u) => u.login !== me);
      return json({ users });
    }

    if (p === '/api/comments' && method === 'POST') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, version, anchor, text: commentText, parent_id } = body;
      if (!slug || !commentText) return json({ error: 'slug and text required' }, { status: 400 });
      if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const meta = await loadDocMeta(env, slug);
      const access = accessFromMeta(meta || {});
      if (!canReadDoc(access, s, env, meta)) return json({ error: 'access_denied' }, { status: 403 });
      if (!canCommentOnDoc(access, s, env, meta)) return json({ error: 'commenting_disabled' }, { status: 403 });
      // login carries the actor key (a handle, or email:<addr>); name is what
      // readers see, and for an email identity that is the local part only —
      // the address itself never renders in a thread.
      const author = { login: actorKey(s), avatar_url: s.avatar_url || '', name: actorDisplayName(s) };
      const created = new Date().toISOString();
      const V = coerceBodyVersion(version);
      const ownerLogin = hostedGithubLogin(meta) || env.TDOC_OWNER;
      // Resolve @mentions BEFORE the write: the delivered list is stamped onto
      // the event, so a chip on the card is exactly the set that was notified.
      // Named logins come from the text, never from the request body.
      const priorList = await readComments(env, slug);
      const isDocOwner = isDocOwnerSession(env, s, meta);
      const outcome = classifyMentions(
        mentionCandidates(commentText).filter((login) => login !== actorKey(s)),
        {
          canRead: (login) => canReadDoc(access, { login }, env, meta),
          canInvite: isDocOwner,
          inviteBudget: Math.max(0, MENTION_INVITE_ALLOWLIST_MAX - access.allowed_users.length),
        },
      );
      const mentions = outcome.notified;
      // Who among them is new to this doc, and can the mention find them on
      // its own. Computed against the doc as it stood BEFORE the invite below
      // widened the allowlist, so an invitee still reads as a newcomer.
      outcome.newcomers = await describeNewcomers(env, {
        notified: outcome.notified,
        invited: outcome.invited,
        insiders: mentionableUsers({
          ownerLogin,
          allowedUsers: access.allowed_users,
          participants: commentParticipants(priorList),
        }).map((u) => u.login),
      });
      // An invite is a meta write, so it happens before the comment lands: a
      // notification whose link 403s is worse than no notification.
      if (outcome.invited.length) {
        const patched = applyAccessPatch(meta, {
          allowed_users: access.allowed_users.concat(outcome.invited),
        });
        if (patched.error) return json(patched, { status: 400 });
        await env.META.put(`meta:${slug}`, JSON.stringify(patched.meta));
      }
      // Serialized through the per-slug DO (mutation logic lives once in
      // applyCommentOp). create + reply are both id-stamped here so the
      // response is deterministic regardless of where the write runs.
      const op = parent_id
        ? { kind: 'reply', slug, parent_id, reply_id: `r_${Date.now()}_${rand(4)}`, author, text: commentText, mentions, version: V, at: created }
        : { kind: 'create', slug, id: `c_${Date.now()}_${rand(4)}`, author, text: commentText, mentions, anchor: anchor || null, version: V, at: created };
      const res = await mutateComments(env, slug, op);
      if (res.status === 200) {
        const title = (meta && meta.title) || slug;
        const commentId = parent_id ? op.reply_id : op.id;
        const threadId = parent_id ? (res.body && res.body.thread_id) : op.id;
        if (mentions.length) {
          await deliverInbox(env, null, {
            kind: 'mention', slug, version: V, comment_id: commentId,
            thread_id: threadId, target_id: commentId, mentions,
            actor: author, preview: commentText, title, at: created,
          });
        }
        if (!parent_id) {
          const owner = positionalRecipient(ownerLogin, mentions);
          if (owner) {
            await deliverInbox(env, owner, {
              kind: 'comment', slug, version: V, comment_id: op.id, thread_id: op.id,
              actor: author, preview: commentText, title, at: created,
            });
          }
        } else {
          const parentA = recordAuthor(priorList, parent_id);
          const parentLogin = positionalRecipient(parentA && parentA.login, mentions);
          if (parentLogin) {
            await deliverInbox(env, parentLogin, {
              kind: 'reply', slug, version: V, comment_id: op.reply_id,
              thread_id: res.body && res.body.thread_id, target_id: parent_id,
              actor: author, preview: commentText, title, at: created,
            });
          }
        }
      }
      // The composer needs to know what became of each name: an invite is
      // worth telling the owner about (they still have to send the link), and
      // a blocked name would otherwise fail silently.
      const body_out = res.status === 200 && res.body && typeof res.body === 'object'
        ? { ...res.body, mention_outcome: outcome }
        : res.body;
      return json(body_out, { status: res.status });
    }

    // Re-anchor a comment, or edit its text. Appends an `anchor_changed` /
    // `text_edited` event stamped at the current version, so OLDER versions
    // still resolve to the anchor and the words they were published with.
    //
    // The two differ in who may do them: re-anchor is the author's or the doc
    // owner's (canMutate), but an EDIT is the author's alone — rewriting
    // somebody else's words under their name is not a power a doc owner gets.
    if (p === '/api/comments' && method === 'PATCH') {
      const s = await getSession(env, req);
      if (!s) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, id, anchor, version } = body;
      if (typeof body.text === 'string') {
        const text = body.text.trim();
        if (!slug || !id || !text) return json({ error: 'slug, id, text required' }, { status: 400 });
        if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
        const list = await readComments(env, slug);
        ensureMigrated(list);
        const meta = await loadDocMeta(env, slug);
        const access = accessFromMeta(meta || {});
        if (!canReadDoc(access, s, env, meta)) return json({ error: 'access_denied' }, { status: 403 });
        // The target is a top-level comment or a reply; either way the record
        // that carries the author is the one that has to match the session.
        const target = findRecord(list, id);
        if (!target) return json({ error: 'not_found' }, { status: 404 });
        if (!isRecordAuthor(target, s)) return json({ error: 'not_author' }, { status: 403 });
        const V = coerceBodyVersion(version);
        const res = await mutateComments(env, slug, {
          kind: 'edit_text', slug, id, text, version: V, actor: { login: actorKey(s) },
        });
        return json(res.body, { status: res.status });
      }
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
        kind: 'patch_anchor', slug, id, anchor, reset_status: true, version: V, actor: { login: actorKey(s) },
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
    //
    // The author's — mayDelete, not canMutate. A doc owner used to be able to
    // delete anybody's comment here, which is the wrong power to hand the
    // person being reviewed: taking someone's words off the page is theirs to
    // do. The one thing an owner still reaches is an AGENT's comment, because
    // the agent wrote it with the owner's own upload token. What is gone is
    // silencing a reader; what is kept is clearing what your tools said.
    //
    // ?version=N to stamp the delete at a specific version (defaults to
    // Infinity, meaning "delete forward from now" which the overlay supplies
    // as the current view's version).
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
      const target = findRecord(authList, id);
      if (!target) return json({ error: 'not_found' }, { status: 404 });
      const meta = await loadDocMeta(env, slug);
      if (!mayDelete(target, s, env, meta)) return json({ error: 'not_author' }, { status: 403 });
      const res = await mutateComments(env, slug, {
        kind: 'delete', slug, id, version: stampVersion, actor: { login: actorKey(s) },
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
      // One answer per human turn. A round that re-reads comments.json after
      // somebody deleted the agent's reply would otherwise post the same words
      // in the same place; the log remembers what the fold forgot. `force`
      // exists for the caller that means it — nothing in /tdoc edit sets it.
      const gate = agentReplyGate(parent, agent.login);
      if (!gate.allowed && body.force !== true) {
        return json({
          ok: true, skipped: true, reason: gate.reason,
          parent_id, thread_id: parent.id,
        });
      }
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

    // ---- explicit browser save (owner/latest only in the shell) ----
    if (p === '/api/doc/versions' && method === 'POST') {
      if (!env.COMMENTS) return json({ error: 'version_store_unavailable' }, { status: 503 });
      const maxBytes = hostedMaxUploadBytes(env);
      const contentLength = Number(req.headers.get('content-length') || 0);
      if (contentLength && (!Number.isFinite(contentLength) || contentLength > maxBytes + 64 * 1024)) {
        return json({ error: 'payload_too_large', limit: maxBytes }, { status: 413 });
      }
      let body = {};
      try { body = await req.json(); } catch {}
      const slug = body && body.slug;
      const baseVersion = Number(body && body.baseVersion);
      const doc = body && body.html;
      if (!isValidSlug(slug) || !Number.isInteger(baseVersion) || baseVersion < 1 || typeof doc !== 'string') {
        return json({ error: 'slug, baseVersion, html required' }, { status: 400 });
      }
      const size = utf8ByteLength(doc);
      if (size > maxBytes) return json({ error: 'payload_too_large', limit: maxBytes, size }, { status: 413 });
      if (!/<html[\s>]/i.test(doc) || !/<body[\s>]/i.test(doc)) {
        return json({ error: 'invalid_document_html' }, { status: 400 });
      }
      if (/data-tdoc-provider|id=["']tdoc-frame-probe["']/i.test(doc)) {
        return json({ error: 'provider_markup_forbidden' }, { status: 400 });
      }
      const auth = await authorizeOwnerMutation(req, env, slug);
      if (!auth.ok) return auth.response;
      const result = await createBrowserVersion(env, slug, {
        baseVersion,
        html: doc,
        actorLogin: sessionLogin(auth.session) || '',
      });
      return json(result.body, { status: result.status });
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
      const { html: stampedHtml, aids, sha: uploadSha } = await prepareDocVersion(doc);
      // Tier-1 client visibility: the server is the only place guaranteed to
      // see every publish, so the version entry records which client produced
      // it. The self-update machinery has failed silently in seven distinct
      // ways; this is the observability that does not depend on it.
      const clientVersion = (req.headers.get('x-tdoc-client') || '').slice(0, 64) || null;
      const r2Key = `docs/${slug}/v${verNum}/index.html`;
      const incomingLatest = latestVersionNumber(incoming);
      const writesLatestMeta = !!incoming && (incomingLatest === 0 || verNum === incomingLatest);
      let versionReservation = null;
      const remoteLatest = latestVersionNumber(writeGate.meta);
      if (writeGate.meta && verNum <= remoteLatest) {
        const existing = await env.DOCS.get(r2Key);
        const existingHtml = existing ? await existing.text() : null;
        // Old-version uploads are best-effort repairs, never rewrites. This is
        // what prevents a stale local v8 from replacing a browser-created v8
        // while the CLI walks its historical versions before uploading v9.
        if (existingHtml != null && existingHtml !== stampedHtml) {
          return json({ error: 'version_conflict', baseVersion: verNum - 1, latestVersion: remoteLatest }, { status: 409 });
        }
      }
      if (writesLatestMeta && writeGate.meta && env.COMMENTS && verNum > remoteLatest) {
          if (verNum !== remoteLatest + 1) {
            return json({ error: 'version_conflict', baseVersion: verNum - 1, latestVersion: remoteLatest }, { status: 409 });
          }
          const lock = await versionReservationOp(env, slug, { kind: 'reserve', baseVersion: remoteLatest });
          if (!lock.ok) return json({ error: lock.error || 'version_conflict', ...lock }, { status: lock.status || 409 });
          versionReservation = { id: lock.id, next: lock.next };
      }
      const finishVersionReservation = async (committed) => {
        if (!versionReservation) return;
        const reservation = versionReservation;
        versionReservation = null;
        const result = await versionReservationOp(env, slug, { kind: 'finish', reservation, committed });
        if (!result.ok) throw new Error(result.message || result.error || 'version_lock_finalize_failed');
      };
      const abortVersionWrite = async (body, status) => {
        try { await finishVersionReservation(false); } catch {}
        return json(body, { status });
      };
      try {
        await env.DOCS.put(r2Key, stampedHtml, {
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
        });
      } catch (e) {
        try { await finishVersionReservation(false); } catch {}
        console.error('[upload] R2 put failed:', e.message);
        return json({ error: 'r2_put_failed', message: e.message }, { status: 500 });
      }
      // Verify the write actually landed before we tell the caller "ok".
      // The previous handler returned ok: true even when the binding was
      // silently dropping writes — leaving us with KV meta but no R2 doc.
      const verify = await env.DOCS.head(r2Key);
      if (!verify) {
        try { await finishVersionReservation(false); } catch {}
        console.error('[upload] R2 write did not persist:', r2Key);
        return json({ error: 'r2_write_lost', message: 'PUT succeeded but the key is not readable. Re-deploy the worker; the R2 binding may be stale.' }, { status: 500 });
      }
      const widgets = body.widgets;
      if (widgets != null) {
        if (typeof widgets !== 'object' || Array.isArray(widgets)) {
          return abortVersionWrite({ error: 'widgets must be an object of name → html' }, 400);
        }
        const names = Object.keys(widgets);
        if (names.length > 32) return abortVersionWrite({ error: 'too many widgets' }, 400);
        for (const wname of names) {
          if (!isValidWidgetName(wname)) return abortVersionWrite({ error: 'invalid_widget_name', name: wname }, 400);
          const whtml = widgets[wname];
          if (typeof whtml !== 'string') return abortVersionWrite({ error: 'widget html must be a string', name: wname }, 400);
          if (whtml.length > 512 * 1024) return abortVersionWrite({ error: 'widget too large', name: wname }, 400);
          const wKey = `docs/${slug}/v${verNum}/widgets/${wname}.html`;
          try {
            await env.DOCS.put(wKey, whtml, {
              httpMetadata: { contentType: 'text/html; charset=utf-8' },
            });
          } catch (e) {
            try { await finishVersionReservation(false); } catch {}
            console.error('[upload] R2 widget put failed:', e.message);
            return json({ error: 'r2_put_failed', message: e.message }, { status: 500 });
          }
        }
      }
      if (incoming && writesLatestMeta) {
        try {
          // Remote storage is authoritative. Preserve versions that a browser
          // editor may have created since this local checkout was last pulled.
          const currentMeta = await loadDocMeta(env, slug);
          const versionByNumber = new Map();
          for (const item of (Array.isArray(currentMeta && currentMeta.versions) ? currentMeta.versions : [])) {
            versionByNumber.set(Number(item.n), item);
          }
          for (const item of (Array.isArray(incoming.versions) ? incoming.versions : [])) {
            const number = Number(item.n);
            if (!versionByNumber.has(number) || number === verNum) versionByNumber.set(number, item);
          }
          if (!versionByNumber.has(verNum)) {
            versionByNumber.set(verNum, { n: verNum, created: new Date().toISOString() });
          }
          // The entry for the version whose bytes this request just stored
          // records the hash of those bytes and the client that sent them.
          const storedEntry = { ...versionByNumber.get(verNum), sha: uploadSha };
          if (clientVersion) storedEntry.client = clientVersion;
          versionByNumber.set(verNum, storedEntry);
          const mergedVersions = [...versionByNumber.values()]
            .filter((item) => Number.isInteger(Number(item && item.n)) && Number(item.n) > 0)
            .sort((a, b) => Number(a.n) - Number(b.n));
          await env.META.put(`meta:${slug}`, JSON.stringify({
            ...(currentMeta || {}),
            ...incoming,
            versions: mergedVersions,
          }));
        } catch (e) {
          try { await finishVersionReservation(false); } catch {}
          console.error('[upload] META put failed:', e.message);
          return json({ error: 'meta_put_failed', message: e.message || String(e) }, { status: 500 });
        }
        try {
          await finishVersionReservation(true);
        } catch (e) {
          // META is the commit point, matching browser Save. A later request
          // repairs the cursor from META; never report this committed version
          // as failed and invite an unsafe retry.
          console.error('[upload] version cursor finalize failed (recoverable):', e.message || String(e));
        }
      } else {
        // History backfill (re-uploading v1..vN-1) stores freshly-prepared
        // bytes but skips the latest-meta merge above — without this, the
        // entry keeps a sha for bytes that no longer exist, and /raw serves a
        // stale ETag after a reader-template generation change. Refresh just
        // this entry; touch nothing else in meta.
        try {
          const currentMeta = await loadDocMeta(env, slug);
          const entry = (Array.isArray(currentMeta && currentMeta.versions) ? currentMeta.versions : [])
            .find((v) => Number(v.n) === verNum);
          if (entry && (entry.sha !== uploadSha || (clientVersion && entry.client !== clientVersion))) {
            entry.sha = uploadSha;
            if (clientVersion) entry.client = clientVersion;
            await env.META.put(`meta:${slug}`, JSON.stringify(currentMeta));
          }
        } catch (e) {
          // The bytes are stored and correct; a stale recorded sha costs at
          // worst one spurious /raw re-download. Never fail the upload for it.
          console.error('[upload] backfill sha refresh failed (recoverable):', e.message || String(e));
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
      // `sha` is the hash of the exact stored bytes (post-bake, post-stamp). The
      // client records it so a later edit can ask "has remote moved since I
      // published?" with one HEAD request instead of re-downloading the doc.
      return json({ ok: true, url: `/d/${slug}/v/${verNum}`, size: verify.size, aids: aids.length, sha: uploadSha, mergedComments: mergedLocal });
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

    // ---- rename ----
    // A title is a property of the document, not of its text: renaming edits
    // the meta record and leaves the body and the version history alone. The
    // alternative — rewriting the document's heading — mangles documents whose
    // first h1 is not their title (tdoc-start's is a tagline), and turns
    // changing a display name into publishing a new version (#383).
    if (p === '/api/doc/title' && method === 'PATCH') {
      const TITLE_PATCH_MAX_BYTES = 4 * 1024;
      const clRaw = req.headers.get('content-length');
      if (clRaw != null && clRaw !== '') {
        const cl = Number(clRaw);
        if (!Number.isFinite(cl) || cl < 0 || cl > TITLE_PATCH_MAX_BYTES) {
          return json({ error: 'payload_too_large' }, { status: 413 });
        }
      }
      let body = {};
      try { body = await req.json(); } catch {}
      const unknownTop = Object.keys(body || {}).filter((k) => k !== 'slug' && k !== 'title');
      if (unknownTop.length) return json({ error: 'invalid_field', fields: unknownTop }, { status: 400 });
      const { slug, title } = body || {};
      if (!slug) return json({ error: 'slug required' }, { status: 400 });
      if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const clean = typeof title === 'string' ? title.trim() : '';
      if (!clean) return json({ error: 'title_required' }, { status: 400 });
      if (clean.length > 120) return json({ error: 'title_too_long', limit: 120 }, { status: 400 });
      const auth = await authorizeOwnerMutation(req, env, slug);
      if (!auth.ok) return auth.response;
      const meta = auth.meta || await loadDocMeta(env, slug);
      if (!meta) return json({ error: 'not_found' }, { status: 404 });
      await env.META.put(`meta:${slug}`, JSON.stringify({ ...meta, title: clean }));
      return json({ ok: true, slug, title: clean });
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
