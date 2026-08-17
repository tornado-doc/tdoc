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
// IMPORTANT: This file contains placeholder strings `__TDOC_OVERLAY_JS__` and
// `__TDOC_BUILD_INFO__`. The publish script replaces them before deploy,
// producing worker/_worker.bundled.js. Do not deploy worker.js directly — the
// overlay/provenance would be missing.

const OVERLAY_JS = `__TDOC_OVERLAY_JS__`;


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
    overlay_sha: b.overlay_sha || null,
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
// The worker owner = the GitHub login configured in TDOC_OWNER at deploy.
// Only that signed-in viewer may see the catalog of hosted docs. Case-
// insensitive; if TDOC_OWNER is unset, nobody is owner (catalog stays
// fully private — safe default).
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
function canMutate(record, session, env) {
  if (isOwnerSession(env, session)) return true;
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

function isAllowlisted(access, session, env) {
  if (isOwnerSession(env, session)) return true;
  const login = sessionLogin(session);
  if (!login) return false;
  return (access.allowed_users || []).includes(login);
}

function canReadDoc(access, session, env) {
  if (access.visibility === 'public' || access.visibility === 'unlisted') return true;
  return isAllowlisted(access, session, env);
}

function canSeeHistory(access, session, env) {
  if (access.history_visibility === 'public') return true;
  if (access.history_visibility === 'invited') return isAllowlisted(access, session, env);
  // owner — TDOC_OWNER only (not every allowlisted reviewer)
  return isOwnerSession(env, session);
}

function canCommentOnDoc(access, session, env) {
  if (access.commenting === 'off') return false;
  if (!sessionLogin(session)) return false;
  if (access.commenting === 'signed_in') return true;
  if (access.commenting === 'owner') return isOwnerSession(env, session);
  if (access.commenting === 'invited') return isAllowlisted(access, session, env);
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

async function enforceDocAccess(env, req, slug, version) {
  const meta = await loadDocMeta(env, slug);
  // No meta yet (orphan R2 object) — treat as public so legacy uploads still work.
  const access = accessFromMeta(meta || {});
  const session = await getSession(env, req);
  if (canReadDoc(access, session, env)) {
    return { ok: true, access, session, meta };
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
const TDOC_LOGO_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAeGVYSWZNTQAqAAAACAAEARoABQAAAAEAAAA+ARsABQAAAAEAAABGASgAAwAAAAEAAgAAh2kABAAAAAEAAABOAAAAAAAAAEgAAAABAAAASAAAAAEAA6ABAAMAAAABAAEAAKACAAQAAAABAAABAKADAAQAAAABAAABAAAAAABUZS5+AAAACXBIWXMAAAsTAAALEwEAmpwYAAABWWlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNi4wLjAiPgogICA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPgogICAgICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgICAgICAgICB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iPgogICAgICAgICA8eG1wOkNyZWF0b3JUb29sPkZpZ21hPC94bXA6Q3JlYXRvclRvb2w+CiAgICAgIDwvcmRmOkRlc2NyaXB0aW9uPgogICA8L3JkZjpSREY+CjwveDp4bXBtZXRhPgoE/1zIAAAmzUlEQVR4Ae2dB7xlNbXGA6JixYIVFBTFNsLYFREEUeyiiAq2AREFFBtWlEFEimIXFUYURVHEQreMOjBiB0Xsoij23nvLW//1Xvbb59x9+sk5OXd/+f3O3fvukmR/Sb4kK2utbBAtBAUhIARaicCGrfxqfbQQEAKOgAhAFUEItBgBEUCLC1+fLgREAKoDQqDFCIgAWlz4+nQhIAJQHRACLUZABNDiwtenCwERgOqAEGgxAiKAFhe+Pl0IiABUB4RAixEQAbS48PXpQkAEoDogBFqMgAigxYWvTxcCIgDVASHQYgREAC0ufH26EBABqA4IgRYjIAJoceHr04WACEB1QAi0GAERQIsLX58uBEQAqgNCoMUIiABaXPj6dCEgAlAdEAItRkAE0OLC16cLARGA6oAQaDECIoAWF74+XQiIAFQHhECLERABtLjw9elCQASgOiAEWoyACKDFha9PFwIiANUBIdBiBEQALS58fboQEAGoDgiBFiMgAmhx4evThYAIQHVACLQYARFAiwtfny4ERACqA0KgxQiIAFpc+Pp0ISACUB0QAi1GQATQ4sLXpwsBEYDqgBBoMQIigBYXvj5dCIgAVAeEQIsREAG0uPD16UJABKA6IARajIAIoMWFr08XAiIA1QEh0GIERAAtLnx9uhAQAagOCIEWIyACaHHh69OFgAhAdUAItBgBEUCLC1+fLgREAKoDQqDFCIgAWlz4+nQhIAJQHRACLUZABNDiwtenCwERgOqAEGgxAiKAFhe+Pl0IiABUB4RAixEQAbS48PXpQkAEoDogBFqMgAigxYWvTxcCIgDVASHQYgREAC0ufH26EBABqA4IgRYjIAJoceHr04WACEB1QAi0GAERQIsLX58uBEQAqgNCoMUIiABaXPj6dCEgAlAdEAItRkAE0OLC16cLARGA6oAQaDECIoAWF74+XQiIAFQHhECLERABtLjw9elCQASgOiAEWozARi3+9r6f/q9//Sv85z//CRtttJH/+j6sm0JgQREQAfxfwX3nO98JF1xwQbjooovC17/+9fCnP/0p/Pvf/w5XvOIVw6abbhrucIc7hO222y5sv/324drXvvaCFreyLQQ6EdggWui81J7//vGPf4Szzz47vOMd7wjr168Pf/jDHwZ+/K1udavwuMc9Luy7777hhje84cDn9YAQKBmB1hLAhz/84XDUUUeFT33qU43lc41rXCNc6UpX8mkAowGmA/Ww1VZbhZe+9KXhsY99bP2yzoXAQiGwrAngz3/+sw/nf/jDH4Zf/epXPqRn+P7pT386nHjiif5/Kq2rXe1q4W53u1vYZZddwooVK8KWW24Zrn71qwdGCT/96U/DN77xjXDOOeeE888/P/ztb3/z1zbYYIPw9Kc/PRx99NHhKle5SopKRyGwOAgwBVhu4cc//nFcvXp1tIYcbQ7PFKfn7zrXuU58xjOeEb/85S/H//73vwOh+NznPhcf+chHdsS3xx57xN///vcD39UDQqA0BEJpGZo0P2eddVa04XlHA+1FAI9+9KPj1772tbGSNLlBvP71r1+l85CHPCT+8Y9/HCsuvSQE5oXAspoCvPe97w1PetKTwl//+lcfgm244YYuvb/HPe7hAjsk+r/73e98OnD3u9/dn2UYP274/Oc/H/baa69w2WWXeRSrVq0Ka9as0bLhuIDqvdkjMC/mmXa6X/ziF+O1rnWtqkfeZptt4plnnhmNDKadVEd8l1xySceI45hjjum4r3+EQMkILJsRwAMe8IDwkY98xBmU9fr3v//94UY3utFMGPULX/hCeOhDHxp+8YtfuOCQfNzznvecSdpKRAhMgsDCEQBS+Z/85CcByT7S+R/96EcuoX/3u9/tS3XXve51w7p168Ltb3/7SXAZ+d1TTz3V9QNQHqLxr127VisDI6OoF2aNQPEEgErut771LdfSY8598cUXe8NnWa8pPPWpTw1vfvObq1us359++unhe9/7XmCUkJMYSPv444/3tJEFoCykIASKRqDU+cn3v//9eOyxx8Z73ete0dboq7m9gdl4foUrXCGaZl5kma4eXvGKV1TP3/jGN46m5lu/PdVzlh9vetObenpGNNE0C6cavyITAtNGoDhbAObRr3rVq8LJJ58cfv7zny8hTxR5mNvf9ra3DTe/+c3DTW5yk7DFFlsEW5JzST/nKRhY4QMf+ED610cOH//4x/3d6uIUTzbbbLNw0EEHhYMPPjh89atfdcWhPffcc4opKCohMGUEps0ok8Rnw3tX3rFPrHptzlHoseF1tHl2/Pa3vx1Nw2/oZPbZZ58qLlsWjDY3H/rdcR40AotGQp7m/e9//2hTkHGi0TtCYCYIFKMIdPnll0cztKkaKxp8aNyde+65Ew2lbRQR999//7jzzjtHm5fPpEE+97nP9e8wVeJoKsQzKUglIgTGQaAIAjDJeUQrL/X8W2+9dTRjnXG+p+c7s+yJkUNc+cpX9u+RXkDPItGNAhAowiMQS2as2xNMUOfzdhs++//T+oNW4KwCvgNWrlzpyZ1xxhmBlQwFIVAiArNrFT2+3gxwwute97rK3PYlL3mJW+P1eHwhLmNGjGIQwYyMXCC4EBlXJluHwNwJ4Etf+lI477zzHHjW6HG2sRyCGQcFTIwxHTaV5OXwSfqGZYjA3AngQx/6UPj73//u0OJcAxv85RBuc5vbBAyOCKeccoobIZX8XYzEUJpCk5Ef5zZFLTnLytsUEJirHgC940c/+lH/DBo+veZyCTgTfcITnhA+8YlPhEsvvTS86U1vCocccsjMPo8GbT4Kgpkou3/DX/7yl+FnP/tZ4IijFK7jAo1zPB5RFokAyCSWkxtvvHHAM5IZWYXrXe96fkTfAjkNuhjc22STTcI1r3nNMEsZy8xAbEFCc1UFRlkGLzxUvh122MEbCw1nuQQalmkyhq985Ss+ssFeIckGJv1GemlGTqhEmwaiN2zsIzBNxkbiN7/5jStS0eDB95///GeAFKYRMKG2VQ6f4kAIN7jBDZwcIArO8ZXIdaZAeEqC3NOP/3kXgjHtTScOyIM405HzScy0p/GNbYljrq3ts5/9rFdOwIYAcjR+GgD+AejNqJyzrFj0kEcccUR4xCMe4T0t8g2EnHvvvbd7Gh5Uyeid8V9AT47Rk6lHey+eGjrfxj2egRBGCeBAY0RgSYME+9QgiYfhP3FCHBhggWFKg3uQDz+I5pvf/GbfpNNogjLgPP1IM52Tj5QX8sE5eeRI4Jxne5UfeSI+fhAJzxJSPFzn3fSNPJMIh3spbfIIHhzBJ41w+L/+DITGtUUPcx0BmIJOeMtb3uIFY558woMe9KCp4nnCCSe440+GuhSY6Rd4Y3ziE5/ovdNUE+sT2cte9rJw6KGHVk/c4ha3CHe6050CR6wXqYj00jR4GhS9OkN0GjjDds6TnKSKpMcJcVExIR96YkiPNBiyo6qchu7gwTNXvepV/ZdIIDUKRgs0fvL1l7/8pZpKcP7rX//arTEhJciH/8k3ZJRGGyx9LgcZAnhAEBAHpAIpgBsq6eZOzqc/qKPf8pa39KkR51uaP0mmRbxTepgbAdCbYDaLLT3zS44AN61ABbzrXe/q1oPdcd773vcOJ510ktsQdN/L8T8N4bWvfa17ER7G9figPFCx2KuASkgjh0ioeDTwm93sZlUjp/eisuYOjBAgL0YJicggBciB74XAEpHwDCSSfvzP+/woM+oF5MMP3OrH7u9II5Lu693/J4EmI4AUN8+kc47EVf91xzHs/0x7mP5gk3LnO9/ZiZ4jXqR7jV6GjTvHc3MjACoMvSAbcsCemPnSG40bqDyvf/3rw3e/+93wmMc8xhsCUnh6UBoBikWkxXycAAkw6qAnnFVAJ4A84jCEXp6K2RTSsJjKRI+N0I1KBU6MYrhmVodOnPT29FKLGlIjrDf2dM43pfscu8OwowyeS4G4E3GAf/ox2uG5dOScHyMvZDkQWSI0jox2fvvb33o5UpY8A4k1BWQjd7zjHd0cHRkQZVhKmBsBANZd7nIXV5KhN7vwwgsn6pGx8rvvfe/ruNKAaCyQAQWKhyBcgVNIppobjjzySO9djjvuuHDAAQfMvCxwaMLKgNk/eO9IhaQhM7xk6EivzvASAqDyzKIXnzkIyyBByo2OjHrFFAifEwhhzWDNOxqmSFi31gPlymqXeaJ2f5X1e3M5N0acW3jKU55S6f9jtWdADpWXd77znXGnnXaK1pArd9yHH354FZcB2XFuvvureK0niQ972MP8vo0QohFEdU8nQmBaCFCvMHDDS7WZh0ebBnS4qDeij7axTLSp0bSSHCseesK5Bcx/rYerGisgPetZz4rm3bfKk+3XFw877LDKqs4YN9qct3rH9O6jKRNF8/bj12x+7A3cRgD+v827ounjV/Fx8ra3vc3v4bzDBG0d9/SPEMiBgMk6InXZRpwd7uRf/OIXD7UfRY48EedcCYAMvOc974kmzKoadOq93/rWt7pHXywDuWaCwmg78ETTqos25+14nkZuSzR+jY0+8MxjQqj4rne9K37wgx+MNmeLeO/lxwYgNlXwZ20KEm0qQjYUhMBMEDCZg48KNt98c6+DJhuIJmuYSdpNicydAMiU2QNE8+cfb33rW0d6cBq8LV9FWzOv/k/EYPNivw8J7LffftE8A/n/6b7t3tsxrId5d9xxx2jCvsiwi2N61pYgmzDRNSEwNQRMCB3Nl2U0P5Xu1IYGbwLdqhMz71dTS2uciIoggJRxhvfMi1IDTUcTEsb73Oc+0dZjq3vs/mNLST6Ef8ELXuCjCEYCr371q1N0fuwlG3j84x+v3r8DKf0zCQJ0NMz5TRgdTf/Eh/rUWaaZ9Xqb6rQt0Toh8N48w9xWAQyIxsDSC8t4NnSv7h944IFuMsxOvij3oDPwvOc9L9gIoHrGnH26u3Ak7GzkyXILUvRdd93VFVVY9kPbkPjRO+Bd7isIgVEQsAbrkn2W/ljJQeKP9N+2mKtUr5viSzoa7FLFkiC6AehvzDsURwAAQiM2F16+bo/yBA2/vtEG67AowXQHTItZ8mOJkaVAnkGbjgaP2jHKGApCYBAC1B8UlVjCY1mP+oi6Mw0eOwtUsdEDaNLjQGuQpVsc1tqU1hs6Zu4sS7O8W5p24FxtAXoVBGxpknr3sEvDR6OvHlLjp9c3QZ83enQA2KabwiPQ09P4CbayoMbvSOhPQoDGi7YiPxo6SmLYWrB2T0On7tDI0WLsFehYktYfjZwO5na3u50raaHbsgi2AkWOABLgKPFggNErYFyDhR2jBKwK0fJDcwu/AhTmRRdd5Db5uOVCwUahXQjQyFHUoYFTH7CaRDmMxo7LeXpz7qGm3CskZSzU1NG+pGfHJX1SvUYrEwWuRQ1FjgASmP0aP8+ggUUwIUowR5x+jj8+W0L0c3YUotB6NX5GCWgg4o8QVVPs93lfYbEQoPzpsVH7pqEjA6Inp6GjbYnKLr15r4AKOj05vTY6/OadurKrwLaCESe/QfWxV/wlXy+aAIYFjoJhtEBguI9lG2Hbbbf1Y/cfKsbZZ5/tzkdtV2GfLvAMxLHbbrsFrBSRJSiUhwBTPBo7c3J6c0Z5HGnoEECqB905x+aDRkwDtzV4/9HQ+Z/Gj70F95nDtykUPQXoVxDo/u+xxx7O7KwIIHhhzmVqv42FyFAP7zz09uedd54bdtTjx6AmGZxAIA984APdTgBh5CjGNgw7SxP01L9z0c7puWngEDVTPAyq6OWRwjcF5uUI25AjMVRn6M6wnfk5ZtFYSC7HnrwJi2GuLSQBMM+3Ndbwmc98xpnc9hBo9CTMkg3Sfxo9Fng/+MEPOjBh7obFoO1J4JUFecL73ve+ihxoyFgR4s6LqcSgsH79enf7xRIPAsk0Ehn0nu7/PwJI3+ndKbfzzz/fl9dYZksWfOlJhu34OsD3IstpjPaSWTTz8kUQwKVvmetxnkoI46ZtPUI0Czk3rsDYojtYT+EKRdgJdKsNG9iuPfiiF70oWq8SrWJ1vG6Vz403bEhYKR0ZAXQ80/TPxz72sWg9jL9jPUy0Stv0mK41IGBD+mhTMleeYVNVa7wV9pQXPxuq++5OKH2h4m3u5FzduyE6XRoBgYWd8Ng3+lA7CfiQ8NLLn3baaW76S09SDwwL73e/+4VHPepR7qcvvVd/hnPWbl/5ylcGtvpGmQiBEktF/QI91qpVq9wklFGDbQ3mUuJ+77T9HgJc9DvYvHXdunU+rK9jwhCe5V9WdxilUS70+ApTRmAEsijmUUwoTT/AewZbjnHrP6swS3oNGybGXXbZJR5//PHRlDdGzv+DH/xgj5O9BXsF1JFNy9CfY7Qxb93uXvkc97rtaRAx22ZUNY3ACMvcoy2x4WDUZA5i4gtf+ELfFo49HRXyI1CULcAon2vuxDsMe4wXvRFiD8AwEkMijIyw/x83mJ6Bx2krAz2jMKci/gzpY5y0nIJ5wak2bIUMJwkmH4mmn9Fh/m2jpYhFpvlM9OmYyXYmSULvjoHAwk4BGM6j4MNwnSE4yzcMF1EOwhX3NFx9sSxEYB25KaCSjIsvAgIonH8up8DqRxKmIYnHLRZS9FECglG2fmPZNS3RseTGcivCV7xCLbIizShYFPnsGKRR3CsMF7H/n1YwPQG3KsTi0AotYsJp689LordVg6r3N6efS+4vhwvmvsq/ERNWW34b+pPAEBNvWwmpMMJ0G2tNrOYUykBgYUcAdTadhnCIZSaT5LsNwic/+clqKZB06P3QKtxmm22qZK34wumnn+7/I2Dcfffdq3vL6SQJSxGq9lOZTd8Mjrh6f/nLX+7qtlxHPx79DHp89DUUCkKgDB6aby5s9cD9DSA/sKKpflb5KzkD8oB6MEWUiACS523jj/qtLOcIG9esWRPPOeecLPH3itRWN/wbWZpj6a1fMCOayt8iuDBqMCKI5jCz32u6N0cEFlYIOA3MWBkw/f8lDhtMuSSuXr06mrWhO3egMiOwOvHEE6tkzfagckPW7YSkemiKJ3gvIh80RASgswq2iYqna/P0aDbvPZPFEYZp3Pmz5PPhD394ROKvUDYCrSUAFHeS41AqLD8Uh3AYig/BFFAUMn0Av487MnwSEurz/26no+ndaR5N27EiKtNhj2bJNs3oe8Zlzln8200gGpnXNwUUpVDMAkOcvLIy0q1g1fSers0fgVYSgKn7VhWWSstQlfV7s/1eUiIIvkzSX/kmZL362GOP9ed5l54Rn2/dAV0Flr6mNfxlOROPyaTJjyU1szvoTnaq/5Nm8raME0ucrdYDbtyf9rSnVXmCmEy5p/6IzgtHoHUEYBuERPyxpYZkVn/uLbheTmZKGt/whje492AzLondsgHeNcGfx0FcTBW6A1MI3jPhYIeT0u7nRvmfdXlzKeXpEje+53IGCHHFihWe3sqVK91Lc0oPdWx83iUczXgqmq1Fuq3jgiDQKgJAkMZmIKnSoiWIMC8Femv2IOilVcgct/seBGDqwimK6pi0AxEU0nCnFVBuwvU534CzVFyd5wrmCsvdsZMWWKXA9CktkaL9aKrPHeSQntOxfARaRQAnn3xy1fjN0UOkp08BoR7r/Ykc6GHp9Z797Gf7xiM0NMgCIx/bxbh6DnVjjIrqgQaf5Auot05bww0X0ymf5ug04k05RzBry0rQaVtZeRJMh5CFkD7GT+zSpLC4CLSGAMz7T8eQlUaUAj0aQ/3UqMwHgG/e0Kth0aD33Xdffx4ZgHkpTlH5ERlDskKsb0vW8dAE/yBgQwaQ8otlY46AcI80IEOmRJBAShNybJJ95MiH4syHQGsIwBR5qrm/qe1Wkn6zO6+2aqIxm2pxo9ZfdxFgIERjYAOTukQe0kC/nXvmmTibUIw02UiFdNC2Y5Vg2iHZQrAEmnayIT2zqIwy1pk22vOJrzUEYGanVe/15Cc/2dFGkJXmsgxr2aZsmMD2Yix30RjYaLS+5FXf2MQ8FmWV1LP2DmmRD6YczNmnFcz+ocKG+PmxAoLhDqMpheWBQGsIoD7/x1LQNnSoBIIM14eVqOO8woyOvEHQw69du7aqCWxSmhokU4qm1YHq4Smd1Alnzz337CCjSZI499xzq2kMjR/hJ/ssKiwvBFpDAOYHsKrQrPsjQU89GzbowwTzTxdZ7krv1ef3aMkRb+opURSaRUDfIPktIO26bGOS9Bklpe9klMQUSmH5IdAaAqChmH+/qlJTuZk742JqmCEtjT9ZxvEuCjJJcYjlw/ryIqMAM4GduvS/V/Uzn4fV3vPYL9S3V+/1zqDrSQOQb2W6g1MVheWHQGsIgKJDcMWyHlJ+nHcMq7XGsl698bO9eNIfgDzqEvnUa3IkHXN3la3WsCR50EEHVXoBKW3m6kcdddRE8gfi3mmnnSrCZJqEBqTC8kKgVQQwTtHRwDEYSo3LHJF0+B6oz8HT0l96liOjDN5HcDitgBwCYZx5v63yxaiDdMxkubqGIc8kqsiMethFOX2PSGBaJVhOPCKAAWXBykBqAGjD1R2PnHrqqdXQG6UYDIlYFkzP148Yy+y9995LdAYGJN9xmyVGrALRuU9xs0bP6AQVZwIWjpBUuo/AEu3BcYN58emwQWBJcFiB6bhp6r3ZISAC6IM1y3tpGMwyW11zEOWfJEikUbz97W/3mOiZU+Oj90c2wDFdQ3MQ60LII00j+mTBb5EPljHT6kOKC7sAc0qyZKiPkQ5TA8iBZ1mRSPkblFbTfYyOUPdN6fIN5Edh8REQAfQpQ9bCURqi4h944IHVk1jFJSMZ7j3/+c+v7iEYTALB1DvjxIPVA4giNSKOqCMzKmDF4OKLL3abAaYcNDiOyCxYeqv36LzHCIBe2DY+qdJtOrGtzqq9CngP7UXbIanp0YHXyFPd8g97BFSFFRYbARFAn/Jj+Jt6XTwNp+F/0pCjUaEIxApDPdh+dR2Cuec85zm+Po/ijrnFqpSIeD/9UETaeuutXYvQnJpG210o2m5E1X2eYyRx+OGHDz1yIE/YKZh//Soec8/las71/A57jl9EdA1Snskv5tIKi4uACGBA2bGclyr8Xnvt5cYvaUiP5yDbkLIxBhSP6j0+ykcp4CnHtg6LNHTzXlzFn9LpdTTPxz5aSPEMe2Qkgx4/7xM3xwMOOKBn3vvFi7OUZOlIXJgEM+VQWEwERAADyg3B24477tjYSAepDrMUV2/MjATqloEM89EWZH7OnH3XXXf1DTOYGtimli7RZ7SBIU6yLsQPAVqM4wQ0FSGtlCdsCdAZGNWxCL1+mhoRF95/R41jnPzrnekjIAIYAlNsBhiSp4bDES3Aug1Ar2hYJkzCON5DFtDLtx6NCJ8FLL/xq8/xUfZJIwqmHZDHOAG5AnN5dAXS9yCUvPDCC0eKDs1KlI5SHHgrYsqksFgIiACGLC/m/695zWt8SQwJ/ig9Hj14fajPkuFq8xjEev4oYZ999vEGB6GcdNJJo7y65FmsB5PVIo2YxoyS1ChzevKQphXEgXfkcUcnSzKoCzNBQAQwE5hjXGcagXWHIzQYpPl4Gq5PC/plB2u/5HkXAeGkLrhYsUC7r74TMucsZQ5r7osvxTQy4Zuwh8A/AS7ERyHJft+te/kQEAHkw3ZJzAzrjzzyyMqfIA2GHyrDwy6psTV2eo/lxklJgEwyxbHdkDtGKRANeR3GxBgFqOSmLOWNEQUCQuQg+Fyoe1peAowuzA0BEcAcoKfBIYVPrrVoNEwRDjnkkIENhbk/PvdTQ2MYP0wjHeYzkQNg15BWOUhjiy228HwN8vGPtiFWiU3q0JhNI3BEl2JUWcMw+dYz4yMgAhgfu4nfRH237lmXBoewcZCRErID5tuJBLBMrAsMJ83YBRdc4Ov9aPylNNgXAKUl8tZrx2WEosgWWC6tTytSHBwhOuQf4woxJ/02vd+JgAigE4+Z/8f8/41vfGOHDQF2A+gJNG1ImjLIakF9JMAWXNMOKBHhFwChZWrE9OaYVaMKTB56BbQlUVNmeRPHqLyX4uB4xBFH9HpV12eIgAhghmD3Swp9gLpjDxoJDbx7M456HNgSsJsRz9JDN7knrz8/7jk7Ah166KEda/+kyWgFPwHJL0Kv+BmdMNphBJFWDZARzMJjUq886fr/IiACKKgmsI5+zDHHdAjj2FKbIXmvYDsZ+36BNEjkCjkDS6EoLWEgVZf808MPu18hKwTklR9algrzRUAEMF/8G1NnybCusYeEvZ/WIfYFNCj8A9Q9FDdGPoWLzPXJI16DkkIR8oJhfAay/0IaBWDXoDBfBEQA88W/Z+rY9de9ENHQeu1CzPbmqVH1I4qeiU1wgxEIBkYQ0LbbbttXLkAyZ555ZqUZWd9teYIs6NUJENjQCk6hQARsS7FgGofBVI49dzY9CGZLEGzrsmAKNh05Nn2AYIpBfs0sETvu5f7HpgPBzJU9GZsiBLOM7JukrRLQ6QRbAg1madn3Wd3Mj4AIID/GY6dgbr6CbcUVTJkmcE7DMduCYIK3jjhNoBbMXNmv2Xp9x71Z/GOjFU+GPJoOQc8kTaAZbGXA75szk2CakD2f1Y3ZICACmA3OE6VinovDqlWrqjhMs64658RsAwIjBoL5AAy2Tu/ns/hjy5jBVgk8KfIACfQKp5xySjDzab/N99i0pdejuj4jBEQAMwJ6kmRo0GakU0Vhvgmr83Ri6+zpdKZH02oMpo7saZosINjqQGP6ENOaNWv8nskKglkgNj6ni7NFQAQwW7zHSs1cdAeTnvu75t8vmEOOJfGYUo5fMx/+wdRxl9zPdcHW94M5BPHozfNQz2RsF+EAWRBMOSiYslPPZ3VjdgjMrqbM7puWXUpmex/MkMi/qy7wSx+KUPCyyy7zf81RR7qc/cjI5IwzzvB0aNDkrSnQ+9tOw36L3t/2TGx6TNfmgIAIYA6gj5qk7dNXvWIORXzOX12wE3P5FZLwz/YFqN/Kem6OTYLZBngaCPXMgrAxvXrv/8xnPlO9fyNK87koApgP7kOnapZ+IQn9Ntlkk2DGQ0ve5T7CNTO0Cdttt92S+7kusBphLtM8enr1pvl/vfc3jUH1/rkKY8x4RQBjAjer10wNOJgrb0+OOXZTL8vaOsNx7s9qac3Mf4P5JvB8oYNgSkuNkCD5T3N/cxvm6/+ND+riXBAQAcwF9uETNS2/6mEz+13Sy5rFYDAbe39mhx12mMnSmu2VGGjMZgTk6ZozkWA7IlX5TCcIB5Pkf+XKlWG33XZLt3QsBAEtxBZSEN3ZMH37sH79+pAIAM25puW/Sy+9NJgVoEv+t99+++5opvq/7YwUbEekcNxxx3neiJyGvf/++zems3bt2oCcgGCbkqj3b0RpzhcnUCPWq5kQOOuss9xNWNLvtyoS2QasyYkG9gHc32qrrSL+/3ME0sU9WH0zUtLESCntSdidrk1JKn8Fm2222UyMlLrzoP8HIyBjoMEYzeyJyy+/3F1ydbvVwhCITUG7A+bD1us7AeDTL0eg8VsP72nQ6NOPvQswQuoV8CFgOgn+PE5FFMpEQARQSLlgXps2/0iNjJ7z4IMP9l62ycMufgIgB0YKWOXlCPWdkcgXuwLh6BNrxX4BwuJ5XJizN6JCmQiIAAooF+zoU29Jo8Epp62XR0YE/QIednie6cGwrsX7xdd9Dx//yR0YoxKclTRNQ7rf4//dd9/d84ZT0VH3P2iKT9fyICACyIPr0LHiRBMfgDRkfrjjNsWfge+zuxButXgHt9w5Ah6GUr7222+/oZPAcxDfwbvsYqRQLgIigDmWjUnw4+abb141Mlx8c22YkOblOOOwZblhXhnpGXYIMrsDz5tZ+Y0kxLvkkksq1+Lmv2CkdPXwbBHQMqB1U/MKJsEP2MgTbKvtcMIJJwTbWcdVe3vlCdNfc6ZZKeGYr/2AP4BpB1uJCOZ01KNFy89cfvXNV0qf/OGUBP0EwqwUk1L6Oo6GgAhgNLym+nRypEGkthVXMF//webYfdOggaFgww/DGts9uO/z495MFn68b1udh9NOO43R4sDoUv54EGJCT0ChYARmO+BQanUE2Jq7vguPVZNqOjDofNNNN42maFOPbqrn7DZU3zx0UH6677MBiLz+TrVIskS2AbFa4SnMCQFbvnNVXoqB3nNQ4LmNN97YjYJWrFgx6PGJ7uPjD01EVH6HyRuJkT88/dieAcE2Q50ofb2cHwERQH6MlYIQKBYBGQMVWzTKmBDIj4AIID/GSkEIFIuACKDYolHGhEB+BEQA+TFWCkKgWAREAMUWjTImBPIjIALIj7FSEALFIiACKLZolDEhkB8BEUB+jJWCECgWARFAsUWjjAmB/AiIAPJjrBSEQLEIiACKLRplTAjkR0AEkB9jpSAEikVABFBs0ShjQiA/AiKA/BgrBSFQLAIigGKLRhkTAvkREAHkx1gpCIFiERABFFs0ypgQyI+ACCA/xkpBCBSLgAig2KJRxoRAfgREAPkxVgpCoFgERADFFo0yJgTyIyACyI+xUhACxSIgAii2aJQxIZAfARFAfoyVghAoFgERQLFFo4wJgfwIiADyY6wUhECxCIgAii0aZUwI5EdABJAfY6UgBIpFQARQbNEoY0IgPwIigPwYKwUhUCwCIoBii0YZEwL5ERAB5MdYKQiBYhEQARRbNMqYEMiPgAggP8ZKQQgUi4AIoNiiUcaEQH4ERAD5MVYKQqBYBEQAxRaNMiYE8iMgAsiPsVIQAsUiIAIotmiUMSGQHwERQH6MlYIQKBYBEUCxRaOMCYH8CIgA8mOsFIRAsQiIAIotGmVMCORHQASQH2OlIASKRUAEUGzRKGNCID8CIoD8GCsFIVAsAiKAYotGGRMC+REQAeTHWCkIgWIREAEUWzTKmBDIj4AIID/GSkEIFIuACKDYolHGhEB+BEQA+TFWCkKgWAREAMUWjTImBPIjIALIj7FSEALFIiACKLZolDEhkB8BEUB+jJWCECgWARFAsUWjjAmB/AiIAPJjrBSEQLEIiACKLRplTAjkR0AEkB9jpSAEikVABFBs0ShjQiA/AiKA/BgrBSFQLAIigGKLRhkTAvkREAHkx1gpCIFiERABFFs0ypgQyI+ACCA/xkpBCBSLgAig2KJRxoRAfgREAPkxVgpCoFgERADFFo0yJgTyIyACyI+xUhACxSIgAii2aJQxIZAfARFAfoyVghAoFgERQLFFo4wJgfwIiADyY6wUhECxCIgAii0aZUwI5EdABJAfY6UgBIpFQARQbNEoY0IgPwL/A4KvxU8buYBFAAAAAElFTkSuQmCC';
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
  // tdoc project mark (assets/tdoc_logo.png, served at /tdoc_logo.png).
  return '/tdoc_logo.png';
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
function cspHeader(nonce) {
  return `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none';`;
}

// Interactive islands (#138). Host documents keep cspHeader(); computation
// lives in a separately served HTML resource framed with sandbox="allow-scripts"
// (never allow-same-origin). srcdoc/blob inherit the parent CSP and cannot
// run author JS — these must be real URLs.
function isValidWidgetName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}
function widgetCspHeader() {
  return "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; worker-src 'none'; form-action 'none'; sandbox allow-scripts";
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

// Inject the overlay boot + an arbitrary cfg into a document. Single source of
// truth for "put window.__TDOC__ + overlay.js before </body>" — used by both
// the published view and the /fork view (which previously re-implemented this
// inline, risking drift).
//
// `nonce` (when supplied) is stamped onto BOTH injected <script> tags so they
// — and only they — run under the CSP set by cspHeader() above. Callers that
// don't pass a nonce (there are none left in this file, but keep the param
// optional so a future caller can't silently omit CSP without an explicit
// choice) get unnonced tags, which simply won't execute under a nonce-based
// CSP — fail closed, not fail open.
function injectOverlayCfg(rawHtml, cfg, nonce) {
  rawHtml = forceWidgetSandbox(rawHtml);
  const bootCfg = { ...cfg, runtime: cfg.runtime || runtimeInfo() };
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const inject =
    `<script${nonceAttr}>window.__TDOC__ = ${safeJsonForScript(bootCfg)};</script>\n` +
    `<script${nonceAttr}>${OVERLAY_JS}</script>`;
  if (rawHtml.includes('</body>')) return rawHtml.replace('</body>', `${inject}\n</body>`);
  return rawHtml + inject;
}

function injectOverlay(rawHtml, slug, version, identity, versions, isOwner, ownerManage, nonce, isLanding) {
  // The onboarding modal is product UI, so it ships from here under the page
  // nonce. The doc's own <script> would never run (#138), which is why the
  // landing CTA still carries a plain href: with scripting off the visitor
  // gets the /start page instead of a dead button.
  const withOnboard = (slug === LANDING_SLUG || slug === START_SLUG) && nonce
    ? rawHtml.replace('</body>', `<script nonce="${nonce}">${ONBOARD_JS}</script>\n</body>`)
    : rawHtml;
  return injectOverlayCfg(withOnboard, {
    slug, version,
    identity: identity || null,
    isOwner: !!isOwner,
    // `/` is the site itself, not a doc someone published. The slug and the
    // version number are storage detail; printing them in the bar tells a
    // first-time visitor they are looking at somebody's document.
    isLanding: !!isLanding,
    // Always null for non-owners (never just omitted-but-truthy-elsewhere) so
    // the overlay's `if (!cfg.ownerManage) return;` guard is unambiguous.
    ownerManage: isOwner ? (ownerManage || null) : null,
    authConfigured: true,
    mode: 'published',
    versions: Array.isArray(versions) && versions.length ? versions : [{ n: version }],
  }, nonce);
}

// The doc whose latest version IS the site homepage (#127). tdoc.dev/ renders
// this published tdoc rather than a hardcoded marketing page, so the landing
// page is authored, reviewed, and versioned through tdoc itself.
const LANDING_SLUG = 'tornado-doc';

// The doc behind `/start`: the same onboarding, written as a page, for anyone
// who has scripting off or who wants to read the steps before running them.
const START_SLUG = 'tdoc-start';

// The onboarding modal, bundled in by bin/tdoc-bundle. Kept as a placeholder
// here so the source file stays readable and the bundle stays one artifact.
const ONBOARD_JS = `__TDOC_ONBOARD_JS__`;

// Render one published doc version as a full overlay page. Extracted so `/`
// (the homepage) and `/d/<slug>/v/<n>` render through the SAME path — access
// gate, version picker, owner-manage payload, nonce + CSP — instead of the
// homepage growing a parallel copy that drifts.
//
// Returns { ok, response }. `ok:false` carries the real 401/403/404 response
// for the /d/ route to pass through; the homepage ignores it and falls back to
// the neutral page, because `/` must never dead-end on an access screen.
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
    if (meta && Array.isArray(meta.versions) && canSeeHistory(gate.access, session, env)) {
      versions = meta.versions.map(v => ({ n: v.n, created: v.created || null }));
    } else if (meta && Array.isArray(meta.versions)) {
      const hit = meta.versions.find(v => Number(v.n) === version);
      versions = [{ n: version, created: (hit && hit.created) || null }];
    }
  } catch {}
  const isOwner = isOwnerSession(env, session);
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
  return {
    ok: true,
    response: html(injectOverlay(raw, slug, version, identity, versions, isOwner, ownerManage, nonce, isLanding), {
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
<script>
(function () {
  var toastMsg = ${toastJson};
  var toastEl = document.getElementById('toast');
  if (toastMsg && toastEl) {
    toastEl.textContent = toastMsg;
    toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 5200);
  }
  var btn = document.getElementById('signin');
  var status = document.getElementById('status');
  if (!btn) return;
  var pollTimer = null;
  var pollInterval = 5;
  function setStatus(t) { if (status) status.textContent = t || ''; }
  function schedule(code) {
    pollTimer = setTimeout(function () { poll(code); }, pollInterval * 1000);
  }
  async function poll(code) {
    pollTimer = null;
    try {
      var r = await fetch('/api/auth/device/poll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: code })
      });
      var data = await r.json();
      if (data.ok) {
        setStatus('Signed in. Opening My docs…');
        window.location.href = '/me';
        return;
      }
      if (data.error === 'slow_down') {
        pollInterval = Math.max(pollInterval + 5, Number(data.interval) || 0);
        schedule(code); return;
      }
      if (data.error === 'authorization_pending' || (data.pending && !data.error)) {
        schedule(code); return;
      }
      if (data.error === 'expired_token' || data.error === 'access_denied') {
        setStatus('Code expired or denied. Try again.');
        btn.disabled = false; return;
      }
      if (data.error || !r.ok) {
        setStatus('Sign-in failed: ' + (data.message || data.error || ('HTTP ' + r.status)));
        btn.disabled = false; return;
      }
      schedule(code);
    } catch (e) {
      setStatus('Network error — retrying…');
      schedule(code);
    }
  }
  btn.onclick = async function () {
    btn.disabled = true;
    setStatus('Starting GitHub sign-in…');
    try {
      var r = await fetch('/api/auth/device/start', { method: 'POST' });
      var data = await r.json();
      if (!r.ok || data.error || !data.user_code || !data.verification_uri) {
        setStatus('Sign-in error: ' + ((data && (data.message || data.error)) || ('HTTP ' + r.status)));
        btn.disabled = false; return;
      }
      var uri = data.verification_uri_complete || data.verification_uri;
      setStatus('Code ' + data.user_code + ' — approve in the GitHub tab, then return here.');
      try {
        var u = new URL(String(uri));
        if (u.protocol === 'https:' && /(^|\\.)github\\.com$/.test(u.hostname)) window.open(uri, '_blank');
      } catch (_) {}
      pollInterval = Math.max(5, data.interval || 5);
      schedule(data.device_code);
    } catch (e) {
      setStatus('Sign-in error: could not reach the sign-in service.');
      btn.disabled = false;
    }
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

// /me — the owner's doc catalog. JUL-36 tail (2026-08-13): this used to be a
// dense access-control table (visibility/history/commenting/allowed_users
// dropdowns + Save) gated by an admin-token field. Both are GONE now:
//   - access controls moved to the doc-page Share panel (overlay.js
//     showManageModal, PATCH /api/doc/access) — a single doc's own page is
//     the right place to manage that doc, not a spreadsheet of every doc.
//   - the admin-token field is gone because DELETE /api/doc now accepts the
//     owner's session cookie (authorizeOwnerMutation) — safe because of the
//     CSP set on every doc response (see cspHeader()). /me is only reachable
//     by the signed-in owner in the first place (isOwnerSession gate in the
//     route above), so its own fetches are already same-origin + cookied.
// What's left: title, slug, version, search, multi-select batch delete, and
// a quiet ⋯ Delete. No access data of any kind is computed or emitted here
// (gate: response HTML must not contain `allowed_users` — there is nothing
// here that could).
async function indexHtml(env, session) {
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

  const docs = await Promise.all(list.map(async (k) => {
    const slug = k.name.slice('meta:'.length);
    const metaRaw = await env.META.get(k.name);
    let meta = {};
    try { meta = JSON.parse(metaRaw || '{}'); } catch {}
    const latest = meta.versions?.[meta.versions.length - 1]?.n || 1;
    return { slug, title: meta.title || slug, latest };
  }));

  const rows = docs.map(({ slug, title, latest }) => `<div class="doc-row" data-slug="${escapeHtml(slug)}" data-title="${escapeHtml(title)}">
      <label class="row-check">
        <input type="checkbox" class="doc-check" aria-label="Select ${escapeHtml(title)}">
      </label>
      <div class="doc-info">
        <a class="doc-title" href="/d/${encodeURIComponent(slug)}/v/${latest}">${escapeHtml(title)}</a>
        <div class="doc-meta">${escapeHtml(slug)} · v${latest}</div>
      </div>
      <div class="row-actions">
        <button class="row-menu-btn" aria-label="More actions" aria-haspopup="true" aria-expanded="false">⋯</button>
        <div class="row-menu" hidden>
          <button class="row-delete" data-slug="${escapeHtml(slug)}" data-title="${escapeHtml(title)}">Delete…</button>
        </div>
      </div>
    </div>`);

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>tdoc</title>
<style>
  :root {
    --td-accent: #1652f0; --td-accent-hover: #1245d0; --td-accent-tint: #e8eeff;
    --td-danger: #b42318; --td-danger-hover: #931c14; --td-danger-tint: #fdeceb; --td-ok: #087443;
    --td-ink: #111; --td-muted: #666; --td-line: #eee; --td-surface: #f7f7f7;
  }
  body { font: 15px system-ui, -apple-system, sans-serif; max-width: 680px; margin: 48px auto; padding: 0 20px; color: var(--td-ink); }
  h1 { font-size: 28px; margin: 0 0 4px; color: var(--td-accent); }
  .who { color: var(--td-muted); font-size: 13px; margin: 0 0 20px; }
  .who b { color: #444; font-weight: 600; }
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
  .doc-row { display: flex; align-items: center; gap: 12px; padding: 13px 4px; border-bottom: 1px solid var(--td-line); }
  .doc-row.is-selected { background: var(--td-accent-tint); border-radius: 8px; }
  .row-check { display: flex; align-items: center; flex-shrink: 0; cursor: pointer; }
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
  /* Styled confirm modal — replaces window.confirm() (JUL-36). Matches the
     doc overlay's .tdoc-modal-bg/.tdoc-modal visual language; kept as a
     standalone copy here since /me does not load overlay.js. */
  .tdoc-modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 1000; display: flex; align-items: center; justify-content: center; font: 14px system-ui, sans-serif; }
  .tdoc-modal { background: #fff; color: var(--td-ink); border-radius: 12px; padding: 26px; width: 420px; max-width: calc(100vw - 32px); box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
  .tdoc-modal h3 { margin: 0 0 10px; font-size: 18px; }
  .tdoc-modal p { margin: 0 0 14px; color: #444; line-height: 1.5; }
  .tdoc-modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
  .tdoc-modal button { padding: 8px 16px; border-radius: 6px; border: 1px solid #ccc; background: #fff; }
  .tdoc-modal button.danger { background: var(--td-danger); border-color: var(--td-danger); color: #fff; }
  .tdoc-modal button.danger:hover { background: var(--td-danger-hover); border-color: var(--td-danger-hover); }
</style>
</head><body>
<h1>My docs</h1>
<p class="who">${session && session.login ? `Signed in as <b>${escapeHtml(session.login)}</b>` : 'Your published docs'}.</p>
${rows.length === 0 ? '<p class="empty">No published docs yet.</p>' :
  `<div class="toolbar">
    <input type="search" id="doc-search" placeholder="Search title or slug…" autocomplete="off" aria-label="Search docs">
  </div>
  <div class="batch-bar">
    <label class="select-all"><input type="checkbox" id="select-all"> <span id="select-all-label">Select all</span></label>
    <button type="button" id="batch-delete" class="batch-delete">Delete selected</button>
  </div>
  <div class="doc-list">${rows.join('')}</div>
  <p id="no-match" class="empty" hidden>No matches.</p>`}
<script>
(() => {
  // Tiny top-right toast — no third-party runtime on the privileged /me page.
  function toast(message, kind = '') {
    if (!message) return;
    document.querySelectorAll('.tdoc-toast').forEach((n) => n.remove());
    const t = document.createElement('div');
    t.className = 'tdoc-toast';
    t.textContent = message;
    t.setAttribute('role', 'status');
    t.style.cssText = 'position:fixed;top:18px;right:18px;z-index:2000;background:' +
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
      if (danger) goBtn.className = 'danger';
      const done = (v) => { bg.remove(); resolve(v); };
      bg.querySelector('[data-act="cancel"]').onclick = () => done(false);
      bg.addEventListener('click', (e) => { if (e.target === bg) done(false); });
      goBtn.onclick = () => done(true);
      document.body.appendChild(bg);
    });
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
  const listEl = document.querySelector('.doc-list');
  if (!listEl) return;
  const search = document.getElementById('doc-search');
  const selectAll = document.getElementById('select-all');
  const selectAllLabel = document.getElementById('select-all-label');
  const batchDelete = document.getElementById('batch-delete');
  const noMatch = document.getElementById('no-match');

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
    selected.forEach((row) => row.classList.add('is-selected'));
    listEl.querySelectorAll('.doc-row').forEach((row) => {
      const box = row.querySelector('.doc-check');
      if (!(box && box.checked)) row.classList.remove('is-selected');
    });
    batchDelete.classList.toggle('is-visible', n > 0);
    batchDelete.textContent = n <= 1 ? 'Delete' : ('Delete ' + n);
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
    let shown = 0;
    listEl.querySelectorAll('.doc-row').forEach((row) => {
      const hay = ((row.dataset.title || '') + ' ' + (row.dataset.slug || '')).toLowerCase();
      const match = !q || hay.includes(q);
      row.hidden = !match;
      if (match) shown += 1;
      else {
        const box = row.querySelector('.doc-check');
        if (box) box.checked = false;
      }
    });
    if (noMatch) noMatch.hidden = shown > 0;
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
//   marked_applied/open/deleted → <kind>:<at_version>       (state, not history)
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

function hostedRegistrationEnabled(env) {
  const v = String(env.TDOC_HOSTED_REGISTRATION || env.TDOC_HOSTED_SIGNUP || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

async function issueHostedToken(env, body = {}) {
  const token = `tdoc_${rand(24)}`;
  const tokenHash = await sha256Hex(token);
  const record = {
    account_id: `acct_${rand(12)}`,
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
  return { kind: 'hosted', account_id: record.account_id, token_hash: tokenHash };
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
  return {
    ...(meta || {}),
    hosted: {
      ...((meta && meta.hosted && typeof meta.hosted === 'object') ? meta.hosted : {}),
      account_id: actor.account_id,
    },
  };
}

// Combined write gate for browser-facing admin routes (DELETE /api/doc,
// PATCH /api/doc/access). One of:
//   - signed in as TDOC_OWNER (session cookie; CSP makes this safe);
//   - provider-wide upload token (self-host CLI, global admin);
//   - hosted account token AND requireDocWriteAccess for `slug`.
//
// Hosted tokens are NOT global owners. `slug` must be known before this
// runs whenever a hosted token might be in play. Returns { ok: true, actor,
// session, meta? } or { ok: false, response }.
async function authorizeOwnerMutation(req, env, slug) {
  const session = await getSession(env, req);
  if (isOwnerSession(env, session)) return { ok: true, session, actor: { kind: 'owner_session' } };
  const auth = await requireUploadAuth(req, env);
  if (!auth.ok) return { ok: false, response: auth.response };
  if (auth.actor.kind === 'admin') return { ok: true, session: null, actor: auth.actor };
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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (p === '/api/ping') return json({ ok: true, service: 'tdoc' });
    if (p === '/api/runtime') return json({ ok: true, runtime: runtimeInfo() });
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

    // Soft landing for the OAuth App "Authorization callback URL". Device
    // Flow does not need a callback, but GitHub may still redirect here
    // after Approve — serve a friendly page instead of a 404.
    if ((p === '/auth/done' || p === '/auth/github/callback') && method === 'GET') {
      return html(authDoneHtml());
    }

    // ---- owner-only doc catalog ----
    // `/me` returns the list of every doc hosted on THIS worker, but only
    // to the configured owner (TDOC_OWNER) when signed in. Everyone else
    // is sent to the landing page (with a toast) — never to github.com.
    if (p === '/me' && method === 'GET') {
      const s = await getSession(env, req);
      if (!isOwnerSession(env, s)) {
        const notice = sessionLogin(s) ? 'me' : 'signin';
        return new Response(null, {
          status: 302,
          headers: { Location: `/?notice=${notice}` },
        });
      }
      return html(await indexHtml(env, s));
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

    // ---- doc view ----
    const docMatch = p.match(/^\/d\/([^/]+)\/v\/(\d+)\/?$/);
    if (docMatch && (method === 'GET' || method === 'HEAD')) {
      const [, slug, vStr] = docMatch;
      const res = await serveDocVersion(env, req, slug, Number(vStr));
      return res.response;
    }

    // ---- doc export / fork ----
    // /export → forces a file download (Content-Disposition: attachment) unless
    //           ?download=0. Used for "save a copy" links.
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

      // The fork route boots the overlay in read-only "fork" mode so the
      // user can SEE what they just downloaded — comments rendered as cards,
      // anchors highlighted — without any backend.
      // Same confused-deputy surface as the doc-view route (same-origin
      // cookie, arbitrary author HTML) even though fork/export don't expose
      // owner-manage UI — a script here could still ride the viewer's session
      // cookie to hit /api/doc*. Nonce the injected overlay script the same
      // way; author content stays unnonced and inert under the CSP below.
      const nonce = rand(16);
      let bodyHtml = html;
      if (kind === 'fork') {
        bodyHtml = injectOverlayCfg(bodyHtml, {
          slug, version: Number(vStr), identity: null,
          authConfigured: false, mode: 'fork', originalSlug: slug,
        }, nonce);
      }

      const finalHtml = banner + jsonBlock + bodyHtml;
      const dl = url.searchParams.get('download');
      // /export defaults to attachment; /fork defaults to inline. Either can be
      // overridden with ?download=1 / ?download=0.
      const defaultAttach = kind === 'export';
      const forceDownload = dl === '1' || (defaultAttach && dl !== '0');
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': cspHeader(nonce) };
      if (forceDownload) headers['Content-Disposition'] = `attachment; filename="${slug}-v${vStr}-fork.html"`;
      return new Response(finalHtml, { status: 200, headers });
    }

    // ---- auth ----
    if (p === '/api/auth/me' && method === 'GET') {
      const s = await getSession(env, req);
      return json({
        identity: s ? { login: s.login, avatar_url: s.avatar_url, name: s.name } : null,
        isOwner: isOwnerSession(env, s),
        authConfigured: true,
      });
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

    // ---- hosted publish token bootstrap ----
    // Hosted/OOB users should not create Cloudflare resources or receive the
    // provider-wide TDOC_UPLOAD_TOKEN. The central Worker mints an account-
    // scoped upload token, and write routes enforce slug ownership for that
    // token. Registration is provider-gated by env so tdoc.dev can stay
    // closed without changing client code. Do not set TDOC_HOSTED_REGISTRATION
    // on tdoc.dev until signup is intentionally opened.
    if (p === '/api/hosted/token' && method === 'POST') {
      if (!hostedRegistrationEnabled(env)) {
        return json({ error: 'hosted_registration_disabled' }, { status: 403 });
      }
      let body = {};
      try { body = await req.json(); } catch {}
      const issued = await issueHostedToken(env, body);
      return json({
        ok: true,
        token: issued.token,
        account_id: issued.record.account_id,
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
        if (!canReadDoc(access, s, env)) return json({ error: 'access_denied' }, { status: 403 });
        if (!canCommentOnDoc(access, s, env)) return json({ error: 'commenting_disabled' }, { status: 403 });
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
          await deliverInbox(env, env.TDOC_OWNER, {
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
      if (!canMutate(target, s, env)) return json({ error: 'not_author' }, { status: 403 });
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
      let authorized = false;
      const top = authList.find(c => c.id === id);
      if (top) {
        if (!canMutate(top, s, env)) return json({ error: 'not_author' }, { status: 403 });
        authorized = true;
      } else {
        for (const c of authList) {
          ensureEventLog(c);
          const reply = (c.events || []).find(e => e.kind === 'reply_added' && e.reply && e.reply.id === id);
          if (reply) {
            if (!canMutate(reply.reply, s, env)) return json({ error: 'not_author' }, { status: 403 });
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
