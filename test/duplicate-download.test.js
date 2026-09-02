// Split Fork into Duplicate (account copy) vs Download (#146).
//
// Overlay labels and worker route are the product contract. Helpers are
// extracted for slug allocation. Behavioral cases live in
// hosted-oob-behavior.test.js (fake KV/R2/DO).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const overlay = [
  'shell/src/document-shell.jsx',
  'shell/src/document/document-toolbar.jsx',
  'shell/src/document/api.js',
].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');

function block(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  const end = src.indexOf(endNeedle, start);
  if (start < 0 || end < 0 || end <= start) throw new Error(`block missing: ${startNeedle}`);
  return src.slice(start, end);
}

console.log('duplicate vs download (#146)');

t('published React actions say Duplicate and Download, not Fork', () => {
  assert(overlay.includes('Duplicate'), 'Duplicate label missing');
  assert(overlay.includes('Download HTML'), 'Download HTML item missing');
  assert(overlay.includes('Download PDF'), 'Download PDF item missing');
  assert(!overlay.includes('data-action="fork"'), 'legacy Fork action remains');
  assert(!overlay.includes('data-action="fork"'), 'overflow menu must not keep a fork action');
  assert(overlay.includes('data-action="duplicate"'), 'overflow menu missing Duplicate');
  assert(overlay.includes('data-action="download"'), 'overflow menu missing Download HTML');
  assert(overlay.includes('data-action="download-pdf"'), 'overflow menu missing Download PDF');
  assert(/className="[^"]*tdoc-mobile-overflow-only[^"]*" data-action="share"/.test(overlay),
    'Share must move into overflow only on mobile, while staying primary on desktop');
  assert(!overlay.includes('data-action="repo"'), 'tdoc mark already links to GitHub; ⋯ must not duplicate it');
  assert(overlay.includes('contentWindow?.print()'), 'PDF must use the browser print engine');
  assert(!overlay.includes('function jpegPagesToPdf'), 'JPEG-wrapped PDF must be gone');
  assert(!overlay.includes("toDataURL('image/jpeg'"), 'PDF must not snapshot canvas JPEGs');
});

t('Download hits /export and never opens a blob fork tab', () => {
  assert(overlay.includes('/export?download=1'), 'Download HTML must use /export?download=1');
  assert(!overlay.includes("fetch(`${base}/fork`)"), 'Download must not fetch /fork');
  assert(!overlay.includes('-fork.html'), 'download filename must not still say -fork.html');
  assert(overlay.includes('`${config.slug}-v${config.version}.html`'), 'HTML filename should be slug-vN.html');
  assert(overlay.includes('/export?download=0'), 'PDF must print the export reading column');
});

t('Duplicate POSTs /api/doc/duplicate and opens React sign-in on 401', () => {
  assert(overlay.includes("request('/api/doc/duplicate'"), 'client must POST /api/doc/duplicate');
  assert(overlay.includes('error.status === 401'), '401 must start sign-in');
  assert(overlay.includes('signIn();'), 'duplicate must dispatch to React sign-in');
});

const dupRoute = block(
  worker,
  "if (p === '/api/doc/duplicate' && method === 'POST')",
  '// ---- auth ----',
);

t('POST /api/doc/duplicate is session-gated, snapshot-only, no comment copy', () => {
  assert(dupRoute.includes('await getSession(env, req)'), 'must read the GitHub session');
  assert(dupRoute.includes("error: 'sign_in_required'"), 'anonymous callers must 401');
  const session = dupRoute.indexOf('await getSession(env, req)');
  const write = dupRoute.indexOf('env.DOCS.put');
  assert(session >= 0 && write >= 0 && session < write, 'auth before R2 write');
  assert(dupRoute.includes('enforceDocAccess'), 'must not duplicate a doc the caller cannot read');
  assert(dupRoute.includes('hostedAccountCopiesEnabled'), 'non-owner writes must be hosted-gated');
  assert(dupRoute.includes("error: 'account_copy_unavailable'"), 'self-host non-owner must 403');
  assert(dupRoute.includes('sourceHasWidgets'), 'must refuse island-bearing docs');
  assert(!dupRoute.includes('mutateComments'), 'v1 duplicate must not copy comment threads');
  assert(!dupRoute.includes('readComments'), 'v1 duplicate must not snapshot comments');
  // prepareDocVersion is the single home for stored-document invariants:
  // it aid-stamps AND bakes the reading template AND records the content sha.
  assert(dupRoute.includes('prepareDocVersion'), 'copied HTML must go through prepareDocVersion (aids + bake + sha)');
  assert(dupRoute.includes('hostedAccountForGithub'), 'duplicate must reuse the hosted account registry');
  assert(dupRoute.includes('quota_docs'), 'duplicate must share the hosted doc quota');
  assert(dupRoute.includes('quota_upload_bytes'), 'duplicate must share the hosted upload-size cap');
});

