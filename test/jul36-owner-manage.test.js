// JUL-36 — owner manage UX (Delete / Unpublish / Share settings) guard.
//
// Product ask: the doc-view top bar exposes owner-only manage controls
// directly (not just on /me), with a styled confirm modal instead of native
// confirm(). Security constraint from review: owner gating is SERVER-side
// (the overlay never render-then-hides a dead button), and every mutation
// route re-checks auth INSIDE itself.
//
// 2026-08-13 tail: browser owner mutations now authorize off the owner's
// SESSION COOKIE (no more pasted admin token) via the shared
// authorizeOwnerMutation() gate, which is safe ONLY because every doc
// response now carries a CSP (worker.js cspHeader()) that blocks author
// <script>/onclick content — see test/csp.test.js. The CLI keeps using the
// upload bearer token unchanged; authorizeOwnerMutation accepts EITHER.
//
// Two tests mirror what the reviewer said she'll write herself:
//   (a) a non-owner's doc-view response can never carry manage data.
//   (b) the admin mutation gate (shared by DELETE /api/doc and
//       PATCH /api/doc/access) returns 401 for anonymous/non-owner-no-token
//       calls, and passes for EITHER an owner session OR the correct
//       upload token.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
async function tAsync(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const worker = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
const overlay = fs.readFileSync(path.join(__dirname, '..', 'server', 'overlay.js'), 'utf8');

console.log('JUL-36 owner manage UX');

// ── (a) non-owner doc-view response can never carry manage data ──────────

// #127: the doc-view render moved out of the `/d/` route body into
// serveDocVersion(), which the `/d/` route and the `/` homepage now share.
// Scan the shared function — that is where these guarantees have to hold, and
// slicing it keeps ONE copy of them under test instead of per-route copies.
const docViewStart = worker.indexOf('async function serveDocVersion(');
const docViewEnd = worker.indexOf('async function landingResponse', docViewStart);
if (docViewStart < 0 || docViewEnd < 0) throw new Error('serveDocVersion block missing');
const docViewRoute = worker.slice(docViewStart, docViewEnd);

t('doc-view route computes isOwner server-side from the session, not the client', () => {
  assert(docViewRoute.includes('const isOwner = isDocOwnerSession(env, session, gate.meta);'),
    'isOwner must be derived from isDocOwnerSession(env, session, meta) on THIS request');
});

t('doc-view route only builds ownerManage data inside an isOwner guard', () => {
  const decl = docViewRoute.indexOf('let ownerManage = null;');
  const guard = docViewRoute.indexOf('if (isOwner) {', decl);
  assert(decl >= 0, 'ownerManage must default to null');
  assert(guard >= 0 && guard > decl, 'ownerManage must only be populated inside `if (isOwner)`');
});

t('doc-view never leaks private doc metadata (version count) to non-owners via the shared bootCfg', () => {
  // The reviewer's refined bar: button-label strings live in the shared,
  // open-source overlay bundle and protect nothing — but a slug's *version
  // count* is private metadata. `commentCount` and `allowed_users` only ride
  // inside ownerManage (already forced null for non-owners above), so the one
  // channel that reaches EVERY viewer is the `versions` array. Its length must
  // therefore follow the access policy: only callers cleared by canSeeHistory
  // get the full list; everyone else collapses to just the version they asked
  // for, so `versions.length` can never betray how many versions exist.
  const full = docViewRoute.indexOf('meta.versions.map(');
  const gate = docViewRoute.lastIndexOf('canSeeHistory(', full);
  const gateStmt = docViewRoute.lastIndexOf('if (', full);
  assert(full >= 0, 'doc-view must build the version list from meta.versions');
  assert(gate >= 0 && gate < full && gate > gateStmt,
    'the full version list must be gated by canSeeHistory(...) in the SAME if — never handed out unconditionally');
  const collapse = docViewRoute.indexOf('versions = [{ n: version,', full);
  assert(collapse >= 0,
    'the non-history branch must collapse `versions` to the single viewed version, not the full list');
});

// Anchored on the parameters this file actually reasons about; #127 appends
// an isLanding flag after `nonce`, and a later caller may append more.
const injectOverlayStart = worker.search(
  /function injectOverlay\(rawHtml, slug, version, identity, versions, isOwner, ownerManage, nonce[^)]*\) \{/);
const injectOverlayEnd = worker.indexOf('\n}', injectOverlayStart);
if (injectOverlayStart < 0) throw new Error('injectOverlay() signature not found — did it change?');
const injectOverlayFn = worker.slice(injectOverlayStart, injectOverlayEnd);

t('injectOverlay re-checks isOwner itself before embedding ownerManage (defense in depth)', () => {
  // Even if a future caller passed real data with isOwner falsy, this line
  // must still force null — the boot config a non-owner receives can never
  // carry manage data, regardless of what upstream computed.
  assert(injectOverlayFn.includes('ownerManage: isOwner ? (ownerManage || null) : null'),
    'injectOverlay must force ownerManage to null whenever isOwner is falsy');
});

t('overlay has no separate Share settings menu item — Share is the single owner entry', () => {
  assert(!overlay.includes('id="tdoc-manage-doc"'),
    'the identity-menu Share settings item must be gone; the bar Share button is the only entry');
  const fnStart = overlay.indexOf('function showShareModal() {');
  assert(fnStart >= 0, 'showShareModal not found');
  const fnEnd = overlay.indexOf('function showManageModal()', fnStart);
  const body = overlay.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 600);
  assert(body.includes('if (cfg.ownerManage)') && body.includes('showManageModal()'),
    'showShareModal must dispatch to showManageModal for owners before rendering the copy-link-only panel');
});

