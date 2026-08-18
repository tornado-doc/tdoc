// Owner catalog (/me) guard.
//
// 2026-08-13 rework (julie: "删改实在是太丑了 uiux 请improve。而且不能只在/me page"):
// /me is a clean catalog — title/slug/version + search + multi-select batch
// delete + quiet ⋯ Delete. The per-row visibility/history/commenting/
// allowed_users dropdowns and the admin-token input are GONE: access
// controls moved to the doc-page Share panel (overlay.js showManageModal,
// see jul36-owner-manage.test.js), and Delete now authorizes off the owner's
// session cookie instead of a pasted token (safe only because of the CSP on
// every doc response — see csp.test.js). /me is gated by canSeeMyDocs
// (hosted: any signed-in GitHub user; BYOK: TDOC_OWNER), so its own
// same-origin fetches are already cookied.
//
// Gate (小cc review #2): the /me HTML response must not contain access data
// of any kind — especially `allowed_users` — since none of that is rendered
// here anymore.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const worker = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
const overlay = fs.readFileSync(path.join(__dirname, '..', 'server', 'overlay.js'), 'utf8');
const start = worker.indexOf('async function indexHtml(env, session');
const end = worker.indexOf('// ─────────────────────────────────────────────────────────────────────────', start);
if (start < 0 || end < 0 || end <= start) throw new Error('indexHtml block missing');
const index = worker.slice(start, end);

const deleteStart = worker.indexOf("if (p === '/api/doc' && method === 'DELETE')");
const deleteEnd = worker.indexOf("return text('Not found'", deleteStart);
if (deleteStart < 0 || deleteEnd < 0 || deleteEnd <= deleteStart) throw new Error('/api/doc DELETE block missing');
const deleteRoute = worker.slice(deleteStart, deleteEnd);

console.log('/me owner catalog');

t('/me no longer exposes the per-row access-control form', () => {
  assert(!index.includes('class="access-form"'), '/me must not render the old access-form');
  assert(!index.includes('name="visibility"'), '/me must not render a visibility control');
  assert(!index.includes('name="history_visibility"'), '/me must not render a history-visibility control');
  assert(!index.includes('name="commenting"'), '/me must not render a commenting control');
  assert(!index.includes('name="allowed_users"'), '/me must not render an allowed-users control');
});

t('/me no longer asks for an admin token', () => {
  assert(!index.includes('id="admin-token"'), '/me must not render the admin-token input');
  assert(!index.includes('Admin token'), '/me must not reference "Admin token" anywhere');
  assert(!index.includes('TDOC_UPLOAD_TOKEN'), '/me HTML must not reference TDOC_UPLOAD_TOKEN');
  assert(!index.includes("'Authorization'"), '/me must not build an Authorization header');
});

t('/me never computes or emits allowed_users (gate: no access data leaks into the catalog)', () => {
  assert(!index.includes('allowed_users'), '/me source must not reference allowed_users at all');
  assert(!index.includes('accessFromMeta'), '/me must not compute an access policy per row anymore');
});

t('/me keeps title, slug, version, search, batch select, and a quiet ⋯ delete per row', () => {
  assert(index.includes('doc-title'), 'missing doc title link');
  assert(index.includes('doc-meta'), 'missing slug/version meta line');
  // Delete is tucked behind a ⋯ overflow menu, not a prominent per-row button.
  assert(index.includes('class="row-menu-btn"'), 'missing ⋯ overflow trigger');
  assert(index.includes('class="row-delete"'), 'missing delete item inside the menu');
  assert(!index.includes('class="delete-doc"'), 'the loud standalone delete button should be gone');
  // Search + multi-select batch delete (still no access forms).
  assert(index.includes('id="doc-search"'), 'missing catalog search input');
  assert(index.includes('class="doc-check"'), 'missing per-row select checkbox');
  assert(index.includes('id="batch-delete"'), 'missing batch delete control');
  assert(index.includes('id="select-all"'), 'missing select-all control');
});

t('/me search is client-side over title/slug (no extra catalog round-trips)', () => {
  assert(index.includes('applySearch'), 'missing search apply helper');
  assert(index.includes('dataset.title'), 'search must read title from the rendered row');
  assert(index.includes('dataset.slug'), 'search must read slug from the rendered row');
  assert(index.includes('No matches.'), 'missing empty search state');
  // `.doc-row { display:flex }` would otherwise override the UA [hidden] rule
  // and leave "filtered" rows visible — pin the !important hide.
  assert(/\.doc-row\[hidden\][^}]*display:\s*none\s*!important/.test(index),
    'filtered rows must force display:none !important so search actually hides them');
});

