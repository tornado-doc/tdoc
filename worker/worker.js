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
const SHELL_RUNTIME_EXTRA_ASSETS = "__TDOC_SHELL_RUNTIME_EXTRA_ASSETS__";
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
  let session = null;
  try {
    const data = JSON.parse(raw);
    session = { id: sid, ...data };
  } catch { return null; }
  // A session is stamped with its account at sign-in -- but an account that
  // did not exist yet cannot be stamped, and one is only born when somebody
  // first publishes or creates something. So the session of a person who
  // signed in and then made their first doc carried no account id until they
  // signed in again, and `isDocOwnerSession` compares `session.account_id`
  // first: their own document did not look like theirs. My docs was empty
  // for every new account that arrived through the provider door.
  //
  // Resolved here, once, rather than in the twelve places that ask -- and
  // only when it is missing, so a session that already knows costs nothing.
  if (!session.account_id) {
    try {
      const id = await sessionAccountId(env, session);
      if (id) session.account_id = id;
    } catch {}
  }
  return session;
}

// Cookie session first; else a hosted account Bearer (CLI / agent). The
// synthetic session is for ACL checks only — no cookie is set and nothing
// attributes comments to it. Admin upload token maps to TDOC_OWNER when set.
async function sessionFromHostedBearer(env, req) {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1];
  if (env.TDOC_UPLOAD_TOKEN && await timingSafeEqual(token, env.TDOC_UPLOAD_TOKEN)) {
    const login = (env.TDOC_OWNER || '').trim().toLowerCase();
    return login ? { id: null, login, bearerAdmin: true } : null;
  }
  const actor = await hostedTokenActor(env, token);
  if (!actor) return null;
  return {
    id: null,
    login: actor.github_login || '',
    email: actor.email || '',
    account_id: actor.account_id,
    bearer: true,
  };
}