t('showManageModal() bails before creating any DOM when cfg.ownerManage is absent', () => {
  const fnStart = overlay.indexOf('function showManageModal() {');
  assert(fnStart >= 0, 'showManageModal not found');
  const guardIdx = overlay.indexOf('if (!cfg.ownerManage) return;', fnStart);
  const firstDomWrite = overlay.indexOf('document.createElement', fnStart);
  assert(guardIdx >= 0, 'showManageModal must guard on cfg.ownerManage before rendering');
  assert(guardIdx < firstDomWrite, 'the ownerManage guard must run BEFORE any DOM node is created — never render-then-hide');
});

// ── (b) admin mutation gate: session-OR-token, never neither ─────────────
//
// 2026-08-13: DELETE /api/doc and PATCH /api/doc/access now authorize via
// authorizeOwnerMutation (owner session OR upload token), not
// requireUploadAuth alone. Verify both routes call the shared gate, and unit
// test the gate itself: anonymous/non-owner-no-token → 401; owner session
// alone → authorized (the new browser capability); upload token alone →
// still authorized (CLI unchanged); wrong token + non-owner session → 401.

const uploadAuthStart = worker.indexOf('async function requireUploadAuth(req, env) {');
const timingEqualStart = worker.indexOf('async function timingSafeEqual(a, b) {');
const timingEqualEnd = worker.indexOf('\n}', timingEqualStart) + 2;
const parseCookieStart = worker.indexOf('function parseCookie(req) {');
const parseCookieEnd = worker.indexOf('\n}', parseCookieStart) + 2;
const getSessionStart = worker.indexOf('async function getSession(env, req) {');
const getSessionEnd = worker.indexOf('\n}', getSessionStart) + 2;
const isOwnerSessionStart = worker.indexOf('function isOwnerSession(env, session) {');
const isOwnerSessionEnd = worker.indexOf('\n}', isOwnerSessionStart) + 2;
const sessionLoginStart = worker.indexOf('function sessionLogin(session) {');
const isDocOwnerStart = worker.indexOf('function isDocOwnerSession(env, session, meta) {');
const isDocOwnerEnd = worker.indexOf('\n}', isDocOwnerStart) + 2;
const loadDocMetaStart = worker.indexOf('async function loadDocMeta(env, slug) {');
const loadDocMetaEnd = worker.indexOf('\n}', loadDocMetaStart) + 2;
const hostedHelpersStart = worker.indexOf('async function sha256Hex(s) {');
const authorizeStart = worker.indexOf('async function authorizeOwnerMutation(req, env, slug) {');
const hostedHelpersEnd = worker.indexOf('// #34 — Per-slug write serialization', hostedHelpersStart);
if (uploadAuthStart < 0 || timingEqualStart < 0 || parseCookieStart < 0 || getSessionStart < 0
  || isOwnerSessionStart < 0 || sessionLoginStart < 0 || isDocOwnerStart < 0 || loadDocMetaStart < 0
  || authorizeStart < 0 || hostedHelpersStart < 0 || hostedHelpersEnd < 0) {
  throw new Error('auth helpers not found');
}
const authSrc = [
  worker.slice(timingEqualStart, timingEqualEnd),
  worker.slice(parseCookieStart, parseCookieEnd),
  worker.slice(getSessionStart, getSessionEnd),
  worker.slice(isOwnerSessionStart, isOwnerSessionEnd),
  worker.slice(sessionLoginStart, isDocOwnerEnd),
  worker.slice(loadDocMetaStart, loadDocMetaEnd),
  worker.slice(hostedHelpersStart, hostedHelpersEnd),
].join('\n');

const deleteStart = worker.indexOf("if (p === '/api/doc' && method === 'DELETE')");
const deleteEnd = worker.indexOf("return text('Not found'", deleteStart);
const deleteRoute = worker.slice(deleteStart, deleteEnd);