t('/me batch delete reuses session DELETE /api/doc (no token, no access forms)', () => {
  assert(index.includes('batchDelete.addEventListener'), 'batch delete must be wired');
  assert(index.includes('selectedRows'), 'batch delete must operate on the selected set');
  // Still no access-policy batching — JUL-36 keeps policy on the doc Share panel.
  assert(!index.includes('/api/doc/access'), '/me must not batch-patch access policy');
});

t('/me deletes remote docs through DELETE /api/doc using the session (no token)', () => {
  assert(index.includes("fetch('/api/doc?slug=' + encodeURIComponent(slug)"), 'delete button must call remote delete endpoint');
  assert(index.includes("method: 'DELETE'"), 'delete button must use DELETE');
  assert(index.includes("credentials: 'same-origin'"), 'delete fetch should be explicit about sending the session cookie');
  assert(!index.includes("'Authorization': 'Bearer'"), 'delete must not send a bearer token');
  assert(deleteRoute.includes('await authorizeOwnerMutation(req, env, slug)'), 'remote delete must accept session-or-token auth');
});

t('/me still uses the styled confirm modal, never native confirm()', () => {
  const nativeConfirmCall = /(?:^|[^\w.])confirm\(/m;
  const stripped = index.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert(!nativeConfirmCall.test(stripped), '/me must not call the native confirm()');
  assert(index.includes('showConfirm('), '/me must use the styled showConfirm() modal');
  // Quiet inline toast feedback — no third-party script, no inline status row.
  assert(index.includes("This can't be undone."), 'confirm body should be short and plain');
  const userFacing = index.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert(!/remote storage/i.test(userFacing), '/me copy must not say "remote storage"');
  assert(!index.includes("'/api/comments?slug='"), 'delete confirm must not pre-flight comment counts');
  assert(!/<script\s+src=/i.test(index), '/me must not load third-party <script src=>');
  assert(index.includes("function toast("), '/me must use a tiny inline toast for feedback');
  assert(!index.includes('id="status"'), 'inline status row should be gone — toast replaces it');
  assert(index.includes("toast('Deleted')"), 'success feedback should be a quiet toast("Deleted")');
  assert(!index.includes('data-versions'), 'unused data-versions should be gone from /me rows');
  assert(index.includes('applySearch();'), 'single-row delete must re-run applySearch so empty/filter state stays consistent');
  assert(index.includes('name="viewport"'), '/me must send a mobile viewport meta');
});

t('/me catalog does not fold comment logs or HEAD R2 per row', () => {
  // The slow /me load: N serial readComments (full event-log fold) + N R2 HEADs
  // just to paint titles. Catalog reads KV meta only.
  assert(!index.includes('readComments('), '/me must not call readComments while rendering the catalog');
  assert(!index.includes('DOCS.head'), '/me must not HEAD R2 objects while rendering the catalog');
  assert(index.includes('Promise.all'), '/me should fetch meta rows in parallel');
});

t('overlay top bar occupies layout instead of floating over the document', () => {
  assert(overlay.includes('.tdoc-bar { position: relative;'),
    'bar must sit in document flow, not overlay the page');
  assert(!overlay.includes('.tdoc-bar { position: fixed;'),
    'bar must not be position:fixed');
  assert(overlay.includes('document.body.insertBefore(bar, document.body.firstChild)'),
    'bar must be the first body child so it occupies the top of the layout');
  assert(!overlay.includes('padding-top: 44px !important'),
    'in-flow bar must not reserve a fake padding-top gap');
  assert(!overlay.includes('body.tdoc-has-oldver-strip { padding-top: 72px !important; }'),
    'old-version strip must occupy flow, not extra body padding');
});

t('/me reuses the overlay top bar and hides Share / Duplicate / Copy', () => {
  const meStart = worker.indexOf("if (p === '/me' && method === 'GET')");
  const meEnd = worker.indexOf('// ---- interactive island', meStart);
  assert(meStart >= 0 && meEnd > meStart, '/me route block missing');
  const meRoute = worker.slice(meStart, meEnd);
  assert(meRoute.includes('injectOverlay('), '/me must inject overlay.js for the site bar');
  assert(meRoute.includes("'Content-Security-Policy': cspHeader(nonce)"), '/me overlay needs the same CSP as docs');
  assert(worker.includes('isCatalog: !!isCatalog'), 'injectOverlay must pass isCatalog');
  assert(!worker.includes('function siteChromeCss'), '/me must not fork a second top bar');
  assert(!index.includes('class="who"'), 'identity belongs in the overlay chip');
  assert(index.includes('nonce="${nonce}"'), '/me catalog script must carry the CSP nonce');
  assert(overlay.includes('const isCatalog = !!cfg.isCatalog'), 'overlay must read isCatalog');
  assert(overlay.includes("${isSiteBar ? '' : copyMenuHtml}"), 'catalog must hide Copy');
  assert(overlay.includes("${isSiteBar ? '' : primaryCtaHtml}"), 'catalog must hide Share');
  assert(overlay.includes("${isSiteBar ? '' : forkBtnHtml}"), 'catalog must hide Duplicate/Download');
  assert(overlay.includes('id="tdoc-title"'),
    'doc pages still show the title in the left cluster');
  assert(!overlay.includes('tdoc-bar-center'),
    'title must not sit in a fake-centered middle slot');
  assert(overlay.includes('src="/tdoc_logo.svg"'),
    'bar mark must be the tdoc logo, not a text pill');
  assert(index.includes('class="wrap"'), 'catalog content must sit in a wrap so the bar can be full-bleed');
  const catalogGate = overlay.indexOf('if (isCatalog) {');
  const commentsBoot = overlay.indexOf('// ========== Comment layer + FAB ==========');
  assert(catalogGate >= 0 && commentsBoot > catalogGate, 'catalog must not boot comment chrome');
});

t('/me does not introduce a bespoke cookie-only admin-auth path', () => {
  // The session path now used everywhere is the SHARED authorizeOwnerMutation
  // gate (session OR token) — not a one-off same-origin/cookie check bolted
  // onto just this route.
  assert(!worker.includes('requireAdminAuth'), 'worker must not add a separate cookie-based admin-auth function');
  assert(!worker.includes('isSameOriginRequest'), 'same-origin is not sufficient when docs are arbitrary same-origin HTML');
});

t('/me non-owner bounce goes to landing with notice, not github.com', () => {
  const meStart = worker.indexOf("if (p === '/me' && method === 'GET')");
  const meEnd = worker.indexOf('// ---- doc view ----', meStart);
  assert(meStart >= 0 && meEnd > meStart, '/me route block missing');
  const meRoute = worker.slice(meStart, meEnd);
  assert(meRoute.includes('canSeeMyDocs(env, s, url.origin)'),
    '/me must gate on canSeeMyDocs (hosted per-user or BYOK TDOC_OWNER)');
  assert(!worker.includes('isOwnerSession gate in the'),
    '/me must not document the retired owner-only gate');
  assert(!overlay.includes('cfg.canSeeMyDocs || cfg.isOwner'),
    'My docs must not fall back to this-doc isOwner');
  assert(!overlay.includes('else if (me && me.isOwner) canSeeMyDocs'),
    'device-flow must not treat isOwner as canSeeMyDocs');
  assert(!overlay.includes("typeof me.isOwner === 'boolean') isOwner"),
    'device-flow must not clobber per-doc isOwner from /api/auth/me');
  assert(meRoute.includes("Location: `/?notice=${notice}`") || meRoute.includes("Location: '/?notice="),
    '/me must redirect to landing ?notice=…');
  assert(!meRoute.includes('github.com/tornado-doc/tdoc'),
    '/me must not redirect to the GitHub repo');
});

t('landing supports sign-in + toast notices; /auth/done soft-lands OAuth callback', () => {
  assert(worker.includes('function landingHtml(env, notice)'), 'landingHtml must take a notice');
  assert(worker.includes("id=\"signin\""), 'landing must offer Sign in with GitHub');
  assert(worker.includes('function authDoneHtml('), 'authDoneHtml missing');
  assert(worker.includes("/auth/done"), 'must serve /auth/done for OAuth callback URL');
  assert(worker.includes("Location: '/?notice=notfound'"),
    'unknown GET paths must bounce to landing with notfound notice');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
