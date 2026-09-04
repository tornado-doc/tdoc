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
  // The retry link points back at what was requested: a versioned URL when
  // the caller was asked for one, the doc's head URL (which resolves to the
  // latest version only after this same gate passes) when it wasn't. The
  // head form is what keeps a denial from disclosing any version number.
  const next = !slug ? '/'
    : version ? `/d/${encodeURIComponent(slug)}/v/${version}`
    : `/d/${encodeURIComponent(slug)}`;
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
        body: 'This document is private. Sign in, then open the link again. Only invited accounts can read it.',
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
const TDOC_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="69.36 111.36 259.28 214.28" role="img" aria-label="tdoc">
  <!-- Cropped to the drawing for the same reason the logo is: at a 16px tab
       slot a baked-in margin leaves the strokes too thin to separate.
       A tab strip is dark in dark mode and a favicon has no surrounding text
       to inherit from, so the swap is explicit rather than currentColor. -->
  <style>
    g { stroke: #101219; }
    @media (prefers-color-scheme: dark) { g { stroke: #f5f5f5; } }
  </style>
  <g fill="none" stroke-width="10.5" stroke-linecap="round">
    <path d="M 88.5 171.5 L 309.5 130.5"/>
    <path d="M 122.5 200.5 L 279.5 169.5"/>
    <path d="M 148.5 222 L 278.5 222"/>
    <path d="M 158.5 271.5 L 255 252.5"/>
    <path d="M 180.5 306.5 L 243 291.5"/>
  </g>
</svg>`;

const TDOC_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="69.36 111.36 259.28 214.28" role="img" aria-label="tdoc">
  <!-- The viewBox is the drawing's own bounds (stroke included) plus 6%. The
       source file is a 436 square with the lines floating inside it; carrying
       that margin would leave the mark about half the box at the 24px bar and
       the 16px tab slot, where the strokes wash out. Consumers add their own
       padding in CSS; the file should not.

       No background field, and the ink is currentColor: an inlined copy
       follows the surrounding text, and the <img> copies (which cannot see
       the page's color) render near-black and are flipped to light by the
       reader chrome's dark-mode invert — that is what data-tdoc-dark="invert"
       on those <img> tags asks for. assets/tdoc_logo_square*.svg keep the
       filled square lockup for places with a field of their own. -->
  <g fill="none" stroke="currentColor" stroke-width="10.5" stroke-linecap="round">
    <path d="M 88.5 171.5 L 309.5 130.5"/>
    <path d="M 122.5 200.5 L 279.5 169.5"/>
    <path d="M 148.5 222 L 278.5 222"/>
    <path d="M 158.5 271.5 L 255 252.5"/>
    <path d="M 180.5 306.5 L 243 291.5"/>
  </g>
</svg>
`;
const TDOC_LOGO_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAACcQAAAnECAIAAAChEWJqAAAQAElEQVR4nOzZMQ0AIBAAMULwb/mZCSehtdEzMwsAAAAAAACA114AAAAAAAAAfGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAU+q55AAAEABJREFUAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAABJkKAAAAAAAAEGQqAAAAAAAAQJCpAAAAAAAAAEGmAgAAAAAAAASZCgAAAAAAABBkKgAAAAAAAECQqQAAAAAAAABBpgIAAAAAAAAEmQoAAAAAAAAQZCoAAAAAAABAkKkAAAAAAAAAQaYCAAAAAAAA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DAAAAAArSUwFAAAAAAAACK8NAAAAAAAAADxFTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAADAAAAABPE1MBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQBEkPPpAAAQAElEQVQAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEMRUAAAAAAAAgCCmAgAAAAAAAAQxFQAAAAAAACCIqQAAAAAAAABBTAUAAAAAAAAIYioAAAAAAABAEFMBAAAAAAAAgpgKAAAAAAAAEP5mzw4EAAAAAAT5Wy8wQmkkUwEAAAAAAACGTAUAAAAAAAAYMhUAAAAAAABgyFQAAAAAAACAIVMBAAAAAAAAhkwFAAAAAAAAGDIVAAAAAAAAYMhUAAAAAAAAgCFTAQAAAAAAAIZMBQAAAAAAABgyFQAAAAAAAGDIVAAAAAAAAIAhUwEAAAAAAACGTAUAAAAAfPgX0wAAAFJJREFUAAAYMhUAAAAAAABgyFQAAAAAAACAIVMBAAAAAAAAhkwFAAAAAAAAGDIVAAAAAAAAYMhUAAAAAAAAgCFTAQAAAAAAAIZMBQAAAAAAABgBAAD//0HXNC8AAAAGSURBVAMAvY/9hhbaGHEAAAAASUVORK5CYII=';
// Add to Home Screen never reads the SVG favicon: iOS takes apple-touch-icon,
// Android takes the manifest's PNGs. Both sit on the reader's wallpaper, so
// unlike the mark itself they carry a field (assets/*.png, drawn from
// assets/tdoc_logo.svg at 68% of the box so the maskable safe zone holds).
const TDOC_HOME_ICONS = {
  '/apple-touch-icon.png': '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',
  '/icon-192.png': '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',
  '/icon-512.png': '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CAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAgFAEAAKEIAAAIRQAAQCgCAABCEQAAEIoAAIBQBAAAhCIAACAUAQAAoQgAAAhFAABAKAIAAEIRAAAQigAAgFAEAACEIgAAIBQBAAChCAAACEUAAEAoAgAAQhEAABCKAACAUAQAAIQiAAAg1P8DAAD//wB/DyoAAAAGSURBVAMAr0OeL5Wly2kAAAAASUVORK5CYII=',
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

// Privacy-minimized product events for the hosted onboarding funnel. Workers
// Logs supplies request diagnostics and Analytics Engine supplies aggregate
// counters; neither product payload carries an account, login, email, IP,
// slug, token, cookie, session or installation identifier. Keep the allowlists
// here at the provider boundary so a caller cannot smuggle arbitrary request
// fields into persisted telemetry.
const PRODUCT_EVENTS = new Set([
  'onboarding_started',
  'onboarding_approved',
  'token_minted',
  'publish_succeeded',
]);
const PRODUCT_AUTH_PATHS = new Set(['pair', 'session']);
function productEvent(env, name, fields = {}) {
  if (!PRODUCT_EVENTS.has(name)) return;
  const event = { type: 'tdoc_product_event', schema: 1, event: name };
  if (PRODUCT_AUTH_PATHS.has(fields.auth_path)) event.auth_path = fields.auth_path;
  if (typeof fields.first_publish === 'boolean') event.first_publish = fields.first_publish;
  if (
    typeof fields.client_version === 'string'
    && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(fields.client_version)
  ) event.client_version = fields.client_version;
  console.log(JSON.stringify(event));
  // Ordered Analytics Engine schema:
  //   blob1 event, blob2 auth path, blob3 client version
  //   double1 count, double2 first-publish count
  // Writes are non-blocking. Observability must never make a user operation
  // fail, including in a BYOK deployment whose binding is absent or broken.
  try {
    if (env && env.PRODUCT_ANALYTICS) {
      env.PRODUCT_ANALYTICS.writeDataPoint({
        indexes: [event.event],
        blobs: [event.event, event.auth_path || '', event.client_version || ''],
        doubles: [1, event.first_publish === true ? 1 : 0],
      });
    }
  } catch (_) {}
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
    signin: 'Sign in to continue.',
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
  const ownerDisplay = (row) => {
    if (row.owner) return row.owner;
    // Email-owned docs have no handle; show the owner's local part, never
    // the address.
    const key = normalizeActorKey(row.meta && row.meta.hosted && row.meta.hosted.owner_key);
    return key && key.startsWith('email:') ? key.slice(6).split('@')[0] : '';
  };
  const publicRow = (row) => ({
    slug: row.slug,
    title: row.title,
    latest: row.latest,
    created: row.created,
    updated: row.updated,
    owner: ownerDisplay(row),
    // Computed here because only the server can compare canonical identities;
    // the client comparing display keys went quietly wrong for every session
    // shape that is not a bare handle.
    mine: isDocOwnerSession(env, session, row.meta),
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
      // A person and an agent both write these events, and they mean different
      // things. An agent's carries a verdict, which the fold turns into the
      // ✅/🟡/❓ reaction below; a person's is a decision, so it must not put an
      // emoji in their name. `human` is what tells them apart — absent on every
      // event written before people could resolve, which is why the agent path
      // stays the default.
      case 'marked_applied':
        snap.status = 'applied';
        snap.applied_in = e.applied_in || e.at_version;
        snap.resolved_by = e.human ? (e.by || '') : '';
        snap._agentVerdict = e.human ? null : (e.agent_status || 'applied');
        snap._agentActor = e.by || 'tdoc-agent';
        break;
      case 'marked_open':
        snap.status = 'open';
        snap.applied_in = undefined;
        snap.resolved_by = '';
        snap._agentVerdict = e.human ? null : (e.agent_status || null);
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
//   hosted-account:<login>        → account_id   the CURRENT holder's record,
//       never proof by itself: a GitHub login can be RENAMED and the old name
//       becomes available for anyone to register. Every live record carries
//       its numeric id (backfilled via scripts/backfill-github-identities.mjs
//       for the ones that predated the index), so resolution never rests on
//       the handle alone.
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

async function accountIdpRecord(env, provider, sub) {
  const key = idpKey(provider, sub);
  if (!key || !env || !env.META) return null;
  try {
    const rec = JSON.parse(await env.META.get(key));
    if (rec && typeof rec.account_id === 'string' && rec.account_id) return rec;
  } catch {}
  return null;
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
    // Merge, never rewrite: the bridge stores the verified GitHub handle on
    // this record so later sign-ins can restore session.login, and a
    // fixed-two-field rewrite here erased it on the next token mint — at
    // which point every legacy doc quietly vanished from that person's /me.
    // Same lesson the hosted-account record already learned above.
    let prev = null;
    try { prev = JSON.parse(await env.META.get(key)); } catch {}
    const keep = prev && prev.account_id === account.account_id ? prev : null;
    await env.META.put(key, JSON.stringify({
      ...(keep || {}),
      account_id: account.account_id,
      created: (keep && keep.created) || now,
      ...(handle ? { handle } : {}),
    }));
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
    }
    // Unknown id: they start clean. The handle index may still name an
    // account, but it was written for whoever held this handle BEFORE, and a
    // freed GitHub name can be registered by anyone. There used to be a
    // claim-by-handle window here for legacy records with no recorded id —
    // retired once every live record was backfilled with its numeric id
    // (scripts/backfill-github-identities.mjs), because the window could not
    // tell a returning owner from a squatter wearing the freed name.
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
    ...(!github_login && normalizeEmail(account.email) ? { email: normalizeEmail(account.email) } : {}),
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
  return { kind: 'hosted', account_id: record.account_id, token_hash: tokenHash, github_login, email: normalizeEmail(record.email) };
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
  // The owner's actor key, whatever shape their identity is. Without this an
  // email-born account's doc had no owner anyone could route to, and every
  // comment notification fell through to the worker operator.
  const key = actor.github_login || (actor.email ? `email:${actor.email}` : null);
  if (key) hosted.owner_key = key;
  // Authoritative either way: a client-supplied meta.hosted.owner_key must
  // not survive a token that cannot vouch for one.
  else delete hosted.owner_key;
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
// A deliberate email tag: "@dana@example.com". The leading @ is the summons;
// a bare address in prose ("write to dana@example.com") stays plain text —
// writing someone's address is not the same act as calling them into the
// thread. Matched before the handle pass so "@dana@example.com" cannot be
// half-read as a mention of a GitHub user named dana.
const EMAIL_MENTION_RE = /(^|[^A-Za-z0-9_@\/-])@([^\s@]+@[^\s@]+\.[^\s@]+)/g;

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

// The logins a single comment may act on: parsed in the order they were
// typed, deduped, and capped.
function mentionCandidates(text) {
  return parseMentionLogins(text).slice(0, MENTION_MAX_PER_COMMENT);
}

// Everyone who has written on this doc, newest record last. Reads the raw
// event log rather than a snapshot so the author of a DELETED comment still
// counts as someone you can talk to.
// Who owns this doc, as an actor key — handle-shaped or email-shaped. The
// operator fallback stays for legacy/BYOK docs that predate ownership stamps.
function ownerActorKey(meta, env) {
  const stamped = normalizeActorKey(meta && meta.hosted && meta.hosted.owner_key);
  return hostedGithubLogin(meta) || stamped || (env && env.TDOC_OWNER) || '';
}

function commentParticipants(list) {
  const byLogin = new Map();
  const push = (author) => {
    const login = normalizeActorKey(author && author.login);
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
    const login = normalizeActorKey(entry && entry.login);
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
  const n = normalizeActorKey(login);
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
  const inside = new Set(insiders.map(normalizeActorKey).filter(Boolean));
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
    case 'set_status': {
      // Authorization is enforced UPSTREAM (canMutate needs session+env); the
      // DO only serializes the write. The event id for both status kinds is
      // `status:<version>`, so a thread has exactly one status per version and
      // resolve/reopen converge no matter how they interleave.
      const target = list.find(c => c.id === op.id);
      if (!target) return { status: 404, body: { error: 'not_found' } };
      const by = (op.actor && op.actor.login) || '';
      appendEvent(target, op.resolved
        ? { kind: 'marked_applied', at_version: op.version, at: now, applied_in: op.version, by, human: true }
        : { kind: 'marked_open', at_version: op.version, at: now, by, human: true });
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
        // register. Resolve on the id, and ONLY the id — the handle fallback
        // for pre-index accounts is retired (records were backfilled with
        // their numeric ids), because it handed a freed handle's account to
        // whoever registered the name next.
        const ghId = user.id ? String(user.id) : null;
        const existing = !!(ghId && await accountIdByIdp(env, 'github', ghId));
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
        const notice = sessionPrincipal(s) ? 'me' : 'signin';
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
        body = wrapBareTables(body);
        if (body.indexOf('id="tdoc-reader-patch"') === -1) {
          const ptag = `<style id="tdoc-reader-patch">${READER_PATCH_CSS}</style>`;
          // Anchor on the OPENING tag. The baked reader CSS carries a comment
          // that quotes `</head>` literally, so a first-match replace on the
          // closing tag drops the style inside that comment, where it is inert
          // and invisible — it took a byte-level look at the response to see.
          // A document's real <head> necessarily precedes any prose quoting it.
          body = /<head[^>]*>/i.test(body)
            ? body.replace(/<head[^>]*>/i, (open) => `${open}${ptag}`)
            : ptag + body;
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

    // ---- doc head → latest version ----
    // A bare /d/<slug> link (no /v/<n>) is what people naturally paste as the
    // canonical URL, but only versioned routes existed, so it bounced to the
    // not-found landing while every /v/<n> of the same doc worked. Redirect to
    // the latest version. Access is enforced BEFORE the redirect, so an
    // unauthorized probe gets the same denial screen as /v/<n> and never
    // learns the version count; unknown slugs fall through to the existing
    // not-found landing redirect.
    const docHeadMatch = p.match(/^\/d\/([^/]+)\/?$/);
    if (docHeadMatch && (method === 'GET' || method === 'HEAD')) {
      const slug = docHeadMatch[1];
      // No version was requested, so none is passed: a denial's retry link
      // is this same head URL, and an unauthorized probe learns nothing —
      // not even the version count. On success the gate's own meta yields
      // the redirect target (one KV read, not two).
      const gate = await enforceDocAccess(env, req, slug, null);
      if (!gate.ok) return gate.response;
      const latest = latestVersionNumber(gate.meta);
      if (latest > 0) return redirectTo(`/d/${encodeURIComponent(slug)}/v/${latest}`);
      // Unknown slug → the existing not-found landing redirect below.
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
      if (res.ok && method === 'GET' && actorKey(res.session)) {
        const record = recordDocVisit(env, actorKey(res.session), slug).catch(() => {});
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
      if (!sessionPrincipal(session)) return json({ error: 'sign_in_required' }, { status: 401 });
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
        const acct = sessionLogin(session)
        ? await hostedAccountForGithub(env, session.login, session && session.email,
            session && session.idp && session.idp.provider === 'github' ? session.idp.sub : null)
        : await hostedAccountForEmail(env, session && session.email, session && session.idp);
        if (!acct) return json({ error: 'hosted_account_unavailable' }, { status: 503 });
        actor = { kind: 'hosted', account_id: acct.account_id, github_login: acct.github_login,
          // Without this an email-born account's browser-created doc had no
          // routable owner — the very path most email users take first.
          email: normalizeEmail((acct && acct.email) || (session && session.email)) };
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
      if (!sessionPrincipal(session)) return json({ error: 'sign_in_required' }, { status: 401 });
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
        const acct = sessionLogin(session)
        ? await hostedAccountForGithub(env, session.login, session && session.email,
            session && session.idp && session.idp.provider === 'github' ? session.idp.sub : null)
        : await hostedAccountForEmail(env, session && session.email, session && session.idp);
        if (!acct) return json({ error: 'account_copy_unavailable' }, { status: 403 });
        actor = { kind: 'hosted', account_id: acct.account_id, github_login: acct.github_login,
          // Without this an email-born account's browser-created doc had no
          // routable owner — the very path most email users take first.
          email: normalizeEmail((acct && acct.email) || (session && session.email)) };
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
        identity: sessionPrincipal(s) ? { login: actorKey(s), avatar_url: s.avatar_url || '', name: actorDisplayName(s) } : null,
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
      if (hostedRegistrationEnabled(env, url.origin)) {
        productEvent(env, 'onboarding_started', { auth_path: 'pair' });
      }
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
      productEvent(env, 'token_minted', { auth_path: 'pair' });
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
      if (hostedRegistrationEnabled(env, url.origin)) {
        productEvent(env, 'onboarding_approved', { auth_path: 'pair' });
      }
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
      // The provider remembers its own session, so a returning visitor is
      // signed straight through — correct as a default, bewildering when you
      // meant to pick a different method. prompt=login is the standard OIDC
      // lever that forces the chooser; whitelisted so the param can't smuggle
      // anything else.
      if (url.searchParams.get('prompt') === 'login') auth.searchParams.set('prompt', 'login');
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
        const idpRec = sub ? await accountIdpRecord(env, 'oidc', sub) : null;
        let account_id = idpRec ? idpRec.account_id : null;
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
            // The numeric id, and only the numeric id — the claim-by-handle
            // window for records with no recorded id is retired (records were
            // backfilled), same as the direct GitHub flow.
            if (bridged.ghId) account_id = await accountIdByIdp(env, 'github', bridged.ghId);
            if (account_id) {
              // Write the links NOW, not at mint: the whole point is that the
              // very next sign-in resolves exactly, and this person may read
              // and comment for weeks before they ever mint a token.
              let rec = bridged.handle ? await lookupHostedAccount(env, bridged.handle) : null;
              if (!rec || rec.account_id !== account_id) rec = { account_id, created: new Date().toISOString() };
              if (bridged.ghId) rec = await linkIdentity(env, rec, { provider: 'github', sub: bridged.ghId, email, handle: bridged.handle || undefined });
              rec = await linkIdentity(env, rec, { provider: 'oidc', sub, email });
              // The verified handle rides on the oidc link so every LATER
              // sign-in (which resolves by sub and never re-runs the bridge)
              // can restore it into the session.
              await env.META.put(idpKey('oidc', sub), JSON.stringify({
                account_id, created: new Date().toISOString(), handle: bridged.handle || undefined,
              }));
              if (bridged.handle) await env.META.put(`hosted-account:${bridged.handle}`, JSON.stringify(rec));
            }
          }
        }
        // Self-heal: a linkIdentity rewrite used to strip the handle off the
        // idp record (fixed there), and any record damaged while that bug was
        // live would strand its owner in login-less sessions forever — legacy
        // docs gone from /me, old comments no longer theirs. A record that
        // resolves but carries no handle gets one more question to the
        // provider, and the answer is written back so the heal is permanent.
        // For an account with no GitHub connected this asks once per sign-in
        // and learns nothing — a sign-in is rare enough for that to be fine.
        if (idpRec && account_id && !normalizeGithubLogin(idpRec.handle)) {
          const gh = await clerkExternalGithub(env, sub);
          if (gh && gh.handle) {
            // Restore only what this account already owns: the handle must
            // resolve to THIS account, and if the account records a stable
            // GitHub owner it must be the id the provider just attested — a
            // recycled name pointing anywhere else stays where it is.
            const named = await lookupHostedAccount(env, gh.handle);
            const ghOwner = named && (named.identities || []).find((i) => i && i.provider === 'github');
            if (named && named.account_id === account_id
                && (!ghOwner || !gh.ghId || String(ghOwner.sub) === String(gh.ghId))) {
              idpRec.handle = gh.handle;
              await env.META.put(idpKey('oidc', sub), JSON.stringify(idpRec));
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
          // A bridged legacy user gets their verified handle as the session
          // login, so their actor key stays handle-shaped: old comments stay
          // editable, handle invites keep matching, @handle still reaches
          // them. Truthful — the provider attested which GitHub account this
          // person connected.
          ...((account_id && ((bridged && bridged.handle) || (idpRec && normalizeGithubLogin(idpRec.handle))))
            ? { login: (bridged && bridged.handle) || normalizeGithubLogin(idpRec.handle) } : {}),
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
        // Id only, same as the web callback: the handle fallback is retired.
        const existing = !!(ghId && await accountIdByIdp(env, 'github', ghId));
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
      if (!actorKey(s)) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const name = validFolderName(body.name);
      if (!name) return json({ error: 'invalid_name' }, { status: 400 });
      const state = await loadFolderState(env, actorKey(s));
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
      await saveFolderState(env, actorKey(s), state);
      return json({ ok: true, folder: { id: folder.id, name: folder.name, parent: parentId } });
    }

    if (p === '/api/folders' && method === 'PATCH') {
      const s = await getSession(env, req);
      if (!actorKey(s)) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const name = validFolderName(body.name);
      if (!name) return json({ error: 'invalid_name' }, { status: 400 });
      const state = await loadFolderState(env, actorKey(s));
      const folder = state.folders.find((f) => f.id === body.id);
      if (!folder) return json({ error: 'not_found' }, { status: 404 });
      if (state.folders.some((f) => f !== folder && (f.parent || null) === (folder.parent || null) && f.name.toLowerCase() === name.toLowerCase())) {
        return json({ error: 'duplicate_name' }, { status: 400 });
      }
      folder.name = name;
      await saveFolderState(env, actorKey(s), state);
      return json({ ok: true, folder: { id: folder.id, name: folder.name } });
    }

    if (p === '/api/folders' && method === 'DELETE') {
      const s = await getSession(env, req);
      if (!actorKey(s)) return json({ error: 'sign_in_required' }, { status: 401 });
      const id = url.searchParams.get('id');
      const state = await loadFolderState(env, actorKey(s));
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
      await saveFolderState(env, actorKey(s), state);
      return json({ ok: true });
    }

    if (p === '/api/folders/move' && method === 'POST') {
      const s = await getSession(env, req);
      if (!actorKey(s)) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const folderId = body.folder == null ? null : String(body.folder);
      const slugs = Array.isArray(body.slugs) ? body.slugs : [];
      if (!slugs.length || slugs.length > 100 || !slugs.every((x) => typeof x === 'string' && isValidSlug(x))) {
        return json({ error: 'invalid_slugs' }, { status: 400 });
      }
      const state = await loadFolderState(env, actorKey(s));
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
      await saveFolderState(env, actorKey(s), state);
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
        hint: 'Hosted publish needs a sign-in. If your tdoc CLI did not show a code to approve, it is out of date — run: /tdoc update --yes',
      }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      // session.email is the provider-attested address captured at sign-in —
      // passed as its own argument so nothing in the client-controlled body
      // can pose as it. This is what gives a brand-new publisher their email
      // merge key at the moment their account is minted.
      const issued = await issueHostedToken(env, { ...body, login }, session && session.email, session && session.idp);
      if (issued.error) return json({ error: issued.error }, { status: issued.status || 401 });
      productEvent(env, 'token_minted', { auth_path: 'session' });
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
      const me = actorKey(s);
      const users = mentionableUsers({
        ownerLogin: ownerActorKey(meta, env),
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
      const ownerLogin = ownerActorKey(meta, env);
      // Resolve @mentions BEFORE the write: the delivered list is stamped onto
      // the event, so a chip on the card is exactly the set that was notified.
      // Named logins come from the text, never from the request body.
      const priorList = await readComments(env, slug);
      const isDocOwner = isDocOwnerSession(env, s, meta);
      const outcome = classifyMentions(
        mentionCandidates(commentText).filter((login) => login !== actorKey(s)),
        {
          // The key is an actor key; canReadDoc expects a session. An email
          // key posing as a login never matches a bare-address invite, which
          // both mis-blocked the already-invited and burned allowlist slots
          // on a prefixed string no session could ever match.
          canRead: (key) => canReadDoc(access,
            String(key).startsWith('email:') ? { email: String(key).slice(6) } : { login: key },
            env, meta),
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
          allowed_users: access.allowed_users.concat(outcome.invited.map((k) =>
            String(k).startsWith('email:') ? String(k).slice(6) : k)),
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
      if (typeof body.resolved === 'boolean') {
        // Marking a thread handled, and taking it back. Same gate as delete and
        // move-anchor: the doc's owner, or whoever wrote the comment — the
        // person who asked is the person who gets to say it is answered.
        if (!slug || !id) return json({ error: 'slug, id required' }, { status: 400 });
        if (!isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
        const list = await readComments(env, slug);
        ensureMigrated(list);
        const target = list.find(c => c.id === id);
        if (!target) return json({ error: 'not_found' }, { status: 404 });
        const docMeta = await loadDocMeta(env, slug);
        if (!canMutate(target, s, env, docMeta)) return json({ error: 'not_author' }, { status: 403 });
        const V = coerceBodyVersion(version, target.created_in || 1);
        const res = await mutateComments(env, slug, {
          kind: 'set_status', slug, id, resolved: body.resolved, version: V, actor: { login: s.login },
        });
        return json(res.body, { status: res.status });
      }
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
        kind: 'react', slug, comment_id, emoji, by: actorKey(s), version: V,
      });
      if (res.status === 200 && res.body && res.body.added) {
        const list = await readComments(env, slug);
        const target = recordAuthor(list, comment_id);
        const thread = findCommentThread(list, comment_id);
        const meta = await loadDocMeta(env, slug);
        await deliverInbox(env, target && target.login, {
          kind: 'reaction', slug, version: V, comment_id,
          thread_id: thread && thread.root && thread.root.id, target_id: comment_id,
          actor: { login: actorKey(s), avatar_url: s.avatar_url || '', name: actorDisplayName(s) },
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
      // `replace: true` asks to rewrite the doc's LATEST version in place
      // instead of appending one. It is the landing-doc contract (#458): the
      // homepage, /start and /templates are each a single v1 that
      // publish-landing.yml re-ships on every deploy. Provider token only — a
      // hosted account's history is append-only, and the browser editor's
      // conflict detection relies on that.
      const replace = body.replace === true;
      if (replace && !(auth.actor && auth.actor.kind === 'admin')) {
        return json({ error: 'replace_forbidden', message: 'replace is accepted from the provider upload token only' }, { status: 403 });
      }
      const writeGate = await requireDocWriteAccess(env, auth.actor, slug, { create: true });
      if (!writeGate.ok) return writeGate.response;
      const firstHostedPublish = !!(
        auth.actor && auth.actor.kind === 'hosted' && !writeGate.meta && verNum === 1
      );
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
        //
        // The one sanctioned rewrite is `replace` on the LATEST version. The
        // landing docs need it: the repo HTML carries no baked reader block,
        // so every upload re-stamps it with the current template and the bytes
        // differ after any reader.css change — and a landing edit changes them
        // outright. Bumping the version instead would grow the homepage's
        // history by one per push to main, which the release script exists to
        // avoid. A historical version is never replaced, flag or not: readers
        // may be on it, and nothing above it was derived from the new bytes.
        if (existingHtml != null && existingHtml !== stampedHtml) {
          if (replace && verNum < remoteLatest) {
            return json({ error: 'replace_not_latest', version: verNum, latestVersion: remoteLatest }, { status: 409 });
          }
          if (!replace) {
            return json({ error: 'version_conflict', baseVersion: verNum - 1, latestVersion: remoteLatest }, { status: 409 });
          }
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
      if (auth.actor && auth.actor.kind === 'hosted') {
        productEvent(env, 'publish_succeeded', {
          first_publish: firstHostedPublish,
          client_version: clientVersion,
        });
      }
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