const accessPatchStart = worker.indexOf("if (p === '/api/doc/access' && method === 'PATCH')");
const accessPatchEnd = worker.indexOf('// ---- admin delete ----', accessPatchStart);
const accessPatchRoute = worker.slice(accessPatchStart, accessPatchEnd);

t('DELETE /api/doc and PATCH /api/doc/access both go through the shared authorizeOwnerMutation gate', () => {
  assert(deleteRoute.includes('await authorizeOwnerMutation(req, env, slug)'), 'DELETE /api/doc must call authorizeOwnerMutation');
  assert(accessPatchRoute.includes('await authorizeOwnerMutation(req, env, slug)'), 'PATCH /api/doc/access must call authorizeOwnerMutation');
  // The session path must go through the ONE shared, tested gate — not a
  // bespoke same-origin/cookie check bolted onto just one route.
  assert(!worker.includes('requireAdminAuth'), 'worker must not add a separate cookie-based admin-auth function');
  assert(!worker.includes('isSameOriginRequest'), 'same-origin is not sufficient — docs are arbitrary same-origin HTML');
});

t('authorizeOwnerMutation gate itself calls isDocOwnerSession, then falls back to requireUploadAuth', () => {
  const fnSrc = worker.slice(authorizeStart, hostedHelpersEnd);
  const ownerCheck = fnSrc.indexOf('isDocOwnerSession(env, session, meta)');
  const tokenCheck = fnSrc.indexOf('requireUploadAuth(req, env)');
  assert(ownerCheck >= 0, 'must check isDocOwnerSession');
  assert(tokenCheck >= 0, 'must fall back to requireUploadAuth');
  assert(ownerCheck < tokenCheck, 'doc-owner session check must come before the token fallback');
  assert(fnSrc.includes('requireDocWriteAccess(env, auth.actor, slug)'),
    'hosted tokens must be slug-scoped inside the shared gate, not treated as global owners');
});

const box = { console, TextEncoder, crypto, Response };
vm.createContext(box);
vm.runInContext(`
  function json(obj, init = {}) {
    return new Response(JSON.stringify(obj), { status: (init && init.status) || 200 });
  }
` + authSrc, box);

function fakeReq(bearer) {
  return { headers: { get: (name) => (name.toLowerCase() === 'authorization' && bearer) ? ('Bearer ' + bearer) : null } };
}

// Fake env + req for authorizeOwnerMutation, which additionally needs a
// session cookie resolved through env.META.get('session:<sid>').
function fakeEnv({ owner, token, sessions = {} } = {}) {
  return {
    TDOC_OWNER: owner,
    TDOC_UPLOAD_TOKEN: token,
    META: { async get(key) {
      const m = /^session:(.+)$/.exec(key);
      const s = m && sessions[m[1]];
      return s ? JSON.stringify(s) : null;
    } },
  };
}
function fakeSessionReq({ bearer, sid } = {}) {
  const cookie = sid ? `tdoc_sid=${sid}` : null;
  return { headers: { get: (name) => {
    const n = name.toLowerCase();
    if (n === 'authorization') return bearer ? ('Bearer ' + bearer) : null;
    if (n === 'cookie') return cookie;
    return null;
  } } };
}