async function getViewerSession(env, req) {
  return (await getSession(env, req)) || (await sessionFromHostedBearer(env, req));
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

// Every copy of a doc, in the order that is safe: bytes, then the index, then
// the comments, then the slug reservation. Authorization is the caller's job --
// this only knows how to erase. Named because two callers need it and a second
// thinner version is how one of them ends up leaving the DO populated, which
// is what made delete-then-recreate resurrect old comments.
async function deleteDocEverywhere(env, slug) {
  let cursor;
  do {
    const r = await env.DOCS.list({ prefix: `docs/${slug}/`, cursor });
    for (const o of r.objects) await env.DOCS.delete(o.key);
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  await env.META.delete(`meta:${slug}`);
  // Through the DO (the canonical store), not just the KV mirror: deleting
  // only KV left DO storage populated. The wipe op clears state.storage; the
  // legacy KV value goes too, as cleanup.
  await mutateComments(env, slug, { kind: 'wipe' });
  await env.META.delete(`comments:${slug}`);
  // Free the hosted slug reservation so it can be republished. Data is already
  // gone; this goes last. If COMMENTS is absent (Vercel) there was never a
  // hostedOwner key -- the caller ignores the 503.
  return hostedOwnerOp(env, slug, { kind: 'release_owner' });
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

// One renderer for every edge page — sign-in status, access denial, email
// opt-out. They all ride the SHELL status page so a visitor never falls off
// the brand onto a bare browser-styled card, and the boot JSON is the entire
// contract: title, message, optional link-shaped actions, optional
// request-access affordance.
function statusPageResponse({ docTitle, title, message, error = false, status = 200, actions = null, requestAccess = null, retry = null }) {
  // A worker with no shell runtime (Vercel shim, stripped test builds) still
  // owes the visitor a working page: same content, plain HTML, the actions
  // as links. Request-access needs the shell's fetch and is simply absent.
  if (!SHELL || typeof SHELL.appHtml !== 'function') {
    const actionHtml = (actions || [])
      .map((a) => `<p><a href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a></p>`)
      .join('');
    return html(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(docTitle || 'tdoc')}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#111}
.box{max-width:420px;padding:28px 24px;border:1px solid #e5e7eb;border-radius:12px;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{margin:0 0 12px;color:#444}a{color:#1652f0}</style>
</head><body><div class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${actionHtml}${retry ? `<p><a href="${escapeHtml(retry)}">Retry this link</a></p>` : ''}</div></body></html>`, { status });
  }
  const nonce = rand(16);
  return html(SHELL.appHtml({
    title: docTitle || `tdoc - ${error ? 'error' : 'status'}`,
    nonceAttr: ` nonce="${nonce}"`,
    runtimeJsPath: SHELL_RUNTIME_JS_PATH,
    runtimeCssPath: SHELL_RUNTIME_CSS_PATH,
    bootJson: safeJsonForScript({
      page: 'status',
      title,
      message,
      error,
      ...(actions ? { actions } : {}),
      ...(requestAccess ? { requestAccess } : {}),
      ...(retry ? { retry } : {}),
    }),
  }), {
    status,
    headers: { 'Content-Security-Policy': cspHeader(nonce) },
  });
}

function accessDeniedHtml({ status, title, body, slug, version, signin }) {
  // The retry link points back at what was requested: a versioned URL when
  // the caller was asked for one, the doc's head URL (which resolves to the
  // latest version only after this same gate passes) when it wasn't. The
  // head form is what keeps a denial from disclosing any version number.
  const next = !slug ? '/'
    : version ? `/d/${encodeURIComponent(slug)}/v/${version}`
    : `/d/${encodeURIComponent(slug)}`;
  // A denial is where an invitation LANDS: the emailed link opens here for
  // anyone not yet signed in, so the page must carry the door itself — a
  // dead end that says "go sign in somewhere" loses the invitee. The sign-in
  // round-trips straight back to this URL. `switch` is the 403 flavor:
  // signed in as the wrong person, so force the account chooser — and a 403
  // can also ASK: request access drops a notification in the owner's inbox.
  const actions = signin === 'signin'
    ? [{ label: 'Sign in', href: `/api/auth/oidc/login?return=${encodeURIComponent(next)}`, primary: true }]
    : signin === 'switch'
      ? [{ label: 'Switch account', href: `/api/auth/oidc/login?prompt=login&return=${encodeURIComponent(next)}`, primary: true }]
      : null;
  return statusPageResponse({
    docTitle: `${title} · tdoc`,
    title,
    message: signin === 'signin'
      ? `${body} You’ll come straight back to this document. First time here? Signing in creates your account automatically — there is no separate sign-up.`
      : body,
    error: true,
    status,
    actions,
    ...(signin === 'switch' && slug ? { requestAccess: { slug } } : {}),
    retry: next,
  });
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
  let session = await getSession(env, req);
  if (canReadDoc(access, session, env, meta)) {
    return { ok: true, access, session, meta };
  }
  // Without this the owner is denied their own private doc from their own
  // terminal: /tdoc pull is the documented pre-step to /tdoc edit, and
  // FIRST-DOC.md publishes every new user's first doc as private. See #278.
  if (await docOwnerToken(env, req, meta)) {
    return { ok: true, access, session, meta, ownerToken: true };
  }
  // Invitee / same-account agent: hosted Bearer proves the account so a
  // permitted private doc is readable without a browser cookie.
  if (!session) {
    session = await sessionFromHostedBearer(env, req);
    if (session && canReadDoc(access, session, env, meta)) {
      return { ok: true, access, session, meta, bearerSession: true };
    }
  }
  if (!sessionPrincipal(session)) {
    return {
      ok: false,
      response: accessDeniedHtml({
        status: 401,
        title: 'Sign in required',
        body: 'This document is private. Only invited accounts can read it.',
        slug, version,
        signin: oidcConfig(env) ? 'signin' : null,
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
      signin: oidcConfig(env) ? 'switch' : null,
    }),
  };
}
const TDOC_FAVICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048" viewBox="0 0 436 436" role="img" aria-label="tdoc favicon">
  <rect width="436" height="436" rx="92" ry="92" fill="#FFFFFF"/>
  <g transform="translate(218.0 218.5) scale(1.55) translate(-199.0 -218.5)" fill="none" stroke="#101219" stroke-width="12" stroke-linecap="round">
    <path d="M 88.5 171.5 L 309.5 130.5"/>
    <path d="M 122.5 200.5 L 279.5 169.5"/>
    <path d="M 148.5 222 L 278.5 222"/>
    <path d="M 158.5 271.5 L 255 252.5"/>
    <path d="M 180.5 306.5 L 243 291.5"/>
  </g>
</svg>
`;

const TDOC_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 436 436" role="img" aria-label="tdoc">
  <!-- Transparent mark; scale around path bbox center. Rounded white field is favicon/homescreen only. -->
  <g transform="translate(218.0 218.5) scale(1.55) translate(-199.0 -218.5)" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round">
    <path d="M 88.5 171.5 L 309.5 130.5"/>
    <path d="M 122.5 200.5 L 279.5 169.5"/>
    <path d="M 148.5 222 L 278.5 222"/>
    <path d="M 158.5 271.5 L 255 252.5"/>
    <path d="M 180.5 306.5 L 243 291.5"/>
  </g>
</svg>
`;

// xAI's published Grok logomark, served at /grok_logo.svg so a Grok reply
// carries the right company's mark without a third-party favicon request.
// Byte-identical with assets/grok_logo.svg (pinned by agent-runtime.test.js).
const GROK_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none" role="img" aria-label="Grok">
<path d="M395.479 633.828L735.91 381.105C752.599 368.715 776.454 373.548 784.406 392.792C826.26 494.285 807.561 616.253 724.288 699.996C641.016 783.739 525.151 802.104 419.247 760.277L303.556 814.143C469.49 928.202 670.987 899.995 796.901 773.282C896.776 672.843 927.708 535.937 898.785 412.476L899.047 412.739C857.105 231.37 909.358 158.874 1016.4 10.6326C1018.93 7.11771 1021.47 3.60279 1024 0L883.144 141.651V141.212L395.392 633.916" fill="#0A0A0A"/>
<path d="M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668C403.431 226.097 526.549 195.254 634.026 240.596L749.454 186.994C728.657 171.88 702.007 155.623 671.424 144.2C533.19 86.9942 367.693 115.465 255.323 228.382C147.234 337.081 113.244 504.215 171.613 646.833C215.216 753.423 143.739 828.818 71.7385 904.916C46.2237 931.893 20.6216 958.87 0 987.429L325.139 695.339" fill="#0A0A0A"/>
</svg>
`;
const TDOC_LOGO_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAACAAAAAgACAYAAACyp9MwAAAACXBIWXMAAA7DAAAOwwHHb6hkAAAAGXRFWHRTb2Z0d2FyZQB3d3cuaW5rc2NhcGUub3Jnm+48GgAAIABJREFUeJzs2kERACEQwLDj/HteRPBg6CQKKqBrZuYDAAAAAAAAAJ723w4AAAAAAAAAAM4ZAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAQIABAAAAAAAAAAACDAAAAAAAAAAAEGAAAAAAAAAAAIAAAwAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAABAgAEAAAAAAAAAAAIMAAAAAAAAAAAQYAAAAAAAAAAAgAADAAAAAAAAAAAEGAAAAAAAAAAAIMAAAAAAAAAAAAABBgAAAAAAAAAACDAAAAAAAAAAAECAAQAAAAAAAAAAAgwAAAAAAAAAABBgAAAAAAAAAACAAAMAAAAAAAAAAAQYAAAAAAAAAAAgwAAAAAAAAAAAAAEGAAAA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AAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAAAEhAAAAAAAAAAAEACAgAAAAAAAAAASEAAAAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAAAAAAAAACQgAAAAAAAAAAAABIQAAAAAAAAAABAAgIAAAAAAAAAAEhAAAAAAAAAAAAACQgAAAAAAAAAACABAQAAAAAAAAAAJCAAAAAAAAAAAIAEBAAAAAAAAAAAkIAAAAAAAAAAAAASEAAAAAAAAAAAQAICAAAAAAAAAABIQAAAAAAAAAAAAAkIAAAAAAAAAAAgAQEAAP/Trh3IAAAAAAzyt77HVxwBAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAoovs0wAABV9JREFUAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAwIAAAAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAADAgAAAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMCAAAAAAAAAAAMBA5ppt0yS3+pwAAAAASUVORK5CYII=';
// Add to Home Screen never reads the SVG favicon: iOS takes apple-touch-icon,
// Android takes the manifest's PNGs. Both sit on the reader's wallpaper, so
// unlike the mark itself they carry a field (assets/*.png, drawn from
// the rounded white favicon mark (homescreen + tab share one design).
// The four apps a dock always has, as the real artwork off this machine rather
// than four drawings of it. Hand-drawn versions were audited against the real
// icons and were not close -- Finder came out with two faces on it, Safari as a
// white tile with a thin blue ring -- and at 46px a wrong drawing names no app
// at all. Extracted with `sips` from the system's own .icns, which also brings
// the squircle and the icon's own shadow with it, both of which a CSS
// `border-radius` cannot reproduce.
// The desktop picture, the real one. A CSS gradient cannot stand in for this:
// a translucent dock only reads as glass if there is something under it with
// real luminance variation to refract, and a hand-made gradient has none --
// which is why the dock kept looking painted however its own tints were tuned.
const TDOC_MAC_WALLPAPER = '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Z8hp2Rg5LDdSM2TlZkhMjK4aofNEkUANRFKyFqUjRM5SmFSAhS1qULUpWjQkWTK5UrVAOgYChgt22+DlszYdnK+ZAttsmV4Rty72DOqZPlaCavNEM4ra+S4rKpr2cb5qybd8+CxR1bvIaEZnJgPMcSO0OOPlc21Orjr6ecQmnQN6NGiWwK2d830tDFHBBLXMkjyqXDmBJHJC8jGXhwYkDxK0p0VQmTbbE7RjbRBMxEEqSmIqyMT6/E74b9Uidq0Tq22rbTUadUaYrbattNRp1Rp1Rp1Rp1Rpwo06o06o06o06o06o06o040acKNONGnCjTjRp1Rp1RtNRtq22rbao06o06o040adCNOqNOjGnQjTqjTqjTqjTqjTqjTqjToxp0I06o04UaWzAvnTXp/e8Nn0Km/B0wGUypyoZIQpJVELUyjkilI1LUhGokqUwvCRlSJMqUtCpSDKIQUVsuCsJvBw3bN98XLdox6+R6wrk93CV64Pno6RUVyi2rma+vjU7awc37Zo30Zy2bN+zQ7cSOjokUp01TtDsR03d45OXbNfJyv4YICv0V6dHfor06O/zIxnZm7nLFy4aq5+d5mSFWwiuxNhLAhnimxFzPI1KqpTgFaJhtsadCaXCUkqhEFlpTBKoiCZjQaY0E+yaY+B/U9p1Rp1Rp1Rp1Rp1Rpwo06o06o06o06onao06o06tE6ttqjTqjTq2mKjTq0TqidqjTq22qNOqNOqNOqNOqNOqNONGnVGnVG01GnVG2rbattjRp0I04GNOIjTqjTMUztUadWidDaYBidq2mi1zdebx6B7/ggfS38n0ICtDomFZkTC4lHiTSFLlZErlSiV4ScqBRlYBMzEJyBkEGOGRahjKuAtG2ubps0adfK9aVrHu4XrNFhvzTYV7TJ7Fg3TviTQrRV4QyChGPbRQFB22SNSdNUpXDMjE1CxYJgiJAJh6VUJgnJmGbKSQRHDaUyfKrkqtiOvzM+zMlOitXCZuXDY3PzuSNyZYnUCVU8gwVxIJgaBaiJREVwjEqhOJnJxlZEErhEErgcE+25Ufnv6jGnC22rbattq22rbattq22jttDbattMY21baajTAttMI20dpittq22raYNtpFGnVG2NttW21bbQ22rbattq22rbao040adUadUadUadUadUadUadUadUadUadUadUadUadUaeK6cHnG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GLPNKbTSey29bb1tvvppppprSuyvo013U1pTXcTTCO42WEdLbb7b7AW223c7nc7nc7nc7nc7m3c7nc3pCBmaDCAx/h8uTLGPlydUZcBr1KW0lv8AYqaaaaaaaa7aa7K0rvrsrsrUoG4sIaEttt/RAdrtaaaa77bbbbeXF05lyfCZQxxoOTqZH8CQT+LUpOtNNNNaU00012U0000001rTTX0Ka760rSvon7jTjhSG0nQ6X3jW3c7ne73e73e7i2XnSmkRYYSWOAR5mymT4Tj/ADdiYJxpgmLIdla00000000000001pTTXdTTTTXZWlNNNNaV2U13TN8BxwpDbf0xptdrtdrtdrtdrtdrsdjsdiIMcTjwPA4g+16yTFMXamKYpimDPGmNd1dlNNNNNNNNNNNNNNNNNNdlNa1pTTTWla0013zl6BxwQG29b+iNNj7b7b7bsdjsdjteHhttBYQJYYq5KIGX+BEQPCWkhppITFMUwZY2WKvo01pTTTTTTTTTTTWlNaU000000001pTWlNNfRnKnHG+Shvsv6tu53O93vuO93u5tALDES4unY4xFA9e06U00kJimCYJxMsLtIbb7aaaaaaaaaaaaaa0ppppppppppprSmmmuyu+RpH3G2I0vtPYPqU000iDHEwwMMFcyb9B9Smmna7UwTjZYk4iNAeymmmmmmtaaaaaaaaa0pprSmmmtK+oWR3GmEe89o+tSIMMLj6dG2P4W/onupppp2pimDLEnH+TaD2U000000000000000000001pWlNNfTyz9A44Vpf0gjutvt2scbDp3H0ztjFlInvtvsLbbfZTTSQmKYpizxpiQgoRpTTTTTTTTTTTTTWlNNNNNNNfWyzoOON8lCTqNT2D6gDGDDC48D9sUyJ+oU9l99NNJCYsoMsaCgo0pppppprSmmmmmmmmmvoU19CcqfxFDbfcewfR2ogjEwwWx6evxO6MfwhMyfP1ynuv6BCQmLODEsSjSmmmmmmmmmmmu2mmmmmvplzTs0GIpv8AZY4L8MelPq7ccf6vvHxFJ/Yj9C22+0pCQzixLEo1prsrSmmmmmmmmvr58lBgPXS2/wBkOeXokk+f2QpT3W222223qUhkGQpgWKNKaaaaaaaaa+hX1JyoM5bpIbbbbQUfRv8AY7+mU9lttttttt9hSlkEcFiUfSpppr9hL1GRg22239G9L7Bpbbf7Ffedbbbbbbbbbb7ClmGBYlH7bmnQZyuWlu5vS0I7r7bbbb0v6t6X9I6Eu53O93O5tttttttvQskHlgWJR+1nh6jIgu53okiTuQWKNLbb7bb0tttvuv6F9lt95SkplrbuRNEkFttvS9LSlgWBY/teedOWVt9tMUaXpbbbeltttttttt/TP1ilPcEfRLJgwYo/aS9Qy74o7ToNAnSXaH//2gAIAQIRAT8BtttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttMgPKeoJ4gH2yeZlsDw2SiDHCw6djhARF4TMMs4ZdSy6gpzF3l5aadrtdrsdjtD9rcXdF3h90Puvutttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttu5Oe+IPt3zNuvDyUY7YYWGBjADQzZZwz6llnKZl5drsdutu53u93Nn6NtttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttssvoH2yeZvA8PlEGGFjhREBtllAZ9QyzEpmXlEEQaDaZu93N6U1rbbetOx9p9kttttttt6W2222223pbelt99ttttttttttttttttttttttttt6W222222mQHlqUvKAI+NBBhiYYURATKmeYBn1DLI8lEEQadyZpm3pTWm53u53O53N9gIRMPuvvtttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt6br/CxgBy2gMcbDEiICZAM87PMmdtFEERbTNOR3NNabne7ne73e2XlprS23c7nc239G222222222222222/qW23rbbbbf1bba9S7TLy+NIwYY2ONMqZ52eZM7aRBATJlkTPSnh3Jm73c2Wi7Ha8O53u5t5dpdhfaRiRhRhRgb1tvW22+6+629bbbb0ttttttttvS22222229Lb0vtiCTQdgh58tep0AYwYweAyys8yZvlENDNlkTJpp3Jm7m2na7XhM3e2WnaiCMaIIgiCIIxIxIgGtL0tttttttttvS29Lbbbbbbbbbb1v6V/Utttttw9PLJz6JnGP24kDQBjFATOmWVlkfKIoTNlkdzWhkmWlO1psJyO46U07WmmkBEUBAQEdlf6BvtvW29bb1vvw9GIj3M7lzmfA4CBoAxi3TLIyyN2gaGTLI7ra03NtNO1sBORMi1rTTTTTta7AiKA000022222222222222222222222222222223+x22244SnLbAMcWPpRcuZM5yyS3S1iEBMmU0y0DaZpk1pu0pEXZ+aZgJmS8tabUQRB2u1rW9AEYyjGiLTTX+irb0tv6XTdLPOaj4ZZsfTj28Hn80Ankt6RGhmmbaG0zTLXdoAxgjF+bLLGPhMpSdv56DGSx6co6Z9h9pIASW29BAscKMQRBprvrS+y9b0vtvS+29L1vS++/r9J0PuD3MnEXP1lj2sPEWMW9AG0yTLS0yTLW9AGOMlhgZ5IQ8JM5ow/m1+THp5ScfRsOlfYfaZUHJkSSXYUYSjp0YQERa+hTTTWltttt6223rbbfZettt6Xpbel6W3232W32Xp0/RRxx97qf9Z6jqp5j/RA0GhkmSTpbub7BFjicfTstmPyznOfhh0v5piB4Y4JScfSMOmY4AHYGZAZzZwkX9Ox6VHTvt0000000000019a9L1tvS22+6/2W9IgyNBxdPj6OPuZuZfk5c080t00DW0ydzbbbfYIkscTjwMcIjyWeQniDDpSeZMcMYphbDp2GFEAEaTLKJKMCMCMAdgDJkH232n20j6NNNN99/RvvtvvvW2229Lbbbbbb0xYp5ZbIDlAxdBH88jKUskt00aW7nc2223pTTTHEwwOPpniPh9uU/LHCA0iDGDEa23pWpSH2n2XYEskhppr6V91/s1/sPS9Nkzz2Y2eXF0UPawcy9S8yNyQ222232UiKIIxW4+ncfTMcQCQjG7WmkaAtt99dhTF2Ptvtu12u1pr9lvW22222/wBm6LosnUzqPj83qOqx9ND9P0v+cv8AXS22+0RRBjjY4WHT24+lYYaRB2u361NaU007Xa7UxTFMXa7Wmmmtab0tvS2+y9b0vS++229Lbbbbbbbbbbbbbbbfj/j59TK/Efzer62GOH6fpfCNL7aRFEGOJjhcfTOPpmOFGNpKSk6U000000000000000007WmnamKYpimLtdrtaaaa/YL0vS+2/2P47405/5k+IPW9eNvsdPxHvARBGNjiYYGHTMOnYYUQ0JSU6U07Xa7Xa7Wmu22222222+6kxSGmmmmmv8AQN63pbetvx3xvu/zc3Ef9q9b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8JcEBGvoSJVyhxMFhcWJHhUq2nbGSSZ8z/8AYEAAAAANOgAAAHHWOSfxCOTWOyPxGd+AkvnL6N85IsUvzAWEmCYu02LD84Tkibq5sh2mFCf/AAAb/wDEA3030222223/APLCZGQN/wDgANh9CILBKszaQHd0EA5ukkZWWEYDuASCGR6tsCx9di0LExrEWPIwkJ4gQCAdf/rqAAAA/QAR5AraWfvkNcsr4lbb8HgAdTvzPBL6sBIIS2lMJi8EkmNY1TaWK38xNPXPk8Sbbbbbbbb/APggABttttttttttv4Btv4gbbbbbbbbbbbb6cCD6QfSAGEC2niR3AIDqV+ZoJvrwEB4q3LF4SfjwY3S2j6rJaJBMXbjUJFC/Akn08bb6bb+Abbbbb4222230238Ib/8AIAb/APEA303xttttjnWPrk0vhrbeYjGcFpOwPiAIDxVhMAkHgzTbigJRCdS3q0tMN8Qhg9HaD5gfEAg8b/8AMAN9N/8AoADbfG22222222+Ntttttttttt/EDinH1ReX5v1vkbLXxMh8SNr4wEBfRlMK4L6Mlqw4mSSvoSli9xSkDAj8JEKUPpNtttttttttttttttt8222222221ttttt8bbbb423023023xtttttq2vcPg+W4vx+CA/BmPA0qawBCeCofVaE1TCikYD8SLT3AQQ4pBRSBgC2GCz+JCkP8A7AAGv/wwAANttttttttttttttttt/ABWxYt+X/B+vraZ24Ld8SITxdu4BJPNXqNctoT9FyxFeozzOLLrLF3AsYTL4FIAjLTwKys7uM7gIpSZ7tttttttttttttttttttttttttttttttttttttvpvptttttttttnTB2/B+vpKT35RBfVnFq3ysIe0thYPJW5YwmatrKxHM4znMXGZ8HnK+JvpcPiceIM+QMyV5Y3cB0RQXH4Mg8b4223xtvjfG222+N8bbbb43xtvjfG22222+Ntttttttttttttn08fn5fy/wAwZuH9YiYc2ck9ffwB3fG6sr5nytwnJneeoDmPwExzfUgPiMdEk7mFvweAJP8Aif5u6gOogWQWWWQRCHhv4gbb+Abb+Abbb4238A3xvpvjfTbbbfG22+m22+Nj/GfHyfz/AMfvZvo9EYWw2MPwC7OZj43Jd6kZm0sH1XD8C+acKJXkjPiP6eAh4jPBIw3u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';

const TDOC_MAC_ICONS = {
  '/mac/finder.png': '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',
  '/mac/safari.png': 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAeGVYSWZNTQAqAAAACAAEARoABQAAAAEAAAA+ARsABQAAAAEAAABGASgAAwAAAAEAAgAAh2kABAAAAAEAAABOAAAAAAAAAJAAAAABAAAAkAAAAAEAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAgKADAAQAAAABAAAAgAAAAACaA7zWAAAACXBIWXMAABYlAAAWJQFJUiTwAAABnWlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNi4wLjAiPgogICA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPgogICAgICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgICAgICAgICB4bWxuczpleGlmPSJodHRwOi8vbnMuYWRvYmUuY29tL2V4aWYvMS4wLyI+CiAgICAgICAgIDxleGlmOlBpeGVsWERpbWVuc2lvbj4yNTY8L2V4aWY6UGl4ZWxYRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpQaXhlbFlEaW1lbnNpb24+MjU2PC9leGlmOlBpeGVsWURpbWVuc2lvbj4KICAgICAgPC9yZGY6RGVzY3JpcHRpb24+CiAgIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+Cl6wHhsAAEAASURBVHgB7X0HnN1Ftf+5vW7fZLPpgTRS6CHSIx0VUBQUFRQUGwgiPp9PUVGfIvqkiRVQn3QQRRBCCSRAgBBCEtJjymb7Znu7e/f2//c785t7f7vZJHs3CU8//53d3/3Nb35TzpxzZubMmTPzExl1oxgYxcAoBkYxMIqBUQyMYmAUA6MYGMXAKAZGMTCKgVEMjGJgFAOjGBjFwCgGRjEwioFDigHHIc393yPz/1McvNeFs7zMILq4H3rooeJZs2YVFxQUhL1eb8DlcnkdDofb6XS6ENdpj59KpRwej8dtDxvKz/TI56DUD2WmM5lMaqhy7GGIk8Q1uH5puBRgScZisXgikejH1btly5auiy++uB3pk/Y84B8KR4OiHLzHg4Kg/YAzoEKPPfbYuJNPPnl+KBQ62ufzHeN2uw8DoUuRRwGI5sfdh8sDPwk/gPh4/rd0FlOQgRK44njux9WLqwPMUQXGWBuJRNZWVVW9e9JJJ9XbKjkAd7bwfwsvgVcMds4554R27dr1AVTyD2hNO1BxtqhRNwgDwE01mOHB1tbWi2699dYCi8pZPP5bUN0CUrXcRYsW+evr6z/R39//GrvBQfUdfdwHBjBMrOzo6PjszTffHLTj9F+dCcitivjvvPPOcX19fU9zANxHPUdf7QcD8Xh8CXrPkyzC/0v3BgY4D7qwL6M7a9lP3UZfDxMDaENd3d3dN86dO9cLRjB4/pfqDFTLv/zyy0NtbW3/g3qNdvfDJG4+0SBD/e6BBx4otPUGB8wEJNyBOsWRl1xySfCee+75n6Kioi8eaIYHOz2QLG2RuLT1xaWnPymReEriybQk02lVFOab4nU7JeR1SYHfLWVBr5SFvIKZyMEG5YDzi0ajD997771fuu6663qszAZPO/Mq40BryPQc890tLS23lJeX35BX6YcgMmfhVe0R2dbcK+sbumRjU7fsau+TLhC+N5aUaCIt/SkSXyRloY7aAtBf/C6nBDxOCfvcUgRGmFoalLnjCmX++CKZMTYs00pDYIpDAHSeWfb09Nxz4YUXXrds2TJOK8nFI2aCA6kO06oLQsqXJk+e/Eu0mAPJL0805KL3oUWvruuUV7a3yKs72hTBWyIJaFgc4nR5xOnm5YYfF3RLDhf0S1QzGHDJNZm0ZFIpwWRF0qmkpJO8EvAnxA38jgl5FEOcdniZnDZ9jBw3sViC6DH+rxwa3LfGjh37M5TPBjhiJjgQgrFgWbJkyUJM956Cpqucz++lYwt/akOjLN60W7a19Uk05RS31ysuX0DcPr84PX5JuyA3gfBuXBl09WkwhQt38mraajdOYIHDRApDghPEduCeBBMILmcqLulEvyRj/ZKKRSUZj0vAlZYZZUE574gKuXB+pRyJHuK9dhAMe9avX3/R0UcfvQxlk456PMsTkJGyMAt0gfAF//Ef//Erv98/P89yRxw9ju77pX82y/ef3Sw/XbJNlmzvlPY0iB4uFV/xWPEUjZFMqFTcoWJx+MJSWRSUgpBfetJuKfG55CcnhuX13SnpTjrkshlemVvqltVtGSnyOeWneLeyJSN9Do+ML/JLQcAvEWdQnP4CyfgKxBcqEm8gjPHCK7vRw7yGHuev79bLOzUdatiYVBIEcx1Imxo+WsDAvuLi4hmYav9txYoVseGnHBhTteKBQcN6YrrM3XfffVE4HD57WCkOMBK08fLsxib56L0r5JP3r5Z/bOuWqL9ECsZNFe+YqSLF48VVWC6BUFi+dFShIkg07ZCLp7rkmjkeiSUz6OITctJYlxS5UpKAADA9rC/6GcZ3jBNHXKb5CNIyD8oEzJN5swyWxTJZdr+/VMFCmC4GbISRsL4XDg3vpOuvv/4ylMUCSZO8uW8kDMBCHOeff37ptGnTvjKSQpEmL7eyukM++ae35YoH18jy+ph4iseJf+xU8ZROxApCuUwqK5SFE4KSxriewRh+6VSHHFWSUV18Q1e/TAtl0G1nJA5itkcTMiaA4tUQwDjAHfwM4zvGYVymaURa0vJo5HXpVJ03y3gfymKZLJswKFgA0+uAjTBeBlgJ83vhKisrv3LttdeOG2lZI2UAuemmm04PBALHjbTg4aRr6Y3JTf/YKB+9b6U8v7NX3CUVEqqYIq7iSpk8tkSKwwFJgiATA3G55QSvFLjT0oOh+62GqCyawGmcyLauFIjrkrAbDABiNvbEJQQC8w+UVxf9DOM7xmFcpmFaxmBebzX0qbzDKOMnKItlsuySsE/BQpgIG2F8AbBeDJgJO+twKB1WT4+45pprTC9McPNy+TIAC6Dc4Js9e/bFGIdGKkPsF8iXtjbLh3+/Qu56vU7igRIJV0wSKRwnmUAhEO+WTxzukhuO9CrhbU1zXKIxdO8VThDQJW83J2QmGmgQxKrrw/TO7ZByrDMmAe63Xu+U1a0pTPtYFTJBRvkZxneMw7hMw7RBT1rltaoFvQPyPhllsCyWScHxa0f6FCyEibARRsKaAMyEnXVgXQ6hc0yaNOmjyJ8rqXkPAyNhAMeNN944CWP/KYeiUv2JlNzy/Ba5/P41srkLrXHMRHSzlaBEsZw0KSRTCt3o6h3y/I5uOXO8S6ZBJuuBEPjirj65cKpXEe7lRrTSN1vFiRYaBdHqumMyuwhSP4jb6iqWuDuAdzno6WcY3zEO4zIN0zIP5vVSQ1rlzTKWVKM3QJksmzAQFsJE2AgjYSXMhJ11YF1YJ9btUDgsqy/85S9/eRjyZq1sNdt/aSNhAMH4Pw9GGeP3lb3uYtnC9uLwavBbjrmff2i1/HRptaSCpRIsxxgfKpO0OyiQy+S08qR8/3ifeECxdZ0uWdfUK5fP8mF655bnahIyr8Qp4wMZ6XWGZGuiEHN+p8Qwptf2pGRumUeN924oezg00LEX0D2BEgMwVcQ0Ea2acZmGaZnHlngB8gyqvFnG4uqEKpNlEwbCQpgIG2EkrISZsLMOrAvr9LkHVyu5Qpc+9O9gnAwda2AobCrGwI7gKIQy+SFjAMNd7okTJx7J7l+NpEAYu8IBF+Hgv7rl3ukA/ayrkPNvbOyST/xxpTy9tQt4qxQPxlLBlOuKuUE5ocKFSa5T7lvfLVODKTl7olMSmIrdubYXCqAutEyRHVGX1HbF8M4tUOWIm6o9QJwCAbd2JqUMZiYOKHsM23mh/lte1yuv10WEfgMP4zAu0zAt83B7XMgzo/KuQRksi2WuQdmEgbAQJsJGGCkonjDOJZ8B7KwD6xIqr5R//FPXkXWly+KM/izCiBP9ToVafr6HV73T4YynXjIrR0VFxbG4e+i3Ltz27/LtARjfW1JSMk9lTYiGcvZwm59e86iqgwcqZFZUtcllf3xH1mE+XlA+XjIFZZLyBKCqRQtNROTHCwMyBiNcYzIgv1vTIV87KiAlXodsiYXkuSa3eDBex50etMyoXDTNJ36ggLihC4B4T+yMyy9WdYgffrZ+Xl6kWdbilqUtLuU34YzDuEzDtHTMi3leONUnz6EMlsUyF6NswlDicyiYCBthHAMGIswuwM46sC6ZcJmq23rUkXVlnVn3bAEowwKZJWaDjT9HfRJeJ+Ov8cKcjjQhA+RF03wiE1rG9weDwam4H7AjAl7b3ipXPrBW6vu9quWngyUysywgx4+FBg/j8Z82x2RXa4/ctCAoPq9PntiVlr6+qFw+06vGa68P2AaSfVD1vlSXkld2tovXAX0f8jZ/UU+BdLiKLISzGvryQlvIyzzzznSMyzQmPcOY56tV7aoMlsUyWTZlhsuhUCJMhM2PMMK6q6VHwc46HF/hVXVi3YLo3VhX1pl1Z94Hw2FIngS7SkglVuWGmWk+DMAsHRdccEEx1L4lw8x/r9FYcbaCLzy8TlrQavylFZL2F0ra6ZXxnoT85nS/HFnmlH4Q4odvdkustxvKmqTE3GG5bVWnYoCpQQh26NUdaAZo29KSDshdm9EbqKdc0YpzByFaswDUvmhDg0ngRFx7GP3Mk3mzDJbFMqGURLfvkE+DGX8BmGKusBQ5kxKPdAPmLul3F6g6/Po0v6oT68Y6sq6sM+s+oCfIgZy3D7JK4WWXXZa3Oj4fBlA4Oe6444pBPAxuaARAArsgXnxQf7zrAP1s3jGu9Y7E3wA9/hcfXi/NSb/4SsaKH2rWiYU+pUpdWheXP6zaLXecCqk/7JSaZIHctDImfSmH+L1ueaPNI2/VdsnHDnNDcYMCLOK60DL9IazYcey2gvmK5Q2+VBr9UqUf/F4/Z7NWeTJvlmEyx8KiXHK4W1YCljcBE2GLAMbvvBUDzIUypcApd5wWkj+iLqwT1cSsI+vKOrPuxMGG+i4Fn8KbQqhClsajhUuNaPWQxSPDlBwAgMAAQchmxRq4AfxrBQ19y4cBmIMD6/1BIAf9Lp0GlJAaOE24vTIW2OoVadPQGZVrH90gtVGPBIrHYFApUILX788IyPlTIMR5Q/KbTRl5e1eb3H5qUEJ+tDnOsbGgw7I8gZD8YGVUHt7UKT4KcGRNxZ68sUVrgg96ocDV8O3jl8BaeZn0ihlUrrom6j3isOyHNnQqWAiTKgAwElbCTNhXopf77aa0qhPrdg/qSCGTdfaj7sTBNY9tUDghbnQzMqDqJ+IyG64QS/hNCP3K+SAHUMeZl8uHARSaMf/3g9sobOTtiEjOhf/zb5vl3ZaUBEvKJY1FljQWX+oiaShOGuSHJ/jkw4d5gMQC+f5bfZKM9sqPFgbR5SosqJbCLrrPVywtjgK0KotMVivPUs+ilQYSoGPMzhFSsYgi6R4+9gqIm82HGWTzsvJgWQhm2S3OAgWLGjZUWqQErISZsN/8VhSSaKGqE+t25/IGVde0D50o9AXB4nJZB1wQJ/3oUgjjSBxpAs3sQIFmGBkNlwGyUEEA9APIETKAyO0vVWE61K0qnvYWyiw0h0WYumUwPj5V75PvLqmTy6alIeVnJOYrkRuWdshRhXH50jyvsMs1xEBvKm5MtyzyD6wqCaSIZJEXcfPBK+Oqy7CICRhQClGCWQpgICzKgVEII2ElzIQ9BkZlXT6BOrFuTzaB8CD++VWvyMkNq6EjgGAIJiBObn9pZ15wskzyJocBMIAbCiHDAAqc4fwMlwGYl6omlA4cBF16PDfdEO4AQv1ZLVUNC7YwJ7D00uYW+RVaua+gRJxoFRl0l2GJys9Ocss1R/mAl4A8u9sv17zYJn3ApA9z+VZnsVy/pEV2t3eJC5I4odCoJ0Sq+hZkuPGdem/CcVdxCL7lTOK93U083pnWKkMNLVb+KgrTE/14b7KihzASVsJM2FkH1uWaF9vl722FMtnRJz9743/kxqU/kebeThipQNsIXBAnd79eLy9uagExURpxt7eLJVvvDJ7J8BDO2TBZ+WE7S6IZdnwoWBQDOAmAcrhlS8wGZUPUS1aoBarV7y3eKf2uIJZVYUDh8QFfTnm7ReSqv9XKXR8YL1Oxdn/zCpGuNKZ8Fmt6sQtsS6xINlYnxe9HoEI8Ss7edXecfSZQ5p3lIVMM29niZtRQwPyyFVPZqPwQlKGHeLDS8Eb7wsernRgeYDvAHWx4nXT7JIZO86K65fKdt38n3t1V8qm5n5VNU94nHtqmgW4e4CQKY5Obn9spR08qlHLYJKqVyqEAN7i33hlaoBfYS5c4VCY6LJ8eQKUAp9HtPcch3jD+na9UyyYsuPgLoG93+eRTs73y+fk+8WJuv7avSD7513qZ5I7IvWeFZBw6MtXdK9aC0Afp2u+HfMNiTeUtvLNlKizzZjlG05ee5mXTmAjDuaMcLVDaWrhJZ5Wl3yPQlG0xA2ElzAzuh5p6fGS33L7qLrlv6c3ibNopn51+iayfewFsEN1y5Ry3fHI21NQYAokb4ujOZdXKYs0UN9w7GCHvxbl8GMBQnZs2gVNUj/+4666fj+y2iBD1gq/RLXG+3yF/fqcVFSwSJ4Uf2OVtqu+QS6el5HdnhWFe5ZcmZ5lc+Wyb1De3ywPnhmVemUPp1LPNS+WGDC3my/GgRW4LOgNkDmkIyUUeEGxxSa6I3FsrzcDcsk/0qAcdks0+68lIAgog4uZjtUvl8de+Jx9f9xfZ3hOVL08+X1bPu0CmF0OVfbpPPjolIZvrO4ET2CsCN8QRcbViZydwp/GscU2cWqhVeCauDb414FYPYK/Ffv35MAAzwxQbHToqSuLCnEIXwAcFnb7zkW8oDccwUb99aZ1EMl5xQy+exgQiBcFpRbtPPvZ4g7S1t8kX50CYAqMkQuXyzdehUVtbL7NCMMhU+aqctWCusa6Qr14ZhBvK4M5eW7Vdwsj35h1Bo99cfLY7Ez4oPvNQFxIOnhyo5HxPj5Uug7pFUcepvfXyy3W/kV+i5U+q3SRbYJJ+Q+Xp8tb8D0Ml7ZUrpqekrbVNPvHXRlnR4VU4YS9AHBFXty2rlVgCxg2WYxlsYAobqsDcGx1unvO75y0DGC7D9k6rJNyJaBB7sHNBAHpmU6ssrYqAs0sl4fTJyeM8cvoUv9y3ISr1vWNAcGj4vDEMg5jnQ1ZwhUvkN//sA/cnxeuHTIOsrVHelv2eIVkKIJaiBcGxiGJLmPPa39v9uRjKl80LT3owMBFy9SU0fEqgZ/MkYBVUv1RuqHpKxu3eKZHWDtkZicrNlSfJG0d+WIJ+6AugvrxrZaf0ZPywGxgjE6Ac+tz8gLxSHcPiFBVFhbIMaufnN7fB6HSMJCgnDOEIWw6KISIMIyjfHkCgc7bGGVvRQxCfwNFc+/dvNmFpFBa6XhhMQthp6OiVGf4eefxDYfnsXGgBYbzZ4YBQiJbD2rB38QXDsOrVOg2HEcRUZYjqQcQn81lhlNWMvDaw7jpOrgnj2UrHtAP82WbONAOdyV+/MekANvKKwSBkdtcu+d36X8utW+6XcRjr25vb5J+9vXJr2dGybN5HJBBEPbHa6MDY3+kpE19hmXxmXkgeAy5m+HsVbogj4oo4+/2buxUO94REw2WjgAqApTCj7i36wMpYT3n3ACgkxzSEQGE8V6YKQjCXY1/c2CarYCfnQ6vOwDybK2M7I1656tkuLJ9iVe/kCvnI9LDcsaZf3mhKKgla5USGgkeROpv1IMKrCiDMFGhVSFc/m8iEZu9ZBhkchfnAWTf9MBiXTGxFMMlj6O4D8T75TO3Lcm3dC1IWaZNMa7s0tLRIU3+//K5kjiye92FM83gEApJj6TgFIfjUyUH52oICCWZi8t8v7pIldbBF8GHBCr2gA7jyYShYBTnpFVg9nz8HvSeNDA6By5sBDAxKMOGDgmsgcHxKJFPywOpWCENeyDcBmRh2yWXzAvL8rgS0gB7M99Hd/aVJPnWET37yvrGytsOHKWBUerHXhZMZRW4rWzXroN9gna2U/ybM3BmY9VvvCaNJR79xA3oWBjLhoKg6yNAcUUxGlH5gfoaMj2nbKv+580k5pWuLYNCWRHOz1GBsb4/H5MGC6fLEHBC/uAKdDAQ6EL4Auo6bTi6RBbAXeGB1ozy0JSFdnDKGfHLsGJecM9UjD2/ok7pEALiLyIMQCM+aCRU/YLHAUXAerJ8RM8C+APBAoFtbH5E3sHbuw+oXu7VINCahRFzuXlQs60Hsu9e4ZDMEwd9t7ZPndtbKx+aEJZDxSS8EIHsrzTICca8wgBDjz97hsWGHwVnHyEoizYbsxTMglc6PQeiNzBsz0sUxpy+I98iXq1+QL9W/JAVJGA/GYJfY0CA7OzolmozL34KT5YHZF4kXVsPUnDu8GNKwxhFwu6SmBYYky6NSkyiA0FciR5e65NpjfDK/JC0vb+sUrCwrnPkgL7xe3S0bGvvk6AkhZcq+F+BHHDxyBrA4UhEjWzzlUUUyCH+d0hXHhssgVj7QpFsTXvn2a70yddUuufzIsEzxe2WzeCWI8b4Jip9frI9KAIoeDI9wpCbzAeq11ypB560EzmzBOo4j2x1YUdXNSm8PysevmIrkVx50AE41NV3Yul7+c/tf5fhIFcCESNTXL531dVLV1Y0l4pQs9o2Te2d+UNwwXXdB4ndgeuf0hdQ0rz3tkjs3JcXnK1Rby7jRZbIvKtVYHf3xc72yK4rlZj+siNALuqAj6eqjIN0px4ABdK9LeOBws3wWdDo4398RM4CaegAvbBWmZyRAJERnNCkv/LMHyhBtMDEx7ICk65F1zYVSBQuaH7wdheFECgYVBDcNbse6SBALPgp6u8SrEa+qCq8msoqkf9RrsJzBhO2VLUIOU3u830cA87SKJ1PHMU8vjXbI1VXPyucaXhF/BmMVBD/p6pSmujqpjWDmgnOklnlL5dfTzxNH5QyL+CA8WjKZAIIRNIRuEB4V5ywKAqEXhH6+JiV/34ZSPOVSXOSSI8e4pb47IXUdmFUgLnF57SkJxTD2odcCbx+V2P+rETCAJlAWEJaRRRR6ObT2tfV9sqMdQl0gCFs6l1T6EvK9hV6YXIflZVjtPF/lle2dKXSVGWWOhRFD5aEYCXmpMZ9BzBfUVY0biFLF8IeCEm7KwUMCGRjUCxVRJdVxrGcrRV436iy4i/i0xnfkWzuekHmROhCS5zTATrG1Rerq62HhE4dNdlrecBXKHdPOkdSEOdBwgugY/riqyS1qDqiDqexRsFo8zny5C8nn9cvR2JV07jSvnDnJJa50TG5+LSHVKMMNBtjR3q1wevrhBWqH094qgEM59vZqr+F5MwAtcPbpQK3XdkawpcotISDKiTFvZVNcLn24Vt4HE+qPzCmSj5xZJDURl7wA/f5L1XFpwZhHwY/Ey3b7LMQQmtQmEdnU+T+AoHzJd/rGeNkewcTLBlhxhnHTrd4lFZEW+fKOp+WKpuXYJQwEk5BAdHz3btnVCEUWlrfRz8lqWA3/fMpZEpt0FCR4EB2XMwgGIPG57gHio0IAD0DhnzO2sRALzprik7NhJzA5lFKGIXcthXFJQ0p6YaLuIaNBJooAl8TpaYeZc6OGUYFhRsmbAUy+7AEUzoFco4ki8bj/nsKfAh7jow/qTAfmtF3xCnmqIS7P10ZkvL9DzoTx5gdnF0kpGOTOd7Hyx3hmLFHMYLV8UyCJSOLan42fd74zL+HPPeh3jDJcx80h2Bcu5zW8Id/Y8aTMjDbqVg9FlmDBpq+hXrZD2u9FN+7H6t9msMBPJ54ukanHQocBoqPlc4WP475p+SS+hp8aRaiK0ZIuOdwpC8uj8o93O+Wlqrg0wFYwhl7EB7mhEEav7AFjSQwDYATilLilVRHDFTrMnRmP0I2YAVieKlb107p00BB78+NSg+7dhalfAlx+5WyHfGxuSFY3Z2RlY1KWVvulBfuv7t/ZL49B4vX7MOeFUUiW+CQiGEHR0hCUT1ZldUn6WUWyhxMgwwUKOB17uL9aoeOSSb1Nch0I//HdK5AdMsI2c6Woikalq6ZadnR0SD8yxY4E2ZnxyC3jT5H2w96HVU7sSAbhXVD4OCDIkfGp9GFavbKIvPDP2pHh71vdI7+KxUB0LB55SqS01CHvn+KVEyrdcmyFQ57AdPD3a6AdxfkGNbCiqumMy3TYT+A0Sj08AgYb+odbzQHxDogBBuSEBzLAtta4tKJL9wQh8EC6e3Rth2yu3i3vPzwkH4HyYzsYYVPCJUHIB9iRh7k0jBkUJXO5ZelOIloEzYXBl32wvLZ4RPAAZ4s7IHzQQxJqXCd2Bl/c8JrcuPPvMrkf69RQyCgJFQQUGKU2VVdLdXcPLJhAQBTUAIn+J+NOlIbDT5ZgqES1fBKfQh+ZxoHpr4ZQM7QdNIbEYfDqhAqcmOAO5UmBFHDUj9NN+uRHqyKyDmsEbhe2poOJWjHT3N4Sk1mwOc9qhlW9B1Ukz8cRM8AAIZCFAtHkxs1Q8OBYBWy2wGoYAtsyhbIE++qWNEEP4MIKF5DDjRaMTNqaBmvgNgKgebaytiidCx2QbigiDxWWS658HLy4iSOOLv/w7lq5AVO7C1tX61hKaAOcKCjT0Sa1NTVSzwk6nj1I14pe6paxx0vVjFMlDJWug10/ic/ejGN+tuXnCmXd7HhDb66fgQtsM5CtEJyvfCoCw1KUC9N06k/Q9yAvl8LpZuxH/MARbP02VrJ5cyUN3zdiBtijCABCAXFrawICHSRkIGh8yAGhLygNvWnZ3pHEdqu0kvxjmPty3y1312iCIzErQqqyciSe9UwiKb8KZBzzbEGg0tDPBJYz6c2zCWa4zSUwjXOnYvKp2iVy/a5/yLh4B4ZqtFpKpJybIsvE7kapqq2DsJdQsJKtu1HPn0K/v2XGIgkVjlHdvhL40O3T0EXlwV7DOEMwA6J5xnsSsx8zAebLsT8c8Mk8WBNPL4EdASyi/7apTxq6uUXNpXBLU/SD6fJmAKwFKKAHcCGIQzrE0DdVdaTUWTxq3MPK2DhHTE6Y7JWK+X4oegJS35ORGpxvta0rLX/Z3C8RrHhmZwADaGvrNrNE1rxBBGhcolB6DGF5N0g2weYdX3GtBP/smWJo9bM6d8m3tj8mZ7WvRziJTuIhApDN42GijRD2GhqlB1in0SdCpR+C38+L58uaGWdKqGicIj5bvkO1fIj17PaRXonIJDT/lXCr/eoZ+fDOBhMCBa7ASuCMIqdMhpA/oQCCNKaVu7sw5ndggOQxUJh/8HyjKjQi4phDLZJbP/RYPQszzNPlzQDMn1K/AkA/4FcjqL0vKd39GNOBXBcQ2tDnkP94OSIBZ68EsWGiHBs3Z4/BsSzYKTO9AMueQGkEQhQz0+RmhnQ2qumAIX6HiGMBNeCNQn4ueQJGM75Uv1xZ+5JcV/OslCexTw/r8IqDqZAg8aHH78F4vx06fXT6ivhsz5Tcby+YLW/OOBsWzePV0THOQDG6fUj82P7lYO+BumdNyQiPuVgniyFYV9WA8M6Pzn26p0uaMXQuXReXLS2UoWD1jKlfNO2BKh1DJpiSO5C6+1NCHI8F16isWFF61J1UyN+NiAF0pViznCOC2qNpnMFHXJJFM1IKQdABWzdu3oih5dSgJVU1puTp2jiQCuUJtH9OHMagVYm5ijBXNnrNZVmPFYZnFWTFZ2TW3ArW7xgBjiDalAZcvJndVyPf2Xy/nNa5WXfzhvgkPLuivog079oluzq7YKRBq0UEMyto+X4dmi5LZ4L4ZRMgy3CeT4GP83yM1Gz5IJJyJAodb/AbcBWxsuFkLJxf2I9GsgwHUYFR3dhJRMHZHYIKHUTHRmSVpBuaVeI0gtlTB3BcgZHGMBCzYyRbk1RBw/0ZGQOo4lixgYju6ecZfMADgMcR+1j1wn55GH90oldohBzw7aV90tzvBldDSDIUJh2tbDTBrFwV8awXIHA2jsLmntVTdFbvTGZWHJWP1rgdUZyU3yz0y7TtbUAa4pFgzJjjPYnf2Sm1aPl1kYgKZ07qAvHv9U+RZ2aci+3eU9QcX0/1KPDhrAFM07J5keAoU/EAEzMHwwSW3wpVcTi2B8OwkEYcju9j/Tjb4P1BqcT4X4wdqW/CSOTrz4N1AWc/dh31AsdkHKtazAqOT7zydyNiAFU5VtJWKMnWl4AJGE7fcsGklxz7/cVNUujqlzFhmH8H3NLTxz37GGdVBgZYhSUNP5saHVu0anbqSf+o+hGZeGQSXlads8wxqLtXcRAtDgXKtFBcfnl6gUwrL5H+z39VHLffKj7IKJiSqLySLc1SXV0ju6Ho4XhPx1/q9x/0TZC/QL8fGDMNLZ/qXbZ8EB+GG1y7x4QfF2ITbqYy9SN8Foyml2IMHY/vTFxEQhpOh3v6EnLf8jrpxXlFLb0YUlMYKKEVpPKIuI1oa1kV32TNLE2R9Ofj8meAfaibqdem0YfqCNGiOtIl2ASZkW0dEBw7oPenmbRT737hTBCGs7qHJqbpkDbbkimwWUyQJbCOpX8t5ObemUysSHxEnASaVaUvLncuCskMnv0C5z9ijsSuvFpS9/0WenesSTQ1yQ7o9Luh4rUT3w3i/8VTIfcfdq74x03H2gY1fCQ+mMAQn0PHYMZDGap4QyHWBcBwW4M1IBAM3VPgHocgzMND8BkFNfa/0KBVvjydhOO/Hxc1k8Qt4x5MlzcDAAyMV5wJkN1ZMVYKNQVwSYzzKVVZCC1A/Kexj/+wMrQQOkMpUJi9xYo6CD0wDiETMLl+bzDGBHCmCAYrJMBDplAtDXeNV1W2ykSDgxfaJQBPqTMmd5wekqMqsRpnc94TT5F4827pQU9QxTV8Zm1gRDwPiP+Mq0zum3qOuCtnWS2fal52+7rlKyMPAsHmRxhZvoEZZStn3XQEHaTD9Qta+pwBI5D3TaRqCWGGmawmvbMtLo+tiyJrDKvALevE8gbOwhiEgt+LxSBTKQ1ftnYWDiDdKiSCSgAo1dsO8ycKBXbKwI//dB8pTx2Y5eBhLFV//vABToXRYyKae/adFZFxbC4JzVohiX9GSN43GZq5QY6p2haeLP+cjpW715dhImAxKsJ9IP7z2AH/q2nninPiXGxGxTSPUz30AFzcwRotuAWSOIVdTTadu4HN3NVb/cqqmKqHRVvrBXHRJUmcSKLraE+MBtXLHgbDJjhf4RavSfw9GQD0z+Y4fE/ePYDKmjDysuGejzADxByVSAG46Bof3AwDCsxbqTqlw7qPbmV49OLwRR9O1tCVBn8zCjOxOxPGl6Y8K84e8U1cpOdBjQEomX92akBOm7on8anLqIaw14QFHe8VV0myC4dKbFynCMuVvVcdhXLXpLMkPWE+LJPZ7ePincTHwoxZ2TPwqqLtsCs/YbYCeTPvcdfx9XueLbS03o1j8DgGgBlwwZpOOSf8tK0MYqcxrbCJW5rP5zLT8fQvIo/AjYgB2FXxj//Gsa60YlEbNhmOq7wwJMUBHMIYcglM3mQNFoMoybLhsEtTkWx5mCBzZ4x8HbdTuXG+749O9cp5M/dcPsXna2THjh3S1dUFJoXYhamo68ovSvy2n0pBY6287S6UX0w8QxKTjsayLsZ7NdVD68f6PhVFg4mfhc9eD+PHXdXS9qzi89lc8NIegDuk2Iv7cfLSMVgMikA+bYmkYFyDo2tjmjmIW+KY+p6heoAsLHl4RsgAe5ZAxAc9EFjAoTxsMQMZ4ObTfJgGeqUD5+o2wsJlW1MCQg7O9WXtDXUtPsjlaF7kQvbus+JaebD1CE74/u5JHvnYPJhgD3K9MNHevn07jnPpU8RXr3EquHscDqW6+suy6vY75WdFC6Rv8nHQUUDBw5U9P7V8elkXX6JDxXQPp9KyPMOtyq9CNXHpNWHZuwUon7Nh9OMBF20Ewu6EfPYIkUpYUJWEAlgGTsg3nqM6UOOWOIYEhueD40bEAAR2MAeSK0Ne6vexuKIsex3yg8W7xZHEcieQloAhJc2e0+jXOFugTOdDZVRXbuFF4dLuV3VEAOtrwum1+bNRECcNY8xvLnDJFcfsSXwcry67oOBJguBs+cZ5MC4l+qPyTF2P3D/hLOktnQ3iY/cyCO+imbYHih4nVvagjuU4rGAx+Dd3vFEg2Z41jSxAGW7eDfKT9jFMn9mA2LvvjjjkC0+0QQiF3aADLR+LUk7smyB+/Wj+xDHjMp3dDaaH/d2+/CNjgCFyZOsrgeICm1ph/EECO6U7g0MZgbMADN9CGO/HQsM1C6bPcyo8Uh50ym2v9ypNmIuD3QE4IgNf2YJlrUO+vJDEJ+Jzrra2VvD1MsW0WgFFJsKqHoi/bVed3Lt4laxqxmlj42ZjD0OZHu851TMtn9Y8HLf2wLopw4LfXo2sHx76zTPzwD8hpOKnzJ+Rr58RxnJvWjbtTsjWFqc0R8owBGDRCSpUiqZoJ5gCphVuiWMyw8FyeTPAnotBrArt5HGINtZCCgAxOZRTwkosbFx7clgmYaGjIgjrGYxvdfh6R3Vbp2yuwmJLvx8pcREpOptsvQY9ZsNznlyMGIh/5VyH3HgK1uRJKMuxtbPVN0PYU+O96jqAUBAeH/GUv768Uh5+s1q6gzjweUKluLAZQ0n61jxfmX9BmNXSt6Ggyd26Z4MHtUpbOAme5R3jYRgqHe2PARddMrMcu4RnBWXiiUElJ+3GOkotFszuRiNpwgIacUrcEsemB8jKUUAFcUja5OvyZgAWwMJyXY6uKetFAWVKsRNbnKnVgoOmrba+V97aFIehCJaDu7D0mXELzvtWH3IIBLANCkxBBI3U9WMD5aUzRb77/pLsDIR54ds6StjD17ayXT7n+ZSqN++olXueXSVr2tziLZ+jtmy5aLZNOz415mv9vhL4qC7eF3z2d/vym3e2Oy0E+1IeuWed/jCFT7CH0pFEg3FAaYXl4CJQPAEcoR/AqKlw60FvaU6cBRU02nDL0SM/TObNAOAyuiFLYQObiaPdnt2GJUv4d8Pw8/a3oDjCoWI0kKA6mC0UZ8zoFk+1H7PCo3IMt+pkhezzRuJ/cFpafnx2GRRKIJTlSHRK+mQCM96z1fMsvwefWyV/ebtBIqGJEqgci6kdbfbDIDyJT/UuBD5jxKmEPpPrXu52ePflz75jHfHAZ1wcioI8YCoTUi27D139O9AJrGoDU7Dbx0cueCQHVxiJW4OqvUCTd3DeDJBM41tbUEvq+lgVYbGAjMDNxL5+WrcwAo8/GVsclqNgDfz+w/2wZ3PIz5b1yCasxVBnoPPI0Z/ZDOms/Ozv+rHx9P2TUvLz83CmsO3bPbthrcs5Pk2kSXxeVKe+u7VKfr94tWzqwpSLrZ5ze2xApWbP5UWL53hvqXe1Nc9+Wr4BxlSCz3a//Znh9nfWM/mAjtvoaeY1pywj31xUKNtxmujSHf3yLqyDo6gn0xKnM4A/hQrE553OZPue9QBssQpwA72GQ0HCSkyDYWM5Dk/silE1nJZL54h8dJ5TVlW1yONv9mP8xyAGNU0/JF8/pBsfahangbzNsSPI1ozh5tmqdQxIWViRkjs+WCJFGEboiIC6uroBwh7XHrq6e+WRF1fKk2tbJF44WYKV5YrQymJXtXy0fq7l4+K2JAd1+3o1YyAMqpQhfuyg2/0GZiZBuHo073nHxSkzv2RCXFDBU93WDxx1wIDGL98+pUj+uhFnD6/CcAoLkHJosg/D/lLKVlaW6n6gP3n3AKpwi/j2MYjhZICJ2OaPI26kE8af6L3kwbe75M9vRGHn5pU4rF8DsAKeWOKQM6f75AOzvLIC5s53rEgoRthrZZAvHUcMWsQchRO5776gRMrDGCPhOAOgsMepnmrx6Hk4zXxr3Va597l3ZVtfWPwVc2GBzJZudfn0o7t3QgmjTLdBfEr6qm2xfhrPKv99/mTjWdgwz7wrP36ssGybgYeE/9LxWAOYEpJnt8TlpR1x7ATyyiNbRf66KQr7yW5lWc0NJvj4rsLpxEK93sJ87PzFJ9UDvGdrAaxbtjY59DCIRF8wAce5N1F1CQ53hiWJLrYM+/5OxKLHRfP8MhcHmu5q7panVjbKy9WwexdwDInMWsFllwKsZxUOfwzSz4ziBIhfKuOLoVqE4zhP5Q6+paeIz1bf1t4pDzy/Et/v6ZBk4RQJVmBqx+6dgp5iAhIezzT8NIYcVPCYgi2CqQL292OPS3gtZlXJzDvcldf2zH7rkZVt0oIPWJ07t1g+f1yhbGwV+fuGfnlzlx/WPzjxHPmxlmxYxKkPAjNHBDqTlXkiPaxXOmiYvyPqAUzeiucVJIZSBCwjCyeKPPyuxgWZ8oRJTvnBeWFYWvXLko0Ncvs/+mR7FxQwODHMBztBMkoOQ7m8TDm8c9VsYpDEL5bDrGXdThhwVFVVKSbwgPAcS19dtVHue2G97IoVS2DsPBwuxbFdE14Rn4SnyTZ33WB+r7t8Uz4KGohZOwhD++3x6TfP5s5Uxq/u+ME/xblWHIH754048XRdm0wvasZn6ILyleNLcG5CWL6PjaJv1/IwCSyZgUrvm8Rk+DN5DYJmb+GDou3xmDcDwDAhw1kAOY5/ytlK57E2c3D661Rsad8BI1su9zbgm37ffaJF1uFLHt0ZEqAMhMHBCizd0HsvFeP7JIg/xheTuy8sknnj9bJuE9bwa2pqsOyMk8cwrDS1tMn/PrtSXtwKa57iwyRUUopyTHcPJmDr5zIuWz2MQJS+YH9TvD3QNUTAYLjNs7kzifEPunO4CmAGkEyGZENPQtbjfKTfvVEvR1Y6cbhECLijjgS4xNHcR4zB9I8LhiYPIIabVrLPWc8QMO4jKG8GSCUgX5uxJgtMrgTKKLD3lFOmwPIX0j4F9MY+j+zqQjfv8UCSxfHqxwfxsYWYPLuV9gBY50Zydm0+9IvsDLIIs4hf6I7LHR8qkAUYL8l81Ow1YC++G2M9e48X3lgrf1yyWRpT5TDcmAMVLghttXou3+ruHsYgptUrLQUyHyHScrW1wWqANjgxd4Zn/egVUSbOkVB4oa6EavHzZ3nk2IlBuX+VR6raQrICGkEflCr4hLFaGSQuqQQy3b8u30Z8BYatEB1hWL9KXzOsmFYktHw61IkA2C/ik5XVWqtFhwk+xqinKyTSGHxP5ycfDMtDnwrLeG+n7GxE94ABk/vdxmPR7hun4UMLEMRTmBGY/LmU7McmrJ+fH5LTZxRgW15cjfeN2JTp8+K8od2t8t9/fE5++o/t0uKfLoGKqdDmcd0eCznU5/NOrR5avjqYkhK+EvQ0rAPht9dlmH5wu87D6hHt+NgDPxijUTfWkXVlnVl34qAKuCBOiBviiLgiztgWiMNF08g4ho9IaFOuQreFLwSPwOXdA2TL2IPhdAB/qamagTntsfjW02vVXOTAGoEzLp1tLfLFV3tkPb7UkYQFbAnODfjU8QG5HKdjrMKHHvpg8iw4OQv1U5KvOxOXn3wgJB/Ayh4+nS47d+Kk0Sj2SAHRTy19R+5ftk2anWMlMO4w1b1np3YU9Njdqx06XL8H4VWrp6CXrcGBe4bKyx5m/LZ7BIdJTPIl5cFPlMr9a3CMzKoozk3wyZcf75L5Y9ogEBZICEzaj6N1aANwLL7MNLPcrv2zg20yRhgb3wjciBjA3nL2ViZt/i6YLThLn+toDpyL64QSCGf/wdLGiy1B58/2yXWnBSXS2yPffKRO3qjHbIBr70iXRreID/bKzecG5ZJjS6Sjo10rd7DUu6u+We57ZpW8WQNtY8lMnEDCtXrM4znGY7ahmIDzem7y4Lye47wiPm4jw9HeqjggP5W1PX8TgLvxsruNQLX7tSe75KQJHXLD2WPlojnFcterffLCFpesxdawda/EYACCrfVYPOOy+QWz9LaxmH12MQREpH92aB7i/d6C8mYAFjIcBqDx4jHg3vnjcF5QI5Qe0GcmIfhNgg7g5vMLZVoRvgry0i55fD2+sAEjjAC+78uJPrk+BUJ/5wy/fObEYmlqapSmxkbVAzz92np5aHmNdLorMNaPUQocJ8Z6Nc6reb0W8mipq1o9WhI4QNddUWFvaBhBeDa/rGcAQwxgNkZR0fQqqQ/fNl7e1C8r/7hbLpnfJt8+c7xcdmxAbl7cLbUd2A+o9koAd+hBjxlPncHArIeCVttoDvVm32F5MwCzG8AAwK/Z2k3TZVaUKOeYFYCm7yNzsBu4GQoMBDqxvFnhT8qmHY3y9Td6pDEOBQ3G7LIgdghZLJ4A8a8/BV3iKQXYkFkrrTiFY9N2LN4sfldWN+FQ5eJZUCaxe8fZg0rAo0KHCh62estcC9K1ttdTwBLkg+8UQZmt9uzRA6tgyEDQLdBEjUu/XMghboi/sgKcmQDh+H/fRevfXCWfP7kAuMHRMFgs4yFbVJUTdwEP5/5IhTQqrcXQ9LNsXYx+UkF5/oyIAQaUAQgsMOhRzrqpufvCSRmlxFiBoYCKu3cwt319B4QEd5lUFLvlu9APJDC/+fazEUi8GfncArdcB1u+Gkj6NdiU+cSyDfKXlS3S68X3gsegu6eBhJreWVM7pb+nGhdTO0vIUyxogBgA7EF6yOad9WTrnkOAfheDoHfp0V7sjXDJb5ZDfiEZscjzrUV+TIrc8qPnMDz24Ki8l3FuEuwmCmBCx78FEzKY+6fV1M9krnK0OM1WMvLUQuFIasdhKW+X1QMAGHtvMNjPKY8X2qtL56cEp6FCkwWLIdi+eTBen4jzcB6/qlgKHT1y94uN6kzhS+dBQj7dK431tfIypnb/dd/r8qe3sSESrd6PXbhOL1fsaKpVigtSPvbkOdxgBNrqceVO6fCJYHgP1cWxeFDeoOceYSoOwtk2N+7qkA/PxqbSi/AJeogkNPq8e0kj9J84MRU4OBGnpRAnxA1xRFwRZx7gTq/97xvPGu8UnAlIfi5fBnBQCaAYQNUQhRkmwDP/+Gy/uNAzryIt583gliYMC5j386ik2SUxeeiVGrn6gXZoBYPyIbz/9hkuLONul58/sEy+89gu2RSbKv6yKZi+U8Aj8WmqRcKzJ0C3j7UF9fESjvVU5bL+QK6603+wrwF5o557zZ840OXT6ndDi08u+32tjPP2yZ8+WSTjC52yo7tArn6wTeGAuCBOiBviiLgizqgjIDrpTONigPLrYMtPYxACl782ON8hIAMrmwwFQWqxCEjWGUCzAZYH4eABjGeQcBs8OEjRAUWRUx5a1Y+xDXIuWvDZhyXkpjMysmT5KrnzqX/ifF1oCksn41t9VAzhq51o4Rl8itWnBD0Ii2asV0Ieic+y+MP2Bmfz6oCD8KvKMPnkHuwoMG8ptKEh6yVvMIkXCrCWRKlc+b/N8sMPxeWhz4yR6zHtW1tXKvfh41ced0yKwkGlHJqGT9VfDFxRbtB5m7vOPVsyGcEUCA9pgoZJlszLAXv5OfYAKNoqyAKBN3VZHgV57h0ZoDSYlsuPTSo5gMIhj4hxYzxfUBmTa47tktsefEVufLhRtmWOkLJxEzEdxJiOFp6AvuCIyWVy8cKxOEAZYz0NNLENm0IejSQGdpE2hYxCIJF3EK4BeeXKGFg2sYJ1fSivPo4xfy6+Ms5lXoaRksXQe/e7SuWbf+uWR5bXyn2fKpQFk7FqCWGWBiHECWUk4qgE5nMUGnPOwiUDmJ15YfOT9oeaAVS5WHpNolKqvyGddXeEiqo/VVcF4IB3eOC08NgJKbnwiKQyHSuEhsvvhMFDW4381x9XYxNJicSL58hZc4vkpvMwLcQO4iS6+YqyIvn5JZUyFkjBzB/EJ89aLZ0lIW/dExE8XsSc5ddAWECZ98O47zVdLm9VJuPZy4I/lcY5CN6I3HFxgYwLU4JPSwBH3//qkpB8aD7qhDOBfrU8JTfev0Nops4T8QuAC5rTETfHAUe669f10gzMKljPLG+QH0BAWEzAzpF9T34u7x4AGrkYOC2RBcgAM4w7pfyLUMkTJ0HAwWBXhAa9vadEtstc8RVNkLOhHPr6WYXy3Poe6UkGcfBSWH7x8Up8XaRP7n0TloTckkXioywOearDs2gwUBDTSGI8Qx91J/2Gc1l56rR75mUvizCo4VeVRUK65Nev4KPWO9rkjo8Wgfg4ObUXO4xfxSfxPhCUi470w9Y0LMtq8HnZDreUBHieEpbKJ6egFELXz/51GLi0xyHJsRczhU0v2E6SbR0M3q/LlwEc4FrFAMzZDsRw/DRs8LrScsWxcaiKccAiBsqSQnwmBXP4cdCNf+7kkNyJr2stqS4UN4wzf3DhWNgKQCP4TATzfBzBxvV60INID6Pl0MzcTgz67c97I6AOZwX2du1JdMYdnD+fCQNhMcxIVYgDn8P7zt/xNVB8PPqHH4LpGZadn9zolO88uku+eqoHRjPYRIMVzFL0+dxHMRO4uOKYOJgH+ykHDDfDZwaMzAnYRpAB6FizYbl8GQCKmdYoegCcAwLHYogYcqz5s4pWN/Ve/aioTELjhjLIA58/PiYTYcIfwnJhMRa8+3B03Dcf75BltYXYjFkiX4aV7/GT3XLDo/iEHDZGkPhsZGzBKWRyM9YILjvaJf08fkQXkb0PJlTuPSJaLXXfd10vk25v+bHsTx4NWwfAQpgIG7MnrFFM8q5/qFmOH5+Wr0Dl7YG6evFWj3zunlrpwcFIJTCQCWHeP7EwLVcviCuc6NbPamg47Y2KuFP1t6qgnzWDWP4YtrvxRJu83HAZAMUqdMiWLVuwjT4VpTWrIboqMRvDAgrQ6j8DuA5npbhYNLkYTICKj8PKV0HQD51+gXQ5KiDtF8mi2UG58sSAXP9AAw5hxqEOWEL+yYUhHKiUgZFkRk6Z5obdnEMeXYEdNBhKlERC/CPffrw3BOOz8Y/0bs+DefNZERrlsexH3myDMOdQMBG2MDR3twBWwlwTCctX/1wnn8U5yYumY6LnDEh7Cl8LxUnpBWAAHvVy9QkxmHun9PkABpEksvLnfog3hvJP3dWzfk9aYAjog31Edy7F8HzDZQDmpmBavnx5VzLBk5UQQCKP8GKDmT0mJZ9fGJfKYg+mQX4pgwYkBKmosTUiX7i3WtY3Q0KGtux7H4TlbjKCsTSmNpd8/awC+dMrrVLd5VELJqSyWmqFdfWNZ2K6iGFGIYywoUtNY1zVc5dhwIv4jMs0RoJnXl6ocW/A0S1jUAbfs8/nYk11l1fB8vUz8S1gjPcdPTEcOBmR7wPmIFbE3kUdrr6nShpae/CM3g9DRiGITwHx6gVRmQX7RupKRopHVU/QAo2yZ8mSJe3wUkLWXALP/lw+DMC8mHG8N9Jbq1erdfYAX3vUrynbFgYEooa2WFqvnYDyhgqPL4IJJmFDSREwVFHgloYev6zdjZU9HOB01Ul+mVKUkh/9vR2IcsulWDr2Y2n5/rf6YRACqRrKEtY4gW7lnFluOXkKFk9wvAq7YY7HLJT76bgVjX6e0qEu+CE4q0uN21Y44zAu06j4TIMrjp1Ep07LqDJYFstk2ZzKEha/Ky6XHAPDV8D4oyfbZTJgvuokmrt5VV0aunFUHs79KcJW70lFIP7CKCynkpaqVxXF4uDhr/LxyeYb/GDeof7oAWL90Qb0ADCHGpiEeezL5cMAhApokiTkgC2q20Er4PyTXEgBjyeHqDtisfWo1sc4fI+Emsv1M/0KsVjomIFW8CUgZBbWvdk6Kos8UgYByYdWF+/rkW89XC9tsTDGS6d88fSg3PZsC/YfBuSICpd8YC6YAPNtfmn0vLle+fs7XTh4ERZ3RCT+OU5fcowHPYNfqZsVehAeR5ozYYnDi34Tzs/cMS7TGPmCcPYnnCpvlsGyWCbLJgydgOW2xS3yJZxEMgEwtmGRizATdtaBdanELh/WbWY5GP6EPplRypZPXOhLNRD6AQhQZuGROMzhi1gkvs2l8Es8ArdtHR34Zo3SBAJaVRvc9u/yYQDmphgAhhkb+2P9OPeBRcOxSP6ou/ZrKLIBeMf3qJB+oaLqPkHLBBPRYq4+IQID0hSmh04Zi9Myy3C41COrkrK6kS3JKVedHJQdDb3y4hZMt2AOdv2ZAWw64eaJtEwfA4EK56q9iG1o3AXE1snC2E3PGgsDzK5+hVRCR8dPsZ00zaku+2fZyMCMyzRMyzyYF/Nk3iyDZbHMo8anFQw+wPLi5oyC7XOAkWckEmbCzjqwLqwT68Y6sq48G1jhgsCoYvij/TkPAxjGuLb4OpQv1H8SWkDsiYAZLg4d1DTKxtifJx8GIDRkAFm8ePEW7LHfbdTBGjgNYM5vgB7enQgp9qdgHdSL/QL9+HYuzMgwHEwoD0txCN0+BMBl61vkB39txfl9QTl6okvmY8fRn1/FVzfhzkNr3FATlYYuCJXovudUgnyAmC2Qw8vGOgwZYNgUiKnGdhCaegleaIYqjO8Yh3GZhmmZx9zxbizQOFTeLOO8eVitgfvzqx0KBsJCmAgbYSSshJmwsw6sC+vEurGOmvjDw8v+8MlzBSORvrZXXnllowJK04i0GpbLhwGYITNOvfDCC3Xt7e1v6+9I28tBpWyP9id7uC3KAC/Vny70t+fPispnj4tgKxk+Iw9bgXGFLikHItc2ejFOZ3AOAAAK3ElEQVQrwCIQSjnnCI8sWQezcChTikCPs8AAT77Tg521bjljplv+69wAjIpSaj19Ig6q2oIDKtljsTVyNxK7WQUsAKOfYXzHOIzLNFyLT2Pp7lvn+lWezJtlnDXHp8pk2YTh7DlQWyMzwkYYCSthJuysA+vCOrFuA1W8A6q//4chkEgG6OnpXvunP/1pl1Uj1Uj3n5mOkQ8DsHhmzolQbPXq1YthpKkKs3NprrtCdP5b3Zc93IQNdae8wFY5e0wc3WW3nDMjCmSKVAChU8t9IJILYyk2VbzRKrc/14U1Ay96A2w4xWFUr2/Xp44tmIaDlRsi0gvNKC2Q+nHESksvpm0A/ZaPBKGSZrcO0Nm8WR78DOM7xmFcpmHa3v6kbMUX0I6f6lIm7iwjgLJYJoVUwvDI8lYFE2EjjISVMBN21oF1YZ32WDuwcDMUHoYMA0Lt4cQv5IHM5s2bnwFN+AkDDgEIVRdu+3f5MABzY+ZqnLnrrrtWtLW1bcSXRBUSTVG6dAtQFaj7AfVrIZxx6FRchtlhxiMFIdIn7EnLB2dF5Krje6Ajxxm5QPB4GJFMxEnaCcGOIyfWDLC+Xt8clW/eXy+9ccyvkeYE2Bos3UjjUZfMwAeYmrviEgF6vDhxoxLKp14cwMOZgHH0M4zvGIdxmYZpmcdSnNjNPJk3y/jmA/VShzK5r4EwJPAtJMJE2AgjYSXMhD3sTau6qGqypiS69cd6m9orWAY9mLfqbnun0IgEbkyROzo7dvz6179exqxxsXHyPmyX93IwcmYhcezFa129atWDZ59zzi0okctyer7E4jmDUoEgJjzoVZVTfvgUAjhNYyh+KHhpZyXCjYjCvhgEZ6AoictlR+GMoVaPrKgNSlU7xnmI4lxt49GpXX0Y/3fj1DEgxInjtR9+dbeswZe4sC8YRHVIFb5X0JeAoQWsbUqht23BsfU0FMVnsK1ycSATwviO5lhtiMs0TAtls6ypTqk8nZi2+sDw65tg5Yzp3IRil4Qh2aujWzAMTYNkv3BiVGaixdOYI4kZjjKTMzTBGUB0aobCeqtq67pTlld44iPqrkIRR8n46pkhDNDxiT3iaPOmzQ+tWrWqCS95kFDeDECT2ZE49hyet1Hw+eeff0xpaelEnsZxqBwRxQIrwkkss8Ywj8YnabCAkqL9HHTpBegGCtEcOY7z752dCWjdsOiCmUN1U4+8tT0K2cCPYSIJIqWw2ISVM9giTChISBsOr9rQAEJjCnYYdPKvYKNmEqd0b8IHG7fgs7dJnNFHa6P1NVjKxjcQS3Hi2Tgormi7X4wxfixM2+dVJuTcGX1y+rQITkUBHgBvlqcPEVJ8Ph/V8uuuv/76WyCPUQPIIYBMoDlkmOVqlhxmZCsa06DfxymPWMn86le/esoXvviF33o93kLFBHjLeTMdb4ysuNgWqMIMuxtwGagcPBaX81Gn12/0M6ZnkM4pvO/u9eBMHR96Bi/GbRythupTq8ZDl8zFI9aoeiYMhC8ei2ANHh9hpKFJgjZ6EDy5hwD65DQWb7wwzaJwS6GOpu1B2HDxMCtzedFDhFD7MWDGGeUxNb5XhPmRDAp4bJUaZuY7uGro9AYGmgiMTIf3Kspe8lDREcENc/dUKhl95JFHr/nhD3/4AlKyIlQCvScMgHIwRYbgjAvabCm89957P3/KKaf8p1ZM2AZXvDyUjoxAhFHx09TjUarhamyxbu/D2foxfVoZpW4er0r1LeUKPmdX3FRqIh35gCG5Gwcdi7LkcYHQ1PXzGZuQMA3EEBFMyZSSODSTCaxeJjDdo7TC/AjFe+MIJ+UuCOG/+vjHP34bSiXh8QkOnLyDjgfXYLZC0N7dSCFnOsoPWNHn3m4pffLJJ/9r7ty5n4jjjLjh2agzCxusdkgGBdsedQtBypzj2KmPWGN+SRCjs98lHTiKtjmC8R73zihWDcEkPG07gXGZPQIPXjYdDTsjTtHY4jl2+zCPJ3GL8RGnMUEIn2jhJH4RdvS4wXRkGfZAJn0OFstnr5rdz9fm2dytAP3IXzpdxkD8cHBDq0PXD0XcM5/+9Ke/jcOvsKFcMGdR37UwMwA8Dt+ZEoefIheTwzItNBQTjBs3ruKee+65afas2RfE8ZFoqjg1fXXVlIRjw5gOtd7l8tS+wcH2Z/rp7FyhAnIvaDRE4Y1lEgwSKwpVLpkgnuJFAmq5lUlJfMqDtGCmvQKJH4DEr/NRmStic1wfUCw5RwXkQnNQ6HT2X01CS8DDC8bNpbRiIpCjJcP1e+sXZZH41dW7ln71q9d9G1O/ekRh6zddP1t/3o65j9QxrWECrJFJQQXcb3/72xtmz559KSVUrFCNNO+Dno600l29znqoihPptDPU94MOwogzpLKHQu/OnVXP3HDDDT/GknwjMmPLJ/Fpm5F31480yo10FmDS8058Ke6DuVjq0Ucffeeoo47qBS8cGQgEvGQC8rxCOGLaBSG2CN0eFHXU9IiZGd5XXuuHYx+boX6PGHzku2yA9rMcFaSzHNBNayNStHzE4SdaqAFkqzaXeo/UqqOyMsrmhzSDHd/RaRAGxlRP9qBsZFNrfVfp7fFUjjqAdfbhFPN4ItG/evU791x11eduw4GXzYhCwlPwo9A3YuIjrRLmeD8Qx/rzMoCknn766Q143jB16tTxBQUF4ylVq1XDAynl/6O0RtDjWgumeusff/zx//7GN77xOIw+KewZ4rPl5z3vH4xGw5eDw/N9Zj7sTSgTQFErsPCTQElJSfn3vve98xYcv+BjxSXFsyi9ciqmhgawjOoZ2JThOGSoVo2Wqfjfgkx3yPjVzUzFsZqcTod4Kqr1XuWl3uguX3mtMhSfsgvCv+l5lFJGl4jeCWVbcKlIJm+VKV7gPYvR5elnlacuRP2afPlgxnLzWqVjDvxn3syMuSkPZhzo6tUUD2ZHOP5m57p165649dZbn66qqtqNiJznk/g0+zooxEc+ui70HATH+pEJODsgE1A4pK7ARwHxK9d+5cQFxy04q7y8fB6GhjFkBtUrsFsfcCGFIg+xgywN5Rn8b+zUEAb4eSc/8oga7YcSCi09hYbRF41iWb9jE6Z4L/3hD394bevWrRzrSWx29yQ8mYDS/gG3fOShHIl2MB3zo2BoegPqCsgIvJTyaNGiRRNPPfXU2bNmzZhVXj52ZjgcHochIgTuD+LyAhkeXDhjEnsAgCkixyAPefxbOTK2YXL2ely4wYXPD6ZjeO7HHoteLKs3o5vfhpNNt7z++uubn3vuuRpUki2d4zsJbi4ygpnqqb4DzwfsDjYDGICYr+kNSHgyAi8OEXw2DOL1+/2BY489tqSysrIAQ0YwHAz6fAEc9ub0uDM4WsTtdJMZyFT/dg7DXSaFDw5imOGWuiTs9pOw3I51d3f2QZjrXrNmTSfM7A2xTbdOIlOpYy4yAsOU7Ir7QXWHigEIJPPmReJxWOBF4g/2kxlMXAPP4LvheBOOJP/SbjC85tl+J0Hp2J2TwLxIbHPxme+McG3SIujgufcCoSzDXGZ4MHcSn35zmXjmPrimDP93cIOJZZ55N5dp0bwbQvNu/CaeSXtI6v1eI9QQdl93U9GhYBsqzMT/V7rvjWgm3E7cvfnfk/r8XyPUXr7dz8oPfn5PEHKICzEMwGL25j/EIIxmP4qBUQyMYmAUA6MYGMXAKAZGMTCKgVEMjGJgFAOjGBjFwP+vGPh/xEOvX2eQzVkAAAAASUVORK5CYII=',
  '/mac/messages.png': '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',
  '/mac/trash.png': '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',
  '/mac/claude.png': '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',
  '/mac/codex.png': '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',
  '/mac/grok.png': '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',
  '/mac/downloads.png': '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',
};

const TDOC_HOME_ICONS = {
  '/apple-touch-icon.png': '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',
  '/apple-touch-icon-v3.png': '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',
  '/icon-192.png': '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',
  '/icon-192-v3.png': 'iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAOdUlEQVR4nO2d229c1RXG1/kHYve9jqavxSH2SynELc5DW0QATwSlhN5MCy2USthCKiVIjS2VFJCojVRKWm4Ot1BKlTGXCpUH7BKH8mRHcVDfMHHKG8LOP5B+3zk+ZjKM7Zk5l9nn7O8nraw9gYfI/r41a+3ZZ09gXebSpUsDSHsRFTPjuhdBhk2UiTmLWEMsbcQnQRAwd40AkSsbgr8WMWxR9CKEv6wh5iyK+SBnQ+RiAIi+YmYjiDFExYTYmiXEjJnNwgwrljEBIjMg/GEzuw9RRQjRLjXEEzDCnGVEJgbYEP4RxLAJkZw5M5sMMjBCqgaA8CtmNoWoIoRImxpiHEZYsZRIzQAQPyv+GKIXIURWrCGmYYJJ5MQEiERA+BUzO4kYQAiRF0uIgzDCiiUgkQEg/irS84hehBB5s4a4IwiCGnJHdGwAiH8KaQwhRLdhSzSO3DYdGQDiZ9UfNSHcYQYmuAO5LQJEy0D4vUgUfxUhhGvMWLRLtIbcEu0a4CRSFSGEq7T1ThAgWgLiZ+UfNSHcp2UTBIgdgfinke5DCFEUnoAJxpC3ZUcDQPxVpJMIIYrGQZighrwl2xoA4q+Y2SKiFyFE0VhDDMIEK7YFOxmA4h9ACFFUlmCAQeSmbGkAiH/CohOdQhSdySAIJqwJTQ0A8VdMrY8oD2uIpq3QVgY4iVRFCFEWajDAQeTL+JIBIP5hM3sPIUTZ2B80PFTTzAAU/7AJUT7mYID9yJsEiE0g/mFT9RflZn9Q9y7QaIAa0ghCiLIyCwNUkUM2DQDxV8zsY4QQZedrwcaOUL0BxpCmEEKUnXEYYBr5MgOw+ldMiPKzBAMMIluAoPgHkBYRQvjCIEywFBtgDGkKIYQvjMMA07EBakgjCCF8YRYGqMYG+BypFyGEL6zBAF8JIP4BvFhECOEM6+vrtrz8kZ1aOG1nz56z86sXkJdtaOgau/sXd9qBA9fh/0rMIA0watFND0J0BQp7+dxHdv78KgT/AV6fCw2wHU/+acpuP/QDrBJxkAaYMJ37FzlAUbOqn10+F4r8/CoEf+o0/ktnnFn80Hbv7sOqYyZpgBoWIwghUoPVPBL7cih2ip5/lyZHH560e+6+C6uOmaUB5iz6yiIhOmIBbQureSz0JFW9HR74zf322wfux6pj5mUA0TJxC8PB9Px5DKUQO/v3bvHm7OvhUJyA0ACXsBDiMijs1dX/QeTLEHxrg2me7Nt3tb31xj+wSsSaDCDCFiaq5ujT0crk1cJ0yqHbbrU/HJ20np4evEqGDOARHELZwrCqU+wUPf/OZfr6vmp79lxhe/r7bQhVn+s0hB8jA5QUVnVW81jozC61MM1gW7O7ry8U+Z7+K5L29y0hAxQcippV3ZXBtBV27doVinxo3zWh0HfvZpXvx3/JHxmgQFDY9YMp2xeGy/RD4JHI+yD49FuYpMgAjsIWhtWcAmd2fTCNqzrFzsxWJo8WJikyQJehwFdXL6CiR4e+KHb+ncvUD6abgkeFLyIyQI6wheGhr1jozOzhXaYbg2meyAAZQFEXeTANh1KIvVuDaZ7IAAlhu0KxF20wjUSezd56kZAB2qBogylhCxNVc4gerUzZWpikyABNoMDrB9P4aSSXKdNgmifeG4DC5mBK0bOFoeDZw7sMqzqrOUUei93XFiYp3hiAoo56dQ6kiDC7XdV9HUzzpJQGYDWPxF6cQ1+NgynbF4bIlsIbgINp/aGvIg2mFDizBtPuURgDxC1M0QZTipwtDIXOdoavhTs4aQAKu2iDKVuYWORx1mDqPl01AEXNqs7WhSJnK+N6CxMPprHIo6zBtKjkZgBW80jsxRlM2cJEItdg2g78vfJzFNLf/3Wn3wkzMUDjYMrMau8yGkw7g2KPC1uzdpXiP/rwRBq3uGVCagZ4++137Nhfn3G+hWFVp8jjwTTcelQL0xI7iX07XnrhubTu80yVVAzwyom/2b2/HsfKLeLBNBI8KjzaGVYksTNpb0TwHZX3+LhGYgPwB7R38CqsuocG02TEYqfI2bJm9S7++Wef4k+3SGyARx593B597HGs8oEtTCRyHfrqhLzE3giL1Ccf/xcrt3DaABxM6w998W1UtE63xN4MXmb15yensXKLxAbgD/nbw9/FqnNYHShyDaadw503ipxi5w5cN8XeCGext9543cn5K7EByA033Rz+AlqBP4xI5BpMO4U/61jsUXbzSAh/1weuv87uuftOZ3/HqRiAuwMPHj5iJ159Da++gC0MxU6Rs5VRC9M+RRJ7/LtmLsrvOhUDxNAI/EWxujNEe0js+ZOqAURrsFDwA6UinGyN38VZ0JiLLPZmyAAZ0yh2VnZ+duIisdjjyu7DRoQMkCISe/GQATpEYi8HMkALUNgUeyeHwPKk/vOU8LMUiX1HZIAGiij2SOjRoCraw2sDSOzCGwNI7KIZpTQA99RdOQS2HfUnW3kshEJniPwovAGKKnauXT0f4xOFMoDELtKmEAbgI5ePPvbHsI93DYm92DhvAIrfleeNGw+BMUvsxcZpA3CXZu/gN8OcN41iL9shMBHhtAHY4984cgtW2SKx+4t3BpDYRT1OG4BcOfCNzWv22qX+EJieSBPNcN4ArQ7B9WKPsg6BiZ1x3gCE1y4+8tjjtoy9fyKxi7QohAGEyAoZQHiNDCC8RgYQXiMDCK+RAYTXeGUAniniU2G8yUFkCw8JcouaW9Yu440B+CzBj37ycyePVJcZfvr+0gvPhoZwES8MwMrPK9wl/u7AG6JfevE5rNzDCwO0epxCZMeZxQ+dfN7ZCwNk+S02ojX4BXlsh1zDCwM8dexpO/zQEaxEt/j33L+cPLPlhQHY+3/r2u/YxYsX8UrkDZ/BeH/+XazcwwsDEM4B/BYbmSBfeGnAyxiAXaz+xBsDEL4TvHLiNX0OkAM9PbuMt9vdfuhWrN3cAiVeGUCIRmQA4TUygPAaGUB4jQwgvEYGEF4jAwivkQGE18gAwmtkAOE1MoDwGhlAeI0MIDZZ4NfHLp8LDw2ur1803r166LbvO32YLSkygKfEYo+/cJCXBjSDx5jfnP17aU0gA3hAq2LfCj7KyEcay4gMUCJ4+0V871EsdrYzaeDqI41JkQEKSpZibwbfAfhOUDZkgAKQt9ib4eq1JkmRARyDwqbYzy4vQ/AfhK8Z3eT6679nL7/4PFblQwboIhR2vdhZ3VntXYI3Orz1xuvaBRLJKILYya5duzDsXhE+0D607+pS9v31yAAZwG3G5XMfhaIvith5kzPXZezzt0MGSEgsdoqcwym/3NtFJPbmyABtUBSx8zIqCnxPfz8CGWuJvTkywBbEn56yjWEugtjZs3Nd1oE1C2SADVjdj/3l2VDsXLuIxJ4+MgDgvaGufX8Atx/ZvrB1kdizw3sDsLW5ceQWrLpHLHaKnLnsW48u4b0BfnXvmJ149TWs8kFidwvvDXDDTTeHA28W8BsSd/f1SewO470BHjz8Owy/z2CVDIqdIo/FXsajw2XEewNwm7Pdb4+R2MuD9wYg3Pa84aZbmppAYi83MsAGPKvz9j/fwTvChQ2hR1uQotzIAMJrZADhNTKA8BoZQHiNDCC8RgbwAO5wLSz8x3irRPSE2jL+Nrrw6ujvJ7Dj5e/WrgxQQvjh3sLpD+zUKYh9h+PdPGHKqw99NYEMUAIocD6pRsGzytMA7cB3Al585SMyQAGh4BdOo6U5FbU0bHGS8vlnn+JP/5ABCgBPq7KyU+x8HjkNwTciAwgnoLh5f1AseFb5rOEzCu/Pv4uVf8gAXYaCb7ZDkydlvfm5FWSAnOGA2uoOTdbwpOs9v7zLDhy4Dq/8RAbIGAo8yQ5NmvBWCV6MNTR0dZh12lUGSB0KPu0dmk5hb88bJSh2He9ujgyQAhQ7H6vstuDZ0vBZBgqeVZ4fcontkQESwvuEeK9QN6DgQ7Ez48Ms0TbrNMCcmV2LEG3Cyp/XnUK83JZVnYIPq7wEnwbzMkACsrxTiAMr+3YKnhXe123KjAkNUMNiBCHaJM07hSj4UOwbVV4Day7M0gATZnYEIdrkqWNP2+GHOvvRaYfGCSZpgFEzex4h2oQ7PlcOXNX0OpVGOLCGvTsEzyqvHRonOEgDDGCxiBAdwH3/H/74Z7a6egGvvoCCD8XOrIHVVQYD/GEwwRpSD0J0CHeE1tcvorJzt0aCLwDrQRD0xgaoIY0ghPCFWRigGhtgDGkKIYQvjMMA07EBBpAWEUL4wiAMsBQagMAES0h7EUKUnTMQ/wCy1RtgDGkKIUTZGYcBppEvM0DFzD5GCFF2vhYEwYqBTQMQmKCGNIIQoqzMQvxV5JBGAwyb2XsIIcrK/iAI5myDywxAYII50+lQUU7mgyAYtjqaGWDY9C4gysn+oK76ky8ZgMAENSTNAqJMXNb7x2xlgIqZLSF6EEIUHT6oPQADrFgDTQ1AYIIJ03MCohxMBkEwYU3Y0gAEJuC7wF6EEEXlDMQ/gNyUnQxQMbVCorhs2frEbGsAAhNUkU4ihCgaByH+GvKW7GgAAhNMI92HEKIoPAHxjyFvS0sGIDDBjJn9FCGE6xwPgmDUWqBlAxCZQBSA40GL4iftGqAXaRohEwgXOY4YgwHWkFsiQLQNjDBjMoFwi+NBG5U/piMDEJhgGkmDsXCBlgbeZnRsAAITVJFmTJ8TiO7Aff5RiL+G3BGJDEBggoqZ8R+wFyFEXpxBVCH+FUtAYgPEwAgThgEE0YMQIivWEdMQ/oSlQGoGIDBBxfCPQ4wghEibWcQYxL9iKZGqAWJghGEzmzA9WSbSYR4xAeHPWcoEiMzYMMIYQu8IohNY8aezEH5MpgaIgREqhoEFMWoalsX2nEHMGDZWIPwVy5hcDFAPzDCANGxfRA9C+Ms6Ys42AqJfQs6N3A3QyIYhKmbGzOhFkAGEzFEOKPIlBFlDLG3ESt6Cb+T/QAhmleAZ684AAAAASUVORK5CYII=',
  '/icon-512.png': 'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAAp0klEQVR4nO3dW5NeV3kn8LU/wFidmrsUEu3cZSzF8k0YbCVuXSRQGLCocDJHmYEKh1QhDzUBzBSWqOJgpjwWFQym4mCJk4GEskywx8lc0M5IdsiN5Ugmd3FbMnM3RctfwPM876ttt9s69OE97LX371e1vHbL3CH3/7/WXnvvpjAXL7300mIp5fUxFst4pL0xFmK0lgpA3ZbLK1ZjnI6RVsp4PN80zUph5poYTFEE/c0xLZZxuOdYLOMBwCtWynicvjhWohg8ETNT0sRgQiLs98Z0fYylMg77HABs3emLY7mU8kyUgrxmAhSAbbgY+LnCXyrjsRADgOlZjbFcxuOJRiHYMgVgEyLwF2LKwD8QY6mUslgAmKeVMi4DJ2I80TTNasxsQBODq4jgvzWmg2Uc/AB017ESZSCKwCMxcwUKwGVcDP0M/BwLMQCox2qMEzmUgUtTANaI0F8spXw4xsFSymIBoA9Wynhn4HjjkcOXNTEGL4I/V/sHy3i1D0B/nYjxjSgCy2XgBl0AIvhztX+4lLJYABiSlRK//6MIHI95kJoYgxKhvxDTp2McirEQA4DhWo1xNEbuCqzGPBiDKQCCH4ArWI1xNMZgikDvC4DgB2ATVmMcjdH7ItDrAhDh7x4/AFuxUiI/ogQcj7mXmhi9E8G/VEq5K8ZSAYCtWy6lHGl6+NRArwpABP9CTPfGOFgAYHKOlVLuiCKwGnMv9KYARPh/OqbDxX1+AKZjNUbeFvhGzNWrvgBE8C+WUh6MsVQAYPqWSym3N5W/VbDqAhDhb9UPwDysxqh6N6DKAhDBv1is+gGYv+VSyjuiCGQhqEp1BSDC/0BMGf4LMQBg3lZj3N40zYmYq1FNAYjgX4jp3hgHCwB0z7FS0ZMCVRSACP/FUsrDMfbGAICuOh3jHVECVkrHdb4ARPgvlXH4L8QAgK5bjZElYLl0WKcLQIT/XTEdLgBQn0NRAjr7lEBnC0CE/4MxHSwAUK9jUQJuj7lzmhidEsG/EFNu+S8VAKjfchnfEliNuTM6VQAi/BfLOPz3xgCAvjgdI0vASumIzhSACP+9Mf0yxkIMAOib1Rj7m6Y5HfPcdaIACH8ABmI1xv6mAyVg7gVA+AMwMKsx9jdzLgFzLQDCH4CBWo2xv5ljCZhbARD+AAzcaoz9zZxKwFwKgPAHgJHVGPubOZSAmRcA4Q8Ar7IaY38z4xIw0wIQ4b9YSnk6xkIMAGBsNcYNUQJWyozMrABE+C/ElCv/vTEAgFc7HWN/M6M3Bs6yAGT4LxUA4HKWowDsj3nqmhhTF+H/YEwHCwBwNceiBNwe81Q1MaYqwv9wKeWuGADAxhxpmuZwmaKpFoAI/6Uyvu8PAGzO/qZplsuUTK0ARPgvFif+AWCrVmNM7cmAqRSACP+FmHLlvzcGALA1p6MA3BDzxE2rADwY08ECAGzXN6IEHIp5oiZeACL8D8T0cAwAYDLeESXgRMwTM9ECEOG/WNz3B4BJW41xbTPBlwRNugD8MqalAgBM2nIUgP0xT0QTYyIi/A/FdG8MAGA67ogScDTmbZtIAYjwXyy2/gFg2lZj3BAlYKVs06QKgK1/AJiNidwKaGJsS4T/oZjujQEAzMYdUQKOxrxl2yoAEf4LMT0XI2cAYDZWY1zbbOOpgO0WgGOllA/HAABm63jTNAfLFm25AET4L5Xx634BgPnY32zxg0HbKQAZ/ksFAJiX5SgA+2PetCbGpkX4HyylPBgDAJiv25umOVY2adMFIMJ/IaanYywWAGDeVsr43QCrMW9YE2NTogAcLqXcFQMA6IYjTdMcLpuwqQIQ4b8Q03MxcgYAumE1xrXNJnYBNlsADherfwDooiPNJnYBNlwAIvwXYnouRs4AQLesxri22eAuwGYKwOFi9Q8AXXak2eAuwGYKwG9jWogBAHTTShSAa2O+qibGVUX4Hyye+weAGtzebOC9ABstAM/FtFgAgK7b0C5AE+OKIvwPxPRwDACgDvubq3wjYCMF4ERMt8YAAOrwSBSAAzFf1hULQIT/Yhk/+gcA1OXapmlWymVcrQAcLh79A4AaHWmu8Ejg1QrAczEtFgCgNitRAK6N+ZKaGJcU4Z/3Dh6OAQDU6R1RAk7E/BpXKgDHSikfjgEA1Ol40zQHyyVcqQD8NqaFGABAnVajAPxOzK9xyQIQ4X8gpodjAAB1u+RtgMsVgPwf3hoDAKjb8eYStwFeUwAi/Bdi+m0MAKB+qzGubdZ9JvhSBeBATA/HAAD64TW3AS5VAI4Vp/8BoE+ON+tuA1yqADwX02IBAPpiJQrAtTG/rInxsgj/vTE9HQMA6JdrmzXfBlhfAA7FdG8MAKBf7ogCcDTmkfUF4ERMt8YAAPrlkSgAB2IeWV8AfhvTQgwAoF9e9VbAlwtAhP/emJ6OAQD00w1RAk7H/KoCcCime2MAAP10e9M0x0pYWwCOFc//AzBwp049Vc6dP1/OnTsfP5WyZ/fusmPHNeWmm94YP1XveHPxfQBrC8BzMS0WABiACxculLNnf11OnnqynDnzbIT+CzGfjX9zaTt27Cif+PhHy8f//KOj60qdjgJwQ8yliTESBeClmACgdzLYzz7769Gq/mSs8DPwswBsRYb/5z77mVERqFEUgFH2j/4R2b9USvllDACoVoZ6rurPnH12FPK5lX/y5JPxbybvfbe9p9z3zXvjqjr7m6ZZbgvAwVLKgzEAoAq5mh+H/dlR2Gfo55/NUu4CfPUrX4qrqtzeNM2xtgAcjenTMQCgc9qDeW3Q55yr/S74wfe+W2655c1xVY1vRAE41BaA5VLKzTEAYG4y1HNVnwfzzp174WLYX/5gXhfs2rWzPPP0r+KqGk80TbPUFoDnYlosADAjGeznz/8mQv5sBP72DubNW2W7ACtRAK5t4iILwEsxAcBU5Bb+eDUf9+ljK39aB/Pm5bb3vrt86768m16HKABNE9m/WEp5LgYAbEsewsst/FzVZ9hn6Oef9V2+JOgXP/9ZXFXj2iwAS8UjgABsUm7h57P1bdDnXOsW/nZVWAD2ZwE4WDwCCMBlZKjnqr6mg3mzVmEBuD0LwOFSyl0xABi4DPa1B/Ny+z4HV1ZhATiiAAAMVHswLwM+574dzJulWgvAibi4NQYAPZQBf/78C7GiH3/0JsM+/4zJ+exffmb0fYCKHM8CsFy8BAigF3ILPw/mZcDnFn4Gft7DZ7pW/v3fRh8JqsgTCgBAhTLU82BeruYz5Mezg3nzUNs7AC5SAAC6Llfz47B3MK+L8jXA+TrgyowKwEtxAUAHOJhXl/wccH4WuEKrCgDAHGTArz2Ydy6ubeHXpeLwH1EAAKYsg93BvP7YufN15VvfPFr27bsxfqqXAgAwIRnq43v1eSAvV/UR+LbweyOf9X/fbe+OUe+qfy0FAGALcjU/DvthffRmKHbvvq7siZGH+/ZF8O/Zc11tj/ldlQIAcBV5MC9X823QW9X3xzXXXDMK9wz7V+bd8W/6TwEAuKjdwncwr5/y3v045HePVvW5us8xVAoAMEgZ7Gs/epOBnwWAfsj79bt27rwY+NdVf2BvGhQAoPdyCz+37jPkcyvfFn5/tFv4+266cRT0u3blKn8YW/jbpQAAvZGH8HILP1f1GfYZ+vln9MMQDubNkgIAVClX9bmab4M+Z1v4/dCu6jPsc86tfFv4k6cAAJ2WoZ6r+jyYd+7cCxfD3sG8vlh7MO/lwI8VPtOnAACdkcHuYF5/OZjXLQoAMBe5hZ+r+bxHn7ODef3RbuHnwbzRobwIewfzukcBAKYqA37tR28y7PPP6Ic8mDcO+fGz9Rn8DubVQQEAJia38POjN23Q52wLvz9yC3+8mo/Qj618W/h1UwCATctQdzCvvxzMGwYFALiiDPa1B/Ny+z4H/ZBb+G3It7Mt/GFQAICXOZjXXw7msZ4CAAOUAb/2YJ6P3vRLrurHIT8+mJfb9zlgLQUAei6DPQ/mZejnFn4Gft7Dpx/ag3kZ8Dk7mMdGKQDQExnqeTAvt+4z5MezVX1f5MG8DPncws+gz+38/Bm2SgGACuVqfhz2Dub1UW7htyHfzg7mMWkKAHRcHsxb+9EbB/P6oz2Y14b8eHYwj9lQAKAj2i18B/P6KbfwxyHvYB7doADAHGSwO5jXXw7mUQMFAKYoQz1X9bl1nyGfW/m28PsjV/UZ8u3BvNGjd7bwqYQCABOSq/lx2J8dhX2Gfv4Z/dAezBsHfqzwYzvfwTxqpgDAFjiY11/rD+b56A19pQDAFbRb+Hkwz0dv+ie38DPk82Dey4EfK3wYAgUALspgX/vRm1zdZwGgH/JgXq7mM+Qz7K3qGToFgEHKLfzxaj7u08dWvi38/mi38B3MgytTAOi1PISXW/i5qs+wz9DPP6MfHMyDrVMA6I3cws9n69ugz9kWfn/kFn6GfYZ8buXbwoftUQCoToZ6ruodzOsnB/NgNhQAOi2Dfe3BvNy+z0E/5Ko+V/MZ8m3Y28KH2VAA6Iz2YF4GfM4O5vXH2oN5o0N5o7B3MA/mSQFg5jLgz59/IVb044/eZNjnn9EPeTBvHPLjj95k8FvVQ/coAExVbuE7mNdfuYU/Xs1H6MdWvoN5UA8FgInIUM+DeW3Ij2cH8/oiD+blQbzcwn858ONnoF4KAJuW2/XjsHcwr49yC78N+Xa2hQ/9owBwRQ7m9ZeDeTBsCgAjGfBrD+adi2tb+P2Rq/pxyI8P5uX2fQ5guBSAAcpgz4N5Gfq5hZ+Bn/fw6Yf2YF4GfM4O5gGXogD0WIb6+F59HsjLVX0Evi383lh/MG+0wreFD2yQAtATuZofh72P3vRRbuGPQz4DP1b4ce/ewTxgOxSACuXBvFzNt0FvVd8f7cG8DPtXZqt6YPIUgA5rt/AdzOun3MIfh7yDecDsKQAdkcHuYF5/OZgHdI0CMAe5hZ9b9xnyuZVvC78/2i18B/OArlMApihX87mF72BePzmYB9RMAZiQXNXnar4N+pxt4fdDu6rPsM/ZR2+APlAANilDPVf1eTDv3LkXLoa9g3l9sfZg3suBHyt8gL5RAK4gg/38+d9EyI8/emNV3y95MC9X8xnyGfZW9bBxeTszF0P5+zHl7a/87yhLtNJcBwXgotzCH6/m4z59bOU7mNcf7RZ+HswbHcqLX1IO5sHGbXYxlGX6s//tv45mumtwBSBb69qP3mTo55/RD3kwbxzy42frM/hzZQJsTIZ9PpLc/n7czmIoC8APvvc3/hvsqF4XgPV/kXO+UmulLrmFP17NR+jHVn7+sgE2bv3vyO2E/eXk7YAsAXbduqc3BSCD/dSpfy6PPvb46C9y/sWmH/KeYoZ8rupfDvz4pQJsXP5OnHbYX07+9/pPy/9oJ6Bjqi8AGfz3f+eB8u37HxhdU7dc1edqPkO+DXu/NGBz8kxTnmWaR9hfTu7Q/f0jfxdXdEXVBSAD/223viv+klvt18bBPJiMDPsM+Tbsu/z7MAtAFgG6odoCkOF//Q3/eTTTbesP5uV2YA5gc2oK+0t5y1veVH74/Qfjii6osgBk6Fv5d1Nu4edqPgM+Z20ftqb2sL+c3/6//xv/pAuqLABfu/uecvfX74kr5iUP5mXI5xZ+Bn1u5+fPwObkgiZfqJOPJg/h7aJuA3RHdQUgn9n/46U/Hf1Hw2zkFn4b8u3sYB5sXv7easO+Xdnn77QhUQC6o7oC8O37/7rc+YW74opJaw/mtSE/nh3Mg60Q9pemAHRHdQXgrW//s9G9MbYnt/DHIb87tvEdzIPtEPYbpwB0R3UF4Hf+4+/GP9kMB/NgcjLYM+zzvfjCfvPyhUB2FrtBAeiRXNVnyLcH80aP3vkPDbYsg70N+418BIcry99R/3r6X+KKLlAAKtUezBsHfqzwYzvfwTzYOmE/fV/58pHyiY9/LK7oAgWg4xzMg8kT9rOXv8v+9fSvLFQ6pLoC0OdDgLk9Ng55H72BScln6td+BCdnYT97H//zj5avfuVLcUVXVFcA+vIYYB7MW/vRGwfzYPvWh30XPoLD+PfdL37+s7iiS6orALl1d/0Nb4irOuS2V4a8g3kwWcK+Dhn+P/z+d239d1B1BSB98lOHykM//mlcdYuDeTAdwr5Otv27rcoCkPfv3vr2d5az8YtgHtpVfYZ9zrmVbwsfJiPP+GTIZ9jnN+2FfV3yLNMtb3nz6LR/LoborioLQMoVQZaAF198MX6anvzLnCHvYB5M3tqwH8/9/QhOH7WLofYWZ177/ViPagtAyvMA7//gRya2E5D3qnI1n3+J27/MtvBhMoR93YR9/1RdAFLeDvj2/Q/E+OsN7was/Ys8OpQ3+svsYB5MirCv29rfkePfj8K+j6ovAK0sAj966Kfxi2Z83zB/AaU8mDcO+d3xl9nBPJik/O8uX6jjIzj1Wnub0+/IYelNAQCmS9jXT9izlgIAvIawr5+w52oUABg4YV8/tzrZCgUABiSDPcPeR3DqlWHfHszL2TtI2CoFAHpK2NdP2DNNCgD0gLCvn7Bn1hQAqEw+U3/+/G+EfcXWv3RM2DMPCgB0WIa9j+DULcM+Q74Ney8doysUAOgIYV8/YU9NFACYA2FfP2FP7RQAmLJ8LXW+nlrY12nte/HHz9oLe/pBAYAJyrDPkG/DPlf61GNt2I+DPl+w4yM49JMCAFsk7Osm7Bk6BQA2QNjXTdjDaykAsEY+T58v1Mn34p8794Kwr9Daj+AIe7g8BYDBWhv27co+36hHPdaGvY/gwOYoAAyCsK+fsIfJUgDoHWFfP2EP06cAULUM9gz7fC++sK/T+o/g5CzsYfoUAKqRwd6GvY/g1Gl92PsIDsyPAkAnCfv6CXvoNgWAuRP29RP2UB8FgJnKZ+rXfgQnZ2Ffl7Ufwclv2gt7qJMCwNSsD3sfwanP2rAfzz6CA32hADARwr5+wh6GRQFg04R9/YQ9oABwRWs/gpPftBf2dfERHOByFABetjbsx7OP4NRE2AOboQAMlLCvm7AHtksBGABhXzdhD0yDAtAj+Tx9vlDHR3Dq5SM4wKwoAJXL1fxDP/7b8uhjjwv7ygh7YJ4UgEpl8N/53w87lV8JYQ90jQJQoR899JNy5xcOj7b86Z58L/6uXRH4wh7oMAWgMo8++nj5wIc+Eld0QYZ9ezAvZ+/FB2qhAFQkt/3fduu7rPznRNgDfaIAVORtt77TPf8ZEfZA3ykAlcjgzwLA5OV78fOztsIeGBIFoBKf/NSh8tCPfxpXbEeGfYZ8G/Y+ggMMlQJQicXf+333/jdJ2ANcngJQid/5j78b/+RyhD3A5igAFXD//xVr34s/ftZe2ANshQJQgdz6z1sAQ7M27MdBny/Y8REcgElQACrR91sAwh5gthSASvzRzX9Szp59Nq7qJ+wB5k8BqMTX7r6n3P31e+KqLms/giPsAbpDAahEfur3+hveEFfdtTbsfQQHoNsUgIp8/s4vlvu/80BczZ+wB6ibAlCRfBrgrW9/58zPAgh7gP5RACqTtwLe+vY/K+fPvxA/Td76j+DkLOwB+kcBqFDuBLz/gx8pp049FT9t3fqw9xEcgOFQACqWbwj82tfv2VAREPYArKUA9MCZM2fLo4/9w2hn4MzF8wEZ8vm4Xc7CHoD1FAAAGCAFAAAGSAEAgAFSAABggBQAABggBQAABkgBAIABUgAAYIAUAAAYIAUAAAZIAQCAAVIAAGCAFAAAGCAFAAAGSAEAgAFSAABggBQAABggBYC5uXDhQnnsf/1DOXnyqXLu/PmYn4w/BWqyY8eOsmfPdWXP7uvKvptuLG95y5viT6mBAsBcPPTjn5bP33nXqAQA/bFr185y31/dW/btuzF+ossUAGYqA/9Tf3FHefSxx+MnoK8+8fGPla98+Uhc0VUKADOT4f+2W99Vzpw5Gz8Bffe+295T7vvmvXFFFykAzMwHPvgRK38YmNwFyN0AukcBYCZ+9NBPRlv/wPA88/SvRmcD6BYFgJm4/oY3lHPnzscVMDS3vffd5Vv3HY0rukQBYOoeffTx8oEPfSSugKFa+fd/Gz0ySHcoAEzd5+/8Yrn/Ow/EFTBUP/jed8stt7w5rugKBYCpe+vb/6ycOvVUXAFD9dm//Ez53Gc/E1d0hQLA1CkAgALQPQoAU6cAAApA9ygATJ0CACgA3aMAMHUOAQIOAXaPAsDU5Vf+3nbrO+MKGCqPAXaPAsBM/MHePyznz78QV8DQeBFQNykAzISXAcFweRVwNykAzMwnP3WoPPTjn8YVMBT5NcD8KiDdowAwU39085+Us2efjSug72z9d5sCwMzZCYD+8xng7lMAmIs8E/D5L3zRwUDomZtuemP53F9+puzbd2P8RJcpAMxVPiL46GOPlzMXbwt4YRDU45prril79lwXV6Xsu+nGcstb3hQ/746fqIECAAADpAAAwAApAAAwQAoAAAyQAgAAA6QAAMAAKQAAMEAKAAAMkAIAAAOkAADAACkAADBACgAADJACAAADpAAAwAApAAAwQAoAAAyQAgAAA6QAAMAAKQAAMEAKAAAMkAIAAAOkAADAACkAADBACgAADJACAAADpAAAwAApAAAwQAoAAAyQAgAAA6QAAMAAKQAAMEAKAAAMkAIAAAOkAAB0wJkzZ8v5878pZ86eLTt27Ch7dl9Xdu/+T6NrmAYFAGDGMuzPPvvrmJ+NwH+2nDz5ZPzppe3atbN87rOfKbe9993xE0yOAgAwRadOPTUK+TbsM/y3IovAD773N2XPnt3xE2yfAgAwIZMK+yu575v3lvfd9p64gu1RAAC2YBZhfzk/+N53yy23vDmuYOsUAIAruHDhQjl79tfl5KknI+SfLefOvxDz7ML+UvJg4D8t/+PotgBslQIAcNH6sM+V/blz5+PfdE8eCvzWfUfjCrZGAQAGqaawv5xnnv6VXQC2TAEAei+DPcM+n7GvNewvxYFAtkMBAHolg70N+5N5UC8CP1f7ffSWt7yp/PD7D8YVbJ4CAFRrSGF/KTfd9Mbyi5//LK5g8xQAoAp58j7fnpehP8SwvxQFgO1QAIDOacM+Qz7v11/pVblDpgCwHQoAMFfCfuucAWA7FABgZvLteefOnxf2E+KNgGyHAgBMRYZ9hnwb9rnSZ3J27nxd+dfT/xJXsDUKALBtwn72vvLlI+UTH/9YXMHWKADApgj7+bvmmmti9f+r0TcBYKsUAOCS8hG7fMa+5lfl9lV+CGjPnt1xBVunAADCvhK58v/qV454/S8ToQDAwAj7OuWhvx9+/7tW/kyMAgA9lsGeYT/UV+X2Qb7s5323vTuGVT+TpQBATwj7+uUqf8+e68qe3bvLvgj+vHbQj2lRAKBCwr5+wp55UwCg4/Ixu7Wvys1Z2NdF2NNFCgB0yPqw96rc+uzenUEfI0I+5337bow/he5RAGBOhH39hD01UwBgBta+PS8/hiPs6yPs6RsFACZsbdiPZ6/KrU0+epchn2G/a+dOYU8vKQCwDcK+fmvDfjx70Q7DoADABuSp+3zsLt+ed+7cC8K+UsIeXqEAwDprw75d2edz99Qj35mfIb/vphtHQb9rVz6GJ+xhLQWAQRP29Vsf9nm9a9fO+DfAlSgADEYG+/nzLwj7igl7mBwFgF7KYM+VvVfl1mvt2/OEPUyeAkAv5IG8U0/+c3n0scfjWtjXZm3Ye1UuzIYCQNXyhTp3/4//OZqpg7CHblAAqNbdX7+nfO3ue+KKrsq3541O4At76BwFgCp96i/uKD966CdxRVdk2Lf36nP29jzoNgWA6mTwZwFgfoQ91E8BoCp5uv+Pl/7UIb8Zyrfn5fvwhT30iwJAVT75qUPloR//NK6Yhgz7DPk27L09D/pLAaAauepf/L3fjysmQdjDsCkAVMO9/60T9sB6CgDVyEf+8tE/Ls+rcoGNUgCohvv/rybsge1QAKjG5+/8Yrn/Ow/E1fAIe2DSFACqMZRbAOtflZtBnwNgkhQAqvHoo4+XD3zoI3HVH+vDPq+9KheYBQWAatT+GKCwB7pEAaAq7//g7eWxx/4hrrpt/atycxb2QJcoAFQlXwV8/Q1viKvuWB/2XpUL1EABoDrzfBpA2AN9oQBQpVm8E6B9e16ewM9Z2AN9ogBQrUnuBLRh367svSoX6DsFgKqdPPlk+drX7ymnTj0VP22MsAdQAOiJLAKPPvZ4OXP22XLmzLPlxRdffNXb83btep2wB1hDAQCAAVIAAGCAFAAAGCAFAAAGSAEAgAFSAABggBQAABggBQAABkgBAIABUgAAYIAUAAAYIAUAAAZIAQCAAVIAAGCAFACATTh37nw5e/bX5czZs/FTGX1u+ppr/oNPTVMdBQDgCs6cOVtOPfnP5eTJJ8vJU0+VCxcuxJ++1q5dO8snPv6xctt731V27NgRfwLdpgAArHEqQv7kqScj+J+N+fKBfzkZ/vf91b3lllveHD9BdykAwKC1gZ9hn6v8ScndgK98+UhcQTcpAMBg5Gr+1KnYzr8Y+Lm9P01ZALIIQBcpAEBv5YG9U09m0I+386cd+Jfy94/8Xdm378a4gm5RAIDeaAP/5MkYscrPn+ctnw74p+V/jCvoFgUAqFau6DdyQn/esgBkEYAuUQCAarQH9tot/a4G/nof//OPlq9+5UtxBd2hAACd1QZ+hn2u8mt1001vLL/4+c/iCrpDAQA6IVfzszyhP0sKAF2kAABzkQf08sBeu53fp8BfTwGgixQAYCbawO/SCf1ZydcEP/P0r+IKukMBAKYiV/Q1nNCfhd27ryv/54n/HVfQHQoAMBHtgb12S3/Igb/efd+8t7zvtvfEFXSHAgBsSRv4Gfa5yufyVv7930YfCYIuUQCAq8rVfF9P6E/bbe99d/nWfUfjCrpFAQBeIw/o5YG9djtf4G/NNddcU37x87/zFkA6SQEAXg78IZ7Qnyb3/ukyBQAGKFf0TuhPl/Cn6xQAGID2wF67pS/wp2fnzteVr375S+WWW94cP0F3KQDQQ23gZ9jnKp/py2f933fbu0fDiX9qoABA5XI174T+7GXg77vpjWXPnpxvHL3tD2qiAEBl8oBeHthrt/MF/my0gZ9hv2/fG63yqZ4CAB3XBr4T+rOVH/AZhX3O+26MP4F+UQCgY3JF74T+bOXz+rmq37N7t8BnMBQAmLP2wF67pS/wp68N/HaF70U9DJECADPWBn6Gfa7ymb58NG8U9hdD34E9UABg6nJF/9CP/7b86KGfxirfgb1ZaA/sOaEPl6cAwBTd/fV7yrfvf2BUApieNvAz7HOV74Q+XJ0CAFOQgf+BD/0XW/xT4oQ+bNuFLADLpZSbYwAT8sdLf2q7f0LaA3tO6MNEPaEAwIR9/s4vlvu/80BcsRVt4LcrfCf0YSoUAJikfEnP9Te8Ia7YKCf0YS5GBeBEXNwaA9gmq/+raw/sOaEPc3U8C8DhUspdMYBtytV/7gLwijbwM+xzle+EPnTCEQUAJuTRRx8vH/jQR+Jq2JzQhyqMCsDBUsqDMYBt+Nrd94ye+x+S9sCeE/pQnduzACyVUn4ZA9iGIRSANvDbFb4T+lCt/VkAFkspz8UAtuHb9/91ufMLd8VVfzihD711bRP/KFECXooJ2IZ869/bbn1nXNWrPbDnhD70W5NizgKwUkp5fQxgi/LNf/kGwJq0gZ9hn6t8J/RhEJ5vmmaxiYssAMvFy4Bg2/5g7x+W8+dfiKtuckIfCE80TbPUFoCjMX06BrANXToI2B7Yc0IfWOcbUQAOtQXgYPEoIGxbfgXwj27+k7nsArSB367wndAHLuP2pmmOtQVgqXgUECZiVi8EckIf2KL9TdMsjwpAihLwUkzABPzooZ+UT/3FHXE1Oe2BPSf0ge2I8B9l/+gfKfJ/pXgSACYmHwt8/wc/Ul588cX4afPawM+wz1W+E/rABDwT+b835lcVgGOllA/HACYkzwR8+/4HRjsCVzsX4IQ+MAPHm6Y5WMLaAnCwOAgIU5M7AidPPTUqBWfOPlt27dw52sYX+MAM3d40zbES1haA3BJ4OgYA0E83RAE4HfMrBSBFCViNaUcMAKBfLkT4L8Q8sr4AnIjp1hgAQL88EgXgQMwj6wvAoZjujQEA9MsdUQCOxjyyvgDsjenpGABAv1zbNM1KuehVBSBFCVgp3gcAAH3yfNM0i2WNJsarRAE4VrwPAAD65Hhz8fn/1qUKwIGYHo4BAPTDO6IAnIj5ZZcqAAsx/TYGAFC/CzEWowCsxvyy1xSAFCXgREy3xgAA6na8Wbf9ny5XAA7E9HAMAKBur9n+T5csAClKwGpMO2IAAHW6EOG/EPNrXKkAHCueBgCAmh1vLrH9n65UAA7E9HAMAKBO74gCcCLm17hsAUhRAlaKlwIBQI2eb5pmsVxGE+OyogAcLqXcFQMAqMuRpmkOl8u4WgFYLKU8FwMAqMu1zZp3/693xQKQogTkvYNbYwAAdXgkwv9AzJe1kQKwVEr5ZQwAoA77m6ZZLldw1QKQogSsFIcBAaAGzzdNs1iuoolxVVEADpZSHowBAHTb7U3THCtXsaECkKIErMa0IwYA0E3PN02zWDagibEhUQAOF48EAkCXHWmu8OjfWpspAAsxrRS7AADQRZf87O/lbLgApCgBh4tdAADooiPNBlf/abMFYCGmlWIXAAC6ZFOr/7SpApCiBBwudgEAoEuONJtY/aetFICFmE7HeH0MAGC+nm+aZrFsUhNj06IEHCzeCwAAXXB7s4Hn/tfbUgFIUQKWSyk3xwAA5uOJpmmWyhZspwAsFd8IAIB52t9c5Z3/l7PlApCiBBwrpXw4BgAwW8ebpjlYtmi7BWAhppXisUAAmKVNP/a33rYKQIoScCime2MAALNxe7OFg39rbbsApCgBy8WBQACYhSeaLR78W2tSBWCxjN8NsCMGADAdufW/NwrAStmmiRSAFCXgUEz3xgAApuOOCP+jMW/bxApAihKwXNwKAIBpeKKZwNZ/a9IFYCGmleJWAABMUm79b+vU/3oTLQApSsCBmB6OAQBMxjsi/E/EPDETLwApSsCx4gVBADAJ34jwPxTzRE2rACzEtFxKuT4GALA1z0T474154qZSAFKUgMXi0UAA2Kq87z+RR/4uZWoFIEUJWCo+GAQAW7G/2eKHfjZiqgUgRQk4XEq5KwYAsDF3RPgfjXlqpl4AUpSAY8WhQADYiOPNNr7yt1EzKQApSsBy8ZIgALiSJ5oJvuznSmZZABZiWi6eDACAS3kmxlIUgNWYp25mBSBFCVgsngwAgPUuxFicVfinmRaAFCVgb0zLRQkAgJThvxThfzrmmZl5AUhKAACMzCX801wKQFICABi4uYV/mlsBSEoAAAM11/BPcy0ASQkAYGDmHv5p7gUgKQEADEQnwj91ogAkJQCAnutM+KfOFIAUJWCxlHIixvUxAKAvnolxIMJ/pXREpwpAihKwENOJGF4bDEAfPBEjw3815s5oYnRSFIFjxQeEAKjb8WYGH/bZis4WgBQl4HDxKWEA6jT1T/puR6cLQIoSsFTGtwR2xACArrsQI7f8l0uHdb4ApCgBi2VcAq6PAQBd9UyMDP+V0nFVFIAUJWAhpqMxPhwDALrmGxH8h2KuQjUFoBVF4EBMx4pbAgB0w4UYByP8T8RcjeoKQIoSsBDTiRg3xwCAeXkiRm75r8ZclSZGtaIIHIrpcLEbAMBs5ar/cAT/0ZirVHUBSFECFsv4loDdAABm4YkYByP8V0rFmhi9EEXgUEyHi90AAKYjV/2HIviPlR7oTQFIUQIWYjoa48MxAGBSjsfI8F+NuReaGL0TRWCpjHcDbo4BAFv1RIzDEfzLpWeaGL0VReBgif/jSimvjwEAG/V8jAz+Y6Wnmhi9FiVgIaZDF4fzAQBcSd7nP5ojwn815t7qfQFoKQIAXMFggr81mALQUgQAWOP5GMfKgIK/1cQYrCgDB0vc4ynOCAAMzfMxen2P/2qaGIMXRWCpjHcEbo0BQH89EiNX+8tl4BSANaIILJZSDpbxsCsA0A/PxzhWYkTwrxRGmhhcQpSBAzG1Y0cMAOpxIcaJHBH6ObOOArABa8rAh2MA0E1CfxMUgE2IIrAQ01IZl4Gl4jYBwLw9H2O5ROjHWI7gX42ZDWhisEVRCPbGtFReGW4VAExXrvKXy3jkSn+lsCUKwARdLAQ5lsp4vj4GAFv3TIzTMZZLzBH4ec0EKABTFqVgqZSyWMaFIMdicesAYL3nY6yUCPmLYyXCfrkwNU0M5iCKwWIpZbG8MtJiGY/W3hg7YgDU6EKM0zFaK2U80kq5OCLoVwoz9/8BzN/pjJM1Cg0AAAAASUVORK5CYII=',
  '/icon-512-v3.png': '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'
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
    { "src": "/icon-192-v3.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icon-512-v3.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
`;
function isAnthropicCompanyMark(url) {
  return typeof url === 'string' && /(?:^|\/\/)(?:www\.)?github\.com\/anthropics(?:\.png)?(?:[/?#]|$)/i.test(url);
}
function logoForAgentLogin(login) {
  const key = String(login || '').toLowerCase();
  // xAI's published logomark (assets/grok_logo.svg, served at /grok_logo.svg).
  // NOT `github.com/xai-org.png`: that is the avatar of an org GitHub calls
  // "SpaceXAI Org", and it is the SpaceX X -- every Grok reply on a doc was
  // signed with another company's logo.
  if (key.includes('grok') || key.includes('xai')) return '/grok_logo.svg';
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
  // Escape until it stops changing, because one pass can REBUILD the thing it
  // is removing. `--->` has its first pair rewritten to `-\-`, and the `-` that
  // was left over joins the tail of the replacement to spell `-->` again:
  //
  //   '--->'  ->  '-\\-->'   which still closes the comment
  //   '---!>' ->  '-\\--!>'  which still closes it the other way
  //
  // This banner is an HTML comment carrying every comment's text, concatenated
  // into the published document, and anyone who may comment writes that text.
  // One pass made that a stored XSS: close the comment, and the rest of the
  // string is document.
  //
  // The loop terminates -- every pass inserts a backslash between the pair it
  // rewrote, so the number of `--` occurrences strictly decreases.
  let out = String(s == null ? '' : s);
  for (let pass = 0; pass < 8; pass += 1) {
    const next = out.replace(/--/g, '-\\-');
    if (next === out) return out;
    out = next;
  }
  return out;
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

const READER_PATCH_CSS = ':where(body){overflow-wrap:anywhere}:where(body table){overflow-wrap:normal}:where(body>.wrap,body>main,body>article,body>.content,body>.container)[data-tdoc-width="wide"]{max-width:none}.tdoc-table-scroll{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}.tdoc-table-scroll>table{max-width:none}';
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
function shellDocumentWorker(rawHtml, slug, version, identity, versions, isOwner, ownerManage, nonce, isLanding, canSeeMyDocsFlag, isCatalog, webAuth, stars, viewerStar, versionWritesEnabled, commentWritesEnabled, docMeta, oidc, pageUrl) {
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
    // Landing keeps meta.commenting off (no KV writes) but still opens the
    // real sidebar so visitors can try highlight / reply. The shell stores
    // those in memory only — see demoComments.
    canComment: !!commentWritesEnabled || !!isLanding,
    demoComments: !!isLanding,
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
    // The internal bar goes on every page a walk passes through, and a walk
    // starts at the landing page -- everything between there and the gate is
    // part of what is being tested. Rides in the options seat rather than
    // becoming a nineteenth positional argument.
    debug: !!(oidc && oidc.debug),
    mode: 'published',
    versions: vlist,
    stars: stars || null,
    viewerStar: viewerStar || null,
    runtime: runtimeInfo(),
  };
  const hasCta = /<a[^>]+href="\/start"/.test(rawHtml || '');
  cfg.onboarding = slug === LANDING_SLUG || slug === START_SLUG || hasCta;
  // The doc takes comments and this visitor has none of the sessions that may
  // leave one. The Comment option still shows and opens the sign-in: the door
  // is where the person looks for it, not a button in the corner.
  cfg.signInToComment = !identity && !isLanding && !!versionWritesEnabled
    && accessFromMeta(docMeta || {}).commenting !== 'off';

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
  // Share cards and search engines never enter the sandboxed /frame. Put a
  // short excerpt + absolute URLs on the shell so Twitter/OG/SEO can work.
  const origin = (() => {
    try { return pageUrl ? new URL(pageUrl).origin : ''; } catch (_) { return ''; }
  })();
  const access = accessFromMeta(docMeta || {});
  const description = (SHELL.excerptFromHtml && SHELL.excerptFromHtml(rawHtml, 180)) || '';
  const cachedImage = docMeta && docMeta.preview && typeof docMeta.preview.image === 'string'
    ? docMeta.preview.image
    : '';
  const fromHtml = (SHELL.previewFromHtml && SHELL.previewFromHtml(rawHtml, {
    slug, version, maxLen: 180,
  }).image) || '';
  let shareImage = cachedImage || fromHtml || '';
  if (shareImage && shareImage.startsWith('/') && origin) shareImage = origin + shareImage;
  // -v2 cache-busts Apple/iMessage OG caches that pin the old tornado PNG URL.
  if (!shareImage && origin) shareImage = `${origin}/tdoc_logo-v2.png`;
  // Homepage share cards: never use the slug title or the first inline SVG
  // (brand mark) — crawlers only see the shell SEO, not the framed landing.
  let seoTitle = title;
  let seoDescription = description || (isLanding ? 'Docs that fix themselves.' : `A tdoc by ${author || 'tdoc'}.`);
  if (isLanding) {
    seoTitle = 'Tornado: AI Native Docs';
    seoDescription = 'Your AI-native docs. Agents draft; you comment; they rewrite. Open source and free.';
    shareImage = origin ? `${origin}/tdoc_logo-v2.png` : '/tdoc_logo-v2.png';
  }
  const seo = origin ? {
    title: seoTitle,
    description: seoDescription,
    url: pageUrl,
    image: shareImage,
    type: isLanding ? 'website' : 'article',
    robots: access.visibility === 'private' ? 'noindex, nofollow' : '',
  } : null;
  return SHELL.shellHtml({
    title: isLanding ? seoTitle : title,
    nonceAttr,
    cfgJson: safeJsonForScript(cfg),
    bootJson: safeJsonForScript({
      frameSrc: `/d/${encodeURIComponent(slug)}/v/${version}/frame`,
      oldVersion,
    }),
    runtimeJsPath: SHELL_RUNTIME_JS_PATH,
    runtimeCssPath: SHELL_RUNTIME_CSS_PATH,
    seo,
  });
}

// ---- onboarding (shared with server.js; test/no-drift.test.js pins these) ----
// A step is a timestamp, never a boolean: resuming reads the first one that is
// empty, the checklist renders from the same object, and the funnel is read
// off the stamps rather than from a second set of counters.
function stampOnboarding(record, step, at, extra) {
  const out = record && typeof record === 'object' ? { ...record } : {};
  if (step && !out[step]) out[step] = at;
  if (extra && typeof extra === 'object') {
    for (const key of Object.keys(extra)) if (out[key] == null) out[key] = extra[key];
  }
  return out;
}
// Accounts allowed to drive their own onboarding state from the page, for
// testing the gate's branches without hand-editing storage. Comma-separated
// emails in TDOC_DEBUG_ACCOUNTS; empty (the default) allows nobody. It grants
// one power and no other: clearing YOUR OWN onboarding record.
const DEBUG_STATES = ['new', 'started', 'connected', 'published', 'commented', 'revised'];
function debugRecord(state, at, firstDoc) {
  const doc = firstDoc || null;
  switch (state) {
    case 'new': return {};
    case 'started': return { started: at };
    case 'connected': return { started: at, agent_connected: at };
    case 'published': return { started: at, agent_connected: at, published_first: at, first_doc: doc };
    case 'commented': return { started: at, agent_connected: at, published_first: at, first_doc: doc, commented: at };
    case 'revised': return { started: at, agent_connected: at, published_first: at, first_doc: doc, commented: at, revised: at };
    default: return null;
  }
}

// Accounts allowed to put their own onboarding record into a named state, for
// internal testing. The list is operational data, not build config: an email
// is not a credential, and a deploy is the wrong price for adding or taking
// away a name. It lives in KV under `debug-accounts`, comma-separated, and an
// absent or empty key allows nobody, which is every deploy's default.
// Two sources, and the account has to be in either. `TDOC_DEBUG_ACCOUNTS` is
// filled at deploy from a repository variable -- a variable and not a secret,
// because an email is not a credential -- so letting another tester in is a
// field on a settings page. The KV key stays, additive, for a change that
// cannot wait for a deploy; it is the only one of the two that can be written
// without the repository, and the only one that needs Cloudflare credentials.
//
// It cannot be inferred from TDOC_OWNER, which is the deploy's GitHub login:
// an account that signed in through the provider has an email and no login at
// all, so the two never match.
function debugAccountList(env) {
  const fromEnv = String((env && env.TDOC_DEBUG_ACCOUNTS) || '');
  // An unset repository variable leaves the placeholder behind rather than an
  // empty string, and a placeholder is not a name.
  return fromEnv.includes('PLACEHOLDER_') ? '' : fromEnv;
}

async function isDebugAccount(env, session) {
  const email = normalizeEmail(session && session.email);
  if (!email) return false;
  // Commas, newlines, semicolons or spaces. The settings page hands somebody a
  // multi-line box and the docs said "comma-separated", so the list arrives in
  // whichever shape the person reached for -- and a list that silently matches
  // nobody looks exactly like a list that was never set.
  const named = (raw) => String(raw || '')
    .split(/[\s,;]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
  if (named(debugAccountList(env))) return true;
  let raw = '';
  try { raw = String((await env.META.get('debug-accounts')) || ''); } catch { return false; }
  return named(raw);
}

// Which actions the page may report, and which step (if any) each one stamps.
// Anything else is rejected: the log is what the funnel is read from, so a
// page cannot invent a step.
function onboardingActionStep(action) {
  switch (action) {
    case 'door_own_agent': return 'started';
    case 'waitlist': return 'waitlist';
    case 'tour_seen': return 'tour_seen';
    case 'share_link_copied': return 'shared';
    case 'example_opened':
    case 'copy_clicked':
    case 'fix_copy_clicked':
    case 'timeout_shown':
      return null;
    default:
      return undefined;
  }
}
// A second POST of the same words, from the same person, on the same spot,
// within seconds of the first — a double ⌘+Enter, a click after the key, a
// retry on a slow write — is the same comment, not a second one. Returns the
// record it duplicates, or null. Identical on both hosts (no-drift).
function duplicateComment(comments, { author, text, anchor, parent_id, at }, windowMs = 15000) {
  const now = Date.parse(at || '') || Date.now();
  const login = author && author.login;
  const words = String(text || '').trim();
  const same = (r) => Boolean(r && r.author && login && r.author.login === login)
    && String(r.text || '').trim() === words
    && now - (Date.parse(r.created || '') || 0) < windowMs;
  if (parent_id) {
    for (const c of comments || []) {
      for (const r of c.replies || []) if (r.parent_id === parent_id && same(r)) return r;
    }
    return null;
  }
  const spot = (a) => (a && (a.text || a.aid || a.selector)) || '';
  for (const c of comments || []) {
    if (same(c) && spot(c.anchor) === spot(anchor)) return c;
  }
  return null;
}

// The first comment on somebody's first doc, from tdoc and signed as tdoc —
// not a person pretending to be one. Anchored to the first paragraph so it
// lands on text the reader can see, and worded to ask for the one gesture the
// page exists to teach.
// ---- the onboarding half ----------------------------------------------
// Setup ends at My docs, and the onboarding starts there -- but on nothing we
// put there. The four rows all stand on the doc the person made themselves:
// the account arrives empty, row 2 asks for a doc, and rows 3 and 4 are that
// same doc being argued with and then fixed.
//
// A template copied into an "Onboarding" folder used to sit here, so that the
// loop could be walked before they had written anything. It was the wrong
// object twice over: nobody argues with a generic page about nobody, and its
// existence made "Create your first tdoc" tick on a doc we wrote. What it was
// really for -- a first comment already on the page, so row 3 is a reply and
// not a blank -- the publish path does anyway, on their own first doc.
const SEED_COMMENT_TEXT = 'First reader here. Which claim on this page would you defend least? Highlight it and say so.';
// Filled light square (white field) — not the stroke-only mark. Avatars need a
// solid tile; /tdoc_logo.svg is for chrome that follows currentColor/invert.
const SEED_COMMENT_AUTHOR = { login: 'tdoc', name: 'tdoc', avatar_url: '/tdoc_logo.png', kind: 'system' };
function seedCommentAnchor(html) {
  const m = String(html || '').match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  if (!m) return null;
  // Tags go first, repeated until none are left (a tag split by another tag
  // must not survive one pass), and `&amp;` is decoded last so a literal
  // `&amp;lt;` becomes `&lt;` and not `<`. The result is anchor text, never
  // markup, but the order is what makes that true.
  let text = m[1];
  for (let previous = null; previous !== text;) { previous = text; text = text.replace(/<[^>]*>/g, ''); }
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 8) return null;
  return { kind: 'text', text: text.slice(0, 200), context_before: '', context_after: '' };
}

async function sessionAccountId(env, session) {
  if (!session) return null;
  if (typeof session.account_id === 'string' && session.account_id) return session.account_id;
  const login = sessionLogin(session);
  const rec = login ? await lookupHostedAccount(env, login) : null;
  if (rec && rec.account_id) return rec.account_id;
  // The email registry, which is where an account born through the provider
  // door actually lives. `hostedAccountForEmail` writes `account-email:<addr>`
  // and `lookupHostedAccount` reads `hosted-account:` / `hosted-github:` --
  // two different keys, so an account could be minted and then not be found
  // by the very next request. Everything keyed on the account id (the
  // onboarding record most of all) silently belonged to nobody until the
  // first publish happened to write the other index.
  const email = normalizeEmail(session && session.email);
  if (!email || !env || !env.META) return null;
  try {
    const byEmail = JSON.parse(await env.META.get(`account-email:${email}`));
    if (byEmail && typeof byEmail.account_id === 'string' && byEmail.account_id) return byEmail.account_id;
  } catch {}
  return null;
}
async function loadOnboarding(env, accountId) {
  try {
    const rec = JSON.parse(await env.META.get(`account-onboarding:${accountId}`));
    return rec && typeof rec === 'object' ? rec : {};
  } catch { return {}; }
}
async function stampOnboardingFor(env, accountId, step, extra) {
  if (!env || !env.META || !accountId) return null;
  const at = new Date().toISOString();
  const next = stampOnboarding(await loadOnboarding(env, accountId), step, at, extra);
  await env.META.put(`account-onboarding:${accountId}`, JSON.stringify(next));
  return next;
}
// Is this doc the one FIRST-DOC.md produced? tdoc-write --first-doc marks the
// meta (`origin: "first-doc"`); an agent on an older skill still carries the
// pasted line as the prompt of record, and that line names the recipe.
function isFirstDocProduct(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (meta.origin === 'first-doc') return true;
  const prompts = Array.isArray(meta.versions) ? meta.versions.map((v) => v && v.prompt) : [];
  return prompts.some((p) => typeof p === 'string' && (/FIRST-DOC\.md/i.test(p) || /make my first doc/i.test(p)));
}
// The journey follows the doc FIRST-DOC.md produced, whichever slug it landed
// on. Re-pointing starts the doc's own steps over — the comment, the fix, the
// revision belong to the doc being watched, not to the one it replaced.
async function adoptFirstDocFor(env, accountId, slug) {
  if (!env || !env.META || !accountId) return null;
  const record = await loadOnboarding(env, accountId);
  const next = { ...record, first_doc: slug, published_first: new Date().toISOString() };
  for (const key of ['commented', 'revised', 'seeded_comment', 'comments_read']) delete next[key];
  await env.META.put(`account-onboarding:${accountId}`, JSON.stringify(next));
  return next;
}
// Every action the page saw, one row each. The funnel and each step's
// drop-off are derived from these; nothing else counts anything.
async function logOnboardingEvent(env, accountId, action, meta) {
  if (!env || !env.META) return;
  const at = new Date().toISOString();
  await env.META.put(
    `onboarding-event:${accountId || 'anon'}:${at}:${rand(4)}`,
    JSON.stringify({ account_id: accountId || null, action, at, ...(meta || {}) }),
    { expirationTtl: 60 * 60 * 24 * 90 },
  );
}
// Bridge 2 reads this: the owner's agent pulling the comments is the first
// thing it does after the person pastes the line, and the card is waiting to
// hear exactly that.
async function markAgentRead(env, slug) {
  if (!env || !env.META || !slug) return;
  await env.META.put(`doc-agent-read:${slug}`, JSON.stringify({ at: new Date().toISOString() }));
}
async function readAgentStatus(env, slug) {
  let rec = null;
  try { rec = JSON.parse(await env.META.get(`doc-agent-read:${slug}`)); } catch {}
  return { read_at: (rec && rec.at) || null };
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
  const reqUrl = new URL(req.url);
  const pageUrl = isLanding && (reqUrl.pathname === '/' || reqUrl.pathname === '')
    ? `${reqUrl.origin}/`
    : `${reqUrl.origin}/d/${encodeURIComponent(slug)}/v/${version}`;
  return {
    ok: true,
    // session rides along so the /d/ route can record the visit (recents)
    // without a second session lookup.
    session,
    response: html(render(raw, slug, version, identity, versions, isOwner, ownerManage, nonce, isLanding, canSeeMyDocs(env, session, requestOrigin(req)), false, !!env.GITHUB_CLIENT_SECRET, stars, viewerStar, !!env.COMMENTS, canCommentOnDoc(gate.access, session, env, gate.meta), gate.meta, { enabled: !!oidcConfig(env), label: (oidcConfig(env) || {}).label || '', debug: await isDebugAccount(env, session) }, pageUrl), {
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
    me: 'This self-hosted tdoc only shows My docs to the worker operator. On https://tdoc.dev every signed-in account gets their own My docs — open that host and sign in again.',
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

// Sign-in providers that speak plain OIDC: discovery, code exchange,
// userinfo. Adding one is an entry here — the login/callback routes, state
// handling and token exchange are shared. `id` is the route segment
// (/api/auth/<id>/login, /auth/<id>/callback) and the account-idp namespace;
// `complete` turns a userinfo response into a session. GitHub is not here:
// it predates this and keeps its own first-party flow.
const OIDC_PROVIDERS = {
  // The generic human seat (Clerk in production): email-verified sign-in.
  oidc: {
    config: (env) => ({
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      label: env.OIDC_LABEL || 'Email',
    }),
    scope: 'openid email profile',
    statelessAgents: false,
    complete: completeEmailSignIn,
  },
  // Login with Raft. Agents sign in with no state (userinfo type "agent");
  // humans go through the normal state-checked browser flow. Dormant until
  // the Raft app is registered and RAFT_CLIENT_ID/SECRET are set.
  raft: {
    config: (env) => ({
      issuer: env.RAFT_OIDC_ISSUER || 'https://api.raft.build',
      clientId: env.RAFT_CLIENT_ID,
      clientSecret: env.RAFT_CLIENT_SECRET,
      label: 'Raft',
    }),
    scope: 'openid profile',
    statelessAgents: true,
    complete: completeRaftSignIn,
  },
};
const OIDC_PROVIDER_IDS = Object.keys(OIDC_PROVIDERS).join('|');
const OIDC_LOGIN_ROUTE = new RegExp(`^/api/auth/(${OIDC_PROVIDER_IDS})/login$`);
const OIDC_CALLBACK_ROUTE = new RegExp(`^/auth/(${OIDC_PROVIDER_IDS})/callback$`);

// A configured provider, or null when unknown or missing any of issuer
// (https only), client id or client secret — an unconfigured provider's
// routes bow out and no button is advertised.
function oidcProvider(env, id) {
  const def = Object.prototype.hasOwnProperty.call(OIDC_PROVIDERS, id) ? OIDC_PROVIDERS[id] : null;
  if (!def) return null;
  const raw = def.config(env || {});
  const issuer = String(raw.issuer || '').trim().replace(/\/$/, '');
  const clientId = String(raw.clientId || '').trim();
  const clientSecret = String(raw.clientSecret || '').trim();
  if (!/^https:\/\//.test(issuer) || !clientId || !clientSecret) return null;
  return {
    id, issuer, clientId, clientSecret,
    label: String(raw.label || '').trim() || 'Email',
    scope: def.scope,
    statelessAgents: def.statelessAgents,
    complete: def.complete,
    callbackPath: `/auth/${id}/callback`,
    // The generic seat keeps its original cookie name so in-flight sign-ins
    // survive the deploy that introduced the registry.
    stateCookie: id === 'oidc' ? 'tdoc_oidcst' : `tdoc_${id}st`,
  };
}

// The human "Sign in" button — the generic seat.
function oidcConfig(env) {
  return oidcProvider(env, 'oidc');
}

// Per-isolate discovery cache, per issuer. Discovery is static config on the
// issuer's side; refetching it per sign-in would add a round trip for nothing.
const OIDC_DISCOVERY = new Map();
async function oidcDiscovery(cfg) {
  const cached = OIDC_DISCOVERY.get(cfg.issuer);
  if (cached) return cached;
  const r = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'tdoc-worker' },
  });
  if (!r.ok) throw new Error(`oidc discovery ${r.status}`);
  const doc = await r.json();
  if (!doc || !doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
    throw new Error('oidc discovery incomplete');
  }
  OIDC_DISCOVERY.set(cfg.issuer, doc);
  return doc;
}

// The generic seat's sign-in: a verified email resolves (never mints) an
// account and becomes a session.
async function completeEmailSignIn(env, { user, ret, clearState }) {
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
  // The provider is asked about a connected GitHub identity at most
  // once per sign-in, whichever of the consumers below needs it first.
  let ghProbe;
  const probeGithub = async () => {
    if (ghProbe === undefined) ghProbe = sub ? await clerkExternalGithub(env, sub) : null;
    return ghProbe;
  };
  let bridged = null;
  if (!account_id && sub) {
    bridged = await probeGithub();
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
  // The session's GitHub handle, from the strongest source available.
  // This is identity for WORDS, not for documents — comments, @mention
  // routing and handle invites key on it, while account resolution
  // above never rests on it (numeric ids only). It must survive the
  // provider door for commenters exactly as it does for publishers: a
  // commenter is not a publisher, but their words are still theirs,
  // and the first-party GitHub flow always carried the handle.
  let ghHandle = (bridged && bridged.handle)
    || (account_id && idpRec && normalizeGithubLogin(idpRec.handle))
    || null;
  if (!ghHandle && sub) {
    const gh = await probeGithub();
    if (gh && gh.handle) {
      if (!account_id) {
        // No account in play: the provider attested which GitHub
        // account this person connected, and that is exactly the trust
        // the old first-party flow extended to GitHub's /user.
        ghHandle = gh.handle;
      } else {
        // An account resolved by email or by a link that predates the
        // bridge (or was written by a mint) carries no handle. Restore
        // only what this account already owns: the handle must resolve
        // to THIS account, and if the account records a stable GitHub
        // owner it must be the id the provider just attested — a
        // recycled name pointing anywhere else stays where it is.
        const named = await lookupHostedAccount(env, gh.handle);
        const ghOwner = named && (named.identities || []).find((i) => i && i.provider === 'github');
        if (named && named.account_id === account_id
            && (!ghOwner || !gh.ghId || String(ghOwner.sub) === String(gh.ghId))) {
          ghHandle = gh.handle;
          // Written back so the heal is permanent — but only onto a
          // link that already exists. An email-resolved sign-in stays
          // resolve-don't-mint: its durable link is written at mint,
          // not smuggled in here.
          if (idpRec) {
            idpRec.handle = gh.handle;
            await env.META.put(idpKey('oidc', sub), JSON.stringify(idpRec));
          }
        }
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
    // The verified handle becomes the session login, so the actor key
    // stays handle-shaped: old comments stay editable, handle invites
    // keep matching, @handle still reaches them. Truthful — the
    // provider attested which GitHub account this person connected.
    ...(ghHandle ? { login: ghHandle } : {}),
  };
  await env.META.put(`session:${sid}`, JSON.stringify(session), { expirationTtl: 60 * 60 * 24 * 30 });
  return redirectTo(ret, [
    `tdoc_sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
    clearState,
  ]);
}

// Login with Raft.
//
// A Raft sign-in answers "WHICH AGENT is this", and nothing else. It is not an
// authority to write: that stays the upload token, exactly as it is for a
// person publishing from their laptop. Keeping the two apart is what makes the
// linking step below safe to expose — binding an agent to an account needs
// BOTH credentials, so a Raft identity alone can never reach somebody's docs
// and an upload token alone can never invent an agent that did not sign in.
//
// INVARIANT: the stateless path must never mint a browser session. Skipping
// the state check is only defensible because there is no browser in this flow
// to be logged in; hand it a session cookie and the skipped check becomes a
// login-CSRF hole, where a victim's browser is walked onto somebody else's
// identity. An agent gets a one-time link code, never a cookie.
const RAFT_LINK_TTL = 600;
const AGENT_SESSION_TTL = 60 * 60 * 24 * 30;

async function completeRaftSignIn(env, { user, tok, stateless }) {
  const sub = user && user.sub ? String(user.sub) : '';
  if (!sub) {
    return authStatusResponse('This sign-in carried no stable identifier, so it cannot be used here.', { error: true, status: 403 });
  }
  // A human signing in with Raft is a P1 seat. Refusing is the honest answer;
  // falling through would hand a person an agent session.
  if (!stateless || !(user && user.type === 'agent')) {
    return authStatusResponse('Signing in to tdoc with a Raft account is not available yet.', { error: true, status: 501 });
  }
  // The server the agent belongs to comes from the ISSUER, never from the
  // agent: the token is bound to one server, so asking the issuer is the only
  // reading a caller cannot shape. Without it an agent could name a server it
  // has no standing in and be delivered notifications meant for that server.
  const server = await raftServerInfo(env, tok && tok.access_token);
  if (!server || !server.id) {
    return authStatusResponse('Raft did not say which server this identity belongs to, so the sign-in cannot be completed.', { error: true, status: 502 });
  }
  const identity = {
    provider: 'raft',
    server_id: String(server.id),
    ...(server.slug ? { server_slug: String(server.slug) } : {}),
    agent_sub: sub,
    // `preferred_username` is the handle (smarter-tdoc-claw); `name` is a
    // display field that for an agent is often its whole multi-line bio.
    // Whatever lands here gets rendered as "who this is", so prefer the one
    // that reads like a name and never let a bio through as an identity.
    agent_name: agentDisplayName(user),
    at: new Date().toISOString(),
  };
  const asid = rand(24);
  await env.META.put(`agent-session:${asid}`, JSON.stringify(identity), { expirationTtl: AGENT_SESSION_TTL });
  // A one-time code as well, so a caller that cannot hold cookies still has a
  // way through. Same identity, same two-credential rule at redemption.
  const code = rand(16);
  await env.META.put(`raft-link:${code}`, JSON.stringify(identity), { expirationTtl: RAFT_LINK_TTL });
  return json({
    ok: true,
    link_code: code,
    expires_in: RAFT_LINK_TTL,
    agent: { server_id: identity.server_id, server_slug: identity.server_slug || null, agent_sub: sub, agent_name: identity.agent_name },
  }, {
    // SECURITY — read this before changing the cookie.
    //
    // Agent sign-in skips the OIDC state check because there is no browser in
    // the flow to protect, and an earlier version therefore refused to set any
    // cookie at all. That was the wrong conclusion drawn from the right worry,
    // and it broke Login with Raft outright: the protocol IS a service session
    // the caller keeps.
    //
    // What makes a stateless-issued cookie safe is not its absence but its
    // emptiness. THIS SESSION CARRIES NO AUTHORITY. It names an agent and
    // nothing else: it is stored under its own key, read by its own helper,
    // and no route treats it as a tdoc account. A browser tricked into holding
    // one has gained an answer to "which agent", which is not a secret and not
    // a capability. Acting on an account still needs the upload token, so the
    // two credentials stay orthogonal exactly as designed.
    //
    // The invariant to keep: never let this cookie widen into account access,
    // and never merge it into `tdoc_sid`. If a future change needs an agent to
    // act on an account, that change needs the token too — not a bigger cookie.
    headers: {
      'Set-Cookie': `tdoc_agent_sid=${asid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${AGENT_SESSION_TTL}`,
    },
  });
}

// Resolve the agent behind a request, if any. Deliberately separate from
// getSession: an agent session is not a tdoc account and must never be
// mistaken for one by a caller reaching for "who is this".
async function getAgentSession(env, req) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)tdoc_agent_sid=([a-f0-9]+)/);
  if (!m) return null;
  try {
    const raw = await env.META.get(`agent-session:${m[1]}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}


// The label a person should see for an agent. Order matters: a handle reads as
// an identity, a display name may be a bio, and the sub is a uuid that reads as
// a session id — which is exactly how it was mistaken for one.
function agentDisplayName(user) {
  const handle = typeof user?.preferred_username === 'string' ? user.preferred_username.trim() : '';
  if (handle) return handle.slice(0, 80);
  const name = typeof user?.name === 'string' ? user.name.trim() : '';
  // A bio masquerading as a name: take its first line, and only if it is short
  // enough to be a name at all.
  const firstLine = name.split('\n')[0].trim();
  if (firstLine && firstLine.length <= 60) return firstLine;
  return '';
}

async function raftServerInfo(env, accessToken) {
  if (!accessToken) return null;
  const base = env.RAFT_API_BASE || 'https://api.raft.build';
  try {
    const r = await fetch(`${base}/api/oauth/serverinfo`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'tdoc-worker' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function authStatusResponse(message, { error = false, status = 200 } = {}) {
  return statusPageResponse({
    docTitle: error ? 'tdoc - sign-in failed' : 'tdoc - signed in',
    title: error ? 'Sign-in failed' : "You're signed in",
    message,
    error,
    status,
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

// Folder link sharing (catalog only). Docs keep their own access; the share
// page lists whichever of the folder's docs the viewer (cookie or Bearer) may
// already read. unlisted/public = anyone with the link; private = owner +
// allowlisted invitees (same shape as doc access).
function folderVisibility(folder) {
  const v = folder && folder.visibility;
  return ACCESS_VISIBILITIES.has(v) ? v : 'private';
}

function folderAllowedUsers(folder) {
  const src = folder && Array.isArray(folder.allowed_users) ? folder.allowed_users : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const login = normalizeInvitee(item);
    if (!login || seen.has(login)) continue;
    seen.add(login);
    out.push(login);
  }
  return out;
}

function publicFolder(folder) {
  const visibility = folderVisibility(folder);
  const out = {
    id: folder.id,
    name: folder.name,
    parent: folder.parent || '',
    visibility,
    allowed_users: folderAllowedUsers(folder),
  };
  if (folder.share_id) out.share_id = folder.share_id;
  return out;
}

function canAccessSharedFolder(folder, session, ownerKey) {
  const visibility = folderVisibility(folder);
  if (visibility === 'unlisted' || visibility === 'public') return true;
  const me = actorKey(session);
  if (me && normalizeActorKey(ownerKey) && me === normalizeActorKey(ownerKey)) return true;
  const allowed = folderAllowedUsers(folder);
  const login = sessionLogin(session);
  if (login && allowed.includes(login)) return true;
  const email = normalizeEmail(session && session.email);
  return !!(email && allowed.includes(email));
}

async function loadFolderShareIndex(env, shareId) {
  if (!shareId || typeof shareId !== 'string') return null;
  try {
    const raw = await env.META.get(`folder-share:${shareId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.owner_key !== 'string' || typeof parsed.folder_id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function putFolderShareIndex(env, shareId, ownerKey, folderId) {
  await env.META.put(`folder-share:${shareId}`, JSON.stringify({
    owner_key: ownerKey,
    folder_id: folderId,
  }));
}

async function deleteFolderShareIndex(env, shareId) {
  if (!shareId) return;
  try { await env.META.delete(`folder-share:${shareId}`); } catch {}
}

async function ensureFolderShareId(env, ownerKey, folder) {
  if (folder.share_id) return folder.share_id;
  const shareId = `s_${rand(16)}`;
  folder.share_id = shareId;
  await putFolderShareIndex(env, shareId, ownerKey, folder.id);
  return shareId;
}

async function buildFolderShareListing(env, req, shareId) {
  const index = await loadFolderShareIndex(env, shareId);
  if (!index) return { ok: false, status: 404 };
  const state = await loadFolderState(env, index.owner_key);
  const folder = state.folders.find((f) => f.id === index.folder_id);
  if (!folder || folder.share_id !== shareId) return { ok: false, status: 404 };
  const session = await getViewerSession(env, req);
  if (!canAccessSharedFolder(folder, session, index.owner_key)) {
    if (!sessionPrincipal(session)) {
      return { ok: false, status: 401 };
    }
    return { ok: false, status: 404 };
  }
  const visibility = folderVisibility(folder);
  const slugs = Object.entries(state.docs)
    .filter(([, fid]) => fid === folder.id)
    .map(([slug]) => slug);
  const docs = [];
  for (const slug of slugs) {
    const meta = await loadDocMeta(env, slug);
    if (!meta || !docReadableBy(env, session, meta)) continue;
    const versions = Array.isArray(meta.versions) ? meta.versions : [];
    const latest = versions[versions.length - 1]?.n || 1;
    docs.push({
      slug,
      title: meta.title || slug,
      latest,
      updated: versions[versions.length - 1]?.created || meta.created || '',
      url: `/d/${encodeURIComponent(slug)}/v/${latest}`,
    });
  }
  docs.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return {
    ok: true,
    folder: { name: folder.name, visibility, share_id: shareId },
    docs,
  };
}

function folderSharePageResponse(env, listing) {
  const nonce = rand(16);
  return html(SHELL.appHtml({
    title: listing.folder.name,
    nonceAttr: ` nonce="${nonce}"`,
    runtimeJsPath: SHELL_RUNTIME_JS_PATH,
    runtimeCssPath: SHELL_RUNTIME_CSS_PATH,
    bootJson: safeJsonForScript({
      page: 'folder-share',
      folder: listing.folder,
      docs: listing.docs,
    }),
  }), { headers: { 'Content-Security-Policy': cspHeader(nonce) } });
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
    folders: folderState.folders.map((folder) => publicFolder(folder)),
  };
}

// Public profile for /@handle: only docs the owner curated (pinned). Curate
// forces visibility=public; take-down restores the prior visibility. includePrivate
// is a legacy safety net for pins that predate that rule.
async function profileData(env, account, { includePrivate = false } = {}) {
  const accountId = account && typeof account.account_id === 'string' ? account.account_id : '';
  const login = normalizeGithubLogin(account && account.github_login);
  if (!accountId && !login) return [];

  const pins = accountId
    ? normalizeProfilePins(await accountProfile(env, accountId))
    : [];
  if (!pins.length) return [];

  const docs = [];
  for (const slug of pins) {
    let meta = null;
    try { meta = JSON.parse(await env.META.get(`meta:${slug}`) || 'null'); } catch { continue; }
    if (!meta || typeof meta !== 'object') continue;
    const hosted = meta.hosted;
    const owns = (accountId && hosted && hosted.account_id === accountId)
      || (login && hostedGithubLogin(meta) === login);
    // Owner boot (includePrivate): pin membership is enough — account_id on
    // older meta can drift from the claim/mint account and used to empty the
    // page after refresh.
    if (!owns && !includePrivate) continue;
    const visibility = accessFromMeta(meta).visibility;
    if (!includePrivate && visibility !== 'public' && visibility !== 'unlisted') continue;
    const versions = Array.isArray(meta.versions) ? meta.versions : [];
    const latest = versions[versions.length - 1]?.n || 1;
    const published = versions[0]?.created || meta.created || '';
    const updated = versions[versions.length - 1]?.created || published;
    // Prefer cached meta.preview. Backfill when excerpt/image missing, or when
    // image is a tiny SVG data URL (checkbox icon mistakenly cached earlier).
    let cached = meta.preview && typeof meta.preview === 'object' ? meta.preview : null;
    let excerpt = cached && typeof cached.excerpt === 'string' ? cached.excerpt : '';
    let image = cached && typeof cached.image === 'string' ? cached.image : '';
    const weakSvg = typeof image === 'string'
      && image.startsWith('data:image/svg')
      && image.length < 2000;
    if (!excerpt || !image || weakSvg) {
      const refreshed = await refreshDocPreview(env, slug, meta);
      if (refreshed && refreshed.preview && typeof refreshed.preview === 'object') {
        const next = refreshed.preview;
        const nextExcerpt = typeof next.excerpt === 'string' ? next.excerpt : '';
        const nextImage = typeof next.image === 'string' ? next.image : '';
        const nextExcerptUse = excerpt || nextExcerpt;
        const nextImageUse = (weakSvg || !image) ? (nextImage || image) : image;
        const changed = nextExcerptUse !== excerpt || nextImageUse !== image;
        excerpt = nextExcerptUse;
        image = nextImageUse;
        if (changed) {
          try {
            await env.META.put(`meta:${slug}`, JSON.stringify({
              ...refreshed,
              preview: { excerpt, image },
            }));
          } catch { /* best-effort */ }
        }
      }
    }
    docs.push({
      slug,
      title: meta.title || slug,
      latest,
      published,
      updated,
      excerpt,
      image,
      visibility,
      url: `/d/${encodeURIComponent(slug)}/v/${latest}`,
    });
  }
  return docs;
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
        // WHO closed this, for both kinds of actor. `resolved_by` stays
        // human-only because callers already read it that way; this is the
        // answer to "a human and an agent may both resolve, so record which".
        // Everything here comes off the same event — no new write path, no
        // migration.
        // WHO closed this, for both kinds of actor — `resolved_by` stays
        // human-only because callers already read it that way. Inlined rather
        // than factored out: the fold is extracted and evaluated in isolation
        // by several tests, so a helper defined elsewhere in the file is not
        // in scope for them.
        snap.resolution = {
          state: 'resolved',
          by: e.by || (e.human ? '' : 'tdoc-agent'),
          kind: e.human ? 'human' : 'agent',
          at: e.at || '',
          at_version: e.at_version || null,
        };
        break;
      case 'marked_open':
        snap.status = 'open';
        snap.applied_in = undefined;
        snap.resolved_by = '';
        snap._agentVerdict = e.human ? null : (e.agent_status || null);
        snap._agentActor = e.by || 'tdoc-agent';
        snap.resolution = {
          state: 'reopened',
          by: e.by || (e.human ? '' : 'tdoc-agent'),
          kind: e.human ? 'human' : 'agent',
          at: e.at || '',
          at_version: e.at_version || null,
        };
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
  if (!snap.resolution) snap.resolution = { state: 'none', by: '', kind: null, at: '', at_version: null };
  snap.replies = keepThread(replyOrder, replyById).map(r => (hasNoWords(r) ? asTombstone(r) : r));
  return snap;
}


// A record with no words. Deleting takes the words away; a caller that posted
// only whitespace never supplied any. Both leave the same thing behind — a slot
// with a name on it and nothing to read — so the fold treats them alike rather
// than keeping a second rule beside this one.
//
// The shell cannot produce one (it trims, and blocks an empty submit), but the
// API used to accept "\n" as text, and those replies rendered as a row zero
// pixels tall: it counted toward the thread and the pin badge, yet had no hit
// area, so there was no menu and no way to delete it (#532).
function hasNoWords(record) {
  return !!record && (record.deleted || !String(record.text || '').trim());
}

// Which replies survive the fold. An alive reply always does. A DELETED one
// does too when something that survives still hangs off it — otherwise the
// answers to it would vanish with it, and a conversation would lose its middle.
// Resolved to a fixpoint, so a deleted reply whose only child was itself
// deleted-and-dropped goes as well.
function keepThread(order, byId) {
  const keep = new Set(order.filter(id => byId.get(id) && !hasNoWords(byId.get(id))));
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
    if (hasNoWords(s) && !s.replies.length) continue;
    out.push(hasNoWords(s) ? asTombstone(s) : s);
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
// Unset: hosted product hostname (tdoc.dev) OR a tdoc-cd bundle (the Worker
// we operate — every hostname it serves, including the workers_dev preview).
// BYOK (tdoc-publish) stays single-owner unless they set the var themselves.
function hostedRegistrationEnabled(env, origin) {
  const v = String((env && (env.TDOC_HOSTED_REGISTRATION || env.TDOC_HOSTED_SIGNUP)) || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  if (runtimeInfo().generated_by === 'tdoc-cd') return true;
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

// Self-serve bump: first ask raises to 100; a later ask can raise to 200.
// Above 200 needs a human. Every ask stores a reason, even when already capped.
const QUOTA_BUMP_FLOOR = 100;
const QUOTA_BUMP_CAP = 200;
const QUOTA_REASON_MAX = 500;

async function loadAccountQuota(env, accountId) {
  if (!env || !env.META || !accountId) return null;
  try {
    const raw = await env.META.get(`account-quota:${accountId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Env default, or this account's recorded override — whichever is higher.
async function hostedMaxDocsFor(env, accountId) {
  const base = hostedMaxDocs(env);
  const rec = await loadAccountQuota(env, accountId);
  const custom = Number(rec && rec.max_docs) || 0;
  return Math.max(base, custom > 0 ? Math.floor(custom) : 0);
}

function nextQuotaBumpTarget(from) {
  const n = Number(from) || 0;
  if (n < QUOTA_BUMP_FLOOR) return QUOTA_BUMP_FLOOR;
  if (n < QUOTA_BUMP_CAP) return QUOTA_BUMP_CAP;
  return n;
}

async function requestQuotaBump(env, { accountId, reason, by }) {
  if (!env || !env.META || !accountId) {
    return { ok: false, status: 503, error: 'quota_store_unavailable' };
  }
  const trimmed = String(reason || '').trim();
  if (!trimmed) return { ok: false, status: 400, error: 'reason_required' };
  if (trimmed.length > QUOTA_REASON_MAX) return { ok: false, status: 400, error: 'reason_too_long' };
  const from = await hostedMaxDocsFor(env, accountId);
  const to = nextQuotaBumpTarget(from);
  const at = new Date().toISOString();
  const already = to <= from;
  if (!already) {
    await env.META.put(`account-quota:${accountId}`, JSON.stringify({
      max_docs: to,
      updated_at: at,
      last_reason: trimmed,
      last_by: by || null,
    }));
  }
  // Always record the ask — even when already at the self-serve cap — so a
  // later "I still need more" leaves a trail a human can read.
  await env.META.put(
    `account-quota-bump:${accountId}:${at}:${rand(4)}`,
    JSON.stringify({
      account_id: accountId,
      at,
      reason: trimmed,
      by: by || null,
      from,
      to: already ? from : to,
      applied: !already,
    }),
    { expirationTtl: 60 * 60 * 24 * 365 },
  );
  return {
    ok: true,
    from,
    to: already ? from : to,
    reason: trimmed,
    already,
    floor: QUOTA_BUMP_FLOOR,
    cap: QUOTA_BUMP_CAP,
  };
}

function quotaDocsPayload(env, limit, used) {
  return {
    error: 'quota_docs',
    limit,
    used,
    // Agents (and the UI) learn the escape hatch from the error itself — no
    // skill edit required. POST with a non-empty reason; self-serve stops at 200.
    bump: {
      endpoint: '/api/quota/bump',
      method: 'POST',
      body: { reason: 'string (required) — why you need more hosted docs' },
      floor: QUOTA_BUMP_FLOOR,
      cap: QUOTA_BUMP_CAP,
    },
  };
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

// The newest doc this account owns. Two callers: the internal state switcher,
// and the second ask on `/setup?step=doc`. That page cannot read the record
// for its answer -- `published_first` and `first_doc` are stamped once, so a
// SECOND doc moves nothing on the record at all -- and "did a new doc appear
// while you were watching" is exactly what it is waiting for.
async function newestDocFor(env, accountId) {
  if (!accountId || !env || !env.META) return null;
  let best = null;
  let cursor;
  do {
    const r = await env.META.list({ prefix: 'meta:', cursor });
    for (const k of r.keys || []) {
      let meta = null;
      try {
        const raw = await env.META.get(k.name);
        if (raw) meta = JSON.parse(raw);
      } catch {}
      if (!meta || !meta.hosted || meta.hosted.account_id !== accountId) continue;
      // The newest version's stamp, not `meta.created` -- nothing writes that.
      // Ranking on a field that is always '' made this "whichever KV listed
      // first", so the debug states rebuilt the journey on a doc that could be
      // months older than the one the tester had just published.
      const versions = Array.isArray(meta.versions) ? meta.versions : [];
      const created = (versions.length ? versions[versions.length - 1].created : meta.created) || '';
      if (!best || created > best.created) best = { slug: k.name.slice('meta:'.length), created };
    }
    cursor = r.cursor;
    if (r.list_complete) break;
  } while (cursor);
  return best ? best.slug : null;
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

// Public @handles people claim on /me. Same shape as a GitHub login so
// /@alice stays one parser. Reserved names are first-path segments we already
// serve (and a few doc/route prefixes) so a claim cannot shadow them.
const RESERVED_HANDLES = new Set([
  'me', 'api', 'auth', 'activate', 'setup', 'start', 'templates', 'email',
  'favicon', 'assets', 'static', 'mac', 'd', 'f', 'publish', 'feedback',
  'admin', 'www', 'cdn', 'null', 'undefined', 'tdoc',
]);

function suggestHandleFromEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const local = norm.split('@')[0] || '';
  // Drop plus-tags and dots that would fail the github-login regex.
  const cleaned = local.replace(/\+.*$/, '').replace(/[^a-z0-9-]/g, '');
  return normalizeGithubLogin(cleaned);
}

async function accountProfile(env, accountId) {
  if (!accountId || !env || !env.META) return null;
  try {
    const rec = JSON.parse(await env.META.get(`account-profile:${accountId}`));
    if (rec && typeof rec === 'object') return rec;
  } catch {}
  return null;
}

const PROFILE_PINS_MAX = 50;

function normalizeProfilePins(rec) {
  const raw = rec && Array.isArray(rec.pins) ? rec.pins : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const slug = typeof item === 'string' ? item : (item && item.slug);
    if (typeof slug !== 'string' || !slug || seen.has(slug)) continue;
    if (!isValidSlug(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= PROFILE_PINS_MAX) break;
  }
  return out;
}

async function putAccountProfile(env, accountId, patch) {
  const prev = (await accountProfile(env, accountId)) || {};
  const next = { ...prev, ...patch, account_id: accountId };
  if (patch.pins === undefined && prev.pins) next.pins = normalizeProfilePins(prev);
  else if (patch.pins !== undefined) next.pins = normalizeProfilePins({ pins: patch.pins });
  await env.META.put(`account-profile:${accountId}`, JSON.stringify(next));
  return next;
}

function docPreviewFromHtml(html, { slug, version, title } = {}) {
  if (!SHELL || typeof SHELL.previewFromHtml !== 'function') {
    return { excerpt: '', image: '' };
  }
  return SHELL.previewFromHtml(html, { slug, version, title, maxLen: 220, skipHeading: true });
}

async function refreshDocPreview(env, slug, meta) {
  if (!meta || typeof meta !== 'object' || !env || !env.DOCS) return meta;
  const versions = Array.isArray(meta.versions) ? meta.versions : [];
  const latest = versions[versions.length - 1]?.n || 1;
  try {
    const obj = await env.DOCS.get(`docs/${slug}/v${latest}/index.html`);
    if (!obj) return meta;
    const preview = docPreviewFromHtml(await obj.text(), {
      slug,
      version: latest,
      title: meta.title || slug,
    });
    return { ...meta, preview };
  } catch {
    return meta;
  }
}

// Curate = author-only doc flag (meta.profile.curated). Pinning sets the doc
// public and remembers the prior visibility; take-down restores it.
async function setProfilePin(env, accountId, slug, pinned, { session, meta } = {}) {
  if (!accountId || !isValidSlug(slug)) return { error: 'invalid_slug', status: 400 };
  if (!meta) {
    try { meta = JSON.parse(await env.META.get(`meta:${slug}`) || 'null'); } catch { meta = null; }
  }
  if (!meta) return { error: 'not_found', status: 404 };
  // Author only — collaborators / folder guests cannot curate someone else's doc.
  if (!isDocOwnerSession(env, session, meta)) return { error: 'forbidden', status: 403 };

  const access = accessFromMeta(meta);
  let nextMeta = { ...meta };
  const hosted = nextMeta.hosted && typeof nextMeta.hosted === 'object' ? nextMeta.hosted : {};
  if (hosted.account_id !== accountId) {
    nextMeta.hosted = {
      ...hosted,
      account_id: accountId,
      ...(sessionLogin(session) ? { github_login: sessionLogin(session) } : {}),
    };
  }

  if (pinned) {
    const prior = (nextMeta.profile && nextMeta.profile.restore_visibility)
      || access.visibility;
    nextMeta.profile = {
      curated: true,
      restore_visibility: ACCESS_VISIBILITIES.has(prior) ? prior : 'unlisted',
    };
    nextMeta.access = { ...access, visibility: 'public' };
    // Refresh preview on every curate so old double-title caches get fixed
    // and first-graphic stays in sync with the latest published HTML.
    nextMeta = await refreshDocPreview(env, slug, nextMeta);
  } else {
    const restore = (nextMeta.profile && nextMeta.profile.restore_visibility) || access.visibility;
    const { profile: _drop, ...withoutProfile } = nextMeta;
    nextMeta = withoutProfile;
    nextMeta.access = {
      ...access,
      visibility: ACCESS_VISIBILITIES.has(restore) ? restore : access.visibility,
    };
  }
  await env.META.put(`meta:${slug}`, JSON.stringify(nextMeta));

  const prev = await accountProfile(env, accountId);
  let pins = normalizeProfilePins(prev);
  if (pinned) {
    if (!pins.includes(slug)) pins = [slug, ...pins].slice(0, PROFILE_PINS_MAX);
  } else {
    pins = pins.filter((s) => s !== slug);
  }
  await putAccountProfile(env, accountId, { pins });
  return {
    ok: true,
    pins,
    on_profile: pins.includes(slug),
    visibility: accessFromMeta(nextMeta).visibility,
  };
}

async function accountClaimedHandle(env, accountId) {
  const rec = await accountProfile(env, accountId);
  return normalizeGithubLogin(rec && rec.handle);
}

// Resolve /@x: claimed handle first, then the GitHub-login index (MVP #569
// back-compat). Never mints.
async function lookupProfileAccount(env, raw) {
  const handle = normalizeGithubLogin(raw);
  if (!handle || !env || !env.META) return null;
  try {
    const idx = JSON.parse(await env.META.get(`hosted-handle:${handle}`));
    if (idx && typeof idx.account_id === 'string' && idx.account_id) {
      return {
        account_id: idx.account_id,
        handle,
        github_login: normalizeGithubLogin(idx.github_login) || null,
      };
    }
  } catch {}
  const acct = await lookupHostedAccount(env, handle);
  if (!acct) return null;
  const claimed = await accountClaimedHandle(env, acct.account_id);
  return {
    ...acct,
    handle: claimed || normalizeGithubLogin(acct.github_login) || handle,
    github_login: normalizeGithubLogin(acct.github_login) || null,
  };
}

// Claim or change a public handle. Changing releases the previous
// hosted-handle index so the old @url frees up.
async function claimAccountHandle(env, accountId, rawHandle, { github_login } = {}) {
  if (!accountId || !env || !env.META) return { error: 'sign_in_required', status: 401 };
  const handle = normalizeGithubLogin(rawHandle);
  if (!handle) return { error: 'invalid_handle', status: 400 };
  if (RESERVED_HANDLES.has(handle)) return { error: 'reserved_handle', status: 400 };

  const existing = await accountClaimedHandle(env, accountId);
  if (existing === handle) return { ok: true, handle, changed: false };

  try {
    const taken = JSON.parse(await env.META.get(`hosted-handle:${handle}`));
    if (taken && typeof taken.account_id === 'string' && taken.account_id
        && taken.account_id !== accountId) {
      return { error: 'handle_taken', status: 409 };
    }
  } catch {}
  const ghAcct = await lookupHostedAccount(env, handle);
  if (ghAcct && ghAcct.account_id !== accountId) {
    return { error: 'handle_taken', status: 409 };
  }

  const gh = normalizeGithubLogin(github_login);
  const now = new Date().toISOString();
  await env.META.put(`hosted-handle:${handle}`, JSON.stringify({
    account_id: accountId,
    created: now,
    ...(gh ? { github_login: gh } : {}),
  }));
  if (existing && existing !== handle) {
    try {
      const old = JSON.parse(await env.META.get(`hosted-handle:${existing}`));
      if (old && old.account_id === accountId) {
        await env.META.delete(`hosted-handle:${existing}`);
      }
    } catch {}
  }
  const prev = (await accountProfile(env, accountId)) || {};
  await putAccountProfile(env, accountId, {
    handle,
    created: prev.created || now,
    ...(gh ? { github_login: gh } : {}),
    pins: normalizeProfilePins(prev),
  });
  if (gh) {
    try {
      const rec = JSON.parse(await env.META.get(`hosted-account:${gh}`));
      if (rec && rec.account_id === accountId) {
        await env.META.put(`hosted-account:${gh}`, JSON.stringify({ ...rec, handle }));
      }
    } catch {}
  }
  return { ok: true, handle, changed: Boolean(existing) };
}

async function profileBootForSession(env, session) {
  const accountId = await sessionAccountId(env, session);
  if (!accountId) {
    const login = sessionLogin(session);
    const suggested = login || suggestHandleFromEmail(session && session.email) || null;
    return { handle: null, suggested, pins: [] };
  }
  const rec = await accountProfile(env, accountId);
  const claimed = normalizeGithubLogin(rec && rec.handle);
  const login = sessionLogin(session);
  const suggested = claimed || login || suggestHandleFromEmail(session && session.email) || null;
  return { handle: claimed, suggested, pins: normalizeProfilePins(rec) };
}

// Claim / publish mint an account; bare sign-in does not (spectators stay
// account-less until they do something that needs one). Handle claim is that
// something for email users and vanity pickers.
async function ensureSessionHostedAccount(env, session) {
  if (!session || !env || !env.META) return null;
  const existingId = await sessionAccountId(env, session);
  const login = sessionLogin(session);
  const idp = session.idp && typeof session.idp === 'object' ? session.idp : null;
  if (login) {
    const ghId = idp && idp.provider === 'github' && idp.sub ? String(idp.sub) : null;
    const rec = await hostedAccountForGithub(env, login, session.email || null, ghId);
    if (rec && existingId && rec.account_id !== existingId) {
      // Session already pointed at an account; don't swap under it.
      return { account_id: existingId, github_login: login };
    }
    return rec;
  }
  if (normalizeEmail(session.email)) {
    return hostedAccountForEmail(env, session.email, idp);
  }
  if (existingId) return { account_id: existingId };
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
  // The account rides on the key's metadata as well as in the value. A list
  // returns metadata with the keys, so "which of these belong to this account"
  // can be answered from the listing alone -- without it, revoking an
  // account's terminals means reading every token record on the host one at a
  // time, which took the replay button past 45 seconds and looked like a hang.
  await env.META.put(`hosted-token:${tokenHash}`, JSON.stringify(record), {
    metadata: { account_id: record.account_id },
  });
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
  try { await stampOnboardingFor(env, account.account_id, 'agent_connected'); } catch {}
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
// ---- invite emails --------------------------------------------------------
// Adding someone to a doc's allowed_users is an invitation, and an invitation
// nobody hears about is not one: the in-app inbox only shows after the person
// signs in, which is exactly what they do not know to do. Each NEWLY added
// invitee gets one message. Delivery is pluggable and both plugs are
// OPTIONAL — a Cloudflare Email Sending binding when the worker has one,
// else Resend over HTTPS when RESEND_API_KEY is set, else nothing — and
// "nothing" is a supported configuration, not an error: same posture as the
// OIDC provider seat.
//
// The sending domain's reputation is shared by everything tdoc will ever
// send, so this path is deliberately stingy:
//   - only the diff sends — an address already on the list never re-sends
//   - a per-doc+address cooldown (KV TTL) absorbs remove/re-add churn
//   - a per-inviter daily cap bounds the worst case
//   - an opt-out is honored before anything else, and it is permanent
const INVITE_EMAIL_COOLDOWN_S = 7 * 24 * 60 * 60;
const INVITE_EMAIL_DAILY_CAP = 50;

function emailSenderAvailable(env) {
  return !!(env && ((env.EMAIL && typeof env.EMAIL.send === 'function')
    || String(env.RESEND_API_KEY || '').trim()));
}

async function deliverEmail(env, msg) {
  if (env.EMAIL && typeof env.EMAIL.send === 'function') return env.EMAIL.send(msg);
  const key = String(env.RESEND_API_KEY || '').trim();
  if (!key) throw new Error('no email sender configured');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${msg.from.name} <${msg.from.email}>`,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}`);
}

// allowed_users holds two shapes (see isAllowlisted): a bare address is its
// own destination; a handle reaches the email its account has on record, and
// a handle with no account — or none recorded — simply cannot be mailed.
async function resolveInviteeAddress(env, invitee) {
  if (typeof invitee !== 'string' || !invitee) return null;
  if (invitee.includes('@')) return normalizeEmail(invitee);
  const rec = await lookupHostedAccount(env, invitee);
  return rec ? normalizeEmail(rec.email) : null;
}

function inviteEmailBodies({ inviterName, title, docUrl, optoutUrl }) {
  const text = [
    `${inviterName} invited you to the document "${title}".`,
    '',
    `Open it here: ${docUrl}`,
    '',
    'Sign in with this email address and the invitation is already yours —',
    'access is granted to the address itself, nothing to set up.',
    '',
    '—',
    'tdoc · prompt-native documents',
    `No more emails like this: ${optoutUrl}`,
  ].join('\n');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = [
    '<!doctype html><html><body style="font-family:-apple-system,system-ui,sans-serif;color:#1a1a1a;max-width:34em;margin:2em auto;padding:0 1em">',
    `<p><strong>${esc(inviterName)}</strong> invited you to the document &ldquo;${esc(title)}&rdquo;.</p>`,
    `<p><a href="${esc(docUrl)}">Open the document</a></p>`,
    '<p style="color:#555">Sign in with this email address and the invitation is already yours — access is granted to the address itself, nothing to set up.</p>',
    `<p style="color:#999;font-size:0.85em;border-top:1px solid #eee;padding-top:1em">tdoc · prompt-native documents · <a href="${esc(optoutUrl)}" style="color:#999">No more emails like this</a></p>`,
    '</body></html>',
  ].join('');
  return { text, html };
}

async function sendInviteEmails(env, { added, inviterName, inviterId, slug, title, origin }) {
  const emailed = [];
  if (!emailSenderAvailable(env)) return emailed;
  if (!Array.isArray(added) || !added.length) return emailed;
  let host = 'tdoc.dev';
  try { host = new URL(origin).hostname; } catch {}
  const from = { email: String(env.TDOC_EMAIL_FROM || '').trim() || `invites@${host}`, name: 'tdoc' };
  const day = new Date().toISOString().slice(0, 10);
  const capKey = `invite-cap:${inviterId || 'unknown'}:${day}`;
  let sentToday = Number(await env.META.get(capKey)) || 0;
  for (const invitee of added) {
    if (sentToday >= INVITE_EMAIL_DAILY_CAP) return emailed;
    let addr = null;
    try { addr = await resolveInviteeAddress(env, invitee); } catch {}
    if (!addr) continue;
    if (await env.META.get(`email-optout:${addr}`)) continue;
    const coolKey = `invite-sent:${slug}:${addr}`;
    if (await env.META.get(coolKey)) continue;
    const tok = rand(16);
    const { text, html: htmlBody } = inviteEmailBodies({
      inviterName, title,
      docUrl: `${origin}/d/${slug}`,
      optoutUrl: `${origin}/email/optout?t=${tok}`,
    });
    try {
      await env.META.put(`email-optout-token:${tok}`, addr, { expirationTtl: 60 * 60 * 24 * 30 });
      await deliverEmail(env, {
        to: addr,
        from,
        subject: `${inviterName} invited you to "${title}" on tdoc`,
        text,
        html: htmlBody,
      });
      sentToday += 1;
      emailed.push(addr);
      await env.META.put(capKey, String(sentToday), { expirationTtl: 60 * 60 * 24 * 2 });
      await env.META.put(coolKey, '1', { expirationTtl: INVITE_EMAIL_COOLDOWN_S });
    } catch {
      // One address failing must not sink the access patch or the rest of
      // the batch — the invitation still exists in the list either way.
    }
  }
  return emailed;
}

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
  if (kind === 'access_request') return `access_request:${slug}`;
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

// ===========================================================================
// Outbound notification — provider-neutral fan-out to an external inbox.
//
// PROBLEM: deliverInbox() writes tdoc's OWN inbox, which nobody is watching.
// An agent only learns a comment exists by polling (`tdoc-pull`), so review
// feedback sits until someone remembers to go look.
//
// SHAPE: one provider-neutral layer here, and providers that know a wire
// format. Raft is the first; nothing below names it outside NOTIFY_PROVIDERS.
// A second provider is a new entry in that object and nothing else.
//
// WHAT THIS IS NOT: it is not a second inbox and not a retry engine. The
// internal inbox still gets every event; this fires only when a HUMAN hands
// work over. Delivery failure is reported, never retried — a handoff that did
// not land shows a marker and a resend button, because an agent woken by a
// replay of a comment the human already dealt with is worse than one not woken
// at all.
// ===========================================================================

// A target names one agent on one provider. `agent_sub` is the stable key:
// agent_name is a display string the provider may rename under us.
function normalizeNotifyTarget(t) {
  if (!t || typeof t !== 'object') return null;
  const provider = typeof t.provider === 'string' ? t.provider.trim().toLowerCase() : '';
  if (!NOTIFY_PROVIDERS[provider]) return null;
  const out = NOTIFY_PROVIDERS[provider].validateTarget(t);
  if (!out) return null;
  return {
    provider,
    ...out,
    agent_name: typeof t.agent_name === 'string' ? t.agent_name.slice(0, 80) : '',
    last_touched: typeof t.last_touched === 'string' ? t.last_touched : '',
  };
}

function sameNotifyTarget(a, b) {
  return !!a && !!b && a.provider === b.provider
    && a.server_id === b.server_id && a.agent_sub === b.agent_sub;
}

const NOTIFY_PROVIDERS = {
  raft: {
    validateTarget(t) {
      const server_id = typeof t.server_id === 'string' ? t.server_id.trim() : '';
      const agent_sub = typeof t.agent_sub === 'string' ? t.agent_sub.trim() : '';
      if (!server_id || !agent_sub) return null;
      // The slug is what addresses a server when REQUESTING access; the id is
      // what the resource URN is built from. They are different strings and
      // the API rejects each in the other's place, so a target carries both.
      const server_slug = typeof t.server_slug === 'string' ? t.server_slug.trim() : '';
      return { server_id, agent_sub, ...(server_slug ? { server_slug } : {}) };
    },
    // Three legs: request → resource-bound token → event. The token is bound
    // to (server, agent-inbound) so it cannot address a different server.
    async send(env, target, event) {
      if (!env.RAFT_CLIENT_ID || !env.RAFT_CLIENT_SECRET) {
        return { status: 'failed', error: 'provider_not_configured' };
      }
      const base = env.RAFT_API_BASE || 'https://api.raft.build';
      try {
        // Addressed by SLUG, not id. Passing the server's uuid here answers
        // 404, which reads like a missing endpoint and is really a missing
        // server — the reason a target keeps both strings.
        if (!target.server_slug) return { status: 'failed', error: 'target_missing_server_slug' };
        const reqRes = await fetch(`${base}/api/oauth/requests/agent`, {
          method: 'POST',
          headers: raftAuthHeaders(env),
          body: JSON.stringify({
            serverSlug: target.server_slug,
            agentName: target.agent_name || target.agent_sub,
            scopes: ['agent:notification:write'],
          }),
        });
        if (!reqRes.ok) return { status: 'failed', error: `request_${reqRes.status}` };
        const reqBody = await reqRes.json().catch(() => ({}));
        // The response is camelCase. Reading `request_id` here silently sent
        // `undefined` to the token endpoint.
        const requestId = reqBody.requestId || reqBody.request_id;
        if (!requestId) return { status: 'failed', error: 'request_id_missing' };
        // "built from the returned agent.serverId exactly as shown" — take the
        // id the API just handed back rather than the one we stored, so a
        // stale record cannot address the wrong server's inbox.
        const serverId = (reqBody.agent && reqBody.agent.serverId) || target.server_id;

        const tokRes = await fetch(`${base}/api/oauth/token`, {
          method: 'POST',
          headers: raftAuthHeaders(env),
          body: JSON.stringify({
            grant_type: 'urn:slock:grant-type:agent_request',
            request_id: requestId,
            resource: `urn:raft:server:${serverId}:agent-inbound`,
          }),
        });
        if (!tokRes.ok) return { status: 'failed', error: `token_${tokRes.status}` };
        const { access_token } = await tokRes.json();

        const evRes = await fetch(`${base}/api/oauth/agent-events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
          body: JSON.stringify(event),
        });
        if (!evRes.ok) return { status: 'failed', error: `event_${evRes.status}` };
        return { status: 'delivered', error: null };
      } catch (e) {
        return { status: 'failed', error: String((e && e.message) || e).slice(0, 200) };
      }
    },
  },
};

function raftAuthHeaders(env) {
  const basic = btoa(`${env.RAFT_CLIENT_ID}:${env.RAFT_CLIENT_SECRET}`);
  return { 'Content-Type': 'application/json', Authorization: `Basic ${basic}` };
}

// ─────────────────────── who follows this doc ───────────────────────
//
// The list is not hand-maintained. An agent writes itself in whenever it
// publishes a version or answers a comment, so "who is on this doc" is a
// consequence of doing the work rather than a setting somebody has to
// remember. Replacement is therefore automatic: when an agent goes away, the
// one that picks the doc up becomes the default the first time it touches it.
const NOTIFY_AGENTS_MAX = 8;

async function touchDocAgent(env, slug, target) {
  const t = normalizeNotifyTarget(target);
  if (!t) return false;
  const meta = await loadDocMeta(env, slug);
  if (!meta) return false;
  const prev = Array.isArray(meta.notify_agents) ? meta.notify_agents : [];
  const rest = prev.map(normalizeNotifyTarget).filter(x => x && !sameNotifyTarget(x, t));
  const next = [{ ...t, last_touched: new Date().toISOString() }, ...rest].slice(0, NOTIFY_AGENTS_MAX);
  await env.META.put(`meta:${slug}`, JSON.stringify({ ...meta, notify_agents: next }));
  return true;
}

async function accountNotifyTargets(env, accountId) {
  if (!accountId) return [];
  try {
    const raw = await env.META.get(`account-notify:${accountId}`);
    const list = raw ? JSON.parse(raw) : [];
    return (Array.isArray(list) ? list : []).map(normalizeNotifyTarget).filter(Boolean);
  } catch { return []; }
}

// doc first, account second. Returns what the handoff panel renders: one
// preselected recipient, the other recent ones as switchable candidates.
async function resolveNotifyTargets(env, slug) {
  const meta = await loadDocMeta(env, slug);
  const byRecency = (a, b) => String(b.last_touched || '').localeCompare(String(a.last_touched || ''));
  const docTargets = (Array.isArray(meta && meta.notify_agents) ? meta.notify_agents : [])
    .map(normalizeNotifyTarget).filter(Boolean).sort(byRecency);
  const fallbackList = await accountNotifyTargets(env, meta && meta.hosted && meta.hosted.account_id);
  const fallback = fallbackList[0] || null;
  if (docTargets.length) {
    return {
      default: { ...docTargets[0], source: 'doc' },
      candidates: docTargets.slice(1).map(t => ({ ...t, source: 'doc' })),
      fallback,
      reason: null,
    };
  }
  // With no recipient the caller has to tell a person WHY, and the honest
  // answer differs by case. Saying "this agent has notifications off" when we
  // simply have nobody bound would be a guess presented as a fact — tdoc
  // cannot see whether the App is installed on the Raft side until it tries a
  // delivery. So this reports the one thing it actually knows — nobody is
  // bound — and a delivery that was attempted and failed speaks for itself
  // through its own recorded error, which is the case that must NOT disable
  // the button: that would remove the only way to retry.
  return {
    default: fallback ? { ...fallback, source: 'account' } : null,
    candidates: fallbackList.slice(1).map(t => ({ ...t, source: 'account' })),
    fallback,
    reason: fallback ? null : 'no_agent_bound',
  };
}

// ─────────────────────────── handoffs ───────────────────────────
const HANDOFF_MAX = 50;

async function loadHandoffs(env, slug) {
  try {
    const raw = await env.META.get(`handoffs:${slug}`);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function putHandoff(env, slug, record) {
  const list = await loadHandoffs(env, slug);
  const next = [record, ...list.filter(h => h && h.handoff_id !== record.handoff_id)].slice(0, HANDOFF_MAX);
  await env.META.put(`handoffs:${slug}`, JSON.stringify(next));
  return record;
}

// The payload carries a summary and a link, never comment bodies: a delivery
// surface we do not control should not become a copy of the document.
function handoffEvent({ slug, docTitle, handoffId, commentIds, instruction, publicHost }) {
  const n = commentIds.length;
  return {
    kind: 'notification',
    summary: n === 1
      ? `tdoc: 1 comment handed to you on "${docTitle || slug}"`
      : `tdoc: ${n} comments handed to you on "${docTitle || slug}"`,
    externalEventId: `tdoc:${slug}:${handoffId}`,
    ttlSeconds: 86400,
    payload: {
      source: 'tdoc',
      slug,
      handoff_id: handoffId,
      comment_ids: commentIds,
      instruction: instruction || '',
      url: `https://${publicHost || 'tdoc.dev'}/d/${slug}`,
    },
  };
}

async function dispatchHandoff(env, { slug, meta, commentIds, instruction, recipient, publicHost }) {
  const handoffId = `h_${Date.now()}_${rand(3)}`;
  const target = normalizeNotifyTarget(recipient);
  const event = handoffEvent({
    slug, docTitle: meta && meta.title, handoffId, commentIds, instruction, publicHost,
  });
  const delivery = target
    ? await NOTIFY_PROVIDERS[target.provider].send(env, target, event)
    : { status: 'failed', error: 'no_recipient' };
  return putHandoff(env, slug, {
    handoff_id: handoffId,
    at: new Date().toISOString(),
    recipient: target,
    comment_ids: commentIds,
    instruction: instruction || '',
    delivery: { ...delivery, at: new Date().toISOString() },
  });
}

// Decorate a folded comment list with handoff state. `note` is the default:
// a comment nobody handed over is a note for a human, not work queued for an
// agent. Resolution is per comment id, so a partially-resolved handoff shows
// exactly which of its comments are done.
function withHandoffStatus(list, handoffs) {
  const bare = { handoff_status: 'note', handoff_id: null, handoff_at: null, handoff_acked_at: null, handoff_delivery: null };
  if (!Array.isArray(list) || !Array.isArray(handoffs) || !handoffs.length) {
    return Array.isArray(list) ? list.map(c => ({ ...c, ...bare })) : list;
  }
  const byComment = new Map();
  // Oldest first so a later handoff of the same comment wins.
  for (const h of [...handoffs].reverse()) {
    if (!h || !Array.isArray(h.comment_ids)) continue;
    const done = new Set(Array.isArray(h.resolved_ids) ? h.resolved_ids : []);
    for (const id of h.comment_ids) {
      byComment.set(id, {
        handoff_status: done.has(id) ? 'resolved' : 'sent',
        handoff_id: h.handoff_id,
        // WHEN it went, and whether it landed. Without both, "sent" is a dead
        // end for the reader: they cannot tell an agent that is still thinking
        // from one that never got the message, and they have nothing to judge
        // "has this been long enough to chase" by. Delivered-but-silent is the
        // common case and the original design had no way to show it at all.
        handoff_at: h.at || null,
        // When an agent said it picked this up. null means only that we have
        // not heard — an agent that cannot ack is indistinguishable from one
        // that has not, so the UI must say "no response yet", never "not working".
        handoff_acked_at: h.acked_at || null,
        handoff_delivery: h.delivery ? { status: h.delivery.status, error: h.delivery.error || null } : null,
      });
    }
  }
  return list.map(c => ({ ...c, ...(byComment.get(c.id) || bare) }));
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
        preview: docPreviewFromHtml(stamped.html, {
          slug,
          version: reservation.next,
          title: nextTitle || meta.title || slug,
        }),
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
    if (SHELL_RUNTIME_EXTRA_ASSETS && typeof SHELL_RUNTIME_EXTRA_ASSETS === 'object' && Object.hasOwn(SHELL_RUNTIME_EXTRA_ASSETS, p) && (method === 'GET' || method === 'HEAD')) {
      const asset = SHELL_RUNTIME_EXTRA_ASSETS[p];
      const body = method === 'HEAD' ? null : asset.binary ? Uint8Array.from(atob(asset.body), (c) => c.charCodeAt(0)) : asset.body;
      return new Response(body, { headers: { 'Content-Type': asset.type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
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
    if (p === '/grok_logo.svg' && method === 'GET') {
      return new Response(GROK_LOGO_SVG, {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (p === '/mac/wallpaper.jpg' && method === 'GET') {
      const bin = Uint8Array.from(atob(TDOC_MAC_WALLPAPER), (c) => c.charCodeAt(0));
      return new Response(bin, {
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
    }
    if (TDOC_MAC_ICONS[p] && method === 'GET') {
      const bin = Uint8Array.from(atob(TDOC_MAC_ICONS[p]), (c) => c.charCodeAt(0));
      return new Response(bin, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
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
    if ((p === '/tdoc_logo.png' || p === '/tdoc_logo-v2.png') && method === 'GET') {
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
            ? { login: session.login || null, name: session.name || session.login || session.email, avatar_url: session.avatar_url || '', email: normalizeEmail(session.email) || '' }
            : null,
          webAuth: !!env?.GITHUB_CLIENT_SECRET,
          authConfigured: !!String(env?.GITHUB_CLIENT_ID || '').trim(),
          oidcAuth: !!oidcConfig(env),
          oidcLabel: (oidcConfig(env) || {}).label || '',
        }),
      }), { headers: { 'Content-Security-Policy': cspHeader(nonce) } });
    }

    // Isolated design review; no session, credentials, or auth actions.
    if (p === '/__preview/onboarding' && (method === 'GET' || method === 'HEAD')) {
      if (runtimeInfo().generated_by !== 'tdoc-preview') return json({ error: 'not_found' }, { status: 404 });
      const nonce = rand(16);
      return html(SHELL.appHtml({
        title: 'tdoc onboarding preview', nonceAttr: ` nonce="${nonce}"`,
        runtimeJsPath: SHELL_RUNTIME_JS_PATH, runtimeCssPath: SHELL_RUNTIME_CSS_PATH,
        bootJson: safeJsonForScript({ page: 'onboarding-preview' }),
      }), { headers: { 'Content-Security-Policy': cspHeader(nonce) } });
    }

    // `/setup` — the gate. Setup is not the tutorial: it is the one thing that
    // must be true before tdoc does anything, so it gets a route of its own
    // rather than a step inside the landing pop-up. The page reads the
    // onboarding record and moves itself when the agent turns up.
    if (p === '/setup' && (method === 'GET' || method === 'HEAD')) {
      const session = await getSession(env, req);
      // Two asks live on this route, because they are the same ask twice: paste
      // a line into your agent and watch this page move. `?step=doc` is the
      // second one. The page still shows the first to anyone who has not done
      // it, so the link is safe to hand to anybody.
      const step = url.searchParams.get('step') === 'doc' ? 'doc' : 'connect';
      const here = step === 'doc' ? '/setup?step=doc' : '/setup';
      if (!sessionPrincipal(session) && oidcConfig(env)) {
        return new Response(null, {
          status: 302,
          headers: { Location: `/api/auth/oidc/login?return=${encodeURIComponent(here)}` },
        });
      }
      // Opening the gate is beginning. `started` used to be stamped by the page
      // and only when somebody pressed Copy, so anyone who selected the line
      // and hit cmd-C connected their agent and then found no checklist on My
      // docs at all -- the card renders on `started`. The door is the honest
      // signal, and the server is standing in it. A CLI-first publisher who
      // never loads this page still never starts, which is what keeps tdoc's
      // seeded question off the doc of somebody who did not ask to be onboarded.
      try {
        const who = await sessionAccountId(env, session);
        if (who) await stampOnboardingFor(env, who, 'started');
      } catch {}
      const nonce = rand(16);
      return html(SHELL.appHtml({
        // One title for both steps. `?step=doc` is a request, not a fact: the
        // page falls back to step 1 for anybody who has not connected yet, and
        // a tab reading "make a doc" over a screen headed "Connect your agent"
        // is the URL talking over the product. The server would need the
        // account's record to tell them apart, and this route renders before
        // that is read.
        title: 'tdoc - set up',
        nonceAttr: ` nonce="${nonce}"`,
        runtimeJsPath: SHELL_RUNTIME_JS_PATH,
        runtimeCssPath: SHELL_RUNTIME_CSS_PATH,
        bootJson: safeJsonForScript({
          page: 'setup',
          step,
          identity: sessionPrincipal(session)
            ? { login: session.login || null, name: session.name || session.login || session.email, avatar_url: session.avatar_url || '' }
            : null,
          oidcAuth: !!oidcConfig(env),
          oidcLabel: (oidcConfig(env) || {}).label || '',
          debug: await isDebugAccount(env, session),
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
    //
    // Agents (hosted Bearer) use GET /api/me — same catalog as the HTML /me
    // hub, without needing a cookie. Cookie sessions also work so browser
    // tools can fetch JSON.
    if (p === '/api/me' && method === 'GET') {
      const s = await getViewerSession(env, req);
      if (!canSeeMyDocs(env, s, url.origin)) {
        return json({ error: sessionPrincipal(s) ? 'forbidden' : 'sign_in_required' }, {
          status: sessionPrincipal(s) ? 403 : 401,
        });
      }
      const data = await indexData(env, s, url.origin);
      const profile = hostedRegistrationEnabled(env, url.origin)
        ? await profileBootForSession(env, s)
        : null;
      const pinSet = new Set((profile && profile.pins) || []);
      return json({
        ok: true,
        identity: { login: actorKey(s), avatar_url: s.avatar_url || '', name: actorDisplayName(s) },
        docs: (data.docs || []).map((row) => ({ ...row, on_profile: pinSet.has(row.slug) })),
        folders: data.folders,
        recent: data.recent,
        starred: data.starred,
        ...(profile ? { profile } : {}),
      });
    }

    // Claim a public @handle (or change it). Hosted only. Email/OIDC users need
    // this for /@…; GitHub users can keep using their login via fallback or claim
    // a vanity name here. Changing frees the previous @handle.
    if (p === '/api/me/handle' && method === 'POST') {
      if (!hostedRegistrationEnabled(env, url.origin)) {
        return json({ error: 'hosted_only' }, { status: 404 });
      }
      const s = await getSession(env, req);
      if (!canSeeMyDocs(env, s, url.origin)) {
        return json({ error: sessionPrincipal(s) ? 'forbidden' : 'sign_in_required' }, {
          status: sessionPrincipal(s) ? 403 : 401,
        });
      }
      // Sign-in alone does not mint an account (spectators). Claiming a public
      // handle does — same door publish uses.
      const acct = await ensureSessionHostedAccount(env, s);
      const accountId = acct && acct.account_id;
      if (!accountId) {
        return json({ error: 'sign_in_required' }, { status: 401 });
      }
      if (s.id && !s.account_id) {
        try {
          const raw = JSON.parse(await env.META.get(`session:${s.id}`));
          if (raw && typeof raw === 'object') {
            raw.account_id = accountId;
            await env.META.put(`session:${s.id}`, JSON.stringify(raw), { expirationTtl: 60 * 60 * 24 * 30 });
          }
        } catch {}
      }
      let body = {};
      try { body = await req.json(); } catch {}
      const result = await claimAccountHandle(env, accountId, body && body.handle, {
        github_login: sessionLogin(s) || (acct && acct.github_login) || null,
      });
      if (!result.ok) {
        return json({ error: result.error, ...(result.handle ? { handle: result.handle } : {}) }, {
          status: result.status || 400,
        });
      }
      return json({
        ok: true,
        handle: result.handle,
        url: `/@${result.handle}`,
        changed: Boolean(result.changed),
      });
    }

    if (p === '/api/me/profile/pin' && method === 'POST') {
      if (!hostedRegistrationEnabled(env, url.origin)) {
        return json({ error: 'hosted_only' }, { status: 404 });
      }
      const s = await getSession(env, req);
      if (!canSeeMyDocs(env, s, url.origin)) {
        return json({ error: sessionPrincipal(s) ? 'forbidden' : 'sign_in_required' }, {
          status: sessionPrincipal(s) ? 403 : 401,
        });
      }
      const acct = await ensureSessionHostedAccount(env, s);
      const accountId = acct && acct.account_id;
      if (!accountId) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const slug = body && typeof body.slug === 'string' ? body.slug.trim() : '';
      const pinned = body && body.pinned !== false && body.pinned !== 'false';
      const result = await setProfilePin(env, accountId, slug, Boolean(pinned), { session: s });
      if (!result.ok) {
        return json({ error: result.error }, { status: result.status || 400 });
      }
      return json({
        ok: true,
        slug,
        on_profile: result.on_profile,
        pins: result.pins,
        visibility: result.visibility,
      });
    }

    if (p === '/api/me/profile' && method === 'POST') {
      if (!hostedRegistrationEnabled(env, url.origin)) {
        return json({ error: 'hosted_only' }, { status: 404 });
      }
      const s = await getSession(env, req);
      if (!canSeeMyDocs(env, s, url.origin)) {
        return json({ error: sessionPrincipal(s) ? 'forbidden' : 'sign_in_required' }, {
          status: sessionPrincipal(s) ? 403 : 401,
        });
      }
      const acct = await ensureSessionHostedAccount(env, s);
      const accountId = acct && acct.account_id;
      if (!accountId) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      const bio = typeof body.bio === 'string' ? body.bio.replace(/\s+/g, ' ').trim().slice(0, 280) : '';
      await putAccountProfile(env, accountId, { bio });
      return json({ ok: true, bio });
    }

    if (p === '/me' && (method === 'GET' || method === 'HEAD')) {
      const s = await getSession(env, req);
      if (!canSeeMyDocs(env, s, url.origin)) {
        const notice = sessionPrincipal(s) ? 'me' : 'signin';
        return new Response(null, {
          status: 302,
          headers: { Location: `/?notice=${notice}` },
        });
      }
      if (method === 'HEAD') return new Response(null, { status: 200 });
      const nonce = rand(16);
      const identity = { login: actorKey(s), avatar_url: s.avatar_url || '', name: actorDisplayName(s) };
      const data = await indexData(env, s, url.origin);
      const profile = hostedRegistrationEnabled(env, url.origin)
        ? await profileBootForSession(env, s)
        : null;
      const pinSet = new Set((profile && profile.pins) || []);
      const docs = (data.docs || []).map((row) => ({
        ...row,
        on_profile: pinSet.has(row.slug),
      }));
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
          onboarding: await (async () => {
            try {
              const id = await sessionAccountId(env, s);
              return id ? await loadOnboarding(env, id) : null;
            } catch { return null; }
          })(),
          // The checklist lives here, so every state reads differently on this
          // page -- it is the one surface that has a face for all six.
          debug: await isDebugAccount(env, s),
          ...(profile ? { profile } : {}),
          ...data,
          docs,
        }),
      }), {
        headers: { 'Content-Security-Policy': cspHeader(nonce) },
      });
    }

    // Public profile: /@<handle>. Hosted only. Claimed handle, else GitHub
    // login fallback. Lists docs the owner pinned (curated), not every public doc.
    const profileMatch = p.match(/^\/@([^/]+)\/?$/);
    if (profileMatch && (method === 'GET' || method === 'HEAD')) {
      if (!hostedRegistrationEnabled(env, url.origin)) {
        return statusPageResponse({
          status: 404,
          error: true,
          title: 'Profiles unavailable',
          message: 'Public @handles are only on hosted tdoc.dev.',
          actions: [{ label: 'tdoc home', href: '/' }],
        });
      }
      const login = normalizeGithubLogin(decodeURIComponent(profileMatch[1]));
      let account = login ? await lookupProfileAccount(env, login) : null;
      if (!account) {
        return statusPageResponse({
          status: 404,
          error: true,
          title: 'Profile not found',
          message: login
            ? `@${login} has not published on tdoc yet, or that handle is not claimed.`
            : 'That is not a valid handle.',
          actions: [{ label: 'tdoc home', href: '/' }],
        });
      }
      if (method === 'HEAD') return new Response(null, { status: 200 });
      const handle = account.handle || login;
      const session = await getSession(env, req);
      const viewerId = session ? await sessionAccountId(env, session) : null;
      const mine = Boolean(
        (viewerId && account.account_id && viewerId === account.account_id)
        || (sessionLogin(session) && account.github_login
            && sessionLogin(session) === account.github_login),
      );
      // Enrich github_login from the hosted-account record when the handle
      // index omitted it — needed so ownership matches docs stamped by login.
      if (!account.github_login && account.account_id) {
        const storedLogin = sessionLogin(session);
        if (mine && storedLogin) account = { ...account, github_login: storedLogin };
      }
      const docs = await profileData(env, account, { includePrivate: mine });
      const stored = account.account_id ? await accountProfile(env, account.account_id) : null;
      const bio = stored && typeof stored.bio === 'string' ? stored.bio.slice(0, 280) : '';
      let catalog = [];
      if (mine && session) {
        const data = await indexData(env, session, url.origin);
        const pinned = new Set((stored && normalizeProfilePins(stored)) || []);
        catalog = (data.docs || [])
          .filter((row) => row.mine)
          .map((row) => ({
            slug: row.slug,
            title: row.title,
            on_profile: pinned.has(row.slug),
          }));
      }
      const wantsJson = (req.headers.get('accept') || '').includes('application/json');
      if (wantsJson) {
        return json({
          ok: true,
          login: handle,
          handle,
          github_login: account.github_login || null,
          bio,
          docs,
          ...(mine ? { mine: true, catalog } : {}),
        });
      }
      const nonce = rand(16);
      const identity = sessionPrincipal(session)
        ? { login: actorKey(session), avatar_url: session.avatar_url || '', name: actorDisplayName(session) }
        : null;
      return html(SHELL.appHtml({
        title: `@${handle} · tdoc`,
        nonceAttr: ` nonce="${nonce}"`,
        runtimeJsPath: SHELL_RUNTIME_JS_PATH,
        runtimeCssPath: SHELL_RUNTIME_CSS_PATH,
        bootJson: safeJsonForScript({
          page: 'profile',
          login: handle,
          handle,
          github_login: account.github_login || null,
          bio,
          docs,
          mine,
          ...(mine ? { catalog, identity } : { identity }),
        }),
      }), {
        headers: { 'Content-Security-Policy': cspHeader(nonce) },
      });
    }

    // Shared folder catalog: opaque /f/<share_id>. Lists only docs the
    // viewer may already read (cookie or hosted Bearer). Agents prefer
    // /api/folders/shared?id=.
    const folderShareMatch = p.match(/^\/f\/([^/]+)\/?$/);
    if (folderShareMatch && method === 'GET') {
      const shareId = decodeURIComponent(folderShareMatch[1]);
      const listing = await buildFolderShareListing(env, req, shareId);
      if (!listing.ok) {
        if (listing.status === 401) {
          return statusPageResponse({
            status: 401,
            error: true,
            title: 'Sign in required',
            message: 'This folder is private. Sign in with an invited account to open it.',
            actions: [{
              label: 'Sign in',
              href: `/api/auth/oidc/login?return=${encodeURIComponent(`/f/${shareId}`)}`,
            }],
          });
        }
        return statusPageResponse({
          status: listing.status || 404,
          error: true,
          title: 'Folder not found',
          message: 'This folder link is private, revoked, or does not exist.',
          actions: [{ label: 'tdoc home', href: '/' }],
        });
      }
      const wantsJson = (req.headers.get('accept') || '').includes('application/json');
      if (wantsJson) {
        return json({
          ok: true,
          folder: listing.folder,
          docs: listing.docs,
          url: `/f/${encodeURIComponent(shareId)}`,
        });
      }
      return folderSharePageResponse(env, listing);
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
      // The query rides along. Everything that deep-links into a doc without
      // knowing its version -- `?comment=<id>` from a notification, `?step=`
      // from the checklist -- addresses the bare slug, and dropping the search
      // here landed all of them on an ordinary page with nothing opened.
      // `url.search` is already percent-encoded by the URL parser, so it
      // cannot carry a newline into the header.
      if (latest > 0) return redirectTo(`/d/${encodeURIComponent(slug)}/v/${latest}${url.search}`);
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
          // No backslash-escaping of quotes: this goes into an HTML comment,
          // where a quote means nothing. It was a JSON habit applied to the
          // wrong grammar -- and it escaped quotes without escaping
          // backslashes, which is the flaw CodeQL named. `forHtmlComment` is
          // the actual defence here.
          : c.anchor?.text ? `(on text: "${forHtmlComment(c.anchor.text.slice(0, 120))}")` : '(no anchor)';
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
    // Self-serve hosted-doc quota bump. Session cookie or hosted upload token.
    // Body: { reason }. Raises 50→100, then 100→200; above that stays logged only.
    if (p === '/api/quota/bump' && method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}
      const reason = body && body.reason;

      let accountId = null;
      let by = null;
      const upload = await requireUploadAuth(req, env);
      if (upload.ok && upload.actor && upload.actor.kind === 'hosted' && upload.actor.account_id) {
        accountId = upload.actor.account_id;
        by = {
          kind: 'token',
          account_id: accountId,
          github_login: upload.actor.github_login || null,
          email: upload.actor.email || null,
        };
      } else {
        const session = await getSession(env, req) || await sessionFromHostedBearer(env, req);
        if (!sessionPrincipal(session)) {
          return json({ error: 'sign_in_required' }, { status: 401 });
        }
        accountId = await sessionAccountId(env, session);
        if (!accountId) {
          return json({ error: 'hosted_account_unavailable' }, { status: 503 });
        }
        by = {
          kind: 'session',
          account_id: accountId,
          login: sessionLogin(session) || null,
          email: normalizeEmail(session && session.email) || null,
        };
      }

      const result = await requestQuotaBump(env, { accountId, reason, by });
      if (!result.ok) return json({ error: result.error }, { status: result.status || 400 });
      return json(result);
    }

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
      // Same door as /api/doc/duplicate: a self-hosted worker keeps writes to
      // its owner unless it has opted into hosted accounts. tdoc.dev is open.
      // The operator session used to skip this and become `owner_session`,
      // which bypassed the doc quota and left new docs unstamped — so the
      // site owner never hit the bump dialog while their agent token did.
      if (!ownerCreate && !hostedAccountCopiesEnabled(env, req)) {
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
      if (!acct) {
        if (ownerCreate) {
          // BYOK operator with no hosted registry: keep the old unlimited path.
          const html = blankDocHtml();
          let newSlug = null;
          for (let attempt = 0; attempt < 8; attempt++) {
            const candidate = blankDocSlug(crypto.getRandomValues(new Uint8Array(8)));
            const existsMeta = await loadDocMeta(env, candidate);
            if (existsMeta) continue;
            const bytes = await docBytesExist(env, candidate);
            if (!bytes.ok) return bytes.response;
            if (bytes.exists) continue;
            newSlug = candidate;
            break;
          }
          if (!newSlug) return json({ error: 'slug_exhausted' }, { status: 409 });
          const now = new Date().toISOString();
          const incoming = {
            title: 'Untitled',
            created_from: 'blank',
            slug: newSlug,
            created: now,
            versions: [{ n: 1, created: now, prompt: 'Created from scratch in the browser', blank: true }],
            created_by: session.login,
          };
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
        return json({ error: 'hosted_account_unavailable' }, { status: 503 });
      }
      const actor = {
        kind: 'hosted',
        account_id: acct.account_id,
        github_login: acct.github_login,
        // Without this an email-born account's browser-created doc had no
        // routable owner — the very path most email users take first.
        email: normalizeEmail((acct && acct.email) || (session && session.email)),
      };

      const html = blankDocHtml();
      const maxBytes = hostedMaxUploadBytes(env);
      const size = utf8ByteLength(html);
      if (size > maxBytes) return json({ error: 'quota_upload_bytes', limit: maxBytes, size }, { status: 413 });
      const limit = await hostedMaxDocsFor(env, actor.account_id);
      const used = await countHostedDocs(env, actor.account_id);
      if (used >= limit) return json(quotaDocsPayload(env, limit, used), { status: 403 });

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
      // Operator session used to stay on owner_session forever, which skipped
      // quota and left copies unstamped. Prefer the hosted account whenever
      // one exists — same rules as everyone else.
      const acct = sessionLogin(session)
        ? await hostedAccountForGithub(env, session.login, session && session.email,
            session && session.idp && session.idp.provider === 'github' ? session.idp.sub : null)
        : await hostedAccountForEmail(env, session && session.email, session && session.idp);
      if (acct) {
        actor = {
          kind: 'hosted',
          account_id: acct.account_id,
          github_login: acct.github_login,
          email: normalizeEmail((acct && acct.email) || (session && session.email)),
        };
      } else if (!ownerCopy) {
        return json({ error: 'account_copy_unavailable' }, { status: 403 });
      }
      if (actor.kind === 'hosted') {
        const maxBytes = hostedMaxUploadBytes(env);
        const size = utf8ByteLength(rawHtml);
        if (size > maxBytes) {
          return json({ error: 'quota_upload_bytes', limit: maxBytes, size }, { status: 413 });
        }
        const limit = await hostedMaxDocsFor(env, actor.account_id);
        const used = await countHostedDocs(env, actor.account_id);
        if (used >= limit) {
          return json(quotaDocsPayload(env, limit, used), { status: 403 });
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

    // OIDC sign-in, one pair of routes for every registered provider
    // (OIDC_PROVIDERS). GitHub keeps its own first-party flow above.
    const oidcLoginMatch = method === 'GET' && p.match(OIDC_LOGIN_ROUTE);
    if (oidcLoginMatch) {
      const cfg = oidcProvider(env, oidcLoginMatch[1]);
      if (!cfg) return redirectTo('/?notice=signin');
      const nonce = rand(16);
      const ret = sanitizeReturn(url.searchParams.get('return'));
      await env.META.put(`oauthstate:${cfg.id}:${nonce}`, ret, { expirationTtl: 600 });
      let auth;
      try { auth = new URL((await oidcDiscovery(cfg)).authorization_endpoint); }
      catch (e) { return authStatusResponse('Sign-in is not available right now: ' + e.message, { error: true, status: 502 }); }
      auth.searchParams.set('client_id', cfg.clientId);
      auth.searchParams.set('redirect_uri', `${url.origin}${cfg.callbackPath}`);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('scope', cfg.scope);
      auth.searchParams.set('state', nonce);
      // The provider remembers its own session, so a returning visitor is
      // signed straight through — correct as a default, bewildering when you
      // meant to pick a different method. prompt=login is the standard OIDC
      // lever that forces the chooser; whitelisted so the param can't smuggle
      // anything else.
      if (url.searchParams.get('prompt') === 'login') auth.searchParams.set('prompt', 'login');
      return redirectTo(auth.toString(), [
        `${cfg.stateCookie}=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      ]);
    }

    const oidcCallbackMatch = method === 'GET' && p.match(OIDC_CALLBACK_ROUTE);
    if (oidcCallbackMatch) {
      const cfg = oidcProvider(env, oidcCallbackMatch[1]);
      if (!cfg) return redirectTo('/?notice=signin');
      const code = url.searchParams.get('code');
      const state = String(url.searchParams.get('state') || '');
      const cookieState = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${cfg.stateCookie}=([a-f0-9]+)`));
      // Agent sign-in (Raft) carries no state: there is no browser to hold
      // the cookie. Only a provider that opts in may take that path, and the
      // userinfo check below then insists the identity really is an agent —
      // otherwise this would be a CSRF-able login for humans.
      const stateless = !state && !cookieState && cfg.statelessAgents;
      if (!code || (!stateless && (!state || !cookieState || cookieState[1] !== state))) {
        return authStatusResponse('Sign-in could not be verified (state mismatch). Please try again.', { error: true, status: 400 });
      }
      let ret = '/';
      if (!stateless) {
        ret = sanitizeReturn(await env.META.get(`oauthstate:${cfg.id}:${state}`));
        await env.META.delete(`oauthstate:${cfg.id}:${state}`);
      }
      try {
        const disc = await oidcDiscovery(cfg);
        const tr = await fetch(disc.token_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'tdoc-worker' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: `${url.origin}${cfg.callbackPath}`,
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
        if (stateless && !(user && user.type === 'agent')) {
          return authStatusResponse('Only an agent may sign in without a browser session. Please start sign-in again.', { error: true, status: 403 });
        }
        return await cfg.complete(env, { user, tok, disc, ret, stateless, clearState: `${cfg.stateCookie}=; Path=/; Max-Age=0` });
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
      const folder = {
        id: `f_${Date.now()}_${rand(4)}`,
        name,
        visibility: 'private',
        created: new Date().toISOString(),
        ...(parentId ? { parent: parentId } : {}),
      };
      state.folders.push(folder);
      await saveFolderState(env, actorKey(s), state);
      return json({ ok: true, folder: publicFolder(folder) });
    }

    if (p === '/api/folders' && method === 'PATCH') {
      const s = await getSession(env, req);
      if (!actorKey(s)) return json({ error: 'sign_in_required' }, { status: 401 });
      let body = {};
      try { body = await req.json(); } catch {}
      if (!body.id || typeof body.id !== 'string') return json({ error: 'invalid_id' }, { status: 400 });
      const wantsName = 'name' in body;
      const wantsVisibility = 'visibility' in body;
      const wantsAllowed = 'allowed_users' in body;
      if (!wantsName && !wantsVisibility && !wantsAllowed) {
        return json({ error: 'nothing_to_update' }, { status: 400 });
      }
      const state = await loadFolderState(env, actorKey(s));
      const folder = state.folders.find((f) => f.id === body.id);
      if (!folder) return json({ error: 'not_found' }, { status: 404 });
      if (wantsName) {
        const name = validFolderName(body.name);
        if (!name) return json({ error: 'invalid_name' }, { status: 400 });
        if (state.folders.some((f) => f !== folder && (f.parent || null) === (folder.parent || null) && f.name.toLowerCase() === name.toLowerCase())) {
          return json({ error: 'duplicate_name' }, { status: 400 });
        }
        folder.name = name;
      }
      if (wantsVisibility) {
        if (!ACCESS_VISIBILITIES.has(body.visibility)) {
          return json({ error: 'invalid_access_value', field: 'visibility' }, { status: 400 });
        }
        folder.visibility = body.visibility;
      }
      if (wantsAllowed) {
        if (!Array.isArray(body.allowed_users)) {
          return json({ error: 'invalid_access_value', field: 'allowed_users' }, { status: 400 });
        }
        const allowed = [];
        const seen = new Set();
        for (const item of body.allowed_users) {
          const login = normalizeInvitee(item);
          if (!login) return json({ error: 'invalid_access_value', field: 'allowed_users' }, { status: 400 });
          if (seen.has(login)) continue;
          seen.add(login);
          allowed.push(login);
        }
        folder.allowed_users = allowed;
      }
      // Mint a share id whenever access is touched so Copy link always works
      // (private invitees still open /f/<id> after sign-in).
      if (wantsVisibility || wantsAllowed) {
        await ensureFolderShareId(env, actorKey(s), folder);
      }
      await saveFolderState(env, actorKey(s), state);
      return json({ ok: true, folder: publicFolder(folder) });
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
      await deleteFolderShareIndex(env, gone.share_id);
      return json({ ok: true });
    }

    if (p === '/api/folders/shared' && method === 'GET') {
      const shareId = url.searchParams.get('id') || '';
      const listing = await buildFolderShareListing(env, req, shareId);
      if (!listing.ok) return json({ error: 'not_found' }, { status: listing.status || 404 });
      return json({
        ok: true,
        folder: listing.folder,
        docs: listing.docs,
        url: `/f/${encodeURIComponent(shareId)}`,
      });
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
    // Is this credential still good? The CLI holds a config file that says it
    // is signed in, and until now nothing could tell it otherwise: a token
    // revoked anywhere -- an account reset, a terminal taken away, a replay --
    // left `--signin-only` reporting "already signed in" and the next publish
    // failing with a 401 printed as raw JSON, for ever. One cheap GET, so the
    // file can be checked instead of believed.
    if (p === '/api/hosted/whoami' && (method === 'GET' || method === 'HEAD')) {
      const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!bearer) return json({ error: 'token_required' }, { status: 401 });
      const actor = await hostedTokenActor(env, bearer);
      if (!actor) return json({ error: 'invalid_token' }, { status: 401 });
      return json({ ok: true, account_id: actor.account_id, github_login: actor.github_login || null });
    }

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

    // ---- onboarding ----
    if (p === '/api/onboarding' && method === 'GET') {
      const session = await getSession(env, req);
      const accountId = await sessionAccountId(env, session);
      if (!accountId) return json({ anonymous: true, record: null });
      // `paired`: has a terminal ever connected to this account. A paired
      // agent never shows a code again, so the page must not wait for one.
      let paired = false;
      try { paired = Boolean(await env.META.get(`account-terminal:${accountId}`)); } catch {}
      const record = await loadOnboarding(env, accountId);
      // `?docs=1` costs a catalog walk, so only the page that waits for a doc
      // to appear asks for it. The connect gate's own poll stays two reads.
      if (url.searchParams.get('docs') === '1') {
        return json({ record, paired, newest_doc: await newestDocFor(env, accountId) });
      }
      return json({ record, paired });
    }
    // Puts the caller's own onboarding record into a named state, so the
    // journey's branches can be walked without hand-editing storage. The body
    // names a state; the record is built here from a fixed table, so no field
    // arrives from the client. Allowlisted accounts only, same-origin, and the
    // account id comes from the session — it can reach no record but yours.
    if (p === '/api/onboarding/state' && method === 'POST') {
      if (!sameOrigin(req, url)) return json({ error: 'forbidden' }, { status: 403 });
      const session = await getSession(env, req);
      if (!(await isDebugAccount(env, session))) return json({ error: 'forbidden' }, { status: 403 });
      // Mint on first use, the way creating a doc does. An account record is
      // only written when somebody first publishes or creates something, so a
      // tester who has just signed in and done nothing else has no account id
      // -- and answering "sign in again" to somebody who is plainly signed in
      // is both wrong and unactionable. A brand-new account is exactly the
      // state onboarding most needs to be simulated from, so it is the one
      // this route must not refuse.
      let accountId = await sessionAccountId(env, session);
      if (!accountId) {
        const acct = sessionLogin(session)
          ? await hostedAccountForGithub(env, session.login, session && session.email,
            session && session.idp && session.idp.provider === 'github' ? session.idp.sub : null)
          : await hostedAccountForEmail(env, session && session.email, session && session.idp);
        accountId = acct && acct.account_id;
      }
      if (!accountId) return json({ error: 'hosted_account_unavailable' }, { status: 503 });
      let body = {};
      try { body = await req.json(); } catch {}
      const state = typeof body.state === 'string' ? body.state : '';
      if (!DEBUG_STATES.includes(state)) return json({ error: 'unknown_state', states: DEBUG_STATES }, { status: 400 });
      const prior = await loadOnboarding(env, accountId);
      // Which doc the built states should stand on. The record's own is right
      // whenever it has one; resetting to `new` wipes it, so the account's
      // newest doc stands in rather than a slug this person may not even own.
      // A catalog walk is fine here and nowhere else: this route is a testing
      // affordance, pressed by hand, never polled.
      const doc = (prior && prior.first_doc) || await newestDocFor(env, accountId);
      const next = debugRecord(state, new Date().toISOString(), doc);
      await env.META.put(`account-onboarding:${accountId}`, JSON.stringify(next));
      // The pairing marker moves with the state. `paired` -- has this account
      // ever connected a terminal -- is half of what the gate calls connected,
      // and it is only ever written, so an account that has paired once could
      // not be put back before it: `new`, `started` and `connected` all looked
      // identical on /setup, and the waiting and stuck branches were
      // unreachable. This is the marker, not the credential: the token lives
      // under `hosted-token:` and is untouched, so a paired CLI keeps working.
      try {
        const key = `account-terminal:${accountId}`;
        if (next && next.agent_connected) {
          if (!(await env.META.get(key))) await env.META.put(key, JSON.stringify({ first: next.agent_connected, last: next.agent_connected }));
        } else {
          await env.META.delete(key);
        }
      } catch {}
      // --- replay ---
      // Resetting the record is not the same as being new again, and testing
      // onboarding means being new again more than once. Three things survive
      // a reset and each of them makes the next walk a different walk:
      //
      //   the credential   `account-terminal:` above is a marker; the token it
      //                    stands for lives under `hosted-token:` and is what
      //                    actually keeps a CLI connected. Leaving it means
      //                    step 1 can never be walked again -- the one step
      //                    that cannot be exercised locally at all.
      //   the doc          the journey's doc and its comments stay, so a second
      //                    walk publishes a second one, and a tenth walk leaves
      //                    ten test docs in somebody's list.
      //   the dismissals   live in the browser, not here; the page clears its
      //                    own (see the debug bar).
      //
      // Both are opt-in, because the states are also used to jump *to* a step
      // on an account that should keep working afterwards.
      const cleared = { tokens: 0, doc: null };
      if (body.unpair === true) {
        // No account -> token index exists; the token's key is its own hash.
        // A full scan is the price, and this route is pressed by hand.
        let cursor;
        do {
          const r = await env.META.list({ prefix: 'hosted-token:', cursor });
          for (const k of r.keys) {
            // Metadata when the key has it (every token written since this
            // shipped), a read only for the ones that predate it. The
            // fallback keeps revocation complete on an old key; the metadata
            // keeps it fast on every new one, and the slow set only shrinks.
            let owner = k.metadata && k.metadata.account_id;
            if (!owner) {
              try { owner = (JSON.parse(await env.META.get(k.name)) || {}).account_id; } catch {}
            }
            if (owner === accountId) {
              await env.META.delete(k.name);
              cleared.tokens += 1;
            }
          }
          cursor = r.cursor;
          if (r.list_complete) break;
        } while (cursor);
        try { await env.META.delete(`account-terminal:${accountId}`); } catch {}
      }
      if (body.purge === true && prior && prior.first_doc) {
        // Only the journey's own doc, and only after checking this account
        // owns it -- a slug in a record is not a licence to delete.
        const meta = await loadDocMeta(env, prior.first_doc);
        if (meta && meta.hosted && meta.hosted.account_id === accountId) {
          await deleteDocEverywhere(env, prior.first_doc);
          cleared.doc = prior.first_doc;
        }
      }
      return json({ ok: true, state, record: next, cleared });
    }
    if (p === '/api/onboarding/event' && method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}
      const action = typeof body.action === 'string' ? body.action : '';
      const step = onboardingActionStep(action);
      if (step === undefined) return json({ error: 'unknown_action' }, { status: 400 });
      const session = await getSession(env, req);
      const accountId = await sessionAccountId(env, session);
      const doc = typeof body.doc === 'string' && isValidSlug(body.doc) ? body.doc : null;
      // Two actions mean something before there is an account: joining the
      // waitlist and opening the example. Everything else is a step on a
      // journey that belongs to somebody.
      if (!accountId && action !== 'waitlist' && action !== 'example_opened') {
        return json({ error: 'sign_in_required' }, { status: 401 });
      }
      await logOnboardingEvent(env, accountId, action, doc ? { doc } : null);
      let record = null;
      if (accountId && step) {
        record = await stampOnboardingFor(env, accountId, step,
          step === 'waitlist' ? { started: new Date().toISOString() } : null);
      }
      return json({ ok: true, record });
    }
    if (p === '/api/doc/agent-status' && method === 'GET') {
      const slug = url.searchParams.get('slug');
      if (!slug || !isValidSlug(slug)) return json({ error: 'slug required' }, { status: 400 });
      const gate = await enforceDocAccess(env, req, slug, 1);
      if (!gate.ok) return json({ error: 'access_denied' }, { status: gate.response.status || 403 });
      const status = await readAgentStatus(env, slug);
      return json({
        ...status,
        latest_version: latestVersionNumber(gate.meta) || null,
        title: (gate.meta && typeof gate.meta.title === 'string' && gate.meta.title) || null,
      });
    }

    // ---- comments ----
    if (p === '/api/comments' && method === 'GET') {
      const slug = url.searchParams.get('slug');
      if (!slug) return json({ error: 'slug required' }, { status: 400 });
      // Same read gate as the HTML routes: private docs don't leak comments.
      const gate = await enforceDocAccess(env, req, slug, parseVersionParam(url) || 1);
      if (!gate.ok) return json({ error: 'access_denied' }, { status: gate.response.status || 403 });
      // The agent reading the comments is what bridge 2 waits for. A Bearer
      // token names the agent; `version=all` is the shape only tdoc-pull asks
      // for. Neither ever fails the read.
      const agentAuth = req.headers.get('authorization') ? await requireUploadAuth(req, env) : null;
      if ((agentAuth && agentAuth.ok) || url.searchParams.get('version') === 'all') {
        try {
          await markAgentRead(env, slug);
          if (agentAuth && agentAuth.ok && agentAuth.actor && agentAuth.actor.kind === 'hosted') {
            await stampOnboardingFor(env, agentAuth.actor.account_id, 'comments_read');
          }
        } catch {}
      }
      // Read from the DO (source of truth; it lazily migrates from KV on first
      // touch). Migrate-in-memory for this response only — never persist from a
      // read (writes go through the DO).
      const list = await readComments(env, slug);
      ensureMigrated(list);
      const V = parseVersionParam(url);
      // `?version=all` returns every comment across all versions (lossless,
      // used by tdoc-pull). A numeric/absent version returns that version's
      // snapshot (used by the overlay viewing a specific /v/<n>).
      const folded = V === 'all' ? historyList(list) : snapshotList(list, V);
      // Handoff state is derived from the handoff records, not stored on the
      // comment: the comment log stays a log of what people said, and "has
      // this been handed over" is a fact about the handoff, not the comment.
      return json(withHandoffStatus(folded, await loadHandoffs(env, slug)));
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
      const { slug, version, anchor, parent_id } = body;
      // Trimmed before the check, the way the edit path already does it: "\n" is
      // not a comment, and one that gets in cannot be seen or removed (#532).
      const commentText = typeof body.text === 'string' ? body.text.trim() : body.text;
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
      // The same words twice within seconds is one comment: answer with the
      // one already there instead of writing a twin.
      const dup = duplicateComment(priorList, { author, text: commentText, anchor, parent_id, at: created });
      if (dup) return json({ ...dup, duplicate_of: dup.id, mention_outcome: outcome });
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
      // The owner's own first comment, and the first person they tagged, are
      // steps on their journey. Never fail the post for a stamp.
      if (res.status === 200 && isDocOwner) {
        try {
          const accountId = await sessionAccountId(env, s);
          // Only a comment on the journey's own doc moves the journey; a
          // comment on any other doc of theirs says nothing about it.
          const journey = await loadOnboarding(env, accountId);
          // A reply counts. The seeded comment is a question -- "which claim
          // would you defend least?" -- and its Reply button is the most
          // obvious thing on the page, so the gesture the checklist asks for
          // is very often a reply and not a new thread. Excluding replies left
          // the doc's own corner row ticking while My docs stayed at 2 of 4
          // and row 4 stayed locked, with no way to reach it.
          if (!journey.first_doc || journey.first_doc === slug) await stampOnboardingFor(env, accountId, 'commented');
          if (mentions.length) await stampOnboardingFor(env, accountId, 'tagged');
        } catch {}
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

    // ---- Raft agent behavior manifest ----
    //
    // Raft fetches this to learn what tdoc is and how an agent signs in. It is
    // registered on the App, so it has to exist before Login with Raft works
    // at all — a registration pointing at a 404 is an App nothing can use.
    //
    // `actions` is deliberately empty. An action is invoked with the agent's
    // Raft-derived session, and every mutating endpoint tdoc has today is
    // authed with the upload token instead, so declaring one here would
    // advertise a call that cannot succeed. Linking an agent needs both
    // credentials and is driven from the agent's own machine, where the token
    // already is — it is not an action Raft brokers. Actions arrive with the
    // session-authed read/reply endpoints, which is what lets an agent with no
    // local tdoc token work at all.
    if (p === '/.well-known/raft-agent-manifest.json' && method === 'GET') {
      const origin = `${url.protocol}//${url.host}`;
      return json({
        schema: 'raft-agent-manifest.v0',
        name: 'tdoc',
        description: 'Prompt-native HTML documents. Comments on a doc are handed to the agent that follows it, so review feedback arrives instead of being polled for.',
        service: env.RAFT_CLIENT_ID || 'tdoc',
        app_origin: origin,
        execution: { mode: 'http_api', base_url: origin },
        auth: { type: 'login_with_raft' },
        actions: [],
      }, { headers: { 'Cache-Control': 'public, max-age=300' } });
    }

    // Bind an agent that signed in with Raft to THIS account, as a fallback
    // recipient for docs with nobody following them.
    //
    // This is the one place the two credentials meet, and it needs both: the
    // link code proves which agent signed in (the issuer said so), the upload
    // token proves whose account is being written to. Either alone is inert —
    // which is the whole reason an agent may sign in without a browser.
    if (p === '/api/notify/link' && method === 'POST') {
      const auth = await requireUploadAuth(req, env);
      if (!auth.ok) return auth.response;
      if (auth.actor.kind !== 'hosted' || !auth.actor.account_id) {
        return json({ error: 'account_token_required' }, { status: 403 });
      }
      let body = {};
      try { body = await req.json(); } catch {}
      // Either credential shape proves the SAME thing — which agent signed in
      // with Raft — and neither proves anything about an account. The upload
      // token checked above is what says which account, and it is required on
      // both paths, so the two-credential rule holds whichever is used.
      const code = typeof body.link_code === 'string' ? body.link_code : '';
      let pending = null;
      if (code) {
        try { pending = JSON.parse((await env.META.get(`raft-link:${code}`)) || 'null'); } catch {}
        if (!pending) return json({ error: 'link_code_invalid_or_expired' }, { status: 404 });
        // One use. A link code that survives its redemption is a bearer token
        // sitting in a log somewhere.
        await env.META.delete(`raft-link:${code}`);
      } else {
        pending = await getAgentSession(env, req);
        if (!pending) return json({ error: 'link_code_or_agent_session_required' }, { status: 400 });
      }
      const target = normalizeNotifyTarget(pending);
      if (!target) return json({ error: 'unsupported_target' }, { status: 400 });
      const existing = await accountNotifyTargets(env, auth.actor.account_id);
      const next = [
        { ...target, last_touched: new Date().toISOString() },
        ...existing.filter(t => !sameNotifyTarget(t, target)),
      ].slice(0, NOTIFY_AGENTS_MAX);
      await env.META.put(`account-notify:${auth.actor.account_id}`, JSON.stringify(next));
      return json({ ok: true, target, targets: next.length });
    }

    // ---- outbound notification: handoff to the doc's follow-up agent ----
    // Gated by authorizeOwnerMutation, which is the whole permission model:
    // driving an agent needs the doc owner's session or their upload token, so
    // a reader who can comment still cannot make somebody's agent do work.
    if (p === '/api/notify/targets' && method === 'GET') {
      const slug = url.searchParams.get('slug');
      if (!slug || !isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const gate = await authorizeOwnerMutation(req, env, slug);
      if (!gate.ok) return gate.response;
      return json(await resolveNotifyTargets(env, slug));
    }

    if (p === '/api/notify/handoffs' && method === 'GET') {
      const slug = url.searchParams.get('slug');
      if (!slug || !isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const gate = await authorizeOwnerMutation(req, env, slug);
      if (!gate.ok) return gate.response;
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), HANDOFF_MAX);
      return json({ handoffs: (await loadHandoffs(env, slug)).slice(0, limit) });
    }

    if (p === '/api/notify/handoff' && method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, comment_ids, instruction, recipient } = body;
      if (!slug || !isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const ids = Array.isArray(comment_ids) ? comment_ids.filter(x => typeof x === 'string') : [];
      if (!ids.length) return json({ error: 'comment_ids required' }, { status: 400 });
      const gate = await authorizeOwnerMutation(req, env, slug);
      if (!gate.ok) return gate.response;
      const resolved = await resolveNotifyTargets(env, slug);
      const target = recipient ? normalizeNotifyTarget(recipient) : resolved.default;
      // No recipient is a 200 with a failed delivery, not a 4xx: the handoff
      // is a real record either way, and the panel renders "not delivered"
      // the same for "nobody bound" as for "Raft was down".
      const rec = await dispatchHandoff(env, {
        slug, meta: gate.meta, commentIds: ids,
        instruction: typeof instruction === 'string' ? instruction.slice(0, 2000) : '',
        recipient: target, publicHost: env.PUBLIC_HOST,
      });
      return json({ ok: true, handoff_id: rec.handoff_id, sent: ids.length, delivery: rec.delivery });
    }

    if (p === '/api/notify/handoff/resend' && method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, handoff_id } = body;
      if (!slug || !isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const gate = await authorizeOwnerMutation(req, env, slug);
      if (!gate.ok) return gate.response;
      const prev = (await loadHandoffs(env, slug)).find(h => h && h.handoff_id === handoff_id);
      if (!prev) return json({ error: 'handoff_not_found' }, { status: 404 });
      // A resend reuses the original externalEventId, so a provider that did
      // receive the first attempt drops the duplicate instead of waking the
      // agent twice for the same batch.
      const event = handoffEvent({
        slug, docTitle: gate.meta && gate.meta.title, handoffId: prev.handoff_id,
        commentIds: prev.comment_ids, instruction: prev.instruction, publicHost: env.PUBLIC_HOST,
      });
      const target = normalizeNotifyTarget(prev.recipient);
      const delivery = target
        ? await NOTIFY_PROVIDERS[target.provider].send(env, target, event)
        : { status: 'failed', error: 'no_recipient' };
      const rec = await putHandoff(env, slug, {
        ...prev, delivery: { ...delivery, at: new Date().toISOString() },
      });
      return json({ ok: true, handoff_id: rec.handoff_id, sent: prev.comment_ids.length, delivery: rec.delivery });
    }

    // Called by the agent once it has applied a batch. Upload-token authed:
    // an agent resolving its own handoff is the owner writing through a tool,
    // the same reading /api/agent/reply already takes.
    // An agent saying "I have picked this up". Delivery only proves the event
    // reached an inbox; an agent may be asleep, busy, or start an hour later.
    // Without this, "it died" and "it is thinking" look identical to whoever is
    // waiting, and those call for opposite actions.
    if (p === '/api/notify/ack' && method === 'POST') {
      const auth = await requireUploadAuth(req, env);
      if (!auth.ok) return auth.response;
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, handoff_id } = body;
      if (!slug || !isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const writeGate = await requireDocWriteAccess(env, auth.actor, slug);
      if (!writeGate.ok) return writeGate.response;
      const prev = (await loadHandoffs(env, slug)).find(h => h && h.handoff_id === handoff_id);
      if (!prev) return json({ error: 'handoff_not_found' }, { status: 404 });
      // First ack wins. The useful fact is when work STARTED, not when an agent
      // last pinged, so a re-ack must not push the clock forward.
      if (prev.acked_at) {
        return json({ ok: true, handoff_id: prev.handoff_id, acked_at: prev.acked_at, already: true });
      }
      const rec = await putHandoff(env, slug, { ...prev, acked_at: new Date().toISOString() });
      return json({ ok: true, handoff_id: rec.handoff_id, acked_at: rec.acked_at, already: false });
    }

    if (p === '/api/notify/resolve' && method === 'POST') {
      const auth = await requireUploadAuth(req, env);
      if (!auth.ok) return auth.response;
      let body = {};
      try { body = await req.json(); } catch {}
      const { slug, handoff_id, comment_ids } = body;
      if (!slug || !isValidSlug(slug)) return json({ error: 'invalid_slug' }, { status: 400 });
      const writeGate = await requireDocWriteAccess(env, auth.actor, slug);
      if (!writeGate.ok) return writeGate.response;
      const prev = (await loadHandoffs(env, slug)).find(h => h && h.handoff_id === handoff_id);
      if (!prev) return json({ error: 'handoff_not_found' }, { status: 404 });
      const asked = Array.isArray(comment_ids) ? comment_ids.filter(x => typeof x === 'string') : null;
      // Resolving without a list means "all of them"; a list resolves only
      // what it names, so an agent can report partial progress honestly.
      const resolvedIds = asked && asked.length
        ? [...new Set([...(prev.resolved_ids || []), ...asked.filter(id => prev.comment_ids.includes(id))])]
        : [...prev.comment_ids];
      const rec = await putHandoff(env, slug, { ...prev, resolved_ids: resolvedIds });
      return json({ ok: true, handoff_id: rec.handoff_id, resolved: resolvedIds.length, of: prev.comment_ids.length });
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
      const { slug, parent_id, status: agentStatus, applied_in,
              bind_anchor_aid } = body;
      const replyText = typeof body.text === 'string' ? body.text.trim() : body.text;
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
      // Answering a comment is following the doc. This is the whole of the
      // "who gets the handoff" bookkeeping: nobody maintains a list, an agent
      // earns the seat by doing the work, and an agent that takes over from
      // one that went away becomes the default the first time it replies.
      // Silent by design — a Raft identity is optional and its absence must
      // not fail a reply that is otherwise fine.
      const replyingAgent = await getAgentSession(env, req);
      if (replyingAgent) { try { await touchDocAgent(env, slug, replyingAgent); } catch {} }
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
          const limit = await hostedMaxDocsFor(env, auth.actor.account_id);
          const used = await countHostedDocs(env, auth.actor.account_id);
          if (used >= limit) {
            return json(quotaDocsPayload(env, limit, used), { status: 403 });
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
            preview: docPreviewFromHtml(stampedHtml, {
              slug,
              version: verNum,
              title: (incoming && incoming.title) || (currentMeta && currentMeta.title) || slug,
            }),
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
        // Publishing a version is following the doc. Same bookkeeping as
        // answering a comment: the seat is earned by doing the work, so no
        // list has to be maintained and a successor becomes the default the
        // first time it publishes. After the commit point and swallowed on
        // failure — nobody's publish should fail over who gets notified.
        try {
          const publishingAgent = await getAgentSession(env, req);
          if (publishingAgent) await touchDocAgent(env, slug, publishingAgent);
        } catch (e) {
          console.error('[upload] notify-agent touch failed (non-fatal):', e.message || String(e));
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
        // Homepage replace: the release payload ships an empty thread, but
        // merge is add-only — old review comments would stick forever. Wipe
        // so tdoc.dev/ stays a product page with the static demo, not a live
        // collaborative doc.
        if (replace && slug === LANDING_SLUG && auth.actor && auth.actor.kind === 'admin') {
          const wiped = await mutateComments(env, slug, { kind: 'wipe', slug });
          if (!(wiped && wiped.body && wiped.body.ok !== false) && wiped.status && wiped.status >= 400) {
            console.error('[upload] landing comment wipe failed (non-fatal):', wiped.status, wiped.body);
          }
        }
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
        // The journey's two publish stamps. The first doc also gets its first
        // comment — from tdoc, signed as tdoc — so the margin is not empty
        // when the person arrives, and there is something for their agent to
        // answer even before they have written a word. Never fails the upload.
        try {
          const journey = await loadOnboarding(env, auth.actor.account_id);
          // tdoc's first comment on the journey's doc: something for their
          // agent to answer before they have written a word. Only for
          // somebody who came through the door — a CLI-first publisher never
          // asked to be onboarded, and a comment from tdoc on their first doc
          // would be an uninvited guest.
          const seedFirstComment = async (record) => {
            if (!(record && record.started && !record.seeded_comment)) return;
            const seeded = await mutateComments(env, slug, {
              kind: 'create', slug, id: `c_${Date.now()}_${rand(4)}`, author: SEED_COMMENT_AUTHOR,
              text: SEED_COMMENT_TEXT, mentions: [], anchor: seedCommentAnchor(doc), version: verNum,
              at: new Date().toISOString(),
            });
            if (seeded.status === 200) await stampOnboardingFor(env, auth.actor.account_id, 'seeded_comment');
          };
          if (verNum === 1 && isFirstDocProduct(body.meta) && journey.started && !journey.shared && journey.first_doc !== slug) {
            // The doc FIRST-DOC.md produced is the journey's doc, whichever
            // slug it landed on. A re-run — a taken slug, a second machine —
            // re-points the journey at the doc that exists instead of leaving
            // it watching an older one forever.
            await seedFirstComment(await adoptFirstDocFor(env, auth.actor.account_id, slug));
          } else if (firstHostedPublish || (journey.started && !journey.first_doc)) {
            // The journey's doc is the first one published after it started.
            // Keying only on "this account's first doc ever" left anybody who
            // had published before they onboarded with a row that could never
            // tick: their first publish is long past, and nothing else stamps.
            await seedFirstComment(await stampOnboardingFor(env, auth.actor.account_id, 'published_first', { first_doc: slug }));
          } else if (verNum >= 2 && journey.first_doc === slug) {
            // Only the journey's own doc reaching v2 is the loop closing.
            await stampOnboardingFor(env, auth.actor.account_id, 'revised');
          }
        } catch (e) {
          console.error('[onboarding] publish stamp failed (non-fatal):', e && e.message ? e.message : String(e));
        }
      }
      return json({ ok: true, url: `/d/${slug}/v/${verNum}`, size: verify.size, aids: aids.length, sha: uploadSha, mergedComments: mergedLocal });
    }

    // ---- admin access mutation ----
    // Remote storage is the source of truth: access policy must be mutable
    // without a local meta.json or full document re-upload. Authorized by
    // authorizeOwnerMutation: the owner's session (browser, doc-page Share
    // panel / /me) OR the upload token (CLI) — see its doc comment for why
    // the session path is safe (CSP blocks author scripts on every response).
    // The other half of the 403 page: a signed-in visitor who is not on the
    // allowlist can ask, and the ask lands in the owner's inbox as a
    // notification. Session-only (an ask is attributable or it is spam),
    // deduped per doc+asker so a double-click is one row, and it answers the
    // same shape whether it delivered or was deduplicated — the visitor's
    // side of the story is "the owner has been notified" either way.
    if (p === '/api/doc/request-access' && method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}
      const slug = body && body.slug;
      if (!slug || !isValidSlug(slug)) return json({ error: 'slug required' }, { status: 400 });
      const session = await getSession(env, req);
      if (!sessionPrincipal(session)) return json({ error: 'sign_in_required' }, { status: 401 });
      const meta = await loadDocMeta(env, slug);
      if (!meta) return json({ error: 'not_found' }, { status: 404 });
      if (canReadDoc(accessFromMeta(meta), session, env, meta)) {
        return json({ ok: true, already: true });
      }
      const asker = actorKey(session);
      const dedupeKey = `access-req:${slug}:${asker}`;
      if (await env.META.get(dedupeKey)) return json({ ok: true, requested: true });
      const owner = ownerActorKey(meta, env);
      if (owner && owner !== asker) {
        const { key, inbox } = await loadInbox(env, owner);
        if (key) {
          const next = applyInboxEvent(inbox, {
            id: `n_${Date.now()}_${rand(4)}`,
            kind: 'access_request',
            slug,
            at: new Date().toISOString(),
            actor: { login: asker, name: actorDisplayName(session) },
          });
          await env.META.put(key, JSON.stringify(next));
        }
      }
      await env.META.put(dedupeKey, '1', { expirationTtl: 7 * 24 * 60 * 60 });
      return json({ ok: true, requested: true });
    }

    // Opt-out for invitation emails. The token is a single-use KV pointer
    // written at send time — possession of the emailed link IS the proof, so
    // nobody can unsubscribe an address whose mail they cannot read.
    if (p === '/email/optout' && method === 'GET') {
      const t = String(url.searchParams.get('t') || '');
      let done = false;
      if (/^[a-f0-9]{16,64}$/.test(t)) {
        const addr = await env.META.get(`email-optout-token:${t}`);
        if (addr) {
          await env.META.put(`email-optout:${addr}`, JSON.stringify({ at: new Date().toISOString() }));
          await env.META.delete(`email-optout-token:${t}`);
          done = true;
        }
      }
      return statusPageResponse({
        docTitle: 'tdoc - email preferences',
        title: done ? 'You are unsubscribed' : 'This link has expired',
        message: done
          ? 'This address will not receive invitation emails from this site again.'
          : 'The unsubscribe link is single-use and time-limited. If you still receive unwanted email, reply to it and the operator will remove you.',
        error: !done,
      });
    }

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
      const prevAllowed = accessFromMeta(meta).allowed_users;
      const next = applyAccessPatch(meta, access);
      if (next.error) {
        return json({ error: next.error, ...(next.field ? { field: next.field } : {}), ...(next.fields ? { fields: next.fields } : {}) }, { status: 400 });
      }
      await env.META.put(`meta:${slug}`, JSON.stringify(next.meta));
      // The one moment an invitation exists as an event rather than a list
      // entry: mail the people the owner just added, never the ones who were
      // already there.
      const added = (next.access.allowed_users || []).filter((x) => !prevAllowed.includes(x));
      let emailed = [];
      if (added.length) {
        const inviterName = auth.session ? actorDisplayName(auth.session)
          : ((auth.actor && (auth.actor.github_login || (auth.actor.email || '').split('@')[0])) || 'Someone');
        const inviterId = auth.session ? actorKey(auth.session)
          : ((auth.actor && (auth.actor.account_id || auth.actor.kind)) || 'unknown');
        try {
          emailed = await sendInviteEmails(env, {
            added, inviterName, inviterId, slug,
            title: (next.meta && next.meta.title) || slug,
            origin: url.origin,
          });
        } catch {}
      }
      // The Share panel tells the owner what actually went out — "saved"
      // and "they were told" are different promises.
      return json({ ok: true, slug, access: next.access, emailed });
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
      const released = await deleteDocEverywhere(env, slug);
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