t('export attachment filename is slug-vN.html, not -fork.html', () => {
  const exp = block(worker, '// ---- doc export / fork ----', '// ---- account duplicate');
  assert(exp.includes('filename="${slug}-v${vStr}.html"'), 'Content-Disposition must drop -fork');
  assert(!exp.includes('-fork.html'), 'export filename must not still say -fork.html');
});

t('Download /export bakes the reader CSS, not bar chrome', () => {
  // Reader CSS is a standalone file now (server/reader.css) — extracted from
  // the overlay monolith; the bundler inlines it as READER_CSS.
  const css = fs.readFileSync(path.join(__dirname, '..', 'server', 'reader.css'), 'utf8');
  assert(css.includes('--td-accent'), 'reader CSS missing theme tokens');
  assert(css.includes(':where(body h1)'), 'reader CSS missing heading template');
  assert(css.includes('max-width: 720px'), 'reader CSS missing reading column');
  assert(css.includes('@media print'), 'reader CSS must include print/PDF styles');
  assert(!css.includes('.tdoc-bar {'), 'reader CSS must not include the overlay bar');
  const exp = block(worker, '// ---- doc export / fork ----', '// ---- account duplicate');
  assert(worker.includes('function injectReaderCss'), 'worker must stamp reader CSS into export HTML');
  assert(exp.includes('injectReaderCss(html, readerCssSource())'), 'export must inject reader CSS');
});

t('/me hides another GitHub user\'s hosted duplicate from the catalog boot data', () => {
  const start = worker.indexOf('async function indexData(env, session');
  const idx = worker.slice(
    start,
    worker.indexOf('\nfunction ', start + 20),
  );
  assert(idx.includes('isDocOwnerSession(env, session, row.meta)'),
    'hosted /me must filter by doc owner session');
  assert(idx.includes('if (hosted) return isDocOwnerSession(env, session, row.meta)'),
    'hosted /me must skip other people\'s copies');
});

const slugStart = worker.indexOf('function isValidSlug(slug) {');
const slugEnd = worker.indexOf('function envFlagTrue(v) {');
const nextStart = worker.indexOf('function nextDuplicateSlug(sourceSlug, n) {');
const nextEnd = worker.indexOf('async function hostedAccountForGithub');
assert(slugStart >= 0 && nextStart >= 0 && nextEnd > nextStart, 'slug helpers missing');
const box = {};
vm.createContext(box);
vm.runInContext(worker.slice(slugStart, slugEnd) + '\n' + worker.slice(nextStart, nextEnd), box);

t('nextDuplicateSlug allocates -copy then -copy-N within the 64-char cap', () => {
  assert(box.nextDuplicateSlug('hello', 1) === 'hello-copy');
  assert(box.nextDuplicateSlug('hello', 2) === 'hello-copy-2');
  assert(box.nextDuplicateSlug('hello', 10) === 'hello-copy-10');
  const long = 'a'.repeat(64);
  const got = box.nextDuplicateSlug(long, 1);
  assert(got && got.endsWith('-copy') && got.length <= 64, `long slug overflowed: ${got}`);
  assert(box.isValidSlug(got), `allocated slug is invalid: ${got}`);
  assert(box.nextDuplicateSlug('../x', 1) === null, 'must refuse invalid source slugs');
  assert(box.nextDuplicateSlug('hello', 0) === null, 'n must be >= 1');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