async function main() {
  await tAsync('requireUploadAuth: anonymous request (no Authorization header) → 401', async () => {
    const res = await box.requireUploadAuth({ headers: { get: () => null } }, { TDOC_UPLOAD_TOKEN: 'secret-token' });
    assert(res && res.ok === false, 'must not pass through');
    assert(res.response.status === 401, `expected 401, got ${res.response && res.response.status}`);
  });

  await tAsync('requireUploadAuth: wrong bearer token → 401', async () => {
    const res = await box.requireUploadAuth(fakeReq('not-the-token'), { TDOC_UPLOAD_TOKEN: 'secret-token' });
    assert(res && res.ok === false, 'must not pass through');
    assert(res.response.status === 401, `expected 401, got ${res.response && res.response.status}`);
  });

  await tAsync('requireUploadAuth: no TDOC_UPLOAD_TOKEN configured → unknown bearer is 401 (fail closed)', async () => {
    const res = await box.requireUploadAuth(fakeReq('anything'), {});
    assert(res && res.ok === false && res.response.status === 401, 'must fail closed when no token is configured');
  });

  await tAsync('requireUploadAuth: correct bearer token → passes as admin actor', async () => {
    const res = await box.requireUploadAuth(fakeReq('secret-token'), { TDOC_UPLOAD_TOKEN: 'secret-token' });
    assert(res && res.ok === true && res.actor && res.actor.kind === 'admin',
      'a correct provider token must pass as an admin actor');
  });

  // ── authorizeOwnerMutation: session-OR-token ──────────────────────────

  await tAsync('authorizeOwnerMutation: fully anonymous (no cookie, no bearer) → 401', async () => {
    const env = fakeEnv({ owner: 'julie', token: 'secret-token' });
    const res = await box.authorizeOwnerMutation(fakeSessionReq({}), env);
    assert(res.ok === false, 'must not authorize an anonymous caller');
    assert(res.response.status === 401, `expected 401, got ${res.response.status}`);
  });

  await tAsync('authorizeOwnerMutation: signed in as a NON-owner, no token → 401', async () => {
    const env = fakeEnv({ owner: 'julie', token: 'secret-token', sessions: { deadbeef: { login: 'mallory' } } });
    const res = await box.authorizeOwnerMutation(fakeSessionReq({ sid: 'deadbeef' }), env);
    assert(res.ok === false, 'a non-owner session must not authorize');
    assert(res.response.status === 401, `expected 401, got ${res.response.status}`);
  });

  await tAsync('authorizeOwnerMutation: OWNER session, NO token → authorized (the new browser capability)', async () => {
    const env = fakeEnv({ owner: 'julie', token: 'secret-token', sessions: { deadbeef: { login: 'julie' } } });
    const res = await box.authorizeOwnerMutation(fakeSessionReq({ sid: 'deadbeef' }), env);
    assert(res.ok === true, 'the configured owner’s session alone must authorize (case-insensitive login match)');
  });

  await tAsync('authorizeOwnerMutation: no session, correct upload token → authorized (CLI unchanged)', async () => {
    const env = fakeEnv({ owner: 'julie', token: 'secret-token' });
    const res = await box.authorizeOwnerMutation(fakeSessionReq({ bearer: 'secret-token' }), env);
    assert(res.ok === true, 'the CLI token path must keep working with no session at all');
  });

  await tAsync('authorizeOwnerMutation: non-owner session + WRONG token → 401 (neither credential is valid)', async () => {
    const env = fakeEnv({ owner: 'julie', token: 'secret-token', sessions: { deadbeef: { login: 'mallory' } } });
    const res = await box.authorizeOwnerMutation(fakeSessionReq({ sid: 'deadbeef', bearer: 'not-the-token' }), env);
    assert(res.ok === false, 'a non-owner session plus a wrong token must still be 401');
    assert(res.response.status === 401, `expected 401, got ${res.response.status}`);
  });

  // ── styled confirm modal replaces native confirm() (no native confirm left) ─

  const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');

  // Matches an actual native-confirm CALL (`confirm(` not preceded by "show"
  // or another identifier char, and not inside a `// ... confirm() ...`
  // prose comment praising its removal) — not just the word appearing in a
  // comment.
  const nativeConfirmCall = /(?:^|[^\w.])confirm\(/m;
  function stripLineComments(src) {
    return src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  }

  t('worker /me page no longer uses window.confirm() for delete', () => {
    const idxStart = worker.indexOf('async function indexHtml(env, session');
    const idxEnd = worker.indexOf('// ─────────────────────────────────────────────────────────────────────────', idxStart);
    const indexHtmlSrc = worker.slice(idxStart, idxEnd);
    assert(!nativeConfirmCall.test(stripLineComments(indexHtmlSrc)), '/me must not call the native confirm()');
    assert(indexHtmlSrc.includes('showConfirm('), '/me must use the styled showConfirm() modal');
    // Quiet confirm — title + "This can't be undone.", no version/comment inventory.
    assert(indexHtmlSrc.includes("This can't be undone."), 'delete confirm copy should stay short and plain');
    assert(!/remote storage/i.test(stripLineComments(indexHtmlSrc)), '/me must not say "remote storage" to the user');
  });

  t('local server index page no longer uses window.confirm() for delete', () => {
    const idxStart = serverJs.indexOf('function indexPage()');
    const indexPageSrc = serverJs.slice(idxStart, serverJs.indexOf('const server = http.createServer'));
    assert(!nativeConfirmCall.test(stripLineComments(indexPageSrc)), 'local index page must not call the native confirm()');
    assert(indexPageSrc.includes('showConfirm('), 'local index page must use the styled showConfirm() modal');
    assert(!indexPageSrc.includes('readCommentFile('), 'local catalog must not read comments.json for every row');
  });

  t('overlay.js manage flow never uses window.confirm() either', () => {
    const start = overlay.indexOf('// ========== Owner manage');
    const end = overlay.indexOf('async function pollDevice');
    const section = overlay.slice(start, end);
    assert(start >= 0 && end > start, 'owner manage section not found');
    assert(!nativeConfirmCall.test(stripLineComments(section)), 'owner manage flow must use showManageConfirm(), not native confirm()');
    assert(section.includes('showManageConfirm('), 'owner manage flow must build a styled confirm modal');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
