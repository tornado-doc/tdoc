// JUL-36 — owner manage UX (Delete / Unpublish / visibility switch) guard.
//
// Product ask: the doc-view top bar exposes owner-only manage controls
// directly (not just on /me), with a styled confirm modal instead of native
// confirm(). Security constraint from review: owner gating is SERVER-side
// (the overlay never render-then-hides a dead button), and every mutation
// route re-checks auth INSIDE itself — this ticket must not weaken that by
// adding a cookie-only admin-write path (see test/me-management.test.js,
// which already forbids `requireAdminAuth` / `isSameOriginRequest`).
//
// Two tests mirror what the reviewer said she'll write herself:
//   (a) a non-owner's doc-view response can never carry manage data.
//   (b) the admin mutation gate (shared by DELETE /api/doc and
//       PATCH /api/doc/access) returns 401 for anonymous/wrong-token calls
//       and passes for the correct token — i.e. it is NOT satisfied by a
//       session cookie alone.
// Plus: owner-succeeds coverage for the same gate.

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

const docViewStart = worker.indexOf("// ---- doc view ----");
const docViewEnd = worker.indexOf("// ---- doc export / fork ----", docViewStart);
if (docViewStart < 0 || docViewEnd < 0) throw new Error('doc-view route block missing');
const docViewRoute = worker.slice(docViewStart, docViewEnd);

t('doc-view route computes isOwner server-side from the session, not the client', () => {
  assert(docViewRoute.includes('const isOwner = isOwnerSession(env, session);'),
    'isOwner must be derived from isOwnerSession(env, session) on THIS request');
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
  const collapse = docViewRoute.indexOf('versions = [{ n: Number(vStr)', full);
  assert(collapse >= 0,
    'the non-history branch must collapse `versions` to the single viewed version, not the full list');
});

const injectOverlayStart = worker.indexOf('function injectOverlay(rawHtml, slug, version, identity, versions, isOwner, ownerManage) {');
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

t('overlay renderIdentity() only emits the manage menu item behind isOwner && cfg.ownerManage', () => {
  const idx = overlay.indexOf('id="tdoc-manage-doc"');
  assert(idx >= 0, 'manage menu item markup not found in overlay.js');
  const templateStart = overlay.lastIndexOf('${isOwner && cfg.ownerManage', idx);
  assert(templateStart >= 0 && templateStart < idx,
    'the manage-doc button must be gated by `${isOwner && cfg.ownerManage ...}` — never unconditional');
});

t('showManageModal() bails before creating any DOM when cfg.ownerManage is absent', () => {
  const fnStart = overlay.indexOf('function showManageModal() {');
  assert(fnStart >= 0, 'showManageModal not found');
  const guardIdx = overlay.indexOf('if (!cfg.ownerManage) return;', fnStart);
  const firstDomWrite = overlay.indexOf('document.createElement', fnStart);
  assert(guardIdx >= 0, 'showManageModal must guard on cfg.ownerManage before rendering');
  assert(guardIdx < firstDomWrite, 'the ownerManage guard must run BEFORE any DOM node is created — never render-then-hide');
});

// ── (b) admin mutation gate: 401 anonymous/wrong token; owner-succeeds ───

const uploadAuthStart = worker.indexOf('async function requireUploadAuth(req, env) {');
const uploadAuthEnd = worker.indexOf('\n}', uploadAuthStart) + 2;
const timingEqualStart = worker.indexOf('async function timingSafeEqual(a, b) {');
const timingEqualEnd = worker.indexOf('\n}', timingEqualStart) + 2;
if (uploadAuthStart < 0 || timingEqualStart < 0) throw new Error('auth helpers not found');
const authSrc = worker.slice(timingEqualStart, timingEqualEnd) + '\n' + worker.slice(uploadAuthStart, uploadAuthEnd);

const deleteStart = worker.indexOf("if (p === '/api/doc' && method === 'DELETE')");
const deleteEnd = worker.indexOf("return text('Not found'", deleteStart);
const deleteRoute = worker.slice(deleteStart, deleteEnd);

const accessPatchStart = worker.indexOf("if (p === '/api/doc/access' && method === 'PATCH')");
const accessPatchEnd = worker.indexOf('// ---- admin delete ----', accessPatchStart);
const accessPatchRoute = worker.slice(accessPatchStart, accessPatchEnd);

t('DELETE /api/doc and PATCH /api/doc/access are gated ONLY by requireUploadAuth (not a session/cookie path)', () => {
  assert(deleteRoute.includes('await requireUploadAuth(req, env)'), 'DELETE /api/doc must call requireUploadAuth');
  assert(accessPatchRoute.includes('await requireUploadAuth(req, env)'), 'PATCH /api/doc/access must call requireUploadAuth');
  // JUL-36 must not introduce a cookie-only admin-write bypass. A published
  // doc is arbitrary HTML on this same origin — trusting the owner's session
  // cookie alone here would let doc content silently trigger admin writes.
  assert(!worker.includes('requireAdminAuth'), 'worker must not add a cookie-based admin auth path');
  assert(!worker.includes('isSameOriginRequest'), 'same-origin is not sufficient — docs are arbitrary same-origin HTML');
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

async function main() {
  await tAsync('requireUploadAuth: anonymous request (no Authorization header) → 401', async () => {
    const res = await box.requireUploadAuth({ headers: { get: () => null } }, { TDOC_UPLOAD_TOKEN: 'secret-token' });
    assert(res !== null, 'must not pass through');
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await tAsync('requireUploadAuth: wrong bearer token → 401', async () => {
    const res = await box.requireUploadAuth(fakeReq('not-the-token'), { TDOC_UPLOAD_TOKEN: 'secret-token' });
    assert(res !== null, 'must not pass through');
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await tAsync('requireUploadAuth: no TDOC_UPLOAD_TOKEN configured → always 401 (fail closed)', async () => {
    const res = await box.requireUploadAuth(fakeReq('anything'), {});
    assert(res !== null && res.status === 401, 'must fail closed when no token is configured');
  });

  await tAsync('requireUploadAuth: correct bearer token → passes (owner-succeeds coverage)', async () => {
    const res = await box.requireUploadAuth(fakeReq('secret-token'), { TDOC_UPLOAD_TOKEN: 'secret-token' });
    assert(res === null, 'a correct token must pass through (return null)');
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
    const idxStart = worker.indexOf('async function indexHtml(env, session)');
    const idxEnd = worker.indexOf('// ─────────────────────────────────────────────────────────────────────────', idxStart);
    const indexHtmlSrc = worker.slice(idxStart, idxEnd);
    assert(!nativeConfirmCall.test(stripLineComments(indexHtmlSrc)), '/me must not call the native confirm()');
    assert(indexHtmlSrc.includes('showConfirm('), '/me must use the styled showConfirm() modal');
    assert(indexHtmlSrc.includes('dataset.versions'),
      'delete confirm copy should be built from data-versions/data-comments (honest N/M copy)');
  });

  t('local server index page no longer uses window.confirm() for delete', () => {
    const idxStart = serverJs.indexOf('function indexPage()');
    const indexPageSrc = serverJs.slice(idxStart, serverJs.indexOf('const server = http.createServer'));
    assert(!nativeConfirmCall.test(stripLineComments(indexPageSrc)), 'local index page must not call the native confirm()');
    assert(indexPageSrc.includes('showConfirm('), 'local index page must use the styled showConfirm() modal');
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
